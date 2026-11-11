"""Live check: the popup's mini player stays inside the 300 px popup, whatever the song line.

    .venv/Scripts/python.exe tests/player/popup_width.py [--ext DIR]

No network at all: every request outside chrome-extension:// is aborted (and a session rule blocks
http/https for the extension itself); nothing is played. Builds a copy of the extension
(tests/player/integration.py -> test-build-player-width, or a copy of DIR with --ext, e.g. an older
export to compare) and runs it in its own throwaway profile (test-profile-player-width).

Opens src/ui/popup.html at the popup's real width (body 300 px + 2 x 6 px padding = 312 px), sets each
year 1998-2025 in storage and checks:
  - the mini player's group box ends inside the window body; the time and "Show player" are visible;
  - the page gets no wider than 312 px (a real toolbar popup would grow past its frame, or clip);
  - a song line that does not fit scrolls (marquee); one that fits stands still.
Then the same for the longest status line (YouTube did not start the music...), sent as a state.
Background: Chrome gives a fieldset min-inline-size: min-content, so a long no-wrap line widened the
box instead of scrolling (12 of 28 years before miniplayer.css set min-inline-size: 0).
Screenshots: test-shots/player/width_<case>.png
"""
import json
import shutil
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from integration import build  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "test-build-player-width"
PROFILE = ROOT / "test-profile-player-width"
SHOTS = ROOT / "test-shots" / "player"
POPUP_W = 312
SHOT_YEARS = (2003, 2005, 2012)
results = []

MEASURE = """() => {
  const R = (s) => document.querySelector(s).getBoundingClientRect();
  const m = document.getElementById('mp-marquee'), t = document.getElementById('mp-text');
  const line = t.textContent.split('   ***   ')[0];
  const probe = t.cloneNode();
  probe.removeAttribute('id');
  probe.textContent = line;
  probe.style.cssText = 'position:absolute;visibility:hidden';
  m.append(probe);
  const lineW = probe.getBoundingClientRect().width;
  probe.remove();
  return {
    boxOver: R('#mini-player').right - R('.window-body').right,
    showOver: R('#mp-show').right - R('.window-body').right,
    timeOver: R('#mp-time').right - R('#mp-screen').right,
    pageW: document.scrollingElement.scrollWidth,
    minInline: getComputedStyle(document.getElementById('mini-player')).minInlineSize,
    scrolls: m.classList.contains('scroll'),
    fits: lineW <= m.clientWidth + 1,
    lineW: Math.round(lineW), marqueeW: m.clientWidth, line: line.slice(0, 80)
  };
}"""


def log(step, ok, info=""):
    results.append({"step": step, "ok": bool(ok), "info": info})
    print(("PASS " if ok else "FAIL ") + step + (": " + info if info else ""), flush=True)


def check(case, m):
    inside = m["boxOver"] <= 0.5 and m["showOver"] <= 0.5 and m["timeOver"] <= 0.5 and m["pageW"] <= POPUP_W
    log(f"{case}: mini player inside the popup", inside,
        f"box {m['boxOver']:+.0f} px, Show player {m['showOver']:+.0f} px, page {m['pageW']} px, "
        f"min-inline-size {m['minInline']}")
    log(f"{case}: {'stands still' if m['fits'] else 'scrolls'}", m["scrolls"] != m["fits"],
        f"line {m['lineW']} px in {m['marqueeW']} px, scroll={m['scrolls']}: '{m['line']}'")


def main():
    source = None
    if "--ext" in sys.argv:
        source = Path(sys.argv[sys.argv.index("--ext") + 1]).resolve()
    SHOTS.mkdir(parents=True, exist_ok=True)
    if source:
        shutil.rmtree(BUILD, ignore_errors=True)
        shutil.copytree(source, BUILD, ignore=shutil.ignore_patterns("_metadata"))
    else:
        build(BUILD)
    shutil.rmtree(PROFILE, ignore_errors=True)
    blocked, errors = [], []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), channel="chromium", headless=True,
            args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={BUILD}", f"--load-extension={BUILD}", "--lang=en-US"],
            locale="en-US", viewport={"width": POPUP_W, "height": 640})

        def route(r):
            if r.request.url.startswith("chrome-extension://"):
                r.continue_()
            else:
                blocked.append(r.request.url[:100])
                r.abort()
        ctx.route("**/*", route)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        base = f"chrome-extension://{sw.url.split('/')[2]}"

        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base}/src/ui/popup.html")
        page.evaluate("""() => chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [9002], addRules: [
            {id: 9002, priority: 100, action: {type: 'block'}, condition: {regexFilter: '^https?://'}}]})""")

        def show_year(year):
            page.evaluate("y => chrome.storage.local.set({ year: y })", year)
            page.reload()
            page.wait_for_function("y => document.getElementById('mp-legend').textContent === 'Music of ' + y",
                                   arg=year, timeout=8000)
            page.wait_for_function("() => /\\S/.test(document.getElementById('mp-text').textContent)"
                                   " && document.getElementById('mp-text').textContent !== 'Press Play'", timeout=8000)
            page.wait_for_timeout(250)  # the marquee decides on scrolling in the next animation frame

        for year in range(1998, 2026):
            show_year(year)
            check(str(year), page.evaluate(MEASURE))
            if year in SHOT_YEARS:
                page.screenshot(path=str(SHOTS / f"width_{year}.png"))

        # The longest line the music UIs show: a problem status. A page never receives its own
        # runtime messages, so a third page sends the state to the popup and to the side panel.
        show_year(2012)
        status = page.evaluate("u => import(u).then((m) => m.NO_START_TEXT || null)", f"{base}/src/player/music_state.js") \
            or "YouTube refuses to play right now. Open youtube.com once in this Chrome profile, then press Play."
        panel = ctx.new_page()
        panel.on("pageerror", lambda e: errors.append("panel: " + str(e)))
        panel.set_viewport_size({"width": 300, "height": 600})
        panel.goto(f"{base}/src/player/player.html")
        panel.wait_for_timeout(600)
        sender = ctx.new_page()
        sender.goto(f"{base}/src/ui/popup.html")
        sender.evaluate("s => chrome.runtime.sendMessage({type: 'music:changed', state: s, source: 'test'})",
                        {"playing": False, "year": 2012, "index": 0, "length": 100,
                         "track": {"artist": "Gotye", "title": "Somebody That I Used to Know", "rank": 1},
                         "at": int(time.time() * 1000) + 60000, "status": status, "problem": True})
        page.wait_for_function("s => document.getElementById('mp-text').textContent.startsWith(s)", arg=status,
                               timeout=5000)
        panel.wait_for_function("s => document.getElementById('status').textContent === s", arg=status, timeout=5000)
        page.wait_for_timeout(250)
        check("problem status", page.evaluate(MEASURE))
        page.screenshot(path=str(SHOTS / "width_problem_status.png"))
        over = panel.evaluate("document.documentElement.scrollWidth - innerWidth")
        log("side panel wraps the problem status at 300 px", over <= 0, f"overflow {over} px")
        panel.screenshot(path=str(SHOTS / "width_problem_status_panel.png"))
        sender.close()
        panel.close()

        log("no requests outside the extension", not blocked, "; ".join(blocked[:5]))
        log("no page errors", not errors, "; ".join(errors[:5]))
        ctx.close()
    (SHOTS / "width_results.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    failed = [r for r in results if not r["ok"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
