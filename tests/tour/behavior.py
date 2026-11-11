"""Behaviour checks of the tour in a throwaway Chromium profile (no Google traffic at all): the first
screen keeps the focus out of the replica, the glide between steps (smooth, arced, on time), moving on
quickly after Next, keyboard control (Escape at any moment), the picker paths, window resizing, clicking
the guide, and sounds on without console errors. Builds test-build-tour/ like shots.py.

Usage: .venv/Scripts/python.exe tests/tour/behavior.py
"""
import shutil
import sys
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shots import BUILD, ROOT, build  # noqa: E402

PROFILE = ROOT / "test-profile-tour"
SHOTS = ROOT / "test-shots" / "tour"
problems = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        problems.append(what)


AGENT_POS = """() => { const m = /translate3d\\((-?[\\d.]+)px, (-?[\\d.]+)px/.exec(document.querySelector('.yy-agent')?.style.transform || '');
    return m ? [Number(m[1]), Number(m[2])] : null; }"""
RECTS = """() => { const r = (el) => { if (!el || el.hidden) return null; const b = el.getBoundingClientRect(); return {x: b.left, y: b.top, w: b.width, h: b.height}; };
    const f = document.getElementById('replica').getBoundingClientRect();
    const win = document.getElementById('replica').contentDocument.querySelector('.window').getBoundingClientRect();
    return { balloon: r(document.querySelector('.yy-balloon')), agent: r(document.querySelector('.yy-agent')),
             window: {x: f.left + win.left, y: f.top + win.top, w: win.width, h: win.height},
             vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth,
             title: document.getElementById('tour-title')?.textContent || null }; }"""


def overlap(a, b):
    w = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    h = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return max(0, w) * max(0, h)


FOCUS = """() => { const d = document.getElementById('replica').contentDocument;
    return { top: document.activeElement?.id || document.activeElement?.tagName,
             inner: d.activeElement?.id || d.activeElement?.tagName }; }"""
# popup.js has drawn itself (and focused its slider, which the tour must undo or prevent).
REPLICA_READY = """() => { const d = document.getElementById('replica').contentDocument;
    return Boolean(d?.querySelector('.window') && !d.documentElement.classList.contains('loading')); }"""
SETTINGS = "chrome.storage.local.get(['enabled', 'year', 'google', 'youtube', 'strict', 'eraLook'])"
# Logs the guide's position every animation frame; GLIDE_START: ms from window.__click to the first move.
MOTION_LOG = """() => { window.__moves = []; const tick = () => {
    window.__moves.push([performance.now(), document.querySelector('#stage > .yy-agent')?.style.transform || '']);
    requestAnimationFrame(tick); }; requestAnimationFrame(tick); }"""
GLIDE_START = """() => { const c = window.__click; const log = window.__moves.filter((e) => e[0] >= c);
    const move = log.find((e) => e[1] !== log[0][1]); return move ? Math.round(move[0] - c) : null; }"""


def shows(pg, selector, timeout):
    """Waits for selector; False instead of an exception, so one failure does not skip later checks."""
    try:
        pg.wait_for_selector(selector, timeout=timeout)
        return True
    except PlaywrightTimeout:
        return False


def picker_focus(pg, label):
    """The picker as it first appears: focus on Start, none inside the replica (the real popup: keys
    there changed the year, and Tab + Space could switch the time machine on), Escape means no tour."""
    pg.wait_for_selector("#picker:not([hidden])")
    pg.wait_for_function(REPLICA_READY, timeout=8000)
    pg.wait_for_timeout(400)
    focus = pg.evaluate(FOCUS)
    check(focus == {"top": "start", "inner": "BODY"}, f"{label}: focus on Start, none in the replica ({focus})")
    before = pg.evaluate(SETTINGS)
    for key in ("ArrowRight", "ArrowRight", "End", "ArrowUp"):
        pg.keyboard.press(key)
    walk = []
    for _ in range(10):
        pg.keyboard.press("Tab")
        walk.append(pg.evaluate(FOCUS)["top"])
    check("replica" not in walk, f"{label}: Tab stays out of the replica ({walk})")
    refused = pg.evaluate("""() => { const d = document.getElementById('replica').contentDocument;
        d.getElementById('opt-enabled').focus(); d.getElementById('year').focus(); return d.activeElement?.tagName; }""")
    check(refused == "BODY", f"{label}: the replica refuses focus from script too ({refused})")
    pg.wait_for_timeout(500)  # the popup saves a year 300 ms after the last change
    after = pg.evaluate(SETTINGS)
    check(after == before, f"{label}: keys never touch the real settings ({before} -> {after})")
    pg.keyboard.press("Escape")
    check(shows(pg, "#done:not([hidden])", 8000) and "No problem" in pg.inner_text("#done-text"),
          f"{label}: Escape on the picker means no tour")


