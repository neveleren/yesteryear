// Unit tests for extension/src/ui/logic.js (pure helpers of the popup and the badge). No network.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as L from "../../extension/src/ui/logic.js";
import * as stateSw from "../../extension/src/shared/state_sw.js";

const YY = createRequire(import.meta.url)("../../extension/src/shared/common.js");

// In-memory chrome.storage.local, enough for state_sw.setState()/getState().
function fakeStorageChrome() {
  const store = {};
  return {
    store,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const k of [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]);
            return out;
          },
          async set(patch) { Object.assign(store, structuredClone(patch)); }
        }
      }
    }
  };
}

describe("year range and defaults", () => {
  test("come from the integrator's state module and match common.js", () => {
    assert.equal(L.MIN_YEAR, 1998);
    assert.equal(L.MAX_YEAR, 2025);
    assert.equal(L.MIN_YEAR, stateSw.MIN_YEAR);
    assert.equal(L.MAX_YEAR, stateSw.MAX_YEAR);
    assert.equal(L.MIN_YEAR, YY.MIN_YEAR);
    assert.equal(L.MAX_YEAR, YY.MAX_YEAR);
    assert.deepEqual({ ...L.DEFAULTS }, { ...YY.DEFAULTS });
  });

  test("every popup toggle is a boolean state key", () => {
    for (const key of L.TOGGLE_KEYS) assert.equal(typeof L.DEFAULTS[key], "boolean", key);
    assert.deepEqual([...L.TOGGLE_KEYS], ["enabled", "google", "youtube", "strict", "eraLook"]);
  });
});

describe("clampYear", () => {
  test("keeps years in range and rounds", () => {
    assert.equal(L.clampYear(2010), 2010);
    assert.equal(L.clampYear(1998), 1998);
    assert.equal(L.clampYear(2025), 2025);
    assert.equal(L.clampYear(2010.4), 2010);
    assert.equal(L.clampYear(2010.5), 2011);
    assert.equal(L.clampYear("2005"), 2005);
  });

  test("clamps to 1998..2025", () => {
    assert.equal(L.clampYear(1990), 1998);
    assert.equal(L.clampYear(0), 1998);
    assert.equal(L.clampYear(-5000), 1998);
    assert.equal(L.clampYear(2026), 2025);
    assert.equal(L.clampYear(1e9), 2025);
  });

  test("falls back to the default year for non-numbers", () => {
    for (const v of [undefined, NaN, "abc", {}, Infinity, -Infinity]) {
      assert.equal(L.clampYear(v), L.DEFAULTS.year, String(v));
    }
  });

  test("gives exactly what state_sw.setState() stores, for any input", async () => {
    const saved = globalThis.chrome;
    const { chrome } = fakeStorageChrome();
    globalThis.chrome = chrome;
    try {
      const inputs = [2010, 1998, 2025, 1997, 2026, 2010.49, 2010.5, 1997.5, "2003", "2003.6", " 2004 ", "",
        "abc", null, undefined, NaN, Infinity, -Infinity, true, false, [], [2001], {}, 1e9, -1, 0];
      for (const input of inputs) {
        const stored = await stateSw.setState({ year: input });
        assert.equal(L.clampYear(input), stored.year, `input ${JSON.stringify(input)} (${typeof input})`);
      }
    } finally {
      globalThis.chrome = saved;
    }
  });
});

describe("stepYear (spin buttons)", () => {
  test("steps one year and stops at the ends", () => {
    assert.equal(L.stepYear(2010, 1), 2011);
    assert.equal(L.stepYear(2010, -1), 2009);
    assert.equal(L.stepYear(2025, 1), 2025);
    assert.equal(L.stepYear(1998, -1), 1998);
  });

  test("clamps a bad start year first and ignores bad deltas", () => {
    assert.equal(L.stepYear(3000, -1), 2024);
    assert.equal(L.stepYear(1900, 1), 1999);
    assert.equal(L.stepYear(2010, "x"), 2010);
    assert.equal(L.stepYear(2010, 1.9), 2011);
  });
});

describe("normalizeState", () => {
  test("fills defaults and keeps only the state keys", () => {
    assert.deepEqual(L.normalizeState({}), { ...L.DEFAULTS });
    assert.deepEqual(L.normalizeState(null), { ...L.DEFAULTS });
    const s = L.normalizeState({ enabled: true, year: 1999, "wb:cache": 1 });
    assert.equal(s.enabled, true);
    assert.equal(s.year, 1999);
    assert.equal("wb:cache" in s, false);
    assert.deepEqual(Object.keys(s).sort(), Object.keys(L.DEFAULTS).sort());
  });

  test("coerces booleans and clamps the year", () => {
    const s = L.normalizeState({ enabled: 1, google: 0, youtube: "", strict: "yes", year: 2099 });
    assert.equal(s.enabled, true);
    assert.equal(s.google, false);
    assert.equal(s.youtube, false);
    assert.equal(s.strict, true);
    assert.equal(s.year, 2025);
  });

  test("treats a removed key (undefined) as its default", () => {
    const s = L.normalizeState({ google: undefined, year: undefined });
    assert.equal(s.google, L.DEFAULTS.google);
    assert.equal(s.year, L.DEFAULTS.year);
  });
});

