// Remote control for the music, used by the side panel (player.js) and the popup mini player
// (miniplayer.js). It only talks to the service worker (music:state, music:control) and listens for
// the music:changed broadcasts; the music itself plays in the offscreen document.
import { MSG, isNewer, makeState } from "./music_state.js";

export function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (reply) => resolve(chrome.runtime.lastError ? null : reply ?? null));
    } catch (_) {
      resolve(null);
    }
  });
}

// onState(state) runs for the first state and every newer one. While the music plays the engine
// reports at least every 5 s; if it goes quiet for longer, the hidden player may have been closed by
// Chrome, so we ask the service worker, which checks and corrects the state.
export function connectMusic(onState, { staleMs = 12000, now = Date.now } = {}) {
  let current = null;
  let lastHeard = now();
  let closed = false;

  const accept = (raw) => {
    if (closed || !raw || typeof raw !== "object") return;
    const state = makeState(raw);
    if (!isNewer(current, state)) return;
    current = state;
    lastHeard = now();
    onState(state);
  };

  const listener = (msg) => {
    if (msg?.type === MSG.changed && msg.state) accept(msg.state);
    return false; // never answers: the service worker does
  };
  chrome.runtime.onMessage.addListener(listener);

  const refresh = async () => accept(await sendMessage({ type: MSG.state }));
  const watch = setInterval(() => {
    if (current?.playing && now() - lastHeard > staleMs) {
      lastHeard = now();
      refresh();
    }
  }, 2000);
  refresh();

  return {
    get state() { return current; },
    refresh,
    async control(cmd, extra = {}) {
      const reply = await sendMessage({ type: MSG.control, cmd, ...extra });
      if (reply?.state) accept(reply.state);
      return reply;
    },
    close() {
      closed = true;
      clearInterval(watch);
      chrome.runtime.onMessage.removeListener(listener);
    }
  };
}
