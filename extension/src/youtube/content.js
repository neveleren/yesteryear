// YouTube content script (document_start). Needs common.js (YY) and youtube_core.js (YYT).
// Searches get YouTube's own server-side cap "before:<Y+1>-01-01"; cards whose relative date says they are
// newer are hidden everywhere (home, sidebar, end screens); Shorts and comments go away; before 2005 there
// was no YouTube at all.
(function () {
  "use strict";
  const YY = window.YY, T = window.YYT;
  if (!YY || !T) return;
  const html = document.documentElement;
  const MAP_PREFIX = "yy:ytq:";   // sessionStorage: a query this tab built -> the user's own words ("" = the year search of the home page)
  let state = null;

  YY.getState().then(start);
  YY.onSettledStateChange(applyState);

  function mapped(q) {
    try { return sessionStorage.getItem(MAP_PREFIX + q); } catch (_) { return null; }
  }
  function remember(built, words) {
    try { sessionStorage.setItem(MAP_PREFIX + built, words); } catch (_) { /* private mode */ }
  }

  // A settings change, once settled and only while this tab is in view: a results page we built goes straight to the
  // user's own words for the new year (or without before: when the time machine is off for YouTube); other pages
  // reload. Never leaves an old year's cap behind.
  function applyState(st) {
    if (!state || !["enabled", "year", "youtube", "eraLook"].some((k) => st[k] !== state[k])) return;
    const active = (s) => s.enabled && s.youtube;
    if (!active(state) && !active(st)) return;
    const url = new URL(location.href);
    const q = url.pathname === "/results" ? url.searchParams.get("search_query") || "" : "";
    const words = q ? mapped(q) : null;
    if (words !== null && !(active(st) && st.year < 2005)) {
      if (active(st)) {
        const built = T.queryFor(words, st.year, YY.rewriteQuery);
        remember(built, words);
        url.searchParams.set("search_query", built);
      } else if (words === "") {
        location.replace(`${location.origin}/`);
        return;
      } else {
        url.searchParams.set("search_query", words);
      }
      if (url.toString() !== location.href) { location.replace(url.toString()); return; }
    }
    location.reload();
  }

  function start(st) {
    state = st;
    if (!st.enabled || !st.youtube) return;
    if (st.year < 2005) {
      // the real address goes along (u last: it is the rest of the fragment), so the page comes back afterwards
      location.replace(chrome.runtime.getURL(`src/wayback/notfound.html#y=${st.year}&why=none&from=youtube&u=${location.href}`));
      return;
    }
    html.classList.add("yy-youtube");
    if (st.eraLook && st.year <= 2012) html.classList.add("yy-yt-classic");
    if (route()) return;
    interceptSearch();
    document.addEventListener("yt-navigate-finish", route, true);
    window.addEventListener("popstate", route, true);
    startFilter();
  }

  // returns true if a full navigation was started
  function route() {
    const url = new URL(location.href);
    if (url.pathname === "/results") {
      const q = url.searchParams.get("search_query") || url.searchParams.get("q") || "";
      // the user's words: remembered for a query we built (so an old year's before: is replaced), else q itself
      // unless the user typed a before:/after: of their own
      const words = q ? T.userQuery(q, mapped(q)) : null;
      if (words !== null) {
        const built = T.queryFor(words, state.year, YY.rewriteQuery);
        if (built !== q || url.searchParams.has("q")) {
          remember(built, words);
          url.searchParams.set("search_query", built);
          url.searchParams.delete("q");
          location.replace(url.toString());
          return true;
        }
      }
      showCleanQuery();
    } else if (url.pathname === "/" || url.pathname === "/feed/trending" || url.pathname.startsWith("/shorts")) {
      const built = T.homeQuery(state.year);
      remember(built, "");
      const u = new URL("/results", location.origin);
      u.searchParams.set("search_query", built);
      location.replace(u.toString());
      return true;
    }
    return false;
  }

  // In-page searches go through POST /youtubei/v1/search: edit the box before YouTube reads it.
  function interceptSearch() {
    const fix = (input) => {
      if (!input || T.hasDateOperator(input.value) || !input.value.trim()) return;
      const words = input.value;
      const built = T.buildQuery(words, state.year, YY.rewriteQuery);
      remember(built, words);
      input.value = built;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const findBox = (from) => (from && from.matches && from.matches('input[name="search_query"], input.ytSearchboxComponentInput, #search input') ? from :
      document.querySelector('input[name="search_query"], input.ytSearchboxComponentInput, ytd-searchbox input, #search input'));
    window.addEventListener("keydown", (e) => { if (e.key === "Enter") fix(findBox(e.target)); }, true);
    window.addEventListener("submit", (e) => fix(findBox(e.target && e.target.querySelector ? e.target.querySelector("input") : null)), true);
    window.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button[aria-label*="Search" i], #search-icon-legacy, .ytSearchboxComponentSearchButton');
      if (btn) fix(findBox(null));
    }, true);
  }

  // Show the user's own words (or at least the query without the operator) once the results page is up (purely
  // cosmetic; YouTube keeps the full query).
  function showCleanQuery() {
    const t = setInterval(() => {
      const input = document.querySelector('input[name="search_query"], input.ytSearchboxComponentInput, ytd-searchbox input');
      if (!input) return;
      clearInterval(t);
      const words = mapped(input.value);
      const clean = words ? words.trim() : T.stripOperator(input.value);
      if (clean && clean !== input.value && document.activeElement !== input) input.value = clean;
    }, 400);
    setTimeout(() => clearInterval(t), 8000);
  }

  // ---- leak filter
  const CARD = "ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, " +
    "ytd-playlist-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytd-end-screen-video-renderer";
  const SHORTS = "ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], grid-shelf-view-model, ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model)";

  function scan() {
    for (const s of document.querySelectorAll(SHORTS)) s.style.setProperty("display", "none", "important");
    for (const a of document.querySelectorAll('a[href^="/shorts/"]')) {
      const card = a.closest(CARD);
      if (card) card.style.setProperty("display", "none", "important");
    }
    for (const card of document.querySelectorAll(CARD)) {
      if (card.dataset.yyChecked === String(state.year)) continue;
      const text = card.textContent || "";
      if (!/ago|назад|vor\s|streamed|premiere|live/i.test(text)) continue;   // metadata not loaded yet
      card.dataset.yyChecked = String(state.year);
      const meta = [...card.querySelectorAll("#metadata-line span, .inline-metadata-item, .yt-content-metadata-view-model__metadata-text, span")]
        .map((s) => s.textContent).filter((t) => /ago|назад|vor\s|streamed|premiere/i.test(t)).join(" ");
      if (T.isFuture(meta || text, state.year)) {
        card.style.setProperty("display", "none", "important");
        card.dataset.yyHidden = "future";
      }
    }
  }

  function startFilter() {
    let queued = false;
    const run = () => { queued = false; try { scan(); } catch (_) { /* layout changed */ } };
    const obs = new MutationObserver(() => { if (!queued) { queued = true; setTimeout(run, 250); } });
    const go = () => { obs.observe(document.documentElement, { childList: true, subtree: true }); run(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true });
    else go();
  }
})();