def main():
    build()
    SHOTS.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(PROFILE, ignore_errors=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), channel="chromium", headless=True,
            args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={BUILD}", f"--load-extension={BUILD}", "--lang=en-US",
                  "--autoplay-policy=no-user-gesture-required"],
            locale="en-US", viewport={"width": 1280, "height": 800})
        ctx.route("https://www.google.com/**", lambda route: route.abort())
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext = sw.url.split("/")[2]
        url = f"chrome-extension://{ext}/src/tour/welcome.html"
        errors = []

        def watch(pg):
            pg.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") else None)
            pg.on("pageerror", lambda e: errors.append(str(e)))

        # The first screen exactly as the install opened it.
        first = None
        for _ in range(50):
            first = next((pg for pg in ctx.pages if pg.url.startswith(url)), None)
            if first:
                break
            ctx.pages[0].wait_for_timeout(200)
        check(first is not None, "the install opened the tour")
        if first:
            watch(first)
            first.bring_to_front()
            picker_focus(first, "first screen")
            first.close()
            sw.evaluate("chrome.storage.local.remove('tour:done')")  # the skip check below sets it again

        page = ctx.new_page()
        watch(page)

        # Sounds on: the code path that plays the characters' MP3s.
        page.goto(f"{url}#agent=clippy&step=2&sound=1")
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=15000)
        check(page.evaluate("document.querySelector('#mute').getAttribute('aria-pressed')") == "true", "sound on from #sound=1")

        # The glide: sample the guide's position after Next until the balloon is back.
        page.wait_for_timeout(1200)
        start = page.evaluate(AGENT_POS)
        page.click("#tour-next")
        t0 = time.monotonic()
        samples = []
        while time.monotonic() - t0 < 4:
            samples.append(page.evaluate(AGENT_POS))
            if page.evaluate("!document.querySelector('.yy-balloon').hidden"):
                break
            page.wait_for_timeout(30)
        took = time.monotonic() - t0
        end = page.evaluate(AGENT_POS)
        distinct = len({tuple(s) for s in samples if s})
        print(f"     glide {start} -> {end}, {distinct} distinct positions, balloon back after {took:.2f}s")
        check(distinct >= 8, "the guide glides through many positions (no jump)")
        check(took < 3.0, "next step is on screen within 3 s")
        line_y = lambda x: start[1] + (end[1] - start[1]) * ((x - start[0]) / (end[0] - start[0]))
        lifted = max(line_y(s[0]) - s[1] for s in samples if s and min(start[0], end[0]) < s[0] < max(start[0], end[0]))
        check(lifted > 8, f"Clippy floats over in an arc (lifted {lifted:.1f}px above the straight line)")

        # Keyboard: right, left, escape.
        page.wait_for_timeout(600)
        title = lambda: page.evaluate("document.getElementById('tour-title')?.textContent || ''")
        page.keyboard.press("ArrowRight")
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=8000)
        check("4 of 7" in title(), f"ArrowRight goes to step 4 ({title()})")
        page.keyboard.press("ArrowLeft")
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=8000)
        check("3 of 7" in title(), f"ArrowLeft goes back to step 3 ({title()})")

        # The replica is the real popup: it must never take focus, keys or clicks (that would change settings).
        settings = lambda: page.evaluate("chrome.storage.local.get(['enabled', 'year', 'google', 'strict'])")
        before_settings = settings()
        focus = page.evaluate("""() => ({ top: document.activeElement?.id || document.activeElement?.tagName,
            inner: document.getElementById('replica').contentDocument.activeElement?.tagName })""")
        check(focus["top"] != "replica", f"focus stays out of the replica ({focus})")
        on_box = page.evaluate("""() => { const f = document.getElementById('replica').getBoundingClientRect();
            const b = document.getElementById('replica').contentDocument.querySelector('label[for=opt-enabled]').getBoundingClientRect();
            return [f.left + b.left + 6, f.top + b.top + b.height / 2]; }""")
        page.mouse.click(on_box[0], on_box[1])
        page.mouse.click(on_box[0] + 40, on_box[1] - 120)  # somewhere on the LCD / slider area
        page.keyboard.press("ArrowUp")
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(500)
        check(settings() == before_settings, f"clicks and keys never touch the real settings ({before_settings} -> {settings()})")
        check(page.evaluate("document.getElementById('replica').contentDocument.getElementById('opt-enabled').checked") is False,
              "the replica's checkbox did not toggle")

        # Clicking the guide plays a trick (the sprite changes frames).
        page.wait_for_timeout(2500)
        before = page.evaluate("document.querySelector('.yy-agent-layer').style.backgroundPosition")
        page.click(".yy-agent")
        page.wait_for_timeout(700)
        after = page.evaluate("document.querySelector('.yy-agent-layer').style.backgroundPosition")
        check(before != after, f"a click on Clippy plays an animation ({before} -> {after})")

        page.keyboard.press("Escape")
        page.wait_for_selector("#done:not([hidden])", timeout=12000)
        check("No problem" in page.inner_text("#done-text"), "Escape skips the tour and says how to get it back")
        check(page.evaluate("chrome.storage.local.get('tour:done')").get("tour:done") is True, "skipping sets tour:done")
        page.screenshot(path=str(SHOTS / "behavior_skipped.png"))

        # "Show me again" -> picker -> Rover.
        page.click("#done-again")
        page.wait_for_selector("#picker:not([hidden])")
        page.wait_for_timeout(1500)
        check(page.evaluate("document.querySelectorAll('#picker .yy-agent:not([hidden])').length") == 2, "the picker shows both guides alive")
        page.click("#choice-rover .field-row label")
        check(page.evaluate("document.getElementById('choice-rover').classList.contains('selected')"), "picking Rover marks his tile")
        page.click("#start")
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=15000)
        check("Rover" in title(), f"the tour restarts with Rover ({title()})")
        check(page.evaluate("document.querySelectorAll('#picker .yy-agent').length") == 0, "picker previews are cleaned up")

        # Resizing: the balloon stays on screen and off the window when there is room.
        for (w, h, name) in [(1000, 700, "resize_1000x700"), (760, 640, "resize_760x640")]:
            page.set_viewport_size({"width": w, "height": h})
            page.wait_for_timeout(700)
            r = page.evaluate(RECTS)
            b = r["balloon"]
            inside = b and b["x"] >= 0 and b["y"] >= 0 and b["x"] + b["w"] <= max(r["vw"], 640) and b["y"] + b["h"] <= max(r["vh"], 600 + 28)
            check(bool(inside), f"{w}x{h}: balloon inside the page {b}")
            if w >= 1000:
                check(overlap(b, r["window"]) == 0, f"{w}x{h}: balloon does not cover the Yesteryear window")
            check(overlap(r["agent"], r["window"]) < 0.5 * r["agent"]["w"] * r["agent"]["h"], f"{w}x{h}: guide mostly beside the window")
            page.screenshot(path=str(SHOTS / f"{name}.png"))
        page.set_viewport_size({"width": 1280, "height": 800})

        # The music step highlights the mini player and mentions it. The popup has the real one since
        # v0.2; an older popup gets the player module's fixture (read only, from tests/player).
        page.goto("about:blank")
        page.goto(f"{url}#agent=rover&step=5&sound=0")
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=15000)
        has_mini = page.evaluate("Boolean(document.getElementById('replica').contentDocument.getElementById('mini-player'))")
        fixture = ROOT / "tests" / "player" / "fixtures" / "popup_mini_player.html"
        if not has_mini and fixture.exists():
            page.evaluate("""(html) => { const doc = document.getElementById('replica').contentDocument;
                const box = doc.createElement('div'); box.innerHTML = html;
                (doc.querySelector('.actions') || doc.querySelector('fieldset.settings')).after(...box.children); }""",
                          fixture.read_text(encoding="utf-8"))
            has_mini = True
            print("     mini player: fixture inserted into an older popup")
        if has_mini:
            page.wait_for_timeout(600)
            page.keyboard.press("ArrowRight")
            page.wait_for_selector(".yy-balloon:not([hidden])", timeout=8000)
            page.wait_for_timeout(1500)
            hint = page.evaluate("document.querySelector('.yy-balloon .hint')?.textContent || ''")
            check("mini player" in hint, f"music step mentions the mini player ({hint})")
            covered = page.evaluate("""() => { const f = document.getElementById('replica').getBoundingClientRect();
                const m = document.getElementById('replica').contentDocument.getElementById('mini-player').getBoundingClientRect();
                const a = document.querySelector('.yy-ants').getBoundingClientRect();
                return a.left <= f.left + m.left && a.top <= f.top + m.top && a.right >= f.left + m.right && a.bottom >= f.top + m.bottom; }""")
            check(covered, "the music highlight covers the mini player")
            page.screenshot(path=str(SHOTS / "rover_6_with_mini_player.png"))
        else:
            print("skip mini-player check: no mini player and no fixture")

        # Next: the guide winds his animation down briskly and moves on (EXIT_MS = 600 in tour_core.js,
        # was 900 plus a cut to the rest pose), on every step, also a second into a long animation.
        page.goto("about:blank")
        page.goto(f"{url}#agent=rover&step=1&sound=0")
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=15000)
        page.evaluate(MOTION_LOG)
        starts = []
        for _ in range(6):
            page.wait_for_timeout(1000)
            page.evaluate("() => { window.__click = performance.now(); document.getElementById('tour-next').click(); }")
            page.wait_for_function("() => !document.querySelector('.yy-balloon').hidden && performance.now() > window.__click + 30",
                                   timeout=10000)
            starts.append(page.evaluate(GLIDE_START))
        check(all(s is not None and s <= 750 for s in starts), f"Rover moves on within 0.75 s of every Next ({starts} ms)")

        # Escape leaves at any moment the guide is out, also when no balloon (and no Skip) is on screen.
        page.goto("about:blank")
        page.goto(f"{url}#agent=clippy&step=1&sound=0")
        page.wait_for_selector("#stage > .yy-agent:not([hidden])", timeout=15000)
        page.wait_for_timeout(300)
        entering = page.evaluate("!document.querySelector('.yy-balloon:not([hidden])')")
        page.keyboard.press("Escape")
        left = shows(page, "#done:not([hidden])", 12000) and "No problem" in page.inner_text("#done-text")
        check(entering and left, f"Escape during the entrance skips the tour (entering: {entering}, done shown: {left})")
        page.wait_for_timeout(1500)
        check(page.evaluate("!document.querySelector('.yy-balloon:not([hidden])')"), "no step shows up after that")

        page.goto("about:blank")
        page.goto(f"{url}#agent=clippy&step=1&sound=0")
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=15000)
        page.wait_for_timeout(800)
        page.click("#tour-next")
        page.wait_for_timeout(150)
        moving = page.evaluate("document.querySelector('.yy-balloon').hidden")
        page.keyboard.press("Escape")
        left = shows(page, "#done:not([hidden])", 12000) and "No problem" in page.inner_text("#done-text")
        check(moving and left, f"Escape between two steps skips the tour (moving: {moving}, done shown: {left})")
        page.wait_for_timeout(1500)
        check(page.evaluate("!document.querySelector('.yy-balloon:not([hidden])')"), "step 2 never shows up")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        check(page.evaluate("!document.getElementById('done').hidden"), "Escape on the end message changes nothing")

        # "No thanks" in the picker.
        page.goto(url)
        page.wait_for_selector("#picker:not([hidden])")
        page.click("#no-tour")
        page.wait_for_selector("#done:not([hidden])", timeout=8000)
        check("No problem" in page.inner_text("#done-text"), "No thanks shows the skipped message")

        real = [e for e in errors if "favicon" not in e]
        check(not real, f"no console errors or warnings ({real[:3]})")
        ctx.close()
    print("problems:", problems or "none")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
