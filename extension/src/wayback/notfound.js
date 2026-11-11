// Period-correct "page cannot be displayed": the site did not exist yet in that year (why=none), the archive is
// busy (why=busy) or unreachable (why=error), or the archive kept redirecting into the future (why=loop).
// from=youtube: this page stands in for a YouTube page before 2005 and goes back to it once the time machine is off
// for YouTube or the year is 2005 or later.
import { parseFragment } from "./wayback_core.js";
import { browserEra, hostOf, h } from "./era_chrome.js";
import { getState } from "../shared/state_sw.js";

const f = parseFragment(location.hash);
// A new fragment (another year or page) means a new lookup: start over.
addEventListener("hashchange", () => location.reload());
const year = Number.isFinite(f.y) ? f.y : 2010;
const target = f.u || "";
const why = f.why || "none";
const host = hostOf(target);
const era = browserEra(year);
document.body.className = `era-${era}`;

const retry = h("button", { type: "button", class: "btn", text: "Try again", onclick: () => {
  location.replace(chrome.runtime.getURL(`src/wayback/resolve.html#y=${year}${f.d ? `&d=${f.d}` : ""}&u=${target}`));
} });

function ieBody() {
  const reasons = {
    none: "The page you are looking for is currently unavailable. The Web site might be experiencing technical difficulties, or you may need to adjust your browser settings.",
    busy: "The server is too busy to answer right now. Please try again in a minute.",
    error: "The connection to the server could not be established.",
    loop: "The page you are looking for keeps moving to a newer address."
  };
  return h("div", { class: "ie-error" },
    h("table", { class: "ie-head" }, h("tbody", {}, h("tr", {},
      h("td", { class: "ie-icon", text: "ⓘ" }),
      h("td", {}, h("h1", { text: "The page cannot be displayed" }))))),
    h("p", { text: reasons[why] || reasons.none }),
    h("hr"),
    h("p", { text: "Please try the following:" }),
    h("ul", {},
      h("li", { text: "Click the Refresh button, or try again later." }),
      h("li", { text: `If you typed the page address in the Address bar, make sure that it is spelled correctly.` }),
      h("li", { text: "To check your connection settings, click the Tools menu, and then click Internet Options." })),
    h("p", { class: "ie-dns", text: why === "none" ? `Cannot find server or DNS Error` : why === "busy" ? "HTTP 503 - Service unavailable" : "Cannot find server" }),
    h("p", { class: "ie-dns", text: "Internet Explorer" }),
    why === "none" ? h("p", { class: "note", text: `In ${year}, ${host || "this site"} did not exist yet (or nobody had saved it).` }) : retry
  );
}

function chromeBody() {
  const old = era === "chrome1";
  const title = why === "loop" && old ? "This webpage has a redirect loop" : old ? "This webpage is not available" : why === "loop" ? "This page isn’t working" : "This site can’t be reached";
  const detail = why === "none" ? `${host || "This server"}’s server IP address could not be found.` :
    why === "busy" ? "The server is busy right now." : why === "loop" ? `${host || "This site"} redirected you too many times.` : "The connection was reset.";
  const code = why === "none" ? "DNS_PROBE_FINISHED_NXDOMAIN" : why === "busy" ? "ERR_TOO_MANY_REQUESTS" : why === "loop" ? "ERR_TOO_MANY_REDIRECTS" : "ERR_CONNECTION_RESET";
  return h("div", { class: old ? "chrome-error old" : "chrome-error" },
    h("div", { class: "sad", text: old ? "☹" : "" }),
    h("h1", { text: title }),
    h("p", { text: detail }),
    h("p", { class: "code", text: code }),
    why === "none" ? h("p", { class: "note", text: `In ${year}, ${host || "this site"} did not exist yet (or nobody had saved it).` }) : retry
  );
}

document.title = era.startsWith("ie") ? "The page cannot be displayed" : host || "Not available";
document.body.append(era.startsWith("ie") ? ieBody() : chromeBody());

// Stand-in for YouTube: back to the real page once YouTube is allowed again (only while this tab is in view, so a
// background tab does not load YouTube by itself).
if (f.from === "youtube" && /^https:\/\/(www\.|m\.)?youtube\.com\//.test(target)) {
  let leaving = false;
  const check = () => getState().then((st) => {
    if (leaving || (st.enabled && st.youtube && st.year < 2005)) return;
    if (document.visibilityState !== "visible") return;   // visibilitychange checks again
    leaving = true;
    location.replace(target);
  }, () => {});
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ("enabled" in changes || "youtube" in changes || "year" in changes)) check();
  });
  check();
}
