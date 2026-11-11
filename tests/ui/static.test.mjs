// Static checks of the UI module's files: MV3 CSP rules, references that must resolve, the vendored
// 98.css copy and its licences, and names Chrome refuses to load. No network, no browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOGGLE_KEYS } from "../../extension/src/ui/logic.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UI = join(ROOT, "extension/src/ui");
const VENDOR = join(ROOT, "extension/src/vendor/98css");
const read = (p) => readFileSync(p, "utf8");
const html = read(join(UI, "popup.html"));
const UI_SCRIPTS = ["popup.js", "logic.js", "sw_ui.js"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out.push(p);
    if (statSync(p).isDirectory()) out.push(...walk(p));
  }
  return out;
}

describe("popup.html under the MV3 extension-page CSP", () => {
  test("has no inline script, every script is a bundled file", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length >= 1);
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /\bsrc="[^"]+"/, "script without src");
      assert.doesNotMatch(attrs, /src="(https?:)?\/\//, "remote script");
      assert.equal(body.trim(), "", "inline script body");
    }
    assert.match(html, /<script type="module" src="popup\.js"><\/script>/);
  });

  test("has no inline event handlers or javascript: URLs", () => {
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /javascript:/i);
  });

  test("every local src/href/srcset resolves to a file", () => {
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const m of html.matchAll(/\ssrcset="([^"]+)"/g)) {
      for (const part of m[1].split(",")) refs.push(part.trim().split(/\s+/)[0]);
    }
    assert.ok(refs.length >= 5);
    for (const ref of refs) {
      if (/^(data:|https?:)/.test(ref)) continue;
      assert.ok(existsSync(join(UI, ref)), `missing ${ref}`);
    }
  });

  test("UI scripts import only bundled modules", () => {
    for (const f of UI_SCRIPTS) {
      for (const m of read(join(UI, f)).matchAll(/^\s*import\b[^"']*["']([^"']+)["']/gm)) {
        assert.match(m[1], /^\.\.?\//, `${f} imports ${m[1]}`);
        assert.ok(existsSync(join(UI, m[1])), `${f}: ${m[1]} does not exist`);
      }
    }
  });
});

describe("popup.html content", () => {
  const LABELS = {
    enabled: "Time machine ON",
    google: "Google",
    youtube: "YouTube",
    strict: "Strict: never show the future",
    eraLook: "Period look"
  };

  test("has the five checkboxes, each directly followed by its label (98.css needs input + label)", () => {
    for (const key of TOGGLE_KEYS) {
      const re = new RegExp(`<input type="checkbox" id="opt-${key}">\\s*<label for="opt-${key}">${LABELS[key]}</label>`);
      assert.match(html, re, key);
    }
  });

  test("has the title, the travel button and the mini player", () => {
    assert.match(html, /<div class="title-bar-text"[^>]*>[\s\S]*?Yesteryear\s*<\/div>/);
    assert.match(html, /<button type="button" id="travel" class="default">Travel to \d{4} &gt;&gt;<\/button>/);
    assert.match(html, /<fieldset class="mini-player" id="mini-player">/);
    assert.match(html, /<button type="button" id="mp-show" disabled>Show player<\/button>/);
    assert.match(html, /<input type="range" id="year" min="1998" max="2025" step="1"/);
  });

  test("fits Chrome's popup height at 125 % zoom: no tip line, the advice is the switch's tooltip", () => {
    // Chrome caps a popup at 600 DIP (480 CSS px at 125 %); the tip line cost 34 px. Measured in a
    // browser by tests/ui/popup_check.py; this only keeps the line from coming back unnoticed.
    assert.doesNotMatch(html, /class="tip"/);
    assert.match(html, /<div class="field-row master" title="[^"]*separate Chrome profile[^"]*">/);
  });

  test("the mini player's placeholders name no year (they show for a frame before music:state answers)", () => {
    assert.match(html, /<legend id="mp-legend">Music<\/legend>/);
    assert.match(html, /<span id="mp-text"><\/span>/);
    assert.match(html, /<span class="mp-time" id="mp-time"><\/span>/);
    const fieldset = html.slice(html.indexOf('id="mini-player"'), html.indexOf("</fieldset>", html.indexOf('id="mini-player"')));
    assert.doesNotMatch(fieldset, /\b(19|20)\d\d\b/);
  });

  test("every element id that popup.js looks up exists", () => {
    const js = read(join(UI, "popup.js"));
    const ids = [...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 10);
    for (const id of [...ids, ...TOGGLE_KEYS.map((k) => `opt-${k}`)]) {
      assert.ok(html.includes(`id="${id}"`), `popup.html lacks id="${id}"`);
    }
  });
});

