// Unit tests for the v0.2 review fixes in the cores (resolver decisions, loop breaker, site-check cache, query
// mapping, period tabs, settings changes). No network: archive lookups and storage are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as W from "../../extension/src/wayback/wayback_core.js";

const require = createRequire(import.meta.url);
const YY = require("../../extension/src/shared/common.js");
const G = require("../../extension/src/google/google_core.js");
const T = require("../../extension/src/youtube/youtube_core.js");

const cdx = (...rows) => JSON.stringify([["timestamp", "original", "statuscode"], ...rows]);

// A fake archive + cache for resolveCapture. answers: url -> (opts) => parseCdx-like result.
function fakeDeps(answers, { now = 1e12 } = {}) {
  const store = new Map();
  const calls = [];
  const deps = {
    now: () => now,
    getCached: async (k) => store.get(k),
    setCached: async (k, v) => { store.set(k, v); },
    lookup: async (url, year, day, opts) => {
      calls.push({ url, year, day, redirects: !!opts.redirects });
      const a = answers[url];
      return a ? a(opts) : { ok: true, none: true };
    }
  };
  return { deps, store, calls };
}

// ---------------------------------------------------------------- F8: redirect captures
test("F8: redirect-aware lookups ask for a window with status; 200-only lookups stay as they were", () => {
  const red = new URL(W.cdxQueryUrl("https://www.nytimes.com/", 2017, "", { redirects: true }));
  assert.equal(red.searchParams.get("limit"), "-20");
  assert.equal(red.searchParams.get("fl"), "timestamp,original,statuscode");
  assert.equal(red.searchParams.get("filter"), "statuscode:[23]..");
  const plain = new URL(W.cdxQueryUrl("https://www.nytimes.com/a", 2017));
  assert.equal(plain.searchParams.get("limit"), "-1");
  assert.equal(plain.searchParams.get("fl"), "timestamp,original");
  assert.equal(plain.searchParams.get("filter"), "statuscode:200");
});

test("F8: the newest 2xx in the window wins over a newer redirect (nytimes.com 2017)", () => {
  const body = cdx(["20171231200000", "https://www.nytimes.com/", "301"], ["20171231234502", "https://www.nytimes.com/", "200"],
    ["20171231235927", "http://nytimes.com/", "301"]);
  assert.deepEqual(W.parseCdx(body, 2017), { ok: true, ts: "20171231234502", original: "https://www.nytimes.com/" });
  // only redirects: the newest redirect is the last resort
  const only3 = cdx(["20100101000000", "http://a.example/", "302"], ["20100601000000", "http://a.example/", "301"]);
  assert.equal(W.parseCdx(only3, 2010).ts, "20100601000000");
  // rows after the cutoff never count, whatever their status
  const late = cdx(["20100601000000", "http://a.example/", "302"], ["20110101000500", "http://a.example/", "200"]);
  assert.equal(W.parseCdx(late, 2010).ts, "20100601000000");
  // two-column answers (200-only lookups) are all 2xx
  assert.equal(W.parseCdx(JSON.stringify([["timestamp", "original"], ["20100101000000", "http://a/"]]), 2010).ts, "20100101000000");
  assert.deepEqual(W.parseCdx(cdx(["20100101000000", "http://a/", "-"]), 2010), { ok: true, none: true });
});

test("F8: resolve picks the 200 for a front page and caches it under the new prefix", async () => {
  const body = cdx(["20171231234502", "https://www.nytimes.com/", "200"], ["20171231235927", "http://nytimes.com/", "301"]);
  const { deps, store, calls } = fakeDeps({ "https://www.nytimes.com/": () => W.parseCdx(body, 2017) });
  const r = await W.resolveCapture(deps, "https://www.nytimes.com/", 2017);
  assert.equal(r.ts, "20171231234502");
  assert.equal(r.approx, "page");
  assert.equal(calls[0].redirects, true);
  assert.equal(W.CACHE_PREFIX, "wb2:");
  assert.deepEqual([...store.keys()], ["wb2:2017:https://www.nytimes.com/"]);
});

