// Wayback module, service-worker side.
//  - "wayback:resolve" {url, year, day?, force200?}: strict CDX lookup -> {ok:true, ts, waybackUrl, approx} | {ok:false, reason}
//  - "wayback:hosts" {hosts, year}: did these sites exist by the end of the year (each site's earliest capture)
//  - dynamic DNR rules: 1000 sends pages opened from Google results to resolve.html first; 1001 (always on) blocks
//    sign-in forms inside archived Google pages, which would post the typed address and password to web.archive.org
//  - a webNavigation guard keeps every web.archive.org page at or before the chosen year (or day), toolbar hidden
import { getState } from "../shared/state_sw.js";
import {
  cdxQueryUrl, parseCdx, parseWaybackUrl, isAfterCutoff, createLimiter, validDay, availabilityBody, parseAvailability,
  existedBy, resolveCapture, cachedFirstAnswer, emptyFirstEntry, createBounceTracker, OLD_CACHE_PREFIX
} from "./wayback_core.js";

const RULE_ID = 1000;
const LOGIN_BLOCK_ID = 1001;
const GOOGLE_DOMAINS = ["google.com", "google.de", "google.ru", "google.co.uk"];
const NEVER_REDIRECT = [
  ...GOOGLE_DOMAINS, "gstatic.com", "googleusercontent.com", "googleapis.com", "google-analytics.com",
  "youtube.com", "youtu.be", "archive.org", "accounts.google.com", "consent.google.com"
];

// archive.org: hard limit 30 CDX requests/min per IP; we stay at 20/min with at least 1 s between requests.
// The availability POST (site check, one per results page) has its own queue, at least 3 s apart and 10/min, so a
// slow answer never holds up the lookup of a clicked result. A 429 from either pauses both for 70 s.
const limiter = createLimiter({ minGapMs: 1000, perMinute: 20 });
const hostsLimiter = createLimiter({ minGapMs: 3000, perMinute: 10 });
function pauseArchive() {
  limiter.pause(70000);
  hostsLimiter.pause(70000);
}

async function cdxLookup(url, year, day, opts) {
  return limiter.run(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(cdxQueryUrl(url, year, day, opts), { signal: ctrl.signal, credentials: "omit" });
      if (r.status === 429) {
        pauseArchive();
        return { ok: false, reason: "busy" };
      }
      if (!r.ok) return { ok: false, reason: "error", status: r.status };
      return parseCdx(await r.text(), year, day);
    } catch (e) {
      return { ok: false, reason: "error", detail: String(e && e.name) };
    } finally {
      clearTimeout(timer);
    }
  });
}

// Best capture at or before the cutoff: the page itself, else the page without its query string, else the
// site's front page from that time (approx: "site", the resolver says so). Errors are never cached, and neither is
// a fallback found after an error (degraded). The decision lives in wayback_core.js (resolveCapture).
export function resolve(rawUrl, year, day, opts) {
  return resolveCapture({
    lookup: cdxLookup,
    getCached: async (key) => (await chrome.storage.local.get(key))[key],
    setCached: (key, value) => chrome.storage.local.set({ [key]: value })
  }, rawUrl, year, day, opts);
}

// Did these sites exist by the end of the year? Uses each site's earliest capture (cached for good: it does
// not depend on the year), one POST for all hosts not seen before. A host already being asked for is not asked
// again: the second caller waits for the same answer. 429 (or a pause after one) -> every host is "busy".
const FIRST_PREFIX = "wbfirst:";
const AVAILABLE = "https://archive.org/wayback/available";
const firstInflight = new Map();   // host -> Promise<"YYYYMMDDhhmmss" | null | "busy" | "error">

function askFirstCaptures(hosts, cachedEntries) {
  const all = (v) => Object.fromEntries(hosts.map((h) => [h, v]));
  if (Math.max(limiter.pausedUntil, hostsLimiter.pausedUntil) > Date.now()) return Promise.resolve(all("busy"));
  return hostsLimiter.run(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);   // a page waits at most HOLD_MAX_MS (content.js) anyway
    try {
      const r = await fetch(AVAILABLE, {
        method: "POST", credentials: "omit", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "Wayback-Api-Version": "2" },
        body: availabilityBody(hosts)
      });
      if (r.status === 429) {
        pauseArchive();
        return all("busy");
      }
      if (!r.ok) return all("error");
      const parsed = parseAvailability(await r.text());
      if (!parsed) return all("error");
      const now = Date.now(), out = {}, save = {};
      for (const h of hosts) {
        const first = parsed[h] || null;
        out[h] = first;
        save[FIRST_PREFIX + h] = first ? { ts: first, at: now } : emptyFirstEntry(cachedEntries[FIRST_PREFIX + h], now);
      }
      await chrome.storage.local.set(save);
      return out;
    } catch (_) {
      return all("error");
    } finally {
      clearTimeout(timer);
    }
  });
}

