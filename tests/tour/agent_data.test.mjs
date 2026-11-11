// Unit tests for the tour's character player (extension/src/tour/agent.js): parsing the vendored
// clippy.js data, frame stepping with branches and exit branches, directions, glide maths and balloon
// placement. No network, no browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeAgentData, nextFrameIndex, simulate, directionTo, gestureFor, moveAnimationFor, idleAnimations,
  easeInOut, glideDuration, glidePoint, placeBalloon, END, exitFrames, hurriedFrameMs, hurriedNext,
  EXIT_FRAME_MS, HURRY_FRAME_MS, MIN_FRAME_MS
} from "../../extension/src/tour/agent.js";
import { pngSize } from "./vendor_clippy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_DIR = join(ROOT, "extension/src/vendor/clippy/agents");
const raw = (id) => JSON.parse(readFileSync(join(AGENTS_DIR, id, "agent.json"), "utf8"));
const DATA = { clippy: normalizeAgentData(raw("clippy"), "clippy"), rover: normalizeAgentData(raw("rover"), "rover") };

// A random source that replays the given values (0..1), then repeats the last one.
const seq = (...values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };

describe("vendored character data", () => {
  test("Clippy and Rover parse, with the frame sizes clippy.js uses", () => {
    assert.deepEqual(DATA.clippy.framesize, [124, 93]);
    assert.deepEqual(DATA.rover.framesize, [80, 80]);
    assert.equal(DATA.clippy.overlayCount, 1);
    assert.equal(DATA.rover.overlayCount, 1);
    assert.equal(Object.keys(DATA.clippy.animations).length, 43);
    assert.equal(Object.keys(DATA.rover.animations).length, 29);
    for (const d of Object.values(DATA)) assert.ok(d.animations.RestPose, "RestPose exists");
  });

  test("parsing keeps the data unchanged (a clean copy, nothing dropped)", () => {
    for (const id of ["clippy", "rover"]) {
      const original = raw(id);
      for (const [name, anim] of Object.entries(original.animations)) {
        const parsed = DATA[id].animations[name];
        assert.equal(parsed.frames.length, anim.frames.length, `${id}.${name}`);
        anim.frames.forEach((f, i) => {
          const p = parsed.frames[i];
          assert.equal(p.duration, f.duration ?? 100);
          assert.deepEqual(p.images, f.images ?? []);
          assert.equal(p.exitBranch, f.exitBranch);
          assert.equal(p.sound, f.sound === undefined ? undefined : String(f.sound));
          assert.deepEqual(p.branching?.branches, f.branching?.branches);
        });
      }
    }
  });

  test("every sprite offset lies inside map.png", () => {
    for (const id of ["clippy", "rover"]) {
      const { width, height } = pngSize(readFileSync(join(AGENTS_DIR, id, "map.png")));
      const [w, h] = DATA[id].framesize;
      for (const [name, anim] of Object.entries(DATA[id].animations)) {
        for (const f of anim.frames) {
          for (const [x, y] of f.images) {
            assert.ok(x + w <= width && y + h <= height, `${id}.${name}: [${x}, ${y}] outside ${width}x${height}`);
          }
        }
      }
    }
  });

  test("every sound a frame plays is listed and shipped as an MP3", () => {
    for (const id of ["clippy", "rover"]) {
      const listed = new Set(DATA[id].sounds);
      for (const s of listed) {
        const file = join(AGENTS_DIR, id, "sounds", `${s}.mp3`);
        assert.ok(existsSync(file), file);
        assert.equal(readFileSync(file).subarray(0, 3).toString("latin1"), "ID3", file);
      }
      for (const [name, anim] of Object.entries(DATA[id].animations)) {
        for (const f of anim.frames) if (f.sound) assert.ok(listed.has(f.sound), `${id}.${name} plays unknown sound ${f.sound}`);
      }
    }
  });

  test("no animation traps the player: once asked to exit, every one reaches its last frame", () => {
    for (const [id, data] of Object.entries(DATA)) {
      for (const [name, anim] of Object.entries(data.animations)) {
        for (const [label, random] of [["always branch", () => 0], ["never branch", () => 0.9999], ["mixed", seq(0.2, 0.7, 0.4, 0.95, 0.1)]]) {
          for (const exitAfter of [0, 3, 25]) {
            const path = simulate(anim, { random, exitAfter, limit: 3000 });
            assert.equal(path.at(-1), anim.frames.length - 1, `${id}.${name} (${label}, exit after ${exitAfter}) never ends`);
          }
        }
      }
    }
  });

  test("looping animations hold their pose until they are asked to exit", () => {
    for (const [id, name] of [["clippy", "Thinking"], ["clippy", "Hearing_1"], ["rover", "Travel"], ["rover", "Celebrity"]]) {
      const anim = DATA[id].animations[name];
      const held = simulate(anim, { random: () => 0, limit: 400 });
      assert.equal(held.length, 400, `${id}.${name} should still loop after 400 frames`);
      assert.notEqual(held.at(-1), anim.frames.length - 1);
      const left = simulate(anim, { random: () => 0, exitAfter: 60, limit: 400 });
      assert.equal(left.at(-1), anim.frames.length - 1, `${id}.${name} leaves after the exit request`);
    }
  });

  test("idle animations: Clippy has a set of Idle*, Rover one long Idle", () => {
    assert.ok(idleAnimations(DATA.clippy).length >= 6);
    assert.deepEqual(idleAnimations(DATA.rover), ["Idle"]);
  });
});

