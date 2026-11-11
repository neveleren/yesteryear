// Pure helpers for the Yesteryear UI (popup and toolbar badge). No chrome.* and no DOM here, so
// node --test can load this file directly. Year limits and defaults come from the integrator's
// state module, so the UI can never disagree with what the service worker stores.
import { MIN_YEAR, MAX_YEAR, DEFAULTS } from "../shared/state_sw.js";

export { MIN_YEAR, MAX_YEAR, DEFAULTS };

// Quick-jump buttons under the year slider.
export const QUICK_YEARS = Object.freeze([1999, 2005, 2010, 2015, 2020]);

// Popup checkboxes, in display order (keys of chrome.storage.local, see ARCHITECTURE.md).
export const TOGGLE_KEYS = Object.freeze(["enabled", "google", "youtube", "strict", "eraLook"]);

// Storage keys that change the toolbar badge.
export const BADGE_KEYS = Object.freeze(["enabled", "year"]);

// Win98 palette: navy like an active title bar while ON, button-shadow grey while OFF.
export const BADGE_ON_COLOR = "#000080";
export const BADGE_OFF_COLOR = "#808080";
export const BADGE_TEXT_COLOR = "#FFFFFF";

// YouTube's first video went up on 2005-04-23; nothing older exists there.
export const YOUTUBE_FIRST_YEAR = 2005;

// Same rule as setState() in src/shared/state_sw.js: round, fall back to the default year when
// the value is not a finite number, then clamp to MIN_YEAR..MAX_YEAR.
export function clampYear(value) {
  const y = Math.round(Number(value));
  return Math.min(MAX_YEAR, Math.max(MIN_YEAR, Number.isFinite(y) ? y : DEFAULTS.year));
}

export function stepYear(year, delta) {
  return clampYear(clampYear(year) + Math.trunc(Number(delta) || 0));
}

// Exactly the state keys, with booleans as booleans and the year clamped.
export function normalizeState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = key in src && src[key] !== undefined ? src[key] : def;
    out[key] = typeof def === "boolean" ? Boolean(v) : v;
  }
  out.year = clampYear(out.year);
  return out;
}

// Quick-year buttons that fit the allowed range, with the one matching the current year pressed.
export function quickYearButtons(currentYear) {
  const year = clampYear(currentYear);
  return QUICK_YEARS
    .filter((y) => y >= MIN_YEAR && y <= MAX_YEAR)
    .map((y) => ({ year: y, label: String(y), pressed: y === year }));
}

// ---- 7-segment LCD ------------------------------------------------------------------------
//  aaa
// f   b
//  ggg
// e   c
//  ddd
export const SEGMENT_IDS = Object.freeze(["a", "b", "c", "d", "e", "f", "g"]);
const SEGMENTS = Object.freeze({
  0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg",
  5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg", "-": "g", " ": ""
});

// Lit segments for one character ("" for anything the display cannot show).
export function segmentsFor(ch) {
  return Object.hasOwn(SEGMENTS, ch) ? SEGMENTS[ch] : "";
}

// The four characters the LCD shows for a year.
export function lcdDigits(year) {
  return String(clampYear(year)).padStart(4, " ").slice(-4).split("");
}

// ---- Text --------------------------------------------------------------------------------
export function musicLabel(year) {
  return `Music of ${clampYear(year)}...`;
}

export function badgeFor(state) {
  const s = normalizeState(state);
  return s.enabled
    ? { text: String(s.year), background: BADGE_ON_COLOR, textColor: BADGE_TEXT_COLOR }
    : { text: "OFF", background: BADGE_OFF_COLOR, textColor: BADGE_TEXT_COLOR };
}

// Toolbar tooltip.
export function titleFor(state) {
  const s = normalizeState(state);
  return s.enabled ? `Yesteryear: ON, it is ${s.year}` : `Yesteryear: OFF (year set to ${s.year})`;
}

// Left status-bar field.
export function statusText(state) {
  const s = normalizeState(state);
  return s.enabled ? `ON: it is ${s.year}` : "OFF: you are in the present";
}

// Right status-bar field: which sites travel back.
export function sitesText(state) {
  const s = normalizeState(state);
  if (s.google && s.youtube) return "Google + YouTube";
  if (s.google) return "Google only";
  if (s.youtube) return "YouTube only";
  return "No site selected";
}

// One short hint for the current settings, or "" when there is nothing to say.
export function noteFor(state) {
  const s = normalizeState(state);
  if (s.enabled && !s.google && !s.youtube) return "Tick Google or YouTube to travel back.";
  if (s.youtube && s.year < YOUTUBE_FIRST_YEAR) {
    return `YouTube did not exist yet in ${s.year} (first video: April 2005).`;
  }
  return "";
}

// ---- Time travel ---------------------------------------------------------------------------
// The year a trip departs from: where Google and YouTube are, i.e. the saved year while the time
// machine is ON and the present while it is OFF. Never the year of an earlier trip: switching OFF in
// between brought them back to the present. (A trip to the year you are already in is the travel
// module's business: normalizeTrip() in src/travel/travel_core.js starts it from the present.)
export function departureYear(state, present) {
  const s = normalizeState(state);
  return s.enabled ? s.year : present;
}

// ---- Timing --------------------------------------------------------------------------------
// Trailing debounce that remembers the latest value: schedule(v) restarts the wait, flush() runs
// a pending call right now (used before the popup closes), cancel() drops it.
export function debounce(fn, ms) {
  let timer = null;
  let pending = null; // { value } while a call is waiting
  function run() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const call = pending;
    pending = null;
    if (call) fn(call.value);
  }
  return {
    schedule(value) {
      pending = { value };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, ms);
    },
    flush() { if (pending) run(); },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
    get pending() { return pending !== null; }
  };
}
