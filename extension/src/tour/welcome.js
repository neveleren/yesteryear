// Yesteryear first-run tour. A Windows 98 desktop with the real Yesteryear window on it (an iframe
// of ../ui/popup.html, inert outside and in: always identical, never clickable or focusable, never
// writes a setting) and an Office Assistant (Clippy or Rover) who walks through it in seven steps.
// For every step the guide glides next to the control, the control gets marching ants, and the guide
// plays its own animation. Extension page: bundled scripts only, DOM built with createElement/textContent.
import { Agent, Balloon, loadAgent, END } from "./agent.js";
import {
  TOUR_KEYS, AGENTS, AGENT_IDS, DEFAULT_AGENT, STEPS, EXIT_MS, stepContent, animFor, agentSpot, unionRect,
  padRect, centerOf, parseHash, resolveAgentId, doneText, keyAction
} from "./tour_core.js";

const HAS_CHROME = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
const HOLD_MS = 9000;  // a looping step animation keeps its pose this long, then the guide idles
const SHOW_MS = 6500;  // longest wait for the entrance / goodbye animation

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const replica = $("replica");
const picker = $("picker");
const done = $("done");
const muteButton = $("mute");

const state = {
  agentId: DEFAULT_AGENT,
  sound: true,
  step: -1,       // step on screen, -1 = none
  nav: 0,         // bumps on every navigation; stale async work checks it and stops
  busy: false     // the guide is moving between steps
};
let leaving = false; // finish() is under way (the goodbye); Escape must not start it again
let agent = null;
let balloon = null;
let highlights = [];
const previews = [];
const agentDefs = new Map(); // id -> Promise of loadAgent()

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (err) => (err && err.message) || String(err);

// ---- Storage ----------------------------------------------------------------------------------------
async function readPrefs() {
  if (!HAS_CHROME) return {};
  try {
    return await chrome.storage.local.get([TOUR_KEYS.agent, TOUR_KEYS.sound]);
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  if (!HAS_CHROME) return Promise.resolve();
  return chrome.storage.local.set(patch).catch((err) => showProblem(`Could not save: ${errorText(err)}`));
}

function showProblem(text) {
  const p = $("problem");
  p.textContent = text;
  p.hidden = !text;
}

function agentDef(id) {
  if (!agentDefs.has(id)) agentDefs.set(id, loadAgent(id));
  return agentDefs.get(id);
}

// ---- Geometry (stage pixels) -----------------------------------------------------------------------
function stageRect(el) {
  const s = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
}

const frameDoc = () => {
  try { return replica.contentDocument; } catch { return null; }
};

// An element inside the replica, in stage pixels (the iframe has no border or scrolling).
function innerRect(el) {
  const f = stageRect(replica);
  const r = el.getBoundingClientRect();
  return { x: f.x + r.left, y: f.y + r.top, w: r.width, h: r.height };
}

function windowRect() {
  const win = frameDoc()?.querySelector(".window");
  return win ? innerRect(win) : stageRect(replica);
}

function bounds() {
  return { x: 0, y: 0, w: stage.clientWidth, h: stage.clientHeight };
}

// One rect (or null) per highlight box of a step.
function boxRects(index) {
  const doc = frameDoc();
  return STEPS[index].boxes.map((selectors) => {
    if (!doc) return null;
    const rects = [];
    for (const sel of selectors) {
      let found = [];
      try { found = [...doc.querySelectorAll(sel)]; } catch { found = []; }
      for (const el of found) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) rects.push(innerRect(el));
      }
    }
    const union = unionRect(rects);
    return union ? padRect(union, 4) : null;
  });
}

function anchorRect(index) {
  const boxes = boxRects(index);
  return boxes[STEPS[index].anchor || 0] || boxes.find(Boolean) || windowRect();
}

function spotFor(index) {
  return agentSpot({
    target: anchorRect(index),
    frame: windowRect(),
    size: { w: agent.w, h: agent.h },
    side: STEPS[index].side,
    bounds: bounds()
  });
}

function balloonOptions(index, spot) {
  return {
    bounds: bounds(),
    avoid: [windowRect(), ...boxRects(index).filter(Boolean)],
    prefer: spot.side === "left" ? "left" : "right"
  };
}

const hasHelpButton = () => Boolean(frameDoc()?.getElementById("help"));

// ---- The replica ------------------------------------------------------------------------------------
function measureReplica() {
  const body = frameDoc()?.body;
  if (!body) return;
  const r = body.getBoundingClientRect();
  if (r.width > 0) replica.style.width = `${Math.ceil(r.width)}px`;
  if (r.height > 0) replica.style.height = `${Math.ceil(r.height)}px`;
}

