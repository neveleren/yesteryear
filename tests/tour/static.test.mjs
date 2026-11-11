// Static checks of the tour module and its vendored characters: MV3 extension-page CSP, references
// that must resolve, safe DOM habits, the vendor notes (origin, licence, hashes) and names Chrome
// refuses to load. No network, no browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOUR = join(ROOT, "extension/src/tour");
const VENDOR = join(ROOT, "extension/src/vendor/clippy");
const read = (p) => readFileSync(p, "utf8");
const html = read(join(TOUR, "welcome.html"));
const SCRIPTS = ["welcome.js", "agent.js", "tour_core.js", "sw_tour.js"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out.push(p);
    if (statSync(p).isDirectory()) out.push(...walk(p));
  }
  return out;
}

describe("welcome.html under the MV3 extension-page CSP", () => {
  test("one bundled module script, no inline script", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 1);
    const [, attrs, body] = scripts[0];
    assert.match(attrs, /type="module" src="welcome\.js"/);
    assert.equal(body.trim(), "");
  });

  test("no inline event handlers, javascript: URLs or remote resources", () => {
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /\s(?:src|href)="(?:https?:)?\/\//);
  });

  test("every local src/href resolves to a file", () => {
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 6);
    for (const ref of refs) assert.ok(existsSync(join(TOUR, ref)), `missing ${ref}`);
  });

  test("the popup replica is the real popup in an inert iframe", () => {
    assert.match(html, /<iframe id="replica"[^>]*\ssrc="\.\.\/ui\/popup\.html"[^>]*\sinert[\s>]/);
    assert.match(read(join(TOUR, "welcome.css")), /\.replica\s*\{[^}]*pointer-events:\s*none/);
  });

  test("every id that welcome.js looks up exists (ids made at runtime excepted)", () => {
    const js = read(join(TOUR, "welcome.js"));
    const RUNTIME = new Set(["tour-next", "tour-title", "tour-skip"]);
    const ids = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
    for (const m of js.matchAll(/\$\(`([a-z]+)-\$\{[^}]+\}`\)/gi)) for (const id of ["clippy", "rover"]) ids.add(`${m[1]}-${id}`);
    assert.ok(ids.size >= 15);
    for (const id of ids) if (!RUNTIME.has(id)) assert.ok(html.includes(`id="${id}"`), `welcome.html lacks id="${id}"`);
  });

  test("98.css radios and checkboxes are each directly followed by their label", () => {
    for (const id of ["pick-clippy", "pick-rover", "opt-sound"]) {
      assert.match(html, new RegExp(`<input type="(radio|checkbox)"[^>]*id="${id}"[^>]*>\\s*<label for="${id}">`), id);
    }
  });
});

describe("tour scripts", () => {
  test("import only bundled relative modules that exist", () => {
    for (const f of SCRIPTS) {
      for (const m of read(join(TOUR, f)).matchAll(/^\s*import\b[^"']*["']([^"']+)["']/gm)) {
        assert.match(m[1], /^\.\.?\//, `${f} imports ${m[1]}`);
        assert.ok(existsSync(join(TOUR, m[1])), `${f}: ${m[1]} does not exist`);
      }
    }
  });

  test("never build DOM from HTML strings or evaluate code", () => {
    for (const f of SCRIPTS) {
      const src = read(join(TOUR, f));
      for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/]) {
        assert.doesNotMatch(src, bad, `${f}: ${bad}`);
      }
    }
  });

  test("no requests to Google or any remote host", () => {
    for (const f of SCRIPTS) assert.doesNotMatch(read(join(TOUR, f)), /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, f);
  });

  test("agent.js has no top-level DOM access (node can import it, so can the service worker)", async () => {
    const mod = await import("../../extension/src/tour/agent.js");
    assert.equal(typeof mod.Agent, "function");
    assert.equal(typeof mod.Balloon, "function");
  });

  test("every url() in welcome.css is a data: URL", () => {
    for (const m of read(join(TOUR, "welcome.css")).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      assert.ok(m[1].startsWith("data:"), m[1]);
    }
  });
});

describe("house rules", () => {
  test("no long dashes in the tour files and the vendor README", () => {
    const files = [...walk(TOUR).filter((p) => /\.(js|html|css|svg)$/.test(p)), join(VENDOR, "README.md")];
    for (const p of files) assert.doesNotMatch(read(p), /[–—]/, p);
  });

  test("no file or folder name starts with '_' (Chrome refuses to load the extension)", () => {
    for (const p of [...walk(TOUR), ...walk(VENDOR)]) assert.ok(!p.split(/[\\/]/).at(-1).startsWith("_"), p);
  });
});

describe("vendored characters", () => {
  const readme = read(join(VENDOR, "README.md"));

  test("README names the source release and the licence situation", () => {
    assert.match(readme, /clippyjs@0\.1\.0/);
    assert.match(readme, /2026-02-17/);
    assert.match(readme, /MIT/);
    assert.match(readme, /Microsoft/);
    assert.match(readme, /personal use/i);
    const license = read(join(VENDOR, "LICENSE"));
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.match(license, /property of Microsoft/);
  });

  test("every vendored file is listed in the README with its SHA-256", () => {
    const files = walk(VENDOR).filter((p) => statSync(p).isFile() && !p.endsWith("README.md"));
    assert.ok(files.length >= 30);
    for (const p of files) {
      const rel = relative(VENDOR, p).split(/[\\/]/).join("/");
      const hash = createHash("sha256").update(readFileSync(p)).digest("hex");
      assert.ok(readme.includes(`\`${rel}\``), `${rel} not listed`);
      assert.ok(readme.includes(hash), `${rel}: hash ${hash} not in README`);
    }
  });
});
