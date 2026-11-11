"""Visual and functional check of the time-travel feature in Playwright's Chromium (headless, throwaway profile).

Builds a copy of the extension in test-build-travel/ with this module's INTEGRATION NEEDED changes applied
(sw.js import + init, the popup's "Travel to <year> >>" button), runs the UI and travel unit tests against
that copy, then drives it:
  popup    popup with the travel button
  warp     the time tunnel mid-way (back and forward); the drums blur on a next trip in the same tab and
           on "Replay the trip" after a resize
  landing  landing cards for 1999 2005 2010 2016 2023 (+ 2021 rounded, 2008): nothing dated after the card's
           day, the rows of searches, sites and front pages, one download per meme picture
  fit      the card fits 1366x768, 1280x800 and 1000x768 without scrolling (screenshots fit_*.png)
  dates    fixed clock: January 3 and November 11 cards fall back to last year's meme, gadget and facts
  motion   reduced-motion mode, click to skip
  flow     popup click -> travel:go -> trip -> "Play the hits" -> "People are searching" -> "Search like
           it's <year>" -> Back; a "Web favorites" link from a card later than the dial
  images   every years.json image loads in the browser, spaced 2.5 s apart (polite to Wikimedia)
No request reaches Google, YouTube or the Internet Archive: www.google.com is answered by a local stub page
(main frame only), a session rule blocks every other request to google.com, youtube.com, googlevideo.com,
ytimg.com and archive.org (also the service worker's and the offscreen player's), and a seeded music
cooldown stops the player before it searches YouTube. Headless Chromium plays no sound either way.

Usage: .venv/Scripts/python.exe tests/travel/visual_check.py [build] [popup] [warp] [landing] [fit] [dates] [motion] [flow] [images]
"""
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "extension"
BUILD = ROOT / "test-build-travel"
EXT = BUILD / "extension"
PROFILE = ROOT / "test-profile-travel"
SHOTS = ROOT / "test-shots" / "travel"
sys.stdout.reconfigure(encoding="utf-8")
STEPS = sys.argv[1:] or ["build", "popup", "warp", "landing", "fit", "dates", "motion", "flow", "images"]
YEARS = json.loads((SRC / "src/travel/years.json").read_text(encoding="utf-8"))
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
SLOW = "YouTube asked us to slow down. Try again later."  # src/player/engine.js, a search hits the cooldown
# Test-only safety net (DNR session rule): no type is listed, so it blocks every request type except the
# main frame. The www.google.com stub navigations still work; YouTube lookups of the service worker, the
# offscreen player's embed (and the google.com bot check it would call) and Wayback lookups do not.
BLOCK_RULE = {"id": 9001, "priority": 100, "action": {"type": "block"},
              "condition": {"requestDomains": ["google.com", "youtube.com", "googlevideo.com", "ytimg.com", "archive.org"]}}
results = []


def log(step, ok, info):
    results.append({"step": step, "ok": bool(ok), "info": info})
    print(("PASS " if ok else "FAIL ") + step + ": " + info, flush=True)