function layoutReplica() {
  const w = replica.offsetWidth;
  const h = replica.offsetHeight;
  // A taller popup (new controls in later versions) makes the desktop taller instead of being cut off.
  stage.style.minHeight = `${Math.max(600, h + 48)}px`;
  const { w: W, h: H } = bounds();
  replica.style.left = `${Math.max(8, Math.round((W - w) / 2))}px`;
  replica.style.top = `${Math.max(16, Math.round((H - h) / 2.2))}px`;
}

// The replica must never take focus, clicks or keys: they would change the real settings. popup.js
// focuses its year slider once it has drawn itself, and the iframe's inert attribute does not stop
// that here, so keys then went to the popup. The page inside is made inert too, as early as possible
// (its focus() is then refused), and focus that got in anyway comes back out.
function quietReplica() {
  const doc = frameDoc();
  if (doc?.documentElement) doc.documentElement.inert = true;
  if (document.activeElement !== replica) return;
  doc?.activeElement?.blur?.();
  replica.blur();
  if (!picker.hidden) $("start").focus({ preventScroll: true });
}

// Resolves once the popup inside the iframe has read the settings and drawn itself.
function prepareReplica() {
  quietReplica();
  replica.addEventListener("load", quietReplica);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      quietReplica();
      measureReplica();
      layoutReplica();
      const doc = frameDoc();
      const win = replica.contentWindow;
      if (doc?.body && win?.ResizeObserver) {
        new win.ResizeObserver(() => { measureReplica(); relayout(); }).observe(doc.body);
      }
      resolve();
    };
    const ready = () => {
      const doc = frameDoc();
      return Boolean(doc && doc.readyState === "complete" && doc.querySelector(".window") &&
        !doc.documentElement.classList.contains("loading"));
    };
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      quietReplica();
      if (ready()) {
        clearInterval(poll);
        const fonts = frameDoc()?.fonts?.ready;
        (fonts || Promise.resolve()).then(finish, finish);
      } else if (tries > 80) { // 4 s: show what there is
        clearInterval(poll);
        finish();
      }
    }, 50);
  });
}

// Win98 "animate windows": a title bar flies from the taskbar button, then the window is there.
async function revealReplica() {
  if (!replica.classList.contains("hidden")) return;
  layoutReplica();
  if (!reducedMotion()) {
    const from = $("task").getBoundingClientRect();
    const to = replica.getBoundingClientRect();
    const bar = document.createElement("div");
    bar.className = "zoom";
    document.body.append(bar);
    const box = (x, y, w, h) => ({ transform: `translate(${x}px, ${y}px)`, width: `${w}px`, height: `${h}px` });
    const fly = bar.animate(
      [box(from.left, from.top, from.width, from.height), box(to.left + 6, to.top + 6, to.width - 12, 18)],
      { duration: 280, easing: "ease-in" }
    );
    await fly.finished.catch(() => {});
    bar.remove();
  }
  replica.classList.remove("hidden");
}

// ---- Highlights ----------------------------------------------------------------------------------
function clearHighlight() {
  for (const el of highlights) el.remove();
  highlights = [];
}

function setHighlight(index, { flash = true } = {}) {
  clearHighlight();
  for (const r of boxRects(index)) {
    if (!r) continue;
    const el = document.createElement("div");
    el.className = flash ? "yy-ants flash" : "yy-ants";
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    stage.append(el);
    highlights.push(el);
  }
}

// ---- Balloon content ---------------------------------------------------------------------------------
function button(label, onClick, { id, isDefault = false, disabled = false } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (id) b.id = id;
  if (isDefault) b.className = "default";
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

function stepNode(index) {
  const has = (selector) => {
    try { return Boolean(frameDoc()?.querySelector(selector)); } catch { return false; }
  };
  const content = stepContent(STEPS[index], state.agentId, { has });
  const last = index === STEPS.length - 1;
  const wrap = document.createElement("div");
  wrap.className = "yy-step";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-labelledby", "tour-title");

  const title = document.createElement("h2");
  title.id = "tour-title";
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = `${index + 1} of ${STEPS.length}`;
  title.append(count, content.title);

  const text = document.createElement("p");
  text.textContent = content.text;
  wrap.append(title, text);
  if (content.hint) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = content.hint;
    wrap.append(hint);
  }

  const row = document.createElement("div");
  row.className = "buttons";
  row.append(button("< Back", () => goTo(index - 1), { disabled: index === 0 }));
  row.append(button(last ? "Let's go!" : "Next >", () => (last ? finish("finished") : goTo(index + 1)), { id: "tour-next", isDefault: true }));
  if (!last) row.append(button("Skip", () => finish("skipped"), { id: "tour-skip" }));
  wrap.append(row);
  return wrap;
}

