// Yesteryear tour: the steps, the two guides and the layout rules as plain data and pure functions
// (no DOM, no chrome.*), so node --test can check them. welcome.js draws the tour, sw_tour.js opens it.
import { gestureFor } from "./agent.js";

export const TOUR_PAGE = "src/tour/welcome.html";

// chrome.storage.local keys of this module (prefix "tour:").
export const TOUR_KEYS = Object.freeze({
  agent: "tour:agent", // "clippy" | "rover": the guide picked last time
  done: "tour:done",   // true once the tour was finished or skipped
  sound: "tour:sound", // false: the guide stays silent
  shown: "tour:shown"  // true once the service worker opened the tour by itself
});

// Step animation placeholder: point at the control (GestureLeft/Right/Up/Down, else Look...).
export const GESTURE = "@gesture";

// Animation names come from the vendored data (src/vendor/clippy/agents/<id>/agent.json).
// Clippy's sprite includes his sheet of paper; Rover has no gesture to his right, only GestureLeft.
export const AGENTS = Object.freeze({
  clippy: Object.freeze({
    id: "clippy",
    name: "Clippy",
    blurb: "The paperclip from Office 97.",
    hello: "Hi! I'm Clippy.",
    enter: "Greeting",   // rides in on a bicycle and bends into shape
    leave: "GoodBye",    // turns into a bicycle and rides off
    fallback: "Explain",
    idle: Object.freeze(["Idle1_1", "IdleSideToSide", "IdleHeadScratch", "IdleFingerTap", "IdleEyeBrowRaise", "IdleAtom"]),
    preview: Object.freeze(["Idle1_1", "IdleSideToSide", "IdleHeadScratch", "IdleEyeBrowRaise", "IdleFingerTap"]),
    poke: Object.freeze(["GetTechy", "GetWizardy", "GetArtsy", "Print", "Save", "SendMail", "EmptyTrash", "Processing", "Writing", "Alert"]),
    move: Object.freeze({ arc: 24 }), // floats over in a low arc
    lookWhileMoving: true             // eyes turn toward where he is going
  }),
  rover: Object.freeze({
    id: "rover",
    name: "Rover",
    blurb: "The search dog from Windows XP.",
    hello: "Woof! I'm Rover.",
    enter: "Show",       // runs in from the distance
    leave: "Hide",       // trots off into the distance
    fallback: "Acknowledge",
    idle: Object.freeze(["Idle", "LookUp", "LookUpLeft", "Thinking", "GetAttentionMinor", "Acknowledge"]),
    preview: Object.freeze(["LookUp", "LookUpLeft", "Thinking", "GetAttentionMinor", "Acknowledge", "ClickedOn"]),
    poke: Object.freeze(["ClickedOn", "Embarrassed", "Surprised", "Money", "Cooking", "Shopping", "Sports", "Books", "Writing", "Pleased"]),
    move: Object.freeze({ hops: 4, hopHeight: 7 }), // trots: four small bounces per trip
    lookWhileMoving: false
  })
});
export const AGENT_IDS = Object.freeze(Object.keys(AGENTS));
export const DEFAULT_AGENT = "clippy";

// Next, Back, Skip and Escape give the guide this long to wind his animation down before he moves
// on or says goodbye (Agent.exit() hurries the way out to fit, so it is never cut short).
export const EXIT_MS = 600;

// The seven steps. boxes: one highlight per inner list (the union of those elements inside the popup,
// src/ui/popup.html, that exist); the guide stands beside box `anchor` (default 0), on `side` of the
// window. hints: extra lines; one with `when` shows only if the popup has that element (the "?"
// button and the mini player arrive with other modules).
export const STEPS = Object.freeze([
  {
    id: "welcome",
    title: "{hello}",
    text: "Yesteryear is a time machine for Google and YouTube. Pick a year, search as usual, and you only see what existed back then.",
    hints: [{ text: "This window opens from the Yesteryear button in Chrome's toolbar (find it under the puzzle piece and pin it)." }],
    boxes: [[".window"]],
    side: "right",
    anim: { clippy: "Wave", rover: "Greet" }
  },
  {
    id: "year",
    title: "Pick a year",
    text: "This is the year you travel to, from 1998 to 2025. Click the arrows (hold one to spin), drag the slider or press a quick year.",
    boxes: [[".dial", ".slider-row", ".quick"]],
    side: "left",
    anim: { clippy: GESTURE, rover: "Travel" }
  },
  {
    id: "on",
    title: "Start the trip",
    text: "The Travel button flies you to your year and switches the time machine on. Ticking Time machine ON does the same without the ride.",
    hints: [{ text: "The Yesteryear button then shows your year on its badge." }],
    boxes: [["#travel"], [".master"]],
    side: "right",
    anim: { clippy: "GetAttention", rover: "GetAttention" }
  },
  {
    id: "sites",
    title: "Google and YouTube",
    text: "Choose where to travel. Google shows only results from your year or older. YouTube shows only videos uploaded by then (it started in 2005).",
    boxes: [[".pair"]],
    side: "left",
    anim: { clippy: "Searching", rover: "Searching" }
  },
  {
    id: "strict",
    title: "Strict and Period look",
    text: "Strict also hides results that give away a later year, and sites that did not exist yet. Period look makes Google and YouTube look the way they did back then.",
    boxes: [[".field-row:has(#opt-strict)", ".field-row:has(#opt-eraLook)"]],
    side: "right",
    anim: { clippy: "CheckingSomething", rover: "ImageSearching" }
  },
  {
    id: "music",
    title: "Music of the year",
    text: "That year's Billboard hits play right here. Show player opens the big player; hide the player there and the music keeps playing.",
    hints: [{ when: "#mini-player", text: "The mini player's Play, back and forward work while the big player is hidden." }],
    boxes: [["#mini-player"]],
    side: "left",
    anim: { clippy: "Hearing_1", rover: "Celebrity" }
  },
  {
    id: "off",
    title: "Back to the present",
    text: "Untick Time machine ON and Google and YouTube are normal again. The button's badge then says OFF.",
    hints: [{ when: "#help", text: "Want this tour again? Click ? in the title bar." }],
    boxes: [[".master"], ["#help"]],
    side: "right",
    anim: { clippy: "Congratulate", rover: "Congratulate" }
  }
]);

