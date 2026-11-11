// Unit tests for extension/src/tour/sw_tour.js (opening the tour) and the tour's storage keys, against
// a fake chrome.* API. No network, no browser.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initTour, openTour, handleInstalled, tourUrl } from "../../extension/src/tour/sw_tour.js";
import { TOUR_KEYS, TOUR_PAGE } from "../../extension/src/tour/tour_core.js";
import { DEFAULTS } from "../../extension/src/shared/state_sw.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const PAGE_URL = `chrome-extension://${EXT_ID}/${TOUR_PAGE}`;

function makeFakeChrome({ store = {}, tabs = [], failCreate = false } = {}) {
  const calls = [];
  const listeners = { installed: [], message: [] };
  let nextId = 100;
  const fake = {
    calls, listeners, store, tabs,
    chrome: {
      runtime: {
        getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
        onMessage: { addListener: (fn) => listeners.message.push(fn) }
      },
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
            return out;
          },
          async set(patch) { calls.push(["set", patch]); Object.assign(store, patch); }
        }
      },
      tabs: {
        async query(q) { calls.push(["query", q]); return tabs.map((t) => ({ ...t })); },
        async create(opts) {
          calls.push(["create", opts]);
          if (failCreate) throw new Error("no window");
          const tab = { id: nextId++, url: opts.url, windowId: 1 };
          tabs.push(tab);
          return tab;
        },
        async update(id, opts) { calls.push(["update", id, opts]); return { id }; },
        async reload(id) { calls.push(["reload", id]); }
      },
      windows: { async update(id, opts) { calls.push(["focus", id, opts]); return { id }; } }
    }
  };
  return fake;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const kinds = (fake) => fake.calls.map((c) => c[0]);

let saved;
beforeEach(() => { saved = globalThis.chrome; });
afterEach(() => { globalThis.chrome = saved; });

describe("storage keys", () => {
  test("tour:agent and tour:done as agreed, plus tour:sound and tour:shown, all prefixed", () => {
    assert.equal(TOUR_KEYS.agent, "tour:agent");
    assert.equal(TOUR_KEYS.done, "tour:done");
    assert.equal(TOUR_KEYS.sound, "tour:sound");
    assert.equal(TOUR_KEYS.shown, "tour:shown");
    const values = Object.values(TOUR_KEYS);
    assert.equal(new Set(values).size, values.length);
    for (const k of values) {
      assert.match(k, /^tour:[a-z]+$/);
      assert.ok(!(k in DEFAULTS), `${k} collides with a state key`);
    }
  });

  test("the tour's scripts write storage only through TOUR_KEYS", () => {
    for (const f of ["welcome.js", "sw_tour.js", "agent.js"]) {
      const src = readFileSync(join(ROOT, "extension/src/tour", f), "utf8");
      assert.doesNotMatch(src, /["'`]tour:(?!open["'`])/, `${f} spells a tour: key by hand`);
    }
    const welcome = readFileSync(join(ROOT, "extension/src/tour/welcome.js"), "utf8");
    for (const key of ["agent", "done", "sound"]) assert.ok(welcome.includes(`TOUR_KEYS.${key}`), key);
  });
});

describe("initTour", () => {
  test("registers onInstalled and onMessage synchronously", () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    initTour();
    assert.equal(fake.listeners.installed.length, 1);
    assert.equal(fake.listeners.message.length, 1);
  });

  test("a fresh install opens welcome.html in a new tab and remembers that it was shown", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    initTour();
    fake.listeners.installed[0]({ reason: "install" });
    await settle(); await settle();
    assert.deepEqual(fake.calls.find((c) => c[0] === "create"), ["create", { url: PAGE_URL }]);
    assert.equal(fake.store[TOUR_KEYS.shown], true);
  });

  test("tour:open replies asynchronously; other messages are left to other modules", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    initTour();
    const [onMessage] = fake.listeners.message;
    let reply;
    const got = new Promise((resolve) => { reply = resolve; });
    assert.equal(onMessage({ type: "tour:open" }, {}, reply), true);
    assert.deepEqual(await got, { ok: true, tabId: 100, reused: false });
    for (const msg of [{ type: "getState" }, { type: "music:videoId" }, null, "tour:open"]) {
      assert.equal(onMessage(msg, {}, () => assert.fail("must not reply")), false);
    }
    assert.equal(fake.store[TOUR_KEYS.shown], undefined, "an opening on request is not the automatic one");
  });

  test("tour:open reports a failure instead of throwing", async () => {
    const fake = makeFakeChrome({ failCreate: true });
    globalThis.chrome = fake.chrome;
    initTour();
    const answer = await new Promise((resolve) => fake.listeners.message[0]({ type: "tour:open" }, {}, resolve));
    assert.deepEqual(answer, { ok: false, error: "no window" });
  });
});

describe("handleInstalled", () => {
  test("update: opens once when the tour was never shown, never again after", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    await handleInstalled({ reason: "update", previousVersion: "0.1.0" });
    assert.equal(kinds(fake).filter((k) => k === "create").length, 1);
    await handleInstalled({ reason: "update", previousVersion: "0.1.0" });
    assert.equal(kinds(fake).filter((k) => k === "create").length, 1, "tour:shown stops the second one");
  });

  test("update after the tour was finished or skipped: nothing", async () => {
    const fake = makeFakeChrome({ store: { [TOUR_KEYS.done]: true } });
    globalThis.chrome = fake.chrome;
    assert.equal(await handleInstalled({ reason: "update" }), null);
    assert.ok(!kinds(fake).includes("create"));
  });

  test("browser updates and missing details: nothing", async () => {
    const fake = makeFakeChrome();
    globalThis.chrome = fake.chrome;
    assert.equal(await handleInstalled({ reason: "chrome_update" }), null);
    assert.equal(await handleInstalled({ reason: "shared_module_update" }), null);
    assert.equal(await handleInstalled(undefined), null);
    assert.deepEqual(fake.calls, []);
  });
});

describe("openTour", () => {
  test("focuses and restarts an open tour tab instead of opening a second one", async () => {
    const fake = makeFakeChrome({ tabs: [{ id: 7, url: "https://example.com/", windowId: 1 }, { id: 9, url: `${PAGE_URL}#agent=rover&step=4`, windowId: 2 }] });
    globalThis.chrome = fake.chrome;
    assert.deepEqual(await openTour(), { ok: true, tabId: 9, reused: true });
    assert.ok(!kinds(fake).includes("create"));
    assert.deepEqual(fake.calls.filter((c) => c[0] !== "query"), [
      ["update", 9, { active: true }], ["reload", 9], ["focus", 2, { focused: true }]
    ]);
  });

  test("a tab that is still loading the tour counts too (pendingUrl)", async () => {
    const fake = makeFakeChrome({ tabs: [{ id: 3, url: "", pendingUrl: PAGE_URL, windowId: 1 }] });
    globalThis.chrome = fake.chrome;
    assert.equal((await openTour()).reused, true);
  });

  test("tourUrl is the extension URL of welcome.html", () => {
    globalThis.chrome = makeFakeChrome().chrome;
    assert.equal(tourUrl(), PAGE_URL);
    assert.equal(TOUR_PAGE, "src/tour/welcome.html");
  });
});