test("F8: force200 skips the cached pick, asks 200-only and overwrites the entry", async () => {
  const { deps, store, calls } = fakeDeps({
    "https://www.nytimes.com/": (opts) => (opts.redirects ? { ok: true, ts: "20171231235927", original: "http://nytimes.com/" } :
      { ok: true, ts: "20171231234502", original: "https://www.nytimes.com/" })
  });
  store.set("wb2:2017:https://www.nytimes.com/", { ts: "20171231235927", original: "http://nytimes.com/", approx: "page", at: 1e12 });
  const cached = await W.resolveCapture(deps, "https://www.nytimes.com/", 2017);
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 0);
  const forced = await W.resolveCapture(deps, "https://www.nytimes.com/", 2017, undefined, { force200: true });
  assert.equal(forced.ts, "20171231234502");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirects, false);
  assert.equal(store.get("wb2:2017:https://www.nytimes.com/").ts, "20171231234502");
});

test("F8: the guard's loop breaker stops the same target at once, however slow the archive is", () => {
  let t = 0;
  const b = W.createBounceTracker({ now: () => t });
  assert.equal(b.decide(7, "https://www.nytimes.com/"), "go");
  t += 300;
  assert.equal(b.decide(7, "https://www.nytimes.com/"), "skip");      // same navigation seen twice (before + committed)
  b.resolverRan(7);
  t += 60000;                                                          // a slow archive: a minute per bounce
  assert.equal(b.decide(7, "https://www.nytimes.com/"), "loop");
  // a page that passes the guard ends the chain: the same target later is a new trip
  b.settled(7);
  assert.equal(b.decide(7, "https://www.nytimes.com/"), "go");
  // other tabs are separate
  assert.equal(b.decide(8, "https://www.nytimes.com/"), "go");
});

test("F8: the rate net still catches targets that alternate and a page that keeps sending itself back", () => {
  let t = 0;
  const b = W.createBounceTracker({ now: () => t });
  const seq = ["a", "b", "a", "b"].map((x) => { t += 1000; const v = b.decide(1, x); b.resolverRan(1); return v; });
  assert.deepEqual(seq, ["go", "go", "go", "go"]);
  t += 1000;
  assert.equal(b.decide(1, "c"), "loop");                              // a fifth bounce within 20 s
  // a page that passes, then sends itself through the resolver again (a script redirect), over and over
  const c = W.createBounceTracker({ now: () => t });
  const self = [1, 2, 3, 4, 5].map(() => { t += 1500; const v = c.decide(2, "x"); c.resolverRan(2); c.settled(2); return v; });
  assert.deepEqual(self, ["go", "go", "go", "go", "loop"]);
  // spread out over time it is ordinary browsing; forget() drops a closed tab
  t += 60000;
  assert.equal(c.decide(2, "x"), "go");
  c.forget(2);
  assert.equal(c.decide(2, "x"), "go");
});

// ---------------------------------------------------------------- F9: errors are not cached as fallbacks
test("F9: a page lookup error followed by a front-page hit is degraded and not cached", async () => {
  const page = "https://deep.example.net/a/b.html";
  const { deps, store } = fakeDeps({
    [page]: () => ({ ok: false, reason: "error", status: 503 }),
    "https://deep.example.net/": () => ({ ok: true, ts: "20100505000000", original: "https://deep.example.net/" })
  });
  const r = await W.resolveCapture(deps, page, 2010);
  assert.equal(r.ok, true);
  assert.equal(r.approx, "site");
  assert.equal(r.degraded, true);
  assert.equal(store.size, 0, "no wb2: key after an archive error");
  // healthy again: the page itself is found and cached
  const ok = fakeDeps({ [page]: () => ({ ok: true, ts: "20100601000000", original: page }) });
  const r2 = await W.resolveCapture(ok.deps, page, 2010);
  assert.equal(r2.approx, "page");
  assert.equal(r2.degraded, undefined);
  assert.equal(ok.store.size, 1);
});

test("F9: an error before a 'noquery' hit is degraded too; 429 stops the lookups and is never cached", async () => {
  const page = "https://x.example/news.php?nid=1";
  const a = fakeDeps({
    [page]: () => ({ ok: false, reason: "error" }),
    "https://x.example/news.php": () => ({ ok: true, ts: "20100209000000", original: "https://x.example/news.php" })
  });
  const r = await W.resolveCapture(a.deps, page, 2010);
  assert.deepEqual([r.approx, r.degraded, a.store.size], ["noquery", true, 0]);
  const busy = fakeDeps({ [page]: () => ({ ok: false, reason: "busy" }) });
  const rb = await W.resolveCapture(busy.deps, page, 2010);
  assert.equal(rb.reason, "busy");
  assert.equal(busy.calls.length, 1);
  assert.equal(busy.store.size, 0);
});

