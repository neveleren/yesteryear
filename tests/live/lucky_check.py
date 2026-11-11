"""Live check of "I'm Feeling Lucky" on the period homepage (archive.org only; www.google.com is a local stub or a
saved results page, and google.com does not even resolve in this browser).

    .venv/Scripts/python.exe tests/live/lucky_check.py [year]      (default 2005)

1. Empty box: opens Google's logo page of that day from the archive (2005: holidaylogos.html).
2. With words: our own lucky search (date cap, site check), then the first result that passed, as it was back then;
   Back returns to the results page without the lucky marker.
"""
import shutil
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
PROFILE = ROOT / "test-profile-lucky"
SHOTS = ROOT / "test-shots"
SHOTS.mkdir(exist_ok=True)
YEAR = int(sys.argv[1]) if len(sys.argv) > 1 else 2005
BLANK = b"<!doctype html><html><head><title>Google</title></head><body></body></html>"
SERP = (ROOT / "research" / "serp" / "2020_linux.html").read_bytes()
ARCHIVE = ("https://archive.org/", "https://web.archive.org/", "https://web-static.archive.org/", "chrome-extension://")
results = []


def log(name, ok, info=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name}: {info}")


def wait_archive(pg, seconds=40):
    for _ in range(int(seconds / 0.5)):
        if "web.archive.org/web/" in pg.url or "notfound.html" in pg.url:
            break
        pg.wait_for_timeout(500)
    return pg.url


shutil.rmtree(PROFILE, ignore_errors=True)
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE), channel="chromium", headless=True,
        args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND",
              f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--lang=en-US"],
        locale="en-US", viewport={"width": 1280, "height": 860})
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext_id = sw.url.split("/")[2]
    pg = ctx.new_page()
    pg.goto(f"chrome-extension://{ext_id}/src/ui/popup.html")
    pg.evaluate("y => chrome.storage.local.set({enabled: true, year: y, google: true, strict: true, eraLook: true})", YEAR)
    pg.wait_for_timeout(800)
    served = []

    def serve(route):
        req = route.request
        url = req.url
        if url.startswith("https://www.google.com/search"):
            served.append(url)
            route.fulfill(status=200, body=SERP, headers={"content-type": "text/html; charset=utf-8"})
        elif url.startswith("https://www.google.com/"):
            route.fulfill(status=200, body=BLANK, headers={"content-type": "text/html; charset=utf-8"})
        elif url.startswith(ARCHIVE):
            route.continue_()
        elif req.resource_type == "document" and "google." not in url.split("/")[2]:
            route.continue_()          # a result page: the extension's redirect rule sends it to the resolver
        else:
            route.abort()

    ctx.route("**/*", serve)
    day = f"{YEAR}{time.strftime('%m%d')}"

    # 1. empty box
    pg.goto("https://www.google.com/", wait_until="domcontentloaded")
    pg.wait_for_selector("#yy-root input[name=btnI]", timeout=8000)
    t0 = time.time()
    pg.click("#yy-root input[name=btnI]")
    final = wait_archive(pg)
    pg.wait_for_timeout(2500)
    pg.screenshot(path=str(SHOTS / f"lucky_empty_{YEAR}.png"))
    ts = final.split("/web/")[1][:14] if "/web/" in final else ""
    log("empty box opens Google's logo page of that time", "/web/" in final and "logos" in final and ts <= day + "235959",
        f"{final[:140]} ({time.time() - t0:.1f}s)")

    # 2. with words
    pg.goto("https://www.google.com/", wait_until="domcontentloaded")
    pg.wait_for_selector("#yy-root input[name=q]", timeout=8000)
    pg.fill("#yy-root input[name=q]", "linux")
    t0 = time.time()
    pg.click("#yy-root input[name=btnI]")
    final = wait_archive(pg, 60)
    pg.wait_for_timeout(2500)
    pg.screenshot(path=str(SHOTS / f"lucky_linux_{YEAR}.png"))
    ts = final.split("/web/")[1][:14] if "/web/" in final else ""
    log("lucky search opens the first result as it was back then", "/web/" in final and ts[:4].isdigit() and ts <= f"{YEAR}1231235959",
        f"{final[:140]} ({time.time() - t0:.1f}s)")
    log("the lucky search carried the date cap", any("cd_max%3A12%2F31%2F" + str(YEAR) in u or f"cd_max:12/31/{YEAR}" in u for u in served),
        f"{len(served)} search requests served locally")
    pg.go_back(wait_until="domcontentloaded")
    for _ in range(20):
        if "google.com/search" in pg.url:
            break
        pg.go_back(wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)
    shown = pg.evaluate("() => document.querySelectorAll('#yy-root .yy-r').length")
    log("Back shows the results page (no second jump)", "google.com/search" in pg.url and "yylucky" not in pg.url and shown > 0,
        f"{pg.url[:120]} results={shown}")
    ctx.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