export function resolveAgentId(value) {
  return Object.hasOwn(AGENTS, value) ? value : DEFAULT_AGENT;
}

// The text of a step for one guide: { title, text, hint }. has(selector): does the popup have it?
export function stepContent(step, agentId, { has = () => false } = {}) {
  const agent = AGENTS[resolveAgentId(agentId)];
  const fill = (s) => String(s || "").replace(/\{hello\}/g, agent.hello).replace(/\{name\}/g, agent.name);
  const hint = (step.hints || []).filter((h) => !h.when || has(h.when)).map((h) => h.text).join(" ");
  return { title: fill(step.title), text: fill(step.text), hint: fill(hint) };
}

// The animation a guide plays for a step. GESTURE needs the character data and two points
// (the guide's centre and the control's centre).
export function animFor(step, agentId, { data, from, to } = {}) {
  const id = resolveAgentId(agentId);
  const want = step.anim[id];
  if (want !== GESTURE) return want;
  return (data && from && to && gestureFor(data, from, to)) || AGENTS[id].fallback;
}

// ---- Layout (rects are { x, y, w, h } in the tour stage's pixels) -------------------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function unionRect(rects) {
  const list = rects.filter((r) => r && r.w >= 0 && r.h >= 0);
  if (!list.length) return null;
  const x = Math.min(...list.map((r) => r.x));
  const y = Math.min(...list.map((r) => r.y));
  return { x, y, w: Math.max(...list.map((r) => r.x + r.w)) - x, h: Math.max(...list.map((r) => r.y + r.h)) - y };
}

export function padRect(r, p) {
  return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p };
}

export const centerOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

// Where the guide stands for a control: beside the window (`frame`) on the preferred side, level with
// the control; the other side if there is no room; on the window's edge below the control if
// neither side fits (a narrow tab). Returns { x, y, side: "left"|"right"|"below" } (top-left corner).
export function agentSpot({ target, frame, size, side = "right", bounds, gap = 14, margin = 8 }) {
  const minX = bounds.x + margin;
  const maxX = bounds.x + bounds.w - margin - size.w;
  const minY = bounds.y + margin;
  const maxY = Math.max(minY, bounds.y + bounds.h - margin - size.h);
  const y = clamp(target.y + target.h / 2 - size.h / 2, minY, maxY);
  for (const s of side === "left" ? ["left", "right"] : ["right", "left"]) {
    const x = s === "right" ? frame.x + frame.w + gap : frame.x - gap - size.w;
    if (x >= minX && x <= maxX) return { x, y, side: s };
  }
  return {
    x: clamp(target.x + target.w - size.w / 2, minX, Math.max(minX, maxX)),
    y: clamp(target.y + target.h + gap, minY, maxY),
    side: "below"
  };
}

// welcome.html#agent=rover&step=3&sound=0 starts at a step without the picker (handy for testing).
export function parseHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const agent = params.get("agent");
  const step = Number(params.get("step"));
  const sound = params.get("sound");
  return {
    agent: Object.hasOwn(AGENTS, agent) ? agent : null,
    step: Number.isInteger(step) && step >= 1 && step <= STEPS.length ? step : null,
    sound: sound === "0" ? false : sound === "1" ? true : null
  };
}

// What a key does on the tour page: "no-tour", "skip", "next", "back" or null. ui = { picker, done,
// leaving, busy, step, balloon }: dialogs open, goodbye under way, guide on the move, step on screen
// (-1: none), balloon shown. Escape leaves whenever the guide is out, also during his entrance and
// between steps, when no Skip button is on screen; the arrows need the balloon.
export function keyAction(key, ui) {
  if (ui.picker) return key === "Escape" ? "no-tour" : null;
  if (key === "Escape") return !ui.done && !ui.leaving && (ui.busy || ui.step >= 0) ? "skip" : null;
  if (ui.step < 0 || !ui.balloon) return null;
  if (key === "ArrowRight" || key === "PageDown") return "next";
  if (key === "ArrowLeft" || key === "PageUp") return "back";
  return null;
}

// The message box at the end.
export function doneText(how, { hasHelp = false } = {}) {
  if (how === "skipped") {
    return hasHelp
      ? "No problem. You can start the tour again any time with the ? button in the Yesteryear window."
      : "No problem. Click the Yesteryear button in Chrome's toolbar whenever you want to travel back in time.";
  }
  return "You're all set! Click the Yesteryear button in Chrome's toolbar, pick a year, tick Time machine ON and search away.";
}