# ---- INTEGRATION NEEDED, applied to the copy only ------------------------------------------------
PATCHES = {
    "sw.js": [
        ('import { initGoogle } from "./src/google/sw_google.js";\n',
         'import { initGoogle } from "./src/google/sw_google.js";\nimport { initTravel } from "./src/travel/sw_travel.js";\n'),
        ("initGoogle();\n", "initGoogle();\ninitTravel();\n"),
    ],
    "src/ui/popup.html": [
        ('      <div class="quick" id="quick" role="group" aria-label="Jump to year"></div>\n',
         '      <div class="quick" id="quick" role="group" aria-label="Jump to year"></div>\n\n'
         '      <div class="travel-row">\n'
         '        <button type="button" id="travel" class="default">Travel to 2010 &gt;&gt;</button>\n'
         '      </div>\n'),
    ],
    "src/ui/popup.css": [
        ("#music { min-width: 120px; }\n",
         "#music { min-width: 120px; }\n\n"
         "/* ---- Travel button (src/travel) --------------------------------------------------------------- */\n"
         ".travel-row { margin-top: 10px; }\n"
         "#travel { display: block; width: 100%; min-height: 30px; font-weight: bold; letter-spacing: 0.5px; }\n"),
    ],
    "src/ui/popup.js": [
        ('  quick: $("quick"), music: $("music"), note: $("note"), close: $("close"),\n',
         '  quick: $("quick"), music: $("music"), travel: $("travel"), note: $("note"), close: $("close"),\n'),
        ("// ---- Render -----",
         "// ---- Time travel (src/travel) ----------------------------------------------------------------------\n"
         "const TRAVEL_LAST_KEY = \"travel:last\"; // year of the last trip, written by src/travel/sw_travel.js\n"
         "const travelLabel = (year) => `Travel to ${year} >>`;\n"
         "\n"
         "function wireTravel() {\n"
         "  el.travel.addEventListener(\"click\", async () => {\n"
         "    const to = shownYear();\n"
         "    yearSaver.cancel(); // saved below, together with the switch\n"
         "    draftYear = null;\n"
         "    state = { ...state, year: to, enabled: true };\n"
         "    render();\n"
         "    if (!HAS_CHROME) return;\n"
         "    el.travel.disabled = true;\n"
         "    try {\n"
         "      const last = Number((await chrome.storage.local.get(TRAVEL_LAST_KEY))[TRAVEL_LAST_KEY]);\n"
         "      const from = Number.isFinite(last) && last > 0 ? last : new Date().getFullYear();\n"
         "      // Travelling switches the time machine on: Google and YouTube are in that year on arrival.\n"
         "      await setState({ year: to, enabled: true });\n"
         "      const reply = await chrome.runtime.sendMessage({ type: \"travel:go\", from, to });\n"
         "      if (!reply?.ok) throw new Error(reply?.reason || \"no answer\");\n"
         "      window.close();\n"
         "    } catch (err) {\n"
         "      el.travel.disabled = false;\n"
         "      showProblem(`Could not travel: ${errorText(err)}`);\n"
         "    }\n"
         "  });\n"
         "}\n"
         "\n"
         "// ---- Render -----"),
        ("  el.music.textContent = musicLabel(year);\n",
         "  el.music.textContent = musicLabel(year);\n  el.travel.textContent = travelLabel(year);\n"),
        ("wireMusic();\n", "wireMusic();\nwireTravel();\n"),
    ],
}


def build():
    shutil.rmtree(BUILD, ignore_errors=True)
    shutil.copytree(SRC, EXT, ignore=shutil.ignore_patterns("_metadata"))
    integrated = "initTravel" in (EXT / "sw.js").read_text(encoding="utf-8")   # tests/integrate_v02.py ran
    for rel, pairs in ({} if integrated else PATCHES).items():
        p = EXT / rel
        text = p.read_text(encoding="utf-8")
        for old, new in pairs:
            if text.count(old) != 1:
                raise SystemExit(f"patch anchor not found exactly once in {rel}: {old[:60]!r}")
            text = text.replace(old, new)
        p.write_text(text, encoding="utf-8", newline="\n")
    for folder in ("ui", "travel"):
        shutil.copytree(ROOT / "tests" / folder, BUILD / "tests" / folder, ignore=shutil.ignore_patterns("*.py"))
    r = subprocess.run(["node", "--test", "tests/ui/*.test.mjs", "tests/travel/*.test.mjs"], cwd=BUILD,
                       capture_output=True, text=True, encoding="utf-8")
    summary = [line for line in r.stdout.splitlines() if line.startswith("ℹ ")]
    print("\n".join(summary))
    log("build", r.returncode == 0, "unit tests on the integrated copy: " + " | ".join(s[2:] for s in summary[:4]))
    if r.returncode:
        print(r.stdout[-3000:])


GOOGLE_STUB = b"<!doctype html><title>Google stub</title><body><p>stub</p></body>"

