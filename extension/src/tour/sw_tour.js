// Tour module, service-worker side. Opens the first-run tour (src/tour/welcome.html) in a tab:
//  - after a fresh install (onInstalled reason "install");
//  - once after the update that brings the tour to an existing install (reason "update" while the
//    tour was never shown or finished), so a reloaded unpacked copy shows it one time too;
//  - on {type: "tour:open"} from the popup's "?" button: an open tour tab is focused and restarted,
//    otherwise a new tab opens. Reply: {ok: true, tabId, reused} or {ok: false, error}.
import { TOUR_PAGE, TOUR_KEYS } from "./tour_core.js";

export function tourUrl() {
  return chrome.runtime.getURL(TOUR_PAGE);
}

const urlOf = (tab) => String(tab.url || tab.pendingUrl || "").split("#")[0];

export async function openTour({ auto = false } = {}) {
  const url = tourUrl();
  if (auto) await chrome.storage.local.set({ [TOUR_KEYS.shown]: true });
  const tabs = await chrome.tabs.query({});
  const open = tabs.find((tab) => urlOf(tab) === url);
  if (open) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.tabs.reload(open.id);
    if (open.windowId !== undefined && chrome.windows?.update) {
      await chrome.windows.update(open.windowId, { focused: true }).catch(() => {});
    }
    return { ok: true, tabId: open.id, reused: true };
  }
  const tab = await chrome.tabs.create({ url });
  return { ok: true, tabId: tab.id, reused: false };
}

export async function handleInstalled(details) {
  const reason = details && details.reason;
  if (reason === "install") return openTour({ auto: true });
  if (reason === "update") {
    const seen = await chrome.storage.local.get([TOUR_KEYS.done, TOUR_KEYS.shown]);
    if (!seen[TOUR_KEYS.done] && !seen[TOUR_KEYS.shown]) return openTour({ auto: true });
  }
  return null;
}

export function initTour() {
  // Listeners are registered synchronously on every service-worker start (MV3 rule).
  chrome.runtime.onInstalled.addListener((details) => {
    handleInstalled(details).catch((err) => console.warn("[Yesteryear tour] could not open the tour:", err));
  });
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.type !== "tour:open") return false;
    openTour().then(reply, (err) => reply({ ok: false, error: String((err && err.message) || err) }));
    return true;
  });
}