describe("quick-year (decade) buttons", () => {
  test("are 1999, 2005, 2010, 2015, 2020 and all inside the allowed range", () => {
    assert.deepEqual([...L.QUICK_YEARS], [1999, 2005, 2010, 2015, 2020]);
    const buttons = L.quickYearButtons(2010);
    assert.deepEqual(buttons.map((b) => b.year), [1999, 2005, 2010, 2015, 2020]);
    assert.deepEqual(buttons.map((b) => b.label), ["1999", "2005", "2010", "2015", "2020"]);
    for (const b of buttons) assert.ok(b.year >= L.MIN_YEAR && b.year <= L.MAX_YEAR);
  });

  test("exactly the button of the current year is pressed", () => {
    for (const y of L.QUICK_YEARS) {
      const pressed = L.quickYearButtons(y).filter((b) => b.pressed).map((b) => b.year);
      assert.deepEqual(pressed, [y]);
    }
    assert.deepEqual(L.quickYearButtons(2011).filter((b) => b.pressed), []);
    assert.deepEqual(L.quickYearButtons("2020").filter((b) => b.pressed).map((b) => b.year), [2020]);
  });

  test("compare against the clamped year", () => {
    assert.deepEqual(L.quickYearButtons(1990).filter((b) => b.pressed), []); // 1998, not a quick year
    assert.deepEqual(L.quickYearButtons(2020.2).filter((b) => b.pressed).map((b) => b.year), [2020]);
  });
});

describe("7-segment LCD", () => {
  test("digit segments match the standard table", () => {
    const table = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg" };
    for (const [digit, segs] of Object.entries(table)) assert.equal(L.segmentsFor(digit), segs, digit);
    assert.equal(L.segmentsFor(7), "abc"); // numbers work too
  });

  test("every digit is distinct and uses only known segment ids", () => {
    const seen = new Set();
    for (let d = 0; d <= 9; d++) {
      const s = L.segmentsFor(String(d));
      for (const id of s) assert.ok(L.SEGMENT_IDS.includes(id), `${d}: ${id}`);
      assert.ok(!seen.has(s), `duplicate pattern for ${d}`);
      seen.add(s);
    }
  });

  test("unknown characters are blank; '-' is the middle bar", () => {
    assert.equal(L.segmentsFor("x"), "");
    assert.equal(L.segmentsFor(""), "");
    assert.equal(L.segmentsFor("toString"), "");
    assert.equal(L.segmentsFor("-"), "g");
    assert.equal(L.segmentsFor(" "), "");
  });

  test("lcdDigits shows the clamped year as four characters", () => {
    assert.deepEqual(L.lcdDigits(2010), ["2", "0", "1", "0"]);
    assert.deepEqual(L.lcdDigits(1998), ["1", "9", "9", "8"]);
    assert.deepEqual(L.lcdDigits(3000), ["2", "0", "2", "5"]);
    assert.deepEqual(L.lcdDigits("junk"), ["2", "0", "1", "0"]);
  });
});