// ---------------------------------------------------------------- F10: day cuts (period tabs)
test("F10: with a day cut every candidate uses the redirect window, and a stale copy is not 'that day's page'", async () => {
  assert.equal(W.isStale("20110501153351", 2024, "20241111"), true);
  assert.equal(W.isStale("20240101000000", 2024, "20241111"), false);
  assert.equal(W.isStale("20110501153351", 2024), false);              // no day cut: an old copy is fine
  // /products in 2024: the newest 200 is from 2011; the site's front page of that day exists
  const prod = "http://www.google.com/products";
  const a = fakeDeps({
    [prod]: () => ({ ok: true, ts: "20110501153351", original: prod }),
    "http://www.google.com/": () => ({ ok: true, ts: "20241111080000", original: "http://www.google.com/" })
  });
  const r = await W.resolveCapture(a.deps, prod, 2024, "20241111");
  assert.equal(r.approx, "site");
  assert.deepEqual(a.calls.map((c) => c.redirects), [true, true]);
  // nothing newer anywhere: the stale copy, said so
  const b = fakeDeps({ "http://groups.google.com/": () => ({ ok: true, ts: "20190101000000", original: "http://groups.google.com/" }) });
  const s = await W.resolveCapture(b.deps, "http://groups.google.com/", 2024, "20241111");
  assert.equal(s.approx, "stale");
  assert.equal(s.ts, "20190101000000");
  assert.equal(b.store.get("wb2:2024:20241111:http://groups.google.com/").approx, "stale");
});

// ---------------------------------------------------------------- F15: "/?p=123"
test("F15: the query-less front page of '/?p=123' counts as the site's front page", () => {
  assert.deepEqual(W.candidateUrls("https://blog.example/?p=123"), [
    { url: "https://blog.example/?p=123", kind: "page" },
    { url: "https://blog.example/", kind: "site" }
  ]);
  assert.deepEqual(W.candidateUrls("https://www.top40-charts.com/news.php?nid=1234").map((c) => c.kind), ["page", "noquery", "site"]);
});

// ---------------------------------------------------------------- F11 / F5: the site-existence cache
test("F11: empty availability answers are asked once more, then kept as unknown for an hour", () => {
  const now = 5e12;
  assert.equal(W.cachedFirstAnswer({ ts: "20050428014715", at: 1 }, 2004, now), "no");
  assert.equal(W.cachedFirstAnswer({ ts: "20050428014715", at: 1 }, 2005, now), "yes");
  const first = W.emptyFirstEntry(undefined, now);
  assert.deepEqual(first, { ts: null, at: now, n: 1 });
  assert.equal(W.cachedFirstAnswer(first, 2005, now + 1000), null);    // the cold-call retry still asks
  const second = W.emptyFirstEntry(first, now + 3000);
  assert.equal(second.n, 2);
  assert.equal(W.cachedFirstAnswer(second, 2005, now + 4000), "unknown");
  assert.equal(W.cachedFirstAnswer(second, 2005, now + 3000 + 3600e3 + 1), null);   // an hour later: ask again
  assert.equal(W.emptyFirstEntry(second, now + 3000 + 3600e3 + 1).n, 1);
  // the Google content script reads the same cache directly and must agree
  for (const [entry, year, at] of [[{ ts: "20050428014715", at: 1 }, 2004, now], [{ ts: "19990101000000", at: 1 }, 2005, now],
    [first, 2005, now + 1000], [second, 2005, now + 4000], [second, 2005, now + 3600e3 * 2], [undefined, 2005, now]]) {
    assert.equal(G.firstCaptureAnswer(entry, year, at), W.cachedFirstAnswer(entry, year, at));
  }
});

// ---------------------------------------------------------------- F14 / F4: fragments
test("F4/F14: fragments carry the day, why and the page a stand-in came from", () => {
  const f = W.parseFragment("#y=1999&why=none&from=youtube&u=https://www.youtube.com/watch?v=abc123&t=5#x");
  assert.deepEqual(f, { y: 1999, why: "none", u: "https://www.youtube.com/watch?v=abc123&t=5#x", d: "", from: "youtube" });
  const g = W.parseFragment("#y=2005&d=20051111&why=future&u=http://www.cnn.com/");
  assert.deepEqual([g.d, g.why, g.u], ["20051111", "future", "http://www.cnn.com/"]);
  assert.equal(W.validDay(2005, "20051111"), true);
  assert.equal(W.validDay(2005, "20061111"), false);
  assert.equal(W.isAfterCutoff("20051231230000", 2005, "20051111"), true);
});

