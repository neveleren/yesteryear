// Static checks of the travel module's files: MV3 extension-page CSP rules, references that must resolve,
// safe DOM habits, house style. No network, no browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(ROOT, "extension/src/travel");
const read = (f) => readFileSync(join(DIR, f), "utf8");
const FILES = readdirSync(DIR);
const SCRIPTS = FILES.filter((f) => f.endsWith(".js"));
const html = read("travel.html");
const css = read("travel.css");

describe("travel.html under the MV3 extension-page CSP", () => {
  test("no inline script; every script is a bundled module file", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 1);
    const [, attrs, body] = scripts[0];
    assert.match(attrs, /type="module" src="travel\.js"/);
    assert.equal(body.trim(), "");
  });

  test("no inline event handlers, no javascript: URLs, no remote scripts or styles", () => {
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /<(script|link)\b[^>]*(src|href)="(https?:)?\/\//i);
  });

  test("every local src/href in the page and every url() in the CSS resolves", () => {
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 3);
    for (const ref of refs) assert.ok(existsSync(join(DIR, ref)), `travel.html: missing ${ref}`);
    const urls = [...css.matchAll(/url\("?([^")]+)"?\)/g)].map((m) => m[1]).filter((u) => !u.startsWith("data:"));
    assert.ok(urls.length >= 2);
    for (const u of urls) assert.ok(existsSync(join(DIR, u)), `travel.css: missing ${u}`);
  });

  test("the blur filters travel.js uses exist", () => {
    for (let i = 0; i < 4; i++) assert.match(html, new RegExp(`<filter id="blur${i}"[^>]*><feGaussianBlur stdDeviation="0 0"/></filter>`));
    for (const id of ["trip", "warp", "hud", "skip", "landing", "scan", "flash"]) assert.ok(html.includes(`id="${id}"`), id);
  });

  test("relative paths the page loads at runtime exist", () => {
    const js = read("travel.js");
    for (const m of js.matchAll(/fetchJson\("([^"]+)"\)/g)) assert.ok(existsSync(join(DIR, m[1])), m[1]);
    for (const m of js.matchAll(/src: "([^"]+)"/g)) assert.ok(existsSync(join(DIR, m[1])), m[1]);
  });
});

describe("scripts", () => {
  test("only bundled relative imports that exist", () => {
    for (const f of SCRIPTS) {
      for (const m of read(f).matchAll(/^\s*import\b[^"']*["']([^"']+)["']/gm)) {
        assert.match(m[1], /^\.\.?\//, `${f} imports ${m[1]}`);
        assert.ok(existsSync(join(DIR, m[1])), `${f}: ${m[1]} does not exist`);
      }
    }
  });

  test("never build DOM from HTML strings or evaluate code", () => {
    for (const f of SCRIPTS) {
      const src = read(f);
      for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/]) {
        assert.doesNotMatch(src, bad, `${f}: ${bad}`);
      }
    }
  });

  test("never talks to Google from the extension side", () => {
    for (const f of SCRIPTS) {
      for (const m of read(f).matchAll(/fetch\(([^)]*)\)/g)) assert.doesNotMatch(m[1], /google/i, `${f}: ${m[0]}`);
    }
  });

  test("message types belong to this module or to documented contracts", () => {
    const allowed = new Set(["travel:go", "getState", "setState", "music:control"]);
    let seen = 0;
    for (const f of SCRIPTS) {
      const src = read(f);
      const types = [...src.matchAll(/send\(\{\s*type: "([^"]+)"/g), ...src.matchAll(/msg\?\.type\s*[!=]==\s*"([^"]+)"/g)];
      for (const m of types) { seen += 1; assert.ok(allowed.has(m[1]), `${f}: ${m[1]}`); }
    }
    assert.ok(seen >= 4);
  });
});

describe("house style", () => {
  test("no long dashes anywhere in the module", () => {
    for (const f of FILES) assert.doesNotMatch(read(f), /[–—]/, f);
  });

  test("no file name starts with '_' (Chrome refuses to load the extension)", () => {
    for (const f of FILES) assert.ok(!f.startsWith("_"), f);
  });
});
