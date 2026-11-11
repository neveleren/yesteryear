// Time travel, pure helpers: no DOM and no chrome.*, so node --test loads this file directly and both
// the travel page and the service-worker part share one definition of the trip, the timeline and the eras.
import { MIN_YEAR, MAX_YEAR } from "../shared/state_sw.js";

export { MIN_YEAR, MAX_YEAR };

export const PAGE_PATH = "src/travel/travel.html";
export const RESOLVER_PATH = "src/wayback/resolve.html";
export const LAST_KEY = "travel:last"; // chrome.storage.local: the year of the last trip (not the next departure)

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---- Trip ------------------------------------------------------------------------------------------
const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};

export const clampTo = (year) => Math.min(MAX_YEAR, Math.max(MIN_YEAR, year));

// The trip the page plays. `to` must be a year the time machine knows (else null); `from` may be any year
// from MIN_YEAR up to the present and falls back to the present. A trip to the year you are already in
// starts from the present again, so the odometer always has something to roll.
export function normalizeTrip(from, to, present) {
  const now = toInt(present);
  const target = toInt(to);
  if (!Number.isFinite(now) || !Number.isFinite(target)) return null;
  if (target < MIN_YEAR || target > MAX_YEAR) return null;
  let start = toInt(from);
  if (!Number.isFinite(start) || start < MIN_YEAR || start > Math.max(now, MAX_YEAR)) start = now;
  if (start === target) start = now === target ? target : now;
  return { from: start, to: target, direction: start > target ? "back" : start < target ? "forward" : "same" };
}

// "#from=2026&to=1999&sound=0&t=lz8x3k" -> {from, to, sound, t}; numbers stay NaN when missing (normalizeTrip
// handles it). t is a nonce: every trip gets a new one, so a travel tab that is sent on the next trip always
// sees its fragment change (a same-document navigation), and a nonce it has played before means Back/Forward.
export function parseTravelHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  return {
    from: params.has("from") ? toInt(params.get("from")) : NaN,
    to: params.has("to") ? toInt(params.get("to")) : NaN,
    sound: params.get("sound") !== "0",
    t: /^[a-z0-9]{1,16}$/i.test(params.get("t") || "") ? params.get("t") : ""
  };
}

// Extension-relative URL of the travel page for a trip (chrome.runtime.getURL() makes it absolute).
export function travelPath({ from, to, sound = true, nonce = "" }) {
  const t = /^[a-z0-9]{1,16}$/i.test(String(nonce)) ? `&t=${nonce}` : "";
  return `${PAGE_PATH}#from=${from}&to=${to}${sound ? "" : "&sound=0"}${t}`;
}

// Tabs the trip may take over instead of opening one more: empty new-tab pages and our own travel page.
export function isReusableTab(url, extensionOrigin = "") {
  const u = String(url || "");
  if (!u || u === "about:blank" || u === "about:newtab") return true;
  if (/^(chrome|edge|brave):\/\/(newtab|new-tab-page)\/?$/i.test(u)) return true;
  if (/^chrome-search:\/\/local-ntp\//i.test(u)) return true;
  return Boolean(extensionOrigin) && u.startsWith(`${extensionOrigin}/${PAGE_PATH}`);
}

// ---- Eras (landing card look) -----------------------------------------------------------------------
// Windows 98 up to 2001, XP 2002-2006, Vista/7 glass 2007-2012, flat from 2013 on.
export const ERAS = Object.freeze([
  { from: MIN_YEAR, id: "win98" },
  { from: 2002, id: "xp" },
  { from: 2007, id: "aero" },
  { from: 2013, id: "flat" }
]);

// Flat windows get the rounded corners of Windows 11 (released October 2021) from 2021 on.
export const ROUNDED_FROM = 2021;

export function eraFor(year) {
  const y = toInt(year);
  let id = ERAS[0].id;
  for (const era of ERAS) if (y >= era.from) id = era.id;
  return id;
}

// ---- Odometer -----------------------------------------------------------------------------------------
// Positions of the number drums for a continuous value, most significant drum first. A position is in
// [0, 10): 9.5 means halfway from 9 to the next 0. Like a real odometer, a drum turns only while every drum
// to its right rolls over from 9 to 0, so 1999.5 gives [1.5, 9.5, 9.5, 9.5].
export function odometerWheels(value, digits = 4) {
  const v = Math.max(0, Number(value) || 0);
  const out = [];
  for (let k = digits - 1; k >= 0; k--) {
    const base = 10 ** k;
    if (k === 0) { out.push(v % 10); continue; }
    const digit = Math.floor(v / base) % 10;
    const lower = v % base;                     // what the drums to the right show, continuous
    out.push(digit + Math.max(0, lower - (base - 1)));
  }
  return out;
}

// ---- Timeline (milliseconds from the start of the trip) -------------------------------------------
export const TIMELINE = Object.freeze({
  rollStart: 250,   // HUD is up, the drums start to turn
  rollEnd: 3050,    // drums lock on the destination year
  flash: 3500,      // 88 MPH: white flash and the boom
  land: 3620,       // landing card is behind the flash, CRT power-on starts
  done: 4700        // power-on finished, the page is interactive
});

// Slow start, fast middle, gentle stop: an odometer with inertia.
export function easeTrip(t) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2;
}

