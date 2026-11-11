# Yesteryear: architecture and contracts (v0.2)

A Chrome MV3 extension (loaded unpacked, personal use, separate Chrome profile recommended) that turns
Google and YouTube into a "time machine": the user picks a year 1998-2025 and searches as usual; results,
pages, looks and music belong to that year or earlier, never later. v0.2 adds the first-run tour
(src/tour), time travel with a year card (src/travel), music that keeps playing in a hidden offscreen
document (src/player), dead-page fallback, the site-existence check and period Google tabs.

Research behind every decision: `research/research_report.json` (landscape, Google date filter, YouTube,
Wayback strictness, era design + music). Key facts:
- Google: `tbs=cdr:1,cd_max:12/31/YYYY` caps by Google's *estimated* page date and still leaks modern pages
  (homepages, stores, undated cards). Result links are opaque `google.com/goto?url=...` tokens since Aug 2026.
  `udm=14` gives plain web results without AI Overview. Stop at `/sorry` (captcha) and never search in the background.
- Query rewriting is required ("this year" -> YYYY, topical queries get YYYY appended): `YY.rewriteQuery`.
- Wayback: only `https://web.archive.org/cdx/search/cdx?url=<u>&to=<YYYY>1231235959&filter=statuscode:200&limit=-1&fastLatest=true&output=json`
  is strict; then open that exact 14-digit timestamp. Availability API, year-only URLs and links inside archived
  pages jump FORWARD in time. `if_` hides the toolbar but links inside drop `if_`. CDX limit: 30 req/min/IP
  hard, budget 20/min; 429 -> back off (IP ban 1 h, doubling). archive.org has 503/504 outages.
  The batch availability API (POST `archive.org/wayback/available`) ignores `"closest":"before"`; it is only
  used for each site's EARLIEST capture (closest to 1996-01-01), and an empty answer means unknown.
- YouTube: `before:YYYY-MM-DD` in `search_query` is enforced server-side, also on continuation pages.
  In-page searches go through `POST /youtubei/v1/search`, so the query must be edited before submit.
  Nothing exists before 2005 (first video 2005-04-23).
- Music: `research/billboard_yearend_1946_2025.json` (Billboard Year-End Hot 100, 1946-2025). A YouTube embed
  inside an extension page needs a Referer header (static DNR rule, `src/player/rules.json`) and is controlled
  via postMessage like `research/exttest/extD/page.js`. Since v0.2 it plays in the offscreen document
  `src/player/offscreen.html` (reason `AUDIO_PLAYBACK`), which nobody sees. Its iframe stays 480x270 because
  YouTube's embed rules ask for a player of at least 200x200 (fine for personal unpacked use; a Web Store
  release would need a visible player). Chrome closes the document after about 30 s without sound (for
  example after a pause); the next command creates it again and resumes the same video at the same second.
  The side panel (`player.html`) and the popup's mini player are only remotes (`remote.js`).

