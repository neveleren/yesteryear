"""Render test without touching Google: archived Google result pages (research/serp) are served in place of
www.google.com/search, so the extension's parser, leak filter and period look run on real Google HTML.

Usage: .venv/Scripts/python.exe tests/live/render_fixture.py <fixture.html> <year> [query]
"""
import shutil
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
PROFILE = ROOT / "test-profile-fixture"
SHOTS = ROOT / "test-shots"
SHOTS.mkdir(exist_ok=True)

fixture = ROOT / "research" / "serp" / sys.argv[1]
year = int(sys.argv[2])
query = sys.argv[3] if len(sys.argv) > 3 else "linux"
html = fixture.read_bytes()

shutil.rmtree(PROFILE, ignore_errors=True)
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(PROFILE), channel="chromium", headless=True,
        args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--lang=en-US"],
        locale="en-US", viewport={"width": 1280, "height": 900})
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext_id = sw.url.split("/")[2]
    pg = ctx.new_page()
    pg.goto(f"chrome-extension://{ext_id}/src/ui/popup.html")
    pg.evaluate("y => chrome.storage.local.set({enabled: true, year: y, google: true, strict: true, eraLook: true})", year)
    pg.wait_for_timeout(800)
    seen = []

    def serve(route):
        url = route.request.url
        if url.startswith("https://www.google.com/search"):
            seen.append(url)
            route.fulfill(status=200, body=html, headers={"content-type": "text/html; charset=utf-8"})
        elif url.startswith("https://www.google.com/s2/favicons"):
            route.fulfill(status=200, body=b"", headers={"content-type": "image/png"})
        elif route.request.url.startswith(("https://archive.org/", "https://web.archive.org/")):
            route.continue_()      # the extension's own archive lookups
        else:
            route.abort()          # nothing else leaves the machine: no Google, no gstatic, no ads

    ctx.route("**/*", serve)
    pg.goto(f"https://www.google.com/search?q={query}&hl=en", wait_until="domcontentloaded")
    pg.wait_for_timeout(9000)
    info = pg.evaluate("""() => ({
        url: location.href,
        era: document.documentElement.dataset.yyEra,
        shown: [...document.querySelectorAll('#yy-root .yy-r')].map(r => (r.querySelector('h3')||{}).textContent),
        stats: (document.querySelector('#yy-root .yy-stats')||{}).textContent,
        nomatch: !!document.querySelector('#yy-root .yy-nomatch')
    })""")
    print("requests served:", len(seen))
    print("final url:", info["url"][:170])
    print("era:", info["era"], "| stats:", info["stats"])
    print("shown:", info["shown"][:10], "| nomatch:", info["nomatch"])
    name = f"fixture_{fixture.stem}_{year}.png"
    pg.screenshot(path=str(SHOTS / name), full_page=False)
    print("screenshot:", SHOTS / name)
    ctx.close()
