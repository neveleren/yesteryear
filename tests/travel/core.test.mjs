// Unit tests for extension/src/travel/travel_core.js: trip rules, eras, odometer drums, the timeline,
// dates and the "Today in <year>" links. No network, no browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_YEAR, MAX_YEAR, normalizeTrip, parseTravelHash, travelPath, isReusableTab, eraFor, ERAS, ROUNDED_FROM,
  odometerWheels, TIMELINE, easeTrip, yearAt, speedAt, mphAt, phaseAt, flashAt, isLeap, sameDayIn, ymd,
  weekdayOf, longDate, circuitDate, trayTime, frontPages, resolverPath, BBC_MOVE, numberOne, checkYear, LAST_KEY,
  LIMITS, SHOWN_FACTS, isMonthDay, monthDay, landingPlan, googleSearchUrl, musicLine, noPlayerText
} from "../../extension/src/travel/travel_core.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

describe("trip", () => {
  test("a normal trip back and forward", () => {
    assert.deepEqual(normalizeTrip(2026, 1999, 2026), { from: 2026, to: 1999, direction: "back" });
    assert.deepEqual(normalizeTrip(1999, 2010, 2026), { from: 1999, to: 2010, direction: "forward" });
  });

  test("the destination must be a year the time machine knows", () => {
    assert.equal(normalizeTrip(2026, MIN_YEAR - 1, 2026), null);
    assert.equal(normalizeTrip(2026, MAX_YEAR + 1, 2026), null);
    assert.equal(normalizeTrip(2026, "abc", 2026), null);
    assert.equal(normalizeTrip(2026, undefined, 2026), null);
    assert.equal(normalizeTrip(2026, 2005, NaN), null);
    assert.deepEqual(normalizeTrip(2026, "2005", 2026), { from: 2026, to: 2005, direction: "back" });
    assert.equal(normalizeTrip(2026, 2004.6, 2026).to, 2005);
  });

  test("a missing or impossible departure year means the present", () => {
    assert.equal(normalizeTrip(undefined, 2001, 2026).from, 2026);
    assert.equal(normalizeTrip(NaN, 2001, 2026).from, 2026);
    assert.equal(normalizeTrip(1900, 2001, 2026).from, 2026);
    assert.equal(normalizeTrip(2099, 2001, 2026).from, 2026);
  });

  test("travelling to the year you are in starts from the present again", () => {
    assert.deepEqual(normalizeTrip(2010, 2010, 2026), { from: 2026, to: 2010, direction: "back" });
  });

  test("hash round trip", () => {
    assert.equal(travelPath({ from: 2026, to: 1999 }), "src/travel/travel.html#from=2026&to=1999");
    assert.equal(travelPath({ from: 2026, to: 1999, sound: false }), "src/travel/travel.html#from=2026&to=1999&sound=0");
    assert.equal(travelPath({ from: 2026, to: 1999, nonce: "mhty3k00" }), "src/travel/travel.html#from=2026&to=1999&t=mhty3k00");
    assert.equal(travelPath({ from: 2026, to: 1999, nonce: "bad nonce!" }), "src/travel/travel.html#from=2026&to=1999");
    assert.deepEqual(parseTravelHash("#from=2026&to=1999"), { from: 2026, to: 1999, sound: true, t: "" });
    assert.deepEqual(parseTravelHash("from=2010&to=2005&sound=0&t=abc123"), { from: 2010, to: 2005, sound: false, t: "abc123" });
    assert.equal(parseTravelHash("#from=2010&to=2005&t=<script>").t, "");
    const empty = parseTravelHash("");
    assert.ok(Number.isNaN(empty.from) && Number.isNaN(empty.to) && empty.sound === true && empty.t === "");
    const path = travelPath({ from: 2001, to: 2023, sound: false, nonce: "z9" });
    const parsed = parseTravelHash(path.slice(path.indexOf("#")));
    assert.equal(parsed.t, "z9");
    assert.deepEqual(normalizeTrip(parsed.from, parsed.to, 2026), { from: 2001, to: 2023, direction: "forward" });
  });

  test("tabs a trip may take over", () => {
    const origin = "chrome-extension://abc";
    for (const url of ["", "about:blank", "chrome://newtab/", "chrome://new-tab-page/", "chrome-search://local-ntp/local-ntp.html",
      `${origin}/src/travel/travel.html#from=2026&to=1999`]) {
      assert.equal(isReusableTab(url, origin), true, url);
    }
    for (const url of ["https://www.google.com/", "chrome://extensions/", `${origin}/src/ui/popup.html`, "https://example.com/newtab"]) {
      assert.equal(isReusableTab(url, origin), false, url);
    }
    assert.equal(isReusableTab(`${origin}/src/travel/travel.html`, ""), false);
  });

  test("storage key carries the module prefix", () => {
    assert.equal(LAST_KEY, "travel:last");
  });
});

