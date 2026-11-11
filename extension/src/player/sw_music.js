// Music module, service-worker side.
// 1. The hub: playback runs in an offscreen document (offscreen.html, reason AUDIO_PLAYBACK) so the
//    music keeps playing when the side panel is closed. The hub creates that document on demand,
//    forwards commands to it, keeps the last state, and follows year changes. Chrome closes the
//    document after 30 s without sound (e.g. after a pause); the next command creates it again and
//    the engine resumes the same video at the same second.
// 2. The video finder: a YouTube video for a chart song, remembered per song.
//
// Messages (see music_state.js for the state shape):
//   music:control {cmd: play|pause|toggle|next|prev|select|seek|shuffle|volume, index?, play?, time?,
//                 volume?, on?} -> {ok, state, reason?}
//   music:state   {} -> state {playing, loading, year, index, length, track:{artist,title,rank}, time,
//                 duration, at, skin, shuffle, volume, status, problem, videoId, alive}
//   music:changed {state, source} broadcast to every extension page on each change
//   music:engine / music:engine:boot   internal, between this hub and the offscreen document
//   music:videoId {artist, title, exclude?: [videoId], prefetch?: bool}
//                 -> {ok:true, videoId} | {ok:false, reason}
//                 reason: none | busy | blocked | cooldown | consent | parse | network | http | bad-request | error
//   music:bad     {videoId, code, artist?, title?} -> {ok:true}   (the player confirmed it does not play)
// Storage (chrome.storage.local):
//   "mus:id:<artist>|<title>" = {videoId, candidates: [ids in YouTube's order], at}
//   "mus:bad:<videoId>"       = {code, at}   (YouTube player error; code 5 counts as temporary)
//   "mus:cooldown"            = {until, ms}  (429 / "sorry" page: back off, doubling)
//   "mus:rate"                = [timestamps of recent searches]
//   "mus:pos:<year>"          = {index, shuffle}   "mus:volume" = 0..100
// Storage (chrome.storage.session): "mus:session" = the last state (resume, answers while no document)
// Lookups that need youtube.com run one at a time with >= 1.5 s between requests.
import { searchUrl, extractInitialData, findVideos, isVideoId } from "./ytsearch.js";
import { songsFor } from "./playlist.js";
import {
  MSG, SESSION_KEY, VOLUME_KEY, DEFAULT_VOLUME, NO_START_TEXT, posKey, clampVolume, cleanCommand, makeState, isNewer
} from "./music_state.js";
import { MIN_YEAR, MAX_YEAR, DEFAULTS } from "../shared/state_sw.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const ID_PREFIX = "mus:id:";
export const BAD_PREFIX = "mus:bad:";
export const COOLDOWN_KEY = "mus:cooldown";
export const RATE_KEY = "mus:rate";
export const SPACING_MS = 1500;

export const LIMITS = Object.freeze({
  candidates: 8,                // ids kept per song, so a dead video costs no extra search
  retrySearchAfterMs: 3 * DAY,  // a song with no usable id left is searched again after this
  transientBadMs: DAY,          // error 5 (HTML5 player error) may be a hiccup, not a dead video
  rateWindowMs: 10 * MINUTE,
  rateMax: 30,                  // searches per window: protects the home IP from a runaway loop
  cooldownFirstMs: 15 * MINUTE,
  cooldownMaxMs: DAY,
  fieldMax: 300
});

const TRANSIENT_CODES = new Set([5]);

export const songCacheKey = (artist, title) => `${ID_PREFIX}${artist}|${title}`;

function cleanField(value) {
  if (typeof value !== "string") return "";
  const s = value.trim();
  return s.length <= LIMITS.fieldMax ? s : "";
}

