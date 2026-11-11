// Unit tests for the service-worker hub (createMusicHub in extension/src/player/sw_music.js): the
// offscreen document is simulated by a real engine with a fake YouTube frame, so these tests cover the
// whole path UI -> hub -> engine -> state, including Chrome closing the document. No network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMusicHub, clampYear, TEXT, OFFSCREEN_PATH, OFFSCREEN_REASON } from "../../extension/src/player/sw_music.js";
import { createEngine } from "../../extension/src/player/engine.js";
import { STATE } from "../../extension/src/player/ytwidget.js";
import { SESSION_KEY, VOLUME_KEY, posKey } from "../../extension/src/player/music_state.js";
import { CHARTS, FakeFrame, idFor, storageArea, manualClock } from "./fakes.mjs";

function world({ local = {}, session = {}, createError = null, mute = false } = {}) {
  const clock = manualClock();
  const L = storageArea({ year: 2010, ...local });
  const S = storageArea(session);
  const broadcasts = [];
  const lookups = [];
  const counts = { creates: 0, closes: 0, engineMsgs: 0 };
  let doc = null; // {engine, frames}
  let hub = null;

  const offscreen = {
    exists: async () => doc !== null,
    create: async () => {
      counts.creates++;
      if (createError) throw new Error(createError);
      if (doc) throw new Error("Only a single offscreen document may be created.");
      await clock.flush(); // createDocument takes a moment
      const frames = [];
      const engine = createEngine({
        charts: CHARTS,
        makeFrame: (h) => { const f = new FakeFrame(h); frames.push(f); return f; },
        lookup: async (q) => { lookups.push(q); return { ok: true, videoId: idFor(q.title) }; },
        emit: (s) => { hub.onEngineState(s); },
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer
      });
      engine.boot(await hub.bootContext());
      doc = { engine, frames };
    },
    close: async () => { counts.closes++; doc = null; }
  };

  hub = createMusicHub({
    local: L,
    session: S,
    offscreen,
    toEngine: async (cmd) => {
      counts.engineMsgs++;
      if (!doc || mute) return null;
      return { ok: true, state: doc.engine.control(cmd) };
    },
    broadcast: (s) => broadcasts.push(s),
    loadCharts: async () => CHARTS,
    now: clock.now
  });

  return {
    hub, L, S, broadcasts, lookups, counts, clock,
    get doc() { return doc; },
    get frame() { return doc?.frames[0]; },
    chromeClosesDocument() { doc = null; },
    async setYear(year) { await L.set({ year }); await hub.onYear(); await clock.flush(); }
  };
}

async function startPlaying(w) {
  const r = await w.hub.control({ cmd: "play" });
  await w.clock.flush();
  w.frame.ready();
  w.frame.starts();
  w.frame.time(42, 200);
  return r;
}

describe("state without a document", () => {
  test("music:state gives the stored year and position, and creates nothing", async () => {
    const w = world({ local: { year: 2010, [posKey(2010)]: { index: 2, shuffle: true }, [VOLUME_KEY]: 40 } });
    const s = await w.hub.getState();
    assert.equal(s.playing, false);
    assert.equal(s.year, 2010);
    assert.equal(s.index, 2);
    assert.equal(s.shuffle, true);
    assert.equal(s.volume, 40);
    assert.deepEqual(s.track, { artist: "Train", title: "Hey, Soul Sister", rank: 3 });
    assert.equal(s.skin, "itunes");
    assert.equal(s.alive, false);
    assert.equal(w.counts.creates, 0);
  });

  test("a saved position past the end of the chart starts at the top", async () => {
    const w = world({ local: { year: 2011, [posKey(2011)]: { index: 50 } } });
    const s = await w.hub.getState();
    assert.equal(s.index, 0);
    assert.equal(s.track.title, "Rolling in the Deep");
  });

  test("year clamp follows the shared limits", () => {
    assert.equal(clampYear(1990), 1998);
    assert.equal(clampYear(2077), 2025);
    assert.equal(clampYear("abc"), 2010);
  });
});

