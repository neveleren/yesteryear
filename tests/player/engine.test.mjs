// Unit tests for the music engine (extension/src/player/engine.js): a fake YouTube frame, a fake clock
// and fake timers. No network, no browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEngine, TIMING } from "../../extension/src/player/engine.js";
import { STATE } from "../../extension/src/player/ytwidget.js";
import { mulberry32 } from "../../extension/src/player/playlist.js";
import { CHARTS, FakeFrame, idFor, manualClock } from "./fakes.mjs";

function harness({ charts = CHARTS, answer } = {}) {
  const clock = manualClock();
  const frames = [];
  const emitted = [];
  const lookups = [];
  const bad = [];
  const respond = answer || ((q) => ({ ok: true, videoId: idFor(q.title, (q.exclude || []).length) }));
  const engine = createEngine({
    charts,
    makeFrame: (handlers) => { const f = new FakeFrame(handlers); frames.push(f); return f; },
    lookup: async (q) => { lookups.push(q); return respond(q); },
    reportBad: (b) => bad.push(b),
    emit: (s) => emitted.push(s),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    rng: mulberry32(7)
  });
  return {
    engine, frames, emitted, lookups, bad,
    flush: clock.flush,
    advance: (ms) => clock.advance(ms),
    tick: clock.tick,
    get frame() { return frames[0]; },
    get now() { return clock.now(); },
    last: () => emitted[emitted.length - 1]
  };
}

async function playing(h, cmd = { cmd: "play" }) {
  h.engine.control(cmd);
  await h.flush();
  h.frame.ready();
  h.frame.starts();
  return h.last();
}

describe("start and state", () => {
  test("boot reports the year's first song, idle, with the saved volume", () => {
    const h = harness();
    const s = h.engine.boot({ year: 2010, pos: { index: 2, shuffle: false }, volume: 35 });
    assert.equal(s.playing, false);
    assert.equal(s.year, 2010);
    assert.equal(s.index, 2);
    assert.equal(s.length, 6);
    assert.deepEqual(s.track, { artist: "Train", title: "Hey, Soul Sister", rank: 3 });
    assert.equal(s.skin, "itunes");
    assert.equal(s.volume, 35);
    assert.equal(h.frames.length, 0, "no YouTube until someone wants music");
  });

  test("play searches, loads the video, reports Loading..., then playing", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    const first = h.engine.control({ cmd: "play" });
    assert.equal(first.playing, true);
    assert.equal(first.loading, true);
    assert.equal(first.status, "Searching...");
    await h.flush();
    assert.deepEqual(h.lookups[0], { artist: "Kesha", title: "Tik Tok", exclude: [] });
    assert.deepEqual(h.frame.loads(), [["load", idFor("Tik Tok"), 0]]);
    assert.equal(h.last().status, "Loading...");
    assert.equal(h.last().videoId, idFor("Tik Tok"));
    // prefetch of the next two songs
    assert.deepEqual(h.lookups.slice(1).map((q) => [q.title, q.prefetch]), [["Need You Now", true], ["Hey, Soul Sister", true]]);
    h.frame.ready();
    assert.deepEqual(h.frame.calls.slice(-2), [["setVolume", 80], ["unMute"]]);
    h.frame.starts();
    const s = h.last();
    assert.equal(s.playing, true);
    assert.equal(s.loading, false);
    assert.equal(s.status, "");
    assert.equal(s.problem, false);
  });

  test("time: the first duration is reported at once, positions at most every syncMs", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    const n = h.emitted.length;
    h.frame.time(0.5, 200);
    assert.equal(h.emitted.length, n + 1);
    assert.equal(h.last().duration, 200);
    h.tick(1000); h.frame.time(1.5, 200);
    h.tick(1000); h.frame.time(2.5, 200);
    assert.equal(h.emitted.length, n + 1, "no emit for every tick");
    h.tick(TIMING.syncMs); h.frame.time(7.5, 200);
    assert.equal(h.emitted.length, n + 2);
    assert.equal(h.last().time, 7.5);
    // snapshot counts on from the last report while playing
    h.tick(2000);
    assert.equal(h.engine.snapshot().time, 9.5);
  });

  test("restarting the same video keeps its duration (YouTube does not send it again)", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    h.frame.time(30, 200);
    h.engine.control({ cmd: "select", index: 0 }); // double-click on the song that plays
    await h.flush();
    assert.equal(h.frame.loads().length, 2);
    assert.equal(h.last().duration, 200);
    assert.equal(h.last().time, 0);
  });

  test("a year without songs says so instead of searching", () => {
    const h = harness({ charts: {} });
    h.engine.boot({ year: 2010 });
    const s = h.engine.control({ cmd: "play" });
    assert.equal(s.playing, false);
    assert.equal(s.problem, true);
    assert.match(s.status, /No songs/);
    assert.equal(h.lookups.length, 0);
  });
});