// storage: chrome.storage.local-like {get, set}; fetchFn: fetch-like. now/sleep are injectable for tests.
export function createMusicService({ storage, fetchFn, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const high = [];             // searches for a song someone wants to hear now
  const low = [];              // prefetches for upcoming songs
  const inflight = new Map();  // cache key -> {promise, job}: one search per song at a time
  let pumping = false;
  let lastEnd = -Infinity;     // end of the previous youtube.com request

  const read = async (key) => (await storage.get(key))[key];

  async function badIds(ids) {
    const bad = new Set();
    if (!ids.length) return bad;
    const marks = await storage.get(ids.map((id) => BAD_PREFIX + id));
    for (const id of ids) {
      const mark = marks[BAD_PREFIX + id];
      if (!mark) continue;
      if (TRANSIENT_CODES.has(Number(mark.code)) && now() - (mark.at || 0) > LIMITS.transientBadMs) continue;
      bad.add(id);
    }
    return bad;
  }

  async function firstUsable(candidates, exclude) {
    const ids = (Array.isArray(candidates) ? candidates : []).filter(isVideoId);
    const bad = await badIds(ids);
    return ids.find((id) => !bad.has(id) && !exclude.has(id)) || null;
  }

  async function lookup(msg) {
    const artist = cleanField(msg?.artist);
    const title = cleanField(msg?.title);
    if (!artist || !title) return { ok: false, reason: "bad-request" };
    const key = songCacheKey(artist, title);
    const exclude = new Set(Array.isArray(msg.exclude) ? msg.exclude.filter(isVideoId) : []);

    const cached = await read(key);
    if (cached && Array.isArray(cached.candidates)) {
      const pick = await firstUsable(cached.candidates, exclude);
      if (pick) {
        // A pick forced by `exclude` stays temporary: the excluded video is only a suspect so far.
        if (!exclude.size && pick !== cached.videoId) await storage.set({ [key]: { ...cached, videoId: pick } });
        return { ok: true, videoId: pick };
      }
      if (now() - (cached.at || 0) < LIMITS.retrySearchAfterMs) return { ok: false, reason: "none" };
    }

    const found = await searchShared(key, artist, title, msg.prefetch === true);
    if (!found.ok) return found;
    const entry = { videoId: await firstUsable(found.candidates, new Set()), candidates: found.candidates, at: now() };
    await storage.set({ [key]: entry });
    const pick = exclude.size ? await firstUsable(entry.candidates, exclude) : entry.videoId;
    return pick ? { ok: true, videoId: pick } : { ok: false, reason: "none" };
  }

  async function markBad(msg) {
    const videoId = msg?.videoId;
    if (!isVideoId(videoId)) return { ok: false, reason: "bad-request" };
    await storage.set({ [BAD_PREFIX + videoId]: { code: Number(msg.code) || 0, at: now() } });
    const artist = cleanField(msg.artist);
    const title = cleanField(msg.title);
    if (artist && title) {
      const key = songCacheKey(artist, title);
      const entry = await read(key);
      if (entry && entry.videoId === videoId) {
        await storage.set({ [key]: { ...entry, videoId: await firstUsable(entry.candidates, new Set()) } });
      }
    }
    return { ok: true };
  }

  // ---- the youtube.com queue ----

  function searchShared(key, artist, title, prefetch) {
    const running = inflight.get(key);
    if (running) {
      if (!prefetch) promote(running.job);
      return running.promise;
    }
    const job = { run: () => search(artist, title), resolve: null };
    const promise = new Promise((resolve) => { job.resolve = resolve; });
    inflight.set(key, { promise, job });
    promise.then(() => inflight.delete(key));
    (prefetch ? low : high).push(job);
    pump();
    return promise;
  }

  function promote(job) {
    const i = low.indexOf(job);
    if (i !== -1) high.push(...low.splice(i, 1));
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (high.length || low.length) {
        const job = high.length ? high.shift() : low.shift();
        let result;
        try { result = await job.run(); } catch (_) { result = { ok: false, reason: "error" }; }
        job.resolve(result);
      }
    } finally {
      pumping = false;
    }
  }

  async function search(artist, title) {
    const cooldown = await read(COOLDOWN_KEY);
    if (cooldown && cooldown.until > now()) return { ok: false, reason: "cooldown" };
    if (!(await takeRateSlot())) return { ok: false, reason: "busy" };
    const url = searchUrl(artist, title);
    let res = await request(url, "omit");
    // EU consent wall for cookie-less requests: retry once with the user's own YouTube cookies.
    if (res.kind === "consent") res = await request(url, "include");
    if (res.kind === "blocked") {
      await tripCooldown(cooldown);
      return { ok: false, reason: "blocked" };
    }
    if (res.kind !== "ok") return { ok: false, reason: res.kind };
    const data = extractInitialData(res.html);
    if (!data) return { ok: false, reason: "parse" };
    if (cooldown?.ms) await storage.set({ [COOLDOWN_KEY]: { until: 0, ms: 0 } });
    return { ok: true, candidates: findVideos(data, { max: LIMITS.candidates }).map((v) => v.videoId) };
  }

  async function request(url, credentials) {
    const wait = lastEnd + SPACING_MS - now();
    if (wait > 0) await sleep(wait);
    try {
      // Cookie-less by default, so these lookups never land in the user's YouTube search history.
      const res = await fetchFn(url, { credentials, headers: { "Accept-Language": "en-US,en;q=0.9" } });
      const finalUrl = String(res.url || url);
      if (res.status === 429 || /\/sorry\//.test(finalUrl)) return { kind: "blocked" };
      if (/^https:\/\/consent\./.test(finalUrl)) return { kind: "consent" };
      if (!res.ok) return { kind: "http" };
      return { kind: "ok", html: await res.text() };
    } catch (_) {
      return { kind: "network" };
    } finally {
      lastEnd = now();
    }
  }

  async function takeRateSlot() {
    const t = now();
    const recent = ((await read(RATE_KEY)) || []).filter((x) => typeof x === "number" && t - x < LIMITS.rateWindowMs);
    if (recent.length >= LIMITS.rateMax) return false;
    recent.push(t);
    await storage.set({ [RATE_KEY]: recent });
    return true;
  }

  async function tripCooldown(previous) {
    const ms = previous?.ms ? Math.min(previous.ms * 2, LIMITS.cooldownMaxMs) : LIMITS.cooldownFirstMs;
    await storage.set({ [COOLDOWN_KEY]: { until: now() + ms, ms } });
  }

  return { lookup, markBad, queued: () => high.length + low.length };
}

// ---- the hub: offscreen playback ------------------------------------------------------------------

export const OFFSCREEN_PATH = "src/player/offscreen.html";
export const OFFSCREEN_REASON = "AUDIO_PLAYBACK";
export const OFFSCREEN_JUSTIFICATION =
  "Plays the chosen year's hit songs (a YouTube embed) while the music panel is closed.";
export const TEXT = Object.freeze({
  silent: "Stopped: Chrome closes the hidden player after 30 s without sound. Press Play.",
  noStart: NO_START_TEXT,
  noAnswer: "The player did not answer. Press Play again.",
  taken: "Another part of Yesteryear is using Chrome's background page. Try again in a minute."
});

const errText = (err) => String(err?.message || err || "unknown error");
const SINGLE_DOC_RE = /single offscreen document|only a single/i;

export function clampYear(value) {
  const y = Math.round(Number(value));
  return Math.min(MAX_YEAR, Math.max(MIN_YEAR, Number.isFinite(y) ? y : DEFAULTS.year));
}

// local/session: chrome.storage-like areas; offscreen: {exists(), create(), close()} for OUR document;
// toEngine(cmd): sends a command to the engine in that document -> {ok, state} | null;
// broadcast(state): tells every open UI; loadCharts(): parsed charts.json.
export function createMusicHub({ local, session, offscreen, toEngine, broadcast = () => {}, loadCharts, now = Date.now }) {
  let last = null;              // latest state (memory copy of SESSION_KEY)
  let starting = null;          // the createDocument in flight, shared by concurrent commands
  const written = new Map();    // local key -> JSON last written, so unchanged values are not rewritten

  async function settings() {
    const s = await local.get(["year", "musicAutoplay", VOLUME_KEY]);
    return { year: clampYear(s.year), autoplay: s.musicAutoplay === true, volume: clampVolume(s[VOLUME_KEY], DEFAULT_VOLUME) };
  }

  async function readPos(year) {
    const key = posKey(year);
    const p = (await local.get(key))[key];
    const i = Number(p?.index);
    return { index: Number.isInteger(i) && i >= 0 ? i : 0, shuffle: p?.shuffle === true };
  }

  async function lastState() {
    if (last) return last;
    const s = (await session.get(SESSION_KEY))[SESSION_KEY];
    last = s && typeof s === "object" ? makeState(s) : null;
    return last;
  }

  async function writeIfChanged(key, value) {
    const json = JSON.stringify(value);
    if (written.get(key) === json) return;
    written.set(key, json);
    await local.set({ [key]: value });
  }

  // Keep a state: memory, session storage (resume, answers while there is no document), and the
  // per-year position and the volume in local storage when they change.
  async function remember(state) {
    const s = makeState(state);
    delete s.alive;
    // The engine's broadcast and its reply to a command can arrive in either order: keep the newest.
    if (!isNewer(await lastState(), s)) return last;
    last = s;
    await Promise.all([
      session.set({ [SESSION_KEY]: s }),
      writeIfChanged(posKey(s.year), { index: s.index, shuffle: s.shuffle }),
      writeIfChanged(VOLUME_KEY, s.volume)
    ]);
    return s;
  }

  // The state while no document is running: the chosen year, its saved position, and the time of the
  // song that was paused there.
  async function idleState(year, extra = {}) {
    const { volume } = await settings();
    const pos = await readPos(year);
    let songs = [];
    try { songs = songsFor(await loadCharts(), year); } catch (_) { songs = []; }
    const index = pos.index < songs.length ? pos.index : 0;
    const prev = await lastState();
    const same = prev && prev.year === year && prev.index === index ? prev : null;
    return makeState({
      playing: false, year, index, length: songs.length, track: songs[index] || null,
      time: same ? same.time : 0, duration: same ? same.duration : 0, videoId: same ? same.videoId : null,
      at: now(), shuffle: pos.shuffle, volume, status: "", problem: false, ...extra
    });
  }

  async function alive() {
    try { return await offscreen.exists(); } catch (_) { return false; }
  }

  async function ensureEngine() {
    if (await alive()) return;
    if (!starting) {
      starting = (async () => {
        try {
          await offscreen.create();
        } catch (err) {
          if (!SINGLE_DOC_RE.test(errText(err))) throw err;
          if (!(await alive())) throw new Error(TEXT.taken); // the one slot holds someone else's page
        }
      })().finally(() => { starting = null; });
    }
    await starting;
  }

  async function failWith(year, status, reason) {
    const s = await remember(await idleState(year, { status, problem: true }));
    broadcast(s);
    return { ok: false, reason, state: { ...s, alive: false } };
  }

  // What the offscreen document needs to start: year, position, the video to resume, volume.
  async function bootContext() {
    const { year, volume } = await settings();
    const pos = await readPos(year);
    const prev = await lastState();
    const resume = prev && prev.year === year && prev.videoId && prev.index === pos.index
      ? { index: prev.index, videoId: prev.videoId, time: prev.time, duration: prev.duration }
      : null;
    return { year, pos, resume, volume };
  }

  async function control(msg) {
    const cmd = cleanCommand(msg);
    if (!cmd) return { ok: false, reason: "bad-request", state: await getState() };
    const { year } = await settings();
    const wasRunning = await alive();
    try {
      await ensureEngine();
    } catch (err) {
      const why = errText(err);
      return failWith(year, why === TEXT.taken ? why : `Cannot start the player: ${why}`, "offscreen");
    }
    // Commands act on the year in storage. A running engine that has not heard of a new year yet
    // (e.g. "play" sent right after the year was saved) switches first.
    const known = wasRunning ? await lastState() : null;
    if (known && known.year !== year) {
      const switched = await toEngine({ cmd: "year", year, pos: await readPos(year) });
      if (switched?.ok && switched.state) await remember(switched.state);
    }
    const reply = await toEngine(cmd);
    if (reply?.ok && reply.state) return { ok: true, state: { ...(await remember(reply.state)), alive: true } };
    // A document that does not answer is broken: close it, the next command starts a fresh one.
    if (await alive()) { try { await offscreen.close(); } catch (_) { /* already gone */ } }
    return failWith(year, TEXT.noAnswer, "no-answer");
  }

  async function getState() {
    const { year } = await settings();
    if (await alive()) {
      const reply = await toEngine({ cmd: "state" });
      if (reply?.ok && reply.state) {
        let s = await remember(reply.state);
        if (s.year !== year) { // the engine missed a year change
          const again = await toEngine({ cmd: "year", year, pos: await readPos(year) });
          if (again?.ok && again.state) s = await remember(again.state);
        }
        return { ...s, alive: true };
      }
      const cached = await lastState(); // busy or starting: the last known state is the best answer
      if (cached && cached.year === year) return { ...cached, alive: true };
    }
    let s = await lastState();
    if (!s || s.year !== year) {
      s = await remember(await idleState(year));
    } else if (s.playing) {
      // It was playing, but the document is gone: Chrome closed it after 30 s without sound. Still
      // loading then means YouTube never started the music.
      const status = s.loading ? TEXT.noStart : TEXT.silent;
      s = await remember({ ...s, playing: false, loading: false, status, problem: true, at: now() });
      broadcast(s);
    }
    return { ...s, alive: false };
  }

  async function onYear() {
    const { year, autoplay } = await settings();
    if (await alive()) {
      const reply = await toEngine({ cmd: "year", year, pos: await readPos(year), autoplay });
      if (reply?.ok && reply.state) await remember(reply.state); // the engine broadcasts it itself
      return;
    }
    if (autoplay) { await control({ cmd: "play" }); return; }
    if (last && last.year === year) return;
    broadcast(await remember(await idleState(year)));
  }

  return { control, getState, bootContext, onYear, onEngineState: remember, idleState };
}

// Sends to the offscreen document until it answers: right after createDocument() its listener may not
// be registered yet, and open UIs receive the same message without answering.
async function askEngine(msg, { tries = 20, gapMs = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const reply = await chrome.runtime.sendMessage(msg);
      if (reply && typeof reply === "object" && "ok" in reply) return reply;
    } catch (_) { /* nobody listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  return null;
}

let chartsPromise = null;
function loadCharts() {
  chartsPromise ??= fetch(chrome.runtime.getURL("src/player/charts.json"))
    .then((r) => r.json())
    .catch((err) => { chartsPromise = null; throw err; });
  return chartsPromise;
}

export function initMusic() {
  const service = createMusicService({
    storage: chrome.storage.local,
    fetchFn: (url, init) => fetch(url, init)
  });
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const fromEngine = (sender) => sender?.id === chrome.runtime.id && String(sender.url || "").startsWith(offscreenUrl);
  const hub = createMusicHub({
    local: chrome.storage.local,
    session: chrome.storage.session,
    offscreen: {
      exists: async () => (await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [offscreenUrl]
      })).length > 0,
      create: () => chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH, reasons: [OFFSCREEN_REASON], justification: OFFSCREEN_JUSTIFICATION
      }),
      close: () => chrome.offscreen.closeDocument()
    },
    toEngine: (cmd) => askEngine({ ...cmd, type: MSG.engine }),
    broadcast: (state) => {
      chrome.runtime.sendMessage({ type: MSG.changed, state: { ...state, alive: false }, source: "hub" }).catch(() => {});
    },
    loadCharts
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    switch (msg?.type) {
      case "music:videoId":
        service.lookup(msg).then(reply, () => reply({ ok: false, reason: "error" }));
        return true;
      case "music:bad":
        service.markBad(msg).then(reply, () => reply({ ok: false, reason: "error" }));
        return true;
      case MSG.control:
        hub.control(msg).then(reply, (err) => reply({ ok: false, reason: "error", detail: errText(err) }));
        return true;
      case MSG.state:
        hub.getState().then(reply, () => reply(null));
        return true;
      case MSG.boot:
        if (!fromEngine(sender)) return false;
        hub.bootContext().then(reply, () => reply(null));
        return true;
      case MSG.changed:
        if (fromEngine(sender) && msg.source === "engine") hub.onEngineState(msg.state).catch(() => {});
        return false;
      default:
        return false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.year) {
      hub.onYear().catch((err) => console.warn("[Yesteryear music] year change:", errText(err)));
    }
  });

  return { service, hub };
}
