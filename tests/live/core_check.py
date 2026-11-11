"""Stubbed browser checks for the core fixes (Google and YouTube content scripts, wayback resolver and guard).
Nothing leaves the machine: www.google.com, www.youtube.com and archive.org (CDX, availability, replays) are
answered locally, extension pages pass, every other request is aborted.

Usage: .venv/Scripts/python.exe tests/live/core_check.py [phase ...]
phases (default all): loop tabs youtube sites coalesce degraded overten day links signin notes bar busy
"busy" runs last: it pauses the extension's archive queue for 70 s.
"""
import asyncio
import json
import shutil
import sys
import time
import urllib.parse
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
# --src=<dir>: check another copy of the extension (e.g. an export of an older commit) instead of extension/
SRC = next((Path(a.split("=", 1)[1]) for a in sys.argv[1:] if a.startswith("--src=")), ROOT / "extension")
BUILD = ROOT / "test-build-core"
PROFILE = ROOT / "test-profile-core"
PHASES = ["loop", "tabs", "youtube", "sites", "coalesce", "degraded", "overten", "day", "links", "signin", "notes", "bar", "busy"]
ONLY = [p for p in sys.argv[1:] if p in PHASES] or PHASES
BLANK = b"<!doctype html><html><head><title>stub</title></head><body>stub</body></html>"
PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")

CFG = {}
LOG = {"search": [], "cdx": [], "posts": [], "replays": [], "youtube": [], "signin": [], "other": []}
T0 = [time.time()]
RESULTS = []


def check(name, ok, info=""):
    RESULTS.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (": " + info if info else ""), flush=True)


def reset(**cfg):
    CFG.clear()
    CFG.update({"serp": BLANK, "cdx": lambda q: (200, []), "avail_delay": 0.0, "avail_status": 200, "first": {},
                "replay": lambda url: None, "replay_delay": 0.0})
    CFG.update(cfg)
    for v in LOG.values():
        v.clear()
    T0[0] = time.time()


def card(i, host, title, snippet=None):
    return (f'<div class=g><a href="https://{host}/page{i}.html"><h3>{title}</h3></a>'
            f'<cite>https://{host} › page{i}.html</cite><div class=VwiC3b>{snippet or f"Plain snippet number {i}."}</div></div>')


def serp(hosts, late=None, slow=False):
    cards = "".join(card(i, h, f"Result {i} at {h}") for i, h in enumerate(hosts, 1))
    late_js = ""
    if late:
        late_js = ("<script>document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{const t=document.createElement('template');"
                   f"t.innerHTML={json.dumps(card(99, late, 'Late card at ' + late))};document.getElementById('rso').append(t.content.firstChild);}},800));</script>")
    img = '<img src="https://www.google.com/slow.png" width=1 height=1>' if slow else ""
    return f"<!doctype html><html><head><title>s</title>{late_js}</head><body><div id=rso>{cards}</div>{img}</body></html>".encode()


async def serve(route):
    req = route.request
    u = req.url
    if u.startswith("chrome-extension://"):
        return await route.continue_()
    if u.startswith("https://www.google.com/search"):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
        LOG["search"].append((round(time.time() - T0[0], 2), q.get("q", [""])[0], q.get("tbs", [""])[0], q.get("udm", [""])[0]))
        return await route.fulfill(status=200, body=CFG["serp"], headers={"content-type": "text/html; charset=utf-8"})
    if u.startswith("https://www.google.com/slow.png"):
        await asyncio.sleep(1.5)
        return await route.fulfill(status=200, body=PNG, headers={"content-type": "image/png"})
    if u.startswith("https://www.google.com/s2/favicons"):
        return await route.fulfill(status=200, body=PNG, headers={"content-type": "image/png"})
    if u.startswith("https://www.google.com/"):
        return await route.fulfill(status=200, body=BLANK, headers={"content-type": "text/html; charset=utf-8"})
    if u.startswith("https://www.youtube.com/"):
        LOG["youtube"].append((round(time.time() - T0[0], 2), urllib.parse.unquote_plus(u)))
        return await route.fulfill(status=200, body=BLANK, headers={"content-type": "text/html; charset=utf-8"})
    if u.startswith("https://archive.org/wayback/available"):
        hosts = [x["url"] for x in json.loads(req.post_data or "[]")]
        LOG["posts"].append((round(time.time() - T0[0], 2), CFG["avail_status"], hosts))
        await asyncio.sleep(CFG["avail_delay"])
        if CFG["avail_status"] != 200:
            return await route.fulfill(status=CFG["avail_status"], body=b"Too Many Requests")
        res = [{"url": h, "archived_snapshots": {"closest": {"timestamp": CFG["first"].get(h, "19990101000000"), "available": True}}} for h in hosts]
        return await route.fulfill(status=200, body=json.dumps({"results": res}).encode(), headers={"content-type": "application/json"})
    if u.startswith("https://web.archive.org/cdx/"):
        q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(u).query).items()}
        LOG["cdx"].append((round(time.time() - T0[0], 2), q.get("url"), q.get("to"), q.get("filter"), q.get("limit"), q.get("fl")))
        status, rows = CFG["cdx"](q)
        return await route.fulfill(status=status, body=json.dumps(rows).encode(), headers={"content-type": "application/json"})
    if u.startswith("https://web.archive.org/web/"):
        if req.method == "POST":
            LOG["signin"].append(u)
            return await route.fulfill(status=200, body=b"<!doctype html><h1>posted</h1>", headers={"content-type": "text/html"})
        LOG["replays"].append((round(time.time() - T0[0], 2), u))
        if CFG["replay_delay"]:
            await asyncio.sleep(CFG["replay_delay"])
        got = CFG["replay"](u)
        if got:
            status, headers, body = got
            return await route.fulfill(status=status, headers=headers, body=body)
        body = f'<!doctype html><html><body><h1>archived {u.split("/web/")[1][:70]}</h1></body></html>'.encode()
        return await route.fulfill(status=200, body=body, headers={"content-type": "text/html; charset=utf-8"})
    LOG["other"].append(u[:100])
    return await route.abort()