describe("transport", () => {
  test("pause keeps the video, play continues it without a new search", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    h.frame.time(42, 200);
    let s = h.engine.control({ cmd: "toggle" });
    assert.equal(s.playing, false);
    assert.equal(h.frame.calls.at(-1)[0], "pause");
    h.frame.state(STATE.PAUSED);
    h.tick(60_000);
    assert.equal(h.engine.snapshot().time, 42, "time stands still while paused");
    const lookups = h.lookups.length;
    s = h.engine.control({ cmd: "toggle" });
    assert.equal(s.playing, true);
    assert.equal(h.frame.calls.at(-1)[0], "play");
    assert.equal(h.lookups.length, lookups);
    assert.equal(h.frame.loads().length, 1);
  });

  test("a finished song starts the next one", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    h.frame.state(STATE.ENDED);
    await h.flush();
    assert.equal(h.last().index, 1);
    assert.equal(h.frame.loads().at(-1)[1], idFor("Need You Now"));
  });

  test("next/prev while paused only move; while playing they play", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    let s = h.engine.control({ cmd: "next" });
    assert.equal(s.index, 1);
    s = h.engine.control({ cmd: "prev" });
    s = h.engine.control({ cmd: "prev" });
    assert.equal(s.index, 5, "wraps around");
    assert.equal(h.lookups.length, 0);
    await playing(h);
    h.engine.control({ cmd: "next" });
    await h.flush();
    assert.equal(h.last().index, 0);
    assert.equal(h.frame.loads().at(-1)[1], idFor("Tik Tok"));
  });

  test("select plays a song; play:false moves the cursor only while paused", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    let s = h.engine.control({ cmd: "select", index: 3, play: false });
    assert.equal(s.index, 3);
    assert.equal(s.playing, false);
    assert.equal(h.lookups.length, 0);
    await playing(h, { cmd: "select", index: 4 });
    assert.equal(h.last().index, 4);
    s = h.engine.control({ cmd: "select", index: 0, play: false });
    assert.equal(s.index, 4, "the cursor does not interrupt the music");
    assert.equal(s.playing, true);
    s = h.engine.control({ cmd: "select", index: 99 });
    assert.equal(s.index, 4, "out of range is ignored");
  });

  test("seek moves the frame and is clamped to the song", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    h.frame.time(1, 200);
    h.engine.control({ cmd: "seek", time: 120 });
    assert.deepEqual(h.frame.calls.at(-1), ["seek", 120]);
    assert.equal(h.last().time, 120);
    h.engine.control({ cmd: "seek", time: 5000 });
    assert.deepEqual(h.frame.calls.at(-1), ["seek", 199]);
  });

  test("volume goes to the frame and unmutes; YouTube's own default never wins", async () => {
    const h = harness();
    h.engine.boot({ year: 2010, volume: 50 });
    await playing(h);
    h.frame.volume(100, false); // YouTube's default, reported before our setVolume arrived
    assert.equal(h.engine.snapshot().volume, 50);
    assert.equal(h.engine.snapshot().diag.ytVolume, 100);
    h.engine.control({ cmd: "volume", volume: 30 });
    assert.deepEqual(h.frame.calls.slice(-2), [["setVolume", 30], ["unMute"]]);
    assert.equal(h.last().volume, 30);
    h.frame.volume(30, true);
    h.frame.volume(30, true);
    assert.equal(h.frame.calls.filter((c) => c[0] === "unMute").length, 3, "one extra unMute per video, not a loop");
  });

  test("shuffle toggles and is reported", () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    assert.equal(h.engine.control({ cmd: "shuffle" }).shuffle, true);
    assert.equal(h.engine.control({ cmd: "shuffle", on: false }).shuffle, false);
  });

  test("unknown commands change nothing", () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    const before = h.engine.snapshot();
    const after = h.engine.control({ cmd: "selfdestruct" });
    assert.equal(after.index, before.index);
    assert.equal(after.playing, false);
  });
});

