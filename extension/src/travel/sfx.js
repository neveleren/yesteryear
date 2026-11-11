// Synthesized sound for the trip (WebAudio, no audio files): a rising whoosh with an engine whine, the boom
// of the flash, and the thunk + hum of a CRT powering on. Chrome's autoplay policy decides: when the page may
// not start audio on its own, the context stays suspended and every call here is silently skipped.

export function createSfx() {
  let ctx = null;
  let comp = null;  // compressor in front of the speakers
  let out = null;   // master gain; replaced by hush() so sounds already scheduled go nowhere
  let noise = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC({ latencyHint: "interactive" });
    } catch (_) {
      return null;
    }
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);
    out = freshOut();
    return ctx;
  }

  // Resolves true when sound can play now. Never waits long: a blocked context resumes only after a gesture.
  async function unlock(waitMs = 250) {
    if (!ensure()) return false;
    if (ctx.state === "running") return true;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, waitMs))]);
    } catch (_) { /* blocked: stay silent */ }
    return ctx.state === "running";
  }

  const running = () => Boolean(ctx) && ctx.state === "running";

  function freshOut() {
    const g = ctx.createGain();
    g.gain.value = 0.55;
    g.connect(comp);
    return g;
  }

  function noiseBuffer() {
    if (noise) return noise;
    const len = Math.floor(ctx.sampleRate * 2);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;              // a darker noise sounds more like air
      data[i] = white * 0.55 + brown * 3.2;
    }
    return noise;
  }

  function env(param, points) {
    param.cancelScheduledValues(points[0][0]);
    param.setValueAtTime(points[0][1], points[0][0]);
    for (const [t, v] of points.slice(1)) param.exponentialRampToValueAtTime(Math.max(0.0001, v), t);
  }

  function noiseSource(at, dur) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    src.loop = true;
    src.start(at);
    src.stop(at + dur + 0.05);
    return src;
  }

  // Rising rush of air plus an engine whine, `dur` seconds long, peaking at the end.
  function whoosh(dur = 3.4, delay = 0) {
    if (!running()) return;
    const at = ctx.currentTime + delay;
    const end = at + dur;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.9;
    env(bp.frequency, [[at, 160], [end, 3600]]);
    const air = ctx.createGain();
    env(air.gain, [[at, 0.0001], [at + dur * 0.25, 0.08], [end - 0.05, 0.55], [end + 0.25, 0.0001]]);
    noiseSource(at, dur + 0.3).connect(bp).connect(air).connect(out);

    for (const [type, f0, f1, level] of [["sawtooth", 46, 420, 0.07], ["square", 92, 840, 0.025]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      env(osc.frequency, [[at, f0], [end, f1]]);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      env(lp.frequency, [[at, 240], [end, 2600]]);
      const g = ctx.createGain();
      env(g.gain, [[at, 0.0001], [end - 0.1, level], [end + 0.15, 0.0001]]);
      osc.connect(lp).connect(g).connect(out);
      osc.start(at);
      osc.stop(end + 0.2);
    }
  }

  // The flash: a deep drop and a burst of rumble.
  function boom(delay = 0) {
    if (!running()) return;
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    env(osc.frequency, [[at, 140], [at + 0.8, 30]]);
    const g = ctx.createGain();
    env(g.gain, [[at, 0.9], [at + 1.1, 0.0001]]);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 1.2);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    env(lp.frequency, [[at, 2400], [at + 0.7, 140]]);
    const rumble = ctx.createGain();
    env(rumble.gain, [[at, 0.7], [at + 0.9, 0.0001]]);
    noiseSource(at, 0.95).connect(lp).connect(rumble).connect(out);
  }

  // CRT power-on: a relay thunk, then a short mains hum that fades away.
  function crt(delay = 0) {
    if (!running()) return;
    const at = ctx.currentTime + delay;
    const thunk = ctx.createOscillator();
    thunk.type = "triangle";
    env(thunk.frequency, [[at, 210], [at + 0.09, 55]]);
    const tg = ctx.createGain();
    env(tg.gain, [[at, 0.5], [at + 0.16, 0.0001]]);
    thunk.connect(tg).connect(out);
    thunk.start(at);
    thunk.stop(at + 0.2);

    for (const [f, level] of [[60, 0.05], [120, 0.03], [180, 0.012]]) {
      const hum = ctx.createOscillator();
      hum.frequency.value = f;
      const hg = ctx.createGain();
      env(hg.gain, [[at + 0.03, 0.0001], [at + 0.12, level], [at + 0.9, 0.0001]]);
      hum.connect(hg).connect(out);
      hum.start(at + 0.03);
      hum.stop(at + 0.95);
    }
  }

  // Stops everything at once (skip, leaving the page): fade the master out, then cut it loose.
  function hush() {
    if (!ctx || !out) return;
    const old = out;
    out = freshOut();
    try {
      old.gain.cancelScheduledValues(ctx.currentTime);
      old.gain.setValueAtTime(old.gain.value, ctx.currentTime);
      old.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.06);
    } catch (_) { /* already silent */ }
    setTimeout(() => { try { old.disconnect(); } catch (_) { /* gone */ } }, 150);
  }

  return { unlock, running, whoosh, boom, crt, hush, get state() { return ctx ? ctx.state : "none"; } };
}
