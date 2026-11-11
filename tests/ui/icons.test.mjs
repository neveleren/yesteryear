// Tests for the icon generator (extension/src/ui/icons/make_icons.mjs) and the PNGs it wrote.
// The PNG reader below is independent of the generator (zlib.crc32 / inflateSync from Node).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";
import { ICONS, PALETTE, ART_16, ART_24, ART_32, rasterize, encodePNG } from "../../extension/src/ui/icons/make_icons.mjs";

const ICON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../extension/src/ui/icons");
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Minimal reader for 8-bit RGBA, non-interlaced PNGs with filter 0 rows (what the generator writes).
function readPNG(buf) {
  assert.ok(buf.subarray(0, 8).equals(SIGNATURE), "PNG signature");
  let pos = 8;
  const chunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crc = buf.readUInt32BE(pos + 8 + len);
    assert.equal(crc, crc32(buf.subarray(pos + 4, pos + 8 + len)), `CRC of ${type}`);
    chunks.push({ type, data });
    pos += 12 + len;
  }
  assert.equal(chunks[0].type, "IHDR");
  assert.equal(chunks.at(-1).type, "IEND");
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.deepEqual([...ihdr.subarray(8, 13)], [8, 6, 0, 0, 0], "8-bit RGBA, deflate, no interlace");
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * 4;
  assert.equal(raw.length, (stride + 1) * height);
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, "filter type 0");
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, rgba };
}

describe("pixel art", () => {
  for (const [name, art] of [["ART_16", ART_16], ["ART_24", ART_24], ["ART_32", ART_32]]) {
    test(`${name} is square and uses only palette colours`, () => {
      assert.ok(art.length >= 16);
      for (const row of art) {
        assert.equal(row.length, art.length);
        for (const ch of row) assert.ok(ch in PALETTE, `unknown colour ${ch}`);
      }
    });
  }

  test("rasterize scales by whole pixels", () => {
    const img = rasterize(["K.", ".Y"], 2);
    assert.equal(img.width, 4);
    const px = (x, y) => [...img.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    assert.deepEqual(px(0, 0), [0, 0, 0, 255]);
    assert.deepEqual(px(1, 1), [0, 0, 0, 255]);
    assert.deepEqual(px(2, 0), [0, 0, 0, 0]);
    assert.deepEqual(px(3, 3), [255, 255, 0, 255]);
  });

  test("rasterize rejects bad art", () => {
    assert.throws(() => rasterize(["KK", "K"]), /square/);
    assert.throws(() => rasterize(["K?", "KK"]), /unknown colour/);
  });
});

describe("PNG encoder", () => {
  test("round-trips through an independent reader", () => {
    const width = 3, height = 2;
    const rgba = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
      1, 2, 3, 4, 250, 251, 252, 253, 0, 0, 0, 255
    ]);
    const back = readPNG(encodePNG({ width, height, rgba }));
    assert.equal(back.width, width);
    assert.equal(back.height, height);
    assert.ok(back.rgba.equals(rgba));
  });
});

describe("icon files", () => {
  test("the manifest sizes 16, 32, 48, 128 (and 24 for 150% displays) are generated", () => {
    assert.deepEqual(Object.keys(ICONS).map(Number).sort((a, b) => a - b), [16, 24, 32, 48, 128]);
  });

  for (const [size, [art, scale]] of Object.entries(ICONS)) {
    test(`icon${size}.png is a valid ${size}x${size} RGBA PNG, up to date with make_icons.mjs`, () => {
      const file = join(ICON_DIR, `icon${size}.png`);
      assert.ok(existsSync(file), "run: node extension/src/ui/icons/make_icons.mjs");
      const png = readPNG(readFileSync(file));
      assert.equal(png.width, Number(size));
      assert.equal(png.height, Number(size));
      assert.ok(png.rgba.equals(rasterize(art, scale).rgba), "pixels differ: regenerate the icons");
      const alpha = (x, y) => png.rgba[(y * png.width + x) * 4 + 3];
      const last = png.width - 1;
      assert.equal(alpha(last, last), 0, "bottom-right corner is transparent");
      let opaque = 0;
      for (let i = 3; i < png.rgba.length; i += 4) {
        assert.ok(png.rgba[i] === 0 || png.rgba[i] === 255, "pixel art: no partial alpha");
        if (png.rgba[i] === 255) opaque++;
      }
      assert.ok(opaque > png.width * png.height * 0.4, "the hourglass fills the icon");
    });
  }
});