// The year the odometer shows at `ms` (continuous, for odometerWheels).
export function yearAt(ms, from, to) {
  const t = (ms - TIMELINE.rollStart) / (TIMELINE.rollEnd - TIMELINE.rollStart);
  return from + (to - from) * easeTrip(t);
}

// Warp speed 0..1: keeps accelerating until the flash, then the tunnel is gone.
export function speedAt(ms) {
  if (ms >= TIMELINE.flash) return 1;
  const t = Math.max(0, ms) / TIMELINE.flash;
  return Math.min(1, 0.04 + 0.96 * t ** 2.2);
}

// The speed readout: 88 MPH exactly at the flash.
export function mphAt(ms) {
  return Math.round(88 * Math.min(1, Math.max(0, ms) / TIMELINE.flash) ** 1.6);
}

export function phaseAt(ms) {
  if (ms < TIMELINE.rollStart) return "intro";
  if (ms < TIMELINE.rollEnd) return "roll";
  if (ms < TIMELINE.flash) return "lock";
  if (ms < TIMELINE.land) return "flash";
  if (ms < TIMELINE.done) return "crt";
  return "done";
}

// White flash opacity: fast in, short hold, slow out.
export function flashAt(ms) {
  const d = ms - TIMELINE.flash;
  if (d < -90) return 0;
  if (d < 0) return 1 + d / 90;
  if (d < 140) return 1;
  return Math.max(0, 1 - (d - 140) / 520);
}

// ---- Dates ---------------------------------------------------------------------------------------------
export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Today's month and day, moved into `year` (29 February becomes the 28th in a common year).
export function sameDayIn(year, now = new Date()) {
  const month = now.getMonth() + 1;
  let day = now.getDate();
  if (month === 2 && day === 29 && !isLeap(year)) day = 28;
  return { year, month, day };
}

export const pad2 = (n) => String(n).padStart(2, "0");
export const ymd = ({ year, month, day }) => `${year}${pad2(month)}${pad2(day)}`;

