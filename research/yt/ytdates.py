"""For a YouTube search query: list results and fetch exact publish dates
from each watch page (microformat publishDate/uploadDate, meta itemprop).

Usage: python ytdates.py "<query>" [sp|-] [max]
"""
import concurrent.futures as cf
import json
import re
import sys
import urllib.parse

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__ else ".")
from ytsearch import fetch, extract_initial_data, walk, text_of  # noqa: E402


def watch_dates(vid):
    try:
        _, html = fetch(f"https://www.youtube.com/watch?v={vid}")
    except Exception as e:  # noqa: BLE001
        return {"err": str(e)}
    out = {}
    m = re.search(r'"publishDate":"([^"]+)"', html)
    out["publishDate"] = m.group(1) if m else None
    m = re.search(r'"uploadDate":"([^"]+)"', html)
    out["uploadDate"] = m.group(1) if m else None
    m = re.search(r'<meta itemprop="datePublished" content="([^"]+)"', html)
    out["meta_datePublished"] = m.group(1) if m else None
    m = re.search(r'"dateText":\{"simpleText":"([^"]+)"', html)
    out["dateText"] = m.group(1) if m else None
    m = re.search(r'"publishDate":\{"simpleText":"([^"]+)"', html)
    out["descPublishDate"] = m.group(1) if m else None
    m = re.search(r'"playabilityStatus":\{"status":"([A-Z_]+)"', html)
    out["playability"] = m.group(1) if m else None
    m = re.search(r'"playableInEmbed":(true|false)', html)
    out["playableInEmbed"] = m.group(1) if m else None
    return out


def main():
    q = sys.argv[1]
    sp = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] not in ("", "-") else None
    mx = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    params = {"search_query": q}
    if sp:
        params["sp"] = sp
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode(params)
    _, html = fetch(url)
    data = extract_initial_data(html)
    rows = []
    seen = set()
    for v in walk(data, "videoRenderer"):
        vid = v.get("videoId")
        if vid in seen:
            continue
        seen.add(vid)
        rows.append((vid, text_of(v.get("publishedTimeText")), text_of(v.get("title"))))
        if len(rows) >= mx:
            break
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        dates = list(ex.map(lambda r: watch_dates(r[0]), rows))
    print(f"QUERY: {q!r} sp={sp} -> {len(rows)} videos")
    for (vid, rel, title), d in zip(rows, dates):
        pd = d.get("publishDate") or d.get("dateText") or d.get("err")
        print(f"{vid} | rel={rel} | publishDate={pd} | upload={d.get('uploadDate')} | "
              f"play={d.get('playability')} | {(title or '')[:50]}")


if __name__ == "__main__":
    main()
