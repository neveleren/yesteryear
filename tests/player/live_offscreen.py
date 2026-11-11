"""Live check of the offscreen music player in Playwright's headless Chromium.

    .venv/Scripts/python.exe tests/player/live_offscreen.py

Runs on a patched COPY of the extension (tests/player/integration.py -> test-build-player) in its own
throwaway profile (test-profile-player). Network budget: no Google traffic at all (a session rule
blocks google.com, which the YouTube embed calls for its bot check), no YouTube searches (the song ->
video cache is seeded and a cooldown blocks any search), exactly one YouTube embed load.
Headless Chromium plays no YouTube sound (without the bot check script YouTube answers errorCode
"auth"), so this checks the plumbing: the offscreen document, the embed with the yy_player marker,
commands reaching it, state reaching the side panel and the popup, hide, close-after-silence, recreate.
Screenshots go to test-shots/player/.
"""
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from integration import build  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "test-build-player"
PROFILE = ROOT / "test-profile-player"
SHOTS = ROOT / "test-shots" / "player"
PORT = 9361
VIDEO = "jNQXAC9IVRw"  # "Me at the zoo", 19 s, always embeddable
results = []


def log(step, ok, info=""):
    results.append({"step": step, "ok": bool(ok), "info": info})
    print(("PASS " if ok else "FAIL ") + step + (": " + info if info else ""), flush=True)


def targets():
    return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5).read())


