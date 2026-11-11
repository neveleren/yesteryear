// Side panel: remote control and playlist for the music, in the look of the chosen year's player.
// The sound plays in the offscreen document (offscreen.js), so "Hide player" only closes this panel
// and the music keeps going. Extension page: bundled scripts only (CSP), DOM built with
// createElement/textContent.
import { connectMusic } from "./remote.js";
import { songsFor, formatTime } from "./playlist.js";
import { liveTime } from "./music_state.js";
import { createVisualizer } from "./visualizer.js";

const $ = (id) => document.getElementById(id);
const APP_NAMES = Object.freeze({ winamp: "Winamp", wmp: "Windows Media Player", itunes: "iTunes", spotify: "Spotify" });
const el = {
  app: $("app-name"), yearTag: $("year-tag"), hide: $("hide"),
  clock: $("clock"), stateInd: $("state-ind"), time: $("time"),
  visBox: $("vis-box"), vis: $("vis"), idle: $("idle"), idleYear: $("idle-year"),
  marquee: $("marquee"), track: $("track"), sub: $("sub"),
  elapsed: $("elapsed"), seek: $("seek"), total: $("total"),
  prev: $("prev"), play: $("play"), next: $("next"), shuffle: $("shuffle"), volume: $("volume"),
  status: $("status"), plTitle: $("pl-title"), plCount: $("pl-count"), list: $("list")
};

let charts = null;
let state = null;
let listYear = null;
let shownIndex = -1;
let cursor = -1;          // keyboard / click selection in the list
let showLeft = false;     // the clock shows the time left (click it, like in Winamp)
let seeking = false;      // the user holds the position slider
let volumeHeld = false;   // ...or the volume slider
let volumeTimer = 0;

const vis = createVisualizer(el.vis);
const music = connectMusic(render);

fetch(chrome.runtime.getURL("src/player/charts.json"))
  .then((r) => r.json())
  .then((data) => { charts = data; if (state) render(state); })
  .catch(() => { el.plCount.textContent = "list not available"; });

// ---- render -----------------------------------------------------------------------------------

function render(s) {
  state = s;
  const skin = s.skin;
  if (document.body.dataset.skin !== skin) {
    document.body.dataset.skin = skin;
    el.track.dataset.text = ""; // fonts and widths changed: measure the marquee again
  }
  el.app.textContent = APP_NAMES[skin] || "Player";
  el.yearTag.textContent = String(s.year);
  el.idleYear.textContent = String(s.year);
  el.plTitle.textContent = `Billboard Year-End Hot 100 of ${s.year}`;
  el.plCount.textContent = s.length ? `${s.length} songs` : "";
  el.visBox.dataset.label = `Hot Hits ${s.year}`;
  el.visBox.style.setProperty("--hue", String((s.year * 47) % 360));

  const t = s.track;
  if (!t) setMarquee("No songs for this year");
  else if (skin === "winamp") setMarquee(`${s.index + 1}. ${t.artist} - ${t.title}${s.duration ? ` (${formatTime(s.duration)})` : ""}`, "  ***  ");
  else setMarquee(t.title);
  el.sub.textContent = t ? t.artist : "";

  el.play.classList.toggle("is-playing", s.playing);
  el.play.setAttribute("aria-label", s.playing ? "Pause" : "Play");
  el.stateInd.className = `state-ind ico ${s.playing ? "play" : s.time > 0 ? "pause" : "stop"}`;
  el.shuffle.setAttribute("aria-pressed", String(s.shuffle));
  if (!volumeHeld) { el.volume.value = String(s.volume); setFill(el.volume); }

  el.status.textContent = s.status;
  el.status.classList.toggle("problem", s.problem);
  el.idle.hidden = s.playing || s.time > 0 || s.duration > 0;

  vis.setSkin(skin);
  vis.setTrack(t ? `${t.artist}|${t.title}` : "");
  vis.setMode(s.playing ? (s.loading ? "load" : "play") : "idle");

  if (charts && listYear !== s.year) buildList(s.year);
  highlightCurrent(s.index);
  updateClock();
}

function updateClock() {
  if (!state) return;
  const now = liveTime(state);
  const dur = state.duration;
  const left = showLeft && dur > 0;
  el.time.textContent = formatTime(left ? Math.max(0, dur - now) : now);
  el.clock.classList.toggle("left", left);
  el.elapsed.textContent = formatTime(now);
  el.total.textContent = state.skin === "itunes" && dur ? `-${formatTime(Math.max(0, dur - now))}` : formatTime(dur);
  el.seek.disabled = !(dur > 0 && state.videoId);
  if (!seeking) {
    el.seek.max = String(Math.max(1, Math.round(dur)));
    el.seek.value = String(Math.round(now));
    setFill(el.seek);
  }
}

function setFill(input) {
  const max = Number(input.max) || 1;
  const pct = Math.min(100, Math.max(0, (Number(input.value) / max) * 100));
  input.style.setProperty("--fill", `${pct}%`);
}

// The title scrolls only when it does not fit, Winamp style ("text *** text *** ").
function setMarquee(text, gap = "     ") {
  if (el.track.dataset.text === text) return;
  el.track.dataset.text = text;
  el.track.textContent = text;
  el.marquee.classList.remove("scroll");
  requestAnimationFrame(() => {
    if (el.track.dataset.text !== text || el.track.scrollWidth <= el.marquee.clientWidth + 1) return;
    el.track.textContent = text + gap + text + gap;
    el.marquee.style.setProperty("--marquee-s", `${Math.max(6, Math.round((text.length + gap.length) / 4))}s`);
    el.marquee.classList.add("scroll");
  });
}

