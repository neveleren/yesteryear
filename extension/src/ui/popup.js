// Yesteryear popup: the year dial (7-segment LCD, slider, spin buttons, quick years), the switches,
// "Travel to <year> >>" (src/travel), the mini player (src/player/miniplayer.js) and "?" (src/tour).
// Extension page: the CSP allows only bundled script files, and the DOM is built with
// createElement/textContent (no HTML strings), the same habit as in the content scripts.
import { getState, setState } from "../shared/state_sw.js";
import {
  MIN_YEAR, MAX_YEAR, DEFAULTS, TOGGLE_KEYS, SEGMENT_IDS, clampYear, stepYear, normalizeState,
  lcdDigits, segmentsFor, quickYearButtons, statusText, sitesText, noteFor, departureYear, debounce
} from "./logic.js";
import { mountMiniPlayer } from "../player/miniplayer.js";

const HAS_CHROME = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
const SVG_NS = "http://www.w3.org/2000/svg";
const SAVE_DELAY_MS = 300;    // year is saved this long after the last change
const REPEAT_DELAY_MS = 400;  // holding a spin button: first repeat after this
const REPEAT_EVERY_MS = 70;   // ...then one year per tick

const $ = (id) => document.getElementById(id);
const el = {
  lcd: $("lcd"), lcdFlag: $("lcd-flag"), digits: $("lcd-digits"),
  up: $("year-up"), down: $("year-down"),
  slider: $("year"), ticks: $("ticks"), min: $("year-min"), max: $("year-max"),
  quick: $("quick"), travel: $("travel"), note: $("note"), close: $("close"),
  status: $("status"), sites: $("sites"),
  toggles: Object.fromEntries(TOGGLE_KEYS.map((key) => [key, $(`opt-${key}`)]))
};

let state = normalizeState(DEFAULTS); // what storage holds, as far as this popup knows
let draftYear = null;                  // year on screen while the user is still choosing it
let departure = null;                  // year the next trip departs from, see wireTravel()
let problem = "";                      // last error, shown in the note line
const digitSegments = [];              // per LCD digit: { a: <polygon>, ..., g: <polygon> }
const quickButtons = [];               // [{ year, button }]

const shownYear = () => draftYear ?? state.year;
const presentYear = () => new Date().getFullYear();
const errorText = (err) => (err && err.message) || String(err);

// The year is written once the user settles on it, never per slider tick: every write reaches all
// open Google and YouTube tabs through storage.onChanged, and they may search again for the new year.
const yearSaver = debounce((year) => {
  if (draftYear === year) draftYear = null;
  if (year !== state.year) {
    state = { ...state, year };
    save({ year });
  }
  render();
}, SAVE_DELAY_MS);

function save(patch) {
  if (!HAS_CHROME) return;
  // setState() from state_sw.js clamps the year the same way logic.js does, then writes storage.
  setState(patch).catch((err) => showProblem(`Could not save: ${errorText(err)}`));
}

function showProblem(text) {
  problem = text;
  render();
}

function setDraft(value) {
  draftYear = clampYear(value);
  render();
}

// ---- Build ------------------------------------------------------------------------------------
// Segment outlines in a 38 x 60 box: hexagonal bars, 6 units thick, 1.5 units apart.
const SEGMENT_POINTS = (() => {
  const t = 3, gap = 1.5, left = 4, right = 28, top = 4, middle = 30, bottom = 56;
  const bar = (y) => [[left + gap, y], [left + gap + t, y - t], [right - gap - t, y - t],
    [right - gap, y], [right - gap - t, y + t], [left + gap + t, y + t]];
  const post = (x, y1, y2) => [[x, y1 + gap], [x + t, y1 + gap + t], [x + t, y2 - gap - t],
    [x, y2 - gap], [x - t, y2 - gap - t], [x - t, y1 + gap + t]];
  const shapes = {
    a: bar(top), g: bar(middle), d: bar(bottom),
    f: post(left, top, middle), b: post(right, top, middle),
    e: post(left, middle, bottom), c: post(right, middle, bottom)
  };
  return Object.fromEntries(Object.entries(shapes).map(([id, pts]) => [id, pts.map((p) => p.join(",")).join(" ")]));
})();

function buildDigits() {
  for (let i = 0; i < 4; i++) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "digit");
    svg.setAttribute("viewBox", "0 0 38 60");
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("transform", "translate(6 0) skewX(-6)"); // the usual LCD slant
    const segments = {};
    for (const id of SEGMENT_IDS) {
      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("class", "seg");
      poly.setAttribute("points", SEGMENT_POINTS[id]);
      group.append(poly);
      segments[id] = poly;
    }
    svg.append(group);
    el.digits.append(svg);
    digitSegments.push(segments);
  }
}

function buildSlider() {
  el.slider.min = String(MIN_YEAR);
  el.slider.max = String(MAX_YEAR);
  el.min.textContent = String(MIN_YEAR);
  el.max.textContent = String(MAX_YEAR);
  for (let year = MIN_YEAR; year <= MAX_YEAR; year++) {
    const tick = document.createElement("span");
    tick.className = year % 5 === 0 ? "tick major" : "tick";
    el.ticks.append(tick);
  }
  el.slider.addEventListener("input", () => setDraft(el.slider.value));
  el.slider.addEventListener("change", () => {
    setDraft(el.slider.value);
    yearSaver.schedule(draftYear);
  });
}

function buildQuickButtons() {
  for (const { year, label } of quickYearButtons(state.year)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      setDraft(year);
      yearSaver.schedule(year);
      yearSaver.flush(); // a deliberate jump: save right away
    });
    el.quick.append(button);
    quickButtons.push({ year, button });
  }
}

