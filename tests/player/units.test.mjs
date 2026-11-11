// Unit tests for the small pieces of the music module: the state shape (music_state.js), the YouTube
// widget protocol (ytwidget.js), the fake visualizer levels (visualizer.js), and the playlist additions.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  cleanCommand, makeState, liveTime, isNewer, trackText, clampVolume, COMMANDS, posKey
} from "../../extension/src/player/music_state.js";
import { YouTubeFrame, STATE, embedUrl, EMBED_MARKER } from "../../extension/src/player/ytwidget.js";
import { bandLevels, sweepLevels, hashSeed, tempoFor, LOOKS } from "../../extension/src/player/visualizer.js";
import { songsFor, ErrorPolicy, AUTH, STALL, skinForYear } from "../../extension/src/player/playlist.js";
import { CHARTS } from "./fakes.mjs";

describe("music_state", () => {
  test("cleanCommand keeps only known commands and their fields", () => {
    assert.deepEqual(cleanCommand({ cmd: "play", extra: 1 }), { cmd: "play" });
    assert.deepEqual(cleanCommand({ cmd: "select", index: 4 }), { cmd: "select", index: 4, play: true });
    assert.deepEqual(cleanCommand({ cmd: "select", index: "4", play: false }), { cmd: "select", index: 4, play: false });
    assert.deepEqual(cleanCommand({ cmd: "seek", time: 12.5 }), { cmd: "seek", time: 12.5 });
    assert.deepEqual(cleanCommand({ cmd: "volume", volume: 140 }), { cmd: "volume", volume: 100 });
    assert.deepEqual(cleanCommand({ cmd: "shuffle", on: true }), { cmd: "shuffle", on: true });
    assert.deepEqual(cleanCommand({ cmd: "shuffle", on: "yes" }), { cmd: "shuffle" });
    for (const bad of [null, {}, { cmd: "year" }, { cmd: "state" }, { cmd: "select", index: 1.5 }, { cmd: "seek", time: -1 },
      { cmd: "volume", volume: null }, { cmd: "volume", volume: "" }]) {
      assert.equal(cleanCommand(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual([...COMMANDS], ["play", "pause", "toggle", "next", "prev", "select", "seek", "shuffle", "volume"]);
  });

  test("makeState fills defaults, drops unknown fields and derives the skin", () => {
    const s = makeState({ year: 2003, playing: true, loading: true, track: { artist: "A", title: "T", rank: 2, evil: 1 }, junk: 1 });
    assert.equal(s.skin, "winamp");
    assert.equal(s.loading, true);
    assert.deepEqual(s.track, { artist: "A", title: "T", rank: 2 });
    assert.equal("junk" in s, false);
    assert.equal(makeState({ loading: true }).loading, false, "loading needs playing");
    assert.equal(makeState({ videoId: "not an id" }).videoId, null);
    assert.equal(makeState({ volume: "x" }).volume, 80);
    assert.equal(makeState({ alive: true }).alive, true);
    assert.equal("alive" in makeState({}), false);
    assert.equal(skinForYear(2007), "wmp");
    assert.equal(skinForYear(2016), "spotify");
  });

  test("liveTime counts on while playing, stops at the end, stands still otherwise", () => {
    const s = { playing: true, loading: false, time: 10, at: 1000, duration: 12 };
    assert.equal(liveTime(s, 2000), 11);
    assert.equal(liveTime(s, 9000), 12);
    assert.equal(liveTime({ ...s, loading: true }, 9000), 10);
    assert.equal(liveTime({ ...s, playing: false }, 9000), 10);
    assert.equal(liveTime(null), 0);
  });

  test("isNewer drops late replies", () => {
    assert.equal(isNewer(null, { at: 1 }), true);
    assert.equal(isNewer({ at: 5 }, { at: 4 }), false);
    assert.equal(isNewer({ at: 5 }, { at: 5 }), true);
    assert.equal(isNewer({ at: 5 }, null), false);
  });

  test("small helpers", () => {
    assert.equal(trackText({ track: { artist: "Kesha", title: "Tik Tok" } }), "Kesha - Tik Tok");
    assert.equal(trackText({}), "");
    assert.equal(clampVolume(-4), 0);
    assert.equal(posKey(2010), "mus:pos:2010");
  });
});

describe("YouTube widget protocol", () => {
  function setup() {
    const listeners = [];
    const posted = [];
    const contentWindow = { postMessage: (data, origin) => posted.push({ data: JSON.parse(data), origin }) };
    const iframe = { contentWindow, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, remove() {} };
    const doc = { createElement: () => iframe };
    const win = { addEventListener: (type, fn) => listeners.push(fn), removeEventListener() {} };
    const host = { appended: [], append(x) { this.appended.push(x); } };
    const events = [];
    const frame = new YouTubeFrame(host, {
      onState: (s) => events.push(["state", s]),
      onError: (c) => events.push(["error", c]),
      onTime: (t, d) => events.push(["time", t, d]),
      onReady: () => events.push(["ready"]),
      onVolume: (v, m) => events.push(["volume", v, m]),
      onVideoError: (c) => events.push(["videoError", c])
    }, { doc, win });
    const fromYouTube = (msg) => listeners.forEach((fn) => fn({ origin: "https://www.youtube.com", source: contentWindow, data: JSON.stringify(msg) }));
    return { frame, iframe, posted, events, fromYouTube, listeners, contentWindow };
  }

  test("the embed URL carries the marker the Referer rule matches", () => {
    const url = embedUrl("jNQXAC9IVRw", 42.7);
    assert.match(url, /^https:\/\/www\.youtube\.com\/embed\/jNQXAC9IVRw\?/);
    assert.match(url, new RegExp(`[?&]${EMBED_MARKER}=1(&|$)`));
    assert.match(url, /[?&]start=42(&|$)/);
    assert.match(url, /[?&]enablejsapi=1/);
  });

  test("commands wait for the handshake, then subscribe and flush", () => {
    const { frame, iframe, posted, events, fromYouTube } = setup();
    frame.load("jNQXAC9IVRw");
    frame.setVolume(37);
    frame.unMute();
    assert.equal(posted.length, 0, "nothing before the iframe answered");
    iframe.listeners.load();
    assert.equal(posted[0].data.event, "listening");
    fromYouTube({ event: "onReady" });
    const funcs = posted.filter((p) => p.data.event === "command").map((p) => [p.data.func, p.data.args]);
    assert.deepEqual(funcs, [["addEventListener", ["onStateChange"]], ["addEventListener", ["onError"]], ["setVolume", [37]], ["unMute", []]]);
    assert.ok(posted.every((p) => p.origin === "https://www.youtube.com"));
    assert.deepEqual(events.at(-1), ["ready"]);
  });

  test("infoDelivery: states once per change, time, volume, and errorCode only for our video", () => {
    const { frame, iframe, events, fromYouTube } = setup();
    frame.load("jNQXAC9IVRw");
    iframe.listeners.load();
    fromYouTube({ event: "initialDelivery", info: { playerState: -1, currentTime: 0, duration: 19, volume: 100, muted: false } });
    fromYouTube({ event: "infoDelivery", info: { playerState: -1, videoData: { video_id: "OLDVIDEO000", errorCode: "auth" } } });
    fromYouTube({ event: "infoDelivery", info: { playerState: -1, videoData: { video_id: "jNQXAC9IVRw", errorCode: "auth" } } });
    fromYouTube({ event: "infoDelivery", info: { videoData: { video_id: "jNQXAC9IVRw", errorCode: "auth" } } });
    fromYouTube({ event: "onStateChange", info: 1 });
    fromYouTube({ event: "onError", info: 150 });
    assert.deepEqual(events.filter((e) => e[0] === "state"), [["state", -1], ["state", 1]]);
    assert.deepEqual(events.filter((e) => e[0] === "videoError"), [["videoError", "auth"]]);
    assert.deepEqual(events.find((e) => e[0] === "volume"), ["volume", 100, false]);
    assert.deepEqual(events.find((e) => e[0] === "time"), ["time", 0, 19]);
    assert.deepEqual(events.at(-1), ["error", 150]);
  });

  test("messages from elsewhere are ignored", () => {
    const { frame, iframe, events, listeners, contentWindow } = setup();
    frame.load("jNQXAC9IVRw");
    iframe.listeners.load();
    for (const fn of listeners) {
      fn({ origin: "https://evil.example", source: contentWindow, data: JSON.stringify({ event: "onStateChange", info: 1 }) });
      fn({ origin: "https://www.youtube.com", source: {}, data: JSON.stringify({ event: "onStateChange", info: 1 }) });
    }
    assert.equal(events.length, 0);
    assert.equal(STATE.PLAYING, 1);
  });
});

describe("visualizer levels", () => {
  test("levels are 0..1, deterministic per song, and silent without energy", () => {
    const seed = hashSeed("Kesha|Tik Tok");
    const a = bandLevels(12.34, 19, seed);
    assert.deepEqual(a, bandLevels(12.34, 19, seed));
    assert.ok(a.every((v) => v >= 0 && v <= 1));
    assert.notDeepEqual(a, bandLevels(12.34, 19, hashSeed("Train|Hey, Soul Sister")));
    assert.ok(bandLevels(3, 19, seed, 0).every((v) => v === 0));
    assert.equal(bandLevels(3, 0, seed).length, 0);
  });

  test("bass bands are louder than treble on average, and the beat moves them", () => {
    const seed = hashSeed("x");
    let bass = 0, treble = 0;
    const samples = [];
    for (let t = 0; t < 20; t += 0.05) {
      const l = bandLevels(t, 19, seed);
      bass += l[0] + l[1];
      treble += l[17] + l[18];
      samples.push(l[0]);
    }
    assert.ok(bass > treble * 1.3, `bass ${bass} treble ${treble}`);
    assert.ok(Math.max(...samples) - Math.min(...samples) > 0.3, "the bars dance");
  });

  test("tempo per song is 88..140 BPM; the loading sweep is a soft bump", () => {
    for (const s of ["a", "b", "Kesha|Tik Tok", ""]) {
      const bpm = tempoFor(hashSeed(s));
      assert.ok(bpm >= 88 && bpm <= 140, String(bpm));
    }
    const sw = sweepLevels(1.2, 24);
    assert.equal(sw.length, 24);
    assert.ok(Math.max(...sw) <= 0.32 && Math.max(...sw) > 0.2);
    assert.deepEqual(Object.keys(LOOKS), ["winamp", "wmp", "itunes", "spotify"]);
  });
});

describe("playlist additions", () => {
  test("songsFor falls back to the closest earlier year", () => {
    assert.equal(songsFor(CHARTS, 2010)[0].title, "Tik Tok");
    assert.equal(songsFor(CHARTS, 2015)[0].title, "Rolling in the Deep");
    assert.equal(songsFor(CHARTS, 1990)[0].title, "Tik Tok");
    assert.deepEqual(songsFor(null, 2010), []);
  });

  test("sign-in walls and stalls never mark videos as bad; three sign-in walls halt", () => {
    const p = new ErrorPolicy();
    const song = "A|T";
    assert.equal(p.onError({ videoId: "aaaaaaaaaaa", code: AUTH, song }).action, "retry");
    assert.equal(p.onError({ videoId: "bbbbbbbbbbb", code: STALL, song }).action, "retry");
    assert.deepEqual(p.onError({ videoId: "ccccccccccc", code: AUTH, song: "B|U" }), { action: "retry", exclude: ["ccccccccccc"] });
    assert.deepEqual(p.onError({ videoId: "ddddddddddd", code: AUTH, song: "B|U" }), { action: "halt", why: "auth" });
    assert.deepEqual(p.onPlaying(), []);
  });
});
