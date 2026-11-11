// UI module, service-worker side. The toolbar badge shows the chosen year while the time machine
// is ON ("2010" on Win98 navy) and a grey "OFF" otherwise; the tooltip says the same in words.
// The toolbar button keeps opening the popup: the side panel (music player) opens only from the
// mini player's "Show player" button in the popup (src/player/miniplayer.js) or the travel card.
import { getState } from "../shared/state_sw.js";
import { BADGE_KEYS, badgeFor, titleFor } from "./logic.js";

let refreshSeq = 0; // a slower, older refresh must not overwrite a newer one

export async function refreshBadge() {
  const seq = ++refreshSeq;
  try {
    const state = await getState();
    if (seq !== refreshSeq) return;
    const badge = badgeFor(state);
    await Promise.all([
      chrome.action.setBadgeText({ text: badge.text }),
      chrome.action.setBadgeBackgroundColor({ color: badge.background }),
      chrome.action.setBadgeTextColor?.({ color: badge.textColor }), // Chrome 110+
      chrome.action.setTitle({ title: titleFor(state) })
    ]);
  } catch (err) {
    console.warn("[Yesteryear ui] badge update failed:", err);
  }
}

export function initUI() {
  // Listeners are registered synchronously on every service-worker start (MV3 rule).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && BADGE_KEYS.some((k) => k in changes)) refreshBadge();
  });
  // Badge text set at runtime is gone after a browser restart. Registering onStartup is what makes
  // Chrome start this service worker at launch, so the badge is back before the first click.
  chrome.runtime.onStartup.addListener(() => { refreshBadge(); });

  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })
      ?.catch?.((err) => console.warn("[Yesteryear ui] setPanelBehavior failed:", err));
  } catch (err) {
    console.warn("[Yesteryear ui] setPanelBehavior failed:", err);
  }

  return refreshBadge(); // also covers install, update, reload and every later wake-up
}
