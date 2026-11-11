// Unit tests for the tour's steps and guides (extension/src/tour/tour_core.js): every step names
// controls that exist in the popup, every guide has a different, existing animation for each step,
// texts stay short and plain, and the layout rules put the guide somewhere new for every line.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentData, exitFrames, hurriedFrameMs, hurriedNext } from "../../extension/src/tour/agent.js";
import {
  STEPS, AGENTS, AGENT_IDS, DEFAULT_AGENT, GESTURE, TOUR_KEYS, EXIT_MS, stepContent, animFor, agentSpot, unionRect,
  padRect, centerOf, parseHash, resolveAgentId, doneText, keyAction
} from "../../extension/src/tour/tour_core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = Object.fromEntries(AGENT_IDS.map((id) => [id, normalizeAgentData(
  JSON.parse(readFileSync(join(ROOT, "extension/src/vendor/clippy/agents", id, "agent.json"), "utf8")), id)]));
const POPUP = readFileSync(join(ROOT, "extension/src/ui/popup.html"), "utf8");
// Arrive with other modules: the "?" button (this one's integration) and the player's mini player.
const OPTIONAL_IDS = new Set(["help", "mini-player"]);

// A popup window and its control rows roughly as measured in Chromium (stage px), for layout tests.
const WINDOW = { x: 490, y: 177, w: 300, h: 385 };
const BOUNDS = { x: 0, y: 0, w: 1280, h: 772 };
const fakeTarget = (step) => {
  const rows = { welcome: [490, 177, 300, 385], year: [497, 205, 286, 151], on: [497, 360, 286, 21], sites: [509, 401, 262, 21],
    strict: [509, 420, 262, 40], music: [655, 474, 128, 31], off: [497, 360, 286, 21] };
  const [x, y, w, h] = rows[step.id];
  return { x, y, w, h };
};