describe("races", () => {
  test("pausing during the search loads nothing", async () => {
    let release;
    const h = harness({ answer: (q) => (q.prefetch ? { ok: true, videoId: idFor(q.title) } : new Promise((r) => { release = () => r({ ok: true, videoId: idFor(q.title) }); })) });
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.engine.control({ cmd: "pause" });
    release();
    await h.flush();
    assert.equal(h.frames.length, 0);
    assert.equal(h.last().playing, false);
    assert.equal(h.last().status, "");
  });

  test("only the latest of quick next presses loads", async () => {
    const pending = [];
    const h = harness({ answer: (q) => (q.prefetch ? { ok: true, videoId: idFor(q.title) } : new Promise((r) => pending.push(() => r({ ok: true, videoId: idFor(q.title) })))) });
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    h.engine.control({ cmd: "next" });
    h.engine.control({ cmd: "next" });
    await h.flush();
    pending.forEach((go) => go());
    await h.flush();
    assert.deepEqual(h.frame.loads().map((c) => c[1]), [idFor("Hey, Soul Sister")]);
  });

  test("a PAUSED left over from the previous video does not stop the new one", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    h.engine.control({ cmd: "pause" });
    h.frame.state(STATE.PAUSED);
    h.engine.control({ cmd: "next" });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.frame.state(STATE.PAUSED); // in flight before loadVideoById
    assert.equal(h.last().playing, true);
    h.frame.starts();
    assert.equal(h.last().playing, true);
    assert.equal(h.last().loading, false);
  });

  test("paused while loading stays paused even if YouTube starts late", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.frame.ready();
    h.frame.state(STATE.UNSTARTED);
    h.engine.control({ cmd: "pause" });
    h.tick(TIMING.echoMs * 3);
    h.frame.state(STATE.BUFFERING);
    h.frame.state(STATE.PLAYING);
    assert.equal(h.frame.calls.at(-1)[0], "pause");
    assert.equal(h.engine.snapshot().playing, false);
  });

  test("paused while loading, year switched, late autoplay is paused again", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.engine.control({ cmd: "pause" });
    h.engine.control({ cmd: "year", year: 2011 }); // autoplay off: the frame still holds the 2010 video
    h.frame.ready();
    h.frame.starts();                              // YouTube's autoplay beat our pause
    assert.deepEqual(h.frame.calls.at(-1), ["pause"]);
    assert.equal(h.last().playing, false);
    const s = h.engine.snapshot();
    assert.equal(s.playing, false);
    assert.equal(s.year, 2011);
    assert.equal(s.track.title, "Rolling in the Deep");
    h.engine.control({ cmd: "play" });             // Play brings the new year's song, not the old video
    await h.flush();
    assert.equal(h.frame.loads().at(-1)[1], idFor("Rolling in the Deep"));
  });

  test("YouTube's PAUSED answer to our own pause does not stop the next song or year", async () => {
    // As in the extension: the search is a round trip to the service worker, so YouTube's PAUSED
    // (a postMessage) arrives while it is still running.
    const slow = (q) => new Promise((r) => setTimeout(() => r({ ok: true, videoId: idFor(q.title) }), 15));
    const wait = () => new Promise((r) => setTimeout(r, 40));
    const h = harness({ answer: slow });
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await wait();
    h.frame.ready();
    h.frame.starts();
    h.frame.echoPause = true;
    h.engine.control({ cmd: "next" });
    assert.equal(h.frame.calls.at(-1)[0], "pause", "the old song stops at once");
    await wait();
    assert.equal(h.last().playing, true);
    assert.equal(h.frame.loads().at(-1)[1], idFor("Need You Now"));
    h.frame.starts();
    h.engine.control({ cmd: "year", year: 2011 });
    await wait();
    assert.equal(h.last().playing, true);
    assert.equal(h.frame.loads().at(-1)[1], idFor("Rolling in the Deep"));
  });

  test("pause and play from outside (media keys) are followed", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    h.frame.state(STATE.PAUSED);
    assert.equal(h.last().playing, false);
    h.tick(TIMING.echoMs + 1);
    h.frame.state(STATE.PLAYING);
    assert.equal(h.last().playing, true);
  });
});

