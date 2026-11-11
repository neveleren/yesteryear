// The music state everybody passes around, the message names, and small pure helpers. Used by the
// engine (offscreen document), the service-worker hub (sw_music.js) and both remotes (side panel and
// popup mini player). No chrome.* and no DOM here, so node tests load it directly.
import { skinForYear } from "./playlist.js";

// Messages (chrome.runtime.sendMessage):
//   music:control      UI -> SW        {cmd, index?, play?, time?, volume?, on?} -> {ok, state, reason?}
//   music:state        UI -> SW        {} -> state
//   music:changed      engine/SW -> all {state, source: "engine" | "hub"}   (broadcast on every change)
//   music:engine       SW -> engine    {cmd, ...} -> {ok, state}            (internal)
//   music:engine:boot  engine -> SW    {} -> {year, pos, resume, volume}    (internal)
export const MSG = Object.freeze({
  control: "music:control",
  state: "music:state",
  changed: "music:changed",
  engine: "music:engine",
  boot: "music:engine:boot"
});

// What a UI may ask for. "select" plays song `index` (play:false only moves the cursor while paused);
// "seek" takes `time` in seconds, "volume" 0..100, "shuffle" an optional `on`.
export const COMMANDS = Object.freeze(["play", "pause", "toggle", "next", "prev", "select", "seek", "shuffle", "volume"]);

export const DEFAULT_YEAR = 2010;
export const DEFAULT_VOLUME = 80;
// Storage keys (module prefix "mus:", see ARCHITECTURE.md).
export const VOLUME_KEY = "mus:volume";     // chrome.storage.local: 0..100
export const SESSION_KEY = "mus:session";   // chrome.storage.session: the last state (resume after the
                                            // offscreen document was closed)
export const posKey = (year) => `mus:pos:${year}`; // chrome.storage.local: {index, shuffle} per year

// Why the music stopped when YouTube never started it. The engine gives up with this before Chrome
// closes its silent offscreen document; the hub says the same when Chrome closed it during loading.
export const NO_START_TEXT =
  "YouTube did not start the music (slow connection or a sign-in check). Open youtube.com once in this Chrome profile, then press Play.";

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const text = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function clampVolume(value, fallback = DEFAULT_VOLUME) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

// A command from a UI, checked and cut down to the fields its cmd uses; null if it is not one.
export function cleanCommand(msg) {
  const cmd = msg?.cmd;
  if (!COMMANDS.includes(cmd)) return null;
  const out = { cmd };
  if (cmd === "select") {
    const i = Number(msg.index);
    if (!Number.isInteger(i) || i < 0 || i > 9999) return null;
    out.index = i;
    out.play = msg.play !== false;
  } else if (cmd === "seek") {
    const t = Number(msg.time);
    if (!Number.isFinite(t) || t < 0) return null;
    out.time = t;
  } else if (cmd === "volume") {
    if (msg.volume === null || msg.volume === "" || !Number.isFinite(Number(msg.volume))) return null;
    out.volume = clampVolume(msg.volume);
  } else if (cmd === "shuffle" && typeof msg.on === "boolean") {
    out.on = msg.on;
  }
  return out;
}

// The one state shape. Unknown fields are dropped, missing or broken ones get defaults.
//   playing   the music is on (or about to start: then loading is true too)
//   time      position in seconds at the moment `at` (ms since epoch); see liveTime()
//   status    a short line for the user ("Searching...", or why it stopped when problem is true)
export function makeState(p = {}) {
  const year = Math.round(num(p.year, DEFAULT_YEAR));
  const t = p.track && typeof p.track === "object" ? p.track : null;
  const playing = p.playing === true;
  const out = {
    playing,
    loading: playing && p.loading === true,
    year,
    index: Math.max(0, Math.floor(num(p.index, 0))),
    length: Math.max(0, Math.floor(num(p.length, 0))),
    track: t ? { artist: text(t.artist), title: text(t.title), rank: Math.max(0, Math.floor(num(t.rank, 0))) } : null,
    time: Math.max(0, num(p.time, 0)),
    duration: Math.max(0, num(p.duration, 0)),
    at: Math.max(0, num(p.at, 0)),
    skin: skinForYear(year),
    shuffle: p.shuffle === true,
    volume: clampVolume(p.volume),
    status: text(p.status, 200),
    problem: p.problem === true,
    videoId: typeof p.videoId === "string" && VIDEO_ID_RE.test(p.videoId) ? p.videoId : null
  };
  if (p.diag && typeof p.diag === "object") {
    const d = p.diag;
    out.diag = {
      frame: Number.isFinite(d.frame) ? d.frame : null,       // YouTube player state (-1..5) or null
      ready: d.ready === true,                                 // the iframe answered the handshake
      ytVolume: Number.isFinite(d.ytVolume) ? d.ytVolume : null, // volume as YouTube reports it
      videoError: text(d.videoError, 40) || null,              // videoData.errorCode of this video
      error: Number.isFinite(d.error) ? d.error : text(d.error, 40) || null // last failure: onError code, "stall", "auth"
    };
  }
  if (typeof p.alive === "boolean") out.alive = p.alive;       // the offscreen document exists
  return out;
}

// Position in seconds right now: the engine reports the time every few seconds, UIs count on from there.
export function liveTime(state, now = Date.now()) {
  if (!state) return 0;
  let t = num(state.time, 0);
  if (state.playing && !state.loading && state.at) t += Math.max(0, now - state.at) / 1000;
  return state.duration ? Math.min(t, state.duration) : t;
}

// Should `next` replace `prev` on screen? States carry the time they were made; an older one (a late
// reply that crossed a broadcast) is dropped.
export function isNewer(prev, next) {
  if (!next) return false;
  if (!prev) return true;
  return num(next.at, 0) >= num(prev.at, 0);
}

// "Kesha - Tik Tok", or "" when there is no track.
export function trackText(state) {
  const t = state?.track;
  return t ? `${t.artist} - ${t.title}` : "";
}
