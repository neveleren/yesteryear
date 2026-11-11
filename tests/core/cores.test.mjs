// Unit tests for the DOM-free cores: wayback_core.js, google_core.js, youtube_core.js, common.js. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as W from "../../extension/src/wayback/wayback_core.js";

const require = createRequire(import.meta.url);
const YY = require("../../extension/src/shared/common.js");
const G = require("../../extension/src/google/google_core.js");
const T = require("../../extension/src/youtube/youtube_core.js");
const fixture = (name) => readFileSync(new URL(`../../research/wb/dl/${name}`, import.meta.url), "utf8");

test("wayback: timestamps are padded to the end of the period and compared to the cutoff", () => {
  assert.equal(W.padTs("2010"), "20101231235959");
  assert.equal(W.padTs("201005"), "20100531235959");
  assert.equal(W.padTs("20101231191441"), "20101231191441");
  assert.equal(W.isAfterCutoff("20101231191441", 2010), false);
  assert.equal(W.isAfterCutoff("20110101001400", 2010), true);
  assert.equal(W.isAfterCutoff("2010", 2010), false);
  assert.equal(W.isAfterCutoff("", 2010), true);            // no timestamp = "latest" = future
});

test("wayback: parses archive URLs with and without flags", () => {
  assert.deepEqual(W.parseWaybackUrl("https://web.archive.org/web/20101231191441if_/http://www.google.com/"),
    { ts: "20101231191441", flags: "if_", target: "http://www.google.com/" });
  assert.deepEqual(W.parseWaybackUrl("https://web.archive.org/web/2010/http:/example.com/a?b=1"),
    { ts: "2010", flags: "", target: "http://example.com/a?b=1" });
  assert.equal(W.parseWaybackUrl("https://web.archive.org/web/http://example.com/").ts, "");
  assert.equal(W.parseWaybackUrl("https://example.com/web/2010/x"), null);
});

test("wayback: normalizes links and unwraps Google /url wrappers", () => {
  assert.equal(W.normalizeUrl("https://www.google.com/url?q=https://Example.com/a%3Fx%3D1&sa=U"), "https://example.com/a?x=1");
  assert.equal(W.normalizeUrl("example.com/page?utm_source=x&id=7#top"), "http://example.com/page?id=7");
  assert.equal(W.normalizeUrl("https%3A%2F%2Fexample.org%2F"), "https://example.org/");
  assert.equal(W.normalizeUrl("javascript:alert(1)"), "");
});

test("wayback: reads real CDX answers and never returns a capture after the cutoff", () => {
  const r = W.parseCdx(fixture("p1_google_2010.body"), 2010);
  assert.deepEqual(r, { ok: true, ts: "20101231191441", original: "http://www.google.com/" });
  assert.deepEqual(W.parseCdx(fixture("p1_empty_youtube_2004.body"), 2004), { ok: true, none: true });
  const leaky = JSON.stringify([["timestamp", "original"], ["20090101000000", "http://a/"], ["20110105000000", "http://a/"]]);
  assert.equal(W.parseCdx(leaky, 2010).ts, "20090101000000");
  assert.equal(W.parseCdx("<html>", 2010).ok, false);
  assert.equal(W.snapshotUrl("20090101000000", "http://a/"), "https://web.archive.org/web/20090101000000if_/http://a/");
  assert.match(W.cdxQueryUrl("http://a/", 2010), /to=20101231235959/);
  assert.match(W.cdxQueryUrl("http://a/", 2010), /filter=statuscode%3A200(&|$)/);
  assert.match(W.cdxQueryUrl("http://a/", 2010, "", { redirects: true }), /filter=statuscode%3A%5B23%5D\.\./);
});

