// Google module logic without DOM or chrome.* (node tests load it): search URL building, leak decisions,
// date parsing, period strings. Exposes globalThis.YYG.
(function (root) {
  "use strict";

  const CD_MIN = "1/1/1990";

  // Target URL for a search: rewritten query + Google's own custom date range (M/D/YYYY, verified live)
  // + the plain "Web" tab (udm=14: no AI Overview, no image/video blocks) unless a vertical is chosen.
  function buildSearchUrl(href, year, rewriteQuery) {
    const url = new URL(href);
    const q = url.searchParams.get("q") || "";
    const rw = rewriteQuery(q, year);
    const target = new URL(url);
    target.searchParams.set("q", rw.query);
    target.searchParams.set("tbs", `cdr:1,cd_min:${CD_MIN},cd_max:12/31/${year}`);
    if (!target.searchParams.has("tbm") && !target.searchParams.has("udm")) target.searchParams.set("udm", "14");
    return { target: target.toString(), rewritten: rw.query, original: q, changed: sameSearch(url, target) === false };
  }

  // Equal when q, tbs and vertical match (Google may reorder or add params such as sei/ved).
  function sameSearch(a, b) {
    const pa = a.searchParams, pb = b.searchParams;
    return pa.get("q") === pb.get("q") && pa.get("tbs") === pb.get("tbs") &&
      (pa.get("udm") || "") === (pb.get("udm") || "") && (pa.get("tbm") || "") === (pb.get("tbm") || "");
  }

  // Our own date cap (buildSearchUrl). A URL that carries it may also carry our rewritten query.
  const OUR_TBS = /^cdr:1,cd_min:1\/1\/1990,cd_max:12\/31\/\d{4}$/;
  function isOurTbs(tbs) { return OUR_TBS.test(String(tbs || "")); }

  function withQuery(href, q) {
    const u = new URL(href);
    u.searchParams.set("q", q);
    return u.toString();
  }

  // The user's own words for a results URL. lookup(q) = what this tab remembered for a query we rewrote
  // (sessionStorage "yy:orig:<rewritten>"), or null.
  function userWords(href, lookup) {
    const u = new URL(href);
    const q = u.searchParams.get("q") || "";
    if (!isOurTbs(u.searchParams.get("tbs"))) return q;
    let mapped = null;
    try { mapped = lookup(q); } catch (_) { /* no sessionStorage */ }
    return mapped || q;
  }

  // Where an open results page goes after a settings change. ON for Google: the user's words searched again for the
  // new year (rewritten = the new query to remember). OFF: the user's words, without our date cap and Web tab.
  // -> {target, rewritten} or null when the page is not a search (the caller reloads).
  function retarget(href, words, st, rewriteQuery) {
    const url = new URL(href);
    if (url.pathname !== "/search" || !String(words || "").trim()) return null;
    if (st.enabled && st.google) {
      const plan = buildSearchUrl(withQuery(href, words), st.year, rewriteQuery);
      return { target: plan.target, rewritten: plan.rewritten };
    }
    const ours = isOurTbs(url.searchParams.get("tbs"));
    url.searchParams.set("q", words);
    if (ours) {
      url.searchParams.delete("tbs");
      if (url.searchParams.get("udm") === "14") url.searchParams.delete("udm");
    }
    return { target: url.toString(), rewritten: null };
  }

  // Google's own wrapper and page hosts (www.google.*, google.*): not a result's site.
  const GOOGLE_HOST = /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/i;

  // A result heading that links to another Google search ("Get more results from the past 24 hours", related
  // searches) is not a result. /url and /goto wrappers are results.
  function isGoogleSearchLink(href) {
    try { const u = new URL(href); return GOOGLE_HOST.test(u.hostname) && u.pathname === "/search"; } catch (_) { return false; }
  }

  // The site a result link points to: the link itself, or the target of an old /url?q= wrapper. "" for opaque
  // /goto tokens and Google's own pages (the URL line, cite, then has to say it).
  function linkHost(href) {
    let u;
    try { u = new URL(href); } catch (_) { return ""; }
    if (GOOGLE_HOST.test(u.hostname)) {
      if (u.pathname !== "/url") return "";
      const inner = u.searchParams.get("q") || u.searchParams.get("url") || "";
      if (!/^https?:\/\//i.test(inner)) return "";
      try { u = new URL(inner); } catch (_) { return ""; }
      if (GOOGLE_HOST.test(u.hostname)) return "";
    }
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : "";
  }

  // The wayback module's cache of each site's earliest capture, read directly by the content script so known sites
  // answer before the first draw. Same rules as wayback_core.js cachedFirstAnswer: "wbfirst:<host>" = {ts, at} (the
  // earliest capture) or {ts:null, at, n} (n empty answers; from the second one on it is "unknown" for an hour).
  // -> "yes" | "no" | "unknown", or null = ask the wayback module.
  const FIRST_EMPTY_MS = 3600e3;
  function firstCaptureAnswer(entry, year, now = Date.now()) {
    if (!entry) return null;
    const ts = entry.ts;
    if (ts && /^\d{14}$/.test(String(ts))) return Number(String(ts).slice(0, 4)) > year ? "no" : "yes";
    if (ts === null && (entry.n || 1) >= 2 && now - (entry.at || 0) < FIRST_EMPTY_MS) return "unknown";
    return null;
  }

  // ---- period tabs: Google's services by date ("YYYYMMDD" = today's date in the chosen year) ------------------
  // [first day, address], newest first; checked against the archive's CDX index on 2026-11-11: /products had only
  // redirects after 2011, /shopping 200s 2012-2018 and shopping.google.com from 2019-08-09; /options/ last 200 on
  // 2012-08-15, /intl/en/about/products/ 200s to 2018-11, about.google/products/ from 2019-02-06.
  const SERVICE_URLS = {
    "News": [["", "http://news.google.com/"]],
    "Groups": [["", "http://groups.google.com/"]],
    "Directory": [["", "http://directory.google.com/"]],
    "Froogle": [["", "http://froogle.google.com/"]],
    "Maps": [["", "http://maps.google.com/"]],
    "Video": [["", "http://video.google.com/"]],
    "Shopping": [["20190809", "https://shopping.google.com/"], ["20120101", "http://www.google.com/shopping"], ["", "http://www.google.com/products"]],
    "+You": [["", "http://plus.google.com/"]],
    "Play": [["", "http://play.google.com/"]],
    "Drive": [["", "http://drive.google.com/"]],
    "Documents": [["", "http://docs.google.com/"]],
    "Calendar": [["", "http://www.google.com/calendar"]],
    "Gmail": [["20060101", "http://mail.google.com/"], ["", "http://gmail.google.com/"]],
    "More": [["20190206", "https://about.google/products/"], ["20120816", "http://www.google.com/intl/en/about/products/"], ["", "http://www.google.com/options/"]]
  };
  const MORE_NAMES = ["more »", "more ▼", "More »", "More"];

  function serviceUrl(name, day) {
    const list = SERVICE_URLS[MORE_NAMES.includes(name) ? "More" : name];
    if (!list) return null;
    const d = String(day || "");
    for (const [from, url] of list) if (!from || d >= from) return url;
    return null;
  }

  // "I'm Feeling Lucky" with an empty box opened Google's logo page. By date (first 200 captures, CDX 2026-11-11):
  // logos.html from 1999-10-13, holidaylogos.html from 2000-11-09, /logos/ from 2009-05-22, /doodles/ from 2014-04-11,
  // doodles.google from 2023-11-07. Before that there is nothing to open (null: the button just stays put).
  const LUCKY_EMPTY = [["20231107", "https://doodles.google/"], ["20140411", "http://www.google.com/doodles/"],
    ["20090522", "http://www.google.com/logos/"], ["20001109", "http://www.google.com/holidaylogos.html"],
    ["19991013", "http://www.google.com/logos.html"]];
  function luckyEmptyUrl(day) {
    const d = String(day || "");
    for (const [from, url] of LUCKY_EMPTY) if (d >= from) return url;
    return null;
  }

  // "I'm Feeling Lucky" with words: our own marker on the results URL (Google ignores it). The results page then opens
  // the first result that passes the time machine's checks, instead of Google's own (uncapped) first hit.
  const LUCKY_PARAM = "yylucky";

  // The links of each era's bar. The 2011 black bar (2011-2013) follows the day: Play from 2012-03-06, Drive from
  // 2012-04-24 (earliest captures); before that Documents and Calendar.
  const NAV_SETS = {
    "1999": [], "1998": [],
    "2002": ["Web", "Images", "Groups", "Directory", "News"],
    "2004": ["Web", "Images", "Groups", "News", "Froogle", "more »"],
    "2007": ["Web", "Images", "Video", "News", "Maps", "Gmail", "more ▼"],
    "2010": ["Web", "Images", "Videos", "Maps", "News", "Shopping", "Gmail", "more ▼"],
    "2014": ["All", "Images", "News", "Videos", "Maps", "More"],
    "2016": ["All", "Images", "News", "Videos", "Maps", "More"],
    "2020": ["All", "Images", "News", "Videos", "Maps", "More"],
    "2024": ["All", "Images", "Videos", "News", "Shopping", "More"]
  };
  function navNames(era, day) {
    if (era === "2011") {
      const d = String(day || "");
      if (d >= "20120424") return ["+You", "Search", "Images", "Maps", "Play", "YouTube", "News", "Gmail", "Drive", "More »"];
      if (d >= "20120306") return ["+You", "Search", "Images", "Maps", "Play", "YouTube", "News", "Gmail", "Documents", "Calendar", "More »"];
      return ["+You", "Search", "Images", "Maps", "YouTube", "News", "Gmail", "Documents", "Calendar", "More »"];
    }
    return (NAV_SETS[era] || []).slice();
  }

  const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|янв|фев|мар|апр|мая|май|июн|июл|авг|сен|окт|ноя|дек|jän|mär|mai|okt|dez";
  const NOW_YEAR = new Date().getFullYear();
  const RELATIVE_NOW = /\b(\d+|an?|one)\s+(sec(ond)?|min(ute)?|hour|day|week|month)s?\s+ago\b|\b(yesterday|just now)\b|(?<!\p{L})(\d+\s+)?(секунд|минут|час|день|дня|дней|недел|месяц)\p{L}*\s+назад|(?<!\p{L})вчера(?!\p{L})|\bvor\s+(\d+|einem|einer)\s+(sekunden?|minuten?|stunden?|tag|tagen|woche|wochen|monat|monaten)\b|\bgestern\b/iu;

  // Years mentioned in a date line ("Mar 3, 2010", "03.03.2010", "3 мар. 2010 г.", "by X · 2010 · Cited by")
  function yearsIn(text) {
    const out = [];
    // a year is 4 digits not glued to other digits; "03.03.2009" counts, "1,230,000" does not
    for (const m of String(text || "").matchAll(/(?<!\d)(19[89]\d|20\d\d)(?![\d])/g)) out.push(Number(m[1]));
    return out;
  }

  function dateYear(text) {
    const t = String(text || "");
    if (!t) return null;
    if (RELATIVE_NOW.test(t)) return 9999;            // "3 days ago": this is today's page
    const ys = yearsIn(t);
    return ys.length ? Math.max(...ys) : null;
  }

  // term -> first year it existed (or was common). Only distinctive terms; matching is case-insensitive.
  const ANACHRONISMS = [
    ["ipod", 2001], ["itunes", 2001], ["windows xp", 2001], ["wikipedia", 2001], ["myspace", 2003], ["linkedin", 2003],
    ["skype", 2003], ["facebook", 2004], ["gmail", 2004], ["podcast", 2004], ["web 2.0", 2004], ["youtube", 2005],
    ["google maps", 2005], ["reddit", 2005], ["xbox 360", 2005], ["twitter", 2006], ["tweet", 2006], ["wii", 2006],
    ["ps3", 2006], ["playstation 3", 2006], ["blu-ray", 2006], ["windows vista", 2006], ["iphone", 2007], ["kindle", 2007],
    ["tumblr", 2007], ["android", 2008], ["google chrome", 2008], ["app store", 2008], ["airbnb", 2008], ["spotify", 2008],
    ["html5", 2008], ["lady gaga", 2008], ["bitcoin", 2009], ["whatsapp", 2009], ["windows 7", 2009], ["minecraft", 2009],
    ["justin bieber", 2009], ["raspberry pi", 2012], ["steam deck", 2022], ["iot", 2014], ["internet of things", 2013], ["ipad", 2010], ["instagram", 2010], ["pinterest", 2010], ["uber", 2010], ["snapchat", 2011],
    ["game of thrones", 2011], ["windows 8", 2012], ["gangnam style", 2012], ["brexit", 2012], ["selfie", 2013],
    ["ps4", 2013], ["playstation 4", 2013], ["xbox one", 2013], ["apple watch", 2014], ["windows 10", 2015],
    ["pokemon go", 2016], ["pokémon go", 2016], ["google pixel", 2016], ["nintendo switch", 2017], ["fortnite", 2017],
    ["tiktok", 2017], ["billie eilish", 2016], ["5g", 2019], ["covid", 2020], ["covid-19", 2020], ["ps5", 2020],
    ["playstation 5", 2020], ["xbox series", 2020], ["windows 11", 2021], ["nft", 2021], ["metaverse", 2021],
    ["chatgpt", 2022], ["openai", 2015], ["gpt-4", 2023], ["gemini ai", 2023], ["google gemini", 2023], ["vision pro", 2023],
    ["threads app", 2023], ["copilot", 2023]
  ].map(([term, year]) => [new RegExp(`(?<![\\p{L}\\d])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "iu"), year, term]);

  function anachronism(text, year) {
    const t = String(text || "");
    for (const [re, first, term] of ANACHRONISMS) if (first > year && re.test(t)) return term;
    return null;
  }

  // Should a result be hidden for the chosen year? r = {title, snippet, dateText, cite, path}
  function leakReason(r, year, strict) {
    const dy = dateYear(r.dateText);
    if (dy && dy > year) return `dated ${dy === 9999 ? "recently" : dy}`;
    const text = `${r.title || ""} ${r.snippet || ""}`;
    if (year < NOW_YEAR && RELATIVE_NOW.test(text)) return "posted recently";
    const later = yearsIn(text).filter((y) => y > year && y <= 2030);
    if (later.length) return `mentions ${Math.max(...later)}`;
    const term = anachronism(text, year);
    if (term) return `mentions ${term}`;
    return null;
  }

  // A site's front page: Google dates it by first sight, but its snippet is today's text. Clicking it opens
  // the archived copy from the chosen year anyway, so keep the result and drop only the (modern) snippet.
  function isLiveHomepage(r) {
    return !!(r.cite && !r.path);
  }

  // "https://www.npr.org › sections › therecord" -> {host: "www.npr.org", path: "sections/therecord"}
  function parseCite(cite) {
    const t = String(cite || "").replace(/\s+/g, " ").trim();
    if (!t) return { host: "", path: "" };
    const parts = t.split("›").map((s) => s.trim()).filter(Boolean);
    let first = (parts.shift() || "").replace(/^https?:\/\//i, "");
    // older layouts print "en.wikipedia.org/wiki/Linux" without breadcrumbs
    const slash = first.indexOf("/");
    if (slash > 0) { parts.unshift(first.slice(slash + 1)); first = first.slice(0, slash); }
    const host = first.replace(/\/$/, "");
    const path = parts.join("/").replace(/\.{3}|…/g, "").replace(/\/+$/, "").replace(/^\/+/, "");
    return { host, path };
  }

  function formatCount(n) {
    return Number(n).toLocaleString("en-US");
  }

  // "About 1,230,000 results (0.42 seconds)" / "Ungefähr 1.230.000 Ergebnisse" / "Результатов: примерно 1 230 000"
  function parseStats(text) {
    const t = String(text || "");
    const m = t.match(/(\d[\d.,\s  ]*\d|\d)/);
    if (!m) return null;
    const n = Number(m[1].replace(/[^\d]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Period homepage page counters (archived homepages, era-design research).
  const PAGE_COUNTERS = { 2000: "1,326,920,000", 2001: "1,387,529,000", 2002: "2,073,418,204", 2003: "3,083,324,652",
    2004: "4,285,199,774", 2005: "8,058,044,651" };

  const api = {
    buildSearchUrl, sameSearch, isOurTbs, withQuery, userWords, retarget, isGoogleSearchLink, linkHost, firstCaptureAnswer,
    serviceUrl, navNames, luckyEmptyUrl, LUCKY_PARAM, dateYear, yearsIn, anachronism, leakReason, isLiveHomepage, parseCite, formatCount, parseStats,
    PAGE_COUNTERS, MONTHS
  };
  root.YYG = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