// ---- The tour ------------------------------------------------------------------------------------
async function ensureGuide(token) {
  const def = await agentDef(state.agentId);
  if (token !== state.nav) return false;
  if (!agent || agent.def.id !== def.id) {
    agent?.destroy();
    const cfg = AGENTS[state.agentId];
    agent = new Agent(stage, def, { muted: !state.sound, moveStyle: cfg.move, lookWhileMoving: cfg.lookWhileMoving });
    agent.el.title = `${cfg.name} (click me)`;
    agent.el.addEventListener("click", poke);
  }
  if (!balloon) balloon = new Balloon(stage);
  agent.setMuted(!state.sound);
  return true;
}

async function startTour(index = 0) {
  const token = ++state.nav;
  leaving = false;
  state.busy = true;
  state.step = -1;
  done.hidden = true;
  balloon?.hide();
  clearHighlight();
  await revealReplica();
  try {
    if (!(await ensureGuide(token))) return;
  } catch (err) {
    showProblem(`Could not load the guide: ${errorText(err)}`);
    state.busy = false;
    return;
  }
  const spot = spotFor(index);
  agent.stop();
  agent.place(spot.x, spot.y);
  agent.show();
  setHighlight(index);
  await withTimeout(agent.play(AGENTS[state.agentId].enter), SHOW_MS);
  if (token !== state.nav) return;
  present(index, spot, token);
}

async function goTo(index) {
  if (!agent || index < 0 || index >= STEPS.length) return;
  const token = ++state.nav;
  state.busy = true;
  state.step = index;
  balloon.hide();
  agent.stopIdle();
  setHighlight(index);
  await agent.exit(EXIT_MS);
  if (token !== state.nav) return;
  const spot = spotFor(index);
  await agent.moveTo(spot.x, spot.y);
  if (token !== state.nav) return;
  present(index, spot, token);
}

function present(index, spot, token) {
  const cfg = AGENTS[state.agentId];
  state.step = index;
  state.busy = false;
  balloon.show(stepNode(index), agent.rect(), balloonOptions(index, spot));
  $("tour-next")?.focus({ preventScroll: true });
  const name = animFor(STEPS[index], state.agentId, { data: agent.data, from: agent.center(), to: centerOf(anchorRect(index)) });
  agent.stopIdle();
  agent.play(name, { holdMs: HOLD_MS }).then((end) => {
    if (token === state.nav && end === END.EXITED) agent.startIdle({ names: cfg.idle });
  });
}

async function withTimeout(promise, ms) {
  const result = await Promise.race([promise, sleep(ms).then(() => "timeout")]);
  if (result === "timeout") agent?.stop();
  return result;
}

async function finish(how) {
  const token = ++state.nav;
  leaving = true;
  state.busy = true;
  state.step = -1;
  savePrefs({ [TOUR_KEYS.done]: true });
  balloon?.hide();
  clearHighlight();
  if (agent && !agent.el.hidden) {
    agent.stopIdle();
    agent.place(agent.x, agent.y); // Escape during a glide: he stops where he is
    await agent.exit(EXIT_MS);
    if (token !== state.nav) return;
    await withTimeout(agent.play(AGENTS[state.agentId].leave), SHOW_MS);
    if (token !== state.nav) return;
    agent.hide();
  }
  state.busy = false;
  showDone(how);
}

function showDone(how) {
  leaving = false;
  $("done-text").textContent = doneText(how, { hasHelp: hasHelpButton() });
  done.hidden = false;
  $("done-close").focus();
}

// A click on the guide: one of its party tricks, like the original.
function poke() {
  if (!agent || state.busy || state.step < 0) return;
  const cfg = AGENTS[state.agentId];
  const tricks = cfg.poke.filter((n) => agent.has(n));
  if (!tricks.length) return;
  const token = state.nav;
  agent.stopIdle();
  agent.play(tricks[Math.floor(Math.random() * tricks.length)], { holdMs: 4000 }).then((end) => {
    if (token === state.nav && end === END.EXITED) agent.startIdle({ names: cfg.idle });
  });
}

