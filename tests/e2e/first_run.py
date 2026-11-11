"""First-impression walkthrough of Yesteryear, the way a new user meets it, judged like a picky user.

Loads extension/ directly (no copy, no patches) into a fresh Chromium profile (test-profile-e2e), headless,
viewport 1366x768, and walks the whole first run:
  1. tour    the install opens the tour tab by itself; Clippy through all 7 steps (waits for every glide and
             animation), finish, Close; "?" in the popup reopens it; Rover quickly. Every Next is timed and the
             guide's path is sampled every frame (jumps, late starts, layout of balloon / highlight / window).
  2. travel  popup as a tab (312x600, the real popup is 300 px + 6 px padding) -> quick year 2005 ->
             "Travel to 2005 >>" -> shots at ~1 s, ~3 s and the landing card; texts, the meme image, buttons;
             "Today in 2005: CNN" -> resolver -> archived CNN of that day; back to the card.
  3. google  "Search like it's 2005": www.google.com is a blank local stub, the extension draws the 2005
             homepage; a query is typed and submitted, /search is served from research/serp/<fixture>;
             the "News" tab opens the archived Google News of that day; Back.
  4. player  src/player/player.html as a tab (360x760) and the popup's mini player (Show player).
Nothing is played (Play would search YouTube from this machine). Console errors and warnings of every page and
of the service worker are collected, plus failed extension requests.

Network: www.google.com is answered locally (stub / fixture), every other Google or YouTube host is aborted;
only chrome-extension://, archive.org (a handful of CDX / availability calls) and upload.wikimedia.org (the
meme picture, one image) go out. Everything else is aborted and listed.

Usage (Git Bash, from the repo root; export PYTHONIOENCODING=utf-8 MSYS_NO_PATHCONV=1):
  .venv/Scripts/python.exe tests/e2e/first_run.py [fixture.html] [query] [--only=tour|--only=google]
  --only=tour    the tour part alone (no network); shots t_*.png
  --only=google  homepage + results for the fixture alone (no News); shots g_<fixture>_*.png
Probes next to it: probe_focus.py (keyboard focus on the tour's first screen), probe_miniplayer.py (mini player
width for every year), probe_miniplayer_fix.py (the one-line CSS fix, injected at run time).
Default fixture 2011_test.html with the query "test" (2008_custom.html is a Custom Search page without
<h3> titles, the parser finds no results there). Output: test-shots/e2e/*.png and test-shots/e2e/results.json.
"""
import datetime
import json
import re
import shutil
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
PROFILE = ROOT / "test-profile-e2e"
SHOTS = ROOT / "test-shots" / "e2e"
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
ONLY = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--only=")), None)   # "google": that part only
FIXTURE = ARGS[0] if len(ARGS) > 0 else "2011_test.html"
QUERY = ARGS[1] if len(ARGS) > 1 else "test"
PREFIX = {"google": f"g_{Path(FIXTURE).stem}_", "tour": "t_"}.get(ONLY, "")
YEAR = 2005
VIEW = {"width": 1366, "height": 768}
POPUP_VIEW = {"width": 312, "height": 600}   # Chrome caps a toolbar popup at 800 x 600
PLAYER_VIEW = {"width": 360, "height": 760}
LIMITS = {"next_ms": 2500, "motion_start_ms": 700, "start_ms": 4500, "finish_ms": 4500, "travel_card_ms": 6000}
sys.stdout.reconfigure(encoding="utf-8")

BLANK = b"<!doctype html><html><head><title>Google</title></head><body></body></html>"
FIXTURE_HTML = (ROOT / "research" / "serp" / FIXTURE).read_bytes()
ALLOWED = ("https://web.archive.org/", "https://archive.org/", "https://web-static.archive.org/",
           "https://upload.wikimedia.org/")

# The tour's highlight boxes (src/tour/tour_core.js STEPS[].boxes), to check the marching ants sit on them.
STEP_BOXES = [
    [[".window"]],
    [[".dial", ".slider-row", ".quick"]],
    [["#travel"], [".master"]],
    [[".pair"]],
    [[".field-row:has(#opt-strict)", ".field-row:has(#opt-eraLook)"]],
    [["#mini-player"]],
    [[".master"], ["#help"]],
]


# ---- report ------------------------------------------------------------------------------------------
class Report:
    def __init__(self):
        self.checks, self.timings, self.notes, self.console, self.requests = [], [], [], [], []
        self.blocked, self.google_hits, self.page_errors = [], [], []

    def check(self, module, ok, what, shot=None, info=None):
        self.checks.append({"module": module, "ok": bool(ok), "what": what, "shot": shot, "info": info})
        tail = f"  [{shot}]" if shot else ""
        print(("ok    " if ok else "FAIL  ") + f"{module:7} {what}" + (f" -- {info}" if info not in (None, "") else "") + tail, flush=True)
        return ok

    def timing(self, module, name, ms, limit=None):
        slow = limit is not None and ms is not None and ms > limit
        self.timings.append({"module": module, "name": name, "ms": None if ms is None else round(ms), "limit": limit, "slow": slow})
        print(f"time  {module:7} {name}: {'n/a' if ms is None else f'{ms:.0f} ms'}" + ("  SLOW" if slow else ""), flush=True)

    def note(self, text):
        self.notes.append(text)
        print("note  " + text, flush=True)


R = Report()
ANCHOR = []   # the browser's first tab: waits go through it, because time.sleep() would stop Playwright's events
SHOTS.mkdir(parents=True, exist_ok=True)
if not ONLY:
    for old in SHOTS.glob("[0-9]*.png"):
        old.unlink()


def shot(page, name, **kw):
    name = PREFIX + name
    path = SHOTS / f"{name}.png"
    try:
        page.screenshot(path=str(path), **kw)
    except Exception as e:  # a page that closed or navigated in the middle
        R.note(f"screenshot {name} failed: {e}")
    return f"test-shots/e2e/{name}.png"


def idle(ms):
    """Waits while Playwright keeps processing events (new tabs, navigations, closes)."""
    ANCHOR[0].wait_for_timeout(ms)


def guarded(module, label):
    """Runs a part of the walk; an exception is a failed check, the walk goes on."""
    def wrap(fn):
        def run(*a, **kw):
            try:
                return fn(*a, **kw)
            except Exception as e:
                R.check(module, False, f"{label}: exception", info=f"{type(e).__name__}: {str(e)[:300]}")
                traceback.print_exc()
                return None
        return run
    return wrap


# ---- page probes (JS) ------------------------------------------------------------------------------------
CUT_JS = r"""(skip) => {
  const out = [];
  const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 3).join('.') : '');
  for (const el of document.querySelectorAll('body *')) {
    if (skip && el.closest(skip)) continue;
    if (el.closest('[hidden]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue;  // screen-reader-only text (1 px boxes)
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const hidX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const hidY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    const cutX = hidX && el.scrollWidth > el.clientWidth + 1;
    const cutY = hidY && el.scrollHeight > el.clientHeight + 1;
    const offRight = r.right > innerWidth + 1 && r.left < innerWidth;
    if (cutX || cutY || offRight) out.push({ el: desc(el), text: text.replace(/\s+/g, ' ').slice(0, 90), ellipsis: cs.textOverflow === 'ellipsis',
      x: cutX ? [el.scrollWidth, el.clientWidth] : null, y: cutY ? [el.scrollHeight, el.clientHeight] : null, offRight: offRight ? Math.round(r.right - innerWidth) : 0 });
  }
  const se = document.scrollingElement || document.documentElement;
  return { cut: out.slice(0, 40), hscroll: se.scrollWidth > innerWidth + 1, vscroll: se.scrollHeight > innerHeight + 1,
           docW: se.scrollWidth, docH: se.scrollHeight, vw: innerWidth, vh: innerHeight };
}"""

BROKEN_IMG_JS = r"""() => [...document.images].filter((i) => { const r = i.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && i.complete && i.naturalWidth === 0; }).map((i) => (i.currentSrc || i.src).slice(0, 140))"""

YEARS_JS = r"""([maxYear, scope]) => {
  const out = [];
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue;
    if (!t || !/\d{4}/.test(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest('[hidden]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    for (const m of t.matchAll(/(?<![\d,.])(199\d|20[0-4]\d)(?![\d,])/g)) {
      if (Number(m[1]) > maxYear) out.push({ year: Number(m[1]), text: t.trim().replace(/\s+/g, ' ').slice(0, 110), el: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') });
    }
  }
  return out.slice(0, 20);
}"""

DASH_JS = r"""(scope) => { const root = scope ? document.querySelector(scope) : document.body; if (!root) return [];
  const t = root.innerText || ''; const out = []; for (const m of t.matchAll(/.{0,40}[—–].{0,40}/g)) out.push(m[0]); return out.slice(0, 10); }"""

