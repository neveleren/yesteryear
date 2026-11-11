// Wayback Machine helpers without chrome.* so node tests can run them.
//
// Research (research_report.json, "wayback-strictness"): only a CDX lookup with to=<Y>1231235959 is strict.
// The Availability API, year-only URLs (/web/2010/ is padded to the END of 2010) and links inside archived
// pages all jump forward in time. Hard CDX limit 30 req/min per IP; budget 20/min; ignoring 429 gets the IP
// blocked for an hour, doubling each time.

export const CDX = "https://web.archive.org/cdx/search/cdx";
export const WAYBACK = "https://web.archive.org/web/";

// A day cut ("Today in 2005", the period Google tabs) applies when it is a YYYYMMDD inside or before the year.
export function validDay(year, day) {
  return !!day && /^\d{8}$/.test(String(day)) && String(day).slice(0, 4) <= String(year);
}

// End of the chosen year, or end of one day when day = "YYYYMMDD" ("Today in 2005": that very date).
export function cutoffTs(year, day) {
  if (validDay(year, day)) return `${day}235959`;
  return `${year}1231235959`;
}

// 14-digit timestamp -> milliseconds (UTC); NaN when there is none.
export function tsToMs(ts) {
  const d = padTs(ts);
  if (!d) return NaN;
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12), +d.slice(12, 14));
}

// With a day cut (period Google tabs, "Today in YEAR"), a capture this much older than the day is not that day's
// page any more: a service that later only redirects would otherwise open years too early without a word.
export const STALE_DAYS = 400;
export function isStale(ts, year, day, maxDays = STALE_DAYS) {
  if (!validDay(year, day)) return false;
  const cut = tsToMs(cutoffTs(year, day)), at = tsToMs(ts);
  return Number.isFinite(cut) && Number.isFinite(at) && cut - at > maxDays * 864e5;
}

// Pad a short Wayback timestamp the way Wayback does for "closest" lookups we must distrust: a missing part
// means "as late as possible" (so /web/2010/ counts as 2010-12-31 23:59:59, still inside 2010).
export function padTs(ts) {
  const digits = String(ts || "").replace(/\D/g, "");
  if (digits.length >= 14) return digits.slice(0, 14);
  const tail = "99991231235959";
  if (digits.length < 4) return "";
  return digits + tail.slice(digits.length);
}

export function isAfterCutoff(ts, year, day) {
  const padded = padTs(ts);
  if (!padded) return true;                // no timestamp at all: Wayback would pick "latest" -> future
  // compare as strings of equal length (14 digits); month/day overflow like 99 never happens below Y.
  return padded > cutoffTs(year, day);
}

// web.archive.org/web/<ts><flags>/<url> -> {ts, flags, target}; null if not a Wayback page URL.
export function parseWaybackUrl(href) {
  let u;
  try { u = new URL(href); } catch (_) { return null; }
  if (!/(^|\.)web\.archive\.org$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/web\/(\d{0,14})([a-z]{2}_)?\*?\/(.+)$/i);
  if (!m) {
    const bare = u.pathname.match(/^\/web\/(https?:\/?\/?.+)$/i);   // /web/http://example.com/ (no timestamp)
    return bare ? { ts: "", flags: "", target: fixScheme(bare[1]) + u.search + u.hash } : null;
  }
  return { ts: m[1], flags: (m[2] || "").toLowerCase(), target: fixScheme(m[3]) + u.search + u.hash };
}

function fixScheme(s) {
  // Wayback paths can collapse "http://" to "http:/"
  return s.replace(/^(https?):\/(?!\/)/i, "$1://");
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_ga|ved|usg|sa|ei|oq|gs_lcp|sclient)$/i;

