// Yesteryear tour: a small player for Microsoft Agent characters (Clippy, Rover), no dependencies.
// Character data is the clippy.js format, vendored in ../vendor/clippy/agents/<id>/: one sprite sheet
// (map.png), animations made of frames (duration in ms + sprite offsets), random branches inside an
// animation (loops, variations) and "exit branches" that lead back to the rest pose once the
// animation is asked to stop. Semantics follow clippy.js (Animator._getNextAnimationFrame / _step).
//
// Top half: pure helpers (node --test imports this file). Bottom half: Agent and Balloon, which touch
// the DOM only when constructed.

export const AGENTS_BASE = "../vendor/clippy/agents/";

// How a play() ended: ran to its last frame, was replaced or cut, or does not exist.
export const END = Object.freeze({ EXITED: "exited", INTERRUPTED: "interrupted", MISSING: "missing" });

const isPosInt = (v) => Number.isInteger(v) && v > 0;

// Validates clippy.js agent data and returns a clean copy:
// { framesize: [w, h], overlayCount, sounds: [ids], animations: { name: { frames, useExitBranching } } }
// frame = { duration, images: [[x, y], ...], sound?, exitBranch?, branching?: { branches: [{ frameIndex, weight }] } }
export function normalizeAgentData(raw, label = "agent") {
  const fail = (path, why) => { throw new TypeError(`${label}: ${path} ${why}`); };
  if (!raw || typeof raw !== "object") fail("data", "is not an object");
  const size = Array.isArray(raw.framesize) ? raw.framesize : [];
  if (size.length !== 2 || !size.every(isPosInt)) fail("framesize", "must be [width, height] in pixels");
  const overlayCount = raw.overlayCount === undefined ? 1 : raw.overlayCount;
  if (!isPosInt(overlayCount) || overlayCount > 8) fail("overlayCount", "must be 1..8");
  const sounds = Array.isArray(raw.sounds) ? raw.sounds.map(String) : [];
  if (!raw.animations || typeof raw.animations !== "object") fail("animations", "are missing");

  const animations = {};
  for (const [name, anim] of Object.entries(raw.animations)) {
    const frames = anim && anim.frames;
    if (!Array.isArray(frames) || !frames.length) fail(`animations.${name}.frames`, "must be a non-empty list");
    const n = frames.length;
    const frameIndex = (v, path) => {
      if (!Number.isInteger(v) || v < 0 || v >= n) fail(path, `must be a frame index 0..${n - 1}`);
      return v;
    };
    animations[name] = {
      useExitBranching: Boolean(anim.useExitBranching),
      frames: frames.map((f, i) => {
        const path = `animations.${name}.frames[${i}]`;
        if (!f || typeof f !== "object") fail(path, "is not an object");
        const duration = f.duration === undefined ? 100 : Number(f.duration);
        if (!Number.isFinite(duration) || duration < 0) fail(`${path}.duration`, "must be a number >= 0");
        const images = (f.images || []).map((xy, k) => {
          if (!Array.isArray(xy) || xy.length !== 2 || !xy.every((v) => Number.isFinite(v) && v >= 0)) {
            fail(`${path}.images[${k}]`, "must be [x, y]");
          }
          return [xy[0], xy[1]];
        });
        const out = { duration, images };
        if (f.sound !== undefined && f.sound !== null) out.sound = String(f.sound);
        if (f.exitBranch !== undefined) out.exitBranch = frameIndex(f.exitBranch, `${path}.exitBranch`);
        if (f.branching) {
          const branches = (f.branching.branches || []).map((b, k) => {
            const weight = Number(b && b.weight);
            if (!Number.isFinite(weight) || weight < 0 || weight > 100) fail(`${path}.branching.branches[${k}].weight`, "must be 0..100");
            return { frameIndex: frameIndex(b.frameIndex, `${path}.branching.branches[${k}].frameIndex`), weight };
          });
          if (branches.length) out.branching = { branches };
        }
        return out;
      })
    };
  }
  if (!Object.keys(animations).length) fail("animations", "are empty");
  return { framesize: [size[0], size[1]], overlayCount, sounds, animations };
}

