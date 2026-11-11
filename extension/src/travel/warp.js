// Time tunnel on a 2D canvas: stars that stretch into light streaks as the speed rises, rings rushing past
// on a twisting path, and a core of light that swells toward the flash. One draw call per call of frame().
// Stars are stroked in a few batches (depth band x colour), so a frame costs about 20 strokes.

const PALETTES = {
  back: ["#7fe7ff", "#6aa8ff", "#b48cff", "#ffffff"],    // going back: cold blue and violet
  forward: ["#ffd27f", "#ff8f6a", "#ff6ad5", "#ffffff"]  // going forward: warm amber and magenta
};
const BANDS = 4;           // depth bands: far stars are thin and dim, near ones thick and bright
const RINGS = 16;
const TAU = Math.PI * 2;

export class Warp {
  constructor(canvas, { direction = "back", seed = 7 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.colors = PALETTES[direction] || PALETTES.back;
    this.rand = mulberry32(seed);
    this.last = null;
    this.z0 = 0;            // ring travel
    this.stars = [];
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.canvas.width && h === this.canvas.height && this.stars.length) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.dpr = dpr;
    const count = Math.round(Math.min(1100, Math.max(350, (w * h) / (dpr * dpr) / 1500)));
    this.stars = Array.from({ length: count }, () => this.spawn(this.rand()));
    this.ctx.fillStyle = "#02030a";
    this.ctx.fillRect(0, 0, w, h);
  }

  spawn(z) {
    const angle = this.rand() * TAU;
    const radius = 0.08 + Math.sqrt(this.rand()) * 1.25; // keep a clear hole in the middle of the tunnel
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: 0.04 + z * 0.96, c: (this.rand() * this.colors.length) | 0 };
  }

  // ms: time since the start of the trip; speed: 0..1 (see speedAt in travel_core.js).
  frame(ms, speed) {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height, dpr = this.dpr;
    const dt = this.last === null ? 16 : Math.min(50, Math.max(0, ms - this.last));
    this.last = ms;
    const s = Math.max(0, Math.min(1, speed));

    // Twisting tunnel: the vanishing point drifts a little, more at high speed.
    const wob = (0.012 + s * 0.035) * Math.min(w, h);
    const cx = w / 2 + Math.sin(ms / 610) * wob;
    const cy = h / 2 + Math.cos(ms / 830) * wob * 0.7;
    const scale = Math.min(w, h) * 0.55;

    // Partial clear leaves motion trails; the trails get longer as the speed climbs.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgba(2, 3, 10, ${0.55 - s * 0.3})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    this.drawRings(cx, cy, scale, ms, s, dt);
    this.drawStars(cx, cy, scale, s, dt, dpr);
    this.drawCore(cx, cy, Math.min(w, h), s);
    ctx.globalCompositeOperation = "source-over";
  }

  drawStars(cx, cy, scale, s, dt, dpr) {
    const { ctx, colors } = this;
    const dz = (0.0016 + s * s * 0.05) * (dt / 16);
    const trail = 0.004 + s * s * 0.32;      // depth covered by one streak
    const paths = new Map();
    for (const star of this.stars) {
      star.z -= dz;
      if (star.z <= 0.03) Object.assign(star, this.spawn(1));
      const z1 = star.z, z2 = Math.min(1.2, star.z + trail);
      const x1 = cx + (star.x / z1) * scale, y1 = cy + (star.y / z1) * scale;
      const x2 = cx + (star.x / z2) * scale, y2 = cy + (star.y / z2) * scale;
      const band = Math.min(BANDS - 1, Math.floor((1 - z1) * BANDS));
      const key = band * 8 + star.c;
      let p = paths.get(key);
      if (!p) { p = new Path2D(); paths.set(key, p); }
      p.moveTo(x2, y2);
      p.lineTo(x1 + 0.01, y1);
    }
    ctx.lineCap = "round";
    for (const [key, path] of paths) {
      const band = Math.floor(key / 8);
      ctx.strokeStyle = colors[key % 8];
      ctx.globalAlpha = Math.min(1, 0.25 + band * 0.25 + s * 0.2);
      ctx.lineWidth = (0.6 + band * 0.75 + s * band * 0.5) * dpr;
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  drawRings(cx, cy, scale, ms, s, dt) {
    const { ctx, colors } = this;
    this.z0 = (this.z0 + (0.0015 + s * s * 0.03) * (dt / 16)) % (1 / RINGS);
    ctx.lineWidth = 1.5 * this.dpr;
    for (let i = 0; i < RINGS; i++) {
      const z = 1 - i / RINGS + this.z0;
      if (z <= 0.05) continue;
      const r = (0.5 / z) * scale * 0.42;
      const twist = Math.sin(ms / 700 + z * 6) * 0.06 * scale * (1 - z);
      ctx.globalAlpha = Math.min(0.45, (1 - z) * (0.15 + s * 0.5));
      ctx.strokeStyle = colors[i % 3];
      ctx.beginPath();
      ctx.ellipse(cx + twist, cy - twist * 0.6, r, r * 0.92, ms / 2400 + i * 0.3, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawCore(cx, cy, size, s) {
    const { ctx } = this;
    const r = size * (0.05 + s * s * 0.35);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255, 255, 255, ${0.35 + s * 0.6})`);
    g.addColorStop(0.35, `rgba(160, 220, 255, ${0.12 + s * 0.3})`);
    g.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
}

// Small seeded PRNG: every trip draws the same tunnel, which keeps screenshots comparable.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