describe("eras", () => {
  test("boundaries", () => {
    const expect = { 1998: "win98", 2001: "win98", 2002: "xp", 2006: "xp", 2007: "aero", 2012: "aero", 2013: "flat", 2025: "flat" };
    for (const [year, era] of Object.entries(expect)) assert.equal(eraFor(Number(year)), era, year);
  });

  test("every year has exactly one era and eras only move forward", () => {
    let last = -1;
    for (let y = MIN_YEAR; y <= MAX_YEAR; y++) {
      const i = ERAS.findIndex((e) => e.id === eraFor(y));
      assert.ok(i >= last, `${y}`);
      last = i;
    }
    assert.equal(last, ERAS.length - 1);
    assert.ok(ROUNDED_FROM > ERAS.at(-1).from && ROUNDED_FROM <= MAX_YEAR);
  });
});

describe("odometer", () => {
  test("whole years show their digits", () => {
    assert.deepEqual(odometerWheels(1999), [1, 9, 9, 9]);
    assert.deepEqual(odometerWheels(2026), [2, 0, 2, 6]);
    assert.deepEqual(odometerWheels(2000), [2, 0, 0, 0]);
  });

  test("a drum turns only while every drum to its right rolls from 9 to 0", () => {
    const w = odometerWheels(1999.5);
    assert.ok([1.5, 9.5, 9.5, 9.5].every((v, i) => near(v, w[i])), String(w));
    const v = odometerWheels(2009.25);
    assert.ok([2, 0, 0.25, 9.25].every((x, i) => near(x, v[i])), String(v));
    const u = odometerWheels(2010.5);
    assert.ok([2, 0, 1, 0.5].every((x, i) => near(x, u[i])), String(u));
  });

  test("positions stay in [0, 10) and move continuously along a whole trip", () => {
    let prev = null;
    for (let ms = 0; ms <= TIMELINE.flash; ms += 4) {
      const pos = odometerWheels(yearAt(ms, 2026, 1998));
      for (const p of pos) assert.ok(p >= 0 && p < 10, `${ms}: ${pos}`);
      if (prev) {
        for (let i = 0; i < 4; i++) {
          const d = Math.abs(pos[i] - prev[i]);
          assert.ok(Math.min(d, 10 - d) < 1.2, `drum ${i} jumped at ${ms} ms: ${prev[i]} -> ${pos[i]}`);
        }
      }
      prev = pos;
    }
  });
});