// The frame after `index` (null = start). While exiting, a frame's exitBranch wins; otherwise one
// random draw picks a branch by weight (percent), and the rest falls through to the next frame.
// One change to clippy.js: while exiting, branches that loop (back to this or an earlier frame) are
// not taken, so a stop request always ends the animation (Clippy's "Writing" has a frame that loops
// on itself 80% of the time and has no exit branch).
export function nextFrameIndex(anim, index, exiting = false, random = Math.random) {
  const frames = anim.frames;
  if (index === null || index === undefined || index < 0) return 0;
  const frame = frames[Math.min(index, frames.length - 1)];
  let next = index + 1;
  if (exiting && frame.exitBranch !== undefined) next = frame.exitBranch;
  else if (frame.branching) {
    let rnd = random() * 100;
    for (const branch of frame.branching.branches) {
      if (rnd <= branch.weight) {
        if (!exiting || branch.frameIndex > index) next = branch.frameIndex;
        break;
      }
      rnd -= branch.weight;
    }
  }
  return Math.min(next, frames.length - 1);
}

// ---- Timing of a way out ------------------------------------------------------------------------
export const EXIT_FRAME_MS = 150; // longest a frame stays while an animation winds down by itself (holdMs)
export const HURRY_FRAME_MS = 40; // ...and while it hurries out because the guide moves on (exit())
export const MIN_FRAME_MS = 16;   // a hurried way out never flips faster (one screen refresh); it skips frames
export const EXIT_GRACE_MS = 150; // exit(maxMs) cuts only this late (timers of a background tab lag)

const exitPlans = new WeakMap();  // anim -> exitFrames()

// Worst case, per frame: how many frames an animation still shows once it is exiting, that frame
// and the last one included (exit branches taken, loops never, any forward branch possible).
// Infinity if exiting could go round in a circle (the data tests rule that out).
export function exitFrames(anim) {
  let left = exitPlans.get(anim);
  if (left) return left;
  const n = anim.frames.length;
  left = new Array(n).fill(0); // 0: not known yet, -1: on the path being followed
  const visit = (i) => {
    if (i >= n - 1) return 1;
    if (left[i] > 0) return left[i];
    if (left[i] < 0) return Infinity;
    left[i] = -1;
    const f = anim.frames[i];
    const next = f.exitBranch !== undefined ? [f.exitBranch]
      : [i + 1, ...(f.branching ? f.branching.branches.map((b) => b.frameIndex).filter((j) => j > i) : [])];
    left[i] = 1 + Math.max(...next.map(visit));
    return left[i];
  };
  for (let i = n - 1; i >= 0; i--) visit(i);
  left[n - 1] = 1;
  exitPlans.set(anim, left);
  return left;
}

// How long a frame stays while the animation hurries out: HURRY_FRAME_MS at most, less when the
// frames left (this one included) would not fit the time left, never below MIN_FRAME_MS.
export function hurriedFrameMs(duration, framesLeft, msLeft) {
  return Math.min(duration, HURRY_FRAME_MS, Math.max(MIN_FRAME_MS, msLeft / framesLeft));
}

// One step of a hurried way out from frame `index`, msLeft before its deadline: the next frame to
// draw and how long it stays. Frames that do not fit at MIN_FRAME_MS each are skipped (neither drawn
// nor heard), so even a long way out ends in time instead of being cut.
export function hurriedNext(anim, index, msLeft, random = Math.random) {
  const left = exitFrames(anim);
  const last = anim.frames.length - 1;
  let next = nextFrameIndex(anim, index, true, random);
  for (let k = 0; next < last && k < anim.frames.length && left[next] * MIN_FRAME_MS > msLeft; k++) {
    next = nextFrameIndex(anim, next, true, random);
  }
  return { index: next, ms: hurriedFrameMs(anim.frames[next].duration, left[next], msLeft) };
}

// Plays an animation on paper: the frame indexes visited until the last frame (or `limit` steps).
// `exitAfter` = after how many steps the exit was requested (Infinity = never).
export function simulate(anim, { random = Math.random, exitAfter = Infinity, limit = 5000 } = {}) {
  const path = [];
  let index = null;
  for (let step = 0; step < limit; step++) {
    index = nextFrameIndex(anim, index, step >= exitAfter, random);
    path.push(index);
    if (index >= anim.frames.length - 1) break;
  }
  return path;
}