describe("normalizeAgentData", () => {
  const good = () => ({
    framesize: [10, 20],
    sounds: ["1"],
    animations: {
      A: { frames: [{ images: [[0, 0]] }, { duration: 50, images: [[10, 0]], sound: 1, exitBranch: 0, branching: { branches: [{ frameIndex: 0, weight: 40 }] } }] }
    }
  });

  test("fills defaults and keeps the rest", () => {
    const d = normalizeAgentData(good());
    assert.equal(d.overlayCount, 1);
    assert.deepEqual(d.animations.A.frames[0], { duration: 100, images: [[0, 0]] });
    assert.deepEqual(d.animations.A.frames[1], {
      duration: 50, images: [[10, 0]], sound: "1", exitBranch: 0, branching: { branches: [{ frameIndex: 0, weight: 40 }] }
    });
    assert.equal(d.animations.A.useExitBranching, false);
  });

  test("rejects broken data with the path in the message", () => {
    const cases = [
      [(d) => { delete d.framesize; }, /framesize/],
      [(d) => { d.framesize = [0, 5]; }, /framesize/],
      [(d) => { d.overlayCount = 0; }, /overlayCount/],
      [(d) => { d.animations = {}; }, /animations are empty/],
      [(d) => { d.animations.A.frames = []; }, /A\.frames/],
      [(d) => { d.animations.A.frames[1].exitBranch = 2; }, /frames\[1\]\.exitBranch/],
      [(d) => { d.animations.A.frames[1].branching.branches[0].frameIndex = -1; }, /frameIndex/],
      [(d) => { d.animations.A.frames[1].branching.branches[0].weight = 150; }, /weight/],
      [(d) => { d.animations.A.frames[0].duration = -5; }, /duration/],
      [(d) => { d.animations.A.frames[0].images = [[1]]; }, /images\[0\]/]
    ];
    for (const [breakIt, message] of cases) {
      const d = good();
      breakIt(d);
      assert.throws(() => normalizeAgentData(d, "test"), message);
    }
    assert.throws(() => normalizeAgentData(null), /not an object/);
  });
});

describe("nextFrameIndex (clippy.js semantics)", () => {
  const anim = {
    frames: [
      { duration: 100, images: [] },
      { duration: 100, images: [], exitBranch: 3, branching: { branches: [{ frameIndex: 0, weight: 30 }, { frameIndex: 2, weight: 50 }] } },
      { duration: 100, images: [] },
      { duration: 100, images: [] }
    ]
  };

  test("starts at frame 0 and steps forward", () => {
    assert.equal(nextFrameIndex(anim, null), 0);
    assert.equal(nextFrameIndex(anim, 0), 1);
    assert.equal(nextFrameIndex(anim, 2), 3);
  });

  test("branches by cumulative weight (percent); the rest falls through", () => {
    assert.equal(nextFrameIndex(anim, 1, false, () => 0.1), 0);   // 10 <= 30
    assert.equal(nextFrameIndex(anim, 1, false, () => 0.5), 2);   // 50 - 30 = 20 <= 50
    assert.equal(nextFrameIndex(anim, 1, false, () => 0.9), 2);   // 90 - 30 = 60 > 50: next frame (2)
  });

  test("an exit request takes the exit branch instead of branching", () => {
    assert.equal(nextFrameIndex(anim, 1, true, () => 0.1), 3);
  });

  test("while exiting, loops without an exit branch are not taken (forward branches still are)", () => {
    const looping = { frames: [{ images: [] }, { images: [], branching: { branches: [{ frameIndex: 1, weight: 80 }, { frameIndex: 3, weight: 20 }] } }, { images: [] }, { images: [] }] };
    assert.equal(nextFrameIndex(looping, 1, false, () => 0), 1, "normally it loops");
    assert.equal(nextFrameIndex(looping, 1, true, () => 0), 2, "exiting: falls through");
    assert.equal(nextFrameIndex(looping, 1, true, () => 0.9), 3, "exiting: a forward branch is fine");
  });

  test("never runs past the last frame", () => {
    assert.equal(nextFrameIndex(anim, 3), 3);
    assert.equal(nextFrameIndex({ frames: [{ duration: 1, images: [], exitBranch: 0 }] }, 0), 0);
  });

  test("simulate stops at the last frame", () => {
    assert.deepEqual(simulate(anim, { random: () => 0.99 }), [0, 1, 2, 3]);
    assert.deepEqual(simulate(anim, { random: () => 0.1, exitAfter: 2 }), [0, 1, 3]);
  });
});

