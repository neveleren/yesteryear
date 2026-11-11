"""Live smoke test of the unpacked extension in Playwright's Chromium (separate throwaway profile, no window).

Budgets (protect the home IP): at most 2 Google searches, a handful of archive.org and YouTube requests.
Usage: .venv/Scripts/python.exe tests/live/smoke.py [step ...]   steps: home search click yt yt2003 player popup
"""
import json
import shutil
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
PROFILE = ROOT / "test-profile"
SHOTS = ROOT / "test-shots"
SHOTS.mkdir(exist_ok=True)
STEPS = sys.argv[1:] or ["popup", "home", "search", "click", "yt", "yt2003", "player"]
results = []


def log(step, ok, info):
    results.append({"step": step, "ok": ok, "info": info})
    print(("PASS " if ok else "FAIL ") + step + ": " + info, flush=True)


def set_state(ctx, ext_id, **state):
    page = ctx.new_page()
    page.goto(f"chrome-extension://{ext_id}/src/ui/popup.html")
    page.evaluate("s => chrome.storage.local.set(s)", state)
    page.close()
    time.sleep(1.0)


def consent(page):
    # fresh EU profile: Google shows a consent page first
    if "consent." in page.url:
        for label in ["Reject all", "Alle ablehnen", "Отклонить все", "Accept all", "Alle akzeptieren"]:
            btn = page.get_by_role("button", name=label)
            if btn.count():
                btn.first.click()
                page.wait_for_load_state("domcontentloaded")
                break


def main():
    if PROFILE.exists():
        shutil.rmtree(PROFILE, ignore_errors=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), channel="chromium", headless=True,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--lang=en-US"],
            locale="en-US", viewport={"width": 1280, "height": 900})
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        print("extension id", ext_id)
        sw_errors = []
        page_errors = []
        ctx.on("weberror", lambda e: page_errors.append(str(e.error)))

        if "popup" in STEPS:
            pg = ctx.new_page()
            pg.goto(f"chrome-extension://{ext_id}/src/ui/popup.html")
            pg.wait_for_timeout(800)
            pg.screenshot(path=str(SHOTS / "popup.png"))
            log("popup", pg.locator(".window").count() > 0, "popup window rendered")
            pg.close()

        set_state(ctx, ext_id, enabled=True, year=2005, google=True, youtube=True, strict=True, eraLook=True)

        if "home" in STEPS:
            pg = ctx.new_page()
            pg.goto("https://www.google.com/?hl=en")
            consent(pg)
            pg.wait_for_timeout(2500)
            pg.screenshot(path=str(SHOTS / "google_home_2005.png"))
            root = pg.locator("#yy-root")
            log("home", root.count() == 1 and pg.locator("#yy-root .yy-q").count() == 1,
                f"url={pg.url} era={pg.evaluate('document.documentElement.dataset.yyEra')}")
            pg.close()

        set_state(ctx, ext_id, year=2010)
        if "search" in STEPS or "click" in STEPS:
            pg = ctx.new_page()
            pg.goto("https://www.google.com/search?q=music+trends+this+year&hl=en")
            consent(pg)
            pg.wait_for_load_state("domcontentloaded")
            pg.wait_for_timeout(3500)
            url = pg.url
            pg.screenshot(path=str(SHOTS / "google_search_2010.png"), full_page=True)
            if "/sorry/" in url:
                log("search", False, "Google captcha page (/sorry) - stop Google tests")
            else:
                items = pg.locator("#yy-root .yy-r")
                texts = pg.locator("#yy-root").inner_text() if pg.locator("#yy-root").count() else ""
                import re
                later = sorted({int(y) for y in re.findall(r"(?<!\d)(20[12]\d)(?!\d)", texts) if int(y) > 2010})
                ok = "cd_max%3A12%2F31%2F2010" in url or "cd_max:12/31/2010" in url
                log("search", ok and "2010" in url and items.count() > 0 and not later,
                    f"results={items.count()} later_years={later} url={url[:160]}")
                if "click" in STEPS and items.count():
                    first = pg.locator("#yy-root .yy-r a.yy-title").first
                    title = first.inner_text()
                    first.click()
                    final = None
                    for _ in range(40):
                        pg.wait_for_timeout(1000)
                        final = pg.url
                        if "web.archive.org/web/" in final or "notfound.html" in final:
                            break
                    pg.wait_for_timeout(2000)
                    pg.screenshot(path=str(SHOTS / "click_result.png"))
                    ok = False
                    if final and "web.archive.org/web/" in final:
                        ts = final.split("/web/")[1][:14]
                        ok = ts.isdigit() and ts <= "20101231235959" and "if_/" in final
                    elif final and "notfound.html" in final:
                        ok = True
                    log("click", ok, f"'{title[:50]}' -> {final[:160] if final else None}")
            pg.close()

        if "yt" in STEPS:
            pg = ctx.new_page()
            pg.goto("https://www.youtube.com/results?search_query=minecraft")
            consent(pg)
            pg.wait_for_timeout(5000)
            pg.screenshot(path=str(SHOTS / "youtube_2010.png"))
            url = pg.url
            dates = pg.evaluate("""() => [...document.querySelectorAll('ytd-video-renderer, yt-lockup-view-model')]
                .filter(e => e.offsetParent !== null).map(e => (e.innerText.match(/\\d+ (year|month|week|day|hour)s? ago/)||[''])[0]).slice(0, 12)""")
            ok = "before%3A2011-01-01" in url or "before:2011-01-01" in url
            log("yt", ok, f"url={url[:140]} visible_dates={dates}")
            pg.close()

        if "yt2003" in STEPS:
            set_state(ctx, ext_id, year=2003)
            pg = ctx.new_page()
            pg.goto("https://www.youtube.com/")
            pg.wait_for_timeout(3000)
            pg.screenshot(path=str(SHOTS / "youtube_2003.png"))
            log("yt2003", "notfound.html" in pg.url, pg.url[:140])
            pg.close()
            set_state(ctx, ext_id, year=2010)

        if "player" in STEPS:
            pg = ctx.new_page()
            events = []
            pg.on("console", lambda m: events.append(m.text))
            pg.goto(f"chrome-extension://{ext_id}/src/player/player.html")
            pg.wait_for_timeout(1500)
            first = pg.locator("#list li").first.inner_text() if pg.locator("#list li").count() else ""
            pg.click("#play")
            pg.wait_for_timeout(9000)
            has_iframe = pg.locator("#vis iframe").count() == 1
            status = pg.locator("#status").inner_text()
            pg.screenshot(path=str(SHOTS / "player_2010.png"))
            log("player", "Tik Tok" in first and has_iframe, f"first='{first}' iframe={has_iframe} status='{status}' skin={pg.evaluate('document.body.dataset.skin')}")
            pg.close()

        if page_errors:
            print("page errors:", page_errors[:5])
        ctx.close()
    (SHOTS / "results.json").write_text(json.dumps(results, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
