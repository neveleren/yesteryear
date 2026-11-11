// Unit tests for extension/src/travel/sw_travel.js against a fake chrome.* API. No network, no browser.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initTravel, travelGo } from "../../extension/src/travel/sw_travel.js";

const EXT = "chrome-extension://abcdefghijklmnop";
const NOW = () => 1762862400000;            // fixed clock: the nonce is Date.now() in base 36
const NONCE = NOW().toString(36);

function makeFake({ activeTab = null, store = {} } = {}) {
  const calls = [];
  const listeners = [];
  let nextId = 100;
  const api = {
    runtime: {
      getURL: (p) => `${EXT}/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) }
    },
    storage: { local: { async set(patch) { Object.assign(store, patch); calls.push(["set", patch]); } } },
    tabs: {
      async query(q) { calls.push(["query", q]); return activeTab ? [activeTab] : []; },
      async update(id, props) { calls.push(["update", id, props]); return { id, ...props }; },
      async create(props) { calls.push(["create", props]); return { id: nextId++, ...props }; }
    }
  };
  return { api, calls, listeners, store };
}

const page = (from, to, extra = "") => `${EXT}/src/travel/travel.html#from=${from}&to=${to}${extra}&t=${NONCE}`;

describe("travelGo", () => {
  test("from the popup (no tab): a new tab next to the active one", async () => {
    const fake = makeFake({ activeTab: { id: 7, index: 3, windowId: 2, url: "https://www.google.com/search?q=x" } });
    const r = await travelGo({ type: "travel:go", from: 2026, to: 1999 }, { url: `${EXT}/src/ui/popup.html` }, fake.api, 2026, NOW);
    assert.deepEqual(r, { ok: true, tabId: 100, url: page(2026, 1999) });
    assert.deepEqual(fake.calls.find((c) => c[0] === "create")[1], { url: page(2026, 1999), active: true, windowId: 2, index: 4, openerTabId: 7 });
    assert.equal(fake.store["travel:last"], 1999);
    assert.equal(fake.calls.some((c) => c[0] === "update"), false);
  });

  test("from the popup over an empty new tab: that tab travels", async () => {
    const fake = makeFake({ activeTab: { id: 9, index: 0, windowId: 1, url: "chrome://newtab/" } });
    const r = await travelGo({ type: "travel:go", from: 2010, to: 2005 }, {}, fake.api, 2026, NOW);
    assert.equal(r.tabId, 9);
    assert.deepEqual(fake.calls.find((c) => c[0] === "update").slice(1), [9, { url: page(2010, 2005) }]);
    assert.equal(fake.calls.some((c) => c[0] === "create"), false);
  });

  test("over an earlier trip: the same tab travels again", async () => {
    const fake = makeFake({ activeTab: { id: 4, index: 1, windowId: 1, url: page(2026, 1999) } });
    const r = await travelGo({ type: "travel:go", from: 1999, to: 2016 }, {}, fake.api, 2026, NOW);
    assert.equal(r.tabId, 4);
    assert.equal(r.url, page(1999, 2016));
  });

  test("from a page in a tab: that tab travels", async () => {
    const fake = makeFake({ activeTab: { id: 1, index: 0, windowId: 1, url: "https://example.com/" } });
    const r = await travelGo({ type: "travel:go", from: 2026, to: 2023 }, { tab: { id: 55, url: "https://www.google.com/" } }, fake.api, 2026, NOW);
    assert.equal(r.tabId, 55);
    assert.deepEqual(fake.calls.find((c) => c[0] === "update").slice(1), [55, { url: page(2026, 2023), active: true }]);
    assert.equal(fake.calls.some((c) => c[0] === "query"), false);
  });

  test("no window at all: a plain new tab", async () => {
    const fake = makeFake({ activeTab: null });
    const r = await travelGo({ type: "travel:go", from: 2026, to: 2010 }, {}, fake.api, 2026, NOW);
    assert.equal(r.ok, true);
    assert.deepEqual(fake.calls.find((c) => c[0] === "create")[1], { url: page(2026, 2010), active: true });
  });

  test("every trip gets a new nonce, so a reused travel tab always sees its fragment change", async () => {
    const fake = makeFake({ activeTab: null });
    let t = 1762862400000;
    const a = await travelGo({ type: "travel:go", from: 2026, to: 2010 }, {}, fake.api, 2026, () => t++);
    const b = await travelGo({ type: "travel:go", from: 2026, to: 2010 }, {}, fake.api, 2026, () => t++);
    assert.notEqual(a.url, b.url);
    assert.match(a.url, /&t=[a-z0-9]+$/);
  });

  test("sound:false is passed on to the page", async () => {
    const fake = makeFake({ activeTab: null });
    const r = await travelGo({ type: "travel:go", from: 2026, to: 2010, sound: false }, {}, fake.api, 2026, NOW);
    assert.equal(r.url, page(2026, 2010, "&sound=0"));
  });

  test("same year again starts from the present; a missing departure is the present", async () => {
    const fake = makeFake({ activeTab: null });
    assert.equal((await travelGo({ type: "travel:go", from: 2010, to: 2010 }, {}, fake.api, 2026, NOW)).url, page(2026, 2010));
    assert.equal((await travelGo({ type: "travel:go", to: 2003 }, {}, fake.api, 2026, NOW)).url, page(2026, 2003));
  });

  test("a bad destination opens nothing and stores nothing", async () => {
    const fake = makeFake({ activeTab: null });
    for (const to of [1990, 2030, "x", undefined]) {
      assert.deepEqual(await travelGo({ type: "travel:go", from: 2026, to }, {}, fake.api, 2026, NOW), { ok: false, reason: "bad-request" });
    }
    assert.equal(fake.calls.length, 0);
  });
});

describe("initTravel", () => {
  let saved;
  beforeEach(() => { saved = globalThis.chrome; });
  afterEach(() => { globalThis.chrome = saved; });

  test("handles only travel:go, answers asynchronously", async () => {
    const fake = makeFake({ activeTab: null });
    globalThis.chrome = fake.api;
    initTravel();
    assert.equal(fake.listeners.length, 1);
    const listener = fake.listeners[0];
    assert.equal(listener({ type: "music:videoId" }, {}, () => {}), false);
    assert.equal(listener({ type: "getState" }, {}, () => {}), false);
    assert.equal(listener(undefined, {}, () => {}), false);
    const reply = await new Promise((resolve) => {
      assert.equal(listener({ type: "travel:go", from: 2026, to: 2005 }, {}, resolve), true);
    });
    assert.equal(reply.ok, true);
    assert.match(reply.url, /travel\.html#from=\d{4}&to=2005&t=[a-z0-9]+$/);
  });

  test("a failing tabs API answers {ok:false, reason:'error'}", async () => {
    const fake = makeFake({ activeTab: null });
    fake.api.tabs.create = async () => { throw new Error("no tabs"); };
    globalThis.chrome = fake.api;
    const warn = console.warn;
    console.warn = () => {};
    try {
      initTravel();
      const reply = await new Promise((resolve) => fake.listeners[0]({ type: "travel:go", from: 2026, to: 2005 }, {}, resolve));
      assert.deepEqual(reply, { ok: false, reason: "error" });
    } finally {
      console.warn = warn;
    }
  });
});
