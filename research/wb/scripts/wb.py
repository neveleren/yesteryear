"""Polite Wayback Machine research helper. Usage: python -I wb.py <phase> [args]

Every request: >= GAP seconds after the previous one (tracked across runs),
hard budget MAX_REQ, 429 -> honour Retry-After (default 65 s), max 1 retry.
"""
import sys, os, time, json, re, urllib.request, urllib.error, urllib.parse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")   # research/wb
DL = os.path.join(BASE, "dl")
STATE = os.path.join(BASE, "state.json")
LOG = os.path.join(BASE, "log.jsonl")
MAX_REQ = 60
GAP = 3.5
UA = "Mozilla/5.0 (compatible; wayback-research-script/0.1; low-volume, ~1 req per 3.5 s)"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPEN_NOFOLLOW = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
OPEN_FOLLOW = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def load_state():
    try:
        with open(STATE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"count": 0, "last": 0.0}


def save_state(s):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(s, f)


def fetch(url, label, method="GET", data=None, follow=False, timeout=150, headers=None):
    st = load_state()
    if st["count"] >= MAX_REQ:
        raise SystemExit("REQUEST BUDGET EXHAUSTED (%d)" % st["count"])
    for attempt in range(2):
        wait = st["last"] + GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        st["count"] += 1
        st["last"] = time.time()
        save_state(st)
        h = {"User-Agent": UA}
        h.update(headers or {})
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        t0 = time.perf_counter()
        err = None
        status, hdrs, body, ttfb = None, [], b"", None
        try:
            resp = (OPEN_FOLLOW if follow else OPEN_NOFOLLOW).open(req, timeout=timeout)
            ttfb = time.perf_counter() - t0
            status = resp.status
            hdrs = list(resp.headers.items())
            body = resp.read()
        except urllib.error.HTTPError as e:
            ttfb = time.perf_counter() - t0
            status = e.code
            hdrs = list(e.headers.items()) if e.headers else []
            try:
                body = e.read()
            except Exception:
                body = b""
        except Exception as e:
            err = repr(e)
        total = time.perf_counter() - t0
        st["last"] = time.time()
        save_state(st)
        rec = {"n": st["count"], "label": label, "method": method, "url": url, "status": status,
               "ttfb_s": round(ttfb, 3) if ttfb else None, "total_s": round(total, 3),
               "bytes": len(body), "err": err,
               "location": next((v for k, v in hdrs if k.lower() == "location"), None)}
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        fn = os.path.join(DL, re.sub(r"[^A-Za-z0-9_.-]", "_", label))
        with open(fn + ".body", "wb") as f:
            f.write(body)
        with open(fn + ".headers.json", "w", encoding="utf-8") as f:
            json.dump({"status": status, "headers": hdrs, "url": url}, f, indent=1)
        print("[#%d] %s %s -> %s ttfb=%s total=%.2fs bytes=%d loc=%s err=%s" % (
            st["count"], label, url, status, rec["ttfb_s"], total, len(body), rec["location"], err))
        if status == 429 and attempt == 0:
            ra = next((v for k, v in hdrs if k.lower() == "retry-after"), None)
            delay = int(ra) if (ra and ra.strip().isdigit()) else 65
            print("  429 received, sleeping %d s then one retry" % (delay + 5))
            time.sleep(delay + 5)
            continue
        return {"status": status, "headers": hdrs, "body": body, "ttfb": ttfb, "total": total, "err": err}
    return {"status": status, "headers": hdrs, "body": body, "ttfb": ttfb, "total": total, "err": err}


def hget(r, name):
    vals = [v for k, v in r["headers"] if k.lower() == name.lower()]
    return vals[0] if len(vals) == 1 else (vals or None)


CDX = "https://web.archive.org/cdx/search/cdx?"


def cdx_url(**params):
    # keep param order readable; allow repeated filter via list
    parts = []
    for k, v in params.items():
        if isinstance(v, list):
            for x in v:
                parts.append((k, x))
        else:
            parts.append((k, v))
    return CDX + urllib.parse.urlencode(parts, safe=":,*/")