TOUR_LAYOUT_JS = r"""(sets) => {
  const R = (el) => { if (!el || el.hidden) return null; const b = el.getBoundingClientRect(); if (!b.width && !b.height) return null;
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const frame = document.getElementById('replica');
  const doc = frame.contentDocument;
  const f = frame.getBoundingClientRect();
  const inner = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 ?
    { x: Math.round(f.left + b.left), y: Math.round(f.top + b.top), w: Math.round(b.width), h: Math.round(b.height) } : null; };
  const expected = (sets || []).map((sels) => { const rs = [];
    for (const s of sels) for (const el of doc.querySelectorAll(s)) { const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) rs.push({ x: f.left + b.left, y: f.top + b.top, r: f.left + b.right, b: f.top + b.bottom }); }
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y)), r = Math.max(...rs.map((r) => r.r)), b = Math.max(...rs.map((r) => r.b));
    return { x: Math.round(x - 4), y: Math.round(y - 4), w: Math.round(r - x + 8), h: Math.round(b - y + 8) }; });
  const balloon = document.querySelector('.yy-balloon');
  const tail = balloon && balloon.querySelector('.yy-balloon-tail');
  let tip = null;
  if (balloon && !balloon.hidden && tail) {
    const t = tail.getBoundingClientRect();
    const flip = /scaleX\(-1\)/.test(tail.style.transform);
    tip = { x: Math.round(flip ? t.right - 6 : t.left + 6), y: Math.round(balloon.dataset.side === 'bottom' ? t.top : t.bottom) };
  }
  const open = balloon && !balloon.hidden;
  const stage = document.getElementById('stage').getBoundingClientRect();
  return {
    title: document.getElementById('tour-title')?.textContent || null,
    text: open ? balloon.querySelector('.yy-step > p:not(.hint)')?.textContent : null,
    hint: open ? (balloon.querySelector('.yy-step .hint')?.textContent || '') : null,
    buttons: open ? [...balloon.querySelectorAll('button')].map((b) => (b.disabled ? '(' + b.textContent + ')' : b.textContent)) : [],
    side: balloon?.dataset.side || null, balloon: R(balloon), agent: R(document.querySelector('.yy-agent')),
    window: inner(doc && doc.querySelector('.window')), frame: { x: Math.round(f.left), y: Math.round(f.top), w: Math.round(f.width), h: Math.round(f.height) },
    frameDoc: doc ? { w: doc.documentElement.scrollWidth, h: doc.documentElement.scrollHeight } : null,
    ants: [...document.querySelectorAll('.yy-ants')].map(R), expected, tip,
    stage: { w: Math.round(stage.width), h: Math.round(stage.height) }, vw: innerWidth, vh: innerHeight,
    sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
    focus: document.activeElement?.id || document.activeElement?.tagName,
    replicaLcd: doc?.getElementById('lcd')?.getAttribute('aria-label'), replicaStatus: doc?.getElementById('status')?.textContent,
  };
}"""

# Samples the guide's position every frame from the click on `trigger` until `until` shows (+600 ms).
ARM_SAMPLER_JS = r"""([trigger, until]) => {
  const s = window.__samp = { clickAt: null, visibleAt: null, samples: [], done: false, timeout: false };
  const target = () => document.querySelector(until);
  const shown = () => { const el = target(); return !!el && !el.hidden && el.getBoundingClientRect().width > 0; };
  const onClick = (e) => { if (s.clickAt === null && e.target.closest(trigger)) s.clickAt = performance.now(); };
  document.addEventListener('click', onClick, true);
  const pos = () => { const el = document.querySelector('.yy-agent');
    const m = el && /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(el.style.transform || '');
    return m ? [Number(m[1]), Number(m[2]), el.hidden ? 0 : 1] : null; };
  const tick = () => {
    const now = performance.now();
    if (s.clickAt !== null) {
      const p = pos();
      s.samples.push([Math.round(now - s.clickAt), p ? p[0] : null, p ? p[1] : null, shown() ? 1 : 0, p ? p[2] : 0]);
      if (s.visibleAt === null && shown() && now - s.clickAt > 30) s.visibleAt = now;
      if (s.visibleAt !== null && now - s.visibleAt > 600) { s.done = true; document.removeEventListener('click', onClick, true); return; }
      if (now - s.clickAt > 12000) { s.done = true; s.timeout = true; return; }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}"""

SPRITE_JS = "() => { const l = document.querySelector('.yy-agent-layer'); return l ? l.style.backgroundPosition + '|' + (l.hidden ? 'h' : '') : null; }"

ODO_JS = r"""() => {
  const strips = [...document.querySelectorAll('.odo .strip')];
  const odo = strips.map((s) => { const m = /translate3d\(0(?:px)?, (-?[\d.]+)%/.exec(s.style.transform || ''); if (!m) return '?';
    return String(Math.round(-Number(m[1]) * 11 / 100) % 10); }).join('');
  return { phase: document.documentElement.dataset.phase, odo, mph: document.querySelector('.mph')?.textContent,
    hudTitle: document.querySelector('.hud-title')?.textContent, readouts: [...document.querySelectorAll('.readout')].map((r) => r.textContent),
    skip: document.getElementById('skip')?.textContent, title: document.title, t: Math.round(performance.now()),
    era: document.documentElement.dataset.era, direction: document.documentElement.dataset.direction };
}"""

LANDING_JS = r"""() => {
  const q = (s) => document.querySelector(s);
  const t = (s) => (q(s)?.textContent || '').trim() || null;
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const img = q('.pic .pic-main') || q('.pic img');   // .pic-bg is the blurred fill behind it
  const bg = q('.pic .pic-bg');
  const desk = q('.desktop');
  return {
    era: document.documentElement.dataset.era, phase: document.documentElement.dataset.phase, title: document.title,
    winTitle: t('#win-title'), h1: t('.hero h1'), date: t('.hero .date'),
    memeBox: t('.meme .box-title'), meme: t('.meme-title'), blurb: t('.meme-blurb'), credit: q('.meme .credit')?.href || null,
    img: img ? { src: (img.currentSrc || img.src).slice(0, 120), complete: img.complete, w: img.naturalWidth, h: img.naturalHeight, box: R(img), pic: R(q('.pic')),
                 bg: bg ? { w: bg.naturalWidth, box: R(bg) } : null } : (q('.pic.broken') ? 'broken' : null),
    songBox: t('.song .box-title'), song: t('.song-title'), artist: t('.song-artist'), songSmall: t('.song .small'),
    factsBox: t('.facts .box-title'), facts: [...document.querySelectorAll('.facts li')].map((li) => li.textContent),
    gadgetBox: t('.gadget .box-title'), gadget: t('.gadget-name'),
    buttons: [...document.querySelectorAll('.actions button')].map((b) => ({ text: b.textContent, disabled: b.disabled, box: R(b) })),
    today: [...document.querySelectorAll('.today a')].map((a) => ({ text: a.textContent, href: a.getAttribute('href').replace(/^chrome-extension:\/\/[^/]+/, ''), target: a.target, box: R(a) })),
    todayLabel: t('.today-label'), status: t('.status'), replay: t('.foot .linkish'), replayBox: R(q('.foot .linkish')),
    taskbar: { start: t('.taskbar .start'), task: t('.taskbar .task'), clock: t('.taskbar .clock'), search: t('.taskbar .search') },
    win: R(q('.win')), taskbarBox: R(q('.taskbar')),
    desktop: desk ? { sh: desk.scrollHeight, ch: desk.clientHeight, sw: desk.scrollWidth, cw: desk.clientWidth } : null,
    vw: innerWidth, vh: innerHeight, landingHidden: q('#landing')?.hidden, tripHidden: q('#trip')?.hidden,
    focus: document.activeElement?.tagName + (document.activeElement?.className ? '.' + document.activeElement.className : ''),
  };
}"""

GOOGLE_JS = r"""() => {
  const root = document.getElementById('yy-root');
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  if (!root) return { root: false, url: location.href, title: document.title };
  const logo = root.querySelector('.yy-logo');
  const img = logo && logo.querySelector('img');
  return {
    root: true, url: location.href, era: document.documentElement.dataset.yyEra, title: document.title,
    logo: img ? { w: img.naturalWidth, h: img.naturalHeight, box: R(img) } : (logo ? 'text logo ' + logo.textContent : null),
    nav: [...root.querySelectorAll('.yy-links > *, .yy-folders > *, .yy-topnav > .yy-tab, .yy-tabsline > *')].map((a) => a.textContent + (a.tagName === 'A' ? '' : '*')),
    navHrefs: [...root.querySelectorAll('.yy-links a, .yy-folders a, .yy-topnav a')].map((a) => [a.textContent, (a.getAttribute('href') || '').replace(/^chrome-extension:\/\/[^/]+/, '')]),
    buttons: [...root.querySelectorAll('input[type=submit]')].map((b) => b.value), input: R(root.querySelector('input[name=q]')),
    under: root.querySelector('.yy-under')?.textContent || null, foot: root.querySelector('.yy-homefoot, .yy-footer')?.textContent || null,
    focus: document.activeElement?.name || document.activeElement?.tagName,
    stats: root.querySelector('.yy-stats')?.textContent || null,
    nomatch: root.querySelector('.yy-nomatch')?.textContent || null,
    results: [...root.querySelectorAll('.yy-r')].map((r) => ({ title: r.querySelector('h3')?.textContent, href: (r.querySelector('h3 a')?.href || '').slice(0, 100),
      url: r.querySelector('.yy-url .yy-green, .yy-url, cite')?.textContent, snippet: (r.querySelector('.yy-snippet')?.textContent || '').slice(0, 160) })),
    pager: (root.querySelector('.yy-pager')?.textContent || '').replace(/\s+/g, ' ').trim() || null,
    others: [...document.body.children].filter((c) => c.id !== 'yy-root' && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0).map((c) => c.tagName + (c.id ? '#' + c.id : '')).slice(0, 6),
    rootBox: R(root),
  };
}"""

