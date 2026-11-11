import sys; sys.stdout.reconfigure(encoding="utf-8")
import json, urllib.request, urllib.parse, time, re
from bs4 import BeautifulSoup
UA = {"User-Agent": "TimeMachineResearch/0.1 (https://github.com/neveleren; personal research script)"}
def get(url):
    for attempt in range(8):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                ra = e.headers.get("Retry-After"); wait = int(ra) if ra and ra.isdigit() else 10*(attempt+1)
                time.sleep(wait); continue
            raise
def grid(table):
    # expand rowspan/colspan into a rectangular grid of text
    out = []; pending = {}  # col -> (remaining, text)
    for tr in table.find_all("tr"):
        cells = tr.find_all(["td","th"])
        row = []; col = 0; ci = 0
        while ci < len(cells) or col in pending:
            if col in pending:
                rem, txt = pending[col]; row.append(txt)
                if rem - 1 <= 0: del pending[col]
                else: pending[col] = (rem-1, txt)
                col += 1; continue
            c = cells[ci]; ci += 1
            txt = c.get_text(" ", strip=True)
            rs = int(re.sub(r"\D","",c.get("rowspan","1")) or 1); cs = int(re.sub(r"\D","",c.get("colspan","1")) or 1)
            for k in range(cs):
                row.append(txt)
                if rs > 1: pending[col] = (rs-1, txt)
                col += 1
        out.append(row)
    return out
data = {}; report = []
for y in range(1946, 2026):
    params = {"action":"parse","page":f"Billboard Year-End Hot 100 singles of {y}","prop":"text|revid","format":"json","formatversion":"2","redirects":"1","maxlag":"5"}
    p = get("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params))["parse"]
    soup = BeautifulSoup(p["text"], "html.parser")
    tables = soup.select("table.wikitable")
    t = tables[0]
    g = grid(t)
    hdr = g[0]; rows = [r for r in g[1:] if r]
    rowspans = len(t.select("[rowspan]"))
    entries = []
    for r in rows:
        if len(r) < 3: continue
        title = r[1].strip().strip('"').strip("“”").strip()
        entries.append({"rank": r[0], "title": title, "artist": r[2]})
    data[y] = {"page": p["title"], "revid": p.get("revid"), "header": hdr, "entries": entries}
    report.append(f"{y}\t{p['title']}\tcols={hdr}\trows={len(entries)}\trowspan_cells={rowspans}\twikitables={len(tables)}")
    time.sleep(2)
json.dump(data, open("billboard_yearend_1946_2025.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
print("\n".join(report))