// Normalize a URL for cache keys and CDX queries: unwrap Google redirect wrappers, drop tracking params and
// the fragment, lowercase the host.
export function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*%3A/i.test(s)) {
    try { s = decodeURIComponent(s); } catch (_) { /* keep as is */ }
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch (_) { return ""; }
  if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === "/url") {
    const inner = u.searchParams.get("q") || u.searchParams.get("url");
    if (inner) return normalizeUrl(inner);
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

// redirects: also accept 3xx captures. Used for a site's front page, which often only redirected (to /en/,
// to www. or https) in a given year, and for day cuts. A redirect capture is only a last resort: its replay can
// land after the cutoff (nytimes.com/ 2017: the newest capture is a 301 whose target was saved on 2018-01-01), so
// these lookups ask for the newest REDIRECT_WINDOW captures with their status and parseCdx prefers a 2xx.
export const REDIRECT_WINDOW = 20;
export function cdxQueryUrl(url, year, day, { redirects = false } = {}) {
  const p = new URLSearchParams({
    url,
    to: cutoffTs(year, day),
    filter: redirects ? "statuscode:[23].." : "statuscode:200",
    limit: redirects ? `-${REDIRECT_WINDOW}` : "-1",
    fastLatest: "true",
    output: "json",
    fl: redirects ? "timestamp,original,statuscode" : "timestamp,original"
  });
  return `${CDX}?${p}`;
}

// CDX JSON: [["timestamp","original"(,"statuscode")], ["20101225...","http://..."(,"200")], ...] or [] when nothing
// matches. With a status column: the newest 2xx, else the newest 3xx.
export function parseCdx(text, year, day) {
  let rows;
  try { rows = JSON.parse(text); } catch (_) { return { ok: false, reason: "parse" }; }
  if (!Array.isArray(rows)) return { ok: false, reason: "parse" };
  const data = rows.filter((r) => Array.isArray(r) && /^\d{14}$/.test(r[0]));
  const usable = data.filter((r) => !isAfterCutoff(r[0], year, day));   // belt and braces: never trust "to="
  const statusClass = (r) => (r.length < 3 ? "2" : String(r[2] || "").charAt(0));   // 200-only lookups have no column
  const ok2 = usable.filter((r) => statusClass(r) === "2");
  const pool = ok2.length ? ok2 : usable.filter((r) => statusClass(r) === "3");
  if (!pool.length) return { ok: true, none: true };
  pool.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const [ts, original] = pool[pool.length - 1];
  return { ok: true, ts, original };
}

export function snapshotUrl(ts, original) {
  return `${WAYBACK}${ts}if_/${original}`;
}

// The CDX lookups for one link, best first: {url, kind}. kind "page" = that page, "noquery" = same page
// without its query string, "site" = the site's front page (shown with a note: the exact page was not
// saved back then). "/?p=123" without its query IS the front page, so it counts as "site" (and gets the note).
// CDX keys are SURTs, which already ignore http/https and "www.", so no scheme variants.
export function candidateUrls(normalized) {
  const out = [{ url: normalized, kind: "page" }];
  try {
    const u = new URL(normalized);
    if (u.search) {
      const v = new URL(normalized); v.search = "";
      out.push({ url: v.toString(), kind: v.pathname === "/" ? "site" : "noquery" });
    }
    if (u.pathname !== "/" || u.search) out.push({ url: `${u.protocol}//${u.hostname}/`, kind: "site" });
  } catch (_) { /* ignore */ }
  const seen = new Set();
  return out.filter((c) => !seen.has(c.url) && seen.add(c.url));
}

// ---- the resolver's decision, without chrome.* (deps are injected so node tests can drive it) ----------------
// Cache: "wb2:<year>[:<day>]:<url>" -> {ts, original, approx, at} | {none:true, at}. "wb:" (up to 0.2.0) could hold
// a redirect pick whose replay lands after the cutoff (a loop for 7 days), so those entries are never read again.
export const CACHE_PREFIX = "wb2:";
export const OLD_CACHE_PREFIX = "wb:";
export const CACHE_MS = 7 * 864e5;

export function cacheKey(url, year, day) {
  return `${CACHE_PREFIX}${year}${day ? ":" + day : ""}:${url}`;
}

// deps: lookup(url, year, day, {redirects}) -> parseCdx-like result; getCached(key) -> entry | undefined;
// setCached(key, entry); now() -> ms.
// opts.force200: the last pick's replay landed after the cutoff (guard, why=future): skip the cache, accept only
// 200 captures and overwrite the cache entry.
// Reply: {ok:true, ts, waybackUrl, approx: "page"|"noquery"|"site"|"stale", cached?, degraded?} or
// {ok:false, reason}. degraded = an earlier, better candidate failed (archive error), so the hit is only a
// fallback: it is not cached and the resolver page asks once more before it settles for it.
export async function resolveCapture(deps, rawUrl, year, day, { force200 = false } = {}) {
  const { lookup, getCached, setCached, now = () => Date.now() } = deps;
  const url = normalizeUrl(rawUrl);
  if (!url || !Number.isFinite(year)) return { ok: false, reason: "bad-request" };
  const key = cacheKey(url, year, day);
  if (!force200) {
    const cached = await getCached(key);
    if (cached && now() - cached.at < CACHE_MS) {
      return cached.none ? { ok: false, reason: "none", cached: true } :
        { ok: true, ts: cached.ts, waybackUrl: snapshotUrl(cached.ts, cached.original), approx: cached.approx || "page", cached: true };
    }
  }
  const dayCut = validDay(year, day);
  let lastError = null, degraded = false, hit = null, stale = null;
  for (const candidate of candidateUrls(url)) {
    // a site's front page often only redirected (to /mail/, /en/, www. or https) in a given year, and a service
    // opened for one day may have moved by then: both also accept redirect captures (newest 2xx preferred)
    const front = candidate.kind === "site" || new URL(candidate.url).pathname === "/";
    const r = await lookup(candidate.url, year, day, { redirects: !force200 && (front || dayCut) });
    if (!r || !r.ok) { lastError = r || { ok: false, reason: "error" }; degraded = true; if (lastError.reason === "busy") break; continue; }
    if (r.none) continue;
    if (isStale(r.ts, year, day)) { if (!stale) stale = r; continue; }   // a later candidate may be that day's page
    hit = { r, approx: candidate.kind };
    break;
  }
  if (!hit && stale && !(lastError && lastError.reason === "busy")) hit = { r: stale, approx: "stale" };
  if (hit) {
    const out = { ok: true, ts: hit.r.ts, waybackUrl: snapshotUrl(hit.r.ts, hit.r.original), approx: hit.approx };
    if (degraded) return { ...out, degraded: true };
    await setCached(key, { ts: hit.r.ts, original: hit.r.original, approx: hit.approx, at: now() });
    return out;
  }
  if (lastError) return lastError;
  await setCached(key, { none: true, at: now() });
  return { ok: false, reason: "none" };
}

// Batch availability (POST archive.org/wayback/available, Wayback-Api-Version 2): one request answers for many
// sites. Asking for the capture closest to 1996-01-01 returns each site's EARLIEST capture (the archive starts
// in 1996). Measured 11.11.2026: "closest":"before" is ignored (top40-charts.com for 2010 came back as 2011
// although 2010 captures exist), so only the earliest capture is a reliable "did this site exist by year Y".
// An empty answer ({}) means unknown, never "did not exist".
export function availabilityBody(hosts) {
  return JSON.stringify(hosts.map((h) => ({ url: h, timestamp: "19960101" })));
}

// -> {host: "YYYYMMDDhhmmss" (earliest capture) | null (unknown)}
export function parseAvailability(text) {
  let data;
  try { data = JSON.parse(text); } catch (_) { return null; }
  const out = {};
  for (const r of (data && data.results) || []) {
    const c = r.archived_snapshots && r.archived_snapshots.closest;
    const host = String(r.url || "").toLowerCase();
    if (!host) continue;
    out[host] = c && /^\d{14}$/.test(c.timestamp || "") ? c.timestamp : null;
  }
  return out;
}

export function existedBy(firstTs, year) {
  if (!firstTs) return "unknown";
  return isAfterCutoff(firstTs, year) ? "no" : "yes";
}

// "wbfirst:<host>" cache: {ts, at} = the earliest capture (kept for good), {ts:null, at, n} = n empty answers in a
// row. The archive sometimes answers empty on a cold first call, so one empty answer is asked once more; after the
// second, the site counts as "unknown" for FIRST_EMPTY_MS without asking again. -> answer, or null = ask the archive.
export const FIRST_EMPTY_MS = 3600e3;
export function cachedFirstAnswer(entry, year, now = Date.now()) {
  if (!entry) return null;
  if (entry.ts) return existedBy(entry.ts, year);
  if (entry.ts === null && (entry.n || 1) >= 2 && now - (entry.at || 0) < FIRST_EMPTY_MS) return "unknown";
  return null;
}

// The cache entry to store after an empty answer for a host.
export function emptyFirstEntry(prev, now = Date.now()) {
  const recent = prev && prev.ts === null && now - (prev.at || 0) < FIRST_EMPTY_MS;
  return { ts: null, at: now, n: recent ? (prev.n || 1) + 1 : 1 };
}

// Fragment of resolve.html / notfound.html: "y=<year>[&d=<day>][&why=<why>][&from=<module>]&u=<rest of fragment,
// raw or encoded>". from=youtube: notfound.html stands in for a YouTube page (before 2005) and goes back to it.
export function parseFragment(hash) {
  const h = String(hash || "").replace(/^#/, "");
  const out = { y: NaN, why: "", u: "", d: "", from: "" };
  const ui = h.indexOf("u=");
  const head = ui >= 0 ? h.slice(0, ui) : h;
  for (const part of head.split("&")) {
    const [k, v] = part.split("=");
    if (k === "y") out.y = Number(v);
    if (k === "why") out.why = v || "";
    if (k === "d" && /^\d{8}$/.test(v || "")) out.d = v;
    if (k === "from" && /^[a-z]+$/.test(v || "")) out.from = v;
  }
  if (ui >= 0) {
    let u = h.slice(ui + 2);
    if (/^[a-z][a-z0-9+.-]*%3A/i.test(u)) { try { u = decodeURIComponent(u); } catch (_) { /* keep */ } }
    out.u = u;
  }
  return out;
}

// Loop breaker for the guard (sw_wayback.js). Per tab: the archive target the guard last sent back to the resolver
// and whether the resolver has answered since. The same target coming back after that answer is a loop (a capture
// whose replay keeps landing after the cutoff), however slow the archive is. The same target again BEFORE the
// resolver ran is one navigation seen twice (onBeforeNavigate, then onCommitted): skip it. More than maxInWindow
// bounces within windowMs is the second net (targets that alternate, or a page that keeps sending itself back
// through the resolver), as before. A page that passes the guard, or a tab that leaves the archive, ends the chain
// (settled); forget() drops the tab.
export function createBounceTracker({ now = () => Date.now(), dupMs = 10000, windowMs = 20000, maxInWindow = 4 } = {}) {
  const last = new Map();    // tabId -> {target, at, ran}
  const times = new Map();   // tabId -> [ms of recent bounces]
  return {
    // -> "go" (send it to the resolver), "skip" (already on its way) or "loop" (give up: notfound why=loop)
    decide(tabId, target) {
      const t = now();
      const b = last.get(tabId);
      if (b && b.target === target) {
        if (b.ran) return "loop";
        if (t - b.at < dupMs) return "skip";
      }
      const list = (times.get(tabId) || []).filter((x) => t - x < windowMs);
      list.push(t);
      times.set(tabId, list);
      last.set(tabId, { target, at: t, ran: false });
      return list.length > maxInWindow ? "loop" : "go";
    },
    resolverRan(tabId) { const b = last.get(tabId); if (b) b.ran = true; },
    settled(tabId) { last.delete(tabId); },
    forget(tabId) { last.delete(tabId); times.delete(tabId); }
  };
}

// A queue that runs one task at a time with a minimum gap and a per-minute budget.
export function createLimiter({ minGapMs = 3000, perMinute = 20, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let chain = Promise.resolve();
  let last = 0;
  const stamps = [];
  let pausedUntil = 0;
  function run(task) {
    const p = chain.then(async () => {
      for (;;) {
        const t = now();
        while (stamps.length && t - stamps[0] > 60000) stamps.shift();
        let wait = Math.max(0, last + minGapMs - t, pausedUntil - t);
        if (stamps.length >= perMinute) wait = Math.max(wait, stamps[0] + 60000 - t);
        if (wait <= 0) break;
        await sleep(wait);
      }
      last = now();
      stamps.push(last);
      return task();
    });
    chain = p.catch(() => {});
    return p;
  }
  return { run, pause(ms) { pausedUntil = Math.max(pausedUntil, now() + ms); }, get pausedUntil() { return pausedUntil; } };
}