describe("text formatting", () => {
  test("music button label", () => {
    assert.equal(L.musicLabel(2010), "Music of 2010...");
    assert.equal(L.musicLabel("1999"), "Music of 1999...");
    assert.equal(L.musicLabel(2077), "Music of 2025...");
  });

  test("badge: the year on navy while ON, grey OFF while OFF", () => {
    assert.deepEqual(L.badgeFor({ enabled: true, year: 2010 }), { text: "2010", background: "#000080", textColor: "#FFFFFF" });
    assert.deepEqual(L.badgeFor({ enabled: false, year: 2010 }), { text: "OFF", background: "#808080", textColor: "#FFFFFF" });
    assert.equal(L.badgeFor({}).text, "OFF"); // default is OFF
    assert.equal(L.badgeFor({ enabled: true, year: 1850 }).text, "1998");
    for (let y = L.MIN_YEAR; y <= L.MAX_YEAR; y++) {
      assert.ok(L.badgeFor({ enabled: true, year: y }).text.length <= 4, "badge text fits in 4 characters");
    }
  });

  test("tooltip and status bar", () => {
    assert.equal(L.titleFor({ enabled: true, year: 2005 }), "Yesteryear: ON, it is 2005");
    assert.equal(L.titleFor({ enabled: false, year: 2005 }), "Yesteryear: OFF (year set to 2005)");
    assert.equal(L.statusText({ enabled: true, year: 2015 }), "ON: it is 2015");
    assert.equal(L.statusText({ enabled: false }), "OFF: you are in the present");
  });

  test("sites field", () => {
    assert.equal(L.sitesText({ google: true, youtube: true }), "Google + YouTube");
    assert.equal(L.sitesText({ google: true, youtube: false }), "Google only");
    assert.equal(L.sitesText({ google: false, youtube: true }), "YouTube only");
    assert.equal(L.sitesText({ google: false, youtube: false }), "No site selected");
  });

  test("notes: YouTube before 2005, and no site ticked", () => {
    assert.equal(L.noteFor({ youtube: true, year: 1999 }), "YouTube did not exist yet in 1999 (first video: April 2005).");
    assert.equal(L.noteFor({ youtube: true, year: 2004 }).startsWith("YouTube did not exist yet in 2004"), true);
    assert.equal(L.noteFor({ youtube: true, year: 2005 }), "");
    assert.equal(L.noteFor({ youtube: false, year: 1999 }), "");
    assert.equal(L.noteFor({ enabled: true, google: false, youtube: false, year: 2010 }), "Tick Google or YouTube to travel back.");
    assert.equal(L.noteFor({ enabled: false, google: false, youtube: false, year: 2010 }), "");
  });

  test("no long dashes in any UI text (house style)", () => {
    const samples = [];
    for (let y = L.MIN_YEAR; y <= L.MAX_YEAR; y++) {
      for (const enabled of [true, false]) {
        for (const [google, youtube] of [[true, true], [true, false], [false, true], [false, false]]) {
          const s = { enabled, google, youtube, year: y };
          samples.push(L.musicLabel(y), L.titleFor(s), L.statusText(s), L.sitesText(s), L.noteFor(s), L.badgeFor(s).text);
        }
      }
    }
    for (const text of samples) assert.doesNotMatch(text, /[–—]/, text);
  });
});

describe("departureYear (where a trip from the popup starts)", () => {
  test("OFF: the present, whatever year is set (Google and YouTube are in the present)", () => {
    assert.equal(L.departureYear({ enabled: false, year: 1999 }, 2026), 2026);
    assert.equal(L.departureYear({ enabled: false, year: 2005 }, 2026), 2026);
    assert.equal(L.departureYear({ year: 2015 }, 2026), 2026); // the default is OFF
    assert.equal(L.departureYear(null, 2026), 2026);
  });

  test("ON: the saved year, where Google and YouTube are right now", () => {
    assert.equal(L.departureYear({ enabled: true, year: 2015 }, 2026), 2015);
    assert.equal(L.departureYear({ enabled: true, year: 1998 }, 2026), 1998);
    assert.equal(L.departureYear({ enabled: 1, year: "2003" }, 2026), 2003); // read like the stored state
    assert.equal(L.departureYear({ enabled: true, year: 1850 }, 2026), 1998); // clamped like the stored state
  });

  test("never looks at the year of an earlier trip", () => {
    // travel:last is the travel module's key, not a state key: an OFF state with an old trip departs now.
    assert.equal(L.departureYear({ enabled: false, year: 2005, "travel:last": 1999 }, 2026), 2026);
    assert.equal(L.departureYear({ enabled: true, year: 2015, "travel:last": 1999 }, 2026), 2015);
  });
});

describe("debounce (year saving)", () => {
  test("runs once with the latest value after the quiet period", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const d = L.debounce((v) => calls.push(v), 300);
    d.schedule(2011);
    t.mock.timers.tick(200);
    d.schedule(2012);
    t.mock.timers.tick(200);
    d.schedule(2013);
    assert.equal(d.pending, true);
    t.mock.timers.tick(299);
    assert.deepEqual(calls, []);
    t.mock.timers.tick(1);
    assert.deepEqual(calls, [2013]);
    assert.equal(d.pending, false);
    t.mock.timers.tick(1000);
    assert.deepEqual(calls, [2013]);
  });

  test("flush runs a pending call at once, and only once", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const d = L.debounce((v) => calls.push(v), 300);
    d.flush(); // nothing pending: no call
    assert.deepEqual(calls, []);
    d.schedule(1999);
    d.flush();
    assert.deepEqual(calls, [1999]);
    t.mock.timers.tick(1000);
    d.flush();
    assert.deepEqual(calls, [1999]);
  });

  test("cancel drops a pending call", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fn = mock.fn();
    const d = L.debounce(fn, 300);
    d.schedule(2000);
    d.cancel();
    t.mock.timers.tick(1000);
    assert.equal(fn.mock.callCount(), 0);
    assert.equal(d.pending, false);
  });
});