PLAYER_JS = r"""() => {
  const t = (id) => (document.getElementById(id)?.textContent || '').trim();
  const rows = [...document.querySelectorAll('#list li')];
  return { skin: document.body.dataset.skin, app: t('app-name'), yearTag: t('year-tag'), idle: t('idle'), idleHidden: document.getElementById('idle')?.hidden,
    track: t('track'), sub: t('sub'), time: t('time'), status: t('status'), plTitle: t('pl-title'), plCount: t('pl-count'),
    rows: rows.length, first: rows[0]?.textContent, current: document.querySelector('#list li.current')?.textContent || null,
    hide: t('hide'), play: document.getElementById('play')?.getAttribute('aria-label'), title: document.title,
    plHead: (() => { const h = document.querySelector('.pl-head'); return h ? [h.scrollWidth, h.clientWidth] : null; })() };
}"""

POPUP_JS = r"""() => {
  const t = (id) => (document.getElementById(id)?.textContent || '').trim();
  const se = document.scrollingElement;
  return { lcd: document.getElementById('lcd')?.getAttribute('aria-label'), flag: t('lcd-flag'), travel: t('travel'), status: t('status'), sites: t('sites'),
    note: document.getElementById('note')?.hidden ? null : t('note'), legend: t('mp-legend'), mpText: t('mp-text'), mpTime: t('mp-time'),
    mpScroll: document.getElementById('mp-marquee')?.classList.contains('scroll'), showDisabled: document.getElementById('mp-show')?.disabled,
    play: document.getElementById('mp-play')?.getAttribute('aria-label'),
    pressed: [...document.querySelectorAll('#quick button[aria-pressed=true]')].map((b) => b.textContent),
    checks: Object.fromEntries([...document.querySelectorAll('input[type=checkbox]')].map((c) => [c.id, c.checked])),
    slider: document.getElementById('year')?.value, docW: se.scrollWidth, docH: se.scrollHeight, bodyH: Math.ceil(document.body.getBoundingClientRect().height),
    loading: document.documentElement.classList.contains('loading') };
}"""


MINI_JS = r"""() => { const b = document.querySelector('.window-body').getBoundingClientRect(); const w = document.querySelector('.window').getBoundingClientRect();
  const f = document.getElementById('mini-player').getBoundingClientRect(); const s = document.getElementById('mp-show').getBoundingClientRect();
  return { fieldsetOver: Math.round(f.right - b.right), showOver: Math.round(s.right - w.right), docW: document.scrollingElement.scrollWidth,
           marqueeScrolls: document.getElementById('mp-marquee').classList.contains('scroll'), text: document.getElementById('mp-text').textContent }; }"""


def mini_inside(page, label, shot_path):
    m = page.evaluate(MINI_JS)
    ok = m["fieldsetOver"] <= 0 and m["showOver"] <= 0 and m["docW"] <= POPUP_VIEW["width"]
    R.check("player", ok, f"{label}: the mini player stays inside the Yesteryear window", shot_path,
            None if ok else f"box sticks out {m['fieldsetOver']} px, Show player {m['showOver']} px past the frame, page {m['docW']} px wide; "
            f"line {m['text']!r} scrolls: {m['marqueeScrolls']}")
    return m


def overlap(a, b):
    if not a or not b:
        return 0
    w = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    h = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return max(0, w) * max(0, h)


def inside(a, w, h, slack=0):
    return bool(a) and a["x"] >= -slack and a["y"] >= -slack and a["x"] + a["w"] <= w + slack and a["y"] + a["h"] <= h + slack


def page_checks(page, module, label, shot_path, skip=None, max_year=None, year_scope=None, dash_scope=None, cut_ok=(), archived=False):
    """Cut text, sideways scrolling, broken images, years after `max_year`, long dashes."""
    info = page.evaluate(CUT_JS, skip)
    cut = [c for c in info["cut"] if not any(k in c["el"] for k in cut_ok)]
    hard = [c for c in cut if not c["ellipsis"]]
    R.check(module, not hard, f"{label}: no cut-off text", shot_path, hard[:4] or None)
    soft = [c for c in cut if c["ellipsis"]]
    if soft:
        R.note(f"{label}: text shortened with an ellipsis: {soft[:4]}")
    R.check(module, not info["hscroll"], f"{label}: no sideways scrolling", shot_path,
            None if not info["hscroll"] else f"page {info['docW']} px wide in a {info['vw']} px window")
    broken = page.evaluate(BROKEN_IMG_JS)
    if archived:   # an archived page: pictures the Internet Archive never saved stay empty, as they would anywhere
        if broken:
            R.note(f"{label}: {len(broken)} images the archive did not save")
    else:
        R.check(module, not broken, f"{label}: no broken images", shot_path, broken or None)
    if max_year:
        later = page.evaluate(YEARS_JS, [max_year, year_scope])
        R.check(module, not later, f"{label}: no year after {max_year} on screen", shot_path, later[:5] or None)
    if dash_scope is not None:
        dashes = page.evaluate(DASH_JS, dash_scope or None)
        R.check(module, not dashes, f"{label}: no long dashes in the copy", shot_path, dashes or None)
    return info


def ext_page(url):
    return url.startswith("chrome-extension://")


def near_day(ts, day, days_before=3):
    """A Wayback timestamp on `day` or at most `days_before` days earlier."""
    if not ts or not re.fullmatch(r"\d{14}", ts):
        return False
    got = datetime.date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))
    return 0 <= (day - got).days <= days_before


