// Data checks for extension/src/travel/years.json (meme, facts, gadget, searches and sites for every year)
// and its use of src/player/charts.json. No network: the image URLs are checked live by
// tests/travel/visual_check.py.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_YEAR, MAX_YEAR, checkYear, numberOne, LIMITS, SHOWN_FACTS, landingPlan, isMonthDay
} from "../../extension/src/travel/travel_core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RAW = readFileSync(join(ROOT, "extension/src/travel/years.json"), "utf8");
const YEARS = JSON.parse(RAW);
const CHARTS = JSON.parse(readFileSync(join(ROOT, "extension/src/player/charts.json"), "utf8"));
const ALL = Array.from({ length: MAX_YEAR - MIN_YEAR + 1 }, (_, i) => MIN_YEAR + i);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const keys = (o) => Object.keys(o).sort();
const texts = (e) => [e.meme.title, e.meme.blurb, e.tech.text, ...e.facts.map((f) => f.text), ...e.searches.map((s) => s.q), ...e.sites.map((s) => s.name)];

describe("years.json", () => {
  test(`has exactly the years ${MIN_YEAR}-${MAX_YEAR}`, () => {
    assert.deepEqual(Object.keys(YEARS).map(Number), ALL);
  });

  test("every entry has the schema and stays within the limits", () => {
    for (const y of ALL) assert.deepEqual(checkYear(YEARS[y], y), [], String(y));
    assert.equal(LIMITS.blurb, 90);
    assert.equal(LIMITS.fact, 80);
    assert.equal(LIMITS.facts, 6);
    assert.equal(LIMITS.searches, 6);
    assert.equal(LIMITS.sites, 6);
  });

  test("only the known fields", () => {
    for (const y of ALL) {
      const e = YEARS[y];
      assert.deepEqual(keys(e), ["facts", "meme", "searches", "sites", "tech"], String(y));
      assert.deepEqual(keys(e.meme), ["blurb", "image", "on", "source", "title"], String(y));
      assert.deepEqual(keys(e.tech), ["on", "text"], String(y));
      for (const f of e.facts) assert.deepEqual(keys(f), ["on", "text"], `${y}: ${JSON.stringify(f)}`);
      for (const s of e.searches) assert.deepEqual(keys(s), ["on", "q"], `${y}: ${JSON.stringify(s)}`);
      for (const s of e.sites) assert.deepEqual(keys(s), ["first", "name", "url"], `${y}: ${JSON.stringify(s)}`);
    }
  });

  test("every date is a real day of that year", () => {
    for (const y of ALL) {
      const e = YEARS[y];
      for (const on of [e.meme.on, e.tech.on, ...e.facts.map((f) => f.on), ...e.searches.map((s) => s.on)]) {
        assert.ok(isMonthDay(on), `${y}: ${on}`);
        if (on === "02-29") assert.ok(y % 4 === 0, `${y} has no February 29`);
      }
    }
  });

  test("images come from Wikimedia's upload server, sources from Wikipedia", () => {
    for (const y of ALL) {
      const { image, source } = YEARS[y].meme;
      assert.match(image, /^https:\/\/upload\.wikimedia\.org\/wikipedia\/(commons|en)\/\S+\.(jpe?g|png|gif|webp|svg\.png|webm\.jpg)$/i, `${y}: ${image}`);
      assert.doesNotMatch(image, /[?#]/, `${y}: no tracking parameters`);
      assert.match(source, /^https:\/\/en\.wikipedia\.org\/wiki\/[^\s?#]+$/, `${y}: ${source}`);
      assert.doesNotThrow(() => new URL(image));
    }
  });

  test("one meme per year, no repeats", () => {
    const titles = ALL.map((y) => YEARS[y].meme.title.toLowerCase());
    assert.equal(new Set(titles).size, titles.length);
    const images = ALL.map((y) => YEARS[y].meme.image);
    assert.equal(new Set(images).size, images.length);
  });

  test("the memes named in the brief sit in their year", () => {
    const expect = {
      1998: "Dancing Baby", 1999: "Hampster Dance", 2001: "All Your Base", 2004: "Numa Numa", 2007: "LOLcats",
      2008: "Rickroll", 2009: "Keyboard Cat", 2010: "Double Rainbow", 2011: "Nyan Cat", 2012: "Gangnam Style",
      2013: "Doge", 2014: "Ice Bucket", 2015: "The Dress", 2017: "Distracted Boyfriend",
      2019: "Woman Yelling at a Cat", 2020: "Coffin Dance", 2023: "Barbenheimer", 2024: "Moo Deng"
    };
    for (const [y, name] of Object.entries(expect)) assert.ok(YEARS[y].meme.title.startsWith(name), `${y}: ${YEARS[y].meme.title}`);
  });

  test("short, plain text: no long dashes, no markup, no stray whitespace, plain ASCII", () => {
    assert.doesNotMatch(RAW, /[–—]/);
    assert.doesNotMatch(RAW, /[^\x20-\x7e\n]/, "plain ASCII");
    for (const y of ALL) {
      for (const s of texts(YEARS[y])) {
        assert.equal(s, s.trim(), `${y}: ${s}`);
        assert.doesNotMatch(s, /[<>]|\s{2}/, `${y}: ${s}`);
      }
    }
  });

  test("nothing mentions a year after its own", () => {
    for (const y of ALL) {
      for (const s of texts(YEARS[y])) {
        for (const m of s.matchAll(/\b(19|20)\d{2}\b/g)) assert.ok(Number(m[0]) <= y, `${y}: ${s}`);
      }
    }
  });

  test("every fact names the day it is dated on", () => {
    for (const y of ALL) {
      for (const { text, on } of YEARS[y].facts) {
        const [month, day] = on.split("-").map(Number);
        const named = text.includes(MONTHS[month - 1]) && new RegExp(`\\b${day}\\b`).test(text);
        const numeric = text.includes(`${month}/${day}/${String(y).slice(2)}`); // "Skyrim is released on 11/11/11."
        assert.ok(named || numeric, `${y}: "${text}" is dated ${on}`);
      }
    }
  });

  test("searches: typed in lower case, no repeats within a year", () => {
    for (const y of ALL) {
      const qs = YEARS[y].searches.map((s) => s.q);
      assert.equal(new Set(qs).size, qs.length, `${y}: ${qs}`);
      for (const q of qs) assert.equal(q, q.toLowerCase(), `${y}: ${q}`);
    }
  });

  test("sites: front pages that were on the web before their year began, no repeats", () => {
    for (const y of ALL) {
      const sites = YEARS[y].sites;
      assert.equal(new Set(sites.map((s) => new URL(s.url).host.replace(/^www\./, ""))).size, sites.length, String(y));
      for (const s of sites) {
        assert.equal(new URL(s.url).pathname, "/", `${y}: ${s.url}`);
        assert.ok(s.first < `${y}0101000000`, `${y}: ${s.name} first captured ${s.first}`);
      }
    }
    assert.ok(!YEARS[2023].sites.some((s) => /chatgpt|openai/.test(s.url)), "chatgpt.com was someone else's site until 2024");
  });
});

describe("the landing card never shows the future", () => {
  // Days that cut the year in different places, a leap day included.
  const DAYS = [[1, 1], [1, 3], [1, 31], [2, 29], [3, 15], [6, 30], [7, 31], [9, 1], [11, 11], [12, 5], [12, 31]];
  const dateOf = (y, month, day) => ({ year: y, month, day: month === 2 && day === 29 && y % 4 ? 28 : day });

  test("every year on every day: facts, searches, meme and gadget are dated on or before it", () => {
    for (const y of ALL) {
      for (const [month, day] of DAYS) {
        const date = dateOf(y, month, day);
        const md = `${String(month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
        const p = landingPlan(YEARS, y, date);
        const where = `${y}-${md}`;
        assert.ok(p.facts.items.length <= SHOWN_FACTS, where);
        const pool = YEARS[p.facts.year].facts;
        for (const text of p.facts.items) {
          const fact = pool.find((f) => f.text === text);
          assert.ok(fact, `${where}: ${text}`);
          if (!p.facts.still) assert.ok(fact.on <= md, `${where}: ${text} is dated ${fact.on}`);
        }
        if (p.facts.still) assert.equal(p.facts.year, y - 1, where);
        for (const q of p.searches) assert.ok(YEARS[y].searches.find((s) => s.q === q).on <= md, `${where}: ${q}`);
        for (const [key, item] of [["meme", p.meme], ["tech", p.tech]]) {
          if (!item) { assert.equal(y, MIN_YEAR, `${where}: no ${key}`); continue; }
          if (item.still) assert.equal(item.year, y - 1, `${where}: ${key}`);
          else assert.ok(item.on <= md, `${where}: ${key} dated ${item.on}`);
        }
        assert.equal(p.sites.length, LIMITS.sites, where);
        for (const s of p.sites) assert.ok(s.path.includes(`#y=${y}&d=${y}${md.replace("-", "")}&u=`), `${where}: ${s.path}`);
      }
    }
  });

  test("every card has facts and something to search, except the first days of the first year", () => {
    for (const y of ALL) {
      for (const [month, day] of DAYS) {
        const p = landingPlan(YEARS, y, dateOf(y, month, day));
        assert.ok(p.searches.length >= 1, `${y}-${month}-${day}: searches`);
        if (y > MIN_YEAR) assert.ok(p.facts.items.length >= 1 && p.meme && p.tech, `${y}-${month}-${day}`);
      }
    }
  });

  test("November 11, 2022: no ChatGPT and no World Cup final yet (both later that year)", () => {
    const p = landingPlan(YEARS, 2022, { year: 2022, month: 11, day: 11 });
    assert.equal(p.facts.still, false);
    assert.equal(p.facts.items.length, 3);
    assert.ok(!p.facts.items.some((t) => /ChatGPT|World Cup/.test(t)), p.facts.items.join(" | "));
    assert.ok(p.facts.items.some((t) => /DART/.test(t)), "September 26 is the latest fact so far");
  });

  test("November 11: the 2004 meme (December) and the 2020 gadget (November 12) are last year's", () => {
    const p2004 = landingPlan(YEARS, 2004, { year: 2004, month: 11, day: 11 });
    assert.deepEqual([p2004.meme.title, p2004.meme.year, p2004.meme.still], [YEARS[2003].meme.title, 2003, true]);
    const p2020 = landingPlan(YEARS, 2020, { year: 2020, month: 11, day: 11 });
    assert.deepEqual([p2020.tech.text, p2020.tech.year, p2020.tech.still], [YEARS[2019].tech.text, 2019, true]);
    const p2020b = landingPlan(YEARS, 2020, { year: 2020, month: 11, day: 12 });
    assert.deepEqual([p2020b.tech.text, p2020b.tech.still], ["PlayStation 5", false]);
  });

  test("blurbs say only what was true on the meme's day", () => {
    assert.doesNotMatch(YEARS[2012].meme.blurb, /billion/i, "Gangnam Style reached a billion views on December 21");
    assert.equal(YEARS[2012].meme.on, "07-30");
    assert.doesNotMatch(YEARS[2010].meme.blurb, /hiker/i);
  });
});

describe("charts.json gives every year a number one", () => {
  test("rank 1 exists for every year", () => {
    for (const y of ALL) {
      const top = numberOne(CHARTS, y);
      assert.ok(top && top.title && top.artist, String(y));
    }
    assert.deepEqual(numberOne(CHARTS, 1999), { title: "Believe", artist: "Cher" });
    assert.deepEqual(numberOne(CHARTS, 2010), { title: "Tik Tok", artist: "Kesha" });
  });
});