new ResizeObserver(() => {
  const text = el.track.dataset.text;
  if (text) { el.track.dataset.text = ""; setMarquee(text, state?.skin === "winamp" ? "  ***  " : "     "); }
}).observe(el.marquee);

// ---- playlist ---------------------------------------------------------------------------------

function span(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function buildList(year) {
  listYear = year;
  shownIndex = -1;
  cursor = -1;
  const frag = document.createDocumentFragment();
  songsFor(charts, year).forEach((song, i) => {
    const li = document.createElement("li");
    li.id = `song-${i}`;
    li.dataset.i = String(i);
    li.setAttribute("role", "option");
    li.title = `${song.artist} - ${song.title} (#${song.rank})`;
    li.append(span("n", String(i + 1)), span("ar", song.artist), span("ti", song.title));
    frag.append(li);
  });
  el.list.replaceChildren(frag);
  el.list.removeAttribute("aria-activedescendant");
}

function highlightCurrent(index) {
  if (index === shownIndex) return;
  const old = el.list.querySelector("li.current");
  old?.classList.remove("current");
  old?.removeAttribute("aria-current");
  const li = el.list.children[index];
  if (li) {
    li.classList.add("current");
    li.setAttribute("aria-current", "true");
    if (cursor < 0) li.scrollIntoView({ block: "nearest" });
  }
  shownIndex = index;
}

function setCursor(i) {
  const n = el.list.children.length;
  if (!n) return;
  cursor = Math.min(n - 1, Math.max(0, i));
  el.list.querySelector("li.sel")?.classList.remove("sel");
  const li = el.list.children[cursor];
  li.classList.add("sel");
  li.scrollIntoView({ block: "nearest" });
  el.list.setAttribute("aria-activedescendant", li.id);
}

const itemIndex = (event) => {
  const li = event.target.closest?.("li[data-i]");
  return li ? Number(li.dataset.i) : -1;
};

el.list.addEventListener("click", (event) => {
  const i = itemIndex(event);
  if (i < 0) return;
  setCursor(i);
  if (!state?.playing) music.control("select", { index: i, play: false });
});
el.list.addEventListener("dblclick", (event) => {
  const i = itemIndex(event);
  if (i >= 0) music.control("select", { index: i });
});
el.list.addEventListener("keydown", (event) => {
  const from = cursor < 0 ? (state?.index ?? 0) : cursor;
  const page = Math.max(1, Math.floor(el.list.clientHeight / 18) - 1);
  const moves = { ArrowDown: from + 1, ArrowUp: from - 1, PageDown: from + page, PageUp: from - page, Home: 0, End: el.list.children.length - 1 };
  if (event.key in moves) {
    event.preventDefault();
    setCursor(moves[event.key]);
  } else if (event.key === "Enter" && cursor >= 0) {
    event.preventDefault();
    music.control("select", { index: cursor });
  }
});

// ---- transport ------------------------------------------------------------------------------------

el.play.addEventListener("click", () => music.control("toggle"));
el.prev.addEventListener("click", () => music.control("prev"));
el.next.addEventListener("click", () => music.control("next"));
el.shuffle.addEventListener("click", () => music.control("shuffle"));

el.seek.addEventListener("input", () => {
  seeking = true;
  setFill(el.seek);
  el.elapsed.textContent = formatTime(Number(el.seek.value));
  if (!showLeft) el.time.textContent = formatTime(Number(el.seek.value));
});
el.seek.addEventListener("change", () => {
  music.control("seek", { time: Number(el.seek.value) }).finally(() => { seeking = false; });
});

el.volume.addEventListener("input", () => {
  volumeHeld = true;
  setFill(el.volume);
  if (!volumeTimer) {
    volumeTimer = setTimeout(() => { volumeTimer = 0; music.control("volume", { volume: Number(el.volume.value) }); }, 120);
  }
});
el.volume.addEventListener("change", () => {
  clearTimeout(volumeTimer);
  volumeTimer = 0;
  music.control("volume", { volume: Number(el.volume.value) }).finally(() => { volumeHeld = false; });
});

function toggleClock() {
  showLeft = !showLeft;
  updateClock();
}
el.clock.addEventListener("click", toggleClock);
el.clock.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleClock(); }
});

// Winamp's keys: Z previous, X play, C pause, V stop, B next; Space plays or pauses.
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
  const target = event.target;
  const inControl = target instanceof HTMLInputElement || target instanceof HTMLButtonElement;
  const key = event.key.toLowerCase();
  const playing = !!state?.playing;
  if (key === " " && !inControl && target !== el.clock) { event.preventDefault(); music.control("toggle"); }
  else if (key === "z") music.control("prev");
  else if (key === "x" && !playing) music.control("play");
  else if ((key === "c" || key === "v") && playing) music.control("pause");
  else if (key === "b") music.control("next");
});

// ---- hide -------------------------------------------------------------------------------------------

// Closes this panel only; the music plays on in the offscreen document.
el.hide.addEventListener("click", async () => {
  try {
    if (chrome.sidePanel?.close) {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.close({ windowId: win.id });
      return;
    }
  } catch (_) { /* not a side panel (e.g. opened as a tab), or an older Chrome */ }
  window.close();
});

setInterval(() => { if (state?.playing && !state.loading) updateClock(); }, 250);
