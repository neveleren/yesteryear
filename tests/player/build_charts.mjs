// Builds extension/src/player/charts.json from research/billboard_yearend_1946_2025.json.
//   node tests/player/build_charts.mjs          -> writes charts.json
// charts.test.mjs imports the same functions and checks that the committed file is exactly what this
// produces, so the cleaning rules below are the single source of truth.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESEARCH_FILE = path.join(ROOT, "research", "billboard_yearend_1946_2025.json");
export const CHARTS_FILE = path.join(ROOT, "extension", "src", "player", "charts.json");

// Wikipedia footnote markers that leaked into cells, e.g. "Kanye West [ a ]", plus dagger-style marks.
const FOOTNOTE_RE = /\s*\[\s*(?:[a-z]{1,2}|\d{1,3}|note\s*\d+|nb\s*\d+|citation needed)\s*\]/gi;
const DAGGER_RE = /\s*[†‡§¶]+/g;
const DQUOTE_RE = /["“”„«»]/g;
const DASH_RE = /[‒–—―]/g; // en/em dashes -> "-" (no long dashes in anything we show)

function tidy(s) {
  return s
    .replace(/ /g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    // Scraper joined linked names with spaces: "Metro Boomin , the Weeknd", "Huntrix : Ejae".
    .replace(/\s+([,;:])(?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// "35 (41)" (1946-48 lists print "No. (Rank)") -> 35; "7" -> 7.
export function parseRank(raw, fallback) {
  const m = String(raw ?? "").match(/\d+/);
  return m ? Number(m[0]) : fallback;
}

export function cleanTitle(raw) {
  let t = String(raw ?? "");
  t = t.replace(FOOTNOTE_RE, "").replace(DAGGER_RE, "");
  // Double A-sides were scraped from '"A" / "B"' with the outer quotes stripped: 'A " / " B'.
  t = t.replace(/\s*["“”]\s*\/\s*["“”]\s*/g, " / ");
  t = t.replace(DQUOTE_RE, "");
  // Scraper artifact: "Creepin '" / "Barefootin '" (space before a word-final apostrophe).
  t = t.replace(/(\w) (['’])(?=\s|$)/g, "$1$2");
  t = t.replace(DASH_RE, "-");
  t = t.replace(/\s*\*+$/, "");
  return tidy(t);
}

export function cleanArtist(raw) {
  let a = String(raw ?? "");
  a = a.replace(FOOTNOTE_RE, "").replace(DAGGER_RE, "");
  a = a.replace(DASH_RE, "-");
  a = a.replace(/\s*\*+$/, "");
  // Nickname quotes (Clarence "Frogman" Henry) are part of the billed name and stay.
  return tidy(a);
}

export function buildCharts(research) {
  const out = {};
  for (const year of Object.keys(research).sort()) {
    const entries = research[year]?.entries || [];
    out[year] = entries.map((e, i) => ({
      rank: parseRank(e.rank, i + 1),
      title: cleanTitle(e.title),
      artist: cleanArtist(e.artist)
    }));
  }
  return out;
}

// One song per line keeps the file diffable and greppable.
export function serializeCharts(charts) {
  const years = Object.keys(charts);
  const parts = years.map((y, yi) => {
    const rows = charts[y].map((s, i) => "  " + JSON.stringify(s) + (i < charts[y].length - 1 ? "," : ""));
    return `"${y}": [\n${rows.join("\n")}\n]${yi < years.length - 1 ? "," : ""}`;
  });
  return `{\n${parts.join("\n")}\n}\n`;
}

export function loadResearch() {
  return JSON.parse(readFileSync(RESEARCH_FILE, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const charts = buildCharts(loadResearch());
  writeFileSync(CHARTS_FILE, serializeCharts(charts));
  const total = Object.values(charts).reduce((n, list) => n + list.length, 0);
  console.log(`wrote ${CHARTS_FILE}: ${Object.keys(charts).length} years, ${total} songs`);
}
