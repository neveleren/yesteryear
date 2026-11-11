// Shared fakes for the player tests: a tiny chart, a fake YouTube frame, a chrome.storage-like area,
// and a manual clock with timers. Not a test file itself (node --test only runs *.test.mjs here).
import { STATE } from "../../extension/src/player/ytwidget.js";

const song = (rank, artist, title) => ({ rank, artist, title });
export const CHARTS = {
  2010: [song(1, "Kesha", "Tik Tok"), song(2, "Lady Antebellum", "Need You Now"), song(3, "Train", "Hey, Soul Sister"),
    song(4, "Katy Perry", "California Gurls"), song(5, "Usher", "OMG"), song(6, "B.o.B", "Airplanes")],
  2011: [song(1, "Adele", "Rolling in the Deep"), song(2, "Maroon 5", "Moves like Jagger"), song(3, "LMFAO", "Party Rock Anthem")]
};

// A stable fake video id per title; n tells apart the next hits of the same song.
export const idFor = (title, n = 0) => (title.replace(/[^A-Za-z]/g, "") + "xxxxxxxxxxx").slice(0, 10) + n;

export class FakeFrame {
  constructor(handlers) { this.handlers = handlers; this.calls = []; this.hasPlayer = false; this.videoId = null; }
  load(id, start) { this.calls.push(["load", id, start]); this.hasPlayer = true; this.videoId = id; }
  play() { this.calls.push(["play"]); }
  pause() {
    this.calls.push(["pause"]);
    // YouTube answers pauseVideo with onStateChange 2, a moment later.
    if (this.echoPause) setImmediate(() => this.handlers.onState(STATE.PAUSED));
  }
  seek(t) { this.calls.push(["seek", t]); }
  setVolume(v) { this.calls.push(["setVolume", v]); }
  unMute() { this.calls.push(["unMute"]); }
  loads() { return this.calls.filter((c) => c[0] === "load"); }
  // what YouTube would report
  ready() { this.handlers.onReady(); }
  state(s) { this.handlers.onState(s); }
  starts() { this.state(STATE.UNSTARTED); this.state(STATE.BUFFERING); this.state(STATE.PLAYING); }
  time(t, d) { this.handlers.onTime(t, d); }
  error(code) { this.handlers.onError(code); }
  videoError(code) { this.handlers.onVideoError(code); }
  volume(v, muted) { this.handlers.onVolume(v, muted); }
}

// chrome.storage.local / .session look-alike (values are copied, like the real thing).
export function storageArea(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) { data[k] = structuredClone(v); writes.push(k); }
    }
  };
}

// Manual clock: timers fire only from advance().
export function manualClock(start = 1_000_000) {
  let t = start;
  let nextId = 1;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  return {
    timers,
    flush,
    now: () => t,
    tick: (ms) => { t += ms; },
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { due: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        t = next[1].due;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      t = end;
      await flush();
    }
  };
}
