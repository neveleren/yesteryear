// Spectrum visualizer for the side panel, in the look of each era's player. There is no audio to
// analyse (the sound plays in a YouTube frame inside another, hidden page), so the bars come from a
// seeded generator with a beat: every song gets its own tempo and pattern, the bars dance while the
// music plays, sweep while it loads, and fall down when it stops.
import { mulberry32 } from "./playlist.js";

// FNV-1a: a stable 32-bit seed for a song.
export function hashSeed(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const tempoFor = (seed) => 88 + (seed % 53); // 88..140 BPM

// Levels 0..1 for n bands (bass first) at time t (seconds). energy 0 = silence.
export function bandLevels(t, n, seed, energy = 1) {
  const count = Math.max(0, Math.floor(n));
  const out = new Array(count).fill(0);
  if (!(energy > 0) || count === 0) return out;
  const rnd = mulberry32(seed);
  const beat = (t * tempoFor(seed)) / 60;
  const kick = Math.max(0, Math.cos(2 * Math.PI * beat)) ** 6;
  const snare = Math.max(0, Math.cos(2 * Math.PI * (beat + 0.5))) ** 10;
  for (let i = 0; i < count; i++) {
    const x = count > 1 ? i / (count - 1) : 0;
    const p1 = rnd() * 6.283, p2 = rnd() * 6.283;
    const f1 = 0.6 + rnd() * 1.8, f2 = 2.1 + rnd() * 3.2;
    const wobble = 0.5 + 0.25 * Math.sin(t * f1 + p1) + 0.25 * Math.sin(t * f2 + p2);
    const tilt = 0.85 - 0.45 * x;
    const hit = kick * Math.max(0, 1 - x * 1.6) * 0.45 + snare * Math.max(0, 1 - Math.abs(x - 0.55) * 2.2) * 0.35;
    out[i] = Math.min(1, Math.max(0, (tilt * (0.3 + 0.6 * wobble) + hit) * energy));
  }
  return out;
}

// Loading: one soft bump that sweeps across the bands.
export function sweepLevels(t, n) {
  const pos = (Math.sin(t * 2.4) + 1) / 2;
  return Array.from({ length: n }, (_, i) => {
    const x = n > 1 ? i / (n - 1) : 0;
    return 0.32 * Math.exp(-((x - pos) ** 2) / 0.012);
  });
}

// ---- drawing -------------------------------------------------------------------------------------

// Winamp 2's default spectrum colours (viscolor.txt of the base skin): index 0 background, 1 grid
// dots, 2..17 bar colour from top (red) to bottom (green), 23 peak dots.
const WINAMP = ["#000000", "#182129", "#ef3110", "#ce2910", "#d65a00", "#d66600", "#d67300", "#c67b08",
  "#dea518", "#d6b521", "#bdde29", "#94de21", "#29ce10", "#32be10", "#39b510", "#319c08", "#299400", "#188408"];
const WINAMP_PEAK = "#969696";

function drawWinamp(ctx, W, H, levels, peaks, s) {
  // Draw at Winamp's own 76 x 16 pixels, then scale up without smoothing.
  const small = s.small || (s.small = Object.assign(ctx.canvas.ownerDocument.createElement("canvas"), { width: 76, height: 16 }));
  const c = small.getContext("2d");
  c.fillStyle = WINAMP[0];
  c.fillRect(0, 0, 76, 16);
  c.fillStyle = WINAMP[1];
  for (let y = 1; y < 16; y += 2) for (let x = 0; x < 76; x += 2) c.fillRect(x, y, 1, 1);
  levels.forEach((v, i) => {
    const x = i * 4;
    const h = Math.round(v * 16);
    for (let row = 16 - h; row < 16; row++) {
      c.fillStyle = WINAMP[2 + row];
      c.fillRect(x, row, 3, 1);
    }
    const p = Math.round(peaks[i] * 16);
    if (p > 0) {
      c.fillStyle = WINAMP_PEAK;
      c.fillRect(x, Math.max(0, 16 - p - 1), 3, 1);
    }
  });
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(small, 0, 0, W, H);
}

// Windows Media Player 11 "Bars and Waves": glassy blue bars over a reflection.
function drawWmp(ctx, W, H, levels, peaks) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#02040c");
  bg.addColorStop(1, "#08142e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const base = Math.round(H * 0.74);
  const n = levels.length;
  const step = W / n;
  const bw = Math.max(2, step * 0.72);
  const grad = ctx.createLinearGradient(0, base, 0, 0);
  grad.addColorStop(0, "#0b3fb5");
  grad.addColorStop(0.55, "#2f8cff");
  grad.addColorStop(1, "#d6f1ff");
  levels.forEach((v, i) => {
    const x = i * step + (step - bw) / 2;
    const h = Math.max(1, v * base * 0.95);
    ctx.fillStyle = grad;
    ctx.fillRect(x, base - h, bw, h);
    ctx.globalAlpha = 0.22;
    ctx.fillRect(x, base + 1, bw, Math.min(H - base - 1, h * 0.35));
    ctx.globalAlpha = 1;
    const p = peaks[i] * base * 0.95;
    if (p > 1) {
      ctx.fillStyle = "#e8f6ff";
      ctx.fillRect(x, base - p - 2, bw, 2);
    }
  });
  ctx.fillStyle = "rgba(120,170,255,.35)";
  ctx.fillRect(0, base, W, 1);
}

// iTunes visualizer (Magnetosphere era): glowing particles that swirl with the bass.
function drawItunes(ctx, W, H, levels, peaks, s) {
  if (!s.particles || s.particles.seed !== s.seed) {
    const rnd = mulberry32(s.seed || 1);
    s.particles = Array.from({ length: 56 }, () => ({
      a: rnd() * 6.283, r: 0.15 + rnd() * 0.85, sp: (0.3 + rnd() * 0.9) * (rnd() < 0.5 ? -1 : 1),
      k: 0.6 + rnd() * 0.9, hue: [195, 210, 280, 320, 30][Math.floor(rnd() * 5)], size: 0.6 + rnd()
    }));
    s.particles.seed = s.seed;
  }
  const bass = (levels[0] + levels[1] + levels[2]) / 3;
  const mid = levels.reduce((a, b) => a + b, 0) / Math.max(1, levels.length);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = s.energy > 0.02 ? "rgba(0,0,0,0.24)" : "#000";
  ctx.fillRect(0, 0, W, H);
  if (s.energy <= 0.02 && mid < 0.01) return;
  ctx.globalCompositeOperation = "lighter";
  const m = Math.min(W, H);
  const cx = W / 2 + Math.sin(s.t * 0.37) * W * 0.16;
  const cy = H / 2 + Math.sin(s.t * 0.53) * H * 0.14;
  for (const p of s.particles) {
    p.a += p.sp * s.dt * (0.35 + mid * 1.8);
    const rr = p.r * m * (0.42 + bass * 0.5);
    const x = cx + Math.cos(p.a) * rr * 1.5;
    const y = cy + Math.sin(p.a * p.k) * rr;
    const size = p.size * (1.5 + bass * 5) * Math.max(mid * 1.6, 0.15);
    if (size < 0.4) continue;
    const g = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
    g.addColorStop(0, `hsla(${p.hue},100%,72%,${Math.min(0.75, 0.25 + mid)})`);
    g.addColorStop(1, `hsla(${p.hue},100%,50%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, size * 3, 0, 6.283);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

// Spotify: rounded bars, mirrored around a middle line, over the cover gradient (drawn by CSS);
// they stay above the cover title at the bottom.
function drawSpotify(ctx, W, H, levels) {
  ctx.clearRect(0, 0, W, H);
  const n = levels.length;
  const step = W / n;
  const bw = Math.max(2, step * 0.5);
  const mid = H * 0.4;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  levels.forEach((v, i) => {
    const h = Math.max(bw, v * H * 0.58);
    const x = i * step + (step - bw) / 2;
    roundRect(ctx, x, mid - h / 2, bw, h, bw / 2);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

export const LOOKS = Object.freeze({
  winamp: { bands: 19, draw: drawWinamp, pixel: true },
  wmp: { bands: 24, draw: drawWmp },
  itunes: { bands: 16, draw: drawItunes },
  spotify: { bands: 26, draw: drawSpotify }
});

// mode: "play" | "load" | "idle". Draws at most ~30 frames per second and stops drawing once
// everything has fallen down.
export function createVisualizer(canvas, { clock = () => performance.now() / 1000 } = {}) {
  const ctx = canvas.getContext("2d");
  const s = { skin: "winamp", seed: 1, mode: "idle", energy: 0, t: 0, dt: 0, small: null, particles: null };
  let levels = [];
  let peaks = [];
  let holds = [];
  let raf = 0;
  let last = clock();
  let lastDraw = -1;
  let W = 0;
  let H = 0;

  function look() { return LOOKS[s.skin] || LOOKS.winamp; }

  function resetBands() {
    const n = look().bands;
    levels = new Array(n).fill(0);
    peaks = new Array(n).fill(0);
    holds = new Array(n).fill(0);
  }

  function resize() {
    const dpr = look().pixel ? 1 : Math.min(2, globalThis.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width * dpr));
    H = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    draw();
  }

  function draw() {
    look().draw(ctx, W, H, levels, peaks, s);
  }

  function frame() {
    raf = 0;
    const t = clock();
    const dt = Math.min(0.1, Math.max(0, t - last));
    last = t;
    if (t - lastDraw < 1 / 32) { schedule(); return; }
    lastDraw = t;
    s.t = t;
    s.dt = dt;
    const target = s.mode === "play" ? 1 : 0;
    s.energy += (target - s.energy) * Math.min(1, dt * (target > s.energy ? 5 : 2.2));
    const n = levels.length;
    const raw = s.mode === "load" ? sweepLevels(t, n) : bandLevels(t, n, s.seed, s.energy);
    for (let i = 0; i < n; i++) {
      levels[i] = raw[i] > levels[i] ? levels[i] + (raw[i] - levels[i]) * Math.min(1, dt * 20) : Math.max(raw[i], levels[i] - dt * 1.5);
      if (levels[i] >= peaks[i]) { peaks[i] = levels[i]; holds[i] = 0.35; }
      else if (holds[i] > 0) holds[i] -= dt;
      else peaks[i] = Math.max(levels[i], peaks[i] - dt * 0.7);
    }
    draw();
    const moving = s.mode !== "idle" || s.energy > 0.01 || peaks.some((p) => p > 0.004);
    if (moving) schedule();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resetBands();
  resize();

  return {
    setSkin(skin) {
      if (skin === s.skin || !LOOKS[skin]) return;
      s.skin = skin;
      s.small = null;
      resetBands();
      resize();
      schedule();
    },
    setTrack(text) {
      const seed = hashSeed(text || "");
      if (seed !== s.seed) { s.seed = seed; s.particles = null; }
    },
    setMode(mode) {
      const m = mode === "play" || mode === "load" ? mode : "idle";
      if (m === s.mode) return;
      s.mode = m;
      last = clock();
      schedule();
    },
    resize,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect();
    }
  };
}