describe("broken videos", () => {
  test("a video error retries the next hit of the same song, then skips", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.frame.ready();
    h.frame.state(STATE.UNSTARTED);
    h.frame.error(150);
    await h.flush();
    assert.deepEqual(h.lookups.filter((q) => !q.prefetch).at(-1).exclude, [idFor("Tik Tok", 0)]);
    assert.equal(h.frame.loads().at(-1)[1], idFor("Tik Tok", 1));
    h.frame.state(STATE.UNSTARTED);
    h.frame.error(150);
    await h.flush();
    h.frame.state(STATE.UNSTARTED);
    h.frame.error(150);
    await h.flush();
    assert.equal(h.last().index, 1, "three failed videos: next song");
    assert.match(h.last().status, /skipping|Loading/);
    h.frame.starts();
    assert.deepEqual(h.bad.map((b) => [b.videoId, b.code]), [[idFor("Tik Tok", 0), 150], [idFor("Tik Tok", 1), 150], [idFor("Tik Tok", 2), 150]]);
  });

  test("five errors in a row halt with a message, nothing is reported as bad", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    for (let i = 0; i < 5; i++) {
      await h.flush();
      h.frame.state(STATE.UNSTARTED);
      h.frame.error(5);
    }
    await h.flush();
    const s = h.last();
    assert.equal(s.playing, false);
    assert.equal(s.problem, true);
    assert.match(s.status, /refuses to play/);
    assert.equal(h.bad.length, 0);
  });

  test("error 153 (no Referer) halts at once", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.frame.error(153);
    assert.match(h.last().status, /Referer/);
    assert.equal(h.last().playing, false);
  });

  test("watchdog: nudge with playVideo, then count a silent video as failed", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.frame.ready();
    h.frame.state(STATE.UNSTARTED);
    await h.advance(TIMING.nudgeMs);
    assert.equal(h.frame.calls.at(-1)[0], "play");
    await h.advance(TIMING.stallMs - TIMING.nudgeMs);
    assert.equal(h.frame.loads().length, 2, "next hit of the same song");
    assert.equal(h.bad.length, 0);
  });

  test("watchdog: buffering gets one grace period", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.frame.state(STATE.UNSTARTED);
    h.frame.state(STATE.BUFFERING);
    await h.advance(TIMING.stallMs);
    assert.equal(h.frame.loads().length, 1);
    h.frame.state(STATE.PLAYING);
    await h.advance(TIMING.bufferGraceMs);
    assert.equal(h.frame.loads().length, 1);
    assert.equal(h.last().playing, true);
  });

  test("errorCode auth: move on quickly; three in a row halt with the sign-in hint", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    for (let i = 0; i < 3; i++) {
      await h.flush();
      h.frame.state(STATE.UNSTARTED);
      h.frame.videoError("auth");
      await h.advance(TIMING.videoErrorMs);
    }
    const s = h.last();
    assert.equal(s.playing, false);
    assert.match(s.status, /sign-in/);
    assert.equal(h.now - 1_000_000 < 30_000, true, "before Chrome closes a silent document");
    assert.equal(h.bad.length, 0);
  });

  test("the same video loaded again keeps its known errorCode (YouTube does not send it twice)", async () => {
    const h = harness({ answer: (q) => ((q.exclude || []).length ? { ok: false, reason: "none" } : { ok: true, videoId: "sameVideo01" }) });
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    h.frame.state(STATE.UNSTARTED);
    h.frame.videoError("auth");
    await h.advance(TIMING.videoErrorMs);   // auth -> retry finds nothing -> next song, same video again
    assert.equal(h.last().index, 1);
    assert.equal(h.frame.loads().length, 2);
    await h.advance(TIMING.videoErrorMs);   // no new videoData from YouTube, but the code is known
    assert.equal(h.last().index, 2, "failed after the short wait, not the 10 s stall");
    await h.advance(TIMING.videoErrorMs);
    assert.match(h.last().status, /sign-in/);
  });

  // Chrome closes the offscreen document 30 s after its start (or the last sound) when nothing was
  // audible; after that the user would only read "30 s without sound".
  for (const buffering of [false, true]) {
    test(`videos that never start halt before Chrome closes the document (${buffering ? "buffering" : "unstarted"})`, async () => {
      const h = harness();
      h.engine.boot({ year: 2010 });
      const start = h.now;
      h.engine.control({ cmd: "play" });
      let answered = 0;
      while (h.engine.snapshot().playing && h.now - start < 60_000) {
        await h.flush();
        const loads = h.frame ? h.frame.loads().length : 0;
        if (loads > answered) {                    // each new video loads but never plays
          answered = loads;
          h.frame.state(STATE.UNSTARTED);
          if (buffering) h.frame.state(STATE.BUFFERING);
        }
        await h.advance(500);
      }
      const s = h.last();
      assert.equal(s.playing, false);
      assert.equal(s.problem, true);
      assert.match(s.status, /did not start the music/);
      assert.ok(h.now - start < 30_000, `halted ${h.now - start} ms after Play`);
      assert.equal(s.index, 0, "still the first song");
      assert.equal(h.bad.length, 0, "a stall says nothing about the video");
    });
  }

  test("a stall right after a song ended still gets its retry (the silence counts from the last sound)", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    await h.advance(60_000);                       // a minute of music
    h.frame.state(STATE.ENDED);                    // next song: loads but never plays
    await h.flush();
    h.frame.state(STATE.UNSTARTED);
    await h.advance(TIMING.stallMs);
    assert.equal(h.frame.loads().length, 3, "the next hit of the same song");
    assert.equal(h.last().playing, true);
  });

  test("songs without a video are skipped; eight misses halt with the reason", async () => {
    const h = harness({ answer: () => ({ ok: false, reason: "cooldown" }) });
    h.engine.boot({ year: 2010 });
    h.engine.control({ cmd: "play" });
    await h.flush();
    await h.flush();
    const s = h.last();
    assert.equal(s.playing, false);
    assert.match(s.status, /slow down/);
    assert.equal(h.lookups.filter((q) => !q.prefetch).length, 8);
  });
});

