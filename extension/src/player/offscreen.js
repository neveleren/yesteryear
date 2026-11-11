// Offscreen document (reason AUDIO_PLAYBACK): hosts the YouTube player and the playback engine, so the
// music keeps playing while the side panel is closed. Offscreen documents only get chrome.runtime:
// storage, the video search and all UIs go through the service worker (sw_music.js).
// sw_music.js creates this page on demand; Chrome closes it after 30 s without sound.
import { YouTubeFrame } from "./ytwidget.js";
import { createEngine } from "./engine.js";
import { MSG } from "./music_state.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(msg) {
  try {
    return (await chrome.runtime.sendMessage(msg)) ?? null;
  } catch (_) {
    return null; // nobody answered (normal for broadcasts)
  }
}

// Year, position, the video to resume and the volume, kept by the service worker.
async function bootContext() {
  for (let i = 0; i < 30; i++) {
    const ctx = await send({ type: MSG.boot });
    if (ctx && typeof ctx === "object") return ctx;
    await sleep(100);
  }
  return {};
}

async function start() {
  const [charts, ctx] = await Promise.all([
    fetch(chrome.runtime.getURL("src/player/charts.json")).then((r) => r.json()),
    bootContext()
  ]);
  const stage = document.getElementById("stage");
  const engine = createEngine({
    charts,
    makeFrame: (handlers) => new YouTubeFrame(stage, handlers),
    lookup: (query) => send({ type: "music:videoId", ...query }),
    reportBad: (bad) => { send({ type: "music:bad", ...bad }); },
    emit: (state) => { send({ type: MSG.changed, state: { ...state, alive: true }, source: "engine" }); }
  });
  engine.boot(ctx);
  return engine;
}

const ready = start();

// Registered right away: the service worker sends the first command as soon as the page has loaded.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== MSG.engine || sender.id !== chrome.runtime.id) return false;
  ready.then(
    (engine) => reply({ ok: true, state: { ...engine.control(msg), alive: true } }),
    (err) => reply({ ok: false, reason: String(err?.message || err) })
  );
  return true;
});