# ---- the walk -----------------------------------------------------------------------------------------------
def main():
    shutil.rmtree(PROFILE, ignore_errors=True)
    t_launch = time.monotonic()
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), channel="chromium", headless=True,
            args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--lang=en-US"],
            locale="en-US", viewport=VIEW)

        own_aborts = set()

        def serve(route):
            url = route.request.url
            host = urlparse(url).hostname or ""
            if url.startswith(("chrome-extension://", "data:", "blob:")):
                route.continue_()
            elif host == "www.google.com":
                path = urlparse(url).path
                R.google_hits.append(url[:160])
                if path == "/search":
                    route.fulfill(status=200, body=FIXTURE_HTML, headers={"content-type": "text/html; charset=utf-8"})
                elif path in ("/", "/webhp", "/imghp"):
                    route.fulfill(status=200, body=BLANK, headers={"content-type": "text/html; charset=utf-8"})
                elif path.startswith("/s2/favicons"):
                    route.fulfill(status=200, body=b"", headers={"content-type": "image/png"})
                else:
                    route.fulfill(status=404, body=b"", headers={"content-type": "text/plain"})
            elif url.startswith(ALLOWED):
                route.continue_()
            else:
                own_aborts.add(url)
                R.blocked.append(f"{route.request.resource_type} {url[:140]}")
                route.abort()

        ctx.route("**/*", serve)
        ANCHOR.append(ctx.pages[0] if ctx.pages else ctx.new_page())

        def on_console(msg):
            if msg.type not in ("error", "warning"):
                return
            if msg.worker is not None:
                src = "service worker"
            elif msg.page is not None:
                src = msg.page.url[:120]
            else:
                src = "?"
            loc = msg.location or {}
            R.console.append({"type": msg.type, "source": src, "text": msg.text[:400], "at": f"{loc.get('url', '')[:110]}:{loc.get('lineNumber', '')}"})

        ctx.on("console", on_console)
        ctx.on("weberror", lambda e: R.page_errors.append({"page": (e.page.url[:120] if e.page else "?"), "error": str(e.error)[:400]}))
        ctx.on("requestfailed", lambda req: None if req.url in own_aborts else R.requests.append(
            {"failed": req.url[:160], "why": req.failure, "type": req.resource_type}))
        ctx.on("response", lambda res: R.requests.append({"status": res.status, "url": res.url[:160]})
               if res.status >= 400 and (res.url.startswith("chrome-extension://") or "/cdx/" in res.url or "/wayback/available" in res.url) else None)

        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        base = f"chrome-extension://{ext_id}"
        print("extension", ext_id, flush=True)

        def hook_sw():
            for w in ctx.service_workers:
                try:
                    w.evaluate("""() => { if (self.__e2e) return; self.__e2e = [];
                        const push = (kind, text) => { try { self.__e2e.push({ kind, text: String(text).slice(0, 500) }); } catch (_) {} };
                        self.addEventListener('error', (e) => push('error', `${e.message} at ${e.filename}:${e.lineno}`));
                        self.addEventListener('unhandledrejection', (e) => push('unhandledrejection', (e.reason && (e.reason.stack || e.reason.message)) || e.reason)); }""")
                except Exception as e:
                    R.note(f"could not hook the service worker: {e}")

        hook_sw()
        sw_eval = lambda js, arg=None: ctx.service_workers[0].evaluate(js, arg) if ctx.service_workers else None

        welcome_url = f"{base}/src/tour/welcome.html"
        popup_url = f"{base}/src/ui/popup.html"

        # =========================== 1. tour ===========================
        welcome = None
        for _ in range(150):
            welcome = next((pg for pg in ctx.pages if pg.url.startswith(welcome_url)), None)
            if welcome:
                break
            idle(100)
        R.check("tour", welcome is not None, "install opens the tour tab by itself",
                info=f"after {1000 * (time.monotonic() - t_launch):.0f} ms from launch")
        if welcome is None:
            welcome = ctx.new_page()
            welcome.goto(welcome_url)
        active = sw_eval("""async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t ? (t.url || t.pendingUrl) : null; }""")
        R.check("tour", bool(active) and active.startswith(welcome_url), "the tour tab is the active tab (the user sees it)", info=active)
        badge = sw_eval("async () => [await chrome.action.getBadgeText({}), await chrome.action.getTitle({})]")
        R.check("core", badge and badge[0] == "OFF", "toolbar badge says OFF after install", info=badge)

        if ONLY == "google":
            gp = ctx.new_page()
            gp.goto(popup_url)
            gp.evaluate("y => chrome.storage.local.set({ enabled: true, year: y, google: true, strict: true, eraLook: true })", YEAR)
            gp.wait_for_timeout(800)
            google_flow(ctx, gp, sw_eval, from_card=False)
            ctx.close()
            summarize()
            return
        tour_first(welcome)
        rover_page = tour_reopen_and_rover(ctx, base, popup_url, welcome_url)
        if rover_page and not rover_page.is_closed():
            rover_page.close()
        if ONLY == "tour":   # the tour alone: no network at all
            ctx.close()
            summarize()
            return

        # =========================== 2. popup + travel ===========================
        hook_sw()
        travel = popup_and_travel(ctx, base, popup_url, sw_eval)

        # =========================== 3. Google ===========================
        if travel and not travel.is_closed():
            google_flow(ctx, travel, sw_eval)

        # =========================== 4. player ===========================
        player_flow(ctx, base, popup_url, sw_eval)

        # ---- errors from the service worker hook ----
        for w in ctx.service_workers:
            try:
                for e in w.evaluate("() => self.__e2e || []"):
                    R.console.append({"type": e["kind"], "source": "service worker (hook)", "text": e["text"], "at": ""})
            except Exception as e:
                R.note(f"could not read the service worker hook: {e}")
        ctx.close()

    summarize()


# ---- 1. tour ------------------------------------------------------------------------------------------------
def tour_step_checks(page, agent, i, layout, shot_path, quick=False):
    L = layout
    vw, vh = L["vw"], L["stage"]["h"]
    b, a, win = L["balloon"], L["agent"], L["window"]
    title = L["title"] or ""
    R.check("tour", f"{i + 1} of 7" in title, f"{agent} step {i + 1}: balloon title '{title}'", shot_path)
    R.check("tour", inside(b, vw, vh), f"{agent} step {i + 1}: balloon fully on screen", shot_path, None if inside(b, vw, vh) else {"balloon": b, "stage": L["stage"]})
    R.check("tour", inside(a, vw, vh), f"{agent} step {i + 1}: guide fully on screen", shot_path, None if inside(a, vw, vh) else {"agent": a})
    ov = overlap(b, win)
    R.check("tour", ov == 0, f"{agent} step {i + 1}: balloon does not cover the Yesteryear window", shot_path, None if ov == 0 else {"px2": ov, "balloon": b, "window": win})
    ov = overlap(b, a)
    R.check("tour", ov == 0, f"{agent} step {i + 1}: balloon does not cover the guide", shot_path, None if ov == 0 else {"px2": ov, "balloon": b, "agent": a})
    if a and win:
        frac = overlap(a, win) / max(1, a["w"] * a["h"])
        R.check("tour", frac < 0.15, f"{agent} step {i + 1}: guide stands beside the window, not on it", shot_path, None if frac < 0.15 else f"{frac:.0%} of the guide over the window")
    # marching ants exactly on the controls the text talks about
    exp = [e for e in L["expected"] if e]
    ants = [x for x in L["ants"] if x]
    match = len(exp) == len(ants) and all(any(abs(e["x"] - x["x"]) <= 2 and abs(e["y"] - x["y"]) <= 2 and abs(e["w"] - x["w"]) <= 2 and abs(e["h"] - x["h"]) <= 2 for x in ants) for e in exp)
    R.check("tour", match, f"{agent} step {i + 1}: highlight sits on the control", shot_path, None if match else {"expected": exp, "ants": ants})
    for x in ants:
        if overlap(b, x):
            R.check("tour", False, f"{agent} step {i + 1}: balloon covers the highlighted control", shot_path, {"balloon": b, "ants": x})
    # the balloon's tail points at the guide
    tip = L["tip"]
    if tip and a:
        dx = abs(tip["x"] - (a["x"] + a["w"] / 2))
        dy = (a["y"] - tip["y"]) if L["side"] == "top" else (tip["y"] - (a["y"] + a["h"]))
        ok = dx <= a["w"] / 2 + 4 and -12 <= dy <= 40
        R.check("tour", ok, f"{agent} step {i + 1}: balloon tail points at the guide", shot_path, None if ok else {"tip": tip, "agent": a, "side": L["side"]})
    fd, fr = L["frameDoc"], L["frame"]
    if fd:
        ok = fd["h"] <= fr["h"] + 1 and fd["w"] <= fr["w"] + 1
        R.check("tour", ok, f"{agent} step {i + 1}: the window picture is not cut off", shot_path, None if ok else {"doc": fd, "frame": fr})
    R.check("tour", L["sw"] <= vw + 1 and L["sh"] <= L["vh"] + 1, f"{agent} step {i + 1}: no scrollbars on the tour page", shot_path,
            None if L["sw"] <= vw + 1 and L["sh"] <= L["vh"] + 1 else {"doc": [L["sw"], L["sh"]], "view": [vw, L["vh"]]})