function relayout() {
  layoutReplica();
  if (!agent || state.busy || state.step < 0 || !balloon?.visible) return;
  const spot = spotFor(state.step);
  agent.place(spot.x, spot.y);
  setHighlight(state.step, { flash: false });
  balloon.reposition(agent.rect(), balloonOptions(state.step, spot));
}

// ---- Picker ------------------------------------------------------------------------------------------
function selectedAgent() {
  const checked = picker.querySelector("input[name=agent]:checked");
  return resolveAgentId(checked && checked.value);
}

function markSelected() {
  const id = selectedAgent();
  for (const other of AGENT_IDS) $(`choice-${other}`).classList.toggle("selected", other === id);
}

function openPicker() {
  done.hidden = true;
  picker.hidden = false;
  $(`pick-${state.agentId}`).checked = true;
  $("opt-sound").checked = state.sound;
  markSelected();
  for (const id of AGENT_IDS) {
    $(`blurb-${id}`).textContent = AGENTS[id].blurb;
    agentDef(id).then((def) => {
      if (picker.hidden) return;
      const box = $(`preview-${id}`);
      const preview = new Agent(box, def, { muted: true });
      preview.place(Math.round((box.clientWidth - preview.w) / 2), Math.round((box.clientHeight - preview.h) / 2));
      preview.show();
      preview.startIdle({ names: AGENTS[id].preview, delay: [700, 2600], holdMs: 4000 });
      previews.push(preview);
    }).catch((err) => showProblem(`Could not load ${AGENTS[id].name}: ${errorText(err)}`));
  }
  $("start").focus({ preventScroll: true });
}

function closePicker() {
  picker.hidden = true;
  for (const p of previews.splice(0)) p.destroy();
}

async function onStart() {
  state.agentId = selectedAgent();
  state.sound = $("opt-sound").checked;
  renderMute();
  savePrefs({ [TOUR_KEYS.agent]: state.agentId, [TOUR_KEYS.sound]: state.sound });
  closePicker();
  await replicaReady;
  startTour(0);
}

function noTour() {
  closePicker();
  finish("skipped");
}

// ---- Taskbar --------------------------------------------------------------------------------------
function renderMute() {
  muteButton.setAttribute("aria-pressed", String(state.sound));
  muteButton.title = state.sound ? "Sounds: on" : "Sounds: off";
}

function toggleSound() {
  state.sound = !state.sound;
  renderMute();
  agent?.setMuted(!state.sound);
  if (!picker.hidden) $("opt-sound").checked = state.sound;
  savePrefs({ [TOUR_KEYS.sound]: state.sound });
}

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function closeTab() {
  if (HAS_CHROME && chrome.tabs?.getCurrent) {
    chrome.tabs.getCurrent().then((tab) => (tab ? chrome.tabs.remove(tab.id) : window.close()), () => window.close());
  } else {
    window.close();
  }
}

// ---- Wiring ------------------------------------------------------------------------------------------
for (const id of AGENT_IDS) $(`pick-${id}`).addEventListener("change", markSelected);
$("start").addEventListener("click", onStart);
$("no-tour").addEventListener("click", noTour);
$("picker-close").addEventListener("click", noTour);
$("opt-sound").addEventListener("change", () => {
  state.sound = $("opt-sound").checked;
  renderMute();
});
$("done-close").addEventListener("click", closeTab);
$("done-x").addEventListener("click", closeTab);
$("done-again").addEventListener("click", () => {
  done.hidden = true;
  openPicker();
});
muteButton.addEventListener("click", toggleSound);

document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
  const action = keyAction(event.key, {
    picker: !picker.hidden, done: !done.hidden, leaving, busy: state.busy, step: state.step, balloon: Boolean(balloon?.visible)
  });
  if (action === "no-tour") {
    noTour();
    return;
  }
  if (!action) return;
  event.preventDefault();
  if (action === "skip") finish("skipped");
  else if (action === "next") {
    if (state.step < STEPS.length - 1) goTo(state.step + 1);
  } else goTo(state.step - 1);
});

let resizeTimer = null;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(relayout, 80);
});

// ---- Start ----------------------------------------------------------------------------------------
tickClock();
setInterval(tickClock, 15000);
const replicaReady = prepareReplica();
const prefs = await readPrefs();
state.agentId = resolveAgentId(prefs[TOUR_KEYS.agent]);
state.sound = prefs[TOUR_KEYS.sound] !== false;
const hash = parseHash(location.hash);
if (hash.sound !== null) state.sound = hash.sound;
renderMute();
if (hash.step) {
  if (hash.agent) state.agentId = hash.agent;
  await replicaReady;
  startTour(hash.step - 1);
} else {
  openPicker();
}