// Direction from the character's point of view, as clippy.js names its animations: a target on the
// SCREEN's left is the character's "Right" (it faces the viewer). `from`/`to` are points.
export function directionTo(from, to) {
  const a = from.y - to.y;
  const b = from.x - to.x;
  const r = Math.round((180 * Math.atan2(a, b)) / Math.PI);
  if (r >= -45 && r < 45) return "Right";
  if (r >= 45 && r < 135) return "Up";
  if (r >= -135 && r < -45) return "Down";
  return "Left";
}

// "GestureLeft" etc. toward a point, else "LookLeft" etc., else null.
export function gestureFor(data, from, to) {
  const dir = directionTo(from, to);
  for (const name of [`Gesture${dir}`, `Look${dir}`]) if (data.animations[name]) return name;
  return null;
}

// A walking animation for the way from -> to, if the character has one (MoveLeft/Right/Up/Down).
export function moveAnimationFor(data, from, to) {
  const name = `Move${directionTo(from, to)}`;
  return data.animations[name] ? name : null;
}

export function idleAnimations(data) {
  return Object.keys(data.animations).filter((name) => name.startsWith("Idle"));
}

export function easeInOut(t) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// Glide time for a distance in px: short hops stay quick, long trips never drag.
export function glideDuration(distance) {
  if (!(distance > 1)) return 0;
  return Math.round(Math.min(1300, 380 + distance * 0.9));
}