def sample_next(page, trigger, until):
    """Clicks `trigger`, samples the guide every frame until `until` shows; returns timing facts."""
    page.evaluate(ARM_SAMPLER_JS, [trigger, until])
    page.click(trigger)
    page.wait_for_function("() => window.__samp && window.__samp.done", timeout=15000, polling=100)
    s = page.evaluate("() => window.__samp")
    if s["timeout"] or s["visibleAt"] is None:
        return {"timeout": True, "samples": len(s["samples"])}
    vis = s["visibleAt"] - s["clickAt"]
    pts = [x for x in s["samples"] if x[1] is not None]
    start = pts[0] if pts else None
    motion = next((x[0] for x in pts if start and (abs(x[1] - start[1]) > 0.5 or abs(x[2] - start[2]) > 0.5)), None)
    pre = [x for x in pts if x[0] <= vis]
    post = [x for x in pts if x[0] > vis]
    # A jump is a leap far beyond one frame's step (a glide moves about 5-25 px per frame). Two rAF callbacks can
    # run back to back after a late frame, so px/ms over a 2 ms gap is no measure; take the step per frame.
    max_speed, worst = 0.0, None
    for a, b in zip(pre, pre[1:]):
        d = ((b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2) ** 0.5
        if d > max_speed:
            max_speed, worst = d, (a[0], b[0], round(d))
    shift = max((((x[1] - post[0][1]) ** 2 + (x[2] - post[0][2]) ** 2) ** 0.5 for x in post), default=0) if post else 0
    land = pre[-1] if pre else None
    landed_at = None
    if land:
        for x in reversed(pre):
            if abs(x[1] - land[1]) > 0.5 or abs(x[2] - land[2]) > 0.5:
                break
            landed_at = x[0]
    distinct = len({(round(x[1]), round(x[2])) for x in pre})
    return {"timeout": False, "balloon_ms": vis, "motion_ms": motion, "landed_ms": landed_at, "distinct": distinct,
            "max_step_px": round(max_speed, 1), "worst": worst, "post_shift": round(shift, 1),
            "from": start and [round(start[1]), round(start[2])], "to": land and [round(land[1]), round(land[2])]}


def settle(page, cap_ms=3500, still_ms=1000):
    """Waits until the guide's sprite stops changing (animation over or holding) or cap_ms; returns ms waited."""
    t0 = time.monotonic()
    last, since = None, time.monotonic()
    while (time.monotonic() - t0) * 1000 < cap_ms:
        cur = page.evaluate(SPRITE_JS)
        if cur != last:
            last, since = cur, time.monotonic()
        elif (time.monotonic() - since) * 1000 >= still_ms:
            break
        page.wait_for_timeout(100)
    return (time.monotonic() - t0) * 1000


def judge_next(agent, i, m, shot_path, quick):
    label = f"{agent} Next {i + 1}->{i + 2}" if i < 6 else f"{agent} Let's go!"
    if m.get("timeout"):
        R.check("tour", False, f"{label}: the next step appears", shot_path, "no balloon / end message within 12 s")
        return
    R.timing("tour", f"{label}: click -> balloon", m["balloon_ms"], LIMITS["next_ms"] if i < 6 else LIMITS["finish_ms"])
    if i < 6:
        R.timing("tour", f"{label}: click -> guide starts moving", m["motion_ms"], LIMITS["motion_start_ms"])
        R.check("tour", m["distinct"] >= 8, f"{label}: the guide glides (no teleport)", shot_path, f"{m['distinct']} positions {m['from']} -> {m['to']}")
        R.check("tour", m["max_step_px"] <= 60, f"{label}: no jump during the glide", shot_path,
                f"largest step between two frames {m['max_step_px']} px" + (f" at {m['worst']}" if m["max_step_px"] > 60 else ""))
        R.check("tour", m["post_shift"] <= 2, f"{label}: the guide stays put once the balloon is up", shot_path, f"moved {m['post_shift']} px after the balloon showed")
        if m["landed_ms"] is not None:
            gap = m["balloon_ms"] - m["landed_ms"]
            R.note(f"{label}: landed at {m['landed_ms']} ms, balloon at {m['balloon_ms']:.0f} ms (gap {gap:.0f} ms)")


@guarded("tour", "Clippy tour")
def tour_first(page):
    page.set_viewport_size(VIEW)
    t0 = time.monotonic()
    page.wait_for_selector("#picker:not([hidden])", timeout=15000)
    R.timing("tour", "tour tab -> picker visible", (time.monotonic() - t0) * 1000)
    try:
        page.wait_for_function("() => document.querySelectorAll('#picker .yy-agent:not([hidden])').length === 2", timeout=8000)
        R.timing("tour", "picker -> both guides alive", (time.monotonic() - t0) * 1000)
    except Exception:
        R.check("tour", False, "picker shows both guides", info="previews did not appear within 8 s")
    page.wait_for_timeout(2200)
    sp = shot(page, "01_tour_picker")
    info = page.evaluate("""() => ({ title: document.title, lead: document.getElementById('picker-lead').textContent,
        blurbs: [...document.querySelectorAll('.blurb')].map((b) => b.textContent), sound: document.getElementById('opt-sound').checked,
        picked: document.querySelector('input[name=agent]:checked')?.value, focus: document.activeElement?.id,
        dialog: (() => { const b = document.getElementById('picker').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })() })""")
    R.check("tour", True, "picker", sp, info)
    focus = page.evaluate("""() => { const f = document.getElementById('replica'); let inner = null;
        try { const a = f.contentDocument.activeElement; inner = a && a !== f.contentDocument.body ? (a.id || a.tagName) : null; } catch (_) {}
        return { top: document.activeElement?.id || document.activeElement?.tagName, inner }; }""")
    R.check("tour", focus["top"] == "start" and not focus["inner"], "picker: keyboard focus is on Start tour (Enter starts, Escape skips)", sp,
            None if focus["top"] == "start" else f"focus is inside the replica popup on #{focus['inner']} (see tests/e2e/probe_focus.py)")
    page_checks(page, "tour", "picker", sp, dash_scope="")

    # Pick Clippy by clicking his picture, keep "Play sounds" as it comes (a new user leaves it).
    page.click("label.preview[for=pick-clippy]")
    picked = page.evaluate("() => [document.getElementById('pick-clippy').checked, document.getElementById('choice-clippy').classList.contains('selected')]")
    R.check("tour", all(picked), "clicking Clippy's picture selects him", sp, picked)
    t_start = time.monotonic()
    page.evaluate(ARM_SAMPLER_JS, ["#start", ".yy-balloon"])
    page.click("#start")
    page.wait_for_timeout(1000)
    sp = shot(page, "02_clippy_enters_1s")
    page.wait_for_function("() => window.__samp && window.__samp.done", timeout=15000, polling=100)
    s = page.evaluate("() => window.__samp")
    first = None if s["visibleAt"] is None else s["visibleAt"] - s["clickAt"]
    R.timing("tour", "Clippy: Start -> first balloon (window opens, Clippy rides in)", first if first is not None else (time.monotonic() - t_start) * 1000, LIMITS["start_ms"])

    texts = []
    for i in range(7):
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=15000)
        anim = settle(page)
        L = page.evaluate(TOUR_LAYOUT_JS, STEP_BOXES[i])
        sp = shot(page, f"03_clippy_step{i + 1}")
        texts.append({"step": i + 1, "title": L["title"], "text": L["text"], "hint": L["hint"], "buttons": L["buttons"], "anim_wait_ms": round(anim)})
        tour_step_checks(page, "Clippy", i, L, sp)
        if i == 0:
            page_checks(page, "tour", "Clippy step 1", sp, dash_scope="")
        if i == 6:
            R.check("tour", "Let's go!" in L["buttons"], "last step offers Let's go!", sp, L["buttons"])
        m = sample_next(page, "#tour-next", ".yy-balloon" if i < 6 else "#done")
        judge_next("Clippy", i, m, sp, quick=False)
    R.note("Clippy texts: " + json.dumps(texts, ensure_ascii=False))
    page.wait_for_selector("#done:not([hidden])", timeout=15000)
    page.wait_for_timeout(400)
    sp = shot(page, "04_clippy_done")
    done = page.evaluate("""() => ({ text: document.getElementById('done-text').textContent, focus: document.activeElement?.id,
        agentHidden: document.querySelector('.yy-agent')?.hidden, stored: null })""")
    stored = page.evaluate("chrome.storage.local.get(['tour:agent', 'tour:done', 'tour:sound', 'tour:shown'])")
    R.check("tour", "all set" in done["text"], "end message after Let's go!", sp, done["text"])
    R.check("tour", stored.get("tour:done") is True and stored.get("tour:agent") == "clippy", "tour remembers it was done, with Clippy", sp, stored)
    # Close: the tab goes away.
    page.click("#done-close")
    for _ in range(30):
        if page.is_closed():
            break
        idle(100)
    R.check("tour", page.is_closed(), "Close closes the tour tab")


@guarded("tour", "reopen with ? and Rover")
def tour_reopen_and_rover(ctx, base, popup_url, welcome_url):
    popup = ctx.new_page()
    popup.set_viewport_size(POPUP_VIEW)
    popup.goto(popup_url)
    popup.wait_for_function("() => !document.documentElement.classList.contains('loading')")
    popup.wait_for_timeout(500)
    sp = shot(popup, "05_popup_first_open")
    st = popup.evaluate(POPUP_JS)
    R.check("ui", st["lcd"] == "Year 2010" and st["flag"] == "OFF", "first popup: year 2010, OFF", sp, {k: st[k] for k in ("lcd", "flag", "status", "travel", "legend", "mpText")})
    R.check("ui", st["bodyH"] <= POPUP_VIEW["height"], "popup fits Chrome's 600 px popup height", sp, f"content {st['bodyH']} px high")
    t0 = time.monotonic()
    with ctx.expect_page(timeout=10000) as info:
        popup.click("#help")
    page = info.value
    page.wait_for_load_state("domcontentloaded")
    page.set_viewport_size(VIEW)
    R.check("tour", page.url.startswith(welcome_url), "? in the popup opens the tour again", info=page.url)
    for _ in range(20):
        if popup.is_closed():
            break
        idle(100)
    R.check("ui", popup.is_closed(), "the popup closes itself after ?")
    page.wait_for_selector("#picker:not([hidden])", timeout=15000)
    R.timing("tour", "? -> picker visible", (time.monotonic() - t0) * 1000)
    pre = page.evaluate("() => document.querySelector('input[name=agent]:checked')?.value")
    R.check("tour", pre == "clippy", "picker remembers the last guide", info=pre)
    page.click("label.preview[for=pick-rover]")
    page.wait_for_timeout(300)
    sp = shot(page, "06_rover_picked")
    page.evaluate(ARM_SAMPLER_JS, ["#start", ".yy-balloon"])
    page.click("#start")
    page.wait_for_function("() => window.__samp && window.__samp.done", timeout=15000, polling=100)
    s = page.evaluate("() => window.__samp")
    R.timing("tour", "Rover: Start -> first balloon (runs in)", None if s["visibleAt"] is None else s["visibleAt"] - s["clickAt"], LIMITS["start_ms"])
    for i in range(7):
        page.wait_for_selector(".yy-balloon:not([hidden])", timeout=15000)
        L = page.evaluate(TOUR_LAYOUT_JS, STEP_BOXES[i])
        sp = shot(page, f"07_rover_step{i + 1}")
        tour_step_checks(page, "Rover", i, L, sp, quick=True)
        m = sample_next(page, "#tour-next", ".yy-balloon" if i < 6 else "#done")
        judge_next("Rover", i, m, sp, quick=True)
    page.wait_for_selector("#done:not([hidden])", timeout=15000)
    page.wait_for_timeout(300)
    sp = shot(page, "08_rover_done")
    stored = page.evaluate("chrome.storage.local.get(['tour:agent', 'tour:done'])")
    R.check("tour", stored.get("tour:agent") == "rover", "Rover is remembered", sp, stored)
    return page


