// Generates the Yesteryear icons: a pixel-art hourglass in Windows 98 colours.
//   node extension/src/ui/icons/make_icons.mjs     (writes icon16/24/32/48/128.png next to this file)
// Pure Node (zlib only), no dependencies. Each size is drawn on its own pixel grid; 48 and 128 are
// the 24 and 32 grids scaled by whole pixels (x2, x4) so they stay crisp pixel art.
// 24 is extra: Chrome picks it for the 16 px toolbar icon at 150% display scaling.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Windows 98 palette colours (plus #DFDFDF, the 98 "3D light" grey).
export const PALETTE = Object.freeze({
  ".": null,            // transparent
  K: [0x00, 0x00, 0x00], // black outline
  N: [0x00, 0x00, 0x80], // navy, the title-bar blue: caps and posts
  B: [0x00, 0x00, 0xff], // blue highlight on caps and posts
  W: [0xff, 0xff, 0xff], // glass
  L: [0xdf, 0xdf, 0xdf], // glass, light shade
  S: [0xc0, 0xc0, 0xc0], // glass, shade (button-face silver)
  Y: [0xff, 0xff, 0x00], // sand
  O: [0x80, 0x80, 0x00]  // sand, shade (olive)
});

// 16 x 16, hand-tuned: no side posts and a 1 px neck, so it still reads as an hourglass at
// toolbar size (with posts it looked like a framed box).
export const ART_16 = [
  "KKKKKKKKKKKKKKK.",
  "KBBBBBBBBBBBBNK.",
  "KKKKKKKKKKKKKKK.",
  "..KWWWWWWWWSK...",
  "...KWWWWWWSK....",
  "....KYYYYOK.....",
  ".....KYYOK......",
  "......KYK.......",
  "......KYK.......",
  ".....KWYSK......",
  "....KWWYWSK.....",
  "...KWWYYYWSK....",
  "..KYYYYYYYYOK...",
  "KKKKKKKKKKKKKKK.",
  "KBBBBBBBBBBBBNK.",
  "KKKKKKKKKKKKKKK."
];

// 24 x 24: caps, side posts, sand dimple where it drains, stream, heap.
export const ART_24 = [
  ".KKKKKKKKKKKKKKKKKKKKKK.",
  ".KBBBBBBBBBBBBBBBBBBBNK.",
  ".KKKKKKKKKKKKKKKKKKKKKK.",
  "..BN.KWWWWWWWWWWLSK.BN..",
  "..BN.KWWWWWWWWWWLSK.BN..",
  "..BN.KWWWWWWWWWWLSK.BN..",
  "..BN..KWWWWWWWWLSK..BN..",
  "..BN..KYYYYWWYYOOK..BN..",
  "..BN...KYYYYYYOOK...BN..",
  "..BN....KYYYYOOK....BN..",
  "..BN.....KYYYOK.....BN..",
  "..BN......KYOK......BN..",
  "..BN......KYOK......BN..",
  "..BN.....KWYOSK.....BN..",
  "..BN....KWWYOLSK....BN..",
  "..BN...KWWYYYYLSK...BN..",
  "..BN..KYYYYYYYYOOK..BN..",
  "..BN..KYYYYYYYYOOK..BN..",
  "..BN.KYYYYYYYYYYOOK.BN..",
  "..BN.KYYYYYYYYYYOOK.BN..",
  "..BN.KYYYYYYYYYYOOK.BN..",
  ".KKKKKKKKKKKKKKKKKKKKKK.",
  ".KBBBBBBBBBBBBBBBBBBBNK.",
  ".KKKKKKKKKKKKKKKKKKKKKK."
];

// 32 x 32: caps with a blue bevel, posts, glass with a shaded right edge, sand running down.
export const ART_32 = [
  ".KKKKKKKKKKKKKKKKKKKKKKKKKKKKKK.",
  ".KBBBBBBBBBBBBBBBBBBBBBBBBBBBNK.",
  ".KBNNNNNNNNNNNNNNNNNNNNNNNNNNNK.",
  ".KKKKKKKKKKKKKKKKKKKKKKKKKKKKKK.",
  "...BN.KWWWWWWWWWWWWWWWWLSK.BN...",
  "...BN.KWWWWWWWWWWWWWWWWLSK.BN...",
  "...BN.KWWWWWWWWWWWWWWWWLSK.BN...",
  "...BN.KWWWWWWWWWWWWWWWWLSK.BN...",
  "...BN..KWWWWWWWWWWWWWWLSK..BN...",
  "...BN..KWWWWWWWWWWWWWWLSK..BN...",
  "...BN...KYYYYYYWWYYYYOOK...BN...",
  "...BN....KYYYYYYYYYYOOK....BN...",
  "...BN.....KKYYYYYYOOKK.....BN...",
  "...BN.......KYYYYOOK.......BN...",
  "...BN........KYYYOK........BN...",
  "...BN.........KYOK.........BN...",
  "...BN.........KYOK.........BN...",
  "...BN........KWYOSK........BN...",
  "...BN.......KWWYOLSK.......BN...",
  "...BN.....KKWWWYOWLSKK.....BN...",
  "...BN....KWWWWWYOWWWLSK....BN...",
  "...BN...KWWWWWYYYYWWWLSK...BN...",
  "...BN..KWWWYYYYYYYYYYWLSK..BN...",
  "...BN..KWYYYYYYYYYYYYYOSK..BN...",
  "...BN.KYYYYYYYYYYYYYYYYOOK.BN...",
  "...BN.KYYYYYYYYYYYYYYYYOOK.BN...",
  "...BN.KYYYYYYYYYYYYYYYYOOK.BN...",
  "...BN.KYYYYYYYYYYYYYYYYOOK.BN...",
  ".KKKKKKKKKKKKKKKKKKKKKKKKKKKKKK.",
  ".KBBBBBBBBBBBBBBBBBBBBBBBBBBBNK.",
  ".KBNNNNNNNNNNNNNNNNNNNNNNNNNNNK.",
  ".KKKKKKKKKKKKKKKKKKKKKKKKKKKKKK."
];

// size -> [art, whole-pixel scale]
export const ICONS = Object.freeze({
  16: [ART_16, 1],
  24: [ART_24, 1],
  32: [ART_32, 1],
  48: [ART_24, 2],
  128: [ART_32, 4]
});

export function rasterize(art, scale = 1) {
  const n = art.length;
  for (const row of art) if (row.length !== n) throw new Error(`art must be square, got a row of ${row.length} in ${n}`);
  const size = n * scale;
  const rgba = Buffer.alloc(size * size * 4); // all zero = transparent
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = art[Math.floor(y / scale)][Math.floor(x / scale)];
      if (!(ch in PALETTE)) throw new Error(`unknown colour "${ch}"`);
      const rgb = PALETTE[ch];
      if (!rgb) continue;
      const i = (y * size + x) * 4;
      rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
    }
  }
  return { width: size, height: size, rgba };
}

// ---- Minimal PNG writer: 8-bit RGBA, no interlace, filter 0 on every row --------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function encodePNG({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height); // each row: filter byte 0, then pixels
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export function writeIcons(outDir) {
  const written = [];
  for (const [size, [art, scale]] of Object.entries(ICONS)) {
    const img = rasterize(art, scale);
    if (img.width !== Number(size)) throw new Error(`icon${size}: got ${img.width} px`);
    const file = join(outDir, `icon${size}.png`);
    writeFileSync(file, encodePNG(img));
    written.push(file);
  }
  return written;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of writeIcons(here)) console.log("wrote", f);
}