# The card as the page drew it.
CARD_JS = """() => {
    const d = document.querySelector('.desktop'), q = (s) => document.querySelector(s);
    const texts = (s) => [...document.querySelectorAll(s)].map((n) => n.textContent);
    const local = (a) => a.href.replace(/^chrome-extension:\\/\\/[^/]+/, '');
    const img = q('.pic-main');
    return {
        era: document.documentElement.dataset.era, title: document.title,
        date: (q('.hero .date') || {}).textContent || '',
        memeTitle: (q('.meme-title') || {}).textContent || null, memeBox: (q('.meme:not([hidden]) .box-title') || {}).textContent || null,
        img: img ? [img.naturalWidth, img.naturalHeight] : 'broken', fill: !!q('.pic .pic-bg'),
        song: (q('.song-title') || {}).textContent || null,
        factsBox: (q('.facts:not([hidden]) .box-title') || {}).textContent || null, facts: texts('.facts li'),
        gadget: texts('.gadget:not([hidden]) h2, .gadget:not([hidden]) p'),
        searches: texts('.searches a'), searchHrefs: [...document.querySelectorAll('.searches a')].map((a) => a.href),
        sites: texts('.sites a'), siteHrefs: [...document.querySelectorAll('.sites a')].map(local),
        today: [...document.querySelectorAll('.today a')].map(local),
        overflow: d.scrollHeight > d.clientHeight, hscroll: document.documentElement.scrollWidth > innerWidth
    };
}"""


def card_day(info):
    """'It is Thursday, November 11, 1999.' -> '11-11'."""
    m = re.search(r"(\w+) (\d{1,2}), \d{4}\.$", info["date"])
    return f"{MONTHS.index(m.group(1)) + 1:02d}-{int(m.group(2)):02d}"


def card_problems(info, year):
    """What the card shows that it must not (anything dated after its day), or misses."""
    md, entry, prev = card_day(info), YEARS[str(year)], YEARS.get(str(year - 1))
    bad = []
    if year > 1998 and not 1 <= len(info["facts"]) <= 3:
        bad.append(f"{len(info['facts'])} facts")
    looking_back = (info["factsBox"] or "").startswith("Looking back")
    pool = prev["facts"] if looking_back else entry["facts"]
    for text in info["facts"]:
        fact = next((f for f in pool if f["text"] == text), None)
        if not fact or (not looking_back and fact["on"] > md):
            bad.append(f"fact {text!r} on {md}")
    for q in info["searches"]:
        s = next((s for s in entry["searches"] if s["q"] == q), None)
        if not s or s["on"] > md:
            bad.append(f"search {q!r} on {md}")
    if info["memeTitle"] == entry["meme"]["title"] and entry["meme"]["on"] > md:
        bad.append(f"meme of {year} before {entry['meme']['on']}")
    if entry["tech"]["text"] in info["gadget"] and entry["tech"]["on"] > md:
        bad.append(f"gadget of {year} before {entry['tech']['on']}")
    if len(info["sites"]) != 6 or len(info["today"]) != 3:
        bad.append(f"{len(info['sites'])} sites, {len(info['today'])} front pages")
    day = f"{year}{md.replace('-', '')}"
    for href in info["siteHrefs"] + info["today"]:
        if not href.startswith(f"/src/wayback/resolve.html#y={year}&d={day}&u=http"):
            bad.append(f"link {href}")
    if any(not h.startswith("https://www.google.com/search?q=") for h in info["searchHrefs"]):
        bad.append("search links")
    if info["hscroll"]:
        bad.append("horizontal scroll")
    return bad


# Samples the drum blur on every frame while the trip is on screen.
BLUR_SAMPLER = """() => {
    const s = window.__blur = {frames: 0, blurred: 0, max: 0};
    const filters = [0, 1, 2, 3].map((i) => document.querySelector('#blur' + i + ' feGaussianBlur'));
    const t0 = performance.now();
    (function tick() {
        if (!document.getElementById('trip').hidden) {
            s.frames++;
            if ([...document.querySelectorAll('.strip')].some((st) => (st.style.filter || '').startsWith('url('))) s.blurred++;
            for (const f of filters) s.max = Math.max(s.max, parseFloat((f.getAttribute('stdDeviation') || '0 0').split(' ')[1]) || 0);
        }
        if (performance.now() - t0 < 5000) requestAnimationFrame(tick);
    })();
}"""

