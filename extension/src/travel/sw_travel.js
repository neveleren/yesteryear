// Time travel, service-worker side.
//   travel:go {from, to, sound?} -> {ok:true, tabId, url} | {ok:false, reason: "bad-request" | "error"}
// Opens src/travel/travel.html#from=<from>&to=<to>&t=<nonce> in the sender's tab when the message comes from a page in
// a tab, otherwise (the toolbar popup has no tab) in the active tab of the focused window when that tab is an
// empty new-tab page or an earlier trip, else in a new tab next to it. Remembers the destination in
// chrome.storage.local "travel:last" (the year of the last trip). It is not the next trip's departure: the
// sender decides that from where the time machine is (the present while it is off).
import { normalizeTrip, travelPath, isReusableTab, LAST_KEY } from "./travel_core.js";

export async function travelGo(msg, sender, api = chrome, present = new Date().getFullYear(), now = Date.now) {
  const trip = normalizeTrip(msg?.from, msg?.to, present);
  if (!trip) return { ok: false, reason: "bad-request" };
  const nonce = Math.floor(now()).toString(36); // a new fragment for every trip, see parseTravelHash()
  const url = api.runtime.getURL(travelPath({ from: trip.from, to: trip.to, sound: msg?.sound !== false, nonce }));
  await api.storage.local.set({ [LAST_KEY]: trip.to });

  const own = sender?.tab;
  if (own && Number.isInteger(own.id) && own.id >= 0) {
    const tab = await api.tabs.update(own.id, { url, active: true });
    return { ok: true, tabId: tab?.id ?? own.id, url };
  }
  const [active] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  const origin = api.runtime.getURL("").replace(/\/$/, "");
  if (active && isReusableTab(active.pendingUrl || active.url, origin)) {
    const tab = await api.tabs.update(active.id, { url });
    return { ok: true, tabId: tab?.id ?? active.id, url };
  }
  const props = { url, active: true };
  if (active) Object.assign(props, { windowId: active.windowId, index: active.index + 1, openerTabId: active.id });
  const tab = await api.tabs.create(props);
  return { ok: true, tabId: tab?.id, url };
}

export function initTravel() {
  // Registered synchronously on every service-worker start (MV3 rule).
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type !== "travel:go") return false;
    travelGo(msg, sender).then(reply, (err) => {
      console.warn("[Yesteryear travel] could not open the trip:", err);
      reply({ ok: false, reason: "error" });
    });
    return true;
  });
}