// ---------------------------------------------------------------- F1: open Google tabs after a trip or OFF
test("F1: the user's words survive a trip; OFF goes back to them without our date cap", () => {
  const remembered = new Map();
  const lookup = (q) => remembered.get(q) || null;
  // search "best phone" at 2010
  const first = G.buildSearchUrl("https://www.google.com/search?q=best+phone&hl=en", 2010, YY.rewriteQuery);
  remembered.set(first.rewritten, "best phone");
  assert.equal(new URL(first.target).searchParams.get("q"), "best phone 2010");
  assert.equal(G.userWords(first.target, lookup), "best phone");
  // a trip to 2005: the open tab goes straight to the user's words for 2005
  const trip = G.retarget(first.target, G.userWords(first.target, lookup), { enabled: true, google: true, year: 2005 }, YY.rewriteQuery);
  const u = new URL(trip.target);
  assert.equal(u.searchParams.get("q"), "best phone 2005");
  assert.equal(u.searchParams.get("tbs"), "cdr:1,cd_min:1/1/1990,cd_max:12/31/2005");
  assert.equal(trip.rewritten, "best phone 2005");
  assert.equal(YY.futureYearsIn(G.userWords(first.target, lookup), 2005).length, 0);   // no "2010 has not happened yet"
  // the next page sees an unchanged plan: no second replace
  remembered.set(trip.rewritten, "best phone");
  const again = G.buildSearchUrl(G.withQuery(trip.target, G.userWords(trip.target, lookup)), 2005, YY.rewriteQuery);
  assert.equal(G.sameSearch(new URL(trip.target), new URL(again.target)), true);
  // OFF: the user's words, no tbs, no udm=14
  const off = new URL(G.retarget(trip.target, "best phone", { enabled: false, google: true, year: 2005 }, YY.rewriteQuery).target);
  assert.equal(off.searchParams.get("q"), "best phone");
  assert.equal(off.searchParams.get("tbs"), null);
  assert.equal(off.searchParams.get("udm"), null);
  assert.equal(off.searchParams.get("hl"), "en");
  // a date range the user chose is not ours: kept, and its q is the user's own
  const own = "https://www.google.com/search?q=best+phone+2010&tbs=cdr:1,cd_min:1/1/2008,cd_max:6/30/2009";
  assert.equal(G.userWords(own, () => "something else"), "best phone 2010");
  assert.equal(new URL(G.retarget(own, "best phone 2010", { enabled: false }, YY.rewriteQuery).target).searchParams.get("tbs"), "cdr:1,cd_min:1/1/2008,cd_max:6/30/2009");
  assert.equal(G.retarget("https://www.google.com/webhp", "x", { enabled: true, google: true, year: 2005 }, YY.rewriteQuery), null);
});

// ---------------------------------------------------------------- F6 / F18 / F10 / F16: links and tabs
test("F6: Google's own search links are not results; a result's site comes from the link when there is no cite", () => {
  assert.equal(G.isGoogleSearchLink("https://www.google.com/search?q=test&tbs=qdr:d"), true);
  assert.equal(G.isGoogleSearchLink("https://www.google.com/url?q=http://a.example/"), false);
  assert.equal(G.isGoogleSearchLink("https://www.google.com/goto?url=CAES"), false);
  assert.equal(G.linkHost("http://www.netaddiction.com/resources/internet_addiction_test.htm"), "www.netaddiction.com");
  assert.equal(G.linkHost("https://www.google.com/url?q=https://Example.org/a&sa=U"), "example.org");
  assert.equal(G.linkHost("https://www.google.com/goto?url=CAESabc"), "");
  assert.equal(G.linkHost("https://support.google.com/websearch"), "support.google.com");
  assert.equal(G.linkHost("javascript:void(0)"), "");
});

