// Unit tests for tests/tour/vendor_clippy.mjs, the tool that turned the npm package's data modules into
// plain files without running them. The literal parser must read data and refuse anything else.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLiteral, parseDefaultExport, decodeDataUrl, pngSize } from "./vendor_clippy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("parseLiteral", () => {
  test("reads the shapes the package uses", () => {
    const src = `{
      overlayCount: 1, // comment
      sounds: ["1", '2',],
      framesize: [124, 93],
      1: "data:audio/mpeg;base64,SUQz",
      "quoted key": { frames: [{ duration: 1e2, images: [[0, -0.5]], ok: true, no: false, nothing: null }] },
      /* block */ esc: "a\\"b\\u0041\\n"
    }`;
    assert.deepEqual(parseLiteral(src).value, {
      overlayCount: 1,
      sounds: ["1", "2"],
      framesize: [124, 93],
      1: "data:audio/mpeg;base64,SUQz",
      "quoted key": { frames: [{ duration: 100, images: [[0, -0.5]], ok: true, no: false, nothing: null }] },
      esc: 'a"bA\n'
    });
  });

  test("refuses code and prototype tricks", () => {
    for (const bad of ["{ a: foo }", "{ a: f() }", "{ a: `x` }", "[1, 2", "{ a: 1 b: 2 }", "{ __proto__: {} }",
      "{ constructor: 1 }", "{ a: new Date() }", "{ a: truex }", '{ a: "unterminated }']) {
      assert.throws(() => parseLiteral(bad), SyntaxError, bad);
    }
  });
});

describe("parseDefaultExport", () => {
  test("accepts exactly 'var x = <literal>; export { x as default };'", () => {
    assert.deepEqual(parseDefaultExport('var agent_default = { a: [1] };\nexport { agent_default as default };\n'), { a: [1] });
    assert.equal(parseDefaultExport('var map_default = "data:image/png;base64,AA==";\nexport { map_default as default };'), "data:image/png;base64,AA==");
  });

  test("refuses anything around the literal", () => {
    for (const bad of [
      'var x = {};\nexport { x as default };\nfetch("https://example.com");',
      'var x = {};\nexport { y as default };',
      'import "./evil.mjs";\nvar x = {};\nexport { x as default };',
      'var x = {}, y = steal();\nexport { x as default };',
      'export default {};'
    ]) {
      assert.throws(() => parseDefaultExport(bad), Error, bad);
    }
  });
});

describe("decoding", () => {
  test("data URLs: right type and clean base64 only", () => {
    assert.deepEqual([...decodeDataUrl("data:audio/mpeg;base64,SUQz", "audio/mpeg")], [0x49, 0x44, 0x33]);
    assert.throws(() => decodeDataUrl("data:image/png;base64,AA==", "audio/mpeg"), /not a audio\/mpeg/);
    assert.throws(() => decodeDataUrl("data:audio/mpeg;base64,SU Qz", "audio/mpeg"), /bad base64/);
  });

  test("pngSize reads the header and refuses non-PNG data", () => {
    const map = readFileSync(join(ROOT, "extension/src/vendor/clippy/agents/clippy/map.png"));
    assert.deepEqual(pngSize(map), { width: 3348, height: 3162 });
    assert.throws(() => pngSize(Buffer.from("GIF89a-------------------")), /not a PNG/);
  });
});
