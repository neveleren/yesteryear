// Shared helpers for content scripts (classic script, loaded before each site's content.js).
// Exposes window.YY. Keep it dependency-free: it also runs in node unit tests via tests/load_common.mjs.
(function (root) {
  "use strict";

  const MIN_YEAR = 1998;
  const MAX_YEAR = 2025;
  const DEFAULTS = {
    enabled: false, year: 2010, google: true, youtube: true, strict: true, eraLook: true, musicAutoplay: false
  };

  function hasChrome() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  async function getState() {
    if (!hasChrome()) return { ...DEFAULTS };
    const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...s };
  }

  function onStateChange(cb) {
    if (!hasChrome()) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.keys(changes).some((k) => k in DEFAULTS)) getState().then(cb);
    });
  }

  // For pages that navigate when the settings change (open Google and YouTube tabs): cb(latest state) runs once the
  // changes settle (a burst of quick-year clicks is one change) and only while the tab is in view, so a background
  // tab never searches by itself; it catches up on its first visibilitychange to "visible". A page restored from the
  // back/forward cache checks the settings again. deps are for tests.
  function onSettledStateChange(cb, { delayMs = 500, doc = root.document, win = root, subscribe = onStateChange, read = getState } = {}) {
    let latest = null, timer = 0;
    const hidden = () => !!doc && doc.visibilityState === "hidden";
    const fire = () => {
      timer = 0;
      if (!latest || hidden()) return;
      const st = latest;
      latest = null;
      cb(st);
    };
    subscribe((st) => {
      latest = st;
      clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    });
    if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", () => { if (latest && !timer) fire(); });
    if (win && win.addEventListener) {
      win.addEventListener("pageshow", (e) => {
        if (e && e.persisted) read().then((st) => { latest = st; if (!timer) fire(); }, () => {});
      });
    }
  }

  function send(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)); }
      catch (_) { resolve(null); }
    });
  }

  // ---- "this year" -> chosen year ------------------------------------------------------------
  // Live tests (2026-11-10): "music trends this year" capped at 2010 gave 1/10 on-topic results,
  // "music trends 2010" gave 6/10. So relative time words must become the chosen year.
  const YEAR_RE = /\b(19|20)\d{2}\b/;

  // Rewrite only outside "quoted phrases" and leave operators (site:, before:, after:, filetype: ...) alone.
  function rewriteQuery(original, year) {
    const before = String(original || "");
    const parts = before.split(/("[^"]*")/);
    let quoted = false;
    const hasOperator = /(^|\s)(before|after|site|filetype|inurl|intitle|daterange):\S/i.test(before);
    const out = parts.map((part) => {
      if (/^"[^"]*"$/.test(part)) { quoted = true; return part; }
      return rewritePlain(part, year);
    }).join("");
    let q = out;
    const TOPICAL_OR_NOW = topicalOrNow(q);
    if (!hasOperator && !YEAR_RE.test(q) && TOPICAL_OR_NOW) q = `${q.trim()} ${year}`;
    q = q.replace(/\s{2,}/g, " ").trim();
    return { query: q, changed: q !== before.replace(/\s{2,}/g, " ").trim(), original: before, quoted };
  }

  function rewritePlain(text, year) {
    let q = String(text || "");
    const Y = String(year), P = String(year - 1), N = String(year + 1);
    const rules = [
      // English
      [/\bthis\s+year'?s\b/gi, Y], [/\bthis\s+year\b/gi, Y],
      [/\blast\s+year'?s\b/gi, P], [/\blast\s+year\b/gi, P], [/\bprevious\s+year\b/gi, P],
      [/\bnext\s+year'?s\b/gi, N], [/\bnext\s+year\b/gi, N],
      [/\bthis\s+(month|week|season|summer|winter|spring|fall|autumn)\b/gi, `$1 ${Y}`],
      // Russian
      [/в\s+этом\s+году/gi, `в ${Y} году`], [/этого\s+года/gi, `${Y} года`], [/этом\s+году/gi, `${Y} году`],
      [/в\s+прошлом\s+году/gi, `в ${P} году`], [/прошлого\s+года/gi, `${P} года`],
      [/в\s+следующем\s+году/gi, `в ${N} году`], [/следующего\s+года/gi, `${N} года`],
      [/в\s+этом\s+месяце/gi, `в ${Y} году`], [/на\s+этой\s+неделе/gi, `в ${Y} году`],
      // German
      [/\bdieses\s+jahres\b/gi, Y], [/\bdiesem\s+jahr\b/gi, Y], [/\bdieses\s+jahr\b/gi, Y],
      [/\bletzten\s+jahres\b/gi, P], [/\bletztes\s+jahr\b/gi, P], [/\bim\s+letzten\s+jahr\b/gi, `im ${P}`],
      [/\bnächstes\s+jahr\b/gi, N], [/\bnaechstes\s+jahr\b/gi, N]
    ];
    for (const [re, to] of rules) q = q.replace(re, to);
    // "N years ago" -> the year that was N years before the chosen one.
    q = q.replace(/\b(\d{1,2})\s+years?\s+ago\b/gi, (_, n) => String(year - Number(n)));
    q = q.replace(/(\d{1,2})\s+(?:года|лет|год)\s+назад/gi, (_, n) => String(year - Number(n)));
    q = q.replace(/\bvor\s+(\d{1,2})\s+jahren\b/gi, (_, n) => String(year - Number(n)));
    // Words that only make sense "now" are dropped; the caller then pins the query to the year.
    q = q.replace(/\b(right\s+now|these\s+days|nowadays|currently)\b/gi, " ");
    return q;
  }

  // "latest / now / today / current ..." or a time-sensitive topic with no explicit year: pin the
  // query to the chosen year. Live test: "best phone" capped at 2010 had 6/10 modern results,
  // "best phone 2010" had 0/9; "music trends this year" 1/10 on topic, "music trends 2010" 6/10.
  // JavaScript's \b is ASCII-only, so Cyrillic words use explicit letter look-arounds.
  const NOW_WORDS = /\b(latest|newest|recent|current|today|now|trending|new)\b|(?<!\p{L})(сейчас|сегодня|последн\p{L}*|новые|новинки|актуальн\p{L}*|текущ\p{L}*|модн\p{L}*)(?!\p{L})|\b(aktuell\w*|heute|jetzt|neueste\w*|derzeit)\b/iu;
  const TOPICAL = /\b(best|top|news|trends?|music|songs?|hits|charts?|albums?|movies?|films?|games?|phones?|smartphones?|laptops?|computers?|cars?|prices?|popular|fashion|celebrit(y|ies)|tv|shows?|releases?|bands?|singers?|gadgets?|consoles?|memes?|reviews?)\b|(?<!\p{L})(лучш\p{L}*|топ|новост\p{L}*|музык\p{L}*|песн\p{L}*|хит\p{L}*|фильм\p{L}*|игр\p{L}*|телефон\p{L}*|смартфон\p{L}*|ноутбук\p{L}*|машин\p{L}*|цен\p{L}*|мод\p{L}*|сериал\p{L}*)(?!\p{L})|\b(beste\w*|nachrichten|musik|lieder|charts|filme?|spiele?|handys?|preise?|mode|serien?)\b/iu;
  function topicalOrNow(q) { return NOW_WORDS.test(q) || TOPICAL.test(q); }

  // Years written in the query that lie in the chosen year's future (e.g. "best phones 2026" in 2010).
  function futureYearsIn(query, year) {
    const out = [];
    for (const m of String(query).matchAll(/\b(19|20)\d{2}\b/g)) if (Number(m[0]) > year) out.push(Number(m[0]));
    return out;
  }

  // ---- Google look per year ("the look that was live on 1 July of that year") ----------------
  // Era ids are the first year of each look; the Google module owns the templates.
  // Eras from research (era-design report, "look that was live on 1 July of the year").
  const GOOGLE_ERAS = [
    [1998, "1998"], // E1 "Google!" beta
    [1999, "1999"], // E2 classic Catull logo, blue stats bar "Searched the web for ..."
    [2002, "2002"], // E3 folder tabs Web/Images/Groups/Directory(/News)
    [2004, "2004"], // E4 text links, light-blue bar "Results 1 - 10 of about N for X. (0.31 seconds)"
    [2007, "2007"], // E5 universal search, top nav bar "Web Images Video News Maps Gmail more"
    [2010, "2010"], // E6 left sidebar "Everything", refreshed logo, "About N results"
    [2011, "2011"], // E7 black bar
    [2014, "2014"], // E8 flat logo, grey app grid, bigger titles
    [2016, "2016"], // E9 Product Sans logo
    [2020, "2020"], // E10 favicons + site names above results
    [2024, "2024"]  // E11 AI era (we never show AI answers)
  ];

  function googleEra(year) {
    let id = GOOGLE_ERAS[0][1];
    for (const [from, eraId] of GOOGLE_ERAS) if (year >= from) id = eraId;
    return id;
  }

  function cutoffTimestamp(year) { return `${year}1231235959`; }

  const YY = {
    MIN_YEAR, MAX_YEAR, DEFAULTS, getState, onStateChange, onSettledStateChange, send,
    rewriteQuery, futureYearsIn, googleEra, GOOGLE_ERAS, cutoffTimestamp,
    extUrl: (p) => (typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(p) : p)
  };
  root.YY = YY;
  if (typeof module !== "undefined" && module.exports) module.exports = YY;
})(typeof window !== "undefined" ? window : globalThis);