// -> {host: "yes" | "no" | "unknown" | "busy"}
export async function hostsExisted(hosts, year) {
  const clean = [...new Set((hosts || []).map((h) => String(h || "").toLowerCase().replace(/^www\./, "")).filter(Boolean))].slice(0, 25);
  const keys = clean.map((h) => FIRST_PREFIX + h);
  const cached = keys.length ? await chrome.storage.local.get(keys) : {};
  const now = Date.now();
  const out = {};
  const todo = [];
  for (const h of clean) {
    const known = cachedFirstAnswer(cached[FIRST_PREFIX + h], year, now);
    if (known) out[h] = known;
    else if (!firstInflight.has(h)) todo.push(h);
  }
  if (todo.length) {
    const ask = askFirstCaptures(todo, cached);
    for (const h of todo) firstInflight.set(h, ask.then((res) => res[h]));
    ask.finally(() => { for (const h of todo) firstInflight.delete(h); }).catch(() => {});
  }
  const open = clean.filter((h) => !(h in out));
  const got = await Promise.all(open.map((h) => (firstInflight.get(h) || Promise.resolve("error")).catch(() => "error")));
  open.forEach((h, i) => {
    const v = got[i];
    out[h] = v === "busy" ? "busy" : (typeof v === "string" && /^\d{14}$/.test(v)) ? existedBy(v, year) : "unknown";
  });
  return out;
}

function resolverBase() {
  return chrome.runtime.getURL("src/wayback/resolve.html");
}

function resolverPage(year, url, why, day) {
  return `${resolverBase()}#y=${year}${day ? `&d=${day}` : ""}${why ? `&why=${why}` : ""}&u=${url}`;
}

function loopPage(year, url, day) {
  return chrome.runtime.getURL(`src/wayback/notfound.html#y=${year}${day ? `&d=${day}` : ""}&why=loop&u=${url}`);
}

// Archived sign-in forms (Gmail, Docs, Calendar...) post to web.archive.org/web/<ts>/https://accounts.google.com/...
// or .../www.google.com/accounts/...: block those posts whatever the settings.
const LOGIN_BLOCK_RULE = {
  id: LOGIN_BLOCK_ID,
  priority: 2,
  action: { type: "block" },
  condition: {
    regexFilter: "^https?://web\\.archive\\.org/web/[0-9]*[a-z_]*/https?://(accounts\\.google\\.com(:[0-9]+)?/|(www\\.)?google\\.com(:[0-9]+)?/accounts/)",
    requestMethods: ["post"],
    resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"]
  }
};

// Pages opened from Google results go to resolve.html (which finds the capture from that year).
async function syncRule() {
  const st = await getState();
  const removeRuleIds = [RULE_ID, LOGIN_BLOCK_ID];
  const addRules = [LOGIN_BLOCK_RULE];
  if (st.enabled && st.google) {
    addRules.push({
      id: RULE_ID,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: `${resolverBase()}#y=${st.year}&u=\\0` }
      },
      condition: {
        regexFilter: "^https?://.*",
        resourceTypes: ["main_frame"],
        initiatorDomains: GOOGLE_DOMAINS,
        excludedRequestDomains: NEVER_REDIRECT
      }
    });
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.warn("[yesteryear] wayback rule update failed", e);
  }
}

// Cache entries of 0.2.0 and earlier ("wb:") may hold a redirect pick that loops: drop them once.
async function dropOldCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const old = Object.keys(all).filter((k) => k.startsWith(OLD_CACHE_PREFIX));
    if (old.length) await chrome.storage.local.remove(old);
  } catch (_) { /* nothing to drop */ }
}

// A day cut ("Today in 2005", period Google tabs) stays with the tab while it browses the archive, so links inside
// the archived page keep that day. chrome.storage.session survives service-worker restarts.
const DAY_PREFIX = "wbday:";
let dayTabs = null;   // tab ids with a stored day (loaded from storage.session once per service-worker start)

async function knownDayTabs() {
  if (!dayTabs) {
    let all = {};
    try { all = await chrome.storage.session.get(null); } catch (_) { /* none */ }
    dayTabs = dayTabs || new Set(Object.keys(all).filter((k) => k.startsWith(DAY_PREFIX)).map((k) => Number(k.slice(DAY_PREFIX.length))));
  }
  return dayTabs;
}

async function rememberDay(tabId, year, day) {
  const tabs = await knownDayTabs();
  const key = DAY_PREFIX + tabId;
  try {
    if (validDay(year, day)) {
      tabs.add(tabId);
      await chrome.storage.session.set({ [key]: { year, day: String(day) } });
    } else if (tabs.has(tabId)) {
      tabs.delete(tabId);
      await chrome.storage.session.remove(key);
    }
  } catch (_) { /* without it the guard cuts at the end of the year */ }
}

async function forgetDay(tabId) {
  const tabs = await knownDayTabs();
  if (!tabs.has(tabId)) return;
  tabs.delete(tabId);
  try { await chrome.storage.session.remove(DAY_PREFIX + tabId); } catch (_) { /* gone anyway */ }
}

