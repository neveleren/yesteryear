// Google content script (document_start). Needs src/shared/common.js (window.YY) and google_core.js (YYG).
// 1. /search: rewrite the query for the chosen year and add Google's own date cap, then
// 2. read Google's organic results, drop anything that leaks a later year, and
// 3. (period look on) hide Google's page and draw the results the way Google looked that year.
// No innerHTML anywhere: google.com enforces Trusted Types.
(function () {
  "use strict";
  const YY = window.YY, G = window.YYG;
  if (!YY || !G) return;

  const SS_PREFIX = "yy:orig:";      // sessionStorage: our rewritten query -> the user's own words
  const FIRST_PREFIX = "wbfirst:";   // chrome.storage.local, wayback module: each site's earliest capture
  const RELEVANT = ["enabled", "year", "google", "strict", "eraLook"];
  const FIRST_WAIT_MS = 1500;        // the period look waits this long for the site check before drawing
  const RETRY_MS = 2500;             // "unknown" sites are asked once more after this
  const ANSWER_CAP_MS = 12000;       // a site check that never answers counts as "no answer"
  const HOLD_MAX_MS = 4000;          // results whose site check has not answered by then are shown anyway
  const html = document.documentElement;
  let state = null;

  YY.getState().then(start);
  YY.onSettledStateChange(applyState);

  function start(st) {
    state = st;
    if (!st.enabled || !st.google) return;
    const url = new URL(location.href);
    if (url.pathname.startsWith("/sorry")) return onReady(() => banner("The time machine is paused on this page (Google asks you to prove you are human)."));
    if (url.pathname === "/search") return onSearch(url, st);
    if ((url.pathname === "/" || url.pathname === "/webhp") && st.eraLook) return onHome(st);
    if (url.pathname === "/imghp" && st.eraLook) return onHome(st, { images: true });
  }

  // A settings change, once settled and only while this tab is in view (YY.onSettledStateChange): an open results
  // page goes straight to the user's own words searched for the new year, or without the time machine (one request,
  // never the old year's rewritten query); a period homepage reloads. Never touches /sorry.
  function applyState(st) {
    if (!state || !RELEVANT.some((k) => st[k] !== state[k])) return;
    const active = (s) => s.enabled && s.google;
    if (!active(state) && !active(st)) return;
    const url = new URL(location.href);
    if (url.pathname === "/search") {
      const words = userWords(url);
      const t = G.retarget(location.href, words, st, YY.rewriteQuery);
      if (t) {
        if (t.rewritten) remember(t.rewritten, words);
        if (!G.sameSearch(url, new URL(t.target))) { location.replace(t.target); return; }
      }
      location.reload();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/webhp" || url.pathname === "/imghp") location.reload();
  }

  function remember(rewritten, words) {
    try { sessionStorage.setItem(SS_PREFIX + rewritten, words); } catch (_) { /* private mode */ }
  }

  // The user's own words behind this URL's q (our rewritten query is looked up, never taken as the user's words).
  function userWords(url) {
    return G.userWords(url.toString(), (q) => sessionStorage.getItem(SS_PREFIX + q));
  }

  // ---------------------------------------------------------------- search
  function onSearch(url, st) {
    const q = url.searchParams.get("q") || "";
    if (!q.trim()) return;
    const words = userWords(url);
    const plan = G.buildSearchUrl(G.withQuery(url.toString(), words), st.year, YY.rewriteQuery);
    if (!G.sameSearch(url, new URL(plan.target)) && loopOk(plan.target)) {
      remember(plan.rewritten, words);
      location.replace(plan.target);
      return;
    }
    // Image search: Google's own picture grid, already limited to the year by the date filter.
    if (url.searchParams.get("tbm") === "isch" || url.searchParams.get("udm") === "2") return;
    const era = YY.googleEra(st.year);
    if (st.eraLook) {
      html.classList.add("yy-google", "yy-era");
      html.dataset.yyEra = era;
    }
    const lucky = url.searchParams.get(G.LUCKY_PARAM) === "1";
    onReady(() => showResults({ st, era, original: words, q, lucky }));
  }

  // ---------------------------------------------------------------- which results to show
  // Sites whose first archive capture is after the chosen year did not exist yet (or nobody saw them): clicking
  // would only end on "page cannot be displayed", so they are dropped. Known sites answer at once from the wayback
  // module's cache; the others are asked in one request (the period look waits up to FIRST_WAIT_MS before it
  // draws). A result the reader already sees is never pulled out: results still being checked are held back and
  // join at the end when their site checks out. Answers are kept per host for the life of the page.
  const siteAnswers = new Map();   // host -> "yes" | "no" | "unknown" | "busy" (final)
  const sitePending = new Set();   // hosts asked (or waiting for their second try) without a final answer yet
  const hostKey = (r) => (r.host || "").toLowerCase().replace(/^www\./, "");

  // page = {st, era, original, q, data, ready, drawn: Map(href -> result) in display order, drawnKey, main}
  function showResults(page) {
    const st = page.st;
    page.data = readResults(st);
    // the period page at once (logo, search box, "Loading results..."): the results join as soon as they are ready
    if (st.eraLook) renderResults(page, null);
    const drawFirst = () => { page.ready = true; draw(page); };
    if (!st.strict) drawFirst();
    else {
      // The archive can be slow or down: a result still being checked after HOLD_MAX_MS is shown anyway (its answer
      // still fills the cache for the next pages, and a result on screen is never pulled out).
      setTimeout(() => { page.released = true; page.ready = true; draw(page); }, HOLD_MAX_MS);
      preloadSites(page).then(() => {
        const asked = askSites(page);
        if (!st.eraLook) return drawFirst();   // Google's own page: hide what is still being checked right away
        Promise.race([asked, new Promise((r) => setTimeout(r, FIRST_WAIT_MS))]).then(drawFirst);
      });
    }
    // late cards (Google streams parts of the page): read once more after load, keeping what is already shown
    window.addEventListener("load", () => {
      const again = readResults(st);
      if (again.results.length === page.data.results.length) return;
      page.data = again;
      if (st.strict) preloadSites(page).then(() => { askSites(page); draw(page); });
      else draw(page);
    }, { once: true });
  }

  function needsSite(r, st) {
    return st.strict && !!r.host && !r.baseLeak;
  }

  function preloadSites(page) {
    const hosts = [...new Set(page.data.results.filter((r) => needsSite(r, page.st)).map(hostKey))].filter((h) => !siteAnswers.has(h));
    if (!hosts.length) return Promise.resolve();
    try {
      return chrome.storage.local.get(hosts.map((h) => FIRST_PREFIX + h)).then((got) => {
        for (const h of hosts) {
          const a = G.firstCaptureAnswer(got[FIRST_PREFIX + h], page.st.year);
          if (a) siteAnswers.set(h, a);
        }
      }, () => {});
    } catch (_) { return Promise.resolve(); }   // extension reloaded under the page
  }

  // Ask the wayback module about the hosts nobody asked yet. Resolves once this request has answered.
  function askSites(page, only = null, retry = true) {
    const hosts = only || [...new Set(page.data.results.filter((r) => needsSite(r, page.st)).map(hostKey))]
      .filter((h) => !siteAnswers.has(h) && !sitePending.has(h));
    if (!hosts.length) return Promise.resolve();
    hosts.forEach((h) => sitePending.add(h));
    return new Promise((done) => {
      let finished = false;
      const finish = (answer) => {
        if (finished) return;
        finished = true;
        const again = [];
        for (const h of hosts) {
          const a = answer ? answer[h] : undefined;
          if (a === "yes" || a === "no" || a === "busy") { siteAnswers.set(h, a); sitePending.delete(h); }
          else if (retry) again.push(h);   // "unknown" or no reply: the archive is sometimes empty on a cold first call
          else { siteAnswers.set(h, "unknown"); sitePending.delete(h); }
        }
        draw(page);
        if (again.length) setTimeout(() => askSites(page, again, false), RETRY_MS);
        done();
      };
      setTimeout(() => finish(null), ANSWER_CAP_MS);
      try {
        chrome.runtime.sendMessage({ type: "wayback:hosts", hosts, year: page.st.year }, (answer) => {
          finish(chrome.runtime.lastError ? null : answer);
        });
      } catch (_) { finish(null); }
    });
  }

  // What each result does now: r.leak (hidden for good, or "over ten"), r.held (its site is still being checked).
  // Returns the results to show, in display order: those already drawn keep their places, new ones join at the end.
  function classify(page) {
    const { data, st } = page;
    const drawn = page.drawn || new Map();
    const byHref = new Map(data.results.map((r) => [r.href, r]));
    const list = [...drawn.keys()].map((href) => byHref.get(href) || drawn.get(href));
    for (const r of data.results) {
      r.held = false;
      r.leak = r.baseLeak;
      if (drawn.has(r.href)) { r.leak = null; continue; }
      if (r.leak) continue;
      if (st.strict) {
        if (!r.host) { r.leak = "no address"; continue; }
        const a = siteAnswers.get(hostKey(r));
        if (a === "no") { r.leak = `site did not exist in ${st.year}`; continue; }
        if (a === undefined && !page.released) { r.held = true; continue; }
      }
      if (list.length >= 10) { r.leak = "over ten"; continue; }
      list.push(r);
    }
    return list;
  }

  function draw(page) {
    if (!page.ready) return;
    const list = classify(page);
    if (page.lucky && !page.luckyDone && (page.released || !page.data.results.some((r) => r.held))) {
      page.luckyDone = true;
      const first = page.data.results.find((r) => !r.leak && !r.held);
      if (first) {
        try {
          const u = new URL(location.href);
          u.searchParams.delete(G.LUCKY_PARAM);
          history.replaceState(history.state, "", u.toString());   // Back returns to the results, not to the jump
        } catch (_) { /* keep the URL */ }
        location.href = first.href;   // from google.com: the time machine opens that page as it was back then
        return;
      }
    }
    const held = page.data.results.some((r) => r.held);
    const key = list.map((r) => r.href).join("\n") + (list.length ? "" : held ? "|held" : "|none");
    if (page.drawnKey === key && (!page.st.eraLook || (page.main && page.main.isConnected))) return;   // nothing new
    page.drawn = new Map(list.map((r) => [r.href, r]));
    page.drawnKey = key;
    if (page.st.eraLook) renderResults(page, list); else hideLeaksInPlace(page, list);
  }

  // never bounce between URLs if Google strips or rewrites our parameters
  function loopOk(target) {
    try {
      const k = "yy:replace:" + target;
      const now = Date.now();
      const list = JSON.parse(sessionStorage.getItem(k) || "[]").filter((t) => now - t < 15000);
      if (list.length >= 2) return false;
      list.push(now);
      sessionStorage.setItem(k, JSON.stringify(list));
    } catch (_) { /* no sessionStorage: allow once */ }
    return true;
  }

  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }

  // ---------------------------------------------------------------- reading Google's page
  // Selectors verified live 2026-11-10 (research): cards are #rso div[data-rpos] with a[jsname=UWckNb] h3,
  // wrapper div.MjjYud; snippet [data-sncf="1"] .VwiC3b; date .VwiC3b .YrbPuc > span. Fallback: any a > h3.
  function readResults(st) {
    const scope = document.querySelector("#rso") || document.querySelector("#search") || document.body;
    const seen = new Set();
    const results = [];
    // Titles: today a > h3 (also a > [role=heading]); until about 2018 h3.r > a. Support both in case Google
    // changes the page again. Not results: headings Google itself hides ("Get more results from the past 24
    // hours", display:none in 2011) and headings that link to another Google search.
    const HEADS = "h3, a [role=heading]";
    const linkOf = (head) => head.closest("a[href]") || head.querySelector("a[href]");
    const heads = scope ? [...scope.querySelectorAll(HEADS)].filter((x) => {
      if (x.closest("#yy-root")) return false;
      const a = linkOf(x);
      return !!a && !G.isGoogleSearchLink(a.href) && !hiddenByGoogle(x);
    }) : [];
    const accepted = new Set(heads);
    const acceptedIn = (el) => { let n = 0; for (const x of el.querySelectorAll(HEADS)) if (accepted.has(x) && ++n > 1) break; return n; };
    // A result's card is the largest block around its link that holds no other result title: works for
    // today's div.MjjYud / data-rpos cards and for older layouts alike.
    const cardOf = (a) => {
      let el = a.closest("h3") || a;
      while (el.parentElement && el.parentElement !== scope && acceptedIn(el.parentElement) === 1) el = el.parentElement;
      return el;
    };
    for (const h3 of heads) {
      const a = linkOf(h3);
      if (!a || !a.href || seen.has(a.href)) continue;
      const card = cardOf(a);
      if (!card) continue;
      seen.add(a.href);
      const citeEl = card.querySelector("cite");
      const cite = citeEl ? citeEl.textContent : "";
      const parsed = G.parseCite(cite);
      const host = parsed.host || G.linkHost(a.href);
      const path = parsed.host ? parsed.path : "";
      const snipEl = card.querySelector('[data-sncf="1"] .VwiC3b') || card.querySelector(".VwiC3b") || card.querySelector('[data-sncf="1"]') ||
        card.querySelector(".IsZvec, .st, .s .st, span.aCOpRe");
      let snippet = snipEl ? snipEl.textContent.trim() : longestText(card, h3, citeEl);
      const dateEl = card.querySelector(".VwiC3b .YrbPuc > span") || card.querySelector(".YrbPuc span") || card.querySelector(".LEwnzc span");
      let dateText = dateEl ? dateEl.textContent.trim() : "";
      if (!dateText) {
        const m = snippet.match(/^([^—–-]{4,32}?)\s+[—–-]\s+/);
        if (m && G.dateYear(m[1])) dateText = m[1];
      }
      if (dateText && snippet.startsWith(dateText)) snippet = snippet.slice(dateText.length).replace(/^\s*[—–-]\s*/, "");
      const r = { title: h3.textContent.trim(), href: a.href, cite, host, path, snippet, dateText, card };
      r.baseLeak = G.leakReason(r, st.year, st.strict);
      r.leak = r.baseLeak;
      if (st.strict && G.isLiveHomepage(r)) r.snippet = "";
      results.push(r);
    }
    const statsEl = document.querySelector("#result-stats");
    const count = statsEl ? G.parseStats(statsEl.textContent) : null;
    const nav = performance.getEntriesByType("navigation")[0];
    const seconds = nav ? Math.max(0.03, (nav.responseStart - nav.requestStart) / 1000) : 0.21;
    const page = Math.floor((Number(new URL(location.href).searchParams.get("start")) || 0) / 10) + 1;
    return { results, count, seconds, page, hasNext: !!document.querySelector("#pnnext") || results.length >= 8 };
  }

  // Hidden by Google itself (display:none on the way up, or visibility:hidden set below the page's top block).
  // Stops below body's own children: the period look hides those (eras.css), so they say nothing. Never
  // getClientRects: under the period look every heading has none.
  function hiddenByGoogle(el) {
    let top = null;
    for (let n = el; n && n.parentElement; n = n.parentElement) {
      if (n.parentElement === document.body) { top = n; break; }
      if (getComputedStyle(n).display === "none") return true;
    }
    if (getComputedStyle(el).visibility !== "hidden") return false;
    return !top || getComputedStyle(top).visibility !== "hidden";
  }

  // Fallback snippet: the longest text block in the card that is not the title or the URL line.
  function longestText(card, head, citeEl) {
    let best = "";
    for (const el of card.querySelectorAll("div, span")) {
      if (el.contains(head) || (citeEl && el.contains(citeEl)) || el.children.length > 3) continue;
      const t = el.textContent.trim();
      if (t.length > best.length && t.length < 400) best = t;
    }
    return best.length > 40 ? best : "";
  }

  // Period look off: Google's own page, with leaks and results still being checked hidden; a result that checks
  // out (or moves up from "over ten") is shown again.
  function hideLeaksInPlace(page, list) {
    const show = new Set(list);
    for (const r of page.data.results) {
      const box = r.card.closest("div.MjjYud") || r.card;
      if (!show.has(r)) {
        box.style.setProperty("display", "none", "important");
        box.dataset.yyHidden = r.leak || "checking";
      } else if (box.dataset.yyHidden) {
        box.style.removeProperty("display");
        delete box.dataset.yyHidden;
      }
    }
  }

  // ---------------------------------------------------------------- DOM helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const b = (t) => h("b", { text: t });

  function textLogo(era) {
    const letters = [["G", "#1a3ccf"], ["o", "#d62d20"], ["o", "#f4b400"], ["g", "#1a3ccf"], ["l", "#008744"], ["e", "#d62d20"]];
    const box = h("span", { class: "yy-textlogo" }, letters.map(([c, col]) => h("span", { style: `color:${col}`, text: c })));
    if (era === "1998") box.append(h("span", { style: "color:#d62d20", text: "!" }));
    return box;
  }

  function logo(era, cls) {
    const wrap = h("a", { class: `yy-logo ${cls || ""}`, href: "/webhp", title: "Go to Google Home" }, textLogo(era));
    chrome.runtime.sendMessage({ type: "google:logo", era }, (r) => {
      if (chrome.runtime.lastError || !r || !r.ok) return;
      const img = h("img", { alt: "Google", src: r.dataUrl });
      img.addEventListener("load", () => { wrap.replaceChildren(img); }, { once: true });
    });
    return wrap;
  }

  function mountRoot() {
    let root = document.getElementById("yy-root");
    if (root) root.remove();
    root = h("div", { id: "yy-root", "data-era": html.dataset.yyEra || "" });
    (document.body || html).append(root);
    return root;
  }

  function searchForm(era, st, value, opts = {}) {
    const input = h("input", { type: "text", name: "q", value: value || "", maxlength: "2048", size: opts.size || "41", autocomplete: "off", class: "yy-q", title: "Google Search" });
    const btn = h("input", { type: "submit", value: opts.button || "Google Search", class: "yy-btn" });
    const form = h("form", { action: "/search", method: "GET", class: "yy-form" }, input, " ", btn,
      opts.lucky ? [" ", h("input", { type: "submit", name: "btnI", value: era === "1998" ? "I'm feeling lucky" : "I'm Feeling Lucky", class: "yy-btn" })] : null,
      opts.images ? h("input", { type: "hidden", name: "tbm", value: "isch" }) : null);
    if (opts.lucky) {
      form.addEventListener("submit", (e) => {
        if (!e.submitter || e.submitter.name !== "btnI") return;   // Enter and "Google Search" search as usual
        e.preventDefault();
        const words = input.value.trim();
        if (!words) {   // an empty box opened Google's logo page of that time
          const logos = G.luckyEmptyUrl(pastDay());
          if (logos) location.href = pastUrl(logos); else input.focus();
          return;
        }
        location.href = `/search?q=${encodeURIComponent(words)}&${G.LUCKY_PARAM}=1`;
      });
    }
    return { form, input };
  }

  // Google's other services and the old search engines, opened as they were on today's date in the chosen
  // year (the resolver finds the newest archive copy on or before that day). Each service's address on that
  // day: G.serviceUrl (google_core.js).
  function pastDay() {
    const now = new Date();
    return `${state.year}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }
  function pastUrl(url) {
    return chrome.runtime.getURL(`src/wayback/resolve.html#y=${state.year}&d=${pastDay()}&u=${url}`);
  }
  const ENGINES = {
    "AltaVista": "http://www.altavista.com/", "Deja": "http://www.deja.com/", "Excite": "http://www.excite.com/",
    "HotBot": "http://www.hotbot.com/", "Infoseek": "http://www.infoseek.com/", "Lycos": "http://www.lycos.com/", "Yahoo!": "http://www.yahoo.com/"
  };
  function serviceHref(name, q) {
    if (name === "Web" || name === "All" || name === "Search") return q ? `/search?q=${encodeURIComponent(q)}` : "/";
    if (name === "Images") return q ? `/search?q=${encodeURIComponent(q)}&tbm=isch` : "/imghp";
    // the user's words: YouTube's content script adds before: itself
    if (name === "Videos" || name === "YouTube") return q ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : "https://www.youtube.com/";
    const url = G.serviceUrl(name, pastDay());
    return url ? pastUrl(url) : null;
  }

  function navLinks(era, active, q) {
    return G.navNames(era, pastDay()).map((name) => {
      const on = name === active || (active === "Web" && (name === "All" || name === "Search"));
      if (on) return h("b", { class: "yy-tab on", text: name });
      const href = serviceHref(name, q);
      return href ? h("a", { class: "yy-tab", href, text: name }) : h("span", { class: "yy-tab", text: name });
    });
  }

  const COPY = (year) => `©${year} Google`;

  function footer(era, year) {
    if (era === "1998" || era === "1999") {
      return h("div", { class: "yy-footer" },
        era === "1999" ? h("p", {}, "Try your query on: ", Object.keys(ENGINES).map((n) => [h("a", { href: pastUrl(ENGINES[n]), text: n }), " "])) : null,
        h("p", { class: "yy-copy", text: era === "1998" ? "Copyright ©1998 Google Inc." : COPY(year) }));
    }
    if (era === "2002") return h("div", { class: "yy-footer" }, h("p", {}, "Dissatisfied with your search results? ", h("u", { text: "Help us improve" }), "."),
      h("p", { class: "yy-copy" }, "Google Home - Advertise with Us - Search Solutions - News and Resources - Language Tools - Jobs, Press, Cool Stuff..."), h("p", { class: "yy-copy", text: COPY(year) }));
    if (era === "2004" || era === "2007") return h("div", { class: "yy-footer" }, h("p", { class: "yy-copy" }, "Google Home - Advertising Programs - Business Solutions - About Google"), h("p", { class: "yy-copy", text: COPY(year) }));
    if (era === "2010" || era === "2011") return h("div", { class: "yy-footer" }, h("p", { class: "yy-copy" }, "Google Home  Advertising Programs  Business Solutions  Privacy  About Google"), h("p", { class: "yy-copy", text: `©${year}` }));
    return h("div", { class: "yy-footer yy-footer-bar" }, h("span", { text: "Help" }), h("span", { text: "Send feedback" }), h("span", { text: "Privacy" }), h("span", { text: "Terms" }));
  }

  function pager(era, data, q) {
    const base = new URL(location.href);
    const linkFor = (n) => { const u = new URL(base); u.searchParams.set("start", String((n - 1) * 10)); u.searchParams.delete("ved"); u.searchParams.delete("ei"); return u.toString(); };
    const pages = Math.max(data.page, Math.min(10, data.page + (data.hasNext ? 9 : 0)));
    const first = Math.max(1, Math.min(data.page - 4, pages - 9));
    const cells = [];
    if (data.page > 1) cells.push(h("td", { class: "yy-pg-prev" }, h("a", { href: linkFor(data.page - 1) }, h("span", { class: "yy-G", text: "G" }), h("br"), "Previous")));
    else cells.push(h("td", {}, h("span", { class: "yy-G", text: "G" })));
    for (let n = first; n <= pages; n++) {
      const current = n === data.page;
      cells.push(h("td", { class: current ? "yy-pg cur" : "yy-pg" },
        h("span", { class: current ? "yy-o red" : "yy-o", text: "o" }), h("br"),
        current ? h("span", { class: "yy-pgn", text: String(n) }) : h("a", { href: linkFor(n), text: String(n) })));
    }
    cells.push(h("td", { class: "yy-pg-next" }, h("span", { class: "yy-gle" }, h("span", { class: "g", text: "g" }), h("span", { class: "l", text: "l" }), h("span", { class: "e", text: "e" })), h("br"),
      data.hasNext ? h("a", { href: linkFor(data.page + 1) }, b("Next")) : null));
    return h("table", { class: "yy-pager", align: "center" }, h("tbody", {}, h("tr", {}, cells)));
  }

  function statsLine(era, data, q, shown) {
    const from = (data.page - 1) * 10 + 1, to = (data.page - 1) * 10 + Math.max(shown, 1);
    const secs = data.seconds.toFixed(2);
    const about = data.count ? [" of about ", b(G.formatCount(data.count))] : [];
    if (era === "1998" || era === "1999" || era === "2002") {
      return h("div", { class: "yy-stats blue" },
        h("span", {}, "Searched the web for ", b(q), "."),
        h("span", { class: "r" }, "Results ", b(String(from)), " - ", b(String(to)), about, ". Search took ", b(secs), " seconds."));
    }
    if (era === "2004" || era === "2007") {
      return h("div", { class: "yy-stats light" },
        h("span", {}, b("Web")),
        h("span", { class: "r" }, "Results ", b(String(from)), " - ", b(String(to)), about, " for ", b(q), ". (", b(secs), " seconds)"));
    }
    return h("div", { class: "yy-stats modern", text: data.count ? `About ${G.formatCount(data.count)} results (${secs} seconds)` : `Page ${data.page} (${secs} seconds)` });
  }

  // A result without a known address gets no URL line at all (never a lone "/").
  function resultItem(era, r) {
    const display = r.host ? `${r.host}${r.path ? "/" + r.path : "/"}` : "";
    const title = h("a", { class: "yy-title", href: r.href }, r.title);
    const snippet = h("div", { class: "yy-snippet" }, r.dateText && era >= "2007" ? h("span", { class: "yy-date", text: `${r.dateText} ... ` }) : null, r.snippet || "");
    const old = era <= "2010";
    if (old) {
      const urlLine = display ? h("div", { class: "yy-url" }, h("span", { class: "yy-green", text: display }),
        " - ", h("a", { class: "yy-grey", href: r.href, text: "Cached" }),
        " - ", h("a", { class: "yy-grey", href: `/search?q=${encodeURIComponent(r.host)}`, text: era === "2010" ? "Similar" : "Similar pages" })) : null;
      return h("div", { class: "yy-r" }, h("h3", {}, title), snippet, urlLine);
    }
    if (era >= "2020") {
      const site = display ? h("div", { class: "yy-site" },
        h("img", { class: "yy-fav", alt: "", width: "18", height: "18", src: `/s2/favicons?domain=${encodeURIComponent(r.host)}&sz=32` }),
        h("div", {}, h("div", { class: "yy-sitename", text: r.host.replace(/^www\./, "") }), h("cite", { text: `https://${r.host}${r.path ? " › " + r.path.split("/").join(" › ") : ""}` }))) : null;
      return h("div", { class: "yy-r" }, site, h("h3", {}, title), snippet);
    }
    return h("div", { class: "yy-r" }, h("h3", {}, title), display ? h("div", { class: "yy-url" }, h("span", { class: "yy-green", text: display })) : null, snippet);
  }

  function header(era, st, q) {
    const { form } = searchForm(era, st, q, { button: era >= "2004" && era < "2014" ? "Search" : "Google Search", size: era >= "2014" ? "60" : "41" });
    if (era === "2011") {
      return [h("div", { class: "yy-blackbar" }, navLinks(era, "Search", q)),
              h("div", { class: "yy-head" }, logo(era, "small"), form)];
    }
    if (era === "2007" || era === "2010") {
      return [h("div", { class: "yy-topnav" }, navLinks(era, "Web", q), h("span", { class: "yy-signin", text: era === "2010" ? "iGoogle | Search settings | Sign in" : "iGoogle | Sign in" })),
              h("div", { class: "yy-head" }, logo(era, "small"), form)];
    }
    if (era === "2004") {
      return [h("div", { class: "yy-head" }, logo(era, "small"), h("div", {}, h("div", { class: "yy-links" }, navLinks(era, "Web", q)), form))];
    }
    if (era === "2002") {
      return [h("div", { class: "yy-head" }, logo(era, "small"), h("div", {}, h("div", { class: "yy-folders" }, navLinks(era, "Web", q)), form))];
    }
    if (era >= "2014") {
      return [h("div", { class: "yy-head" }, logo(era, "small"), form),
              h("div", { class: "yy-tabsline" }, navLinks(era, "All", q))];
    }
    return [h("div", { class: "yy-head" }, logo(era, "small"), form)];
  }

  // First call: the whole period page. Later calls (site answers, late cards) replace only the stats line, the
  // results and the pager, so the search boxes keep what is typed in them and their focus.
  function renderResults(page, visible) {
    const { era, st, original } = page;
    if (!page.main || !page.main.isConnected) {
      const root = mountRoot();
      document.title = `${original} - Google Search`;
      root.append(...header(era, st, original));
      const body = h("div", { class: "yy-body" });
      if (era === "2010") {
        body.classList.add("with-side");
        root.append(h("div", { class: "yy-side" },
          ["Everything", "Images", "Videos", "News", "Shopping", "More"].map((n, i) => h("div", { class: i === 0 ? "on" : "" }, n)),
          h("hr"), ["Any time", "Latest", "Past 24 hours", "Past week"].map((n, i) => h("div", { class: i === 0 ? "on" : "" }, n))));
      }
      root.append(body);
      page.main = h("div", { class: "yy-main" });
      body.append(page.main);
      const { form } = searchForm(era, st, original, { button: era >= "2004" && era < "2014" ? "Search" : "Google Search" });
      if (era < "2014") body.append(h("div", { class: "yy-bottombox" }, form));
      root.append(footer(era, st.year));
    }
    page.main.replaceChildren(...resultsBlock(page, visible));
  }

  function resultsBlock(page, visible) {
    const { era, st, original, data } = page;
    const future = YY.futureYearsIn(original, st.year);
    if (future.length) {
      return [statsLine(era, { ...data, count: 0 }, original, 0),
        h("div", { class: "yy-nomatch" }, h("p", {}, "Your search - ", b(original), " - did not match any documents."),
          h("p", { class: "yy-why", text: `${Math.min(...future)} has not happened yet. It is ${st.year}.` }))];
    }
    if (!visible || (!visible.length && data.results.some((r) => r.held))) return [h("div", { class: "yy-loading", text: "Loading results..." })];
    if (!visible.length) {
      return [statsLine(era, { ...data, count: 0 }, original, 0),
        h("div", { class: "yy-nomatch" }, h("p", {}, "Your search - ", b(original), " - did not match any documents."),
          h("p", {}, "Suggestions:"), h("ul", {}, h("li", { text: "Make sure all words are spelled correctly." }), h("li", { text: "Try different keywords." }), h("li", { text: "Try more general keywords." })))];
    }
    return [statsLine(era, data, original, visible.length),
      h("div", { class: "yy-results" }, visible.map((r) => resultItem(era, r))),
      pager(era, data, original)];
  }

  // ---------------------------------------------------------------- homepage
  function onHome(st, opts = {}) {
    const era = YY.googleEra(st.year);
    const active = opts.images ? "Images" : "Web";
    html.classList.add("yy-google", "yy-era", "yy-home");
    html.dataset.yyEra = era;
    onReady(() => {
      const root = mountRoot();
      const y = st.year;
      document.title = opts.images ? "Google Image Search" : "Google";
      const size = era >= "2014" ? "60" : "41";
      const { form, input } = searchForm(era, st, "", opts.images ? { images: true, button: "Search Images", size } : { lucky: true, size });
      const top = [];
      if (era === "2011") top.push(h("div", { class: "yy-blackbar" }, navLinks(era, opts.images ? "Images" : "Search")));
      else if (era === "2007" || era === "2010") top.push(h("div", { class: "yy-topnav" }, navLinks(era, active), h("span", { class: "yy-signin", text: era === "2010" ? "iGoogle | Search settings | Sign in" : "iGoogle | Sign in" })));
      else if (era >= "2014") top.push(h("div", { class: "yy-topright" }, h("a", { href: serviceHref("Gmail"), text: "Gmail" }), h("a", { href: opts.images ? "/" : "/imghp", text: opts.images ? "Search" : "Images" }), h("span", { class: "yy-grid", text: "⁙" }), h("span", { class: "yy-signbtn", text: "Sign in" })));
      const center = h("div", { class: "yy-center" }, logo(era, "big"));
      if (era === "1998") center.append(h("p", { text: "Search the web using Google!" }));
      if (opts.images) center.append(h("div", { class: "yy-images-label", text: "Images" }));
      if (era === "2002") center.append(h("div", { class: "yy-folders" }, navLinks(era, active)));
      if (era === "2004") center.append(h("div", { class: "yy-links" }, navLinks(era, active)));
      center.append(form);
      if (era === "1999" || era === "2002" || era === "2004") center.append(h("div", { class: "yy-under", text: "Advanced Search · Preferences · Language Tools" }));
      if (era === "1998") center.append(h("p", { class: "yy-under" }, "Special Searches: ", h("u", { text: "Stanford Search" }), ", ", h("u", { text: "Linux Search" }), " | ", h("u", { text: "Help!" }), " | ", h("u", { text: "About Google!" }), " | ", h("u", { text: "Company Info" }), " | ", h("u", { text: "Google! Logos" })));
      const counter = G.PAGE_COUNTERS[y];
      const foot = era === "1998" ? `Copyright ©1998 Google Inc.` :
        era <= "2010" ? `Advertising Programs - Business Solutions - About Google ©${y} Google${counter ? ` - Searching ${counter} web pages` : ""}` : "";
      root.append(...top, center, foot ? h("div", { class: "yy-homefoot", text: foot }) : footer(era, y));
      input.focus();
    });
  }

  function banner(text) {
    const el = h("div", { id: "yy-banner", text });
    (document.body || html).prepend(el);
  }
})();