describe("step list", () => {
  test("seven steps in the order of the manual", () => {
    assert.deepEqual(STEPS.map((s) => s.id), ["welcome", "year", "on", "sites", "strict", "music", "off"]);
  });

  test("every step has a title, a text, boxes, a side and an animation per guide", () => {
    for (const s of STEPS) {
      assert.ok(s.title && s.text, s.id);
      assert.ok(Array.isArray(s.boxes) && s.boxes.length >= 1 && s.boxes.every((b) => Array.isArray(b) && b.length), s.id);
      assert.ok(["left", "right"].includes(s.side), s.id);
      for (const id of AGENT_IDS) assert.ok(s.anim[id], `${s.id}: no animation for ${id}`);
    }
  });

  test("every selector names ids and classes that exist in src/ui/popup.html", () => {
    for (const s of STEPS) {
      for (const sel of [...s.boxes.flat(), ...(s.hints || []).map((h) => h.when).filter(Boolean)]) {
        for (const [, kind, name] of sel.matchAll(/([#.])([A-Za-z][\w-]*)/g)) {
          if (kind === "#") {
            if (OPTIONAL_IDS.has(name)) continue;
            assert.ok(POPUP.includes(`id="${name}"`), `${s.id}: ${sel}: no id="${name}" in popup.html`);
          } else {
            assert.match(POPUP, new RegExp(`class="([^"]* )?${name}( [^"]*)?"`), `${s.id}: ${sel}: no class ${name}`);
          }
        }
      }
    }
  });

  test("the manual covers every control of the popup", () => {
    const text = STEPS.map((s) => `${s.title} ${s.text} ${(s.hints || []).map((h) => h.text).join(" ")}`).join(" ");
    for (const words of ["Time machine ON", "Google", "YouTube", "Strict", "Period look", "arrows", "slider", "hide the player", "music keeps playing", "Untick"]) {
      assert.ok(text.includes(words), words);
    }
  });

  test("texts are short, plain ASCII and free of long dashes", () => {
    for (const s of STEPS) {
      for (const t of [s.title, s.text, ...(s.hints || []).map((h) => h.text)].filter(Boolean)) {
        assert.ok(t.length <= 200, `${s.id}: ${t.length} chars`);
        assert.match(t, /^[\x20-\x7E]+$/, `${s.id}: non-ASCII in "${t}"`);
        assert.doesNotMatch(t, /--/);
      }
    }
    for (const a of Object.values(AGENTS)) {
      for (const t of [a.name, a.blurb, a.hello]) assert.match(t, /^[\x20-\x7E]+$/);
    }
  });
});

describe("animations per guide", () => {
  // The guide's centre on its side of the window, level with the control.
  const resolved = (id) => STEPS.map((s) => {
    const target = fakeTarget(s);
    const size = { w: DATA[id].framesize[0], h: DATA[id].framesize[1] };
    const spot = agentSpot({ target, frame: WINDOW, size, side: s.side, bounds: BOUNDS });
    return animFor(s, id, { data: DATA[id], from: centerOf({ ...spot, ...size }), to: centerOf(target) });
  });

  for (const id of AGENT_IDS) {
    test(`${id}: every step plays an existing animation, all seven different`, () => {
      const names = resolved(id);
      for (const [i, n] of names.entries()) assert.ok(DATA[id].animations[n], `${id} step ${STEPS[i].id}: ${n} missing`);
      assert.equal(new Set(names).size, STEPS.length, `${id}: ${names.join(", ")}`);
      for (const n of names) assert.notEqual(n, "RestPose");
    });

    test(`${id}: entrance, goodbye, fallback, idle, preview and poke animations exist`, () => {
      const a = AGENTS[id];
      for (const n of [a.enter, a.leave, a.fallback, ...a.idle, ...a.preview, ...a.poke]) {
        assert.ok(DATA[id].animations[n], `${id}: ${n} missing`);
      }
      const steps = new Set(resolved(id));
      for (const n of a.idle) assert.ok(!steps.has(n), `${id}: idle ${n} is also a step animation`);
    });
  }

  test("Clippy points toward the control with the gesture of his side", () => {
    const step = STEPS.find((s) => s.anim.clippy === GESTURE);
    assert.ok(step);
    const to = { x: 640, y: 280 };
    assert.equal(animFor(step, "clippy", { data: DATA.clippy, from: { x: 400, y: 280 }, to }), "GestureLeft");
    assert.equal(animFor(step, "clippy", { data: DATA.clippy, from: { x: 860, y: 280 }, to }), "GestureRight");
    assert.equal(animFor(step, "clippy"), AGENTS.clippy.fallback, "no geometry: fallback");
  });

  test("the guide stands somewhere else for every new line", () => {
    for (const id of AGENT_IDS) {
      const size = { w: DATA[id].framesize[0], h: DATA[id].framesize[1] };
      const spots = STEPS.map((s) => agentSpot({ target: fakeTarget(s), frame: WINDOW, size, side: s.side, bounds: BOUNDS }));
      for (let i = 1; i < spots.length; i++) {
        const moved = Math.hypot(spots[i].x - spots[i - 1].x, spots[i].y - spots[i - 1].y);
        assert.ok(moved > 20, `${id}: step ${i} -> ${i + 1} moves only ${moved}px`);
      }
    }
  });
});

describe("moving on (Next, Back, Skip, Escape)", () => {
  // Agent.exit(maxMs) on paper, as agent.js plays it: frame `index` is on screen when the guide is
  // asked to move on; that frame gets hurriedFrameMs, every later one hurriedNext with the time left.
  // Returns the ms until the animation has ended by itself (Infinity: it would have to be cut).
  function hurriedExitMs(anim, index, maxMs, random) {
    let t = hurriedFrameMs(anim.frames[index].duration, exitFrames(anim)[index], maxMs);
    for (let i = index, steps = 0; i < anim.frames.length - 1; steps++) {
      if (steps > 10000) return Infinity;
      const next = hurriedNext(anim, i, maxMs - t, random);
      i = next.index;
      t += next.ms;
    }
    return t;
  }
  const seq = (...values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };

  for (const id of AGENT_IDS) {
    test(`${id}: whatever he plays, he winds down within ${EXIT_MS} ms from any frame and is never cut short`, () => {
      // Every animation, not only the step ones: Next can come during an idle, a trick, the entrance...
      let worst = 0;
      for (const [name, anim] of Object.entries(DATA[id].animations)) {
        for (let i = 0; i < anim.frames.length; i++) {
          for (const random of [() => 0, () => 0.9999, seq(0.3, 0.8, 0.05, 0.6, 0.95)]) {
            const ms = hurriedExitMs(anim, i, EXIT_MS, random);
            assert.ok(ms <= EXIT_MS, `${id}.${name} from frame ${i}: ${ms} ms`);
            worst = Math.max(worst, ms);
          }
        }
      }
      assert.ok(worst > EXIT_MS / 2, `the long ways out use the time they have (${worst} ms)`);
    });
  }

  test("EXIT_MS keeps Next quick", () => {
    assert.ok(EXIT_MS >= 300 && EXIT_MS <= 700, String(EXIT_MS));
  });
});

describe("keys", () => {
  const ui = (over) => ({ picker: false, done: false, leaving: false, busy: false, step: -1, balloon: false, ...over });

  test("picker: Escape means no tour, other keys do nothing", () => {
    assert.equal(keyAction("Escape", ui({ picker: true })), "no-tour");
    assert.equal(keyAction("ArrowRight", ui({ picker: true })), null);
    assert.equal(keyAction("Enter", ui({ picker: true })), null);
  });

  test("a step on screen: arrows and Page keys move, Escape skips", () => {
    const shown = ui({ step: 2, balloon: true });
    assert.equal(keyAction("ArrowRight", shown), "next");
    assert.equal(keyAction("PageDown", shown), "next");
    assert.equal(keyAction("ArrowLeft", shown), "back");
    assert.equal(keyAction("PageUp", shown), "back");
    assert.equal(keyAction("Escape", shown), "skip");
    assert.equal(keyAction("Enter", shown), null);
  });

  test("Escape also skips during the entrance and between steps, when no Skip button is on screen", () => {
    assert.equal(keyAction("Escape", ui({ busy: true })), "skip", "entrance");
    assert.equal(keyAction("Escape", ui({ busy: true, step: 3 })), "skip", "on the way to step 4");
    assert.equal(keyAction("ArrowRight", ui({ busy: true, step: 3 })), null, "arrows wait for the balloon");
  });

  test("Escape does nothing during the goodbye, on the end message or before the tour", () => {
    assert.equal(keyAction("Escape", ui({ busy: true, leaving: true })), null, "a second Escape would restart the goodbye");
    assert.equal(keyAction("Escape", ui({ done: true })), null);
    assert.equal(keyAction("Escape", ui({})), null);
  });
});

describe("step content", () => {
  test("the first title is the guide's hello", () => {
    assert.equal(stepContent(STEPS[0], "clippy").title, "Hi! I'm Clippy.");
    assert.equal(stepContent(STEPS[0], "rover").title, "Woof! I'm Rover.");
    assert.equal(stepContent(STEPS[0], "nobody").title, AGENTS[DEFAULT_AGENT].hello);
  });

  test("conditional hints appear only when the popup has that element", () => {
    const last = STEPS.at(-1);
    const music = STEPS.find((s) => s.id === "music");
    assert.equal(stepContent(last, "clippy").hint, "");
    assert.match(stepContent(last, "clippy", { has: (sel) => sel === "#help" }).hint, /Click \? in the title bar/);
    assert.equal(stepContent(music, "rover", { has: (sel) => sel === "#help" }).hint, "");
    assert.match(stepContent(music, "rover", { has: (sel) => sel === "#mini-player" }).hint, /mini player/);
    assert.match(stepContent(STEPS[0], "rover").hint, /toolbar/, "a hint without `when` always shows");
  });

  test("end message for finished and skipped tours", () => {
    assert.match(doneText("finished"), /all set/);
    assert.match(doneText("skipped", { hasHelp: true }), /\? button/);
    assert.doesNotMatch(doneText("skipped"), /\?/);
  });
});

describe("layout", () => {
  const size = { w: 124, h: 93 };
  const target = { x: 500, y: 300, w: 280, h: 20 };

  test("beside the window on the preferred side, level with the control", () => {
    const right = agentSpot({ target, frame: WINDOW, size, side: "right", bounds: BOUNDS });
    assert.deepEqual(right, { x: 790 + 14, y: 310 - 46.5, side: "right" });
    const left = agentSpot({ target, frame: WINDOW, size, side: "left", bounds: BOUNDS });
    assert.deepEqual(left, { x: 490 - 14 - 124, y: 310 - 46.5, side: "left" });
  });

  test("the other side when the preferred one has no room, below when neither has", () => {
    const narrow = { x: 0, y: 0, w: 960, h: 700 };
    const frame = { x: 600, y: 100, w: 300, h: 400 };
    assert.equal(agentSpot({ target, frame, size, side: "right", bounds: narrow }).side, "left");
    const tiny = { x: 0, y: 0, w: 420, h: 700 };
    const spot = agentSpot({ target, frame: { x: 60, y: 100, w: 300, h: 400 }, size, side: "right", bounds: tiny });
    assert.equal(spot.side, "below");
    assert.ok(spot.x >= 8 && spot.x + size.w <= 412);
  });

  test("stays inside the stage vertically", () => {
    const high = agentSpot({ target: { x: 500, y: 0, w: 10, h: 4 }, frame: WINDOW, size, bounds: BOUNDS });
    assert.equal(high.y, 8);
    const low = agentSpot({ target: { x: 500, y: 790, w: 10, h: 4 }, frame: WINDOW, size, bounds: BOUNDS });
    assert.equal(low.y, 772 - 8 - 93);
  });

  test("union and padding of rects", () => {
    assert.deepEqual(unionRect([{ x: 10, y: 10, w: 10, h: 10 }, { x: 0, y: 15, w: 5, h: 20 }]), { x: 0, y: 10, w: 20, h: 25 });
    assert.equal(unionRect([]), null);
    assert.deepEqual(padRect({ x: 10, y: 10, w: 10, h: 10 }, 4), { x: 6, y: 6, w: 18, h: 18 });
  });
});

describe("hash and agent id", () => {
  test("parseHash accepts only known guides, steps 1..7 and sound 0/1", () => {
    assert.deepEqual(parseHash("#agent=rover&step=3&sound=0"), { agent: "rover", step: 3, sound: false });
    assert.deepEqual(parseHash("agent=clippy&sound=1"), { agent: "clippy", step: null, sound: true });
    assert.deepEqual(parseHash("#agent=bonzi&step=9"), { agent: null, step: null, sound: null });
    assert.deepEqual(parseHash(""), { agent: null, step: null, sound: null });
    assert.equal(parseHash("#step=1.5").step, null);
  });

  test("resolveAgentId falls back to Clippy", () => {
    assert.equal(resolveAgentId("rover"), "rover");
    assert.equal(resolveAgentId("__proto__"), DEFAULT_AGENT);
    assert.equal(resolveAgentId(undefined), DEFAULT_AGENT);
  });

  test("the picker remembers the guide under tour:agent", () => {
    assert.equal(TOUR_KEYS.agent, "tour:agent");
    assert.deepEqual([...AGENT_IDS].sort(), ["clippy", "rover"]);
  });
});