// Win98 spinner: one step per press, auto-repeat while held, save after release.
function wireSpin(button, delta) {
  let delay = null;
  let repeat = null;
  const step = () => {
    const from = shownYear();
    const to = stepYear(from, delta);
    if (to === from) return false; // at 1998 or 2025
    setDraft(to);
    return true;
  };
  const release = () => {
    if (delay === null && repeat === null) return;
    clearTimeout(delay);
    clearInterval(repeat);
    delay = repeat = null;
    yearSaver.schedule(shownYear());
  };
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || button.disabled) return;
    try { button.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    step();
    delay = setTimeout(() => {
      delay = null;
      repeat = setInterval(() => { if (!step()) release(); }, REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, release);
  // Enter/Space arrive as a click with detail 0; mouse presses were already handled on pointerdown.
  button.addEventListener("click", (event) => {
    if (event.detail === 0 && step()) yearSaver.schedule(shownYear());
  });
}

function wireToggles() {
  for (const key of TOGGLE_KEYS) {
    const box = el.toggles[key];
    box.addEventListener("change", () => {
      state = { ...state, [key]: box.checked };
      // The switch moves Google and YouTube (OFF: back to the present), so a trip departs from there now.
      if (key === "enabled") departure = departureYear(state, presentYear());
      render();
      save({ [key]: box.checked });
    });
  }
}

// ---- Time travel (src/travel) ------------------------------------------------------------------
const travelLabel = (year) => `Travel to ${year} >>`;

// A trip departs from where Google and YouTube were when this popup opened (the present while the
// time machine is OFF), or from where the ON switch sent them since. The dial only picks the
// destination: while ON it saves every year it settles on, but that is not where the trip starts.
function wireTravel() {
  el.travel.addEventListener("click", async () => {
    const from = departure ?? departureYear(state, presentYear()); // before `state` changes below
    const to = shownYear();
    yearSaver.cancel(); // saved below, together with the switch
    draftYear = null;
    state = { ...state, year: to, enabled: true };
    render();
    if (!HAS_CHROME) return;
    el.travel.disabled = true;
    try {
      // Travelling switches the time machine on: Google and YouTube are in that year on arrival.
      await setState({ year: to, enabled: true });
      const reply = await chrome.runtime.sendMessage({ type: "travel:go", from, to });
      if (!reply?.ok) throw new Error(reply?.reason || "no answer");
      window.close();
    } catch (err) {
      el.travel.disabled = false;
      showProblem(`Could not travel: ${errorText(err)}`);
    }
  });
}

// ---- Render -----------------------------------------------------------------------------------
function render() {
  const year = shownYear();
  const view = { ...state, year };

  lcdDigits(year).forEach((ch, i) => {
    const lit = segmentsFor(ch);
    for (const id of SEGMENT_IDS) digitSegments[i][id].classList.toggle("on", lit.includes(id));
  });
  el.lcd.setAttribute("aria-label", `Year ${year}`);
  el.lcd.classList.toggle("off", !state.enabled);
  el.lcdFlag.textContent = state.enabled ? "ON" : "OFF";

  el.slider.value = String(year);
  el.up.disabled = year >= MAX_YEAR;
  el.down.disabled = year <= MIN_YEAR;
  const pressed = new Set(quickYearButtons(year).filter((b) => b.pressed).map((b) => b.year));
  for (const { year: y, button } of quickButtons) button.setAttribute("aria-pressed", String(pressed.has(y)));

  for (const key of TOGGLE_KEYS) el.toggles[key].checked = state[key];

  el.travel.textContent = travelLabel(year);
  const note = problem || noteFor(view);
  el.note.textContent = note;
  el.note.hidden = !note;
  el.note.classList.toggle("problem", Boolean(problem));
  el.status.textContent = statusText(view);
  el.sites.textContent = sitesText(view);
}

// ---- Start ------------------------------------------------------------------------------------
buildDigits();
buildSlider();
buildQuickButtons();
wireSpin(el.up, +1);
wireSpin(el.down, -1);
wireToggles();
wireTravel();
// Its buttons first save a year that is still being chosen, as the old music button did.
if (HAS_CHROME) mountMiniPlayer(document.getElementById("mini-player"), { onProblem: showProblem, beforeAction: () => yearSaver.flush() });
el.close.addEventListener("click", () => window.close());
// "?" opens the first-run tour again (src/tour/welcome.html) in a tab.
$("help").addEventListener("click", () => {
  try {
    chrome.runtime.sendMessage({ type: "tour:open" }, () => { void chrome.runtime.lastError; window.close(); });
  } catch { window.close(); }
});

// A popup closes the moment it loses focus: save a pending year on the way out.
addEventListener("pagehide", () => yearSaver.flush());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") yearSaver.flush();
});

if (HAS_CHROME) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const keys = Object.keys(changes).filter((key) => Object.hasOwn(DEFAULTS, key));
    if (!keys.length) return;
    const next = { ...state };
    for (const key of keys) next[key] = changes[key].newValue; // removed key -> default
    state = normalizeState(next);
    render();
  });
}

try {
  if (HAS_CHROME) state = normalizeState(await getState());
  departure = departureYear(state, presentYear());
} catch (err) {
  problem = `Could not read the settings: ${errorText(err)}`;
} finally {
  render();
  document.documentElement.classList.remove("loading");
  if (window.top === window) el.slider.focus({ preventScroll: true }); // not when the tour shows it framed
}
