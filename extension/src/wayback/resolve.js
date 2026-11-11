// "Opening page..." screen: finds the capture of the clicked page from the chosen year (or earlier).
import { parseFragment, tsToMs } from "./wayback_core.js";
import { browserEra, hostOf, h } from "./era_chrome.js";

const f = parseFragment(location.hash);
// The guard may send this very tab to another year or page by changing only the fragment: start over.
addEventListener("hashchange", () => location.reload());
const year = Number.isFinite(f.y) ? f.y : 2010;
const target = f.u;
const era = browserEra(year);
document.body.className = `era-${era}`;
document.title = era.startsWith("ie") ? `Opening page ${target}...` : hostOf(target);

const bar = h("div", { class: "progress" }, h("div", { class: "progress-fill" }));
const status = h("div", { class: "status-text", text: `Opening page ${target}...` });
document.body.append(
  h("div", { class: "frame" },
    h("div", { class: "toolbar" }, h("span", { class: "addr-label", text: "Address" }), h("div", { class: "addr", text: target })),
    h("div", { class: "page blank" }),
    h("div", { class: "statusbar" }, status, bar)
  )
);

let pct = 5;
const tick = setInterval(() => { pct = Math.min(92, pct + Math.max(1, (92 - pct) / 12)); bar.firstChild.style.width = `${pct}%`; }, 250);

function go(why) {
  clearInterval(tick);
  location.replace(chrome.runtime.getURL(`src/wayback/notfound.html#y=${year}&why=${why}${f.d ? `&d=${f.d}` : ""}&u=${target}`));
}

// Say what is about to open in the period's own info-bar style, then open it.
function note(text) {
  document.querySelector(".page").replaceChildren(h("div", { class: `infobar era-${era}` },
    h("span", { class: "infobar-icon", text: era.startsWith("ie") ? "ℹ" : "ⓘ" }), h("span", { text })));
}

// Google services that open on a sign-in form: the archived form would send what is typed to the archive.
function isSignInService(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return /^(mail|gmail|docs|drive|plus|accounts)\.google\.com$/.test(host) ||
      (/^(www\.)?google\.com$/.test(host) && /^\/(calendar|accounts)(\/|$)/.test(u.pathname));
  } catch (_) { return false; }
}

function dayText(ts) {
  const ms = tsToMs(ts);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

// The info bar for a reply, or "" when the page opens as it is.
function noteFor(r) {
  const host = hostOf(target);
  const parts = [];
  if (r.approx === "stale") {
    parts.push(`The newest copy in the archive is from ${dayText(r.ts)}. Opening it...`);
  } else if (r.approx === "site" || r.approx === "noquery") {
    const what = r.approx === "site" ? `${host} as it looked in ${year}` : `a related page from ${year}`;
    parts.push(r.degraded ? `The archive did not answer for this page. Opening ${what}...` :
      r.approx === "site" ? `This page was not saved in ${year}. Opening ${what}...` :
        `This exact page was not saved in ${year}. Opening ${what}...`);
  }
  if (isSignInService(target)) parts.push("This is an archived copy. Do not sign in here.");
  return parts.join(" ");
}

// The archive's lookup service has short hiccups (timeouts, 5xx): one quiet second try before the error page,
// and also before settling for a fallback that was only found because a better lookup failed (degraded).
let attempt = 0;
function lookup() {
  attempt++;
  const ask = { type: "wayback:resolve", url: target, year, day: f.d || undefined, force200: f.why === "future" };
  chrome.runtime.sendMessage(ask, (r) => {
    if (chrome.runtime.lastError || !r) return go("error");
    const failed = !r.ok && !["none", "busy", "bad-request"].includes(r.reason);
    if (attempt < 2 && (failed || (r.ok && r.degraded))) {
      status.textContent = `Opening page ${target}... (trying again)`;
      setTimeout(lookup, 1500);
      return;
    }
    if (r.ok && r.waybackUrl) {
      clearInterval(tick);
      bar.firstChild.style.width = "100%";
      const text = noteFor(r);
      if (text) {
        note(text);
        status.textContent = `Opening ${r.approx === "site" ? hostOf(target) : target}...`;
        setTimeout(() => location.replace(r.waybackUrl), text.length > 90 ? 2600 : 1800);
        return;
      }
      status.textContent = `Website found. Waiting for reply...`;
      location.replace(r.waybackUrl);
      return;
    }
    go(r.reason === "busy" ? "busy" : r.reason === "none" ? "none" : "error");
  });
}

if (!target) go("none");
else lookup();
