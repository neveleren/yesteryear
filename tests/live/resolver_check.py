"""Live check of the archive lookups (archive.org only, never Google)."""
import shutil, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]; EXT = ROOT / "extension"; PROFILE = ROOT / "test-profile-resolver"
shutil.rmtree(PROFILE, ignore_errors=True)
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(str(PROFILE), channel="chromium", headless=True,
        args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext = sw.url.split("/")[2]
    pg = ctx.new_page()
    pg.goto(f"chrome-extension://{ext}/src/ui/popup.html")
    pg.evaluate("() => chrome.storage.local.set({enabled: true, year: 2010, strict: true, google: true})")
    ask = """([year, hosts]) => new Promise(r => chrome.runtime.sendMessage({type: 'wayback:hosts', year, hosts}, r))"""
    names = ['top40-charts.com', 'tiktok.com', 'en.wikipedia.org', 'instagram.com', 'billboard.com', 'spotify.com', 'youtube.com']
    for year in (2010, 2005, 2004):
        for attempt in (1, 2):
            t0 = time.time()
            hosts = pg.evaluate(ask, [year, names])
            print(f"hosts {year} try {attempt} ({time.time()-t0:.1f}s):", hosts)
            if "unknown" not in hosts.values():
                break
            pg.wait_for_timeout(2500)
    for url in ["https://www.top40-charts.com/news.php?nid=99999", "https://www.billboard.com/charts/year-end/2010/hot-100-songs/"]:
        t0 = time.time()
        pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2010&u={url}")
        final = None
        for _ in range(30):
            pg.wait_for_timeout(700)
            final = pg.url
            if "web.archive.org" in final or "notfound.html" in final:
                break
        print(f"{url} -> {final[:150]} ({time.time()-t0:.1f}s)")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=str(ROOT / "test-shots" / "resolver_site_fallback.png"))
    ctx.close()