def rows(*r):
    return [["timestamp", "original", "statuscode"], *[list(x) for x in r]]


def rows200(*r):
    return [["timestamp", "original"], *[list(x) for x in r]]


async def wait_url(pg, pred, secs):
    t0 = time.time()
    while time.time() - t0 < secs:
        if pred(pg.url):
            return True
        await pg.wait_for_timeout(200)
    return pred(pg.url)


async def watch_note(pg, secs):
    """Text of the resolver's info bar (shown for a moment before it opens the page)."""
    t0 = time.time()
    while time.time() - t0 < secs:
        try:
            t = await pg.evaluate("() => (document.querySelector('.infobar') || {}).textContent || ''")
            if t:
                return t
        except Exception:
            pass
        await asyncio.sleep(0.1)
    return ""


async def isolated(pg, expr):
    """Evaluate in the content script's isolated world (headless never reports a hidden tab, so a test makes the
    content script see one)."""
    cdp = await pg.context.new_cdp_session(pg)
    seen = []
    cdp.on("Runtime.executionContextCreated", lambda e: seen.append(e["context"]))
    await cdp.send("Runtime.enable")
    await asyncio.sleep(0.3)
    worlds = [c for c in seen if c.get("auxData", {}).get("type") == "isolated" and
              (str(c.get("origin", "")).startswith("chrome-extension://") or c.get("name") == "Yesteryear")]
    if not worlds:
        raise RuntimeError("no content-script world: " + json.dumps([[c.get("name"), c.get("origin"), c.get("auxData")] for c in seen]))
    r = await cdp.send("Runtime.evaluate", {"expression": expr, "contextId": worlds[-1]["id"], "returnByValue": True})
    await cdp.detach()
    return r.get("result", {}).get("value")

HIDE = "Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'}); document.dispatchEvent(new Event('visibilitychange')); 'ok'"
SHOW = "Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'}); document.dispatchEvent(new Event('visibilitychange')); 'ok'"