describe("time travel from the popup", () => {
  const js = read(join(UI, "popup.js"));

  test("the trip departs from departureYear(), never from the last trip (travel:last)", () => {
    // travel:last is the previous destination: after switching OFF it is not where you are.
    assert.doesNotMatch(js, /travel:last/);
    assert.match(js, /departureYear\(state, presentYear\(\)\)/);
    assert.match(js, /chrome\.runtime\.sendMessage\(\{ type: "travel:go", from, to \}\)/);
  });

  test("the departure is taken before the click switches the machine ON", () => {
    const click = js.slice(js.indexOf('el.travel.addEventListener("click"'));
    const fromAt = click.indexOf("const from = ");
    assert.ok(fromAt > 0, "no departure in the click handler");
    assert.ok(fromAt < click.indexOf("enabled: true"), "departure read after state was switched ON");
    assert.ok(fromAt < click.indexOf("await "), "departure read after an await (storage changes can land there)");
  });
});

describe("safe DOM and house style", () => {
  test("UI scripts never build DOM from HTML strings or evaluate code", () => {
    for (const f of UI_SCRIPTS) {
      const src = read(join(UI, f));
      for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/]) {
        assert.doesNotMatch(src, bad, `${f}: ${bad}`);
      }
    }
  });

  test("no long dashes in UI files and the vendor README", () => {
    for (const p of [...UI_SCRIPTS.map((f) => join(UI, f)), join(UI, "popup.html"), join(UI, "popup.css"), join(VENDOR, "README.md")]) {
      assert.doesNotMatch(read(p), /[–—]/, p);
    }
  });

  test("no file or folder name starts with '_' (Chrome refuses to load the extension)", () => {
    for (const p of [...walk(UI), ...walk(VENDOR)]) {
      assert.ok(!p.split(/[\\/]/).at(-1).startsWith("_"), p);
    }
  });
});

describe("vendored 98.css", () => {
  const css = read(join(VENDOR, "98.css"));

  test("is the pinned release 0.1.21", () => {
    assert.ok(css.startsWith("/*! 98.css v0.1.21 "), css.slice(0, 60));
  });

  test("every url() in 98.css and popup.css resolves (fonts next to the CSS)", () => {
    for (const [file, dir] of [[join(VENDOR, "98.css"), VENDOR], [join(UI, "popup.css"), UI]]) {
      for (const m of read(file).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const ref = m[1];
        if (ref.startsWith("data:")) continue;
        assert.ok(existsSync(join(dir, ref)), `${file}: ${ref}`);
      }
    }
    for (const font of ["ms_sans_serif.woff", "ms_sans_serif.woff2", "ms_sans_serif_bold.woff", "ms_sans_serif_bold.woff2"]) {
      assert.ok(css.includes(`url(${font})`), font);
    }
  });

  test("ships its MIT licence and the font's CC BY-SA 3.0 notices", () => {
    const license = read(join(VENDOR, "LICENSE"));
    assert.match(license, /Copyright 2020 Jordan Scales/);
    assert.match(license, /Permission is hereby granted, free of charge/);
    const readme = read(join(VENDOR, "README.md"));
    assert.match(readme, /98\.css@0\.1\.21/);
    assert.match(readme, /CC BY-SA 3\.0/);
    assert.match(readme, /"lou"/);
    for (const dir of ["ms-sans-serif", "ms-sans-serif-bold"]) {
      assert.match(read(join(VENDOR, "font-licenses", dir, "license.txt")), /Creative Commons Attribution Share Alike/);
      assert.ok(existsSync(join(VENDOR, "font-licenses", dir, "readme.txt")));
    }
  });
});
