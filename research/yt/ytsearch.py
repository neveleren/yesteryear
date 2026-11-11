"""Fetch YouTube search results page and list videos from ytInitialData.

Usage: python ytsearch.py "<query>" [sp] [max]
"""
import json
import re
import sys
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")


def fetch(url, extra_headers=None):
    headers = {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        # EU consent bypass (harmless elsewhere)
        "Cookie": "SOCS=CAI; CONSENT=YES+1",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")


def extract_initial_data(html):
    m = re.search(r"var ytInitialData\s*=\s*(\{.*?\});\s*</script>", html, re.S)
    if not m:
        m = re.search(r'window\["ytInitialData"\]\s*=\s*(\{.*?\});', html, re.S)
    if not m:
        return None
    return json.loads(m.group(1))


def walk(obj, key):
    """Yield all dict values for a key, recursively."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            yield from walk(v, key)
    elif isinstance(obj, list):
        for it in obj:
            yield from walk(it, key)


def text_of(node):
    if not node:
        return None
    if isinstance(node, str):
        return node
    if "simpleText" in node:
        return node["simpleText"]
    if "runs" in node:
        return "".join(r.get("text", "") for r in node["runs"])
    if "content" in node:
        return node["content"]
    return json.dumps(node)[:80]


def main():
    q = sys.argv[1]
    sp = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] not in ("", "-") else None
    mx = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    params = {"search_query": q}
    if sp:
        params["sp"] = sp
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode(params)
    final, html = fetch(url)
    data = extract_initial_data(html)
    print(f"URL: {url}\nFINAL: {final}\nHTML bytes: {len(html)}")
    if data is None:
        print("NO ytInitialData")
        return
    # estimatedResults
    est = data.get("estimatedResults")
    print("estimatedResults:", est)
    # renderer types present
    vids = list(walk(data, "videoRenderer"))
    lockups = list(walk(data, "lockupViewModel"))
    print(f"videoRenderer count: {len(vids)}; lockupViewModel count: {len(lockups)}")
    seen = set()
    n = 0
    for v in vids:
        vid = v.get("videoId")
        if vid in seen:
            continue
        seen.add(vid)
        n += 1
        if n > mx:
            break
        title = text_of(v.get("title"))
        pub = text_of(v.get("publishedTimeText"))
        views = text_of(v.get("viewCountText"))
        owner = text_of(v.get("ownerText"))
        length = text_of(v.get("lengthText"))
        print(f"{n:2d}. {vid} | {pub} | {length} | {views} | {owner} | {title[:70] if title else ''}")
    # Also dump the filter chips / sp values if present
    if "--filters" in sys.argv:
        for g in walk(data, "searchFilterGroupRenderer"):
            gt = text_of(g.get("title"))
            for f in g.get("filters", []):
                fr = f.get("searchFilterRenderer", {})
                label = text_of(fr.get("label"))
                ep = fr.get("navigationEndpoint", {}).get("searchEndpoint", {})
                print(f"FILTER [{gt}] {label}: sp={ep.get('params')}")


if __name__ == "__main__":
    main()