# ---- 2. popup and travel -----------------------------------------------------------------------------------
@guarded("travel", "popup and travel")
def popup_and_travel(ctx, base, popup_url, sw_eval):
    popup = ctx.new_page()
    popup.set_viewport_size(POPUP_VIEW)
    popup.goto(popup_url)
    popup.wait_for_function("() => !document.documentElement.classList.contains('loading')")
    popup.wait_for_timeout(700)
    sp = shot(popup, "10_popup")
    st = popup.evaluate(POPUP_JS)
    R.check("ui", True, "popup before travel", sp, st)
    page_checks(popup, "ui", "popup", sp, skip=".mp-marquee", dash_scope="")
    # quick year 2005
    popup.click("#quick button:text-is('2005')")
    popup.wait_for_timeout(500)
    sp = shot(popup, "11_popup_2005")
    st = popup.evaluate(POPUP_JS)
    stored = popup.evaluate("chrome.storage.local.get(['year', 'enabled'])")
    R.check("ui", st["lcd"] == "Year 2005" and st["travel"] == "Travel to 2005 >>" and st["legend"] == "Music of 2005" and st["pressed"] == ["2005"],
            "2005 quick year: LCD, travel button, mini player follow", sp, {k: st[k] for k in ("lcd", "travel", "legend", "mpText", "pressed", "status")})
    R.check("ui", stored.get("year") == 2005, "2005 is saved right away", sp, stored)
    R.check("player", "Mariah Carey" in (st["mpText"] or ""), "mini player shows the No. 1 of 2005 at once", sp, st["mpText"])
    mini_inside(popup, "popup at 2005", sp)
    page_checks(popup, "ui", "popup at 2005", sp, skip=".mp-marquee")
    popup.evaluate("() => { window.__closed = 0; window.close = () => { window.__closed++; }; }")  # a real popup closes; this tab must survive
    # Travel
    t_click = time.monotonic()
    popup.click("#travel")
    popup.wait_for_url(re.compile(r"/src/travel/travel\.html#"), timeout=10000)
    t_nav = time.monotonic()
    popup.set_viewport_size(VIEW)
    travel = popup
    R.timing("travel", "Travel click -> travel page", (t_nav - t_click) * 1000)
    R.check("travel", "to=2005" in travel.url, "travel page for 2005", info=travel.url.split("/", 3)[3])
    stored = travel.evaluate("chrome.storage.local.get(['travel:last', 'enabled', 'year'])")
    R.check("travel", stored == {"travel:last": 2005, "enabled": True, "year": 2005}, "travel switches the time machine on for 2005", info=stored)
    badge = sw_eval("async () => [await chrome.action.getBadgeText({}), await chrome.action.getTitle({})]")
    R.check("core", badge and badge[0] == "2005", "toolbar badge shows 2005", info=badge)
    # ~1 s and ~3 s into the trip (performance.now() counts from the navigation)
    for name, at in (("12_travel_1s", 1000), ("13_travel_3s", 3000)):
        travel.wait_for_function(f"() => performance.now() > {at}", polling=20)
        before = travel.evaluate(ODO_JS)
        sp = shot(travel, name)
        after = travel.evaluate(ODO_JS)
        R.check("travel", True, f"trip at {before['t']} ms: phase {before['phase']}, odometer {before['odo']}, {before['mph']} MPH (after the shot: {after['phase']} at {after['t']} ms)", sp,
                {"hud": before["hudTitle"], "readouts": before["readouts"], "skip": before["skip"], "title": before["title"], "era": before["era"], "dir": before["direction"]})
        if at == 1000:
            ro = " ".join(before["readouts"])
            R.check("travel", "NOV 11 2005" in ro.upper() or "2005" in ro, "HUD: destination is today's date in 2005", sp, before["readouts"])
            R.check("travel", before["hudTitle"] == "Traveling back in time", "HUD says back in time", sp, before["hudTitle"])
    travel.wait_for_function("() => document.documentElement.dataset.phase === 'done'", timeout=12000, polling=50)
    t_done = time.monotonic()
    R.timing("travel", "Travel click -> landing card ready", (t_done - t_click) * 1000, LIMITS["travel_card_ms"])
    try:
        travel.wait_for_function("() => { const i = document.querySelector('.pic .pic-main') || document.querySelector('.pic img'); return !!document.querySelector('.meme:not([hidden])') && (!i || (i.complete && i.naturalWidth > 0)) || !!document.querySelector('.pic.broken'); }", timeout=20000, polling=100)
        R.timing("travel", "card ready -> meme picture loaded", (time.monotonic() - t_done) * 1000, 3000)
    except Exception:
        R.check("travel", False, "meme picture loads within 20 s")
    travel.wait_for_timeout(1700)  # the CRT scanlines fade out
    sp = shot(travel, "14_travel_landing")
    L = travel.evaluate(LANDING_JS)
    print(json.dumps(L, ensure_ascii=False, indent=1)[:3000])
    charts = json.loads((EXT / "src/player/charts.json").read_text(encoding="utf-8"))
    years = json.loads((EXT / "src/travel/years.json").read_text(encoding="utf-8"))
    top = next(s for s in charts[str(YEAR)] if s["rank"] == 1)
    entry = years[str(YEAR)]
    today = time.localtime()
    then = datetime.date(YEAR, today.tm_mon, today.tm_mday)
    weekday = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][then.weekday()]
    month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][today.tm_mon - 1]
    R.check("travel", L["title"] == f"Welcome to {YEAR}" and L["h1"] == f"Welcome to {YEAR}" and L["winTitle"] == f"Welcome to {YEAR}", "card titles say Welcome to 2005", sp, [L["title"], L["h1"], L["winTitle"]])
    R.check("travel", L["date"] == f"It is {weekday}, {month} {today.tm_mday}, {YEAR}.", "card date is today's date in 2005 with the right weekday", sp, L["date"])
    R.check("travel", L["era"] == "xp", "2005 card is dressed as Windows XP", sp, L["era"])
    # What the card may show today (mirror of landingPlan in src/travel/travel_core.js): nothing dated after
    # today's month and day in 2005; before that, last year's meme, gadget and facts.
    md = f"{today.tm_mon:02d}-{today.tm_mday:02d}"
    prev = years.get(str(YEAR - 1), {})
    due = lambda x: isinstance(x, dict) and isinstance(x.get("on"), str) and x["on"] <= md
    want_meme = entry["meme"] if due(entry["meme"]) else prev.get("meme", {})
    want_tech = entry["tech"] if due(entry["tech"]) else prev.get("tech", {})
    mine = [f for f in sorted(entry["facts"], key=lambda f: f["on"]) if due(f)][-3:]
    want_facts = [f["text"] for f in (mine or sorted(prev.get("facts", []), key=lambda f: f["on"])[-3:])]
    R.check("travel", L["meme"] == want_meme.get("title") and L["blurb"] == want_meme.get("blurb"), "meme title and blurb (never one from later that year)", sp, [L["meme"], L["blurb"]])
    img = L["img"]
    R.check("travel", isinstance(img, dict) and img["w"] > 0, "meme picture shows", sp, img)
    if isinstance(img, dict) and img["w"] > 0 and img.get("pic"):
        fill = img["box"]["w"] * img["box"]["h"] / max(1, img["pic"]["w"] * img["pic"]["h"])
        bg = img.get("bg") or {}
        bg_fill = (bg.get("box") or {}).get("w", 0) * (bg.get("box") or {}).get("h", 0) / max(1, img["pic"]["w"] * img["pic"]["h"])
        R.check("travel", fill >= 0.45 or (bg.get("w", 0) > 0 and bg_fill >= 0.95), "meme picture fills its frame (no big empty bars; a blurred copy fills the sides)", sp,
                f"picture {img['box']['w']}x{img['box']['h']} in a {img['pic']['w']}x{img['pic']['h']} frame ({fill:.0%})")
    R.check("travel", L["song"] == f'"{top["title"]}"' and L["artist"] == top["artist"], "No. 1 song of 2005", sp, [L["song"], L["artist"]])
    R.check("travel", sorted(L["facts"]) == sorted(want_facts), "the latest three facts up to today's date in 2005", sp, L["facts"])
    R.check("travel", L["gadget"] == want_tech.get("text"), "gadget (never one released later that year)", sp, L["gadget"])
    btns = [b["text"] for b in L["buttons"]]
    R.check("travel", btns == [f"Search like it's {YEAR}", f"Play the hits of {YEAR}"] and not any(b["disabled"] for b in L["buttons"]), "card buttons", sp, btns)
    R.check("travel", [a["text"] for a in L["today"]] == ["CNN", "BBC News", "The New York Times"] and all(f"y={YEAR}&d={YEAR}{today.tm_mon:02d}{today.tm_mday:02d}" in a["href"] for a in L["today"]),
            "Today in 2005 links for that very day", sp, L["today"])
    vis_h = L["vh"] - (L["taskbarBox"]["h"] if L["taskbarBox"] else 0)
    fold = [x for x in [*(b["box"] for b in L["buttons"]), *(a["box"] for a in L["today"]), L["replayBox"]] if x and x["y"] + x["h"] > vis_h]
    R.check("travel", not fold and L["desktop"]["sh"] <= L["desktop"]["ch"] + 1, "the whole card fits a 1366x768 screen (no scrolling)", sp,
            None if not fold else {"below the fold": fold, "desktop": L["desktop"]})
    R.check("travel", L["taskbar"]["task"] == f"Welcome to {YEAR}" and L["taskbar"]["start"] == "start", "XP taskbar", sp, L["taskbar"])
    page_checks(travel, "travel", "landing card", sp, max_year=YEAR, year_scope="#landing", dash_scope="#landing", cut_ok=(".odo", ".wheel", "strip"))

    # Today in 2005: CNN (opens in a new tab)
    t0 = time.monotonic()
    with ctx.expect_page(timeout=10000) as info:
        travel.click(".today a:text-is('CNN')")
    cnn = info.value
    cnn.set_viewport_size(VIEW)
    try:
        cnn.wait_for_selector(".frame", timeout=5000)
        sp = shot(cnn, "15_cnn_resolver")
        rs = cnn.evaluate("() => ({ title: document.title, era: document.body.className, status: document.querySelector('.status-text')?.textContent, addr: document.querySelector('.addr')?.textContent })")
        R.check("wayback", rs["era"] == "era-ie6", "resolver looks like Internet Explorer 6 (2005)", sp, rs)
        page_checks(cnn, "wayback", "CNN resolver", sp, dash_scope="")
    except Exception as e:
        R.note(f"resolver screen not caught: {e}")
    final = ""
    for _ in range(240):
        final = cnn.url
        if "web.archive.org" in final or "notfound.html" in final:
            break
        idle(250)
    t_arch = time.monotonic()
    R.timing("wayback", "CNN click -> archived page address", (t_arch - t0) * 1000, 8000)
    m = re.search(r"/web/(\d{14})([a-z]{2}_)?/", final)
    ts = m.group(1) if m else None
    want = f"{YEAR}{today.tm_mon:02d}{today.tm_mday:02d}"
    R.check("wayback", near_day(ts, then), "CNN capture is from that day (or up to 3 days before)", info=final[:120])
    R.check("wayback", bool(m) and m.group(2) == "if_", "archived page without the Wayback toolbar", info=final[:80])
    try:
        cnn.wait_for_load_state("domcontentloaded", timeout=30000)
        R.timing("wayback", "CNN click -> archived page readable (DOMContentLoaded)", (time.monotonic() - t0) * 1000, 10000)
        cnn.wait_for_load_state("load", timeout=45000)
    except Exception:
        R.note("archived CNN did not reach 'load' within 45 s")
    R.timing("wayback", "CNN click -> archived page loaded", (time.monotonic() - t0) * 1000, 15000)
    cnn.wait_for_timeout(2500)
    sp = shot(cnn, "16_cnn_2005")
    cinfo = cnn.evaluate("() => ({ title: document.title, url: location.href.slice(0, 120), wbToolbar: !!document.getElementById('wm-ipp-base'), text: (document.body?.innerText || '').slice(0, 300) })")
    R.check("wayback", "CNN" in cinfo["title"] and not cinfo["wbToolbar"], "archived CNN of 2005 shows", sp, cinfo["title"])
    later = cnn.evaluate(YEARS_JS, [YEAR, None])
    if later:
        R.note(f"archived CNN mentions later years (2005 news about the future is fine): {later[:4]}")
    hist = cnn.evaluate("() => history.length")
    R.note(f"CNN opened in a new tab (history length {hist}); Back in that tab has nowhere to go, the card stays in its own tab")
    cnn.close()
    travel.bring_to_front()
    travel.wait_for_timeout(500)
    sp = shot(travel, "17_back_to_card")
    L2 = travel.evaluate(LANDING_JS)
    R.check("travel", L2["phase"] == "done" and L2["landingHidden"] is False and L2["title"] == f"Welcome to {YEAR}", "back on the card: still there, no second trip", sp,
            {"phase": L2["phase"], "title": L2["title"]})
    return travel