test("wayback: lookup order page -> without query -> the site's front page; day cutoffs", () => {
  assert.deepEqual(W.candidateUrls("https://www.top40-charts.com/news.php?nid=1234"), [
    { url: "https://www.top40-charts.com/news.php?nid=1234", kind: "page" },
    { url: "https://www.top40-charts.com/news.php", kind: "noquery" },
    { url: "https://www.top40-charts.com/", kind: "site" }
  ]);
  assert.deepEqual(W.candidateUrls("https://example.com/"), [{ url: "https://example.com/", kind: "page" }]);
  assert.equal(W.cutoffTs(2005, "20051111"), "20051111235959");
  assert.equal(W.cutoffTs(2005, "20071111"), "20051231235959");          // a day after the year is ignored
  assert.equal(W.isAfterCutoff("20051112000000", 2005, "20051111"), true);
  assert.equal(W.parseFragment("#y=2005&d=20051111&u=https://www.cnn.com/").d, "20051111");
});

test("wayback: earliest capture says whether a site existed by then", () => {
  const body = JSON.parse(W.availabilityBody(["youtube.com", "google.com"]));
  assert.deepEqual(body[0], { url: "youtube.com", timestamp: "19960101" });
  const answer = W.parseAvailability(fixture("p2_avail_batch_post.body"));
  assert.equal(answer["youtube.com"], "20050428014715");
  assert.equal(W.existedBy(answer["youtube.com"], 2004), "no");
  assert.equal(W.existedBy(answer["youtube.com"], 2005), "yes");
  assert.equal(W.existedBy(answer["google.com"], 2000), "yes");
  assert.equal(W.existedBy(null, 2000), "unknown");
  const empty = W.parseAvailability(JSON.stringify({ results: [{ url: "tiktok.com", archived_snapshots: {} }] }));
  assert.equal(empty["tiktok.com"], null);                               // {} = unknown, never "did not exist"
  assert.equal(W.parseAvailability("not json"), null);
});

test("wayback: fragment keeps a raw URL with & and # intact", () => {
  const f = W.parseFragment("#y=2005&why=none&u=http://example.com/a?b=1&c=2#frag");
  assert.equal(f.y, 2005); assert.equal(f.why, "none"); assert.equal(f.u, "http://example.com/a?b=1&c=2#frag");
  assert.equal(W.parseFragment("#y=1999&u=http%3A%2F%2Fexample.com%2F").u, "http://example.com/");
});