async function dayOf(tabId, year) {
  const tabs = await knownDayTabs();
  if (!tabs.has(tabId)) return "";
  const key = DAY_PREFIX + tabId;
  try {
    const v = (await chrome.storage.session.get(key))[key];
    return v && v.year === year && validDay(year, v.day) ? v.day : "";
  } catch (_) { return ""; }
}

// Every archived page must be from the chosen year (or day) or earlier and use if_ (no Wayback toolbar).
const bounces = createBounceTracker();

// Safety net for result clicks the DNR rule missed (e.g. a server redirect it did not see).
const recent = new Map();   // tabId -> [timestamps of safety-net redirects]
function tooManyRedirects(tabId) {
  const now = Date.now();
  const list = (recent.get(tabId) || []).filter((t) => now - t < 20000);
  list.push(now);
  recent.set(tabId, list);
  return list.length > 4;
}

const lastCommitted = new Map();   // tabId -> last committed main-frame URL

function isGoogleSearch(href) {
  try {
    const u = new URL(href);
    return /(^|\.)google\.(com|de|ru|co\.uk)$/i.test(u.hostname) && (u.pathname === "/search" || u.pathname === "/goto" || u.pathname === "/url");
  } catch (_) { return false; }
}

function isExcluded(href) {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return !/^https?:/.test(href) || NEVER_REDIRECT.some((d) => host === d || host.endsWith("." + d));
  } catch (_) { return true; }
}

function isArchive(href) {
  try { return /(^|\.)archive\.org$/i.test(new URL(href).hostname); } catch (_) { return false; }
}

async function afterGoogle(details) {
  const prev = lastCommitted.get(details.tabId);
  lastCommitted.set(details.tabId, details.url);
  if (!prev || !isGoogleSearch(prev) || isExcluded(details.url)) return;
  if (details.transitionType !== "link") return;     // a typed address or a bookmark is the user's choice
  const st = await getState();
  if (!st.enabled || !st.google) return;
  if (tooManyRedirects(details.tabId)) return;
  chrome.tabs.update(details.tabId, { url: resolverPage(st.year, details.url) }).catch(() => {});
}

// Every main-frame commit: a tab that leaves the archive ends its bounce chain and its day cut (the resolver page
// itself is part of the chain; our other pages keep the day so "Try again" keeps it too).
async function onMainCommit(details) {
  if (details.frameId !== 0) return;
  const url = details.url || "";
  if (!isArchive(url)) {
    if (!url.startsWith(resolverBase())) bounces.settled(details.tabId);
    if (!url.startsWith(chrome.runtime.getURL(""))) await forgetDay(details.tabId);
  }
  return afterGoogle(details);
}

// committed = onCommitted (the final URL after server redirects); onBeforeNavigate only sees where a navigation
// starts, so only a commit may end a bounce chain.
async function guard(details, committed) {
  if (details.frameId !== 0) return;
  const st = await getState();
  if (!st.enabled || !st.strict) return;
  const wb = parseWaybackUrl(details.url);
  if (!wb) return;
  const day = await dayOf(details.tabId, st.year);
  const future = isAfterCutoff(wb.ts, st.year, day);
  if (!future && wb.flags === "if_") {
    if (committed) bounces.settled(details.tabId);
    return;
  }
  const verdict = bounces.decide(details.tabId, wb.target);
  if (verdict === "skip") return;
  // why=future: the last pick's replay landed after the cutoff (a redirect capture): the resolver then accepts
  // only 200 captures and replaces its cached pick
  const url = verdict === "loop" ? loopPage(st.year, wb.target, day) : resolverPage(st.year, wb.target, future ? "future" : "", day);
  chrome.tabs.update(details.tabId, { url }).catch(() => {});
}

export function initWayback() {
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === "wayback:resolve") {
      const tabId = sender && sender.tab && sender.tab.id >= 0 ? sender.tab.id : -1;
      const year = Number(msg.year);
      (async () => {
        if (tabId >= 0) {
          bounces.resolverRan(tabId);
          await rememberDay(tabId, year, msg.day);
        }
        return resolve(msg.url, year, msg.day, { force200: msg.force200 === true });
      })().then(reply, (e) => reply({ ok: false, reason: "error", detail: String(e) }));
      return true;
    }
    if (msg?.type === "wayback:hosts") {
      hostsExisted(msg.hosts, Number(msg.year)).then(reply, () => reply({}));
      return true;
    }
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ("enabled" in changes || "year" in changes || "google" in changes)) syncRule();
  });
  chrome.runtime.onInstalled.addListener(() => { syncRule(); dropOldCache(); });
  chrome.runtime.onStartup.addListener(syncRule);
  syncRule();
  const filter = { url: [{ hostSuffix: "web.archive.org" }] };
  chrome.webNavigation.onBeforeNavigate.addListener((d) => guard(d, false), filter);
  chrome.webNavigation.onCommitted.addListener((d) => guard(d, true), filter);
  chrome.webNavigation.onCommitted.addListener(onMainCommit);
  chrome.tabs.onRemoved.addListener((tabId) => {
    lastCommitted.delete(tabId); recent.delete(tabId); bounces.forget(tabId); forgetDay(tabId);
  });
}
