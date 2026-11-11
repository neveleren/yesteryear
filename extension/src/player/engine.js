// Music playback engine: play order (Playlist), what to do with broken videos (ErrorPolicy), and the
// YouTube frame. It runs in the offscreen document (offscreen.js), so the music keeps playing while the
// side panel is closed. No DOM and no chrome.* here: everything comes in through createEngine(), so
// node tests drive it with a fake frame and fake timers.
//
// The document can be closed under us (Chrome closes an AUDIO_PLAYBACK document after 30 s without
// sound, e.g. after a pause). The service worker then keeps the last state, and boot() gets it back as
// `resume`: Play continues the same video at the same second.
import { Playlist, ErrorPolicy, skinForYear, songKey, songsFor, STALL, AUTH } from "./playlist.js";
import { STATE } from "./ytwidget.js";
import { DEFAULT_YEAR, DEFAULT_VOLUME, NO_START_TEXT, clampVolume, makeState } from "./music_state.js";

export const TIMING = Object.freeze({
  syncMs: 5000,         // while playing, report the position at least this often (UIs count on in between)
  nudgeMs: 5000,        // a loaded video that has not started gets one more playVideo...
  stallMs: 10000,       // ...and counts as failed after this (bot check screen, or nothing at all)
  bufferGraceMs: 8000,  // once: still buffering at stallMs is a slow network, not a dead video
  videoErrorMs: 3000,   // videoData.errorCode says it will not play: move on after this
  echoMs: 4000,         // PLAYING this soon after our own pause is the autoplay we tried to stop
  silenceMs: 25000      // no new try that could still be silent by then: Chrome closes the document at 30 s
});

const TEXT = Object.freeze({
  searching: "Searching...",
  loading: "Loading...",
  retry: "Trying another video...",
  skip: "Cannot play this one, skipping...",
  notFound: "Not found, skipping...",
  noSongs: "No songs for this year.",
  referer: "YouTube refused the embed (Referer rule missing).",
  auth: "YouTube wants a sign-in check. Open youtube.com in this Chrome profile, then press Play.",
  refused: "YouTube refuses to play right now. Open youtube.com once in this Chrome profile, then press Play.",
  noStart: NO_START_TEXT
});

function missText(reply) {
  const reason = reply?.reason || "no answer";
  if (reason === "cooldown" || reason === "blocked") return "YouTube asked us to slow down. Try again later.";
  if (reason === "network") return "No connection to YouTube.";
  if (reason === "none") return "No videos found for these songs.";
  return `Cannot reach YouTube right now (${reason}).`;
}

