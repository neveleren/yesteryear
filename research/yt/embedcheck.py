"""Check YouTube embed page server response for various Referer values / params.
Reports playability ERROR code (e.g. EMBEDDER_IDENTITY_MISSING_REFERRER) or OK.
"""
import re
import sys
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")


def check(url, referer=None):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9",
         "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate",
         "Sec-Fetch-Site": "cross-site"}
    if referer is not None:
        h["Referer"] = referer
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode("utf-8", "replace")
            code = r.status
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    m = re.search(r'PLAYABILITY_ERROR_CODE_([A-Z_]+)', html)
    err = m.group(1) if m else None
    m2 = re.search(r'\\"reason\\":\\"([^\\"]{0,80})', html)
    reason = m2.group(1) if m2 else None
    m3 = re.search(r'\\"playabilityStatus\\":\{\\"status\\":\\"([A-Z_]+)', html)
    st = m3.group(1) if m3 else None
    return f"HTTP {code} status={st} err={err} reason={reason!r}"


VID = sys.argv[1] if len(sys.argv) > 1 else "m_yqOoUMHPg"
cases = [
    ("youtube.com/embed, no Referer", f"https://www.youtube.com/embed/{VID}", None),
    ("youtube.com/embed, Referer https://example.com/", f"https://www.youtube.com/embed/{VID}", "https://example.com/"),
    ("youtube.com/embed, Referer chrome-extension://<id>/", f"https://www.youtube.com/embed/{VID}", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"),
    ("youtube.com/embed, Referer https://<id>.chromiumapp.org/", f"https://www.youtube.com/embed/{VID}", "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"),
    ("youtube.com/embed, Referer http://localhost:8080/", f"https://www.youtube.com/embed/{VID}", "http://localhost:8080/"),
    ("youtube.com/embed, Referer file:///C:/x.html", f"https://www.youtube.com/embed/{VID}", "file:///C:/x.html"),
    ("youtube.com/embed, no Referer, ?origin=https://example.com", f"https://www.youtube.com/embed/{VID}?origin=https://example.com", None),
    ("youtube.com/embed, no Referer, ?widget_referrer=https://example.com", f"https://www.youtube.com/embed/{VID}?widget_referrer=https://example.com", None),
    ("youtube.com/embed, no Referer, origin+widget_referrer+enablejsapi", f"https://www.youtube.com/embed/{VID}?enablejsapi=1&origin=https://example.com&widget_referrer=https://example.com", None),
    ("youtube-nocookie.com/embed, no Referer", f"https://www.youtube-nocookie.com/embed/{VID}", None),
    ("youtube-nocookie.com/embed, Referer https://example.com/", f"https://www.youtube-nocookie.com/embed/{VID}", "https://example.com/"),
    ("youtube.com/embed?playlist=ids (no list), Referer ok", f"https://www.youtube.com/embed/{VID}?playlist=UOF_7hSWSJg,LEG9feKeQMY", "https://example.com/"),
    ("youtube.com/embed?listType=search, Referer ok", "https://www.youtube.com/embed?listType=search&list=minecraft", "https://example.com/"),
]
for label, url, ref in cases:
    print(f"{label:70s} -> {check(url, ref)}")
