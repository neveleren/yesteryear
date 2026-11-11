// The time-travel moment: travel.html#from=<year>&to=<year>[&sound=0][&t=<nonce>]
//  1. a time tunnel (warp.js) while an odometer rolls from the departure year to the destination
//  2. at 88 MPH: white flash and a boom (sfx.js, only when Chrome lets the page play sound)
//  3. a CRT power-on into a landing card dressed like the PC of that year (eras: travel_core.js)
// Any key or click skips to the card. Extension page: bundled scripts only, DOM built with createElement.
import { DEFAULTS } from "../shared/state_sw.js";
import { connectMusic } from "../player/remote.js";
import {
  normalizeTrip, parseTravelHash, eraFor, ROUNDED_FROM, odometerWheels, TIMELINE, yearAt, speedAt, mphAt,
  phaseAt, flashAt, sameDayIn, longDate, circuitDate, trayTime, frontPages, numberOne, landingPlan,
  googleSearchUrl, musicLine, noPlayerText
} from "./travel_core.js";
import { Warp } from "./warp.js";
import { createSfx } from "./sfx.js";

const HAS_CHROME = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
const PHASES = ["boot", "intro", "roll", "lock", "flash", "crt", "done"];
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const navType = performance.getEntriesByType?.("navigation")?.[0]?.type || "navigate";
const present = new Date().getFullYear();
const today = new Date();

const sfx = createSfx();
let trip = null;          // {from, to, direction}
let soundWanted = true;   // travel.html#...&sound=0 keeps the trip silent
let warp = null;
let raf = 0;
let startAt = null;
let phase = "boot";
let running = false;
let wheels = [];          // [{strip, blur, pos, sd}]
let cellPx = 0;           // height of one digit on a drum
let windowId = null;      // for chrome.sidePanel.open()
let skipTimers = [];      // timeouts of a skip, cleared when a new trip starts
let music = null;         // live music state for the card's status line, after "Play the hits" (followMusic)
let followed = null;      // {forTrip, year} whose status line follows the music, kept over a pagehide
const el = {};            // elements touched during the trip
const ui = {};            // landing card elements

// ---- Small helpers ------------------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

// replaceChildren() would print a null or false child as text: drop them first.
const kept = (...kids) => kids.filter((k) => k != null && k !== false);

function send(msg) {
  return new Promise((resolve) => {
    if (!HAS_CHROME) { resolve(null); return; }
    try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)); } catch (_) { resolve(null); }
  });
}