WAIT_CARD = "() => { const i = document.querySelector('.pic-main'); return document.documentElement.dataset.phase === 'done' && !!document.querySelector('.sites a') && (!i || i.complete); }"


def main():
    if "build" in STEPS or not EXT.exists():
        build()
    SHOTS.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(PROFILE, ignore_errors=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), channel="chromium", headless=True,
            args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--lang=en-US"],
            locale="en-US", viewport={"width": 1280, "height": 900})
        google_hits = []

        def google(route):
            google_hits.append(route.request.url)
            route.fulfill(status=200, body=GOOGLE_STUB, headers={"content-type": "text/html; charset=utf-8"})

        # The route sees navigations of pages it is attached to (location.assign/replace, Back), but NOT the
        # first request of a tab the extension opens with chrome.tabs.create (checked with example.com: the
        # real page loaded). So this check never Ctrl/middle/Shift-clicks a google.com link.
        ctx.route("https://www.google.com/**", google)
        ctx.route("https://www.gstatic.com/**", lambda route: route.abort())
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        base = f"chrome-extension://{ext_id}"
        print("extension id", ext_id)
        errors = []
        ctx.on("weberror", lambda e: errors.append(str(e.error)))

        def page_with_console():
            # ERR_BLOCKED_BY_CLIENT is the safety rule at work (e.g. the Google module asking google.com for
            # an image on the stub page), not a page error.
            pg = ctx.new_page()
            pg.on("console", lambda m: errors.append(f"console {m.type}: {m.text} @ {pg.url[:60]}")
                  if m.type == "error" and "ERR_BLOCKED_BY_CLIENT" not in m.text else None)
            return pg

        def ext_eval(script, arg=None):
            pg = ctx.new_page()
            pg.goto(f"{base}/src/ui/popup.html")
            out = pg.evaluate(script, arg)
            pg.close()
            return out

        def set_state(**state):
            # A day-long music cooldown: "Play the hits" starts the real player, which must stop before it
            # searches YouTube. No song -> video ids are seeded, so it never loads a YouTube embed either.
            now = int(time.time() * 1000)
            ext_eval("s => chrome.storage.local.remove(['travel:last', 'mus:rate']).then(() => chrome.storage.local.set(s))",
                     {**state, "mus:cooldown": {"until": now + 86400000, "ms": 86400000}})

        ext_eval("r => chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [r.id], addRules: [r]})", BLOCK_RULE)
        rules = ext_eval("() => chrome.declarativeNetRequest.getSessionRules()")
        log("safety: block rule", any(r["id"] == BLOCK_RULE["id"] for r in rules), f"session rules: {[r['id'] for r in rules]}")
        set_state(enabled=False, year=1999, google=True, youtube=True, strict=True, eraLook=True)

        if "popup" in STEPS:
            pg = ctx.new_page()
            pg.set_viewport_size({"width": 320, "height": 470})
            pg.goto(f"{base}/src/ui/popup.html")
            pg.wait_for_timeout(700)
            label = pg.text_content("#travel")
            pg.screenshot(path=str(SHOTS / "popup_travel_button.png"))
            log("popup", label == "Travel to 1999 >>", f"button label {label!r}")
            pg.close()

        if "warp" in STEPS:
            pg = page_with_console()
            pg.goto(f"{base}/src/travel/travel.html#from=2026&to=1999&t=w1")
            ac = pg.evaluate("() => { const c = new AudioContext(); const s = c.state; c.close(); return s; }")
            pg.evaluate(BLUR_SAMPLER)
            phases = []
            # performance.now() counts from the navigation, the trip starts a few ms later. The phase is read
            # before the screenshot, which can take a while.
            for name, at in [("warp_1999_mid", 1700), ("warp_1999_fast", 2650), ("warp_1999_locked", 3250)]:
                pg.wait_for_function(f"() => performance.now() > {at}")
                phases.append(pg.evaluate("document.documentElement.dataset.phase"))
                pg.screenshot(path=str(SHOTS / f"{name}.png"))
            log("warp", phases == ["roll", "roll", "lock"], f"phases at the shots: {phases}; AudioContext without a gesture: {ac}")

            # The service worker sends a travel tab on its next trip by changing only the fragment.
            pg.wait_for_function("() => document.documentElement.dataset.phase === 'done'", timeout=9000)
            first = pg.evaluate("window.__blur")
            pg.evaluate(BLUR_SAMPLER)
            t0 = pg.evaluate("() => { location.hash = '#from=1999&to=2016&t=w2'; return performance.now(); }")
            pg.wait_for_function(f"() => performance.now() > {t0 + 1700}")
            st = pg.evaluate("({phase: document.documentElement.dataset.phase, dir: document.documentElement.dataset.direction, era: document.documentElement.dataset.era})")
            pg.screenshot(path=str(SHOTS / "warp_forward_2016_mid.png"))
            log("warp: next trip in the same tab", st == {"phase": "roll", "dir": "forward", "era": "flat"}, str(st))
            pg.wait_for_function("() => document.documentElement.dataset.phase === 'done'", timeout=9000)
            second = pg.evaluate("window.__blur")
            log("warp: drums blur on the first and the next trip", first["blurred"] > 0 and second["blurred"] > 0 and second["max"] >= 1,
                f"first {first}, next {second}")

            # A resize while the card is up measures the hidden drums as 0 px; "Replay the trip" measures again.
            pg.set_viewport_size({"width": 1180, "height": 860})
            pg.wait_for_timeout(300)
            pg.evaluate(BLUR_SAMPLER)
            pg.click("text=Replay the trip")
            # The replay starts right after the click (a timeout): wait for it to begin, then to end.
            pg.wait_for_function("() => document.documentElement.dataset.phase !== 'done'", timeout=3000, polling=10)
            pg.wait_for_function("() => document.documentElement.dataset.phase === 'done'", timeout=9000)
            again = pg.evaluate("window.__blur")
            log("warp: replay after a resize still blurs", again["blurred"] > 0 and again["max"] >= 1, str(again))
            pg.set_viewport_size({"width": 1280, "height": 900})

            pg.go_back()
            pg.wait_for_timeout(300)
            st = pg.evaluate("({phase: document.documentElement.dataset.phase, era: document.documentElement.dataset.era, title: document.title, landing: !document.getElementById('landing').hidden})")
            log("warp: Back to the 1999 trip shows its card", st == {"phase": "done", "era": "win98", "title": "Welcome to 1999", "landing": True}, str(st))
            pg.close()

        if "landing" in STEPS:
            for year, how in [(1999, "full"), (2005, "skip"), (2010, "skip"), (2016, "skip"), (2023, "skip"), (2021, "skip"), (2008, "skip")]:
                pg = page_with_console()
                image = YEARS[str(year)]["meme"]["image"]
                downloads = []
                pg.on("request", lambda r, u=image: downloads.append(r.url) if r.url == u else None)
                pg.goto(f"{base}/src/travel/travel.html#from=2026&to={year}&sound=0")
                t0 = time.time()
                if how == "skip":
                    pg.wait_for_timeout(900)
                    pg.keyboard.press("Space")
                pg.wait_for_function("() => document.documentElement.dataset.phase === 'done'", timeout=9000)
                took = time.time() - t0
                pg.wait_for_function(WAIT_CARD, timeout=20000)
                pg.wait_for_timeout(1700)  # scanlines fade out
                info = pg.evaluate(CARD_JS)
                pg.screenshot(path=str(SHOTS / f"landing_{year}.png"))
                bad = card_problems(info, year)
                ok = info["img"] != "broken" and info["img"][0] > 0 and info["song"] and not bad and not info["overflow"]
                # The meme box may show last year's meme (its picture then is not this year's image).
                own = info["memeTitle"] == YEARS[str(year)]["meme"]["title"]
                log(f"landing {year}", ok and info["fill"] and (len(downloads) == 1 or not own),
                    f"{how} in {took:.1f}s, era={info['era']}, {info['date']} meme={info['memeTitle']!r} ({info['memeBox']}), img={info['img']}, "
                    f"downloads={len(downloads)}, song={info['song']}, facts={len(info['facts'])} ({info['factsBox']}), "
                    f"searches={len(info['searches'])}, sites={len(info['sites'])}, overflow={info['overflow']}" + (f", PROBLEMS: {bad}" if bad else ""))
                if year == 2005:
                    print("   links:", info["today"][:1], info["siteHrefs"][:1], info["searchHrefs"][:1])
                pg.close()

        if "fit" in STEPS:
            # Laptop screens: the whole card without scrolling, and tidy at 1000 px wide.
            seen = []
            for (w, hgt) in [(1366, 768), (1280, 800), (1000, 768)]:
                for year in (1999, 2005, 2010, 2017, 2023):
                    pg = page_with_console()
                    pg.set_viewport_size({"width": w, "height": hgt})
                    pg.goto(f"{base}/src/travel/travel.html#from=2026&to={year}&sound=0&t=f{year}{w}")
                    pg.wait_for_timeout(600)
                    pg.keyboard.press("Space")
                    pg.wait_for_function(WAIT_CARD, timeout=20000)
                    pg.wait_for_timeout(1700)
                    m = pg.evaluate("""() => { const d = document.querySelector('.desktop'), cs = getComputedStyle(d);
                        return {overflow: d.scrollHeight > d.clientHeight, hscroll: document.documentElement.scrollWidth > innerWidth,
                                spare: Math.round(d.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - document.querySelector('.win').offsetHeight)}; }""")
                    pg.screenshot(path=str(SHOTS / f"fit_{year}_{w}x{hgt}.png"))
                    seen.append((m["spare"], year, f"{w}x{hgt}", m))
                    pg.close()
            bad = [x for x in seen if x[3]["overflow"] or x[3]["hscroll"]]
            tight = min(seen, key=lambda x: x[0])
            log("fit: 1366x768, 1280x800, 1000x768", not bad,
                f"{len(seen)} cards, least spare height {tight[0]} px ({tight[1]} at {tight[2]})" + (f", OVERFLOW: {[(x[1], x[2]) for x in bad]}" if bad else ""))

        if "dates" in STEPS:
            # A fixed clock (2026, local time): the card's day moves into the travelled-to year.
            cases = [("2026-01-03T12:00:00", 2016, {"memeBox": "Still everywhere: meme of 2015", "factsBox": "Looking back at 2015",
                                                    "gadget": ["Everyone still wants", "Hoverboard (self-balancing scooter)", "The must-have of 2015"]}),
                     ("2026-01-03T12:00:00", 2000, {"memeBox": "Still everywhere: meme of 1999", "factsBox": "Also in 2000"}),
                     ("2026-11-11T12:00:00", 2004, {"memeBox": "Still everywhere: meme of 2003", "factsBox": "Also in 2004"}),
                     ("2026-11-11T12:00:00", 2020, {"memeBox": "Meme of 2020", "gadget": ["Everyone still wants", "AirPods Pro", "The must-have of 2019"]}),
                     ("2026-11-11T12:00:00", 2022, {"memeBox": "Meme of 2022", "factsBox": "Also in 2022"})]
            for when, year, expect in cases:
                pg = page_with_console()
                pg.clock.set_fixed_time(when)
                pg.goto(f"{base}/src/travel/travel.html#from=2026&to={year}&sound=0&t=d{year}")
                pg.wait_for_timeout(600)
                pg.keyboard.press("Space")
                pg.wait_for_function(WAIT_CARD, timeout=20000)
                pg.wait_for_timeout(1700)
                info = pg.evaluate(CARD_JS)
                pg.screenshot(path=str(SHOTS / f"dates_{year}_{when[5:10]}.png"))
                got = {k: info[k] for k in expect}
                bad = card_problems(info, year) + [k for k in expect if got[k] != expect[k]]
                if year == 2022 and any("ChatGPT" in f or "World Cup" in f for f in info["facts"]):
                    bad.append("2022 shows facts from after November 11")
                log(f"dates: {year} on {when[5:10]}", not bad, f"{info['date']} {got} facts={info['facts']}" + (f", PROBLEMS: {bad}" if bad else ""))
                pg.close()

        if "motion" in STEPS:
            # Windows "Show animations" off: no tunnel, no shake, a soft fade instead of the CRT.
            pg = page_with_console()
            pg.emulate_media(reduced_motion="reduce")
            pg.goto(f"{base}/src/travel/travel.html#from=2026&to=2005&sound=0")
            pg.wait_for_timeout(1500)
            st = pg.evaluate("({motion: document.documentElement.dataset.motion, canvas: getComputedStyle(document.getElementById('warp')).display})")
            pg.wait_for_function("() => document.documentElement.dataset.phase === 'done'", timeout=9000)
            log("reduced motion", st == {"motion": "reduced", "canvas": "none"}, str(st))
            pg.close()
            # A mouse click skips too.
            pg = page_with_console()
            pg.goto(f"{base}/src/travel/travel.html#from=2026&to=2012&sound=0")
            pg.wait_for_timeout(800)
            t0 = time.time()
            pg.mouse.click(640, 450)
            pg.wait_for_function("() => document.documentElement.dataset.phase === 'done'", timeout=3000)
            log("click skips", time.time() - t0 < 1.5, f"card after {time.time() - t0:.2f}s")
            pg.close()

        if "flow" in STEPS:
            set_state(enabled=False, year=1999, google=True, youtube=True, strict=True, eraLook=True)
            pg = page_with_console()
            pg.goto(f"{base}/src/ui/popup.html")
            pg.wait_for_timeout(600)
            pg.evaluate("() => { window.close = () => { window.__closed = true; }; }")
            pg.click("#travel")
            pg.wait_for_url(f"**/src/travel/travel.html#from={time.localtime().tm_year}&to=1999&t=*", timeout=8000)
            st = pg.evaluate("chrome.storage.local.get(['travel:last', 'enabled', 'year'])")
            log("flow: popup -> travel:go", st == {"travel:last": 1999, "enabled": True, "year": 1999}, f"url={pg.url.split('/', 3)[3]} storage={st}")
            pg.wait_for_function(WAIT_CARD, timeout=20000)

            # "Play the hits" starts the real player; the seeded cooldown stops it before any YouTube search,
            # and the card's line follows the player until it gives up.
            pg.click("text=Play the hits of 1999")
            pg.wait_for_function("() => !/^Starting the hits of/.test(document.querySelector('.status').textContent)", timeout=8000)
            first = pg.text_content(".status")
            try:
                pg.wait_for_function("t => document.querySelector('.status').textContent === t", arg=SLOW, timeout=20000)
            except Exception:  # noqa: BLE001 - the line is reported below
                pass
            status = pg.text_content(".status")
            st = pg.evaluate("chrome.storage.local.get(['mus:rate'])")
            log("flow: play the hits", status == SLOW and not st.get("mus:rate") and "Now playing" not in (first or ""),
                f"status line {first!r} -> {status!r}; YouTube search slots taken: {len(st.get('mus:rate') or [])}")

            # "People are searching": the same as "Search like it's 1999", with the query.
            first_q = pg.text_content(".searches a")
            hits_before = len(google_hits)
            pg.click(".searches a >> nth=0")
            pg.wait_for_url("https://www.google.com/search?**", timeout=8000)
            pg.wait_for_timeout(800)
            st = ext_eval("() => chrome.storage.local.get(['enabled', 'google', 'year'])")
            want = "https://www.google.com/search?q=" + first_q.replace(" ", "+")
            log("flow: people are searching", google_hits[hits_before:hits_before + 1] == [want] and st == {"enabled": True, "google": True, "year": 1999},
                f"opened {google_hits[hits_before:]} state={st}")
            pg.go_back()
            pg.wait_for_function(WAIT_CARD, timeout=8000)

            pg.click("text=Search like it's 1999")
            pg.wait_for_url("https://www.google.com/", timeout=8000)
            log("flow: search like it's 1999", pg.url == "https://www.google.com/", f"url={pg.url}, stub requests={len(google_hits)}")
            pg.go_back()
            pg.wait_for_timeout(500)
            info = pg.evaluate("""() => ({phase: document.documentElement.dataset.phase, landing: !document.getElementById('landing').hidden,
                title: document.title, load: (performance.getEntriesByType('navigation')[0] || {}).type})""")
            log("flow: back shows the card", info["phase"] == "done" and info["landing"], str(info))
            pg2 = ctx.new_page()
            pg2.goto(f"{base}/src/ui/popup.html")
            st = pg2.evaluate("chrome.storage.local.get(['enabled', 'google', 'year'])")
            log("flow: state after search", st == {"enabled": True, "google": True, "year": 1999}, str(st))
            pg2.close()
            pg.close()

            # A card later than the dial (time machine ON in 1999, strict): its links first set the dial to the
            # card's year, else the Wayback guard would turn the 2005 page back into 1999.
            set_state(enabled=True, year=1999, google=True, youtube=True, strict=True, eraLook=True)
            pg = page_with_console()
            pg.goto(f"{base}/src/travel/travel.html#from=2026&to=2005&sound=0&t=fav")
            pg.wait_for_timeout(600)
            pg.keyboard.press("Space")
            pg.wait_for_function(WAIT_CARD, timeout=20000)
            href = pg.evaluate("document.querySelector('.sites a').href")
            with ctx.expect_page(timeout=8000) as opened:
                pg.click(".sites a >> nth=0")
            tab = opened.value
            tab.wait_for_load_state("domcontentloaded")
            url = tab.url
            st = pg.evaluate("chrome.storage.local.get(['enabled', 'year'])")
            tab.close()
            log("flow: web favorite from a later card", url == href and "#y=2005&d=2005" in url and st == {"enabled": True, "year": 2005},
                f"opened {url.split('/', 3)[3]} storage={st}")
            pg.close()

        if "images" in STEPS:
            pg = ctx.new_page()
            pg.goto(f"{base}/src/travel/travel.html#from=2026&to=2010&sound=0")
            bad = []
            for y, e in YEARS.items():
                r = pg.evaluate("""url => new Promise(resolve => {
                    const img = new Image();
                    img.referrerPolicy = 'no-referrer';
                    const t = setTimeout(() => resolve({ok: false, why: 'timeout'}), 20000);
                    img.onload = () => { clearTimeout(t); resolve({ok: img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight}); };
                    img.onerror = () => { clearTimeout(t); resolve({ok: false, why: 'error'}); };
                    img.src = url;
                })""", e["meme"]["image"])
                print(f"   {y} {'ok ' if r['ok'] else 'BAD'} {r} {e['meme']['image'][-70:]}", flush=True)
                if not r["ok"]:
                    bad.append(y)
                time.sleep(2.5)
            log("images", not bad, f"{len(YEARS) - len(bad)}/{len(YEARS)} load in the browser" + (f", failed: {bad}" if bad else ""))
            pg.close()

        log("no Google traffic", all(u.startswith("https://www.google.com/") for u in google_hits), f"stubbed requests: {google_hits}")
        log("page errors", not errors, "; ".join(errors[:8]) or "none")
        ctx.close()
    (SHOTS / "results.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    failed = [r["step"] for r in results if not r["ok"]]
    print("screenshots:", SHOTS)
    print(f"{len(results) - len(failed)}/{len(results)} passed" + (f"; failed: {failed}" if failed else ""))


if __name__ == "__main__":
    main()