export function weekdayOf({ year, month, day }) {
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

// "Thursday, November 11, 1999"
export function longDate(date) {
  return `${weekdayOf(date)}, ${MONTHS[date.month - 1]} ${date.day}, ${date.year}`;
}

// "NOV 11 1999" for the time-circuit readouts.
export function circuitDate(date) {
  return `${MONTHS[date.month - 1].slice(0, 3).toUpperCase()} ${pad2(date.day)} ${date.year}`;
}

// "4:07 PM", the tray clock of every era.
export function trayTime(now = new Date()) {
  const h = now.getHours();
  return `${h % 12 || 12}:${pad2(now.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

// ---- "Today in <year>" front pages ---------------------------------------------------------------------
// BBC News moved from news.bbc.co.uk to www.bbc.co.uk/news on 14 July 2010 (last 200 capture of the old
// front page: July 2010; first of the new one: 2010-07-14, Wayback CDX).
export const BBC_MOVE = "20100714";

export function frontPages(date) {
  const d = ymd(date);
  return [
    { id: "cnn", label: "CNN", url: "http://www.cnn.com/" },
    { id: "bbc", label: "BBC News", url: d < BBC_MOVE ? "http://news.bbc.co.uk/" : "https://www.bbc.co.uk/news" },
    { id: "nyt", label: "The New York Times", url: "http://www.nytimes.com/" }
  ].map((site) => ({ ...site, path: resolverPath(date.year, d, site.url) }));
}

// The Wayback resolver page: newest capture on or before that day. u= stays last and raw (see ARCHITECTURE.md).
export function resolverPath(year, day, url) {
  return `${RESOLVER_PATH}#y=${year}&d=${day}&u=${url}`;
}

// "People are searching" opens Google's results for the query; the Google module then turns the search
// into one from the chosen year.
export function googleSearchUrl(q) {
  return `https://www.google.com/search?${new URLSearchParams({ q: String(q) })}`;
}

// ---- Data ------------------------------------------------------------------------------------------------
// Rank 1 of that year's Billboard Year-End Hot 100 (src/player/charts.json), or null.
export function numberOne(charts, year) {
  const list = charts && Array.isArray(charts[String(year)]) ? charts[String(year)] : [];
  const top = list.find((s) => s && Number(s.rank) === 1) || null;
  return top && top.title && top.artist ? { title: String(top.title), artist: String(top.artist) } : null;
}

// years.json per year: meme {title, blurb, image, source, on}, facts [{text, on}] (6, in date order),
// tech {text, on}, searches [{q, on}] (6, most searched first), sites [{name, url, first}] (6).
// `on` is "MM-DD" inside that year: the day the thing was there (01-01: already before the year began).
// `first` is the site's first Wayback capture (14 digits), before 1 January of that year.
export const LIMITS = Object.freeze({
  blurb: 90, fact: 80, facts: 6, title: 40, tech: 40, searches: 6, query: 40, sites: 6, site: 24
});
// The card shows at most this many facts: the latest ones up to its day.
export const SHOWN_FACTS = 3;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// "02-29" -> true, "02-30" -> false. MM-DD strings compare in date order, so `on <= day` is plain string order.
export function isMonthDay(v) {
  const m = /^(\d{2})-(\d{2})$/.exec(typeof v === "string" ? v : "");
  if (!m) return false;
  const month = Number(m[1]), day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

// "11-11" for {month: 11, day: 11}.
export const monthDay = ({ month, day }) => `${pad2(month)}-${pad2(day)}`;

const datedOnly = (list) => (Array.isArray(list) ? list : []).filter((x) => x && typeof x === "object" && isMonthDay(x.on));
const byDate = (list) => datedOnly(list).sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0)); // stable
const named = (v) => typeof v === "string" && v.trim() !== "";

// What the landing card shows for `year` on `date` ({year, month, day}): nothing dated after that day.
//   meme, tech  this year's once its day has come, else last year's with still: true (the card says so);
//               null when neither exists
//   facts       {year, still, items}: the latest SHOWN_FACTS facts up to the day; before the first one of
//               the year, last year's latest (still: true)
//   searches    the queries already searched by that day, most searched first
//   sites       [{name, url, path}]: path opens the site's front page of that day through the resolver
export function landingPlan(years, year, date) {
  const md = monthDay(date);
  const entry = (years && years[String(year)]) || null;
  const prev = (years && years[String(year - 1)]) || null;
  const due = (x) => isMonthDay(x?.on) && x.on <= md;
  const pick = (key, field) => {
    const mine = entry && entry[key];
    if (mine && named(mine[field]) && due(mine)) return { ...mine, year, still: false };
    const old = prev && prev[key];
    return old && named(old[field]) ? { ...old, year: year - 1, still: true } : null;
  };

  let facts = { year, still: false, items: byDate(entry?.facts).filter(due).slice(-SHOWN_FACTS) };
  if (!facts.items.length && prev) facts = { year: year - 1, still: true, items: byDate(prev.facts).slice(-SHOWN_FACTS) };
  facts.items = facts.items.map((f) => f.text).filter(named);

  const day = ymd(date);
  return {
    meme: pick("meme", "title"),
    tech: pick("tech", "text"),
    facts,
    searches: datedOnly(entry?.searches).filter(due).map((s) => s.q).filter(named).slice(0, LIMITS.searches),
    sites: (Array.isArray(entry?.sites) ? entry.sites : [])
      .filter((s) => s && named(s.name) && /^https?:\/\/[^/\s]+\/\S*$/.test(s.url || ""))
      .slice(0, LIMITS.sites)
      .map((s) => ({ name: s.name, url: s.url, path: resolverPath(year, day, s.url) }))
  };
}