describe("resume and years", () => {
  test("resume continues the same video at the same second without searching", () => {
    const h = harness();
    const s = h.engine.boot({ year: 2010, pos: { index: 1 }, resume: { index: 1, videoId: "abcdefghijk", time: 83, duration: 200 } });
    assert.equal(s.time, 83);
    assert.equal(s.duration, 200);
    assert.equal(s.videoId, "abcdefghijk");
    h.engine.control({ cmd: "play" });
    assert.deepEqual(h.frame.loads(), [["load", "abcdefghijk", 83]]);
    assert.equal(h.lookups.length, 0);
  });

  test("resume for another song is ignored", () => {
    const h = harness();
    const s = h.engine.boot({ year: 2010, pos: { index: 2 }, resume: { index: 1, videoId: "abcdefghijk", time: 83 } });
    assert.equal(s.time, 0);
    assert.equal(s.videoId, null);
  });

  test("seek before play moves the resume point", () => {
    const h = harness();
    h.engine.boot({ year: 2010, resume: { index: 0, videoId: "abcdefghijk", time: 10, duration: 200 } });
    h.engine.control({ cmd: "seek", time: 50 });
    h.engine.control({ cmd: "play" });
    assert.deepEqual(h.frame.loads(), [["load", "abcdefghijk", 50]]);
  });

  test("a new year while playing switches to that year's chart and keeps playing", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    await playing(h);
    const s = h.engine.control({ cmd: "year", year: 2011, pos: { index: 1 } });
    assert.equal(s.year, 2011);
    assert.equal(s.index, 1);
    assert.equal(s.skin, "itunes");
    assert.equal(s.playing, true);
    await h.flush();
    assert.equal(h.frame.loads().at(-1)[1], idFor("Moves like Jagger"));
  });

  test("a new year while paused only switches; autoplay starts it", async () => {
    const h = harness();
    h.engine.boot({ year: 2010 });
    let s = h.engine.control({ cmd: "year", year: 2011 });
    assert.equal(s.playing, false);
    assert.equal(h.lookups.length, 0);
    s = h.engine.control({ cmd: "year", year: 2010, autoplay: true });
    assert.equal(s.playing, true);
    await h.flush();
    assert.equal(h.frame.loads().at(-1)[1], idFor("Tik Tok"));
  });
});