test("F10/F16: period tabs open each service where it lived on that day", () => {
  assert.equal(G.serviceUrl("Shopping", "20101111"), "http://www.google.com/products");
  assert.equal(G.serviceUrl("Shopping", "20151111"), "http://www.google.com/shopping");
  assert.equal(G.serviceUrl("Shopping", "20241111"), "https://shopping.google.com/");
  assert.equal(G.serviceUrl("more ▼", "20091111"), "http://www.google.com/options/");
  assert.equal(G.serviceUrl("More »", "20121111"), "http://www.google.com/intl/en/about/products/");
  assert.equal(G.serviceUrl("More", "20171111"), "http://www.google.com/intl/en/about/products/");
  assert.equal(G.serviceUrl("More", "20201111"), "https://about.google/products/");
  assert.equal(G.serviceUrl("Gmail", "20051111"), "http://gmail.google.com/");
  assert.equal(G.serviceUrl("Gmail", "20061111"), "http://mail.google.com/");
  assert.equal(G.serviceUrl("Web", "20061111"), null);
  const bar = (d) => G.navNames("2011", d);
  assert.equal(bar("20111111").includes("Play"), false);
  assert.equal(bar("20111111").includes("Drive"), false);
  assert.deepEqual(bar("20111111").filter((n) => n === "Documents" || n === "Calendar"), ["Documents", "Calendar"]);
  assert.equal(bar("20120401").includes("Play"), true);
  assert.equal(bar("20120401").includes("Drive"), false);
  assert.equal(bar("20121111").includes("Drive"), true);
  assert.equal(G.serviceUrl("Documents", "20111111"), "http://docs.google.com/");
  assert.equal(G.serviceUrl("Calendar", "20111111"), "http://www.google.com/calendar");
  for (const name of bar("20111111")) {
    if (!["Search", "Images", "YouTube"].includes(name)) assert.ok(G.serviceUrl(name, "20111111"), name);
  }
});

// ---------------------------------------------------------------- F3: open YouTube tabs after a trip or OFF
test("F3: YouTube queries keep the user's words, so a trip replaces the old before:", () => {
  const built2010 = T.queryFor("best phone", 2010, YY.rewriteQuery);
  assert.equal(built2010, "best phone 2010 before:2011-01-01");
  // remembered: rebuilt for the new year
  assert.equal(T.userQuery(built2010, "best phone"), "best phone");
  assert.equal(T.queryFor(T.userQuery(built2010, "best phone"), 2006, YY.rewriteQuery), "best phone 2006 before:2007-01-01");
  // a before: the user typed (nothing remembered) is left alone
  assert.equal(T.userQuery("cats before:2007-01-01", null), null);
  assert.equal(T.userQuery("cats", null), "cats");
  // the home page's year search
  assert.equal(T.queryFor("", 2006, YY.rewriteQuery), "2006 before:2007-01-01");
  assert.equal(T.userQuery("2010 before:2011-01-01", ""), "");
});

// ---------------------------------------------------------------- F2: settled, visible-only state changes
function fakeDoc(visibility = "visible") {
  const listeners = {};
  return {
    visibilityState: visibility,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
    listeners
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("F2: a burst of year changes gives one callback with the last state", async () => {
  let push;
  const got = [];
  const doc = fakeDoc("visible");
  YY.onSettledStateChange((st) => got.push(st.year), { delayMs: 30, doc, win: fakeDoc(), subscribe: (cb) => { push = cb; }, read: async () => ({}) });
  push({ year: 2001 }); await sleep(5); push({ year: 2002 }); await sleep(5); push({ year: 2003 });
  await sleep(80);
  assert.deepEqual(got, [2003]);
});

test("F2: a hidden tab waits until it is shown, then acts once", async () => {
  let push;
  const got = [];
  const doc = fakeDoc("hidden");
  YY.onSettledStateChange((st) => got.push(st.year), { delayMs: 10, doc, win: fakeDoc(), subscribe: (cb) => { push = cb; }, read: async () => ({}) });
  push({ year: 2005 }); push({ year: 1999 });
  await sleep(50);
  assert.deepEqual(got, []);
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  doc.fire("visibilitychange");
  assert.deepEqual(got, [1999]);
});

test("F2: a page restored from the back/forward cache checks the settings again", async () => {
  const got = [];
  const win = fakeDoc();
  YY.onSettledStateChange((st) => got.push(st.year), { delayMs: 10, doc: fakeDoc("visible"), win, subscribe: () => {}, read: async () => ({ year: 2012 }) });
  win.fire("pageshow", { persisted: false });
  win.fire("pageshow", { persisted: true });
  await sleep(20);
  assert.deepEqual(got, [2012]);
});
