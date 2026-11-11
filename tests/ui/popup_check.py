"""Live check of the toolbar popup (src/ui/popup.html) in a throwaway Chromium profile.

    .venv/Scripts/python.exe tests/ui/popup_check.py

Loads a COPY of extension/ (test-build-ui, without Chrome's generated _metadata) in profile test-profile-ui.
Nothing leaves the machine: every request that is not chrome-extension:// is aborted (no Google, no YouTube,
no archive.org). The popup opens as a tab of its real width (312 px = 300 px body + 2 x 6 px padding).

  1. height: the tallest normal state (the YouTube note under 2005) stays <= 480 CSS px, which is Chrome's
     600 DIP popup cap at 125 % page zoom; no horizontal overflow; LCD digits and mini player inside.
  2. placeholders: the frame that reveals the popup names no year, or the stored one (never "Music of 2010").
  3. departure: "Travel to YEAR >>" departs from where Google and YouTube are (the present while OFF, the
     year saved when the popup opened while ON), never from the last trip (travel:last).

Screenshots: test-shots/ui/popup_<year>.png. Exit code 1 when a check fails.
"""
import datetime
import shutil
import sys
from pathlib import Path
from urllib.parse import parse_qs

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
BUILD = ROOT / "test-build-ui"
PROFILE = ROOT / "test-profile-ui"
SHOTS = ROOT / "test-shots" / "ui"
POPUP_WIDTH = 312
HEIGHT_CAP_125 = 480  # 600 DIP / 1.25
PRESENT = datetime.date.today().year
sys.stdout.reconfigure(encoding="utf-8")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


# Records what the first visible frame shows: the moment popup.js drops the "loading" class. Runs before the
# parser has made <html>, so it watches the whole document.
REVEAL_INIT = """(() => {
  if (!location.pathname.endsWith('/src/ui/popup.html')) return;
  new MutationObserver((list, obs) => {
    const root = document.documentElement;
    if (!list.some((m) => m.target === root) || root.classList.contains('loading')) return;
    const legend = document.getElementById('mp-legend');
    window.__yyReveal = { legend: legend && legend.textContent, lcd: document.getElementById('lcd')?.getAttribute('aria-label') };
    obs.disconnect();
  }).observe(document, { attributes: true, attributeFilter: ['class'], subtree: true });
})();"""

MEASURE = """() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: Math.round(b.height) }; };
  const digits = [...document.querySelectorAll('.digit')].map((d) => d.getBoundingClientRect());
  return {
    body: Math.round(document.body.getBoundingClientRect().height),
    docW: document.documentElement.scrollWidth,
    lcd: r('#lcd'), win: r('.window'), mini: r('#mini-player'),
    digitsTop: Math.min(...digits.map((d) => d.top)), digitsBottom: Math.max(...digits.map((d) => d.bottom)),
    note: document.getElementById('note').hidden ? '' : document.getElementById('note').textContent,
    status: document.getElementById('status').textContent
  };
}"""


def build():
    shutil.rmtree(BUILD, ignore_errors=True)
    shutil.copytree(EXT, BUILD, ignore=shutil.ignore_patterns("_metadata"))


def open_popup(ctx, ext, state):
    """A popup tab whose storage holds exactly `state` (plus defaults), drawn and with the mini player answered."""
    page = ctx.new_page()
    page.goto(f"chrome-extension://{ext}/src/ui/popup.html")
    page.evaluate("s => chrome.storage.local.clear().then(() => chrome.storage.local.set(s))", state)
    page.reload()
    page.wait_for_function("() => !document.documentElement.classList.contains('loading')")
    page.wait_for_function("y => document.getElementById('mp-legend').textContent === 'Music of ' + y",
                           arg=state.get("year", 2010), timeout=10000)
    page.wait_for_timeout(250)
    return page


