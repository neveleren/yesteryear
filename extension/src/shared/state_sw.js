// Shared state for the service worker side. The single source of truth is chrome.storage.local.
// Content scripts read the same keys through src/shared/common.js (YY.getState / YY.onStateChange).

export const MIN_YEAR = 1998;
export const MAX_YEAR = 2025;

export const DEFAULTS = Object.freeze({
  enabled: false,      // master switch ("time machine on")
  year: 2010,          // chosen year, MIN_YEAR..MAX_YEAR
  google: true,        // apply to Google search
  youtube: true,       // apply to YouTube
  strict: true,        // never show a capture or page from after the chosen year
  eraLook: true,       // draw Google/YouTube in the chosen year's look
  musicAutoplay: false // start the player when the year changes
});

export async function getState() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}

export async function setState(patch) {
  const clean = { ...patch };
  if ("year" in clean) {
    const y = Math.round(Number(clean.year));
    clean.year = Math.min(MAX_YEAR, Math.max(MIN_YEAR, Number.isFinite(y) ? y : DEFAULTS.year));
  }
  await chrome.storage.local.set(clean);
  return getState();
}

// Last instant that still belongs to the chosen year, as a Wayback 14-digit timestamp.
export function cutoffTimestamp(year) {
  return `${year}1231235959`;
}

export function initState() {
  chrome.runtime.onInstalled.addListener(async () => {
    const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
    const missing = {};
    for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in s)) missing[k] = v;
    if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  });
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "getState") { getState().then(reply); return true; }
    if (msg?.type === "setState") { setState(msg.patch || {}).then(reply); return true; }
    return false;
  });
}
