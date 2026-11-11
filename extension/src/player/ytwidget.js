// Drives a YouTube embed through postMessage, the protocol the official iframe_api script speaks.
// That script cannot load in an extension page (CSP script-src 'self'); talking to the iframe
// directly was proven in research/exttest/extD: send "listening", then {event:"command", func, args}.
export const YT_ORIGIN = "https://www.youtube.com";
export const STATE = Object.freeze({ UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 });

// The yy_player marker lets the static DNR rule in rules.json add the Referer header to our embeds
// only, instead of rewriting every YouTube embed on every site.
export const EMBED_MARKER = "yy_player";

export function embedUrl(videoId, start = 0) {
  const params = new URLSearchParams({ enablejsapi: "1", autoplay: "1", playsinline: "1" });
  const s = Math.floor(Number(start) || 0);
  if (s > 0) params.set("start", String(s));
  params.set(EMBED_MARKER, "1");
  return `${YT_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params}`;
}

export function commandMessage(func, args = []) {
  return JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" });
}

export function parseWidgetMessage(data) {
  let msg = data;
  if (typeof data === "string") {
    try { msg = JSON.parse(data); } catch (_) { return null; }
  }
  return msg && typeof msg === "object" && typeof msg.event === "string" ? msg : null;
}

// handlers: onState(state), onError(code), onTime(currentTime, duration), onReady(),
//           onVolume(volume, muted), onVideoError(errorCode)
// onVideoError reports videoData.errorCode (e.g. "auth"): YouTube shows an error screen but sends no
// onError for it, so a hidden player would otherwise wait forever.
export class YouTubeFrame {
  constructor(host, handlers = {}, { doc = globalThis.document, win = globalThis.window } = {}) {
    this.host = host;
    this.handlers = handlers;
    this.doc = doc;
    this.win = win;
    this.iframe = null;
    this.ready = false;
    this.queue = [];
    this.state = null;
    this.videoId = null; // what we last asked the iframe to show
    this.time = 0;
    this.duration = 0;
    this.volume = null;  // as YouTube reports it
    this.muted = false;
    this.videoError = null;
    this.handshake = 0;
    this.onMessage = this.onMessage.bind(this);
    win.addEventListener("message", this.onMessage);
  }

  get hasPlayer() { return !!this.iframe; }

  // Show this video and play it.
  load(videoId, start = 0) {
    this.videoId = videoId;
    this.state = null;
    this.time = 0;
    this.duration = 0;
    this.videoError = null;
    if (this.iframe) this.command("loadVideoById", [videoId, Math.floor(Number(start) || 0)]);
    else this.create(videoId, start);
  }

  // Show this video without playing. Never creates the iframe: until the user wants music the
  // visualization area shows the idle screen instead of loading YouTube.
  cue(videoId, start = 0) {
    if (!this.iframe) return false;
    this.videoId = videoId;
    this.state = null;
    this.command("cueVideoById", [videoId, Math.floor(Number(start) || 0)]);
    return true;
  }

  play() { this.command("playVideo"); }
  pause() { this.command("pauseVideo"); }
  seek(seconds) { this.command("seekTo", [Math.max(0, Number(seconds) || 0), true]); }
  setVolume(volume) { this.command("setVolume", [Math.min(100, Math.max(0, Math.round(Number(volume) || 0)))]); }
  mute() { this.command("mute"); }
  unMute() { this.command("unMute"); }

  destroy() {
    clearInterval(this.handshake);
    this.win.removeEventListener("message", this.onMessage);
    this.iframe?.remove?.();
    this.iframe = null;
    this.ready = false;
  }

  create(videoId, start) {
    const f = this.doc.createElement("iframe");
    f.src = embedUrl(videoId, start);
    f.title = "YouTube video player";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.setAttribute("allowfullscreen", "");
    f.addEventListener("load", () => this.startHandshake());
    this.ready = false;
    this.queue = [];
    this.iframe = f;
    this.host.append(f);
  }

  startHandshake() {
    clearInterval(this.handshake);
    this.ready = false;
    let tries = 0;
    const ping = () => {
      if (this.ready || ++tries > 40) { clearInterval(this.handshake); return; }
      this.post({ event: "listening", id: 1, channel: "widget" });
    };
    ping();
    this.handshake = setInterval(ping, 250);
  }

  onMessage(e) {
    if (!this.iframe || e.origin !== YT_ORIGIN || e.source !== this.iframe.contentWindow) return;
    const msg = parseWidgetMessage(e.data);
    if (!msg) return;
    if (!this.ready && (msg.event === "onReady" || msg.event === "initialDelivery")) this.becomeReady();
    if (msg.event === "onStateChange") this.setState(Number(msg.info));
    else if (msg.event === "onError") this.handlers.onError?.(Number(msg.info));
    else if (msg.event === "infoDelivery" || msg.event === "initialDelivery") this.readInfo(msg.info);
  }

  becomeReady() {
    this.ready = true;
    clearInterval(this.handshake);
    // The official API subscribes like this; onError in particular is only sent to subscribers.
    this.post({ event: "command", func: "addEventListener", args: ["onStateChange"], id: 1, channel: "widget" });
    this.post({ event: "command", func: "addEventListener", args: ["onError"], id: 1, channel: "widget" });
    const queued = this.queue;
    this.queue = [];
    for (const [func, args] of queued) this.command(func, args);
    this.handlers.onReady?.();
  }

  readInfo(info) {
    if (!info || typeof info !== "object") return;
    if (typeof info.playerState === "number") this.setState(info.playerState);
    let timeChanged = false;
    if (typeof info.currentTime === "number") { this.time = info.currentTime; timeChanged = true; }
    if (typeof info.duration === "number" && info.duration > 0) { this.duration = info.duration; timeChanged = true; }
    if (timeChanged) this.handlers.onTime?.(this.time, this.duration);
    if (typeof info.volume === "number" || typeof info.muted === "boolean") {
      if (typeof info.volume === "number") this.volume = info.volume;
      if (typeof info.muted === "boolean") this.muted = info.muted;
      this.handlers.onVolume?.(this.volume, this.muted);
    }
    const data = info.videoData;
    // Only for the video we asked for: a late message about the previous one must not count.
    if (data && typeof data.errorCode === "string" && data.errorCode && data.video_id === this.videoId
        && data.errorCode !== this.videoError) {
      this.videoError = data.errorCode;
      this.handlers.onVideoError?.(data.errorCode);
    }
  }

  setState(state) {
    // infoDelivery and onStateChange both report states: pass each change on once.
    if (!Number.isFinite(state) || state === this.state) return;
    this.state = state;
    this.handlers.onState?.(state);
  }

  command(func, args = []) {
    if (!this.ready) { this.queue.push([func, args]); return; }
    this.post({ event: "command", func, args, id: 1, channel: "widget" });
  }

  post(obj) {
    try { this.iframe?.contentWindow?.postMessage(JSON.stringify(obj), YT_ORIGIN); } catch (_) { /* frame gone */ }
  }
}