describe("commands", () => {
  test("play creates the offscreen document once and the engine plays the stored position", async () => {
    const w = world({ local: { year: 2010, [posKey(2010)]: { index: 1 } } });
    const [a, b] = await Promise.all([w.hub.control({ cmd: "play" }), w.hub.control({ cmd: "play" })]);
    assert.equal(w.counts.creates, 1, "one document for concurrent commands");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.state.alive, true);
    await w.clock.flush();
    assert.equal(w.frame.loads()[0][1], idFor("Need You Now"));
    w.frame.starts();
    const s = await w.hub.getState();
    assert.equal(s.playing, true);
    assert.equal(s.loading, false);
    assert.equal(s.alive, true);
  });

  test("states are kept in session storage, positions and volume in local storage", async () => {
    const w = world();
    await startPlaying(w);
    await w.hub.control({ cmd: "next" });
    await w.hub.control({ cmd: "volume", volume: 33 });
    await w.clock.flush();
    assert.equal(w.S.data[SESSION_KEY].index, 1);
    assert.deepEqual(w.L.data[posKey(2010)], { index: 1, shuffle: false });
    assert.equal(w.L.data[VOLUME_KEY], 33);
  });

  test("a late, older state (broadcast and reply crossed) does not replace a newer one", async () => {
    const w = world();
    await startPlaying(w);
    const older = { ...(await w.hub.getState()), index: 3, at: 5 };
    await w.hub.onEngineState(older);
    w.chromeClosesDocument();
    const s = await w.hub.getState();
    assert.equal(s.index, 0);
    assert.notEqual(w.S.data[SESSION_KEY].at, 5);
  });

  test("bad commands are refused without starting anything", async () => {
    const w = world();
    for (const msg of [{ cmd: "explode" }, { cmd: "select", index: -1 }, { cmd: "seek", time: "soon" }, { cmd: "volume" }]) {
      const r = await w.hub.control(msg);
      assert.equal(r.ok, false, JSON.stringify(msg));
      assert.equal(r.reason, "bad-request");
    }
    assert.equal(w.counts.creates, 0);
  });

  test("no offscreen API (manifest permission missing) gives a readable problem state", async () => {
    const w = world({ createError: "chrome.offscreen is undefined" });
    const r = await w.hub.control({ cmd: "play" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "offscreen");
    assert.equal(r.state.problem, true);
    assert.match(r.state.status, /Cannot start the player/);
    assert.equal(w.broadcasts.at(-1).status, r.state.status);
  });

  test("a document that does not answer is closed so the next try starts fresh", async () => {
    const w = world({ mute: true });
    const r = await w.hub.control({ cmd: "play" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no-answer");
    assert.equal(w.counts.closes, 1);
    assert.equal(r.state.status, TEXT.noAnswer);
  });
});

describe("the document goes away and comes back", () => {
  test("pause, Chrome closes the silent document, play resumes the same video at the same second", async () => {
    const w = world();
    await startPlaying(w);
    const videoId = w.frame.loads()[0][1];
    await w.hub.control({ cmd: "pause" });
    w.frame.state(STATE.PAUSED);
    w.chromeClosesDocument();
    const idle = await w.hub.getState();
    assert.equal(idle.alive, false);
    assert.equal(idle.playing, false);
    assert.equal(idle.problem, false, "a normal pause is not a problem");
    assert.equal(idle.time, 42);
    const lookups = w.lookups.length;
    await w.hub.control({ cmd: "play" });
    assert.equal(w.counts.creates, 2);
    assert.deepEqual(w.frame.loads(), [["load", videoId, 42]]);
    assert.equal(w.lookups.length, lookups, "no new search");
  });

  test("next while paused, then the document closes: play starts the new song, not the old video", async () => {
    const w = world();
    await startPlaying(w);
    await w.hub.control({ cmd: "pause" });
    w.frame.state(STATE.PAUSED);
    const r = await w.hub.control({ cmd: "next" });
    assert.equal(r.state.index, 1);
    assert.equal(r.state.videoId, null, "no video belongs to the new song yet");
    w.chromeClosesDocument();
    await w.hub.control({ cmd: "play" });
    await w.clock.flush();
    assert.deepEqual(w.frame.loads(), [["load", idFor("Need You Now"), 0]]);
  });

  test("closed while playing (30 s without sound): the state says so instead of playing forever", async () => {
    const w = world();
    await startPlaying(w);
    w.chromeClosesDocument();
    const s = await w.hub.getState();
    assert.equal(s.playing, false);
    assert.equal(s.problem, true);
    assert.equal(s.status, TEXT.silent);
    assert.equal(w.broadcasts.at(-1).status, TEXT.silent);
  });

  test("closed while loading says YouTube did not start, not just 30 s without sound", async () => {
    const w = world();
    await w.hub.control({ cmd: "play" });
    await w.clock.flush();
    w.frame.ready();
    w.frame.state(STATE.UNSTARTED);                // the video never plays
    w.chromeClosesDocument();
    const s = await w.hub.getState();
    assert.equal(s.playing, false);
    assert.equal(s.loading, false);
    assert.equal(s.problem, true);
    assert.equal(s.status, TEXT.noStart);
    assert.match(s.status, /did not start the music/);
    assert.equal(w.broadcasts.at(-1).status, TEXT.noStart);
  });

  test("videos that never start: the engine stops before Chrome closes the document, its reason stays", async () => {
    const w = world();
    const start = w.clock.now();
    await w.hub.control({ cmd: "play" });
    let answered = 0;
    while ((await w.hub.getState()).playing && w.clock.now() - start < 30_000) {
      await w.clock.flush();
      const loads = w.frame ? w.frame.loads().length : 0;
      if (loads > answered) { answered = loads; w.frame.state(STATE.UNSTARTED); }
      await w.clock.advance(500);
    }
    assert.ok(w.clock.now() - start < 30_000, "the engine stopped first");
    w.chromeClosesDocument();
    const s = await w.hub.getState();
    assert.equal(s.playing, false);
    assert.equal(s.status, TEXT.noStart);
    assert.equal(s.index, 0, "the chart did not move on");
  });
});

describe("years", () => {
  test("a new year reaches a running engine, which switches charts and keeps playing", async () => {
    const w = world({ local: { [posKey(2011)]: { index: 2 } } });
    await startPlaying(w);
    await w.setYear(2011);
    const s = await w.hub.getState();
    assert.equal(s.year, 2011);
    assert.equal(s.index, 2);
    assert.equal(s.playing, true);
    assert.equal(w.frame.loads().at(-1)[1], idFor("Party Rock Anthem"));
  });

  test("a new year with no document only updates the idle state and tells the UIs", async () => {
    const w = world();
    await w.hub.getState();
    await w.setYear(2011);
    assert.equal(w.counts.creates, 0);
    const last = w.broadcasts.at(-1);
    assert.equal(last.year, 2011);
    assert.equal(last.track.title, "Rolling in the Deep");
  });

  test("musicAutoplay starts the new year's music", async () => {
    const w = world({ local: { musicAutoplay: true } });
    await w.setYear(2011);
    assert.equal(w.counts.creates, 1);
    await w.clock.flush();
    assert.equal(w.frame.loads()[0][1], idFor("Rolling in the Deep"));
  });

  test("play right after a year was saved plays that year, even before the engine heard of it", async () => {
    const w = world();
    await startPlaying(w);
    await w.hub.control({ cmd: "pause" });
    await w.L.set({ year: 2011 }); // saved; the storage event has not reached the hub yet
    const r = await w.hub.control({ cmd: "play", year: 2011 });
    assert.equal(r.ok, true);
    assert.equal(r.state.year, 2011);
    await w.clock.flush();
    assert.equal(w.frame.loads().at(-1)[1], idFor("Rolling in the Deep"));
  });

  test("an engine that missed a year change is corrected on the next state request", async () => {
    const w = world();
    await startPlaying(w);
    await w.L.set({ year: 2011 }); // no onYear: the event was lost
    const s = await w.hub.getState();
    assert.equal(s.year, 2011);
  });
});

describe("offscreen document parameters", () => {
  test("path, reason and justification", () => {
    assert.equal(OFFSCREEN_PATH, "src/player/offscreen.html");
    assert.equal(OFFSCREEN_REASON, "AUDIO_PLAYBACK");
  });
});