describe("timeline", () => {
  test("phases come in order and cover the whole trip", () => {
    const seen = [];
    for (let ms = 0; ms <= TIMELINE.done + 100; ms += 10) {
      const p = phaseAt(ms);
      if (seen.at(-1) !== p) seen.push(p);
    }
    assert.deepEqual(seen, ["intro", "roll", "lock", "flash", "crt", "done"]);
    assert.ok(TIMELINE.done >= 4000 && TIMELINE.done <= 6000, "the trip lasts 4 to 6 seconds");
  });

  test("easing: starts at 0, ends at 1, never runs backwards", () => {
    assert.equal(easeTrip(0), 0);
    assert.equal(easeTrip(1), 1);
    assert.equal(easeTrip(-3), 0);
    assert.equal(easeTrip(7), 1);
    let last = 0;
    for (let t = 0; t <= 1; t += 0.01) {
      const e = easeTrip(t);
      assert.ok(e >= last - 1e-12);
      last = e;
    }
  });

  test("the odometer reads the departure year, then the destination", () => {
    assert.equal(yearAt(0, 2026, 1999), 2026);
    assert.equal(yearAt(TIMELINE.rollStart, 2026, 1999), 2026);
    assert.equal(yearAt(TIMELINE.rollEnd, 2026, 1999), 1999);
    assert.equal(yearAt(TIMELINE.done, 2026, 1999), 1999);
    const mid = yearAt((TIMELINE.rollStart + TIMELINE.rollEnd) / 2, 1999, 2011);
    assert.ok(near(mid, 2005), String(mid));
  });

  test("warp speed and MPH climb to their peak at the flash: 88 MPH", () => {
    let s = 0, m = 0;
    for (let ms = 0; ms <= TIMELINE.flash; ms += 25) {
      assert.ok(speedAt(ms) >= s && mphAt(ms) >= m, `${ms}`);
      s = speedAt(ms);
      m = mphAt(ms);
    }
    assert.equal(speedAt(TIMELINE.flash), 1);
    assert.equal(mphAt(TIMELINE.flash), 88);
    assert.equal(mphAt(0), 0);
    assert.ok(speedAt(0) > 0 && speedAt(0) < 0.1);
  });

  test("one white flash: up, hold, down, never twice", () => {
    assert.equal(flashAt(0), 0);
    assert.equal(flashAt(TIMELINE.flash + 50), 1);
    assert.equal(flashAt(TIMELINE.done), 0);
    let rising = true, peaks = 0, last = 0;
    for (let ms = 0; ms <= TIMELINE.done; ms += 5) {
      const f = flashAt(ms);
      assert.ok(f >= 0 && f <= 1);
      if (rising && f < last) { rising = false; peaks += 1; }
      if (!rising) assert.ok(f <= last + 1e-12, `the flash comes back at ${ms}`);
      last = f;
    }
    assert.equal(peaks, 1);
  });
});

describe("dates", () => {
  test("leap years", () => {
    for (const y of [2000, 2004, 2024]) assert.equal(isLeap(y), true, y);
    for (const y of [1999, 2001, 2100, 2025]) assert.equal(isLeap(y), false, y);
  });

  test("today's day, moved into the destination year", () => {
    const nov11 = new Date(2026, 10, 11, 15, 30);
    assert.deepEqual(sameDayIn(1999, nov11), { year: 1999, month: 11, day: 11 });
    const feb29 = new Date(2028, 1, 29, 12);
    assert.deepEqual(sameDayIn(2001, feb29), { year: 2001, month: 2, day: 28 });
    assert.deepEqual(sameDayIn(2004, feb29), { year: 2004, month: 2, day: 29 });
    assert.equal(ymd({ year: 2005, month: 3, day: 7 }), "20050307");
  });

  test("weekdays and the long date", () => {
    assert.equal(weekdayOf({ year: 1999, month: 11, day: 11 }), "Thursday");
    assert.equal(weekdayOf({ year: 2000, month: 1, day: 1 }), "Saturday");
    assert.equal(longDate({ year: 1999, month: 11, day: 11 }), "Thursday, November 11, 1999");
    assert.equal(circuitDate({ year: 2026, month: 11, day: 1 }), "NOV 01 2026");
  });

  test("tray clock", () => {
    assert.equal(trayTime(new Date(2026, 0, 1, 0, 5)), "12:05 AM");
    assert.equal(trayTime(new Date(2026, 0, 1, 12, 0)), "12:00 PM");
    assert.equal(trayTime(new Date(2026, 0, 1, 16, 7)), "4:07 PM");
  });
});

