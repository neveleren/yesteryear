"""Live check: the period Google homepage's tabs open Google's own services as they were on today's date in
that year (archive.org only; www.google.com is served from a blank local page, nothing reaches Google).

Usage: .venv/Scripts/python.exe tests/live/services_check.py <year> <tab name> [path] [results fixture]
(Git Bash: set MSYS_NO_PATHCONV=1 so "/imghp" stays a path)
"""
import shutil
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
PROFILE = ROOT / "test-profile-services"
SHOTS = ROOT / "test-shots"
SHOTS.mkdir(exist_ok=True)
year = int(sys.argv[1])
tab = sys.argv[2]
path = sys.argv[3] if len(sys.argv) > 3 else "/"
BLANK = b"<!doctype html><html><head><title>Google</title></head><body></body></html>"
# a results page (path /search?...) is served from an archived Google page in research/serp
FIXTURE = (ROOT / "research" / "serp" / sys.argv[4]).read_bytes() if len(sys.argv) > 4 else BLANK

shutil.rmtree(PROFILE, ignore_errors=True)
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE), channel="chromium", headless=True,
        args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--lang=en-US"],
        locale="en-US", viewport={"width": 1280, "height": 860})
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext_id = sw.url.split("/")[2]
    pg = ctx.new_page()
    pg.goto(f"chrome-extension://{ext_id}/src/ui/popup.html")
    pg.evaluate("y => chrome.storage.local.set({enabled: true, year: y, google: true, strict: true, eraLook: true})", year)
    pg.wait_for_timeout(800)

    def serve(route):
        url = route.request.url
        if url.startswith("https://www.google.com/search"):
            route.fulfill(status=200, body=FIXTURE, headers={"content-type": "text/html; charset=utf-8"})
        elif url.startswith("https://www.google.com/"):
            route.fulfill(status=200, body=BLANK, headers={"content-type": "text/html; charset=utf-8"})
        elif url.startswith(("https://archive.org/", "https://web.archive.org/", "https://web-static.archive.org/", "chrome-extension://")):
            route.continue_()
        else:
            print("  blocked:", route.request.resource_type, url[:100])
            route.abort()

    ctx.route("**/*", serve)
    pg.on("console", lambda m: print("  console:", m.type, m.text[:160]))
    pg.goto(f"https://www.google.com{path}", wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=str(SHOTS / f"home_{year}_{path.strip('/').split('?')[0] or 'home'}.png"))
    links = pg.evaluate("""() => [...document.querySelectorAll('#yy-root a')].map(a => [a.textContent.trim(), a.href.slice(0, 140)])""")
    for name, href in links:
        print(f"  {name:12} {href}")
    link = pg.locator("#yy-root a", has_text=tab).first
    t0 = time.time()
    link.click()
    final = ""
    for _ in range(40):
        pg.wait_for_timeout(700)
        final = pg.url
        if "web.archive.org" in final or "notfound.html" in final:
            break
    pg.wait_for_timeout(4000)
    print(f"{tab} -> {final[:160]} ({time.time() - t0:.1f}s)")
    pg.screenshot(path=str(SHOTS / f"service_{year}_{tab.replace(' ', '_').replace('!', '')}.png"))
    ctx.close()
