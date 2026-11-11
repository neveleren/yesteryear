// Static checks of the music module's files: MV3 extension-page CSP, references that must resolve,
// ids the scripts look up, what an offscreen document may use, and house style. No network, no browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLAYER = join(ROOT, "extension/src/player");
const SNIPPET = join(ROOT, "tests/player/fixtures/popup_mini_player.html");
const read = (p) => readFileSync(p, "utf8");
const PAGES = ["player.html", "offscreen.html"];
const SCRIPTS = readdirSync(PLAYER).filter((f) => f.endsWith(".js"));

function checkPage(html, dir, name) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1, `${name}: no script`);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\btype="module"/, `${name}: scripts are modules`);
    assert.match(attrs, /\bsrc="[^"]+"/, `${name}: script without src`);
    assert.doesNotMatch(attrs, /src="(https?:)?\/\//, `${name}: remote script`);
    assert.equal(body.trim(), "", `${name}: inline script body`);
  }
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, `${name}: inline event handler`);
  assert.doesNotMatch(html, /javascript:/i, `${name}: javascript: URL`);
  for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
    if (/^(data:|https?:)/.test(m[1])) continue;
    assert.ok(existsSync(join(dir, m[1])), `${name}: missing ${m[1]}`);
  }
}

describe("extension pages under the MV3 CSP", () => {
  for (const page of PAGES) {
    test(`${page}: bundled module scripts only, no inline code, references resolve`, () => {
      checkPage(read(join(PLAYER, page)), PLAYER, page);
    });
  }

  test("the popup snippet has no inline code either", () => {
    const html = read(SNIPPET);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i);
  });

  test("module imports are relative and exist", () => {
    for (const f of SCRIPTS) {
      for (const m of read(join(PLAYER, f)).matchAll(/^\s*import\b[^"']*["']([^"']+)["']/gm)) {
        assert.match(m[1], /^\.\.?\//, `${f} imports ${m[1]}`);
        assert.ok(existsSync(join(PLAYER, m[1])), `${f}: ${m[1]} does not exist`);
      }
    }
  });

  test("every url() in the stylesheets is a data: URL or a file", () => {
    for (const f of readdirSync(PLAYER).filter((x) => x.endsWith(".css"))) {
      for (const m of read(join(PLAYER, f)).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        if (m[1].startsWith("data:")) continue;
        assert.ok(existsSync(join(PLAYER, m[1])), `${f}: ${m[1]}`);
      }
    }
  });
});

describe("ids the scripts look up exist", () => {
  test("player.js -> player.html", () => {
    const html = read(join(PLAYER, "player.html"));
    const ids = [...read(join(PLAYER, "player.js")).matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 20);
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), `player.html lacks id="${id}"`);
  });

  test("miniplayer.js -> the popup snippet", () => {
    const html = read(SNIPPET);
    const ids = [...read(join(PLAYER, "miniplayer.js")).matchAll(/q\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 8);
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), `snippet lacks id="${id}"`);
    assert.match(html, /id="mini-player"/);
    assert.match(html, />Show player</);
  });

  test("offscreen.js finds its stage", () => {
    assert.match(read(join(PLAYER, "offscreen.html")), /id="stage"/);
    assert.match(read(join(PLAYER, "offscreen.js")), /getElementById\("stage"\)/);
  });
});

describe("mini player layout", () => {
  test("the fieldset may shrink, so a long song line scrolls instead of widening the popup", () => {
    // Chrome gives a fieldset min-inline-size: min-content; 98.css does not reset it. Live check:
    // tests/player/popup_width.py
    assert.match(read(join(PLAYER, "miniplayer.css")), /\.mini-player\s*\{[^}]*min-inline-size:\s*0\b/);
    assert.match(read(SNIPPET), /<fieldset class="mini-player"/);
  });
});

describe("what each context may use", () => {
  // Code only: comments may name APIs ("chrome.storage.local: ..." describes a key).
  const code = (f) => read(join(PLAYER, f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const chromeApis = (f) => [...new Set([...code(f).matchAll(/\bchrome\.([a-zA-Z]+)/g)].map((m) => m[1]))];

  test("the offscreen document only uses chrome.runtime (the only API Chrome gives it)", () => {
    for (const f of ["offscreen.js", "engine.js", "ytwidget.js", "playlist.js", "music_state.js"]) {
      for (const api of chromeApis(f)) assert.equal(api, "runtime", `${f} uses chrome.${api}`);
    }
  });

  test("the engine and the helpers are pure (node tests load them)", () => {
    for (const f of ["engine.js", "playlist.js", "music_state.js", "ytsearch.js"]) {
      assert.deepEqual(chromeApis(f), [], f);
    }
    assert.doesNotMatch(code("engine.js"), /\bdocument\b|\bwindow\b/);
  });

  test("the hub creates an AUDIO_PLAYBACK document with a justification", () => {
    const sw = read(join(PLAYER, "sw_music.js"));
    assert.match(sw, /chrome\.offscreen\.createDocument\(\{\s*url: OFFSCREEN_PATH, reasons: \[OFFSCREEN_REASON\], justification: OFFSCREEN_JUSTIFICATION/);
    assert.match(sw, /contextTypes: \["OFFSCREEN_DOCUMENT"\]/);
  });

  test("the hide button closes the panel through the sidePanel API, with window.close() as fallback", () => {
    const js = read(join(PLAYER, "player.js"));
    assert.match(js, /chrome\.sidePanel\.close\(\{ windowId: win\.id \}\)/);
    assert.match(js, /window\.close\(\)/);
  });

  test("Show player calls sidePanel.open() synchronously inside the click", () => {
    const js = read(join(PLAYER, "miniplayer.js"));
    const handler = js.slice(js.indexOf('el.show.addEventListener("click"'));
    const open = handler.indexOf("chrome.sidePanel.open(");
    assert.ok(open > 0);
    assert.doesNotMatch(handler.slice(0, open), /\bawait\b/);
  });
});

describe("house style", () => {
  const files = readdirSync(PLAYER).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => join(PLAYER, f));

  test("no DOM from HTML strings, no eval", () => {
    for (const p of files.filter((f) => f.endsWith(".js"))) {
      const src = read(p);
      for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/]) {
        assert.doesNotMatch(src, bad, `${p}: ${bad}`);
      }
    }
  });

  test("no long dashes in the module's files, the chart data and the snippet", () => {
    for (const p of [...files, join(PLAYER, "charts.json"), SNIPPET]) assert.doesNotMatch(read(p), /[–—]/, p);
  });

  test("no file name starts with '_' (Chrome refuses to load the extension)", () => {
    const walk = (dir) => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? [p, ...walk(p)] : [p];
    });
    for (const p of walk(PLAYER)) assert.ok(!p.split(/[\\/]/).at(-1).startsWith("_"), p);
  });
});
