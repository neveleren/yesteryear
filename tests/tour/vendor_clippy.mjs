// Vendoring tool for the Office-Assistant characters used by the first-run tour (not a test).
//
// Input: the extracted npm package clippyjs@0.1.0 (MIT code; the characters belong to Microsoft).
//   In a new, empty folder:  npm pack clippyjs@0.1.0 --ignore-scripts  and  tar -xzf clippyjs-0.1.0.tgz
// Usage: node tests/tour/vendor_clippy.mjs <folder that holds package/dist/agents>
//
// The package ships every agent as three ES modules (agent.mjs, map.mjs, sounds-mp3.mjs) that hold
// one big literal each. Downloaded code is never imported or evaluated here: a small literal parser
// reads the text, and each file must have exactly the expected shape ("var x = <literal>; export
// { x as default };") or the tool stops. Output goes to extension/src/vendor/clippy/agents/<id>/:
// agent.json (animation data, unchanged), map.png (sprite sheet, decoded from base64) and
// sounds/<n>.mp3 (decoded from base64). SHA-256 of every file is printed for the README.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "extension/src/vendor/clippy");
export const AGENT_IDS = ["clippy", "rover"];

// ---- A literal-only parser (objects, arrays, strings, numbers, true/false/null) ----------------
export function parseLiteral(src, start = 0) {
  let i = start;
  const fail = (what) => {
    throw new SyntaxError(`${what} at ${i}: ${JSON.stringify(src.slice(i, i + 24))}`);
  };
  const ws = () => {
    for (;;) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (c === "/" && src[i + 1] === "/") {
        const n = src.indexOf("\n", i);
        i = n < 0 ? src.length : n + 1;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const n = src.indexOf("*/", i + 2);
        if (n < 0) fail("unclosed comment");
        i = n + 2;
        continue;
      }
      return;
    }
  };
  const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const IDENT = /[A-Za-z_$][\w$]*/y;
  const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

  function value() {
    ws();
    const c = src[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"' || c === "'") return string();
    if (c === "-" || c === "." || (c >= "0" && c <= "9")) return number();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]]) {
      if (src.startsWith(word, i) && !/[\w$]/.test(src[i + word.length] || "")) {
        i += word.length;
        return v;
      }
    }
    return fail("unexpected token");
  }
  function number() {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(src);
    if (!m) fail("bad number");
    i += m[0].length;
    return Number(m[0]);
  }
  function string() {
    const quote = src[i++];
    let out = "";
    for (;;) {
      const c = src[i++];
      if (c === undefined) fail("unclosed string");
      if (c === quote) return out;
      if (c === "\n") fail("newline in string");
      if (c !== "\\") { out += c; continue; }
      const e = src[i++];
      const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\\": "\\", '"': '"', "'": "'", "/": "/" };
      if (e in simple) out += simple[e];
      else if (e === "u") {
        const hex = src.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else fail("unsupported escape");
    }
  }
  function key() {
    ws();
    const c = src[i];
    let k;
    if (c === '"' || c === "'") k = string();
    else if (c === "-" || (c >= "0" && c <= "9")) k = String(number());
    else {
      IDENT.lastIndex = i;
      const m = IDENT.exec(src);
      if (!m) fail("bad key");
      i += m[0].length;
      k = m[0];
    }
    if (FORBIDDEN.has(k)) fail(`forbidden key ${k}`);
    return k;
  }
  function object() {
    i++;
    const out = {};
    for (;;) {
      ws();
      if (src[i] === "}") { i++; return out; }
      const k = key();
      ws();
      if (src[i] !== ":") fail("expected ':'");
      i++;
      out[k] = value();
      ws();
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "}") { i++; return out; }
      fail("expected ',' or '}'");
    }
  }
  function array() {
    i++;
    const out = [];
    for (;;) {
      ws();
      if (src[i] === "]") { i++; return out; }
      out.push(value());
      ws();
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "]") { i++; return out; }
      fail("expected ',' or ']'");
    }
  }

  const result = value();
  ws();
  return { value: result, end: i };
}