// Position at progress t (0..1). style.arc lifts the path in the middle (Clippy floats over);
// style.hops adds that many small bounces (Rover trots). Both are 0 at the start and the end.
export function glidePoint(from, to, t, style = {}) {
  const x0 = Math.min(1, Math.max(0, t));
  const e = easeInOut(x0);
  let x = from.x + (to.x - from.x) * e;
  let y = from.y + (to.y - from.y) * e;
  if (style.arc) y -= Math.sin(Math.PI * x0) * style.arc;
  if (style.hops) y -= Math.abs(Math.sin(Math.PI * x0 * style.hops)) * (style.hopHeight || 6);
  return { x, y };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Where a speech balloon of `size` goes next to the character rect `anchor`, inside `bounds`.
// It sits above (or below) the character with its tail on the character's head, opening toward
// `prefer` ("left"/"right"); the first candidate that fits and covers least of `avoid` wins.
// Returns { left, top, side: "top"|"bottom", opens: "left"|"right", tailX } (tailX: from the left edge).
export function placeBalloon({ anchor, size, bounds, avoid = [], prefer = "right", gap = 16, margin = 8, tailInset = 30 }) {
  const cx = anchor.x + anchor.w / 2;
  const opens = prefer === "left" ? ["left", "right"] : ["right", "left"];
  let best = null;
  let order = 0;
  for (const side of ["top", "bottom"]) {
    for (const open of opens) {
      const wantLeft = open === "right" ? cx - tailInset : cx - size.w + tailInset;
      const minLeft = bounds.x + margin;
      const maxLeft = Math.max(minLeft, bounds.x + bounds.w - margin - size.w);
      const left = clamp(wantLeft, minLeft, maxLeft);
      const top = side === "top" ? anchor.y - size.h - gap : anchor.y + anchor.h + gap;
      const outside = Math.max(0, bounds.y + margin - top) + Math.max(0, top + size.h - (bounds.y + bounds.h - margin));
      const rect = { x: left, y: top, w: size.w, h: size.h };
      const covered = avoid.reduce((sum, r) => sum + overlapArea(rect, r), 0);
      const score = outside * 1e6 + covered * 10 + order++;
      if (!best || score < best.score) {
        best = { score, left, top, side, opens: open, tailX: clamp(cx - left, 16, size.w - 16) };
      }
    }
  }
  const { score, ...placement } = best;
  return placement;
}

// ---- DOM ----------------------------------------------------------------------------------------
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const SVG_NS = "http://www.w3.org/2000/svg";

// Loads one character: animation data (validated), the sprite sheet (decoded before first use) and
// the URLs of its sounds. `base` is the folder that holds <id>/agent.json.
export async function loadAgent(id, base = AGENTS_BASE) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad agent id ${id}`);
  const root = new URL(`${base}${id}/`, document.baseURI);
  const res = await fetch(new URL("agent.json", root));
  if (!res.ok) throw new Error(`${id}: agent.json HTTP ${res.status}`);
  const data = normalizeAgentData(await res.json(), id);
  const mapUrl = new URL("map.png", root).href;
  const img = new Image();
  img.src = mapUrl;
  await img.decode();
  const soundUrls = Object.fromEntries(data.sounds.map((s) => [s, new URL(`sounds/${s}.mp3`, root).href]));
  return { id, data, mapUrl, soundUrls };
}

export class Agent {
  // def = loadAgent() result. Coordinates are px in `parent` (which must be positioned).
  constructor(parent, def, { muted = true, volume = 0.6, moveStyle = {}, lookWhileMoving = false, random = Math.random } = {}) {
    this.def = def;
    this.data = def.data;
    [this.w, this.h] = def.data.framesize;
    this.muted = muted;
    this.volume = volume;
    this.moveStyle = moveStyle;
    this.lookWhileMoving = lookWhileMoving;
    this.random = random;
    this.x = 0;
    this.y = 0;
    this._run = null;       // the animation now playing: { name, exiting, deadline, index, done, resolve, holdTimer }
    this._timer = null;     // pending frame step
    this._next = null;      // ...and its callback, so exit() can bring it forward
    this._glide = null;     // { raf, resolve }
    this._idleGen = 0;
    this._idleTimer = null;
    this._audio = new Map();

    this.el = document.createElement("div");
    this.el.className = "yy-agent";
    this.el.dataset.agent = def.id;
    this.el.style.width = `${this.w}px`;
    this.el.style.height = `${this.h}px`;
    this.el.hidden = true;
    this.layers = [];
    for (let i = 0; i < this.data.overlayCount; i++) {
      const layer = document.createElement("div");
      layer.className = "yy-agent-layer";
      layer.style.backgroundImage = `url("${def.mapUrl}")`;
      this.el.append(layer);
      this.layers.push(layer);
    }
    parent.append(this.el);
    this.rest();
  }

  has(name) { return Boolean(name && this.data.animations[name]); }
  animations() { return Object.keys(this.data.animations); }
  get playing() { return this._run ? this._run.name : null; }
  rect() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
  center() { return { x: this.x + this.w / 2, y: this.y + this.h / 2 }; }

  place(x, y) {
    this._cancelGlide();
    this._setPos(x, y);
  }

  show() { this.el.hidden = false; }
  hide() { this.el.hidden = true; }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.muted) for (const audio of this._audio.values()) audio.pause();
  }

  // Draws the rest pose (no animation running).
  rest() {
    const pose = this.data.animations.RestPose || Object.values(this.data.animations)[0];
    this._draw(pose.frames[0]);
  }

  // Starts `name` now, replacing whatever plays. Resolves with END.* when it is over. holdMs: ask
  // the animation to exit after that long (looping animations would otherwise hold their pose).
  play(name, { holdMs = 0 } = {}) {
    this._end(END.INTERRUPTED);
    const anim = this.data.animations[name];
    if (!anim) return Promise.resolve(END.MISSING);
    const run = { name, exiting: false, deadline: 0, index: null, resolve: null, holdTimer: null };
    run.done = new Promise((resolve) => { run.resolve = resolve; });
    this._run = run;
    if (holdMs > 0) run.holdTimer = setTimeout(() => { run.exiting = true; }, holdMs);
    this._step(anim, run);
    return run.done;
  }

  // Asks the current animation to hurry out through its exit branches so that it ends within maxMs:
  // the frame on screen is not waited out (some hold for over a second), the way out plays briskly
  // and a long one skips frames (hurriedNext). Cut only if timers fall far behind.
  exit(maxMs = 1000) {
    const run = this._run;
    if (!run) return Promise.resolve(END.EXITED);
    const deadline = performance.now() + maxMs;
    if (!run.deadline || deadline < run.deadline) {
      run.deadline = deadline;
      run.exiting = true;
      if (this._next) {
        const anim = this.data.animations[run.name];
        clearTimeout(this._timer);
        this._timer = setTimeout(this._next, hurriedFrameMs(anim.frames[run.index].duration, exitFrames(anim)[run.index], maxMs));
      }
    }
    return new Promise((resolve) => {
      const cut = setTimeout(() => {
        if (this._run === run) {
          this._end(END.INTERRUPTED);
          this.rest();
        }
      }, maxMs + EXIT_GRACE_MS);
      run.done.then((how) => { clearTimeout(cut); resolve(how); });
    });
  }

  // Stops at once and shows the rest pose.
  stop() {
    this._end(END.INTERRUPTED);
    this.rest();
  }

  // Random idle animations while nothing else plays. names: which ones (default: Idle*).
  startIdle({ names, delay = [3500, 7000], holdMs = 9000 } = {}) {
    this.stopIdle();
    const list = (names || idleAnimations(this.data)).filter((n) => this.has(n));
    if (!list.length) return;
    const gen = this._idleGen;
    const schedule = () => {
      const wait = delay[0] + this.random() * (delay[1] - delay[0]);
      this._idleTimer = setTimeout(async () => {
        if (gen !== this._idleGen) return;
        if (!this._run) {
          await this.play(list[Math.floor(this.random() * list.length)], { holdMs });
          if (gen !== this._idleGen) return;
        }
        schedule();
      }, wait);
    };
    schedule();
  }

  stopIdle() {
    this._idleGen++;
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  // Glides to (x, y). Plays Move<Dir> during the trip if the character has one; otherwise, with
  // lookWhileMoving, Look<Dir>. Resolves "arrived" or "cancelled" (a newer move/place won).
  async moveTo(x, y, { duration, style = this.moveStyle } = {}) {
    this._cancelGlide();
    const from = { x: this.x, y: this.y };
    const ms = duration === undefined ? glideDuration(Math.hypot(x - from.x, y - from.y)) : duration;
    if (ms <= 0 || reducedMotion() || this.el.hidden) {
      this._setPos(x, y);
      return "arrived";
    }
    const a = this.center();
    const b = { x: x + this.w / 2, y: y + this.h / 2 };
    const walk = moveAnimationFor(this.data, a, b) || (this.lookWhileMoving ? this._lookName(a, b) : null);
    let walkRun = null;
    if (walk) {
      this.play(walk);
      walkRun = this._run;
    }
    const result = await new Promise((resolve) => {
      const t0 = performance.now();
      const glide = { raf: 0, resolve };
      const frame = (now) => {
        if (this._glide !== glide) return;
        const t = Math.min(1, (now - t0) / ms);
        const p = glidePoint(from, { x, y }, t, style);
        this._setPos(p.x, p.y);
        if (t < 1) glide.raf = requestAnimationFrame(frame);
        else {
          this._glide = null;
          resolve("arrived");
        }
      };
      this._glide = glide;
      glide.raf = requestAnimationFrame(frame);
    });
    // Wind the walk down, but do not wait for it: the caller usually starts the next animation at once.
    // Only our own walk: a newer moveTo() may already have started its own.
    if (result === "arrived" && walkRun && this._run === walkRun) this.exit(700);
    return result;
  }

  destroy() {
    this.stopIdle();
    this._cancelGlide();
    this._end(END.INTERRUPTED);
    for (const audio of this._audio.values()) { audio.pause(); audio.removeAttribute("src"); }
    this._audio.clear();
    this.el.remove();
  }

  // ---- internals ----
  _lookName(a, b) {
    const name = `Look${directionTo(a, b)}`;
    return this.has(name) ? name : null;
  }

  _setPos(x, y) {
    this.x = x;
    this.y = y;
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  _cancelGlide() {
    const glide = this._glide;
    if (!glide) return;
    this._glide = null;
    cancelAnimationFrame(glide.raf);
    glide.resolve("cancelled");
  }

  _step(anim, run) {
    if (this._run !== run) return;
    let ms;
    if (run.deadline) { // hurrying out (exit())
      const next = hurriedNext(anim, run.index, run.deadline - performance.now(), this.random);
      run.index = next.index;
      ms = next.ms;
    } else {
      run.index = nextFrameIndex(anim, run.index, run.exiting, this.random);
      const duration = anim.frames[run.index].duration;
      ms = run.exiting ? Math.min(duration, EXIT_FRAME_MS) : duration;
    }
    const frame = anim.frames[run.index];
    this._draw(frame);
    if (frame.sound) this._sound(frame.sound);
    const last = run.index >= anim.frames.length - 1;
    this._next = () => {
      if (this._run !== run) return;
      if (last) this._end(END.EXITED);
      else this._step(anim, run);
    };
    this._timer = setTimeout(this._next, ms);
  }

  _end(how) {
    const run = this._run;
    if (!run) return;
    this._run = null;
    clearTimeout(this._timer);
    clearTimeout(run.holdTimer);
    this._timer = null;
    this._next = null;
    run.resolve(how);
  }

  _draw(frame) {
    const images = frame.images || [];
    this.layers.forEach((layer, i) => {
      const xy = images[i];
      layer.hidden = !xy;
      if (xy) layer.style.backgroundPosition = `${-xy[0]}px ${-xy[1]}px`;
    });
  }

  _sound(id) {
    if (this.muted || this.el.hidden) return;
    const url = this.def.soundUrls && this.def.soundUrls[id];
    if (!url) return;
    let audio = this._audio.get(id);
    if (!audio) {
      audio = new Audio(url);
      this._audio.set(id, audio);
    }
    audio.volume = this.volume;
    try {
      audio.currentTime = 0;
      const p = audio.play();
      if (p && p.catch) p.catch(() => {}); // autoplay rules or a missing file: stay silent
    } catch { /* ignore */ }
  }
}

// The Office 97 assistant balloon: pale yellow, thin black line, round corners, a wedge-shaped tail
// on the character's head. Content is any DOM node.
export class Balloon {
  constructor(parent) {
    this.el = document.createElement("div");
    this.el.className = "yy-balloon";
    this.el.hidden = true;
    this.body = document.createElement("div");
    this.body.className = "yy-balloon-body";
    this.body.setAttribute("aria-live", "polite"); // a live region must exist before its text changes
    const tail = document.createElementNS(SVG_NS, "svg");
    tail.setAttribute("class", "yy-balloon-tail");
    tail.setAttribute("width", "24");
    tail.setAttribute("height", "18");
    tail.setAttribute("viewBox", "0 0 24 18");
    tail.setAttribute("aria-hidden", "true");
    const fill = document.createElementNS(SVG_NS, "polygon");
    fill.setAttribute("points", "0,0 24,0 6,17");
    fill.setAttribute("class", "fill");
    const line = document.createElementNS(SVG_NS, "polyline");
    line.setAttribute("points", "0.5,0.5 6,17 23.5,0.5");
    line.setAttribute("class", "line");
    tail.append(fill, line);
    this.tail = tail;
    this.el.append(this.body, tail);
    parent.append(this.el);
    this.placement = null;
  }

  get visible() { return !this.el.hidden; }

  // opts: { bounds, avoid, prefer } as for placeBalloon().
  show(content, anchor, opts) {
    this.body.replaceChildren(content);
    this.el.hidden = false;
    this.el.classList.remove("pop");
    this.reposition(anchor, opts);
    void this.el.offsetWidth; // restart the appear animation
    this.el.classList.add("pop");
    return this.placement;
  }

  reposition(anchor, { bounds, avoid = [], prefer = "right" } = {}) {
    if (this.el.hidden) return null;
    const size = { w: this.el.offsetWidth, h: this.el.offsetHeight };
    const p = placeBalloon({ anchor, size, bounds, avoid, prefer });
    this.el.style.left = `${Math.round(p.left)}px`;
    this.el.style.top = `${Math.round(p.top)}px`;
    this.el.dataset.side = p.side;
    // The wedge leans toward the character: its tip is 6 px from the left end of the drawing.
    const flip = p.tailX > size.w / 2;
    this.tail.style.left = `${Math.round(flip ? p.tailX - 18 : p.tailX - 6)}px`;
    this.tail.style.transform = `${p.side === "bottom" ? "scaleY(-1)" : ""} ${flip ? "scaleX(-1)" : ""}`.trim() || "none";
    this.placement = p;
    return p;
  }

  hide() {
    this.el.hidden = true;
    this.placement = null;
  }

  destroy() { this.el.remove(); }
}