// Problems with one years.json entry ([] when it is fine). Used by the tests. With `year`, a site must
// also have been on the web before that year began.
export function checkYear(entry, year) {
  const problems = [];
  const str = (v) => typeof v === "string" && v.trim() !== "";
  const meme = entry && entry.meme;
  if (!meme || typeof meme !== "object") return ["meme missing"];
  if (!str(meme.title) || meme.title.length > LIMITS.title) problems.push("meme.title");
  if (!str(meme.blurb) || meme.blurb.length > LIMITS.blurb) problems.push("meme.blurb");
  if (!str(meme.image) || !/^https:\/\/[^/]+\.[a-z]{2,}\//i.test(meme.image)) problems.push("meme.image");
  if (!str(meme.source) || !/^https:\/\//.test(meme.source)) problems.push("meme.source");
  if (!isMonthDay(meme.on)) problems.push("meme.on");

  const list = (key, count, check) => {
    const items = entry[key];
    if (!Array.isArray(items) || items.length !== count) { problems.push(key); return; }
    items.forEach((x, i) => {
      if (!x || typeof x !== "object" || !check(x)) problems.push(`${key}[${i}]`);
    });
  };
  list("facts", LIMITS.facts, (f) => str(f.text) && f.text.length <= LIMITS.fact && isMonthDay(f.on));
  const ons = Array.isArray(entry.facts) && entry.facts.every((f) => isMonthDay(f?.on)) ? entry.facts.map((f) => f.on) : [];
  if (ons.some((on, i) => i > 0 && ons[i - 1] > on)) problems.push("facts order");
  const tech = entry.tech;
  if (!tech || typeof tech !== "object" || !str(tech.text) || tech.text.length > LIMITS.tech) problems.push("tech");
  else if (!isMonthDay(tech.on)) problems.push("tech.on");
  list("searches", LIMITS.searches, (s) => str(s.q) && s.q.length <= LIMITS.query && s.q === s.q.toLowerCase() && isMonthDay(s.on));
  list("sites", LIMITS.sites, (s) => str(s.name) && s.name.length <= LIMITS.site && /^https?:\/\/[^/\s]+\/$/.test(s.url || "")
    && /^\d{14}$/.test(s.first || "") && (year === undefined || s.first < `${year}0101000000`));
  return problems;
}

// ---- "Play the hits" -------------------------------------------------------------------------------------
// The card's line about the music, from the player's state (src/player/music_state.js makeState()):
// what is starting, playing or why it stopped. Never "Now playing" while it is still looking for the song.
export function musicLine(state, year) {
  if (!state || typeof state !== "object") return `Starting the hits of ${year}...`;
  if (state.problem) return state.status || "The music stopped.";
  if (state.year !== year) return `The player is on ${state.year} now.`;
  const t = state.track;
  const song = t && t.artist && t.title ? `${t.artist} - "${t.title}"` : "";
  if (state.playing && state.loading) return song ? `Starting ${song}...` : `Starting the hits of ${year}...`;
  if (state.playing) return song ? `Now playing: ${song}` : `Now playing: the hits of ${year}.`;
  return "Paused.";
}

// When neither the music nor the side panel could be started from the card: where to press Play.
export function noPlayerText(year) {
  return `Click the Yesteryear button, then Play under "Music of ${year}".`;
}