// makeFrame(handlers) -> {load, play, pause, seek, setVolume, unMute, hasPlayer, ready?}
// lookup({artist, title, exclude, prefetch}) -> Promise<{ok:true, videoId} | {ok:false, reason} | null>
// reportBad({videoId, code, artist, title}); emit(state) after every change.
export function createEngine({
  charts,
  makeFrame,
  lookup,
  reportBad = () => {},
  emit = () => {},
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  rng = Math.random
}) {
  let year = DEFAULT_YEAR;
  let songs = [];
  let playlist = new Playlist(0, { rng });
  let policy = new ErrorPolicy();
  let frame = null;
  let frameState = null;  // last YouTube player state of the loaded video
  let want = false;       // the user wants music
  let current = null;     // {index, videoId, exclude}: what the frame holds (videoId null while searching)
  let resume = null;      // {index, videoId, time, duration} from an earlier document
  let time = 0;           // seconds, as of `at`
  let duration = 0;
  let at = now();
  let status = "";
  let problem = false;
  let volume = DEFAULT_VOLUME;
  let seq = 0;            // bumped by every new start, pause or year: stale lookups and timers check it
  let watchdog = null;
  let lastEmit = -Infinity;
  let pausedAt = -Infinity;
  let videoError = null;
  let unmuteTried = false;
  // YouTube's infoDelivery only sends what changed: loading the same video again (a retry, or a
  // double-click on the current song) brings neither its errorCode nor its duration a second time.
  const videoErrors = new Map(); // videoId -> errorCode
  const durations = new Map();   // videoId -> seconds
  let loadSeen = false;   // the loaded video reported -1/3/1: a PAUSED or ENDED before that is stale
  let holdPaused = false; // paused before the video ever played: keep it paused if it starts late
  // Chrome closes the document after 30 s without sound, counted from its start or the last sound.
  let lastSound = now();
  const diag = { ready: false, ytVolume: null, error: null }; // error: the last failure code (onError, stall, auth)

  const handlers = {
    onState: (s) => guard(() => onState(s)),
    onError: (code) => guard(() => fail(code)),
    onTime: (t, d) => guard(() => onTime(t, d)),
    onReady: () => guard(onReady),
    onVolume: (v, muted) => guard(() => onVolume(v, muted)),
    onVideoError: (code) => guard(() => onVideoError(code))
  };

  function guard(fn) {
    try { fn(); } catch (err) { status = `Player error: ${err?.message || err}`; problem = true; changed(); }
  }

  // ---- state -------------------------------------------------------------------------------------

  function liveNow() {
    if (want && frameState === STATE.PLAYING) {
      const t = time + Math.max(0, now() - at) / 1000;
      return duration ? Math.min(t, duration) : t;
    }
    return time;
  }

  function snapshot() {
    const song = songs[playlist.index];
    return makeState({
      playing: want,
      loading: want && frameState !== STATE.PLAYING,
      year,
      index: playlist.index < 0 ? 0 : playlist.index,
      length: songs.length,
      track: song || null,
      time: liveNow(),
      duration,
      at: now(),
      shuffle: playlist.shuffle,
      volume,
      status,
      problem,
      // Only a video of the song on screen: after "next" while paused the old video must not be
      // resumed under the new song's name.
      videoId: (current?.index === playlist.index ? current.videoId : null)
        ?? (resume?.index === playlist.index ? resume.videoId : null),
      diag: { frame: frameState, ready: diag.ready, ytVolume: diag.ytVolume, videoError, error: diag.error }
    });
  }

  function changed() {
    lastEmit = now();
    emit(snapshot());
  }

  function freezeTime() {
    time = liveNow();
    at = now();
  }

  function clearWatchdog() {
    if (watchdog !== null) clearTimer(watchdog);
    watchdog = null;
  }

  function setFrameState(s) {
    if (s === STATE.PLAYING || frameState === STATE.PLAYING) lastSound = now(); // sound starts or stops
    frameState = s;
  }

  function ensureFrame() {
    if (!frame) frame = makeFrame(handlers);
    return frame;
  }

  // ---- year and position ---------------------------------------------------------------------------

  function loadYear(y, pos = {}) {
    const n = Math.round(Number(y));
    year = Number.isFinite(n) ? n : DEFAULT_YEAR;
    songs = songsFor(charts, year);
    playlist = new Playlist(songs.length, { index: Number(pos?.index) || 0, shuffle: pos?.shuffle === true, rng });
    policy = new ErrorPolicy();
    current = null;
    resume = null;
    time = 0;
    duration = 0;
    at = now();
    status = "";
    problem = false;
  }

  function boot({ year: y = DEFAULT_YEAR, pos, resume: r, volume: v } = {}) {
    volume = clampVolume(v, DEFAULT_VOLUME);
    loadYear(y, pos);
    if (r && typeof r.videoId === "string" && r.videoId && r.index === playlist.index) {
      resume = {
        index: r.index,
        videoId: r.videoId,
        time: Math.max(0, Number(r.time) || 0),
        duration: Math.max(0, Number(r.duration) || 0)
      };
      time = resume.time;
      duration = resume.duration;
    }
    return snapshot();
  }

  // ---- commands ------------------------------------------------------------------------------------

  function control(msg = {}) {
    switch (msg.cmd) {
      case "play": play(); break;
      case "pause": pause(); break;
      case "toggle": if (want) pause(); else play(); break;
      case "next": move(+1); break;
      case "prev": move(-1); break;
      case "select": select(msg.index, msg.play !== false); break;
      case "seek": seek(msg.time); break;
      case "shuffle": setShuffle(typeof msg.on === "boolean" ? msg.on : !playlist.shuffle); break;
      case "volume": setVolume(msg.volume); break;
      case "year": setYear(msg.year, msg.pos, msg.autoplay === true); break;
      default: break; // "state" and anything unknown: just report
    }
    return snapshot();
  }

  function play() {
    if (want) { changed(); return; }                     // already playing or starting
    if (!songs.length) { status = TEXT.noSongs; problem = true; changed(); return; }
    want = true;
    status = "";
    problem = false;
    videoErrors.clear(); // a new try by the user: maybe the sign-in check has been done meanwhile
    const paused = frameState === STATE.PAUSED || frameState === STATE.CUED;
    if (frame && current?.videoId && current.index === playlist.index && paused) {
      holdPaused = false;
      frame.play();
      at = now();
      armWatchdog(++seq);
      changed();
      return;
    }
    if (resume && resume.index === playlist.index) {
      const r = resume;
      resume = null;
      startVideo(r.videoId, r.time, [], r.duration);
      return;
    }
    playCurrent();
  }

  function pause() {
    if (!want) { changed(); return; }
    freezeTime();
    want = false;
    seq++;                                                 // drops a pending search and the watchdog
    clearWatchdog();
    pausedAt = now();
    holdPaused = frameState !== STATE.PLAYING;
    if (frame?.hasPlayer) frame.pause();
    status = "";
    problem = false;
    if (current && !current.videoId) current = null;       // paused while still searching
    changed();
  }

  function move(delta) {
    if (!songs.length) { changed(); return; }
    if (delta > 0) playlist.next(); else playlist.prev();
    resetPosition();
    if (want) playCurrent(); else changed();
  }

  function select(index, andPlay) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= songs.length) { changed(); return; }
    if (!andPlay && want) { changed(); return; }           // moving the cursor never stops the music
    if (i !== playlist.index) playlist.select(i);
    resetPosition();
    if (andPlay) { want = true; playCurrent(); } else changed();
  }

  function resetPosition() {
    resume = null;
    time = 0;
    duration = 0;
    at = now();
    status = "";
    problem = false;
  }

  function seek(seconds) {
    let t = Number(seconds);
    if (!Number.isFinite(t)) { changed(); return; }
    t = Math.max(0, duration ? Math.min(t, Math.max(0, duration - 1)) : t);
    if (frame && current?.videoId && current.index === playlist.index) {
      frame.seek(t);
      time = t;
      at = now();
    } else if (resume && resume.index === playlist.index) {
      resume.time = t;
      time = t;
      at = now();
    }
    changed();
  }

  function setShuffle(on) {
    playlist.setShuffle(on);
    changed();
  }

  function setVolume(v) {
    volume = clampVolume(v, volume);
    if (frame) {
      frame.setVolume(volume);
      if (volume > 0) frame.unMute();
    }
    changed();
  }

  function setYear(y, pos, autoplay) {
    const n = Math.round(Number(y));
    if (!Number.isFinite(n)) { changed(); return; }
    if (n === year) { if (autoplay && !want) play(); else changed(); return; }
    const wasPlaying = want;
    freezeTime();
    seq++;
    clearWatchdog();
    if (want && frame?.hasPlayer) frame.pause();
    want = false;
    loadYear(n, pos);
    if (wasPlaying || autoplay) playCurrent(); else changed();
  }

  // ---- starting a song -----------------------------------------------------------------------------

  async function playCurrent(exclude = []) {
    const my = ++seq;
    clearWatchdog();
    want = true;
    const index = playlist.index;
    const song = songs[index];
    if (!song) { halt(TEXT.noSongs); return; }
    // The previous song stops now, not when the next one loads. Its PAUSED answer arrives while we
    // search, when current.videoId is null, so onState() ignores it.
    if (frame?.hasPlayer && current?.videoId && frameState !== STATE.PAUSED) frame.pause();
    current = { index, videoId: null, exclude };
    setFrameState(null);
    time = 0;
    duration = 0;
    at = now();
    // Keep "skipping..." on screen while the next song is looked up.
    if (status !== TEXT.retry && status !== TEXT.skip && status !== TEXT.notFound) status = TEXT.searching;
    problem = false;
    changed();
    let reply = null;
    try {
      reply = await lookup({ artist: song.artist, title: song.title, exclude });
    } catch (_) {
      reply = null;
    }
    if (my !== seq || !want) return;                      // paused, skipped or another song meanwhile
    if (!reply || !reply.ok || typeof reply.videoId !== "string") {
      const step = policy.onMiss();
      if (step.action === "halt") { halt(missText(reply)); return; }
      status = TEXT.notFound;
      playlist.next();
      playCurrent();
      return;
    }
    startVideo(reply.videoId, 0, exclude);
    prefetch();
  }

  function startVideo(videoId, start = 0, exclude = [], knownDuration = 0) {
    const my = ++seq;
    want = true;
    current = { index: playlist.index, videoId, exclude };
    setFrameState(null);
    videoError = null;
    unmuteTried = false;
    loadSeen = false;
    holdPaused = false;
    time = Math.max(0, Number(start) || 0);
    duration = Math.max(0, Number(knownDuration) || 0) || durations.get(videoId) || 0;
    at = now();
    status = TEXT.loading;
    problem = false;
    ensureFrame().load(videoId, time);
    armWatchdog(my);
    const known = videoErrors.get(videoId);
    if (known) onVideoError(known);
    changed();
  }

  function prefetch() {
    for (const i of playlist.upcoming(2)) {
      const song = songs[i];
      if (!song) continue;
      Promise.resolve()
        .then(() => lookup({ artist: song.artist, title: song.title, prefetch: true }))
        .catch(() => {});
    }
  }

  // A hidden player cannot show us its error screen: a video that does not start in time has failed.
  function armWatchdog(my) {
    clearWatchdog();
    let phase = "nudge";
    const check = () => {
      watchdog = null;
      if (my !== seq || !want || frameState === STATE.PLAYING) return;
      if (phase === "nudge") {
        phase = "stall";
        frame?.play();
        watchdog = setTimer(check, Math.max(0, TIMING.stallMs - TIMING.nudgeMs));
        return;
      }
      if (phase === "stall" && frameState === STATE.BUFFERING) {
        phase = "grace";
        watchdog = setTimer(check, TIMING.bufferGraceMs);
        return;
      }
      fail(videoError === AUTH ? AUTH : STALL);
    };
    watchdog = setTimer(check, TIMING.nudgeMs);
  }

  function fail(code) {
    clearWatchdog();
    if (!current?.videoId || !want) return;
    diag.error = code;
    const song = songs[current.index];
    if (!song) return;
    const step = policy.onError({ videoId: current.videoId, code, song: songKey(song), artist: song.artist, title: song.title });
    if (step.action === "halt") { halt(TEXT[step.why] || TEXT.refused); return; }
    // Another try that stays silent as long would run into Chrome's 30 s close, which then says only
    // "30 s without sound". Stop while we can still say why.
    if ((code === STALL || code === AUTH) && now() - lastSound + TIMING.stallMs >= TIMING.silenceMs) {
      halt(code === AUTH ? TEXT.auth : TEXT.noStart);
      return;
    }
    if (step.action === "retry") {
      status = TEXT.retry;
      playCurrent(step.exclude);
      return;
    }
    status = TEXT.skip;
    playlist.next();
    resume = null;
    playCurrent();
  }

  function halt(text) {
    freezeTime();
    want = false;
    seq++;
    clearWatchdog();
    pausedAt = now();
    holdPaused = true;
    if (frame?.hasPlayer) frame.pause();
    status = text;
    problem = true;
    changed();
  }

  // ---- what the YouTube frame tells us ---------------------------------------------------------------

  function onReady() {
    diag.ready = true;
    frame.setVolume(volume);
    if (volume > 0) frame.unMute();
  }

  function onState(s) {
    if (!current?.videoId) {                               // searching: news about the previous video
      // The frame still holds a video from before a year switch (or a pause while searching): a
      // late autoplay must not play while nobody wants music.
      if (s === STATE.PLAYING && !want) frame?.pause();
      return;
    }
    if (s === STATE.UNSTARTED || s === STATE.BUFFERING || s === STATE.PLAYING) loadSeen = true;
    else if ((s === STATE.PAUSED || s === STATE.ENDED) && !loadSeen) return; // from before loadVideoById
    setFrameState(s);
    if (s === STATE.PLAYING) {
      clearWatchdog();
      if (!want) {
        // Our pause lost the race with autoplay: pause again. Otherwise it is the user (media keys).
        if (holdPaused || now() - pausedAt < TIMING.echoMs) { frame?.pause(); return; }
        want = true;
      }
      status = "";
      problem = false;
      at = now();
      for (const bad of policy.onPlaying()) reportBad(bad);
      changed();
    } else if (s === STATE.PAUSED) {
      if (want) {                                          // paused from outside (media keys)
        want = false;
        seq++;
        clearWatchdog();
        pausedAt = now();
      }
      at = now();
      changed();
    } else if (s === STATE.ENDED) {
      if (want) {
        playlist.next();
        resume = null;
        playCurrent();
      } else {
        changed();
      }
    } else if (s === STATE.BUFFERING && want) {
      changed();
    }
  }

  function onTime(t, d) {
    if (!current?.videoId) return;
    const hadDuration = duration > 0;
    if (Number.isFinite(t)) { time = t; at = now(); }
    if (Number.isFinite(d) && d > 0) {
      duration = d;
      durations.set(current.videoId, d);
    }
    if (!hadDuration && duration > 0) { changed(); return; }
    if (want && frameState === STATE.PLAYING && now() - lastEmit >= TIMING.syncMs) changed();
  }

  function onVolume(v, muted) {
    if (Number.isFinite(v)) diag.ytVolume = v;
    // Never take YouTube's volume over ours: its first report is its own default, sent before our
    // setVolume arrived. Only undo a mute we did not ask for, once per video.
    if (muted && volume > 0 && !unmuteTried && frame) {
      unmuteTried = true;
      frame.unMute();
    }
  }

  function onVideoError(code) {
    if (!current?.videoId) return;
    videoError = code;
    if (current?.videoId) videoErrors.set(current.videoId, code);
    if (!want || frameState === STATE.PLAYING) return;
    clearWatchdog();
    const my = seq;
    watchdog = setTimer(() => {
      watchdog = null;
      if (my === seq && want && frameState !== STATE.PLAYING) fail(code === AUTH ? AUTH : STALL);
    }, TIMING.videoErrorMs);
  }

  return {
    boot,
    control,
    snapshot,
    handlers,
    get year() { return year; },
    get skin() { return skinForYear(year); }
  };
}