test("wayback: limiter keeps the gap and the per-minute budget", async () => {
  let t = 0; const slept = [];
  const lim = W.createLimiter({ minGapMs: 3000, perMinute: 2, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  const order = [];
  await Promise.all([1, 2, 3].map((n) => lim.run(async () => order.push([n, t]))));
  assert.deepEqual(order.map((x) => x[0]), [1, 2, 3]);
  assert.ok(order[1][1] - order[0][1] >= 3000);
  assert.ok(order[2][1] - order[0][1] >= 60000);
});

test("google: search URL gets the rewritten query, the date cap and the Web tab", () => {
  const p = G.buildSearchUrl("https://www.google.com/search?q=music+trends+this+year&hl=en", 2010, YY.rewriteQuery);
  const u = new URL(p.target);
  assert.equal(u.searchParams.get("q"), "music trends 2010");
  assert.equal(u.searchParams.get("tbs"), "cdr:1,cd_min:1/1/1990,cd_max:12/31/2010");
  assert.equal(u.searchParams.get("udm"), "14");
  assert.equal(p.changed, true);
  const again = G.buildSearchUrl(p.target + "&sei=abc", 2010, YY.rewriteQuery);
  assert.equal(again.changed, false);                                      // stable: no reload loop
  const images = new URL(G.buildSearchUrl("https://www.google.com/search?q=cats&tbm=isch", 2005, YY.rewriteQuery).target);
  assert.equal(images.searchParams.get("udm"), null);
});

test("google: dates, leaks and cites", () => {
  assert.equal(G.dateYear("Mar 3, 2010"), 2010);
  assert.equal(G.dateYear("3 мар. 2010 г."), 2010);
  assert.equal(G.dateYear("03.03.2009"), 2009);
  assert.equal(G.dateYear("3 days ago"), 9999);
  assert.equal(G.dateYear(""), null);
  const base = { title: "Top songs", snippet: "The best songs of the year", dateText: "Dec 1, 2010", cite: "https://www.npr.org › music", path: "music" };
  assert.equal(G.leakReason(base, 2010, true), null);
  assert.match(G.leakReason({ ...base, dateText: "Jan 2, 2011" }, 2010, true), /2011/);
  assert.match(G.leakReason({ ...base, dateText: "Dec 1, 2005", snippet: "Best iPhone apps" }, 2006, true), /iphone/);
  assert.equal(G.leakReason({ ...base, snippet: "Best iPhone apps" }, 2010, true), null);
  assert.match(G.leakReason({ ...base, title: "Trends for 2024" }, 2010, true), /2024/);
  assert.equal(G.leakReason({ ...base, cite: "https://www.apple.com", path: "" }, 2010, true), null);
  assert.equal(G.isLiveHomepage({ cite: "https://www.apple.com", path: "" }), true);
  assert.equal(G.isLiveHomepage({ cite: "https://www.npr.org › music", path: "music" }), false);
  assert.equal(G.leakReason({ ...base, snippet: "Uploaded vor 1 Tag by someone" }, 2010, true), "posted recently");
  assert.equal(G.leakReason({ ...base, snippet: "OURphone mit Raspberry Pi" }, 2010, true), "mentions raspberry pi");
  assert.deepEqual(G.parseCite("https://www.npr.org › sections › therecord › 2010/12/13"), { host: "www.npr.org", path: "sections/therecord/2010/12/13" });
  assert.equal(G.parseStats("About 1,230,000 results (0.42 seconds)"), 1230000);
  assert.equal(G.parseStats("Ungefähr 1.230.000 Ergebnisse"), 1230000);
});

test("google: I'm Feeling Lucky with an empty box opens the logo page of that day", () => {
  assert.equal(G.luckyEmptyUrl("19980601"), null);                       // nothing yet: the button stays put
  assert.equal(G.luckyEmptyUrl("19991012"), null);
  assert.equal(G.luckyEmptyUrl("19991013"), "http://www.google.com/logos.html");
  assert.equal(G.luckyEmptyUrl("20051111"), "http://www.google.com/holidaylogos.html");
  assert.equal(G.luckyEmptyUrl("20100101"), "http://www.google.com/logos/");
  assert.equal(G.luckyEmptyUrl("20171111"), "http://www.google.com/doodles/");
  assert.equal(G.luckyEmptyUrl("20251111"), "https://doodles.google/");
  assert.equal(G.LUCKY_PARAM, "yylucky");
  const plan = G.buildSearchUrl("https://www.google.com/search?q=linux&yylucky=1", 2005, YY.rewriteQuery);
  assert.equal(new URL(plan.target).searchParams.get("yylucky"), "1");    // the marker survives the date cap
});

test("youtube: queries get before:, relative dates give a conservative upload year", () => {
  assert.equal(T.buildQuery("minecraft", 2010, YY.rewriteQuery), "minecraft before:2011-01-01");
  assert.equal(T.buildQuery("best music videos", 2008, YY.rewriteQuery), "best music videos 2008 before:2009-01-01");
  assert.equal(T.buildQuery("cats before:2007-01-01", 2010, YY.rewriteQuery), "cats before:2007-01-01");
  assert.equal(T.stripOperator("minecraft before:2011-01-01"), "minecraft");
  assert.equal(T.minUploadYear("15 years ago", 2026), 2010);
  assert.equal(T.minUploadYear("15 лет назад", 2026), 2010);
  assert.equal(T.minUploadYear("vor 15 Jahren", 2026), 2010);
  assert.equal(T.minUploadYear("3 months ago", 2026), 2026);
  assert.equal(T.isFuture("15 years ago", 2010, 2026), false);   // Nov 2010 - Nov 2011: could be 2010
  assert.equal(T.isFuture("14 years ago", 2010, 2026), true);
  assert.equal(T.isFuture("2 weeks ago", 2024, 2026), true);
});

test("common: era table follows the research's eras", () => {
  const eras = [[1998, "1998"], [2001, "1999"], [2003, "2002"], [2006, "2004"], [2009, "2007"], [2010, "2010"], [2013, "2011"], [2015, "2014"], [2019, "2016"], [2023, "2020"], [2025, "2024"]];
  for (const [y, e] of eras) assert.equal(YY.googleEra(y), e, `year ${y}`);
});