def wait_for(fn, timeout=20.0, every=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(every)
    return last


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    build(BUILD)
    shutil.rmtree(PROFILE, ignore_errors=True)
    charts = json.loads((BUILD / "src" / "player" / "charts.json").read_text(encoding="utf-8"))
    errors = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), channel="chromium", headless=True,
            args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={BUILD}", f"--load-extension={BUILD}",
                  f"--remote-debugging-port={PORT}", "--lang=en-US"],
            locale="en-US", viewport={"width": 1280, "height": 900})
        ctx.on("weberror", lambda e: errors.append(str(e.error)))
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext = sw.url.split("/")[2]
        base = f"chrome-extension://{ext}"
        offscreen_url = f"{base}/src/player/offscreen.html"

        helper = ctx.new_page()
        helper.goto(f"{base}/src/ui/popup.html")
        state = lambda: helper.evaluate("chrome.runtime.sendMessage({type: 'music:state'})")
        control = lambda cmd, **kw: helper.evaluate("m => chrome.runtime.sendMessage(m)", {"type": "music:control", "cmd": cmd, **kw})
        has_doc = lambda: helper.evaluate("u => chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [u]}).then(c => c.length > 0)", offscreen_url)

        # Test-only safety: no request may reach google.com; no YouTube search may run.
        helper.evaluate("""() => chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [9001], addRules: [
            {id: 9001, priority: 100, action: {type: 'block'}, condition: {requestDomains: ['google.com']}}]})""")
        seed = {"year": 2010, "enabled": True, "mus:cooldown": {"until": int(time.time() * 1000) + 86400000, "ms": 86400000}}
        for s in charts["2010"][:8]:
            seed[f"mus:id:{s['artist']}|{s['title']}"] = {"videoId": VIDEO, "candidates": [VIDEO], "at": int(time.time() * 1000)}
        helper.evaluate("s => chrome.storage.local.set(s)", seed)
        helper.reload()
        helper.wait_for_timeout(800)

        # 1. Idle state without a document: nothing is created just by asking.
        s = state()
        log("idle state", s and s["year"] == 2010 and s["track"]["title"] == "Tik Tok" and not s["playing"] and not has_doc(),
            f"track={s and s['track']} alive={s and s.get('alive')}")
        helper.set_viewport_size({"width": 320, "height": 520})
        helper.wait_for_timeout(300)
        helper.locator("main.window").screenshot(path=str(SHOTS / "popup_idle.png"))
        log("popup mini player", helper.locator("#mp-text").inner_text().startswith("1. Kesha - Tik Tok")
            and helper.locator("#mp-legend").inner_text() == "Music of 2010" and helper.locator("#mp-show").is_enabled(),
            f"text='{helper.locator('#mp-text').inner_text()}'")

        # 2. "Show player" opens the real side panel (needs the click's user gesture).
        opener = ctx.new_page()
        opener.goto(f"{base}/src/ui/popup.html")
        opener.wait_for_timeout(600)
        opener.click("#mp-show")
        panel_target = wait_for(lambda: next((t for t in targets() if t["url"].endswith("/src/player/player.html")), None), 8)
        log("show player opens the side panel", panel_target is not None)
        cdp = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
        panel = next(pg for c in cdp.contexts for pg in c.pages if pg.url.endswith("/src/player/player.html"))
        panel.on("pageerror", lambda e: errors.append("panel: " + str(e)))
        panel.wait_for_timeout(800)
        size = panel.evaluate("({w: innerWidth, h: innerHeight})")
        panel.screenshot(path=str(SHOTS / "panel_idle_itunes_2010.png"))
        log("panel shows the state", panel.locator("#marquee").inner_text().strip().startswith("Tik Tok")
            and panel.locator("#list li").count() == 100, f"size={size} skin={panel.evaluate('document.body.dataset.skin')}")

        # 3. Play in the panel: the hub creates the offscreen document, the engine loads the embed there.
        panel.click("#play")
        log("offscreen document created", wait_for(has_doc, 10))
        frame = wait_for(lambda: next((t for t in targets() if t["type"] == "iframe" and "/embed/" in t["url"]), None), 15)
        doc_target = next((t for t in targets() if t["url"] == offscreen_url), None)
        log("YouTube embed inside the offscreen document carries the marker",
            frame is not None and "yy_player=1" in frame["url"] and doc_target is not None and frame.get("parentId") == doc_target["id"],
            f"iframe={frame and frame['url'][:110]} parent_ok={bool(frame and doc_target and frame.get('parentId') == doc_target['id'])} doc_type={doc_target and doc_target['type']}")
        got = wait_for(lambda: (lambda st: st if st and st.get("duration") == 19 else None)(state()), 15)
        log("YouTube answered the engine (duration 19 s of the seeded video)", got is not None,
            f"diag={got and got.get('diag')} status='{got and got['status']}'")
        shown = wait_for(lambda: panel.locator("#total").inner_text() in ("-0:19", "0:19"), 8, 0.1)
        log("state reached the panel", shown,
            f"total='{panel.locator('#total').inner_text()}' status='{panel.locator('#status').inner_text()}'")

        # 4. A command reaches the iframe: YouTube echoes the new volume.
        control("volume", volume=37)
        echo = wait_for(lambda: (lambda st: st if st and (st.get("diag") or {}).get("ytVolume") == 37 else None)(state()), 10)
        log("volume command reached the YouTube player", echo is not None, f"diag={echo and echo.get('diag')}")
        panel.screenshot(path=str(SHOTS / "panel_live_itunes_2010.png"))

        # 5. Hide player closes the panel; the offscreen document (and its player) stays.
        panel.click("#hide")
        gone = wait_for(lambda: not any(t["url"].endswith("/src/player/player.html") for t in targets()), 6)
        log("hide player closes the panel, the player document stays", gone and has_doc(),
            f"panel_gone={bool(gone)} doc={has_doc()}")
        s = state()
        log("engine still answers after the panel closed", s and s.get("alive") is True, f"alive={s and s.get('alive')} index={s and s['index']}")

        # 6. Headless YouTube refuses (no bot check script): the engine must not hang; it explains.
        halted = wait_for(lambda: (lambda st: st if st and not st["playing"] and st["problem"] else None)(state()), 40, 1.0)
        log("silent YouTube ends with a clear message (no endless 'Loading...')", halted is not None,
            f"status='{halted and halted['status']}' index={halted and halted['index']}")
        tab = ctx.new_page()
        tab.set_viewport_size({"width": 360, "height": 640})
        tab.goto(f"{base}/src/player/player.html")
        tab.wait_for_timeout(1200)
        tab.screenshot(path=str(SHOTS / "panel_problem_itunes_2010.png"))
        log("the panel shows that message", tab.locator("#status").inner_text() == (halted and halted["status"]),
            f"status='{tab.locator('#status').inner_text()}'")
        tab.close()

        # 7. Chrome closes the silent document after 30 s; music:state then reports from the hub.
        closed = wait_for(lambda: not has_doc(), 45, 1.0)
        s = state()
        log("silent document closed by Chrome, state still served", closed and s and s.get("alive") is False and s["year"] == 2010,
            f"alive={s and s.get('alive')} status='{s and s['status']}'")

        # 8. Recreate on demand: a command brings the document back (no YouTube load while paused).
        before = s["index"]
        r = control("next")
        log("command recreates the document", r and r.get("ok") and has_doc() and r["state"]["index"] == (before + 1) % 100,
            f"index {before} -> {r and r['state']['index']} alive={r and r['state'].get('alive')}")
        log("no new embed while paused", not any(t["type"] == "iframe" and "/embed/" in t["url"] for t in targets()))

        # 9. The year follows the popup: a new year reaches the running engine.
        helper.evaluate("chrome.storage.local.set({year: 2003})")
        s = wait_for(lambda: (lambda st: st if st and st["year"] == 2003 else None)(state()), 6)
        log("year change reaches the engine", s and s["skin"] == "winamp" and s.get("alive") is True,
            f"track={s and s['track']} skin={s and s['skin']}")
        helper.wait_for_timeout(500)
        log("popup follows", helper.locator("#mp-legend").inner_text() == "Music of 2003",
            f"legend='{helper.locator('#mp-legend').inner_text()}' text='{helper.locator('#mp-text').inner_text()}'")

        # 10. Looks: the panel page in a tab, fed synthetic "playing" states (no YouTube involved).
        look = ctx.new_page()
        look.on("pageerror", lambda e: errors.append("look: " + str(e)))
        look.set_viewport_size({"width": 360, "height": 640})
        look.goto(f"{base}/src/player/player.html")
        look.wait_for_timeout(800)
        for year in (2002, 2007, 2012, 2020):
            song = charts[str(year)][2]
            st = {"playing": True, "loading": False, "year": year, "index": 2, "length": 100,
                  "track": {"artist": song["artist"], "title": song["title"], "rank": song["rank"]},
                  "time": 63, "duration": 215, "at": int(time.time() * 1000), "volume": 70, "shuffle": year == 2020,
                  "status": "", "problem": False, "videoId": VIDEO}
            helper.evaluate("s => chrome.runtime.sendMessage({type: 'music:changed', state: s, source: 'test'})", st)
            look.wait_for_timeout(1500)
            look.screenshot(path=str(SHOTS / f"look_{year}_{look.evaluate('document.body.dataset.skin')}.png"))
        skins = []
        for width in (320, 300):
            look.set_viewport_size({"width": width, "height": 600})
            for year in (2003, 2008, 2013, 2021):
                song = charts[str(year)][0]
                st = {"playing": True, "year": year, "index": 0, "length": 100, "track": song, "time": 30, "duration": 200,
                      "at": int(time.time() * 1000), "volume": 70}
                helper.evaluate("s => chrome.runtime.sendMessage({type: 'music:changed', state: s, source: 'test'})", st)
                look.wait_for_timeout(900)
                skin = look.evaluate("document.body.dataset.skin")
                over = look.evaluate("document.documentElement.scrollWidth > innerWidth")
                skins.append((width, skin, over))
                look.screenshot(path=str(SHOTS / f"compact_{width}_{skin}.png"))
        log("compact layouts have no horizontal overflow", not any(o for _, _, o in skins), str(skins))
        look.set_viewport_size({"width": 560, "height": 640})
        song = charts["1999"][0]
        helper.evaluate("s => chrome.runtime.sendMessage({type: 'music:changed', state: s, source: 'test'})",
                        {"playing": True, "year": 1999, "index": 0, "length": 100, "track": song, "time": 95, "duration": 240,
                         "at": int(time.time() * 1000), "volume": 60})
        look.wait_for_timeout(1200)
        look.screenshot(path=str(SHOTS / "wide_560_winamp.png"))
        # A page never receives its own runtime messages: the popup's state comes from the other tab.
        look.evaluate("s => chrome.runtime.sendMessage({type: 'music:changed', state: s, source: 'test'})",
                      {"playing": True, "year": 2010, "index": 0, "length": 100, "track": charts["2010"][0], "time": 75,
                       "duration": 200, "at": int(time.time() * 1000), "volume": 70})
        helper.set_viewport_size({"width": 320, "height": 520})
        helper.wait_for_timeout(900)
        log("popup shows a playing state", helper.locator("#mp-play").get_attribute("aria-label") == "Pause"
            and helper.locator("#mp-screen.on").count() == 1, f"time='{helper.locator('#mp-time').inner_text()}'")
        helper.locator("main.window").screenshot(path=str(SHOTS / "popup_playing.png"))

        log("no page errors", not errors, "; ".join(errors[:5]))
        cdp.close()
        ctx.close()
    (SHOTS / "results.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    failed = [r for r in results if not r["ok"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