def check_layout(ctx, ext):
    SHOTS.mkdir(parents=True, exist_ok=True)
    for state, label in (({"year": 1999, "youtube": True, "enabled": True}, "1999, ON, YouTube note"),
                         ({"year": 2010, "youtube": True, "enabled": False}, "2010, OFF, no note")):
        page = open_popup(ctx, ext, state)
        m = page.evaluate(MEASURE)
        page.locator("body").screenshot(path=str(SHOTS / f"popup_{state['year']}.png"))
        check(f"height {label}: {m['body']} px <= {HEIGHT_CAP_125} (fits 600 DIP at 125 % zoom)", m["body"] <= HEIGHT_CAP_125,
              f"note={m['note']!r}")
        check(f"no horizontal overflow {label}", m["docW"] <= POPUP_WIDTH, f"scrollWidth {m['docW']}")
        check(f"LCD digits inside the LCD {label}", m["lcd"]["top"] <= m["digitsTop"] and m["digitsBottom"] <= m["lcd"]["bottom"],
              f"lcd {m['lcd']['top']:.0f}-{m['lcd']['bottom']:.0f}, digits {m['digitsTop']:.0f}-{m['digitsBottom']:.0f}")
        check(f"mini player inside the window {label}", m["mini"]["right"] <= m["win"]["right"] and m["mini"]["bottom"] <= m["win"]["bottom"])
        reveal = page.evaluate("window.__yyReveal || null")
        ok_legends = ("Music", f"Music of {state['year']}")
        check(f"first frame names no wrong year {label}", reveal and reveal["legend"] in ok_legends, f"reveal={reveal}")
        page.close()


def trip(ctx, ext, state, act):
    """Opens the popup with `state`, runs `act(page)`, clicks Travel; returns (from, to) of the trip page."""
    page = open_popup(ctx, ext, state)
    page.evaluate("() => { window.close = () => {}; }")  # a real popup closes itself; this tab must stay
    act(page)
    page.click("#travel")
    page.wait_for_url("**/src/travel/travel.html#*", timeout=10000)
    q = parse_qs(page.url.split("#", 1)[1])
    stored = page.evaluate("() => chrome.storage.local.get(['enabled', 'year', 'travel:last'])")
    page.close()
    return int(q["from"][0]), int(q["to"][0]), stored


def check_departure(ctx, ext):
    def nothing(_page):
        pass

    def quick(year):
        def act(page):
            page.locator("#quick button", has_text=str(year)).click()
            page.wait_for_function("y => document.getElementById('travel').textContent === `Travel to ${y} >>`", arg=year)
        return act

    def switch_off_then_quick(year):
        def act(page):
            page.click("label[for=opt-enabled]")  # 98.css draws the box on the label; the input itself is hidden
            page.wait_for_function("() => !document.getElementById('opt-enabled').checked")
            quick(year)(page)
        return act

    cases = [
        ("OFF after a trip to 1999, Travel to 2005", {"travel:last": 1999, "enabled": False, "year": 2005}, nothing, (PRESENT, 2005)),
        ("ON in 2015 after a trip to 1999, Travel to 2015 (same year: from the present)",
         {"travel:last": 1999, "enabled": True, "year": 2015}, nothing, (PRESENT, 2015)),
        ("ON in 1999, quick year 2015, Travel", {"travel:last": 2010, "enabled": True, "year": 1999}, quick(2015), (1999, 2015)),
        ("ON in 1999, switched OFF here, quick year 2010, Travel", {"travel:last": 1999, "enabled": True, "year": 1999},
         switch_off_then_quick(2010), (PRESENT, 2010)),
    ]
    for label, state, act, want in cases:
        got_from, got_to, stored = trip(ctx, ext, state, act)
        check(f"departure: {label} -> from {want[0]} to {want[1]}", (got_from, got_to) == want,
              f"trip from {got_from} to {got_to}; stored {stored}")
        check(f"arrival saved: {label}", stored.get("enabled") is True and stored.get("year") == want[1], f"stored {stored}")


def main():
    build()
    shutil.rmtree(PROFILE, ignore_errors=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), channel="chromium", headless=True,
            args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={BUILD}", f"--load-extension={BUILD}", "--lang=en-US"],
            locale="en-US", viewport={"width": POPUP_WIDTH, "height": 900})
        ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith("chrome-extension://") else r.abort())
        ctx.add_init_script(REVEAL_INIT)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext = sw.url.split("/")[2]
        # The tour opens itself on install; it is not what this check looks at.
        ctx.pages[0].wait_for_timeout(1500)
        for pg in ctx.pages:
            if "/src/tour/" in pg.url:
                pg.close()
        check_layout(ctx, ext)
        check_departure(ctx, ext)
        ctx.close()
    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed" + (f"; FAILED: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