async def main():
    shutil.rmtree(BUILD, ignore_errors=True)
    shutil.copytree(SRC, BUILD)
    shutil.rmtree(PROFILE, ignore_errors=True)
    reset()
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(str(PROFILE), channel="chromium", headless=True,
            args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={BUILD}", f"--load-extension={BUILD}", "--lang=en-US"], locale="en-US",
            viewport={"width": 1100, "height": 800})
        await ctx.route("**/*", serve)
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker", timeout=15000)
        ext = sw.url.split("/")[2]
        ctl = await ctx.new_page()
        await ctl.goto(f"chrome-extension://{ext}/src/wayback/notfound.html#y=2010&why=error&u=about:blank")
        await ctl.wait_for_timeout(800)
        for pg in list(ctx.pages):
            if pg is not ctl:
                await pg.close()      # the first-run tour tab and the start page

        async def setst(patch, wait=400):
            await ctl.evaluate("p => chrome.storage.local.set(p)", patch)
            await ctl.wait_for_timeout(wait)

        async def storage(prefix):
            return await ctl.evaluate("p => chrome.storage.local.get(null).then(all => Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(p))))", prefix)

        base = {"enabled": True, "google": True, "youtube": True, "strict": True, "eraLook": True}

        # ------------------------------------------------------------ F8: redirect captures, loop breaker
        if "loop" in ONLY:
            print("=== loop (F8)")
            nyt = "https://www.nytimes.com/"

            def cdx_loop(q):
                url, redirects = q["url"], "[23]" in q.get("filter", "")
                if url == nyt:
                    return 200, rows(("20171231234502", nyt, "200"), ("20171231235927", "http://nytimes.com/", "301"))
                if url in ("https://only3xx.example/", "https://www.only3xx.example/"):
                    return 200, (rows(("20171231235927", "http://only3xx.example/", "301")) if redirects else
                                 rows200(("20171231234502", "https://www.only3xx.example/")))
                if url == "https://loop.example/":
                    return 200, (rows(("20171231235927", "http://loop.example/", "301")) if redirects else rows200(("20171231234502", "http://loop.example/")))
                return 200, []

            def replay_loop(u):
                if "/web/20171231235927if_/http://nytimes.com/" in u:
                    return 302, {"location": "https://web.archive.org/web/20180101000001if_/https://www.nytimes.com/"}, b""
                if "/web/20171231235927if_/http://only3xx.example/" in u:
                    return 302, {"location": "https://web.archive.org/web/20180101000001if_/https://www.only3xx.example/"}, b""
                if "loop.example/" in u and "/web/2017" in u:
                    return 302, {"location": "https://web.archive.org/web/20180101000001if_/https://loop.example/"}, b""
                return None

            await setst({**base, "year": 2017})
            reset(cdx=cdx_loop, replay=replay_loop)
            pg = await ctx.new_page()
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2017&u={nyt}")
            await wait_url(pg, lambda x: "20171231234502if_" in x or "notfound" in x, 15)
            await pg.wait_for_timeout(1500)
            check("F8 nytimes: the newest 200 wins over the newer 301", "20171231234502if_/https://www.nytimes.com/" in pg.url, pg.url[:110])
            check("F8 nytimes: one redirect-aware lookup (limit -20, with status)", len(LOG["cdx"]) == 1 and LOG["cdx"][0][4] == "-20" and "statuscode" in LOG["cdx"][0][5], str(LOG["cdx"]))
            cache = await storage("wb2:2017:")
            check("F8 nytimes: the 200 is what is cached (new prefix)", cache.get(f"wb2:2017:{nyt}", {}).get("ts") == "20171231234502", str(cache)[:200])
            await pg.close()

            reset(cdx=cdx_loop, replay=replay_loop)
            pg = await ctx.new_page()
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2017&u=https://only3xx.example/")
            await wait_url(pg, lambda x: "20171231234502if_" in x or "notfound" in x, 20)
            await pg.wait_for_timeout(1500)
            check("F8 only a 301 in the window: lands on the year's 200 after one bounce", "20171231234502if_/https://www.only3xx.example/" in pg.url, pg.url[:110])
            check("F8 only a 301: the bounce asks 200-only (why=future)", len(LOG["cdx"]) == 2 and LOG["cdx"][1][3] == "statuscode:200", str([(c[1], c[3]) for c in LOG["cdx"]]))
            await pg.close()

            reset(cdx=cdx_loop, replay=replay_loop, replay_delay=5.5)
            pg = await ctx.new_page()
            t0 = time.time()
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2017&u=https://loop.example/")
            await wait_url(pg, lambda x: "notfound" in x, 40)
            took = time.time() - t0
            check("F8 a capture that always lands in 2018: why=loop although each bounce takes 5.5 s", "why=loop" in pg.url, f"{took:.1f}s, replays={len(LOG['replays'])}")
            check("F8 loop: stopped after the second bounce", len([r for r in LOG["replays"] if "loop.example" in r[1] and "/web/2017" in r[1]]) <= 2, str([r[1][27:80] for r in LOG["replays"]]))
            await pg.close()

        # ------------------------------------------------------------ F1/F2: open Google tabs after a trip / OFF
        if "tabs" in ONLY:
            print("=== tabs (F1, F2)")
            reset(serp=serp(["www.example.com", "www.example.org"]))
            await setst({**base, "year": 2010, "strict": False})
            a = await ctx.new_page()
            await a.goto("https://www.google.com/search?q=best+phone", wait_until="domcontentloaded")
            await a.wait_for_timeout(1500)
            b = await ctx.new_page()
            await b.goto("https://www.google.com/search?q=top+songs", wait_until="domcontentloaded")
            await b.wait_for_timeout(1500)
            check("F1 setup: 'best phone' at 2010 becomes 'best phone 2010'", any(s[1] == "best phone 2010" for s in LOG["search"]), str(LOG["search"]))
            await isolated(b, HIDE)
            LOG["search"].clear()
            await setst({"year": 2005}, wait=3000)
            sa = [s for s in LOG["search"] if s[1].startswith("best phone")]
            sb = [s for s in LOG["search"] if s[1].startswith("top songs")]
            check("F1/F2 trip to 2005: the visible tab searches the user's words once, for 2005", len(sa) == 1 and sa[0][1] == "best phone 2005" and sa[0][2].endswith("12/31/2005"), str(sa))
            check("F2 trip: the hidden tab sends nothing", not sb, str(sb))
            nomatch = await a.evaluate("() => (document.querySelector('#yy-root .yy-nomatch') || {}).textContent || ''")
            check("F1 no 'has not happened yet' after the trip", "has not happened" not in nomatch, nomatch[:120])
            await isolated(b, SHOW)
            await b.wait_for_timeout(1500)
            sb = [s for s in LOG["search"] if s[1].startswith("top songs")]
            check("F2 the hidden tab catches up once when shown", len(sb) == 1 and sb[0][1] == "top songs 2005", str(sb))
            LOG["search"].clear()
            for y in (2001, 2002, 2003):
                await ctl.evaluate("y => chrome.storage.local.set({year: y})", y)
                await ctl.wait_for_timeout(120)
            await ctl.wait_for_timeout(2500)
            sa = [s for s in LOG["search"] if s[1].startswith("best phone")]
            check("F2 three quick year clicks: one search per tab, for the last year", len(sa) == 1 and sa[0][1] == "best phone 2003", str(LOG["search"]))
            LOG["search"].clear()
            await setst({"enabled": False}, wait=2500)
            sa = [s for s in LOG["search"] if s[1].startswith("best phone")]
            check("F1 OFF: the user's own words, no date cap, no udm=14", len(sa) == 1 and sa[0][1:] == ("best phone", "", ""), str(sa))
            LOG["search"].clear()
            await setst({"enabled": True, "year": 2010}, wait=2500)
            sa = [s for s in LOG["search"] if s[1].startswith("best phone")]
            check("F1 ON again at 2010: one search, rewritten again", len(sa) == 1 and sa[0][1] == "best phone 2010", str(sa))
            await a.close()
            await b.close()

        # ------------------------------------------------------------ F3/F4: open YouTube tabs
        if "youtube" in ONLY:
            print("=== youtube (F3, F4)")
            reset()
            await setst({**base, "year": 2010})
            y1 = await ctx.new_page()
            await y1.goto("https://www.youtube.com/results?search_query=best+phone", wait_until="domcontentloaded")
            await y1.wait_for_timeout(1500)
            check("F3 setup: before: added at 2010", "best phone 2010 before:2011-01-01" in urllib.parse.unquote_plus(y1.url), y1.url)
            LOG["youtube"].clear()
            await setst({"year": 2006}, wait=2500)
            got = [x[1] for x in LOG["youtube"]]
            check("F3 trip to 2006: the open results page drops the old before:", len(got) == 1 and "best phone 2006 before:2007-01-01" in got[0], str(got))
            LOG["youtube"].clear()
            await setst({"enabled": False}, wait=2500)
            got = [x[1] for x in LOG["youtube"]]
            check("F3 OFF: the user's words without before:", len(got) == 1 and got[0].endswith("search_query=best phone"), str(got))
            await y1.close()
            await setst({"enabled": True, "year": 1999})
            y2 = await ctx.new_page()
            await y2.goto("https://www.youtube.com/watch?v=abc123", wait_until="domcontentloaded")
            await wait_url(y2, lambda x: "notfound" in x, 8)
            check("F4 1999: the watch page becomes 'did not exist', with its address", "from=youtube" in y2.url and y2.url.endswith("u=https://www.youtube.com/watch?v=abc123"), y2.url[-90:])
            await setst({"year": 2010}, wait=2500)
            check("F4 back to 2010: the watch page comes back", y2.url.startswith("https://www.youtube.com/watch?v=abc123"), y2.url[:90])
            await setst({"year": 1999}, wait=2500)
            await wait_url(y2, lambda x: "notfound" in x, 8)
            await setst({"enabled": False}, wait=2500)
            check("F4 OFF: the watch page comes back", y2.url.startswith("https://www.youtube.com/watch?v=abc123"), y2.url[:90])
            await y2.close()

        # ------------------------------------------------------------ F5/F13: site check before the first draw
        if "sites" in ONLY:
            print("=== sites (F5, F13)")
            hosts = [f"r{i}-sites.example.com" for i in range(1, 11)]
            reset(serp=serp(hosts, late="late-sites.example.com", slow=True), avail_delay=3.0, first={hosts[0]: "20060301000000"})
            await setst({**base, "year": 2005})
            pg = await ctx.new_page()
            await pg.goto("https://www.google.com/search?q=linux&tbs=cdr:1,cd_min:1/1/1990,cd_max:12/31/2005&udm=14", wait_until="domcontentloaded")
            titles = "() => [...document.querySelectorAll('#yy-root .yy-r h3')].map(h => h.textContent)"
            box = "() => { const i = document.querySelector('#yy-root input.yy-q'); return [i ? i.value : null, document.activeElement === i]; }"
            seen_2006 = False
            snaps = []
            typed = False
            t_start = time.time()
            while time.time() - t_start < 8:
                t = await pg.evaluate(titles)
                seen_2006 = seen_2006 or any(hosts[0] in x for x in t)
                loading = await pg.evaluate("() => !!document.querySelector('#yy-root .yy-loading')")
                snaps.append((round(time.time() - t_start, 1), len(t), loading))
                if not typed and time.time() - t_start > 2.2 and await pg.evaluate("() => !!document.querySelector('#yy-root input.yy-q')"):
                    await pg.click("#yy-root input.yy-q")
                    await pg.keyboard.press("End")
                    await pg.keyboard.type(" kernel")
                    typed = True
                await pg.wait_for_timeout(300)
            final = await pg.evaluate(titles)
            check("F5 the site first seen in 2006 is never shown", not seen_2006, f"final {len(final)} results")
            check("F5 nothing is shown and pulled out again (counts only grow)", all(snaps[i][1] <= snaps[i + 1][1] for i in range(len(snaps) - 1)), str(snaps[::3]))
            check("F5 the late card joins once its site checks out", any("Late card" in x for x in final), str(final[-2:]))
            check("F13 typed text and focus survive the updates", await pg.evaluate(box) == ["linux kernel", True], str(await pg.evaluate(box)))
            check("F13 one request per set of new hosts (no duplicate for the re-read)", len(LOG["posts"]) == 2 and len(LOG["posts"][1][2]) == 1, str([(t, len(h)) for t, s, h in LOG["posts"]]))
            LOG["posts"].clear()
            await pg.goto("https://www.google.com/search?q=linux&tbs=cdr:1,cd_min:1/1/1990,cd_max:12/31/2005&udm=14", wait_until="domcontentloaded")
            await pg.wait_for_timeout(700)
            quick = await pg.evaluate(titles)
            check("F5 known sites: the first draw is immediate and complete", len(quick) >= 9 and not LOG["posts"], f"{len(quick)} results at 0.7 s, posts={len(LOG['posts'])}")
            await pg.close()

        if "coalesce" in ONLY:
            print("=== coalesce (F11)")
            hosts = [f"c{i}-co.example.com" for i in range(1, 6)]
            reset(serp=serp(hosts), avail_delay=2.0)
            await setst({**base, "year": 2005})
            CFG["cdx"] = lambda q: (200, rows200(("20040101000000", q["url"])))
            p1, p2 = await ctx.new_page(), await ctx.new_page()
            await asyncio.gather(p1.goto("https://www.google.com/search?q=a1&tbs=cdr:1,cd_min:1/1/1990,cd_max:12/31/2005&udm=14"),
                                 p2.goto("https://www.google.com/search?q=a2&tbs=cdr:1,cd_min:1/1/1990,cd_max:12/31/2005&udm=14"))
            await p1.wait_for_timeout(300)
            t_click = time.time() - T0[0]
            await ctl.evaluate("() => { chrome.runtime.sendMessage({type: 'wayback:resolve', url: 'https://click.example.com/x', year: 2005}); }")
            await p1.wait_for_timeout(1200)
            cdx_at = [c[0] for c in LOG["cdx"] if c[1] == "https://click.example.com/x"]
            check("F11 a click's lookup does not wait behind a slow site check", bool(cdx_at) and cdx_at[0] - t_click < 1.0 and LOG["posts"] and cdx_at[0] < LOG["posts"][0][0] + 2.0,
                  f"click at {t_click:.2f}s, CDX at {cdx_at}, POST at {[x[0] for x in LOG['posts']]}")
            await p1.wait_for_timeout(2500)
            n1 = len(await p1.evaluate("() => [...document.querySelectorAll('#yy-root .yy-r')]"))
            n2 = len(await p2.evaluate("() => [...document.querySelectorAll('#yy-root .yy-r')]"))
            check("F11 two pages with the same sites at once: one request", len(LOG["posts"]) == 1, str([(t, len(h)) for t, s, h in LOG["posts"]]))
            check("F11 both pages get the answer", n1 == 5 and n2 == 5, f"{n1}, {n2}")
            await p1.close()
            await p2.close()

        # ------------------------------------------------------------ F9: an archive error is not cached
        if "degraded" in ONLY:
            print("=== degraded (F9)")
            page_url = "https://deep.example.net/a/b.html"
            reset(cdx=lambda q: (503, {"error": "x"}) if q["url"] == page_url else (200, rows(("20100505000000", q["url"], "200"))))
            await setst({**base, "year": 2010})
            pg = await ctx.new_page()
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2010&u={page_url}")
            note = await watch_note(pg, 12)
            await wait_url(pg, lambda x: "web.archive.org" in x or "notfound" in x, 12)
            check("F9 page 503 + front page ok: opens the front page with a truthful note", "did not answer" in note and "deep.example.net/" in pg.url, f"{note!r} -> {pg.url[:90]}")
            check("F9 the page was asked twice (quiet retry)", len([c for c in LOG["cdx"] if c[1] == page_url]) == 2, str([c[1] for c in LOG["cdx"]]))
            stored = await storage("wb2:2010:")
            check("F9 nothing cached for that page", f"wb2:2010:{page_url}" not in stored, str(list(stored))[:200])
            reset(cdx=lambda q: (200, rows200(("20100601000000", q["url"]))))
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2010&u={page_url}")
            await wait_url(pg, lambda x: "web.archive.org" in x, 10)
            check("F9 archive healthy again: the page itself", "20100601000000if_/https://deep.example.net/a/b.html" in pg.url, pg.url[:100])
            await pg.close()

        # ------------------------------------------------------------ F12: period look off, "over ten"
        if "overten" in ONLY:
            print("=== overten (F12)")
            hosts = [f"r{i}-f12.example.com" for i in range(1, 13)]
            reset(serp=serp(hosts), avail_delay=0.3, first={hosts[0]: "20060301000000"})
            await setst({**base, "year": 2005, "eraLook": False})
            pg = await ctx.new_page()
            await pg.goto("https://www.google.com/search?q=linux&tbs=cdr:1,cd_min:1/1/1990,cd_max:12/31/2005&udm=14")
            await pg.wait_for_timeout(2500)
            vis = await pg.evaluate("() => [...document.querySelectorAll('#rso div.g')].map(d => [d.querySelector('h3').textContent, getComputedStyle(d).display !== 'none', d.dataset.yyHidden || ''])")
            shown = [v[0] for v in vis if v[1]]
            check("F12 ten shown: result 11 moves up into the dropped site's place", len(shown) == 10 and "Result 11 at r11-f12.example.com" in shown, str([(v[0][:9], v[1], v[2]) for v in vis]))
            check("F12 the site first seen in 2006 stays hidden", not vis[0][1] and "did not exist" in vis[0][2], str(vis[0]))
            await pg.close()
            await setst({"eraLook": True})

        # ------------------------------------------------------------ F14: the day cut stays with the tab
        if "day" in ONLY:
            print("=== day (F14)")

            def cdx_day(q):
                ts = "20051111120000" if q["to"].startswith("20051111") else "20051231230000"
                return 200, rows((ts, q["url"], "200"))

            def replay_day(u):
                body = ('<!doctype html><html><body><h1>archived</h1>'
                        '<a id=logo href="https://web.archive.org/web/20051111120000/http://www.cnn.com/">CNN</a> '
                        '<a id=world href="https://web.archive.org/web/20051111120000/http://www.cnn.com/WORLD/">World</a></body></html>').encode()
                return 200, {"content-type": "text/html; charset=utf-8"}, body
            reset(cdx=cdx_day, replay=replay_day)
            await setst({**base, "year": 2005})
            pg = await ctx.new_page()
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2005&d=20051111&u=http://www.cnn.com/")
            await wait_url(pg, lambda x: "if_" in x, 10)
            check("F14 'Today in 2005' lands on that day", "20051111120000if_" in pg.url, pg.url[:90])
            await pg.click("#world")
            await wait_url(pg, lambda x: "WORLD" in x and "if_" in x, 12)
            await pg.wait_for_timeout(800)
            check("F14 a link inside keeps the day", "20051111120000if_/http://www.cnn.com/WORLD/" in pg.url, pg.url[:100])
            check("F14 its lookup is cut at the end of that day", [c[2] for c in LOG["cdx"] if "WORLD" in c[1]] == ["20051111235959"], str([(c[1], c[2]) for c in LOG["cdx"]]))
            await pg.click("#logo")
            await wait_url(pg, lambda x: "if_/http://www.cnn.com/" in x and "WORLD" not in x, 12)
            await pg.wait_for_timeout(800)
            check("F14 the logo goes back to the same day (cached pick)", "20051111120000if_/http://www.cnn.com/" in pg.url, pg.url[:100])
            await pg.close()

        # ------------------------------------------------------------ F6/F18: what counts as a result; Videos tab
        if "links" in ONLY:
            print("=== links (F6, F18)")
            html = ("""<!doctype html><html><body><div id=rso>
<div class=g><a href="https://www.alpha.example/a"><h3>Alpha result</h3></a><cite>https://www.alpha.example › a</cite><div class=VwiC3b>Alpha snippet text.</div></div>
<div class=g><a href="https://www.beta.example/b"><h3>Beta result</h3></a><cite>https://www.beta.example › b</cite><div class=VwiC3b>Beta snippet text.</div></div>
<li class=g><div><h3 class=r><a href="https://www.gamma.example/c">Gamma result</a></h3><div class=s>Gamma snippet text that is long enough.<br><cite>www.gamma.example/c</cite></div></div>
<h3 class=tbpr style="display:none"><a href="/search?q=linux&tbs=qdr:d">Get more results from the past 24 hours</a></h3></li>
<div class=g><a href="https://www.google.com/search?q=linux+kernel"><h3>Related: linux kernel</h3></a></div>
<div class=g><a href="https://www.delta.example/d"><h3>Delta without cite</h3></a><div class=VwiC3b>Delta snippet text.</div></div>
</div></body></html>""").encode()
            reset(serp=html)
            await setst({**base, "year": 2010, "strict": False})
            pg = await ctx.new_page()
            await pg.goto("https://www.google.com/search?q=linux&tbs=cdr:1,cd_min:1/1/1990,cd_max:12/31/2010&udm=14")
            await pg.wait_for_timeout(1500)
            got = await pg.evaluate("() => [...document.querySelectorAll('#yy-root .yy-r')].map(r => [r.querySelector('h3').textContent, (r.querySelector('.yy-url') || {}).textContent || ''])")
            names = [g[0] for g in got]
            check("F6 hidden heading and links to other searches are not results", names == ["Alpha result", "Beta result", "Gamma result", "Delta without cite"], str(names))
            check("F6 never a lone '/' URL line", all(not g[1].startswith("/") for g in got) and got[2][1].startswith("www.gamma.example/c"), str([g[1][:30] for g in got]))
            check("F6 no cite: the address comes from the link", got[3][1].startswith("www.delta.example/"), got[3][1][:40])
            vids = await pg.evaluate("() => [...document.querySelectorAll('#yy-root a.yy-tab')].filter(a => /Videos/.test(a.textContent)).map(a => a.href)")
            check("F18 Videos keeps the query", vids == ["https://www.youtube.com/results?search_query=linux"], str(vids))
            LOG["search"].clear()
            await setst({"strict": True}, wait=3500)     # the open page reloads by itself (F2: once, settled)
            names = await pg.evaluate("() => [...document.querySelectorAll('#yy-root .yy-r h3')].map(h => h.textContent)")
            check("F6 strict: the same four (all have an address)", names == ["Alpha result", "Beta result", "Gamma result", "Delta without cite"], str(names))
            check("F2 a Strict change reloads the open page once", len(LOG["search"]) == 1, str(LOG["search"]))
            await pg.close()

        # ------------------------------------------------------------ F17: archived sign-in forms
        if "signin" in ONLY:
            print("=== signin (F17)")
            form = (b'<!doctype html><html><body><form id=f method=post action="https://web.archive.org/web/20161111191313/https://accounts.google.com/AccountLoginInfo">'
                    b'<input name=Email value="someone@example.com"><input type=submit id=go value="Next"></form></body></html>')
            reset(cdx=lambda q: (200, rows(("20161111191254", "http://mail.google.com/", "200"))),
                  replay=lambda u: (200, {"content-type": "text/html"}, form) if "mail.google.com" in u else None)
            await setst({**base, "year": 2016})
            pg = await ctx.new_page()
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2016&d=20161111&u=http://mail.google.com/")
            note = await watch_note(pg, 8)
            check("F17 the Gmail tab warns before it opens", "Do not sign in here" in note, repr(note))
            await wait_url(pg, lambda x: "web.archive.org" in x, 10)
            await pg.wait_for_timeout(500)
            try:
                await pg.click("#go")
            except Exception:
                pass
            await pg.wait_for_timeout(1500)
            check("F17 the archived sign-in form cannot post", not LOG["signin"], f"posts seen: {LOG['signin']}, page: {pg.url[:80]}")
            # Strict off: no guard at all, only the always-on rule stands between the form and the archive
            await setst({"strict": False})
            form_page = "https://web.archive.org/web/20161111191254if_/http://mail.google.com/"

            async def submit():
                await pg.goto(form_page)
                await pg.wait_for_timeout(300)
                try:
                    await pg.click("#go")
                except Exception:
                    pass
                await pg.wait_for_timeout(1500)
            await submit()
            check("F17 strict off: the post is still blocked (rule 1001)", not LOG["signin"], f"posts seen: {LOG['signin']}, page: {pg.url[:80]}")
            await ctl.evaluate("() => chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds: [1001]})")
            await submit()
            check("F17 control: without rule 1001 the stub does see the post", len(LOG["signin"]) == 1, str(LOG["signin"]))
            await setst({"google": False})
            await setst({"google": True})       # syncRule puts rule 1001 back
            LOG["signin"].clear()
            await submit()
            check("F17 the rule is back after any settings sync", not LOG["signin"], str(LOG["signin"]))
            await setst({"strict": True})
            await pg.close()

        # ------------------------------------------------------------ F15/F10: resolver notes
        if "notes" in ONLY:
            print("=== notes (F15, F10)")

            def cdx_notes(q):
                if q["url"] == "https://blog.example/":
                    return 200, rows(("20100301000000", "https://blog.example/", "200"))
                if q["url"] == "http://groups.google.com/":
                    return 200, rows(("20190101000000", "http://groups.google.com/", "200"))
                return 200, []
            reset(cdx=cdx_notes)
            await setst({**base, "year": 2010})
            pg = await ctx.new_page()
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2010&u=https://blog.example/?p=123")
            note = await watch_note(pg, 8)
            check("F15 '/?p=123': says the page was not saved", "This page was not saved in 2010. Opening blog.example as it looked in 2010..." in note, repr(note))
            await wait_url(pg, lambda x: "web.archive.org" in x, 8)
            check("F15 then opens the front page of that year", "20100301000000if_/https://blog.example/" in pg.url, pg.url[:90])
            await pg.close()
            await setst({"year": 2024})
            pg = await ctx.new_page()
            await pg.goto(f"chrome-extension://{ext}/src/wayback/resolve.html#y=2024&d=20241111&u=http://groups.google.com/")
            note = await watch_note(pg, 8)
            check("F10 a copy years older than the day says how old it is", "The newest copy in the archive is from January 1, 2019." in note, repr(note))
            await pg.close()

        # ------------------------------------------------------------ F16: the 2011 black bar
        if "bar" in ONLY:
            print("=== bar (F16)")
            reset()
            await setst({**base, "year": 2011})
            pg = await ctx.new_page()
            await pg.goto("https://www.google.com/")
            await pg.wait_for_timeout(1200)
            names = await pg.evaluate("() => [...document.querySelectorAll('#yy-root .yy-blackbar .yy-tab')].map(a => a.textContent)")
            day = time.strftime("%m%d")
            if "2011" + day < "20120306":
                check("F16 2011: no Play or Drive yet, Documents and Calendar instead", "Play" not in names and "Drive" not in names and "Documents" in names and "Calendar" in names, str(names))
            await setst({"year": 2013}, wait=2500)       # the period homepage reloads by itself
            names = await pg.evaluate("() => [...document.querySelectorAll('#yy-root .yy-blackbar .yy-tab')].map(a => a.textContent)")
            check("F16 2013: Play and Drive", "Play" in names and "Drive" in names, str(names))
            await pg.close()

        # ------------------------------------------------------------ F11: 429 from the availability API
        if "busy" in ONLY:
            print("=== busy (F11)")
            reset(avail_status=429, avail_delay=0.2, cdx=lambda q: (200, rows200(("20040101000000", q["url"]))))
            await setst({**base, "year": 2005})
            for n in (1, 2):
                CFG["serp"] = serp([f"r{i}-busy{n}.example.com" for i in range(1, 6)])
                pg = await ctx.new_page()
                await pg.goto(f"https://www.google.com/search?q=page{n}&tbs=cdr:1,cd_min:1/1/1990,cd_max:12/31/2005&udm=14")
                await pg.wait_for_timeout(4500)
                shown = len(await pg.evaluate("() => [...document.querySelectorAll('#yy-root .yy-r')]"))
                check(f"F11 results page {n} after a 429 still shows its results", shown == 5, str(shown))
                await pg.close()
            check("F11 a 429: one request in all, no retry, and none while paused", len(LOG["posts"]) == 1, str([(t, s, len(h)) for t, s, h in LOG["posts"]]))
            t1 = time.time()
            await ctl.evaluate("() => { chrome.runtime.sendMessage({type: 'wayback:resolve', url: 'https://after429.example.com/x', year: 2005}); }")
            await ctl.wait_for_timeout(5000)
            check("F11 the next archive lookup waits (shared pause)", not LOG["cdx"], f"CDX within {time.time() - t1:.1f}s: {LOG['cdx']}")

        bad = sorted(set(x.split("/")[2] for x in LOG["other"]))
        print("aborted hosts:", bad)
        await ctx.close()
    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    for n in failed:
        print("  FAILED:", n)
    sys.exit(1 if failed else 0)


asyncio.run(main())
