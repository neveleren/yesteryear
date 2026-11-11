// Playback logic for the music engine (engine.js): play order, shuffle, how to react to broken videos.
// No DOM and no chrome.* here, so node tests can drive it directly.

// Player look per chosen year (the media player people used then; CSS-only, see player.css).
export const SKINS = Object.freeze([
  { from: 1998, id: "winamp" },  // Winamp 2 classic
  { from: 2005, id: "wmp" },     // Windows Media Player 9-11
  { from: 2010, id: "itunes" },  // iTunes 10-11
  { from: 2015, id: "spotify" }  // Spotify dark
]);

export function skinForYear(year) {
  let id = SKINS[0].id;
  for (const s of SKINS) if (Number(year) >= s.from) id = s.id;
  return id;
}

export const songKey = (song) => `${song.artist}|${song.title}`;
export const formatTrack = (song) => `${song.artist} - ${song.title} (#${song.rank})`;

// The chart of a year from charts.json; a year without a list falls back to the closest earlier one.
export function songsFor(charts, year) {
  if (!charts || typeof charts !== "object") return [];
  const y = Math.round(Number(year));
  if (Array.isArray(charts[y])) return charts[y];
  const years = Object.keys(charts).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!years.length) return [];
  const near = years.filter((v) => v <= y).pop() ?? years[0];
  return Array.isArray(charts[near]) ? charts[near] : [];
}

// 216 -> "3:36", 3723 -> "1:02:03"
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// Small seeded PRNG so tests can pin the shuffle order.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rng) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Play order over a chart of `length` songs (indices 0..length-1).
// Normal: chart order, wrapping around. Shuffle: each round plays every other song once, in random
// order and never the same song twice in a row; prev walks back through what was actually played.
export class Playlist {
  #length;
  #index;
  #shuffle = false;
  #rng;
  #queue = [];   // shuffle: songs still to come
  #history = []; // shuffle: songs played before the current one

  constructor(length, { index = 0, shuffle = false, rng = Math.random } = {}) {
    this.#length = Math.max(0, Math.floor(Number(length) || 0));
    this.#rng = rng;
    const i = Math.floor(Number(index));
    this.#index = this.#length ? (Number.isFinite(i) && i >= 0 && i < this.#length ? i : 0) : -1;
    this.setShuffle(shuffle);
  }

  get length() { return this.#length; }
  get index() { return this.#index; }
  get shuffle() { return this.#shuffle; }

  setShuffle(on) {
    this.#shuffle = !!on;
    this.#queue = [];
    this.#history = [];
  }

  select(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.#length || i === this.#index) return this.#index;
    if (this.#shuffle) {
      this.#history.push(this.#index);
      this.#queue = this.#queue.filter((x) => x !== i);
    }
    this.#index = i;
    return i;
  }

  next() {
    if (this.#length === 0) return -1;
    if (!this.#shuffle) {
      this.#index = (this.#index + 1) % this.#length;
      return this.#index;
    }
    this.#fill(1);
    this.#history.push(this.#index);
    this.#index = this.#queue.shift();
    return this.#index;
  }

  prev() {
    if (this.#length === 0) return -1;
    if (!this.#shuffle) {
      this.#index = (this.#index - 1 + this.#length) % this.#length;
      return this.#index;
    }
    if (this.#history.length) {
      this.#queue.unshift(this.#index);
      this.#index = this.#history.pop();
    }
    return this.#index;
  }

  // The next n songs in play order, without moving (used to look video ids up ahead of time).
  upcoming(n) {
    const count = Math.max(0, Math.floor(n));
    if (this.#length <= 1 || count === 0) return [];
    if (!this.#shuffle) {
      return Array.from({ length: Math.min(count, this.#length - 1) }, (_, k) => (this.#index + k + 1) % this.#length);
    }
    this.#fill(count);
    return this.#queue.slice(0, count);
  }

  #fill(n) {
    if (this.#length === 1) {
      while (this.#queue.length < n) this.#queue.push(0);
      return;
    }
    while (this.#queue.length < n) {
      // A round is every song except the one right before it, so nothing repeats back to back.
      const last = this.#queue.length ? this.#queue[this.#queue.length - 1] : this.#index;
      const all = Array.from({ length: this.#length }, (_, k) => k).filter((k) => k !== last);
      this.#queue.push(...shuffled(all, this.#rng));
    }
  }
}

// ---- broken videos ----------------------------------------------------------------------------

// YouTube iframe API onError codes that are about the video itself.
export const VIDEO_ERRORS = new Set([2, 5, 100, 101, 150]);
// 152/153: the embed did not get the Referer header (our DNR rule): every video would fail.
export const CONFIG_ERRORS = new Set([152, 153]);
// Failures the engine detects itself; YouTube sends no onError for them.
//   STALL: the video never started.
//   AUTH: the player's videoData says errorCode "auth" (YouTube wants a sign-in: bot check or age
//         limit). Live test 2026-11-11: without its bot check script the embed stays at -1 with
//         errorCode "auth" and no onError at all.
export const STALL = "stall";
export const AUTH = "auth";

// Failed videos are only suspects until something actually plays. A bot check or a dead network makes
// every video fail, and marking them all bad would poison the cache for good.
export class ErrorPolicy {
  constructor({ attemptsPerSong = 3, errorsInRow = 5, missesInRow = 8, authInRow = 3 } = {}) {
    this.limits = { attemptsPerSong, errorsInRow, missesInRow, authInRow };
    this.reset();
  }

  reset() {
    this.errors = 0;           // video errors since the last successful playback
    this.misses = 0;           // songs without any video since the last successful playback
    this.auths = 0;            // sign-in walls since the last successful playback
    this.suspects = [];        // [{videoId, code, song, artist, title}]
    this.tried = new Map();    // song key -> Set of video ids that failed
  }

  // A video failed. -> {action: "retry", exclude} (next search hit of the same song)
  //                  | {action: "skip"} (next song) | {action: "halt", why}
  onError({ videoId, code, song, artist, title }) {
    if (CONFIG_ERRORS.has(code)) return { action: "halt", why: "referer" };
    this.errors++;
    // Only YouTube's own codes say something about the video. A stall or a sign-in wall can be about
    // this browser, so those videos are never reported as broken.
    if (videoId && typeof code === "number") this.suspects.push({ videoId, code, song, artist, title });
    const tried = this.tried.get(song) || new Set();
    if (videoId) tried.add(videoId);
    this.tried.set(song, tried);
    if (code === AUTH && ++this.auths >= this.limits.authInRow) return { action: "halt", why: "auth" };
    if (this.errors >= this.limits.errorsInRow) return { action: "halt", why: "refused" };
    if (tried.size >= this.limits.attemptsPerSong) return { action: "skip" };
    return { action: "retry", exclude: [...tried] };
  }

  // No video could be found for a song.
  onMiss() {
    this.misses++;
    return this.misses >= this.limits.missesInRow ? { action: "halt", why: "misses" } : { action: "skip" };
  }

  // Something is playing, so YouTube serves us fine: earlier failures were about those videos.
  // Returns the confirmed bad videos (to report as music:bad).
  onPlaying() {
    const confirmed = this.suspects;
    this.errors = 0;
    this.misses = 0;
    this.auths = 0;
    this.suspects = [];
    this.tried = new Map();
    return confirmed;
  }
}
