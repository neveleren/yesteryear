// YouTube logic without DOM/chrome.* (node tests load it). Exposes globalThis.YYT.
(function (root) {
  "use strict";
  const NOW_YEAR = new Date().getFullYear();

  // before:<Y+1>-01-01 keeps uploads up to Dec 31 of Y (verified live: server-side, also on later pages).
  function beforeOperator(year) { return `before:${year + 1}-01-01`; }

  function hasDateOperator(q) { return /(^|\s)(before|after):\S/i.test(String(q || "")); }

  function buildQuery(q, year, rewriteQuery) {
    const base = hasDateOperator(q) ? String(q) : rewriteQuery(String(q || ""), year).query;
    return hasDateOperator(base) ? base : `${base} ${beforeOperator(year)}`.trim();
  }

  function stripOperator(q) {
    return String(q || "").replace(/\s*(^|\s)before:\d{4}(-\d{2}-\d{2})?/gi, "").trim();
  }

  // The home page and Trending become a search for the year itself.
  function homeQuery(year) { return `${year} ${beforeOperator(year)}`; }

  // The user's own words behind a search_query. mapped = what this tab remembered for a query the extension built
  // ("" = the home page's year search), else null. A before:/after: nobody mapped was typed by the user: null, so
  // it is left alone.
  function userQuery(q, mapped) {
    if (mapped != null) return String(mapped);
    return hasDateOperator(q) ? null : String(q || "");
  }

  // The query for the user's words in a year ("" = the home page's year search).
  function queryFor(words, year, rewriteQuery) {
    return words === "" ? homeQuery(year) : buildQuery(words, year, rewriteQuery);
  }

  // "15 years ago" / "15 лет назад" / "vor 15 Jahren" -> minimal possible upload year (YouTube rounds down,
  // so "15 years ago" in Nov 2026 means Nov 2010 - Nov 2011). months/weeks/days/hours -> this year.
  function minUploadYear(text, nowYear = NOW_YEAR) {
    const t = String(text || "").toLowerCase();
    let m = t.match(/(\d+)\s+(year|years)\s+ago/) || t.match(/(\d+)\s+(год|года|лет)\s+назад/) || t.match(/vor\s+(\d+)\s+(jahr|jahren)/);
    if (m) return nowYear - Number(m[1]) - 1;
    if (/\b(a|one)\s+year\s+ago\b|год\s+назад|vor\s+einem\s+jahr/.test(t)) return nowYear - 2;
    if (/(month|months|week|weeks|day|days|hour|hours|minute|minutes|second|seconds)\s+ago|(месяц|месяца|месяцев|недел\S*|день|дня|дней|час\S*|минут\S*|секунд\S*)\s+назад|vor\s+\d*\s*(monat|monaten|woche|wochen|tag|tagen|stunde|stunden|minute|minuten|sekunde|sekunden)|streamed|live now|в эфире|premiere/.test(t)) return nowYear;
    return null;
  }

  function isFuture(text, year, nowYear = NOW_YEAR) {
    const y = minUploadYear(text, nowYear);
    return y != null && y > year;
  }

  const api = { beforeOperator, hasDateOperator, buildQuery, stripOperator, homeQuery, userQuery, queryFor, minUploadYear, isFuture, NOW_YEAR };
  root.YYT = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