def phase1():
    """CDX latest-200-capture-at-or-before-date + latency."""
    fl = "timestamp,original,statuscode,mimetype,digest,length"
    tests = [
        ("p1_google_2010", "google.com", "20101231235959"),
        ("p1_youtube_2008", "youtube.com", "20081231235959"),
        ("p1_wikipedia_2005", "en.wikipedia.org/wiki/Main_Page", "20051231235959"),
        ("p1_nytimes_2001", "nytimes.com", "20011231235959"),
        ("p1_myspace_2007", "myspace.com", "20071231235959"),
    ]
    for label, u, to in tests:
        url = cdx_url(url=u, to=to, filter="statuscode:200", limit="-1", fastLatest="true", output="json", fl=fl)
        r = fetch(url, label)
        print("   body:", r["body"][:400].decode("utf-8", "replace"))
    # comparisons on google.com
    url = cdx_url(url="google.com", to="20101231235959", filter="statuscode:200", limit="-1", output="json", fl=fl)
    r = fetch(url, "p1_google_2010_noFastLatest")
    print("   body:", r["body"][:400].decode("utf-8", "replace"))
    url = cdx_url(url="google.com", to="2010", filter="statuscode:200", limit="-1", fastLatest="true", output="json", fl=fl)
    r = fetch(url, "p1_google_to4digit")
    print("   body:", r["body"][:400].decode("utf-8", "replace"))
    url = cdx_url(url="google.com", to="20101231235959", limit="-3", fastLatest="true", output="json", fl=fl)
    r = fetch(url, "p1_google_2010_nofilter_last3")
    print("   body:", r["body"][:800].decode("utf-8", "replace"))


def phase2():
    """Availability API: can it return a capture AFTER the timestamp?"""
    r = fetch("https://archive.org/wayback/available?url=youtube.com&timestamp=20041231", "p2_avail_youtube_2004")
    print("   body:", r["body"][:600].decode("utf-8", "replace"))
    r = fetch("https://archive.org/wayback/available?url=youtube.com&timestamp=20041231&closest=before",
              "p2_avail_youtube_2004_closest_before")
    print("   body:", r["body"][:600].decode("utf-8", "replace"))
    payload = json.dumps([
        {"url": "youtube.com", "timestamp": "20041231"},
        {"url": "youtube.com", "timestamp": "20041231", "closest": "before"},
        {"url": "google.com", "timestamp": "20000101"},
    ]).encode()
    r = fetch("https://archive.org/wayback/available", "p2_avail_batch_post", method="POST", data=payload,
              headers={"Wayback-Api-Version": "2", "Content-Type": "application/json"})
    print("   body:", r["body"][:1500].decode("utf-8", "replace"))


def analyse_html(body):
    t = body
    def has(*needles):
        return any(n in t for n in needles)
    rewritten = len(re.findall(rb'(?:href|src|action)=["\']?(?:https?://web\.archive\.org)?/web/\d', t, re.I))
    orig_abs = len(re.findall(rb'(?:href|src|action)=["\']?https?://(?!web\.archive\.org)', t, re.I))
    return {
        "bytes": len(t),
        "toolbar_insert": has(b"BEGIN WAYBACK TOOLBAR INSERT", b'id="wm-ipp-base"', b"wm-ipp-base"),
        "playback_js(bundle-playback/wombat)": has(b"bundle-playback.js", b"wombat.js"),
        "__wm.init/__wm.wombat": has(b"__wm.init", b"__wm.wombat"),
        "ruffle": has(b"ruffle"),
        "footer 'FILE ARCHIVED ON'": has(b"FILE ARCHIVED ON"),
        "rewritten_attr_links(/web/<ts>)": rewritten,
        "original_absolute_links": orig_abs,
    }