describe("hurrying out (Agent.exit)", () => {
  const anim = {
    frames: [
      { duration: 100, images: [] },
      { duration: 100, images: [], branching: { branches: [{ frameIndex: 1, weight: 50 }, { frameIndex: 4, weight: 10 }] } },
      { duration: 500, images: [], exitBranch: 4 },
      { duration: 100, images: [] },
      { duration: 100, images: [] },
      { duration: 100, images: [] }
    ]
  };
  const long = { frames: Array.from({ length: 100 }, () => ({ duration: 100, images: [] })) };

  test("exitFrames: worst-case frames still shown, exit branches taken, loops never", () => {
    // 1 may fall through to 2 (then its exit branch to 4) or jump to 4; it never loops on itself.
    assert.deepEqual(exitFrames(anim), [5, 4, 3, 3, 2, 1]);
    assert.equal(exitFrames(anim), exitFrames(anim), "computed once per animation");
  });

  test("no vendored way out goes round in a circle", () => {
    for (const [id, data] of Object.entries(DATA)) {
      for (const [name, a] of Object.entries(data.animations)) {
        assert.ok(exitFrames(a).every(Number.isFinite), `${id}.${name}`);
      }
    }
  });

  test("a frame hurries at HURRY_FRAME_MS at most, faster when time is short, never below MIN_FRAME_MS", () => {
    assert.equal(hurriedFrameMs(100, 5, 1000), HURRY_FRAME_MS);
    assert.equal(hurriedFrameMs(10, 5, 1000), 10, "a brisk frame stays brisk");
    assert.equal(hurriedFrameMs(100, 10, 250), 25);
    assert.equal(hurriedFrameMs(100, 100, 250), MIN_FRAME_MS);
    assert.ok(HURRY_FRAME_MS < EXIT_FRAME_MS, "hurrying is faster than winding down by itself");
  });

  test("a long way out skips frames instead of running late; a short one plays every frame", () => {
    const tight = hurriedNext(long, 0, 160); // 10 frames x 16 ms fit into 160 ms
    assert.equal(tight.index, 90);
    assert.equal(tight.ms, MIN_FRAME_MS);
    assert.deepEqual(hurriedNext(long, 0, 5000), { index: 1, ms: HURRY_FRAME_MS });
    assert.deepEqual(hurriedNext(anim, 2, 1000), { index: 4, ms: HURRY_FRAME_MS }, "takes the exit branch");
    assert.equal(hurriedNext(long, 0, -5).index, 99, "deadline gone: straight to the last frame");
  });
});