# ---- 3. Google ---------------------------------------------------------------------------------------------
@guarded("google", "Search like it's 2005")
def google_flow(ctx, travel, sw_eval, from_card=True):
    page = travel
    t0 = time.monotonic()
    if from_card:
        page.click(f".actions button:text-is(\"Search like it's {YEAR}\")")
    else:
        page.goto("https://www.google.com/")
    page.wait_for_url("https://www.google.com/", timeout=10000)
    page.wait_for_selector("#yy-root", timeout=10000)
    R.timing("google", "Search like it's 2005 -> period homepage drawn", (time.monotonic() - t0) * 1000, 2500)
    try:
        page.wait_for_selector("#yy-root .yy-logo img", timeout=12000)
        R.timing("google", "homepage -> period logo picture", (time.monotonic() - t0) * 1000, 4000)
    except Exception:
        R.check("google", False, "period logo picture appears", info="still the text logo after 12 s")
    page.wait_for_timeout(600)
    sp = shot(page, "20_google_home_2005")
    g = page.evaluate(GOOGLE_JS)
    print(json.dumps(g, ensure_ascii=False)[:1500])
    R.check("google", g["root"] and g["era"] == "2004", "2005 homepage in the 2004-2006 look", sp, {k: g.get(k) for k in ("era", "title", "nav", "buttons", "under", "foot", "logo")})
    R.check("google", g.get("focus") == "q", "the search box has the cursor", sp, g.get("focus"))
    R.check("google", not g.get("others"), "nothing of the modern page shows through", sp, g.get("others"))
    R.check("google", f"©{YEAR}" in (g.get("foot") or ""), "footer says ©2005", sp, g.get("foot"))
    page_checks(page, "google", "2005 homepage", sp, max_year=YEAR, year_scope="#yy-root", dash_scope="#yy-root")
    # type and submit like a user
    page.click("#yy-root input[name=q]")
    page.keyboard.type(QUERY, delay=70)
    t1 = time.monotonic()
    page.keyboard.press("Enter")
    page.wait_for_url(re.compile(r"^https://www\.google\.com/search\?"), timeout=10000)
    page.wait_for_selector("#yy-root .yy-results, #yy-root .yy-nomatch", timeout=20000)
    R.timing("google", "Enter -> period results page", (time.monotonic() - t1) * 1000, 3000)
    first = page.evaluate(GOOGLE_JS)
    t_first = time.monotonic()
    titles = lambda: page.evaluate("() => [...document.querySelectorAll('#yy-root .yy-r h3')].map((h) => h.textContent)")
    last, changes = titles(), []
    while time.monotonic() - t_first < 7:   # the site-existence check (archive.org) may still drop results
        page.wait_for_timeout(200)
        cur = titles()
        if cur != last:
            changes.append({"ms": round((time.monotonic() - t_first) * 1000), "gone": [t for t in last if t not in cur], "new": [t for t in cur if t not in last]})
            last = cur
    g = page.evaluate(GOOGLE_JS)
    sp = shot(page, "21_google_results_2005")
    shot(page, "21b_google_results_2005_full", full_page=True)
    print(json.dumps(g, ensure_ascii=False)[:3000])
    url = page.url
    R.check("google", "cd_max%3A12%2F31%2F2005" in url or "cd_max:12/31/2005" in url, "the search carries Google's own date cap for 2005", sp, url[:200])
    R.check("google", g["title"] == f"{QUERY} - Google Search", "results page title", sp, g["title"])
    R.check("google", bool(g["results"]), "period results are shown", sp, g.get("nomatch"))
    R.check("google", (g.get("stats") or "").startswith("Web") and f"for {QUERY}" in (g.get("stats") or ""), "2005 stats line (Results 1 - N of about ... for ...)", sp, g.get("stats"))
    junk = [r for r in g["results"] if not r["url"] or r["url"].strip() in ("/", "") or "google.com/search" in (r["href"] or "")]
    R.check("google", not junk, "every result is a real site (no Google-internal links as results)", sp, junk or None)
    empty = [r["title"] for r in g["results"] if not (r["snippet"] or "").strip()]
    if empty:
        R.note(f"results without a snippet (front pages keep no modern snippet by design): {empty}")
    R.note(f"results before the site check: {[r['title'] for r in first['results']]}; after: {[r['title'] for r in g['results']]}")
    R.check("google", not changes, "results stay put once the page is shown", sp, changes or None)
    page_checks(page, "google", "2005 results", sp, max_year=YEAR, year_scope="#yy-root", dash_scope="#yy-root")
    if not from_card:
        return
    # News tab
    t2 = time.monotonic()
    page.click("#yy-root .yy-links a:text-is('News')")
    try:
        page.wait_for_url(re.compile(r"/src/wayback/resolve\.html"), timeout=5000)
        page.wait_for_timeout(300)
        shot(page, "22_news_resolver")
    except Exception:
        pass
    final = ""
    for _ in range(240):
        final = page.url
        if "web.archive.org" in final or "notfound.html" in final:
            break
        idle(250)
    R.timing("google", "News -> archived Google News address", (time.monotonic() - t2) * 1000, 8000)
    m = re.search(r"/web/(\d{14})([a-z]{2}_)?/", final)
    today = time.localtime()
    then = datetime.date(YEAR, today.tm_mon, today.tm_mday)
    R.check("google", near_day(m.group(1) if m else None, then), "News opens Google News of that day in 2005 (or up to 3 days before)", info=final[:120])
    R.check("google", bool(m) and m.group(2) == "if_", "archived Google News without the Wayback toolbar", info=final[:80])
    try:
        page.wait_for_load_state("load", timeout=30000)
    except Exception:
        R.note("archived Google News did not reach 'load' within 30 s")
    page.wait_for_timeout(2500)
    sp = shot(page, "23_google_news_2005")
    n = page.evaluate("() => ({ title: document.title, toolbar: !!document.getElementById('wm-ipp-base'), text: (document.body?.innerText || '').slice(0, 200) })")
    R.check("google", "Google News" in n["title"] and not n["toolbar"], "archived Google News shows", sp, n["title"])
    page_checks(page, "google", "archived Google News", sp, archived=True)
    later = page.evaluate(YEARS_JS, [YEAR, None])
    if later:
        R.note(f"archived Google News mentions later years: {later[:4]}")
    # Back: the results page again
    page.go_back()
    try:
        page.wait_for_selector("#yy-root .yy-results, #yy-root .yy-nomatch", timeout=15000)
        page.wait_for_timeout(1500)
        sp = shot(page, "24_back_to_results")
        g2 = page.evaluate(GOOGLE_JS)
        # The site check may have answered meanwhile (cached now): a site that did not exist yet can drop out.
        R.check("google", g2["root"] and 0 < len(g2["results"]) <= len(g["results"]), "Back from News shows the period results again", sp,
                {"url": g2["url"][:100], "results": f'{len(g2["results"])} (first visit: {len(g["results"])})'})
    except Exception as e:
        sp = shot(page, "24_back_to_results")
        R.check("google", False, "Back from News shows the period results", sp, f"{page.url[:120]} ({e})")