describe("Today in <year>", () => {
  test("three front pages through the Wayback resolver, u= last", () => {
    const pages = frontPages({ year: 2005, month: 11, day: 11 });
    assert.deepEqual(pages.map((p) => p.label), ["CNN", "BBC News", "The New York Times"]);
    assert.equal(pages[0].path, "src/wayback/resolve.html#y=2005&d=20051111&u=http://www.cnn.com/");
    for (const p of pages) assert.match(p.path, /^src\/wayback\/resolve\.html#y=2005&d=20051111&u=https?:\/\/\S+$/);
    assert.equal(resolverPath(1999, "19991111", "http://x.test/?a=1&b=2"), "src/wayback/resolve.html#y=1999&d=19991111&u=http://x.test/?a=1&b=2");
  });

  test("BBC News address before and after its move on 14 July 2010", () => {
    const bbc = (year, month, day) => frontPages({ year, month, day }).find((p) => p.id === "bbc").url;
    assert.equal(BBC_MOVE, "20100714");
    assert.equal(bbc(1999, 11, 11), "http://news.bbc.co.uk/");
    assert.equal(bbc(2010, 7, 13), "http://news.bbc.co.uk/");
    assert.equal(bbc(2010, 7, 14), "https://www.bbc.co.uk/news");
    assert.equal(bbc(2023, 11, 11), "https://www.bbc.co.uk/news");
  });
});

describe("data helpers", () => {
  const charts = {
    "1999": [{ rank: 2, title: "No Scrubs", artist: "TLC" }, { rank: 1, title: "Believe", artist: "Cher" }],
    "2000": [{ rank: 1, title: "", artist: "x" }]
  };

  test("number one of the year", () => {
    assert.deepEqual(numberOne(charts, 1999), { title: "Believe", artist: "Cher" });
    assert.equal(numberOne(charts, 2000), null);
    assert.equal(numberOne(charts, 1998), null);
    assert.equal(numberOne(null, 1999), null);
  });

  test("checkYear spots broken entries", () => {
    const ons = ["01-05", "02-01", "03-01", "06-30", "09-09", "12-31"];
    const good = {
      meme: { title: "T", blurb: "B", image: "https://upload.wikimedia.org/x.png", source: "https://en.wikipedia.org/wiki/X", on: "02-09" },
      facts: ons.map((on, i) => ({ text: `Fact ${i}`, on })),
      tech: { text: "Gadget", on: "01-01" },
      searches: ons.map((on, i) => ({ q: `query ${i}`, on })),
      sites: ons.map((_, i) => ({ name: `Site ${i}`, url: `http://www.site${i}.com/`, first: "19961017235908" }))
    };
    assert.deepEqual(checkYear(good), []);
    assert.deepEqual(checkYear(good, 1999), []);
    assert.deepEqual(checkYear(good, 1996), ["sites[0]", "sites[1]", "sites[2]", "sites[3]", "sites[4]", "sites[5]"], "a site must predate its year");
    assert.deepEqual(checkYear({ ...good, facts: good.facts.slice(1) }), ["facts"]);
    assert.deepEqual(checkYear({ ...good, facts: [...good.facts.slice(0, 5), { text: "y".repeat(81), on: "12-31" }] }), ["facts[5]"]);
    assert.deepEqual(checkYear({ ...good, facts: [good.facts[1], good.facts[0], ...good.facts.slice(2)] }), ["facts order"]);
    assert.deepEqual(checkYear({ ...good, facts: ["a", "b", "c", "d", "e", "f"] }), ["facts[0]", "facts[1]", "facts[2]", "facts[3]", "facts[4]", "facts[5]"], "plain strings are the old schema");
    assert.deepEqual(checkYear({ ...good, tech: "Gadget" }), ["tech"]);
    assert.deepEqual(checkYear({ ...good, tech: { text: "Gadget", on: "13-01" } }), ["tech.on"]);
    assert.deepEqual(checkYear({ ...good, meme: { ...good.meme, on: undefined } }), ["meme.on"]);
    assert.deepEqual(checkYear({ ...good, meme: { ...good.meme, blurb: "x".repeat(91) } }), ["meme.blurb"]);
    assert.deepEqual(checkYear({ ...good, meme: { ...good.meme, image: "http://upload.wikimedia.org/x.png" } }), ["meme.image"]);
    assert.deepEqual(checkYear({ ...good, searches: [{ q: "Titanic", on: "01-01" }, ...good.searches.slice(1)] }), ["searches[0]"], "queries are typed in lower case");
    assert.deepEqual(checkYear({ ...good, sites: [{ ...good.sites[0], url: "http://www.site.com/page" }, ...good.sites.slice(1)] }), ["sites[0]"], "front pages only");
    assert.deepEqual(checkYear(null), ["meme missing"]);
    assert.equal(LIMITS.facts, 6);
    assert.equal(SHOWN_FACTS, 3);
  });
});

describe("dates inside a year (MM-DD)", () => {
  test("valid month-days, leap day included", () => {
    for (const v of ["01-01", "02-29", "04-30", "12-31"]) assert.equal(isMonthDay(v), true, v);
    for (const v of ["", "1-01", "00-10", "13-01", "02-30", "04-31", "12-32", "11/11", null, 1111]) assert.equal(isMonthDay(v), false, String(v));
    assert.equal(monthDay({ year: 1999, month: 3, day: 7 }), "03-07");
    assert.ok("01-31" < "02-01" && "09-30" < "10-01", "string order is date order");
  });
});

describe("what the landing card shows", () => {
  const meme = (title, on) => ({ title, blurb: "b", image: "https://upload.wikimedia.org/x.png", source: "https://en.wikipedia.org/wiki/X", on });
  const YEARS = {
    2003: {
      meme: meme("Old meme", "09-02"),
      facts: [{ text: "A (May 30).", on: "05-30" }, { text: "B (August 29).", on: "08-29" }, { text: "C (October 24).", on: "10-24" }, { text: "D (December 17).", on: "12-17" }],
      tech: { text: "Old gadget", on: "02-14" }
    },
    2004: {
      meme: meme("New meme", "12-06"),
      // Out of order on purpose: the card goes by date, not by file order.
      facts: [{ text: "Rovers (January 25).", on: "01-25" }, { text: "Facebook (February 4).", on: "02-04" }, { text: "Gmail (April 1).", on: "04-01" },
        { text: "Firefox (November 9).", on: "11-09" }, { text: "Euro (July 4).", on: "07-04" }, { text: "Space (June 21).", on: "06-21" }],
      tech: { text: "New gadget", on: "02-20" },
      searches: [{ q: "britney spears", on: "01-01" }, { q: "late one", on: "12-01" }, { q: "ipod", on: "01-01" }],
      sites: [{ name: "MySpace", url: "http://www.myspace.com/", first: "19961221000000" }, { name: "Broken", url: "javascript:alert(1)" }]
    }
  };
  const on = (year, month, day) => landingPlan(YEARS, year, { year, month, day });

  test("the latest three facts up to the card's day, in date order", () => {
    const p = on(2004, 11, 11);
    assert.deepEqual(p.facts, { year: 2004, still: false, items: ["Space (June 21).", "Euro (July 4).", "Firefox (November 9)."] });
    assert.deepEqual(on(2004, 11, 8).facts.items, ["Gmail (April 1).", "Space (June 21).", "Euro (July 4)."], "November 9 is still to come");
    assert.deepEqual(on(2004, 2, 4).facts.items, ["Rovers (January 25).", "Facebook (February 4)."], "a fact of the card's own day counts");
  });

  test("before the first fact of the year: last year's latest, marked as looking back", () => {
    assert.deepEqual(on(2004, 1, 3).facts, { year: 2003, still: true, items: ["B (August 29).", "C (October 24).", "D (December 17)."] });
    assert.deepEqual(on(2003, 1, 3).facts, { year: 2003, still: false, items: [] }, "no data for 2002: nothing");
  });

  test("a meme or gadget still to come gives way to last year's, never the future one", () => {
    const nov = on(2004, 11, 11);
    assert.equal(nov.meme.title, "Old meme");
    assert.deepEqual([nov.meme.year, nov.meme.still], [2003, true]);
    assert.deepEqual([nov.tech.text, nov.tech.year, nov.tech.still], ["New gadget", 2004, false]);
    const dec = on(2004, 12, 6);
    assert.deepEqual([dec.meme.title, dec.meme.still], ["New meme", false]);
    const feb = on(2004, 2, 19);
    assert.deepEqual([feb.tech.text, feb.tech.year, feb.tech.still], ["Old gadget", 2003, true]);
    assert.equal(on(2003, 9, 1).meme, null, "no meme yet and no year before it");
    assert.equal(on(2003, 2, 13).tech, null);
  });

  test("searches already searched by that day, sites through the resolver of that day", () => {
    const p = on(2004, 11, 11);
    assert.deepEqual(p.searches, ["britney spears", "ipod"]);
    assert.deepEqual(on(2004, 12, 1).searches, ["britney spears", "late one", "ipod"]);
    assert.deepEqual(p.sites, [{ name: "MySpace", url: "http://www.myspace.com/", path: "src/wayback/resolve.html#y=2004&d=20041111&u=http://www.myspace.com/" }]);
    assert.deepEqual(on(2003, 6, 1).searches, []);
    assert.deepEqual(on(2003, 6, 1).sites, []);
  });

  test("no data at all: an empty plan, no crash", () => {
    const p = landingPlan(null, 2010, { year: 2010, month: 5, day: 5 });
    assert.deepEqual(p, { meme: null, tech: null, facts: { year: 2010, still: false, items: [] }, searches: [], sites: [] });
  });

  test("Google search address for a query", () => {
    assert.equal(googleSearchUrl("dawson's creek"), "https://www.google.com/search?q=dawson%27s+creek");
    assert.equal(googleSearchUrl("google+"), "https://www.google.com/search?q=google%2B");
    assert.equal(new URL(googleSearchUrl("the queen's gambit")).searchParams.get("q"), "the queen's gambit");
  });
});

describe("Play the hits: the card's music line", () => {
  const base = { playing: true, loading: false, year: 1999, track: { artist: "Cher", title: "Believe", rank: 1 }, status: "", problem: false };

  test("never says Now playing while the song is still being looked up", () => {
    assert.equal(musicLine({ ...base, loading: true, status: "Searching..." }, 1999), 'Starting Cher - "Believe"...');
    assert.equal(musicLine({ ...base, loading: true, track: null }, 1999), "Starting the hits of 1999...");
    assert.equal(musicLine(base, 1999), 'Now playing: Cher - "Believe"');
    assert.equal(musicLine({ ...base, track: null }, 1999), "Now playing: the hits of 1999.");
  });

  test("a failure, another year or a pause shows as such", () => {
    const slow = "YouTube asked us to slow down. Try again later.";
    assert.equal(musicLine({ ...base, playing: false, problem: true, status: slow }, 1999), slow);
    assert.equal(musicLine({ ...base, playing: false, problem: true, status: "" }, 1999), "The music stopped.");
    assert.equal(musicLine({ ...base, year: 2005 }, 1999), "The player is on 2005 now.");
    assert.equal(musicLine({ ...base, playing: false }, 1999), "Paused.");
    assert.equal(musicLine(null, 1999), "Starting the hits of 1999...");
  });

  test("the fallback names controls the popup has (no 'Music of <year>...' button since v0.2)", () => {
    assert.equal(noPlayerText(1999), 'Click the Yesteryear button, then Play under "Music of 1999".');
    assert.doesNotMatch(noPlayerText(1999), /Music of 1999\.\.\./);
  });
});