describe("directions (the character's point of view)", () => {
  const me = { x: 100, y: 100 };
  test("a target on the screen's left is the character's Right", () => {
    assert.equal(directionTo(me, { x: 0, y: 100 }), "Right");
    assert.equal(directionTo(me, { x: 200, y: 100 }), "Left");
    assert.equal(directionTo(me, { x: 100, y: 0 }), "Up");
    assert.equal(directionTo(me, { x: 100, y: 200 }), "Down");
  });

  test("Clippy points with the matching gesture; Rover falls back or has none", () => {
    assert.equal(gestureFor(DATA.clippy, me, { x: 300, y: 110 }), "GestureLeft");  // control to the screen's right
    assert.equal(gestureFor(DATA.clippy, me, { x: -100, y: 90 }), "GestureRight");
    assert.equal(gestureFor(DATA.clippy, me, { x: 100, y: -50 }), "GestureUp");
    assert.equal(gestureFor(DATA.rover, me, { x: 300, y: 110 }), "GestureLeft");
    assert.equal(gestureFor(DATA.rover, me, { x: 100, y: -50 }), "LookUp");
    assert.equal(gestureFor(DATA.rover, me, { x: -100, y: 100 }), null);
  });

  test("walking animations are used when a character has them (these two have none)", () => {
    assert.equal(moveAnimationFor(DATA.clippy, me, { x: 0, y: 100 }), null);
    assert.equal(moveAnimationFor(DATA.rover, me, { x: 0, y: 100 }), null);
    const walker = normalizeAgentData({ framesize: [1, 1], animations: { MoveRight: { frames: [{}] }, MoveUp: { frames: [{}] } } });
    assert.equal(moveAnimationFor(walker, me, { x: 0, y: 100 }), "MoveRight");
    assert.equal(moveAnimationFor(walker, me, { x: 100, y: 0 }), "MoveUp");
    assert.equal(moveAnimationFor(walker, me, { x: 300, y: 100 }), null);
  });
});

describe("glide", () => {
  const a = { x: 0, y: 100 };
  const b = { x: 400, y: 300 };

  test("ease-in-out runs 0..1 and never goes backwards", () => {
    assert.equal(easeInOut(0), 0);
    assert.equal(easeInOut(1), 1);
    assert.equal(easeInOut(0.5), 0.5);
    let last = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = easeInOut(t);
      assert.ok(v >= last);
      last = v;
    }
  });

  test("starts and ends exactly on the points, with an arc or hops in between", () => {
    for (const style of [{}, { arc: 24 }, { hops: 4, hopHeight: 7 }]) {
      assert.deepEqual(glidePoint(a, b, 0, style), a);
      const end = glidePoint(a, b, 1, style);
      assert.ok(Math.abs(end.x - b.x) < 1e-9 && Math.abs(end.y - b.y) < 1e-9, JSON.stringify(style));
    }
    const straight = glidePoint(a, b, 0.5);
    assert.equal(glidePoint(a, b, 0.5, { arc: 24 }).y, straight.y - 24);
    assert.ok(glidePoint(a, b, 0.125, { hops: 4, hopHeight: 7 }).y < glidePoint(a, b, 0.125).y, "mid-hop is higher");
  });

  test("duration grows with distance and stays within bounds", () => {
    assert.equal(glideDuration(0), 0);
    assert.ok(glideDuration(50) >= 380 && glideDuration(50) < glideDuration(400));
    assert.equal(glideDuration(5000), 1300);
  });
});

describe("placeBalloon", () => {
  const bounds = { x: 0, y: 0, w: 1280, h: 770 };
  const size = { w: 300, h: 130 };

  test("sits above the character, opening to the preferred side, tail on the head", () => {
    const anchor = { x: 800, y: 330, w: 124, h: 93 };
    const right = placeBalloon({ anchor, size, bounds, prefer: "right" });
    assert.equal(right.side, "top");
    assert.equal(right.opens, "right");
    assert.equal(right.top, 330 - 130 - 16);
    assert.equal(right.left + right.tailX, 862);
    const left = placeBalloon({ anchor, size, bounds, prefer: "left" });
    assert.equal(left.opens, "left");
    assert.ok(left.left + size.w > 862 && left.left < 862);
  });

  test("goes below when there is no room above", () => {
    const p = placeBalloon({ anchor: { x: 400, y: 40, w: 80, h: 80 }, size, bounds });
    assert.equal(p.side, "bottom");
    assert.equal(p.top, 40 + 80 + 16);
  });

  test("stays inside the bounds and keeps the tail on the balloon", () => {
    const p = placeBalloon({ anchor: { x: 1250, y: 400, w: 80, h: 80 }, size, bounds, prefer: "right" });
    assert.ok(p.left >= 8 && p.left + size.w <= 1272);
    assert.ok(p.tailX >= 16 && p.tailX <= size.w - 16);
  });

  test("avoids covering what it explains", () => {
    const anchor = { x: 600, y: 300, w: 80, h: 80 };
    const avoid = [{ x: 600, y: 100, w: 400, h: 200 }]; // the whole area above-right
    const p = placeBalloon({ anchor, size, bounds, avoid, prefer: "right" });
    assert.ok(!(p.side === "top" && p.opens === "right"), JSON.stringify(p));
  });
});

test("END values are distinct strings", () => {
  assert.equal(new Set(Object.values(END)).size, 3);
});