## Layout (each module owns its folder; do not edit other modules' files)
```
extension/
  manifest.json            (integrator) permissions: storage, unlimitedStorage, declarativeNetRequestWithHostAccess,
                           sidePanel, webNavigation, tabs, offscreen (the music's hidden player)
  sw.js                    (integrator) imports the seven sw modules: state, ui, wayback, music, google, tour,
                           travel; each registers its listeners synchronously (MV3 rule)
  src/shared/common.js     (integrator) window.YY for content scripts: getState, onStateChange, send,
                           rewriteQuery, futureYearsIn, googleEra, GOOGLE_ERAS, cutoffTimestamp, extUrl
  src/shared/state_sw.js   (integrator) DEFAULTS, getState, setState, cutoffTimestamp, MIN/MAX_YEAR;
                           answers getState/setState
  src/google/              Google module: content.js (parser, leak filter, period look, period tabs),
                           google_core.js, sw_google.js (era logos), eras.css, assets/ (no Google logos bundled;
                           era logos are fetched at runtime from web.archive.org `id_` URLs and cached)
  src/wayback/             Wayback module: sw_wayback.js, wayback_core.js, resolve.html/.js, notfound.html/.js,
                           era_chrome.js (period browser frames), pages.css
  src/youtube/             YouTube module: content.js, youtube_core.js, youtube.css
  src/player/              Music module: sw_music.js (hub + video finder), music_state.js (message names, state
                           shape), offscreen.html/.js/.css (the hidden player), engine.js, playlist.js, ytwidget.js,
                           ytsearch.js, remote.js, player.html/.js/.css (side panel), visualizer.js,
                           miniplayer.js/.css (popup), rules.json, charts.json
  src/ui/                  UI module: sw_ui.js (toolbar badge), popup.html/.js/.css, logic.js, icons/
                           (98.css look, vendor copy in src/vendor/98css/)
  src/tour/                Tour module: sw_tour.js, tour_core.js (steps, keys), welcome.html/.js/.css,
                           agent.js (sprite player), info.svg; characters in src/vendor/clippy/
  src/travel/              Travel module: sw_travel.js, travel_core.js (trip, eras, timeline, dates),
                           travel.html/.js/.css, warp.js (canvas tunnel), sfx.js (WebAudio, no sound files),
                           years.json (each year's card: meme {.., on}, 6 dated facts [{text, on}], tech {text, on},
                           searches [{q, on}] x6, sites [{name, url, first}] x6; "on" = MM-DD of that year)
  src/vendor/              98css/ (98.css 0.1.21, MIT; font CC BY-SA 3.0); clippy/ (clippyjs 0.1.0 data; the
                           characters belong to Microsoft: personal use only, never publish them)
tests/<module>/*.test.mjs  node --test unit tests, NO network
tests/<module>/*.py        live checks in throwaway Chromium profiles (test-profile-*, test-build-*); fully stubbed
                           ones: tests/live/core_check.py (core fixes, no network; --src=<dir> checks another export),
                           tests/ui/popup_check.py, tests/player/popup_width.py
```

## State
Settings in `chrome.storage.local` (defaults in state_sw.js and common.js): `enabled` (bool), `year` (1998-2025),
`google` (bool), `youtube` (bool), `strict` (bool), `eraLook` (bool), `musicAutoplay` (bool, no UI yet).

Module keys carry the module's prefix:

| key | area | owner | value |
|---|---|---|---|
| `wb2:<year>[:<YYYYMMDD>]:<url>` | local | wayback | `{ts, original, approx: page\|noquery\|site\|stale, at}` or `{none:true, at}`; kept 7 days; errors and degraded hits are never cached; old `wb:` keys are deleted on install/update |
| `wbfirst:<host>` | local | wayback | `{ts, at}`: the site's earliest capture (kept: it does not depend on the year), or `{ts:null, at, n}`: an empty answer is asked once more, then counts as unknown for 1 h. The Google content script reads these keys directly (read only) |
| `wbday:<tabId>` | session | wayback | `{year, day}`: the day cut of a tab while it browses the archive (period tabs, "Today in YEAR") |
| `goog:logo:<era>` | local | google | `{dataUrl, at}`; `dataUrl: null` = try again after a day |
| `mus:id:<artist>\|<title>` | local | player | `{videoId, candidates, at}` |
| `mus:bad:<videoId>` | local | player | `{code, at}` (YouTube player error; code 5 counts as temporary) |
| `mus:cooldown`, `mus:rate` | local | player | YouTube search back-off (`{until, ms}`) and recent search times |
| `mus:pos:<year>` | local | player | `{index, shuffle}` |
| `mus:volume` | local | player | 0..100 |
| `mus:session` | session | player | the last music state (answers and resumes while there is no offscreen document) |
| `tour:agent` | local | tour | `"clippy"` or `"rover"` |
| `tour:done` | local | tour | true once the tour was finished or skipped |
| `tour:sound` | local | tour | false: the guide stays silent |
| `tour:shown` | local | tour | true once the service worker opened the tour by itself |
| `travel:last` | local | travel | destination of the last trip (written on every trip; the popup does NOT depart from it, see Time travel) |