def phase3(ts, orig):
    """URL modes on one capture: default, if_, id_, fw_, im_."""
    out = {}
    for mode in ["", "if_", "id_", "fw_", "im_"]:
        label = "p3_mode_" + (mode or "default")
        url = "https://web.archive.org/web/%s%s/%s" % (ts, mode, orig)
        r = fetch(url, label)
        a = analyse_html(r["body"])
        a["status"] = r["status"]
        a["content-type"] = hget(r, "Content-Type")
        a["memento-datetime"] = hget(r, "Memento-Datetime")
        a["x-archive-orig-* headers"] = sum(1 for k, v in r["headers"] if k.lower().startswith("x-archive-orig-"))
        a["location"] = hget(r, "Location")
        a["link_hdr_rels"] = re.findall(r'rel="([^"]+)"', str(hget(r, "Link") or ""))[:12]
        out[mode or "default"] = a
        print("   ", json.dumps(a))
    with open(os.path.join(BASE, "phase3_modes.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)


def links_from(label):
    with open(os.path.join(DL, label + ".body"), "rb") as f:
        t = f.read()
    hrefs = re.findall(rb'href=["\']?([^"\' >]+)', t, re.I)
    for h in hrefs:
        print("   ", h.decode("utf-8", "replace"))


def phase4(parent_ts, links):
    """Future-leak demo: Wayback redirects to the CLOSEST capture (may be later)."""
    r = fetch("https://web.archive.org/web/20041231235959/http://www.youtube.com/", "p4_youtube_at_2004")
    r = fetch("https://web.archive.org/web/2010/http://www.google.com/", "p4_google_4digit_2010")
    for i, l in enumerate(links):
        r = fetch("https://web.archive.org/web/%s/%s" % (parent_ts, l), "p4_innerlink_%d" % i)


def phase_video():
    r = fetch("https://web.archive.org/web/2oe_/http://wayback-fakeurl.archive.org/yt/jNQXAC9IVRw",
              "p4_yt_fakeurl_me_at_the_zoo", headers={"Range": "bytes=0-2047"})
    print("   ct:", hget(r, "Content-Type"), "len:", hget(r, "Content-Length"), "cr:", hget(r, "Content-Range"))


def phase5_cdx():
    fl = "timestamp,original,statuscode,mimetype,length"
    r = fetch(cdx_url(url="google.com", **{"from": "1998"}, to="2025", filter=["statuscode:200", "mimetype:text/html"],
                      collapse="timestamp:6", output="json", fl=fl), "p5_google_monthly", timeout=240)
    r = fetch(cdx_url(url="youtube.com", **{"from": "2005"}, to="2025", filter=["statuscode:200", "mimetype:text/html"],
                      collapse="timestamp:6", output="json", fl=fl), "p5_youtube_monthly", timeout=240)


def phase5_serp(*specs):
    """specs like 'prefix:www.google.com/search:300' or 'year:2005' or 'q:www.google.com/search?q=miserable'"""
    fl = "timestamp,original,statuscode,mimetype,length"
    for s in specs:
        kind, _, rest = s.partition(":")
        if kind == "prefix":
            u, _, lim = rest.rpartition(":")
            url = cdx_url(url=u, matchType="prefix", filter=["statuscode:200", "mimetype:text/html"], limit=lim,
                          output="json", fl=fl)
            label = "p5_serp_prefix_" + lim
        elif kind == "year":
            url = cdx_url(url="www.google.com/search", matchType="prefix", **{"from": rest}, to=rest,
                          filter=["statuscode:200", "mimetype:text/html"], limit="5", output="json", fl=fl)
            label = "p5_serp_year_" + rest
        elif kind == "q":
            url = cdx_url(url=rest, matchType="prefix", filter=["statuscode:200", "mimetype:text/html"],
                          collapse="timestamp:4", output="json", fl=fl)
            label = "p5_serp_q_" + re.sub(r"\W", "_", rest[-20:])
        r = fetch(url, label, timeout=240)
        print("   body:", r["body"][:1500].decode("utf-8", "replace"))


def verify(*items):
    """items: label|ts|orig  -> fetch id_ and report title + era markers"""
    for it in items:
        label, ts, orig = it.split("|", 2)
        r = fetch("https://web.archive.org/web/%sid_/%s" % (ts, orig), "v_" + label)
        b = r["body"]
        title = re.search(rb"<title[^>]*>(.*?)</title>", b, re.I | re.S)
        logos = re.findall(rb'(?:src|url)\(?=?["\']?([^"\' )>]*(?:logo|googlelogo|hpp|doodle|yt_)[^"\' )>]*)', b, re.I)[:4]
        serp = {
            "result_g_divs": len(re.findall(rb'class=["\']?g["\' >]', b)),
            "results_of_about": bool(re.search(rb"Results\s*<b>\s*1\s*</b>|of about|About [\d,]+ results", b)),
            "rso": b'id="rso"' in b or b"id=rso" in b,
        }
        print("   %s status=%s bytes=%d title=%r logos=%r serp=%s" % (
            label, r["status"], len(b), title.group(1)[:80] if title else None,
            [x.decode("utf-8", "replace") for x in logos], serp))


if __name__ == "__main__":
    ph = sys.argv[1]
    args = sys.argv[2:]
    if ph == "phase1":
        phase1()
    elif ph == "phase2":
        phase2()
    elif ph == "phase3":
        phase3(args[0], args[1])
    elif ph == "links":
        links_from(args[0])
    elif ph == "phase4":
        phase4(args[0], args[1:])
    elif ph == "video":
        phase_video()
    elif ph == "phase5_cdx":
        phase5_cdx()
    elif ph == "serp":
        phase5_serp(*args)
    elif ph == "verify":
        verify(*args)
    elif ph == "count":
        print(load_state())


def avail_batch(label, site, y0, y1, mmdd="0701"):
    items = [{"url": site, "timestamp": "%d%s" % (y, mmdd)} for y in range(int(y0), int(y1) + 1)]
    r = fetch("https://archive.org/wayback/available", label, method="POST", data=json.dumps(items).encode(),
              headers={"Wayback-Api-Version": "2", "Content-Type": "application/json"}, timeout=240)
    try:
        res = json.loads(r["body"])["results"]
    except Exception as e:
        print("   parse error", e, r["body"][:300])
        return
    for it in res:
        c = it.get("archived_snapshots", {}).get("closest") or {}
        print("   req=%s -> ts=%s status=%s url=%s" % (it.get("timestamp"), c.get("timestamp"), c.get("status"), c.get("url")))


if __name__ == "__main__" and sys.argv[1] == "avail_batch":
    avail_batch(*sys.argv[2:])


def latest_before(label, site, frm, to):
    fl = "timestamp,original,statuscode,mimetype,length"
    r = fetch(cdx_url(url=site, **{"from": frm}, to=to, filter="statuscode:200", limit="-1", fastLatest="true",
                      output="json", fl=fl), label)
    print("   body:", r["body"][:400].decode("utf-8", "replace"))


if __name__ == "__main__" and sys.argv[1] == "latest_before":
    latest_before(*sys.argv[2:])


def verify2(*items):
    """items: label|ts|orig -> fetch id_ (raw archived bytes) and report era markers"""
    for it in items:
        label, ts, orig = it.split("|", 2)
        r = fetch("https://web.archive.org/web/%sid_/%s" % (ts, orig), "v_" + label)
        b = r["body"]
        title = re.search(rb"<title[^>]*>(.*?)</title>", b, re.I | re.S)
        imgs = sorted(set(re.findall(rb'(?:src=|url\()["\']?([^"\' )>]+\.(?:gif|png|jpg|svg|webp))', b, re.I)))[:6]
        info = {
            "status": r["status"], "bytes": len(b), "mementoDT": hget(r, "Memento-Datetime"),
            "title": title.group(1)[:90].decode("utf-8", "replace").strip() if title else None,
            "imgs": [x.decode("utf-8", "replace")[:90] for x in imgs],
            "consent_page": bool(re.search(rb"Before you continue|consent\.google", b)),
            "captcha/sorry": bool(re.search(rb"/sorry/|unusual traffic", b)),
            "serp: class=g": len(re.findall(rb'class=["\']?g["\' >]', b)),
            "serp: id=rso/res": bool(re.search(rb'id=["\']?(rso|res)["\' >]', b)),
            "serp: 'Results 1 - 10'/'About N results'": bool(re.search(rb"Results\s*<b>\s*1\s*</b>|of about|About [\d,.]+ results", b)),
            "yt: Broadcast Yourself": b"Broadcast Yourself" in b,
            "yt: ytInitialData": b"ytInitialData" in b,
            "yt: watch?v= count": len(re.findall(rb"watch\?v=", b)),
        }
        print("   %s %s" % (label, json.dumps(info)))


if __name__ == "__main__" and sys.argv[1] == "verify2":
    verify2(*sys.argv[2:])


def avail_items(label, *pairs):
    items = []
    for p in pairs:
        u, _, ts = p.partition("|")
        items.append({"url": u, "timestamp": ts})
    r = fetch("https://archive.org/wayback/available", label, method="POST", data=json.dumps(items).encode(),
              headers={"Wayback-Api-Version": "2", "Content-Type": "application/json"}, timeout=240)
    for it in json.loads(r["body"])["results"]:
        c = it.get("archived_snapshots", {}).get("closest") or {}
        print("   %s @%s -> ts=%s status=%s url=%s" % (it.get("url"), it.get("timestamp"), c.get("timestamp"), c.get("status"), c.get("url")))


def cdx_years(label, site):
    fl = "timestamp,original,statuscode,mimetype,length"
    r = fetch(cdx_url(url=site, filter="statuscode:200", collapse="timestamp:4", output="json", fl=fl), label, timeout=240)
    print("   body:", r["body"][:2500].decode("utf-8", "replace"))


if __name__ == "__main__" and sys.argv[1] == "avail_items":
    avail_items(*sys.argv[2:])
if __name__ == "__main__" and sys.argv[1] == "cdx_years":
    cdx_years(*sys.argv[2:])


def video_follow():
    h = json.load(open(os.path.join(DL, "p4_yt_fakeurl_me_at_the_zoo.headers.json"), encoding="utf-8"))["headers"]
    loc = next(v for k, v in h if k.lower() == "location")
    r = fetch(loc, "p4_yt_video_bytes", headers={"Range": "bytes=0-2047"})
    print("   status", r["status"], "ct", hget(r, "Content-Type"), "cr", hget(r, "Content-Range"), "len", len(r["body"]), "magic", r["body"][:4])


if __name__ == "__main__" and sys.argv[1] == "video_follow":
    video_follow()