// "var NAME = <literal>;\nexport { NAME as default };" and nothing else.
export function parseDefaultExport(src) {
  const head = /^\s*var ([A-Za-z_$][\w$]*) = /.exec(src);
  if (!head) throw new Error("not a 'var x = <literal>' module");
  const { value, end } = parseLiteral(src, head[0].length);
  const tail = src.slice(end);
  const expected = new RegExp(`^;\\s*export \\{ ${head[1].replace(/\$/g, "\\$")} as default \\};\\s*$`);
  if (!expected.test(tail)) throw new Error(`unexpected code after the literal: ${JSON.stringify(tail.slice(0, 60))}`);
  return value;
}

export function decodeDataUrl(url, mime) {
  const prefix = `data:${mime};base64,`;
  if (typeof url !== "string" || !url.startsWith(prefix)) throw new Error(`not a ${mime} data URL`);
  const b64 = url.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error("bad base64");
  return Buffer.from(b64, "base64");
}

export function pngSize(buf) {
  const SIG = "89504e470d0a1a0a";
  if (buf.subarray(0, 8).toString("hex") !== SIG || buf.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error("not a PNG");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function main(pkgArg) {
  const pkg = resolve(pkgArg);
  const base = [join(pkg, "package/dist/agents"), join(pkg, "dist/agents")].find((p) => {
    try { readFileSync(join(p, "clippy/agent.mjs")); return true; } catch { return false; }
  });
  if (!base) throw new Error(`no dist/agents/clippy/agent.mjs under ${pkg}`);
  const pkgRoot = resolve(base, "../..");
  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  if (pkgJson.name !== "clippyjs" || pkgJson.version !== "0.1.0") {
    throw new Error(`expected clippyjs@0.1.0, got ${pkgJson.name}@${pkgJson.version}`);
  }

  const rows = [];
  const record = (rel, buf) => rows.push([rel, buf.length, sha256(buf)]);
  for (const id of AGENT_IDS) {
    const src = join(base, id);
    const dst = join(OUT, "agents", id);
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(join(dst, "sounds"), { recursive: true });

    const data = parseDefaultExport(readFileSync(join(src, "agent.mjs"), "utf8"));
    const json = Buffer.from(JSON.stringify(data));
    writeFileSync(join(dst, "agent.json"), json);
    record(`agents/${id}/agent.json`, json);

    const png = decodeDataUrl(parseDefaultExport(readFileSync(join(src, "map.mjs"), "utf8")), "image/png");
    const { width, height } = pngSize(png);
    writeFileSync(join(dst, "map.png"), png);
    record(`agents/${id}/map.png`, png);

    const sounds = parseDefaultExport(readFileSync(join(src, "sounds-mp3.mjs"), "utf8"));
    for (const [name, url] of Object.entries(sounds)) {
      if (!/^\d+$/.test(name)) throw new Error(`odd sound name ${name}`);
      const mp3 = decodeDataUrl(url, "audio/mpeg");
      writeFileSync(join(dst, "sounds", `${name}.mp3`), mp3);
      record(`agents/${id}/sounds/${name}.mp3`, mp3);
    }
    console.log(`${id}: ${Object.keys(data.animations).length} animations, frame ${data.framesize.join("x")}, ` +
      `map ${width}x${height}, ${Object.keys(sounds).length} sounds`);
  }
  copyFileSync(join(pkgRoot, "LICENCE"), join(OUT, "LICENSE"));
  record("LICENSE", readFileSync(join(OUT, "LICENSE")));
  console.log("\n| File | Bytes | SHA-256 |\n|---|---|---|");
  for (const [rel, size, hash] of rows) console.log(`| \`${rel}\` | ${size} | \`${hash}\` |`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    console.error("usage: node tests/tour/vendor_clippy.mjs <extracted clippyjs-0.1.0 folder>");
    process.exit(2);
  }
  main(process.argv[2]);
}