async function fetchJson(path) {
  try {
    const res = await fetch(path);
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

const extUrl = (path) => new URL(`../../${path}`, location.href).href;

// ---- Trip and HUD --------------------------------------------------------------------------------------
async function readTrip() {
  const p = parseTravelHash(location.hash);
  soundWanted = p.sound;
  let t = normalizeTrip(p.from, p.to, present);
  if (!t && HAS_CHROME) {
    // No destination in the address: travel to the year the time machine is set to.
    try { t = normalizeTrip(p.from, (await chrome.storage.local.get("year")).year, present); } catch (_) { /* default below */ }
  }
  return { ...(t || normalizeTrip(present, DEFAULTS.year, present)), nonce: p.t };
}

// Nonces of the trips this tab has played (sessionStorage lives as long as the tab). Seeing one again means
// the user went Back or Forward to it: show that card, do not fly again.
const PLAYED_KEY = "travel:played";
function playedNonces() {
  try { return JSON.parse(sessionStorage.getItem(PLAYED_KEY) || "[]"); } catch (_) { return []; }
}
function markPlayed(nonce) {
  if (!nonce) return;
  try { sessionStorage.setItem(PLAYED_KEY, JSON.stringify([...playedNonces().filter((n) => n !== nonce), nonce].slice(-50))); } catch (_) { /* private mode: fine */ }
}

function readout(kind, label, value) {
  return h("div", { class: `readout ${kind}` }, h("span", { class: "rl", text: label }), h("b", { text: value }));
}

function buildHud() {
  const dep = sameDayIn(trip.from, today);
  const dest = sameDayIn(trip.to, today);
  el.title = h("p", { class: "hud-title", text: trip.direction === "forward" ? "Traveling forward in time" : "Traveling back in time" });
  el.odo = h("div", { class: "odo" });
  wheels = [];
  for (let i = 0; i < 4; i++) {
    const strip = h("div", { class: "strip" }, Array.from({ length: 11 }, (_, d) => h("span", { text: String(d % 10) })));
    el.odo.append(h("div", { class: "wheel" }, strip));
    wheels.push({ strip, blur: document.querySelector(`#blur${i} feGaussianBlur`), pos: null, sd: 0 });
  }
  el.mph = h("span", { class: "mph", text: "0" });
  const readouts = h("div", { class: "readouts" },
    readout("dest", "Destination time", circuitDate(dest)),
    h("div", { class: "readout speed" }, h("span", { class: "rl", text: "Speed" }), h("b", {}, el.mph, " MPH")),
    readout("dep", "Last time departed", circuitDate(dep)));
  el.hud = $("hud");
  el.hud.replaceChildren(el.title, el.odo, readouts);
  el.hud.setAttribute("aria-label", `Time travel from ${trip.from} to ${trip.to}`);
  measure();
}

function measure() {
  cellPx = wheels[0]?.strip.parentElement.clientHeight || 0;
  warp?.resize();
}

// Drum positions for a continuous year, with vertical motion blur while a drum spins fast.
function setOdometer(value) {
  odometerWheels(value, 4).forEach((pos, i) => {
    const w = wheels[i];
    w.strip.style.transform = `translate3d(0, ${(-pos * 100 / 11).toFixed(3)}%, 0)`;
    let moved = w.pos === null ? 0 : Math.abs(pos - w.pos);
    moved = Math.min(moved, 10 - moved); // 9.9 -> 0.1 is a small step, not a whole turn
    w.pos = pos;
    const sd = reduceMotion ? 0 : Math.round(Math.min(cellPx * 0.16, moved * cellPx * 0.45) * 2) / 2;
    if (sd === w.sd) return;
    w.sd = sd;
    if (w.blur) w.blur.setAttribute("stdDeviation", `0 ${sd}`);
    w.strip.style.filter = sd >= 1 ? `url(#blur${i})` : "none";
  });
}

// ---- The trip ------------------------------------------------------------------------------------------
function clearSkipTimers() {
  skipTimers.forEach(clearTimeout);
  skipTimers = [];
}

function startTrip() {
  cancelAnimationFrame(raf);
  clearSkipTimers();
  running = true;
  startAt = null;
  phase = "boot";
  root.dataset.phase = "boot";
  document.title = `Traveling to ${trip.to}...`;
  $("landing").hidden = true;
  $("landing").classList.remove("crt-on", "crt-quick");
  $("trip").hidden = false;
  // Measured again now that the drums are on screen: a HUD built or resized while the trip was hidden (the
  // next trip in this tab, a resize under the card) measured 0 px drums, and so no motion blur.
  measure();
  el.odo.classList.remove("locked");
  el.title.textContent = trip.direction === "forward" ? "Traveling forward in time" : "Traveling back in time";
  for (const w of wheels) w.pos = null;
  setOdometer(trip.from);
  if (!reduceMotion) {
    warp = new Warp($("warp"), { direction: trip.direction === "forward" ? "forward" : "back" });
  }
  addEventListener("keydown", onSkipKey, true);
  addEventListener("pointerdown", onSkipPointer, true);
  if (soundWanted) {
    sfx.unlock().then((ok) => {
      if (!ok || !running) return;
      const elapsed = startAt === null ? 0 : performance.now() - startAt;
      if (elapsed < TIMELINE.flash - 300) sfx.whoosh((TIMELINE.flash - elapsed) / 1000);
    });
  }
  raf = requestAnimationFrame(frame);
}

function frame(now) {
  if (startAt === null) startAt = now;
  const ms = now - startAt;
  enterPhase(phaseAt(ms));
  if (ms < TIMELINE.land) {
    const speed = speedAt(ms);
    warp?.frame(ms, speed);
    setOdometer(yearAt(ms, trip.from, trip.to));
    el.mph.textContent = String(mphAt(ms));
    if (!reduceMotion) {
      const amp = speed ** 3 * 5;
      el.hud.style.transform = amp > 0.3 ? `translate(${((Math.random() - 0.5) * amp).toFixed(1)}px, ${((Math.random() - 0.5) * amp).toFixed(1)}px)` : "";
      el.odo.style.setProperty("--ab", (speed ** 2 * 4).toFixed(2));
    }
  }
  const flash = flashAt(ms);
  $("flash").style.opacity = String(reduceMotion ? Math.min(0.3, flash) : flash);
  if (ms >= TIMELINE.done) { finish(); return; }
  raf = requestAnimationFrame(frame);
}

// Walks through every phase up to `next`, so a frame that jumps ahead (a hidden tab) still locks the
// odometer, flashes and shows the card.
function enterPhase(next) {
  let i = PHASES.indexOf(phase);
  const target = PHASES.indexOf(next);
  while (i < target) {
    i += 1;
    phase = PHASES[i];
    root.dataset.phase = phase;
    if (phase === "lock") {
      setOdometer(trip.to);
      el.odo.classList.add("locked");
      el.title.textContent = `Destination reached: ${trip.to}`;
    } else if (phase === "flash") {
      sfx.boom();
    } else if (phase === "crt") {
      showLanding(false);
    }
  }
}

function showLanding(quick) {
  const landing = $("landing");
  landing.hidden = false;
  landing.classList.remove("crt-on", "crt-quick");
  void landing.offsetWidth; // restart the animation on a replay
  landing.classList.add(quick ? "crt-quick" : "crt-on");
  const scan = $("scan");
  scan.classList.remove("on");
  void scan.offsetWidth;
  scan.classList.add("on");
  $("trip").hidden = true;
  el.hud.style.transform = "";
  document.title = `Welcome to ${trip.to}`;
  sfx.crt();
}

function finish() {
  running = false;
  cancelAnimationFrame(raf);
  phase = "done";
  root.dataset.phase = "done";
  $("flash").style.opacity = "0";
  removeEventListener("keydown", onSkipKey, true);
  removeEventListener("pointerdown", onSkipPointer, true);
  // Nothing gets focus here: a Space pressed to skip a moment too late must not press "Search".
}

// Any key or click jumps to the card. Keys that belong to the browser (Ctrl+R, Alt+Tab, F5, F11...) do not.
function onSkipKey(event) {
  if (event.ctrlKey || event.altKey || event.metaKey || /^F\d{1,2}$/.test(event.key)) return;
  if (["Control", "Alt", "Meta", "Shift", "OS", "CapsLock", "NumLock", "ScrollLock"].includes(event.key)) return;
  event.preventDefault();
  skip();
}

function onSkipPointer(event) {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  skip();
}

function skip() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(raf);
  sfx.hush();
  // The key or click is a user gesture: from here on the page may play sound.
  if (soundWanted) sfx.unlock(150).then((ok) => { if (ok) sfx.crt(); });
  setOdometer(trip.to);
  el.odo.classList.add("locked");
  phase = "crt";
  root.dataset.phase = "crt";
  const flash = $("flash");
  flash.classList.remove("fade");
  flash.style.opacity = reduceMotion ? "0.2" : "0.85";
  void flash.offsetWidth; // the flash is up now; from here it fades out
  flash.classList.add("fade");
  flash.style.opacity = "0";
  skipTimers.push(setTimeout(() => flash.classList.remove("fade"), 600));
  showLanding(true);
  skipTimers.push(setTimeout(finish, 450));
}

// ---- Landing card --------------------------------------------------------------------------------------
function buildLanding() {
  const year = trip.to;
  const date = sameDayIn(year, today);
  const era = eraFor(year);

  const close = h("button", { type: "button", class: "win-ctl close", "aria-label": "Close", title: "Close" });
  close.addEventListener("click", closeTab);
  const titleBar = h("div", { class: "win-title" },
    h("img", { class: "win-icon", src: "../ui/icons/icon16.png", srcset: "../ui/icons/icon16.png 1x, ../ui/icons/icon32.png 2x", width: 16, height: 16, alt: "" }),
    h("span", { class: "win-title-text", id: "win-title", text: `Welcome to ${year}` }),
    h("span", { class: "win-ctls" },
      h("span", { class: "win-ctl min", "aria-hidden": "true" }),
      h("span", { class: "win-ctl max", "aria-hidden": "true" }),
      close));

  const hero = h("header", { class: "hero" },
    h("h1", {}, "Welcome to ", h("span", { class: "yr", text: String(year) })),
    h("p", { class: "date", text: `It is ${longDate(date)}.` }));

  ui.meme = h("section", { class: "box meme", hidden: true, "aria-label": `Meme of ${year}` });
  ui.song = h("section", { class: "box song", hidden: true, "aria-label": `Number one song of ${year}` });
  ui.facts = h("section", { class: "box facts", hidden: true, "aria-label": `Also in ${year}` });
  ui.gadget = h("section", { class: "box gadget", hidden: true, "aria-label": "Everyone wants" });
  ui.grid = h("div", { class: "grid" }, ui.meme, h("div", { class: "side" }, ui.song, ui.facts, ui.gadget));

  ui.search = h("button", { type: "button", class: "btn primary", text: `Search like it's ${year}` });
  ui.search.addEventListener("click", searchLikeIts);
  ui.hits = h("button", { type: "button", class: "btn", text: `Play the hits of ${year}` });
  ui.hits.addEventListener("click", playHits);

  // Rows of links: searches and sites come with the year data (fillLanding), the front pages need only the day.
  ui.searches = h("dd", { class: "searches" });
  ui.searchRow = h("div", { class: "row", hidden: true }, h("dt", { text: "People are searching:" }), ui.searches);
  ui.sites = h("dd", { class: "sites" });
  ui.siteRow = h("div", { class: "row", hidden: true }, h("dt", { text: "Web favorites:" }), ui.sites);
  const links = frontPages(date).map((site) =>
    archiveLink(site.label, site.path, `${site.label} front page, ${longDate(date)} (Internet Archive)`));
  const todayRow = h("div", { class: "row" }, h("dt", { class: "today-label", text: `Today in ${year}:` }), h("dd", { class: "today" }, links));

  ui.status = h("p", { class: "status", role: "status" });
  const replayBtn = h("button", { type: "button", class: "linkish", text: "Replay the trip" });
  replayBtn.addEventListener("click", replay);

  const body = h("div", { class: "win-body" },
    hero,
    ui.grid,
    h("div", { class: "actions" }, ui.search, ui.hits),
    h("dl", { class: "rows" }, ui.searchRow, ui.siteRow, todayRow),
    h("div", { class: "foot" }, ui.status, replayBtn));

  const win = h("section", { class: "win", "aria-labelledby": "win-title" }, titleBar, body);
  $("landing").replaceChildren(h("main", { class: "desktop" }, win), buildTaskbar(year, era));
}

let clockTimer = 0;
function buildTaskbar(year, era) {
  const clock = h("span", { class: "clock", text: trayTime(new Date()) });
  clearInterval(clockTimer);
  clockTimer = setInterval(() => { clock.textContent = trayTime(new Date()); }, 15000);
  const startText = { win98: "Start", xp: "start", aero: "", flat: "" }[era];
  // The taskbar search box came with Windows 10 (2015); Windows 11 calls it just "Search".
  const search = year >= ROUNDED_FROM ? "Search" : year >= 2015 ? "Type here to search" : "";
  return h("footer", { class: "taskbar", "aria-hidden": "true" },
    h("span", { class: "start", text: startText }),
    era === "flat" && search ? h("span", { class: "search", text: search }) : null,
    h("span", { class: "task", text: `Welcome to ${year}` }),
    h("span", { class: "tray" }, clock));
}

function boxTitle(text) {
  return h("h2", { class: "box-title", text });
}

// Fills the card from years.json: nothing dated after the card's day (see landingPlan in travel_core.js).
function fillLanding(years, song) {
  const year = trip.to;
  const date = sameDayIn(year, today);
  const plan = landingPlan(years, year, date);
  fillMeme(plan.meme, year);
  if (song) {
    ui.song.replaceChildren(
      boxTitle(`No. 1 song of ${year}`),
      h("p", { class: "song-title", text: `"${song.title}"` }),
      h("p", { class: "song-artist", text: song.artist }),
      h("p", { class: "small", text: "Billboard Year-End Hot 100" }));
    ui.song.hidden = false;
  }
  if (plan.facts.items.length) {
    const label = plan.facts.still ? `Looking back at ${plan.facts.year}` : `Also in ${year}`;
    ui.facts.setAttribute("aria-label", label);
    ui.facts.replaceChildren(boxTitle(label), h("ul", {}, plan.facts.items.map((f) => h("li", { text: f }))));
    ui.facts.hidden = false;
  }
  if (plan.tech) {
    const label = plan.tech.still ? "Everyone still wants" : "Everyone wants";
    ui.gadget.setAttribute("aria-label", label);
    ui.gadget.replaceChildren(...kept(boxTitle(label), h("p", { class: "gadget-name", text: plan.tech.text }),
      plan.tech.still && h("p", { class: "small", text: `The must-have of ${plan.tech.year}` })));
    ui.gadget.hidden = false;
  }
  ui.searches.replaceChildren(...plan.searches.map((q) => {
    const a = h("a", { href: googleSearchUrl(q), title: `Search Google for "${q}" in ${year}`, text: q });
    a.addEventListener("click", (event) => searchFor(event, q));
    a.addEventListener("auxclick", (event) => searchFor(event, q));
    return a;
  }));
  ui.searchRow.hidden = !plan.searches.length;
  ui.sites.replaceChildren(...plan.sites.map((site) =>
    archiveLink(site.name, site.path, `${site.name}, ${longDate(date)} (Internet Archive)`)));
  ui.siteRow.hidden = !plan.sites.length;
}

// The meme of the year once its day has come; before that, last year's, which is still everywhere.
function fillMeme(meme, year) {
  ui.grid.classList.toggle("no-meme", !meme);
  if (!meme) return;
  const label = meme.still ? `Still everywhere: meme of ${meme.year}` : `Meme of ${year}`;
  // The blurred copy fills the frame around a picture of another shape (same URL: one download).
  const bg = h("img", { class: "pic-bg", src: meme.image, alt: "", "aria-hidden": "true", referrerpolicy: "no-referrer", decoding: "async" });
  const img = h("img", { class: "pic-main", src: meme.image, alt: meme.title, referrerpolicy: "no-referrer", decoding: "async" });
  const pic = h("figure", { class: "pic" }, bg, img);
  img.addEventListener("error", () => {
    pic.classList.add("broken");
    bg.remove();
    img.remove();
    pic.append(h("span", { class: "pic-alt", text: meme.title }));
  });
  ui.meme.setAttribute("aria-label", label);
  ui.meme.replaceChildren(...kept(
    boxTitle(label),
    pic,
    h("p", { class: "meme-title", text: meme.title }),
    h("p", { class: "meme-blurb", text: meme.blurb || "" }),
    meme.source && h("a", { class: "credit", href: meme.source, target: "_blank", rel: "noopener", text: "More about it (Wikipedia)" })));
  ui.meme.hidden = false;
}

function status(text) {
  if (ui.status) ui.status.textContent = text;
}

// ---- Links ---------------------------------------------------------------------------------------------
// A plain click opens a link in a new tab next to this one, Ctrl/Cmd or the middle button in the
// background, Shift in a new window: what a normal link does. null: not a click that opens a link.
function linkMode(event) {
  if (event.type === "click" ? event.button !== 0 : event.button !== 1) return null;
  const background = event.ctrlKey || event.metaKey || event.button === 1;
  return { active: !background, window: event.shiftKey && !background };
}

async function openTab(url, mode) {
  try {
    if (!HAS_CHROME) throw new Error("not an extension page");
    if (mode.window) { await chrome.windows.create({ url }); return; }
    const me = await chrome.tabs.getCurrent();
    const near = me ? { windowId: me.windowId, index: me.index + 1, openerTabId: me.id } : {};
    await chrome.tabs.create({ url, active: mode.active, ...near });
  } catch (_) {
    window.open(url, "_blank", "noopener");
  }
}

// A Wayback page of the card's day (front pages, web favorites), through the resolver of the card's year.
function archiveLink(label, path, title) {
  const a = h("a", { href: extUrl(path), target: "_blank", rel: "noopener", title, text: label });
  a.addEventListener("click", openArchived);
  a.addEventListener("auxclick", openArchived);
  return a;
}

// While the time machine is on, its Wayback guard sends every archived page later than the chosen year
// back to the resolver of the chosen year. So a card older than the dial (Back to an earlier trip, or the
// year changed in the popup) first sets the dial to the card's year, or its links would never open.
async function openArchived(event) {
  const mode = linkMode(event);
  if (!mode || !HAS_CHROME) return;
  event.preventDefault();
  const url = event.currentTarget.href;
  const year = trip.to;
  const state = await send({ type: "getState" });
  if (state && state.enabled && state.year !== year) await send({ type: "setState", patch: { year } });
  await openTab(url, mode);
}

// "People are searching": the same as "Search like it's <year>", with the query.
async function searchFor(event, q) {
  const mode = linkMode(event);
  if (!mode) return;
  event.preventDefault();
  const here = mode.active && !mode.window;
  if (here) status(`Setting the time machine to ${trip.to}...`);
  await send({ type: "setState", patch: { enabled: true, google: true, year: trip.to } });
  if (here) location.assign(googleSearchUrl(q));
  else openTab(googleSearchUrl(q), mode);
}

// ---- Buttons -------------------------------------------------------------------------------------------
async function searchLikeIts() {
  ui.search.disabled = true;
  status(`Setting the time machine to ${trip.to}...`);
  // Google is drawn in the chosen year only while the time machine is on (and on for Google).
  await send({ type: "setState", patch: { enabled: true, google: true, year: trip.to } });
  location.assign("https://www.google.com/");
}

// The status line follows the music for the card that pressed "Play the hits", until another trip replaces it.
function followMusic(forTrip, year) {
  music?.close();
  followed = { forTrip, year };
  music = connectMusic((s) => { if (trip === forTrip) status(musicLine(s, year)); });
}

function stopMusicWatch() {
  music?.close();
  music = null;
  followed = null;
}

async function playHits() {
  const forTrip = trip;
  const year = trip.to;
  const say = (text) => { if (trip === forTrip) status(text); };
  stopMusicWatch();
  say(`Starting the hits of ${year}...`);
  // The music module plays the year that is in storage: make it this one (the popup usually already did).
  const state = await send({ type: "getState" });
  if (state && state.year !== year) await send({ type: "setState", patch: { year } });
  const reply = await send({ type: "music:control", cmd: "play", year });
  if (reply && reply.ok) {
    say(musicLine(reply.state, year));
    // The reply is the moment the player starts looking for the song: follow it until it plays or gives up.
    if (trip === forTrip && HAS_CHROME) followMusic(forTrip, year);
    return;
  }
  // Nobody started the music (no music control in this build, or it failed): open the player panel. The
  // click's user activation lasts a few seconds, which chrome.sidePanel.open() needs.
  try {
    if (!HAS_CHROME || windowId === null || !chrome.sidePanel?.open) throw new Error("no side panel");
    await chrome.sidePanel.open({ windowId });
    say("The player is open on the right: press Play.");
  } catch (_) {
    const why = reply && reply.state && reply.state.problem ? reply.state.status : "";
    say(why || noPlayerText(year));
  }
}

function replay() {
  if (soundWanted) sfx.unlock(150); // the click allows sound from now on
  // Started after this click is over, so the click does not count as a skip of the trip it starts.
  setTimeout(startTrip, 0);
}

function closeTab() {
  if (!HAS_CHROME) { window.close(); return; }
  chrome.tabs.getCurrent((tab) => {
    if (chrome.runtime.lastError || !tab) window.close();
    else chrome.tabs.remove(tab.id);
  });
}

// ---- Start ---------------------------------------------------------------------------------------------
// Year data is fetched once and shared by every trip this page plays.
let dataPromise = null;
const loadData = () => (dataPromise ||= Promise.all([fetchJson("years.json"), fetchJson("../player/charts.json")]));

// Dresses the page for the current trip: era, HUD, landing card (filled in when the data is there).
function prepare() {
  stopMusicWatch(); // its status line belongs to the card that is replaced now
  root.dataset.era = eraFor(trip.to);
  if (trip.to >= ROUNDED_FROM) root.dataset.rounded = "1";
  else delete root.dataset.rounded;
  root.dataset.direction = trip.direction;
  buildHud();
  buildLanding();
  const forTrip = trip;
  return loadData().then(([years, charts]) => {
    if (trip === forTrip) fillLanding(years, numberOne(charts, trip.to));
  });
}

// The card without the trip (Back/Forward to a trip this tab already made).
function showCardOnly() {
  cancelAnimationFrame(raf);
  clearSkipTimers();
  running = false;
  sfx.hush();
  removeEventListener("keydown", onSkipKey, true);
  removeEventListener("pointerdown", onSkipPointer, true);
  setOdometer(trip.to);
  $("flash").style.opacity = "0";
  $("trip").hidden = true;
  $("landing").classList.remove("crt-on", "crt-quick");
  $("landing").hidden = false;
  phase = "done";
  root.dataset.phase = "done";
  document.title = `Welcome to ${trip.to}`;
}

// The service worker sends a travel tab on its next trip by changing only the fragment: same document, so
// no reload. A new nonce is a new trip; a nonce played before is Back/Forward.
async function onHashChange() {
  const next = await readTrip();
  const replayed = Boolean(next.nonce) && playedNonces().includes(next.nonce);
  cancelAnimationFrame(raf);
  running = false;
  sfx.hush();
  trip = next;
  prepare();
  if (replayed) { showCardOnly(); return; }
  markPlayed(trip.nonce);
  startTrip();
}

async function main() {
  if (reduceMotion) root.dataset.motion = "reduced";
  trip = await readTrip();
  const filled = prepare();
  addEventListener("resize", measure);
  addEventListener("hashchange", onHashChange);
  // Leaving the page pauses the music line; Back from the back/forward cache picks it up again.
  addEventListener("pagehide", () => { music?.close(); music = null; });
  addEventListener("pageshow", (event) => {
    if (event.persisted && !music && followed && followed.forTrip === trip) followMusic(followed.forTrip, followed.year);
  });
  if (HAS_CHROME) chrome.windows?.getCurrent?.().then((w) => { windowId = w.id; }, () => {});

  // Back/forward to this page shows the card directly; a fresh trip (or a reload) plays the whole thing. A trip
  // this tab has played before is a return too, whatever Chrome calls the load (a live check once saw Back
  // from google.com replay the trip).
  const played = Boolean(trip.nonce) && playedNonces().includes(trip.nonce);
  if (navType === "back_forward" || (navType !== "reload" && played)) {
    await filled;
    showCardOnly();
    return;
  }
  markPlayed(trip.nonce);
  startTrip();
}

main();
