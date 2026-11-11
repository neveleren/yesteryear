// Unit tests for extension/src/ui/sw_ui.js (toolbar badge + side panel behaviour) against a fake
// chrome.* API. No network, no browser.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initUI, refreshBadge } from "../../extension/src/ui/sw_ui.js";

// Records every chrome.action call; storage.local.get can be delayed per call to test races.
function makeFakeChrome({ store = {}, withTextColor = true, panelBehavior = "ok" } = {}) {
  const calls = [];
  const listeners = { storage: [], startup: [] };
  const getDelays = []; // queue of promises the next get() calls wait for
  const fake = {
    calls,
    listeners,
    store,
    getDelays,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const snapshot = {};
            for (const k of [].concat(keys)) if (k in store) snapshot[k] = store[k];
            const delay = getDelays.shift();
            if (delay) await delay;
            return snapshot;
          },
          async set(patch) { Object.assign(store, patch); }
        },
        onChanged: { addListener: (fn) => listeners.storage.push(fn) }
      },
      runtime: { onStartup: { addListener: (fn) => listeners.startup.push(fn) } },
      action: {
        setBadgeText: async (d) => { calls.push(["text", d.text]); },
        setBadgeBackgroundColor: async (d) => { calls.push(["bg", d.color]); },
        setTitle: async (d) => { calls.push(["title", d.title]); }
      },
      sidePanel: {
        setPanelBehavior: (opts) => {
          calls.push(["panel", opts]);
          return panelBehavior === "reject" ? Promise.reject(new Error("nope")) : Promise.resolve();
        }
      }
    }
  };
  if (withTextColor) fake.chrome.action.setBadgeTextColor = async (d) => { calls.push(["fg", d.color]); };
  return fake;
}

// The badge as the fake last saw it.
function badge(fake) {
  const last = (kind) => fake.calls.filter((c) => c[0] === kind).at(-1)?.[1];
  return { text: last("text"), bg: last("bg"), fg: last("fg"), title: last("title") };
}

// Let queued promise callbacks (the listener-triggered refresh) finish.
const settle = () => new Promise((resolve) => setImmediate(resolve));

let saved;
beforeEach(() => { saved = globalThis.chrome; });
afterEach(() => { globalThis.chrome = saved; });

describe("initUI", () => {
  test("shows a grey OFF badge with the default state", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    await initUI();
    assert.deepEqual(badge(fake), { text: "OFF", bg: "#808080", fg: "#FFFFFF", title: "Yesteryear: OFF (year set to 2010)" });
  });

  test("shows the year on navy when the time machine is ON", async () => {
    const fake = makeFakeChrome({ store: { enabled: true, year: 1999 } });
    globalThis.chrome = fake.chrome;
    await initUI();
    assert.deepEqual(badge(fake), { text: "1999", bg: "#000080", fg: "#FFFFFF", title: "Yesteryear: ON, it is 1999" });
  });

  test("keeps the action click for the popup (side panel opens only from the popup)", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    await initUI();
    assert.deepEqual(fake.calls.filter((c) => c[0] === "panel"), [["panel", { openPanelOnActionClick: false }]]);
  });

  test("registers storage and startup listeners synchronously", () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    const done = initUI(); // not awaited: listeners must already be there
    assert.equal(fake.listeners.storage.length, 1);
    assert.equal(fake.listeners.startup.length, 1);
    return done;
  });

  test("survives a rejected setPanelBehavior and a missing setBadgeTextColor", async () => {
    const fake = makeFakeChrome({ withTextColor: false, panelBehavior: "reject", store: { enabled: true, year: 2001 } });
    globalThis.chrome = fake.chrome;
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      await initUI();
      await settle();
    } finally {
      console.warn = warn;
    }
    assert.equal(badge(fake).text, "2001");
    assert.equal(badge(fake).fg, undefined);
    assert.ok(warnings.some((w) => w.includes("setPanelBehavior")), "the rejection is logged, not thrown");
  });

  test("survives a missing sidePanel API", async () => {
    const fake = makeFakeChrome();
    delete fake.chrome.sidePanel;
    globalThis.chrome = fake.chrome;
    await initUI();
    assert.equal(badge(fake).text, "OFF");
  });
});

describe("badge updates", () => {
  test("follows storage changes of enabled and year", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    await initUI();
    const [onChanged] = fake.listeners.storage;

    fake.store.enabled = true;
    fake.store.year = 2010;
    onChanged({ enabled: { oldValue: false, newValue: true } }, "local");
    await settle();
    assert.equal(badge(fake).text, "2010");
    assert.equal(badge(fake).bg, "#000080");

    fake.store.year = 2015;
    onChanged({ year: { oldValue: 2010, newValue: 2015 } }, "local");
    await settle();
    assert.equal(badge(fake).text, "2015");

    fake.store.enabled = false;
    onChanged({ enabled: { oldValue: true, newValue: false } }, "local");
    await settle();
    assert.equal(badge(fake).text, "OFF");
    assert.equal(badge(fake).bg, "#808080");
  });

  test("ignores other keys and other storage areas", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    await initUI();
    const [onChanged] = fake.listeners.storage;
    const before = fake.calls.length;
    onChanged({ "wb:cache": { newValue: 1 } }, "local");
    onChanged({ strict: { newValue: false } }, "local");
    onChanged({ year: { newValue: 2001 } }, "sync");
    await settle();
    assert.equal(fake.calls.length, before);
  });

  test("refreshes on browser startup", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    await initUI();
    fake.store.enabled = true;
    fake.store.year = 2020;
    fake.listeners.startup[0]();
    await settle();
    assert.equal(badge(fake).text, "2020");
  });

  test("a slow, older refresh never overwrites a newer one", async () => {
    const fake = makeFakeChrome({ store: { enabled: false } });
    globalThis.chrome = fake.chrome;
    let releaseFirst;
    fake.getDelays.push(new Promise((resolve) => { releaseFirst = resolve; }));
    const first = refreshBadge(); // reads enabled:false, then waits
    fake.store.enabled = true;
    fake.store.year = 2008;
    await refreshBadge();         // reads enabled:true, finishes first
    releaseFirst();
    await first;
    assert.equal(badge(fake).text, "2008");
    assert.equal(fake.calls.filter((c) => c[0] === "text").length, 1, "the stale result was dropped");
  });

  test("a failing chrome.action call is logged, not thrown", async () => {
    const fake = makeFakeChrome({ store: { enabled: true, year: 2003 } });
    fake.chrome.action.setTitle = async () => { throw new Error("boom"); };
    globalThis.chrome = fake.chrome;
    const warn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      await refreshBadge();
    } finally {
      console.warn = warn;
    }
    assert.equal(warned, true);
    assert.equal(badge(fake).text, "2003");
  });
});
