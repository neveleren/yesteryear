"""Follow search continuations (pages 2..N) via youtubei/v1/search and
report relative dates of every video, to check if before: persists.

Usage: python ytcont.py "<query>" [pages]
"""
import json
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, ".")
from ytsearch import fetch, extract_initial_data, walk, text_of, UA  # noqa: E402


def cfg(html, key):
    m = re.search(r'"%s":"([^"]+)"' % key, html)
    return m.group(1) if m else None


def years_from_rel(rel):
    if not rel:
        return None
    m = re.match(r"(\d+)\s*(y|year)", rel)
    if m:
        return int(m.group(1))
    return 0  # months/days/hours -> recent


def list_videos(data):
    out = []
    for v in walk(data, "videoRenderer"):
        out.append((v.get("videoId"), text_of(v.get("publishedTimeText"))))
    return out


def next_token(data):
    for c in walk(data, "continuationCommand"):
        tok = c.get("token")
        if tok:
            return tok
    return None


def main():
    q = sys.argv[1]
    pages = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": q})
    _, html = fetch(url)
    data = extract_initial_data(html)
    client_version = cfg(html, "INNERTUBE_CLIENT_VERSION")
    visitor = cfg(html, "VISITOR_DATA")
    print("clientVersion", client_version, "visitorData?", bool(visitor))
    allv = []
    vids = list_videos(data)
    allv += vids
    print(f"page 1: {len(vids)} videos; rel years min={min((years_from_rel(r) for _, r in vids if r), default=None)}")
    tok = next_token(data)
    for p in range(2, pages + 1):
        if not tok:
            print("no continuation token")
            break
        body = {
            "context": {"client": {"clientName": "WEB", "clientVersion": client_version,
                                   "hl": "en", "gl": "US", "visitorData": visitor}},
            "continuation": tok,
        }
        req = urllib.request.Request(
            "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
            data=json.dumps(body).encode(),
            headers={"User-Agent": UA, "Content-Type": "application/json",
                     "Accept-Language": "en-US,en;q=0.9",
                     "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": client_version,
                     "Origin": "https://www.youtube.com", "Cookie": "SOCS=CAI; CONSENT=YES+1"})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode("utf-8"))
        vids = list_videos(d)
        allv += vids
        yrs = [years_from_rel(r) for _, r in vids if r]
        print(f"page {p}: {len(vids)} videos; rel strings: {sorted(set(r for _, r in vids if r))}")
        tok = next_token(d)
    yrs = [years_from_rel(r) for _, r in allv if r]
    print(f"TOTAL {len(allv)} videos; min years-ago={min(yrs) if yrs else None}; "
          f"count under 16y={sum(1 for y in yrs if y < 16)}")
    under = [(v, r) for v, r in allv if r and years_from_rel(r) < 15]
    print("suspicious (<15y):", under[:20])


if __name__ == "__main__":
    main()