# ---- 4. player ---------------------------------------------------------------------------------------------
@guarded("player", "player and mini player")
def player_flow(ctx, base, popup_url, sw_eval):
    page = ctx.new_page()
    page.set_viewport_size(PLAYER_VIEW)
    page.goto(f"{base}/src/player/player.html")
    page.wait_for_function("() => document.querySelectorAll('#list li').length > 0", timeout=10000)
    page.wait_for_timeout(1500)
    sp = shot(page, "30_player_2005")
    pl = page.evaluate(PLAYER_JS)
    print(json.dumps(pl, ensure_ascii=False))
    R.check("player", pl["skin"] == "wmp" and pl["app"] == "Windows Media Player", "2005 player looks like Windows Media Player", sp, [pl["skin"], pl["app"]])
    R.check("player", pl["yearTag"] == str(YEAR) and f"{YEAR}" in pl["plTitle"] and pl["plCount"] == "100 songs", "player is set to 2005 with 100 songs", sp,
            {k: pl[k] for k in ("yearTag", "plTitle", "plCount", "idle")})
    R.check("player", "Mariah Carey" in (pl["first"] or "") and "We Belong Together" in (pl["track"] or ""), "first song is the No. 1 of 2005", sp, [pl["first"], pl["track"], pl["sub"]])
    page_checks(page, "player", "player 360x760", sp, skip=".marquee", dash_scope="")
    state = page.evaluate("() => new Promise((r) => chrome.runtime.sendMessage({ type: 'music:state' }, r))")
    R.check("player", state and not state.get("playing") and state.get("year") == YEAR, "nothing plays by itself", sp, {k: state.get(k) for k in ("playing", "year", "alive", "status")} if state else None)
    page.close()

    popup = ctx.new_page()
    popup.set_viewport_size(POPUP_VIEW)
    popup.goto(popup_url)
    popup.wait_for_function("() => !document.documentElement.classList.contains('loading')")
    popup.wait_for_timeout(900)
    sp = shot(popup, "31_popup_mini_player")
    st = popup.evaluate(POPUP_JS)
    R.check("player", st["legend"] == f"Music of {YEAR}" and "Mariah Carey" in st["mpText"] and st["play"] == "Play" and st["showDisabled"] is False,
            "mini player: Music of 2005, No. 1 ready, Play and Show player active", sp, {k: st[k] for k in ("legend", "mpText", "mpTime", "mpScroll", "play", "showDisabled")})
    R.check("ui", st["flag"] == "ON" and st["lcd"] == "Year 2005", "popup after the trip: ON, 2005", sp, {k: st[k] for k in ("flag", "lcd", "status", "sites", "note")})
    R.check("ui", st["bodyH"] <= POPUP_VIEW["height"], "popup fits Chrome's 600 px popup height (time machine ON)", sp, f"content {st['bodyH']} px high")
    mini_inside(popup, "popup after the trip", sp)
    clip = popup.locator("#mini-player").bounding_box()
    if clip:
        shot(popup, "31b_mini_player_zoom", clip={"x": clip["x"] - 4, "y": clip["y"] - 4, "width": clip["width"] + 8, "height": clip["height"] + 8})
    popup.evaluate("() => { window.__closed = 0; window.close = () => { window.__closed++; }; }")
    popup.click("#mp-show")
    popup.wait_for_timeout(1500)
    closed = popup.evaluate("() => window.__closed")
    note = popup.evaluate("() => document.getElementById('note').hidden ? null : document.getElementById('note').textContent")
    panels = sw_eval("async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).map((c) => c.documentUrl)")
    sp = shot(popup, "32_popup_after_show_player")
    R.check("player", (panels or closed) and not note, "Show player opens the side panel", sp, {"side panels": panels, "popup closed itself": closed, "note": note})
    popup.close()


# ---- summary --------------------------------------------------------------------------------------------------
def summarize():
    ext_errors = [c for c in R.console if c["source"].startswith(("chrome-extension://", "service worker"))]
    google_page = [c for c in R.console if c["source"].startswith("https://www.google.com")]
    archive = [c for c in R.console if "web.archive.org" in c["source"]]
    print("\n==== console: extension pages + service worker ====")
    for c in ext_errors:
        print(f"  {c['type']:8} {c['source'][:70]} :: {c['text'][:220]} ({c['at']})")
    print("==== console: google.com pages (content script + fixture) ====")
    for c in google_page[:30]:
        print(f"  {c['type']:8} {c['source'][:60]} :: {c['text'][:200]} ({c['at']})")
    print(f"==== console: archived pages: {len(archive)} messages ====")
    for c in archive[:8]:
        print(f"  {c['type']:8} {c['source'][:60]} :: {c['text'][:160]}")
    print("==== uncaught page errors ====")
    for e in R.page_errors[:20]:
        print("  ", e)
    print("==== failed / 4xx extension and archive requests ====")
    for r in R.requests[:30]:
        print("  ", r)
    print(f"==== blocked by the test ({len(R.blocked)}) ====")
    for b in R.blocked[:25]:
        print("  ", b)
    bad_google = [u for u in R.google_hits if not u.startswith("https://www.google.com/")]
    print(f"www.google.com requests answered locally: {len(R.google_hits)}; others: {bad_google}")
    fails = [c for c in R.checks if not c["ok"]]
    slow = [t for t in R.timings if t["slow"]]
    print(f"\n==== {len(R.checks)} checks, {len(fails)} failed, {len(slow)} slow ====")
    for c in fails:
        print(f"  FAIL {c['module']:7} {c['what']} -- {str(c['info'])[:300]} [{c['shot']}]")
    for t in slow:
        print(f"  SLOW {t['module']:7} {t['name']}: {t['ms']} ms (limit {t['limit']})")
    out = {"fixture": FIXTURE, "query": QUERY, "year": YEAR, "checks": R.checks, "timings": R.timings, "notes": R.notes,
           "console": R.console, "page_errors": R.page_errors, "requests": R.requests, "blocked": R.blocked, "google_local": R.google_hits}
    (SHOTS / (f"results_{PREFIX.rstrip('_')}.json" if PREFIX else "results.json")).write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print("screenshots and results.json:", SHOTS)


if __name__ == "__main__":
    main()
