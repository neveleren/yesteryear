// YouTube search helpers for the music module: build the query for a chart song and pick playable
// video ids out of the results page's ytInitialData. Pure functions (no chrome.*), unit-tested in node.

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const isVideoId = (s) => typeof s === "string" && VIDEO_ID_RE.test(s);

// A song's video: skip teasers and hour-long mixes / "10 hours" loops. Long official videos exist
// (Thriller runs 13:42), so the upper bound is generous.
export const MIN_SECONDS = 45;
export const MAX_SECONDS = 20 * 60;

const FEATURING_RE = /\s+(?:featuring|feat\.|ft\.)\s.*$/i;
const QUOTES_RE = /["“”]/g;

// No before: operator on purpose: official uploads of old songs are often much newer than the song.
export function searchQuery(artist, title) {
  // "A / B" is a double A-side (title) or alternate credits (artist): search for the first one.
  const a = String(artist || "").split(" / ")[0].replace(FEATURING_RE, "");
  const t = String(title || "").split(" / ")[0];
  const words = `${a} ${t}`.replace(QUOTES_RE, "").replace(/\s+/g, " ").trim();
  return `${words} official audio OR video`;
}

export function searchUrl(artist, title) {
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(searchQuery(artist, title));
}

// ---- ytInitialData extraction ----------------------------------------------------------------

// Desktop pages write `var ytInitialData = {...};`; some variants use window["ytInitialData"] or a
// hex-escaped string literal. Scan with a string-aware brace matcher instead of a regex up to
// "};</script>", so a layout change in what follows the object does not break us.
export function extractInitialData(html) {
  const s = String(html || "");
  const assign = /(?:var\s+ytInitialData|window\[\s*["']ytInitialData["']\s*\])\s*=\s*/g;
  for (let m; (m = assign.exec(s)); ) {
    const at = m.index + m[0].length;
    let text = null;
    if (s[at] === "{") text = sliceJsonObject(s, at);
    else if (s[at] === "'" || s[at] === '"') text = readJsString(s, at);
    if (text == null) continue;
    try {
      const data = JSON.parse(text);
      if (data && typeof data === "object") return data;
    } catch (_) { /* try the next assignment */ }
  }
  return null;
}

function sliceJsonObject(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      // JSON strings only use double quotes; skip to the closing one, honouring escapes.
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const SIMPLE_ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };

function readJsString(s, start) {
  const quote = s[start];
  let out = "";
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (c === quote) return out;
    if (c !== "\\") { out += c; continue; }
    const e = s[++i];
    if (e === "x") { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else if (e === "u" && s[i + 1] === "{") { const end = s.indexOf("}", i); out += String.fromCodePoint(parseInt(s.slice(i + 2, end), 16)); i = end; }
    else if (e === "u") { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; }
    else if (e === "\n") { /* line continuation */ }
    else out += SIMPLE_ESCAPES[e] ?? e;
  }
  return null;
}

// ---- picking videos --------------------------------------------------------------------------

export function textOf(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r?.text || "").join("");
  if (typeof node.content === "string") return node.content;
  return "";
}

// "3:36" -> 216, "1:02:03" -> 3723; anything else -> null.
export function parseDuration(text) {
  const m = String(text || "").trim().match(/^(\d{1,3})(?::(\d{2}))(?::(\d{2}))?$/);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((p) => p !== undefined).map(Number);
  return parts.reduce((total, p) => total * 60 + p, 0);
}

// Subtrees that never hold a normal search hit: Shorts shelves, ads, playlists and mixes, channels,
// "people also watched" style shelves. Used only by the fallback walk.
const SKIP_KEYS = new Set([
  "reelShelfRenderer", "gridShelfViewModel", "shortsLockupViewModel", "reelItemRenderer",
  "playlistRenderer", "radioRenderer", "channelRenderer", "shelfRenderer", "horizontalCardListRenderer",
  "adSlotRenderer", "promotedVideoRenderer", "searchPyvRenderer", "promotedSparklesWebRenderer",
  "movieRenderer", "secondaryContents", "header", "topbar", "responseContext", "refinementCardRenderer"
]);

function fromVideoRenderer(v) {
  if (!isVideoId(v?.videoId)) return null;
  const endpoint = v.navigationEndpoint || {};
  const url = endpoint.commandMetadata?.webCommandMetadata?.url || "";
  const overlayStyles = (v.thumbnailOverlays || [])
    .map((o) => o?.thumbnailOverlayTimeStatusRenderer?.style).filter(Boolean);
  const badgeStyles = (v.badges || []).map((b) => b?.metadataBadgeRenderer?.style).filter(Boolean);
  return {
    videoId: v.videoId,
    title: textOf(v.title),
    channel: textOf(v.ownerText),
    // Live streams have no length at all (live test 2026-11-10: "LIVE_NOW" badge, "N watching").
    seconds: parseDuration(textOf(v.lengthText)),
    short: url.startsWith("/shorts/") || !!endpoint.reelWatchEndpoint || overlayStyles.includes("SHORTS"),
    live: badgeStyles.some((s) => s.includes("LIVE_NOW")) || overlayStyles.includes("LIVE"),
    upcoming: !!v.upcomingEventData || overlayStyles.includes("UPCOMING"),
    membersOnly: badgeStyles.includes("BADGE_STYLE_TYPE_MEMBERS_ONLY")
  };
}

// Newer layout (already used in YouTube's sidebar): {contentType, contentId, contentImage...}.
function fromLockup(l) {
  if (l?.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO" || !isVideoId(l.contentId)) return null;
  const badges = [];
  let short = false;
  (function scan(node) {
    if (Array.isArray(node)) return node.forEach(scan);
    if (!node || typeof node !== "object") return;
    if (node.thumbnailBadgeViewModel) badges.push(node.thumbnailBadgeViewModel);
    if (node.reelWatchEndpoint || String(node.url || "").startsWith("/shorts/")) short = true;
    for (const v of Object.values(node)) scan(v);
  })(l);
  const texts = badges.map((b) => String(b.text || "").toUpperCase());
  const styles = badges.map((b) => String(b.badgeStyle || ""));
  const length = badges.map((b) => parseDuration(b.text)).find((n) => n != null);
  return {
    videoId: l.contentId,
    title: textOf(l.metadata?.lockupMetadataViewModel?.title),
    channel: "",
    seconds: length ?? null,
    short,
    live: texts.includes("LIVE") || styles.some((s) => s.includes("LIVE")),
    upcoming: texts.includes("UPCOMING") || styles.some((s) => s.includes("UPCOMING")),
    membersOnly: texts.some((t) => t.includes("MEMBERS"))
  };
}

function readItem(item) {
  if (item?.videoRenderer) return fromVideoRenderer(item.videoRenderer);
  if (item?.lockupViewModel) return fromLockup(item.lockupViewModel);
  return null; // Shorts grids, mixes, playlists, channels, ads, shelves
}

function primaryItems(data) {
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
  if (!Array.isArray(sections)) return null;
  const items = [];
  for (const section of sections) {
    const contents = section?.itemSectionRenderer?.contents;
    if (Array.isArray(contents)) items.push(...contents);
  }
  return items;
}

// Document-order walk for an unknown layout: visits videoRenderer / lockupViewModel wrappers and
// never descends into SKIP_KEYS subtrees.
function walkItems(node, visit) {
  if (Array.isArray(node)) { for (const x of node) walkItems(x, visit); return; }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (key === "videoRenderer" || key === "lockupViewModel") visit({ [key]: value });
    else walkItems(value, visit);
  }
}

// Search hits in YouTube's order that can stand in for the song: real videos only (no Shorts, live,
// premieres, members-only, playlists, channels, ads), with a song-like length.
export function findVideos(data, { max = 8, minSeconds = MIN_SECONDS, maxSeconds = MAX_SECONDS } = {}) {
  const out = [];
  const seen = new Set();
  const take = (item) => {
    const v = readItem(item);
    if (!v || seen.has(v.videoId) || out.length >= max) return;
    seen.add(v.videoId);
    if (v.short || v.live || v.upcoming || v.membersOnly) return;
    if (v.seconds == null || v.seconds < minSeconds || v.seconds > maxSeconds) return;
    out.push(v);
  };
  const items = primaryItems(data);
  if (items) items.forEach(take);
  else walkItems(data, take);
  return out;
}

export function pickVideoIds(html, options) {
  const data = extractInitialData(html);
  return data ? findVideos(data, options).map((v) => v.videoId) : [];
}