Page `sessionStorage` (one tab only, not chrome.storage): the Google content script keeps `yy:orig:<rewritten query>`
(the user's own words) and `yy:replace:<url>` (loop guard); the YouTube content script keeps `yy:ytq:<built query>`
(the user's words; "" = the home page's year search); the travel page keeps `travel:played` (nonces of the trips
this tab has played).

## Messages (chrome.runtime.sendMessage; each sw module handles only its own types, returns true if async)
| type | owner | request | reply |
|---|---|---|---|
| `getState` / `setState` | state_sw | `{}` / `{patch}` | full state |
| `wayback:resolve` | wayback | `{url, year, day?: "YYYYMMDD", force200?: true}` (force200: sent by resolve.html when why=future) | `{ok:true, ts, waybackUrl, approx: "page"\|"noquery"\|"site"\|"stale", degraded?, cached?}` or `{ok:false, reason: "none"\|"error"\|"busy"\|"bad-request"}` |
| `wayback:hosts` | wayback | `{hosts: [host, ...] (25 max), year}` | `{<host>: "yes"\|"no"\|"unknown"\|"busy"}` (did the site exist by the end of the year; busy = 429 or paused) |
| `google:logo` | google | `{era}` | `{ok:true, dataUrl}` or `{ok:false}` |
| `music:control` | player | `{cmd: play\|pause\|toggle\|next\|prev\|select\|seek\|shuffle\|volume, index?, play?, time?, volume?, on?}` | `{ok, state, reason?}` |
| `music:state` | player | `{}` | state `{playing, loading, year, index, length, track:{artist, title, rank}, time, duration, at, skin, shuffle, volume, status, problem, videoId, alive}` |
| `music:changed` | player | broadcast to every extension page: `{state, source: "engine"\|"hub"}` | none |
| `music:engine` | player (internal) | SW -> offscreen engine: `{cmd, ...}` | `{ok, state}` |
| `music:engine:boot` | player (internal) | offscreen engine -> SW: `{}` | `{year, pos, resume, volume}` |
| `music:videoId` | player | `{artist, title, exclude?: [videoId], prefetch?}` | `{ok:true, videoId}` or `{ok:false, reason}` |
| `music:bad` | player | `{videoId, code, artist?, title?}` | `{ok:true}` (the player confirmed the video does not play) |
| `tour:open` | tour | `{}` | `{ok:true, tabId, reused}` or `{ok:false, error}` |
| `travel:go` | travel | `{from, to, sound?}` | `{ok:true, tabId, url}` or `{ok:false, reason: "bad-request"\|"error"}` |

Senders:
- the popup: `travel:go`, `tour:open`, and `music:state` / `music:control` through miniplayer.js and remote.js; it
  reads and writes the settings with state_sw.js directly (no message);
- the tour page: no message, it reads and writes only its own `tour:*` keys;
- the travel page: `getState`, `setState`, `music:control`, and it follows the music through `connectMusic` from
  src/player/remote.js (keep `connectMusic(onState) -> {close}` stable);
- the Google content script: `wayback:hosts`, `google:logo` (and it reads `wbfirst:` keys directly); resolve.html:
  `wayback:resolve`; common.js also exports `onSettledStateChange` (open tabs follow a settled year change once);
- the offscreen engine: `music:engine:boot`, `music:videoId`, `music:bad`, `music:changed`.

## Pages
- `src/ui/popup.html`: the toolbar popup (year dial, switches, "Travel to YEAR >>", mini player, "?").
- `src/wayback/resolve.html#y=<year>[&d=<YYYYMMDD>]&u=<url>` (u is the REST of the fragment, raw or
  percent-encoded, because a DNR regexSubstitution cannot encode it): era-style "Opening page..." then
  `location.replace(waybackUrl)` or `notfound.html#y=...&why=...&u=...`. `d` cuts at the end of that day instead of
  the end of the year (the period Google tabs and the travel card's "Today in YEAR" links use it). When only the
  site's front page of that year exists (`approx: "site"`), it first shows a period info bar: "This page was not
  saved in YEAR. Opening HOST as it looked in YEAR...". Info bars also cover `noquery`, `stale` and degraded answers,
  and Google sign-in services ("This is an archived copy. Do not sign in here."). `&why=future` (a landing after the
  cut) asks again for 200-only captures and replaces the cached pick.
- `src/wayback/notfound.html#y=<year>&why=none|busy|error|loop[&d=<YYYYMMDD>][&from=youtube]&u=<url>`: era-style
  "The page cannot be displayed" (IE/Chrome look of that year) with "Try again"; why=loop shows ERR_TOO_MANY_REDIRECTS;
  from=youtube (u = the real YouTube page) goes back to YouTube once the year allows it.
- `src/tour/welcome.html[#agent=clippy|rover&step=<n>&sound=0]`: the first-run tour. The popup in it is an `inert`
  iframe of popup.html (it never changes a setting and only ever sends `music:state`); welcome.js also sets `inert`
  on the framed popup's own <html>, because the iframe attribute does not stop popup.js from focusing its slider, and
  popup.js only focuses the slider when it is not framed. Escape leaves the tour whenever the guide is on stage;
  `EXIT_MS` (600) lives in tour_core.js.
- `src/travel/travel.html#from=<year>&to=<year>[&sound=0]&t=<nonce>`: the trip (tunnel, odometer, flash) and the
  year card. Every trip gets a new nonce, so a reused tab plays again; a nonce the tab has played means
  Back/Forward and shows the card only.
- `src/player/offscreen.html`: the hidden player (offscreen document, reason `AUDIO_PLAYBACK`, needs the
  `offscreen` permission). An extension may have only one offscreen document: the music module owns it.
- `src/player/player.html`: the side panel (`side_panel.default_path`), a remote. Opened by the mini player's
  "Show player" (`chrome.sidePanel.open` inside the click) or by the travel card as a fallback; "Hide player"
  closes it (`chrome.sidePanel.close`) and the music keeps playing.

Web-accessible: only resolve.html and notfound.html (they open from google.com pages and from the DNR redirect).

## Features across modules
- **Time travel:** the popup's "Travel to YEAR >>" saves `{year, enabled: true}`, then sends `travel:go`.
  `from` is `departureYear()` (src/ui/logic.js): where Google and YouTube are, i.e. the saved year while the
  time machine is ON and the present while it is OFF, taken when the popup opens and again when its ON switch is
  flipped. The dial only picks the destination. `normalizeTrip()` (travel_core.js) starts a trip to the year you
  are already in from the present. The SW opens travel.html in the sender's tab, else reuses an empty new tab or
  an earlier trip, else opens a tab next to the active one. The card's "Search like it's YEAR" sets
  `{enabled, google, year}` and opens google.com; "Play the hits of YEAR" sends `music:control play` (falls back to
  opening the side panel) and follows the music state; "Today in YEAR" opens CNN, BBC News and The New York Times of
  that day through resolve.html with `d=`; "People are searching" (searches of that year dated on or before the
  card's day) sets `{enabled, google, year}` and opens google.com/search?q=; "Web favorites" opens the year's popular
  sites through resolve.html with `d=`. The card's links set the dial to the card's year while ON.
  The card never shows anything dated after its day: it lists the latest 3 facts dated on or before that day and falls
  back to last year's meme, gadget and facts ("Still everywhere", "Everyone still wants", "Looking back at YEAR-1").
- **Dead result pages:** the resolver tries the page, then the page without its query, then the site's front page
  of that year (shown with the info bar above). Front-page and day-cut lookups read the newest 20 2xx/3xx captures and
  prefer the newest 2xx; a landing after the cut is re-resolved 200-only; the same target bouncing back after the
  resolver answered is a loop at once (the 20 s / 4-bounce rate stays as the second net).
- **Sites that did not exist yet:** with Strict on, the Google content script sends the result hosts to
  `wayback:hosts` (one POST to archive.org per results page, earliest captures cached per site) and drops results
  whose site was first captured after the year. The period page (logo, search box, "Loading results...") is drawn at
  once; cached answers apply before the first results draw; the period look waits up to 1.5 s for the rest; unchecked
  results are held back and join at the end, never pulled out of view, and at most 4 s after the page started
  (`HOLD_MAX_MS`) they are shown anyway (a slow or hung archive). The availability POST has its own queue (3 s gap,
  10/min) and an 8 s timeout; a 429 pauses both archive queues for 70 s. resolve.html and notfound.html start over
  on a hashchange (the guard may send a resolver tab to another year by changing only the fragment).
- **Period Google tabs:** in the period look, News, Groups, Directory, Froogle, Maps, Video, Shopping, +You, Play,
  Drive, Gmail and "more" open `resolve.html#y=<year>&d=<today's date in that year>&u=<the service>`, so the
  service appears as it was on that day (service addresses by date: `G.serviceUrl`; the 2011 black bar shows Play
  from 2012-03-06 and Drive from 2012-04-24, before that Documents and Calendar). Archived Google sign-in forms
  cannot post: the always-on DNR rule 1001 blocks them, and the resolver warns first.
- **I'm Feeling Lucky** (period homepage): never Google's own `btnI` (it jumps to an uncapped first hit). An empty
  box opens Google's logo page of that day through resolve.html (`G.luckyEmptyUrl`: logos.html from 1999-10-13,
  holidaylogos.html from 2000-11-09, /logos/ from 2009-05-22, /doodles/ from 2014-04-11, doodles.google from
  2023-11-07; nothing before). With words it opens `/search?q=<words>&yylucky=1`: the results page runs the date cap
  and the checks, then opens the first result that passed (the redirect rule sends it to the resolver) after
  removing the marker from its own URL with history.replaceState, so Back shows the results.
  Check: `tests/live/lucky_check.py [year]`. Images opens a period Google Images page (`/imghp`) or Google's own
  image grid with the date filter; Videos/YouTube open youtube.com (where the time machine applies). In the 1999
  look (1999-2001) the footer "Try your query on" opens AltaVista, Deja, Excite, HotBot, Infoseek, Lycos and
  Yahoo! of that day.
- **Music:** the hub in the SW creates the offscreen document on demand, forwards commands, keeps the last state
  in `mus:session` and follows the stored `year` (with `musicAutoplay` a year change starts the music). Remotes:
  the side panel, the popup's mini player and the travel card. A video that never starts is given up after 25 s
  without sound (`TIMING.silenceMs`), before Chrome's 30 s close, with `NO_START_TEXT` (music_state.js); the hub
  shows the same text when the document vanished while loading.
- **Tour:** opens itself on install, and once after the update that brought it when it was never shown or
  finished. "?" in the popup sends `tour:open`, which reuses an open tour tab.

## DNR rule id ranges
Static `embed_referer` ruleset (src/player/rules.json): ids 1-99 (rule 1 sets the Referer for
`youtube.com/embed/*yy_player=1` sub-frames, the offscreen player included). Dynamic: wayback 1000-1999 (1000 sends
pages opened from Google results to resolve.html; 1001, always on, blocks POSTs from archived Google sign-in forms),
youtube 2000-2999, google 3000-3999, ui 4000-4999 (the last three are reserved). A module only adds/removes ids in its own range.

## CSS scoping
Content-script CSS applies only under `html.yy-google` (Google) or `html.yy-youtube` (YouTube); the content
script adds the class only while the time machine is enabled for that site.

## House rules for pages and copy
- Extension pages: bundled scripts only (no inline scripts or handlers, no remote scripts); build the DOM with
  createElement/textContent. google.com pages: no innerHTML (Trusted Types).
- UI copy: English, short, plain; no long dashes (U+2014, U+2013).
- Popup height: Chrome caps a popup at 600 DIP, which is 480 CSS px at 125 % page zoom. The popup is 446 px, or
  473 px with a note line (`tests/ui/popup_check.py`). 150 % zoom (400 px) would need a denser layout.

## Network budgets (protect the user's IP)
- Google: NO automated requests from this machine (Google answers with a captcha). Browser checks serve
  www.google.com from a local stub or a saved page (`tests/live/render_fixture.py`, `services_check.py`).
  Playwright's `ctx.route("**/*")` also catches chrome-extension:// requests: let those through. It does NOT see
  the first request of a tab the extension opens itself (chrome.tabs.create / windows.create): live checks must
  never open google.com URLs in such tabs (no Ctrl, middle or Shift clicks on google.com links).
- YouTube: no searches from automation; one embed load per run is fine. The extension's own song lookups: at most
  30 per 10 minutes, at least 1.5 s apart, with a doubling back-off after a 429 or a "sorry" page.
- archive.org CDX: the extension stays at <= 20/min with >= 1 s between requests and pauses 70 s after a 429;
  tests keep >= 3 s spacing.
- Wikimedia (the travel card's images): plain scripts get HTTP 429; check images in a browser.
