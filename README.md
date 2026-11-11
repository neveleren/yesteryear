# Yesteryear: Google and YouTube as a time machine

Pick a year (1998-2025). Then search Google and YouTube as usual: results come only from that year or
earlier, pages open as they looked back then, Google looks like that year's Google, and that year's hits play.

A personal hobby project, shared as is. Not affiliated with Google, YouTube, Microsoft or the Internet Archive.

## Install (Chrome)
1. Download `yesteryear-<version>.zip` from [Releases](../../releases) and unzip it (or clone this repository).
2. Recommended: a separate Chrome profile (while it is ON, every Google search goes back in time).
3. Open `chrome://extensions`, switch on **Developer mode** (top right).
4. **Load unpacked** -> choose the `extension` folder. A short tour opens in a new tab.
5. Pin the extension (puzzle icon -> pin "Yesteryear"), click it, pick a year, then **Travel to YEAR >>**.

It is not in the Chrome Web Store: the hidden music player and Clippy/Rover would not pass its rules (see Limits).

## Update to a new version
1. Open `chrome://extensions`.
2. On the Yesteryear card, click the round **reload** arrow.
3. Reload the Google and YouTube tabs that are already open (F5): until then they run the old version.
4. Music stops on a reload: press Play again. If you have never seen the tour, it opens once by itself.

## What it does
- **The popup:** pick the year with the arrows (hold one to spin), the slider or a quick year. **Time machine ON**
  switches it on and off. The toolbar button shows the year while ON and "OFF" otherwise.
- **Travel to YEAR >>:** a ride through a time tunnel (with sound), then a card for that year: the meme of the
  year with a picture, the No. 1 song, three facts, the gadget everyone wanted, and "Today in YEAR" links to CNN,
  BBC News and The New York Times on today's date back then. Travelling also switches the time machine on.
  The card has two buttons: "Search like it's YEAR" and "Play the hits of YEAR", plus two rows: **People are
  searching** (what everyone googled that year: click one and it searches as it would have back then) and **Web
  favorites** (the sites everyone visited, opened as they were that day). The card only shows what had already
  happened by that day: earlier in the year it shows last year's meme and gadget instead.
- **Google:** "this year" / "latest" / "best ..." become the chosen year; Google's own date cap
  (`cd_max:12/31/YEAR`) and the plain Web tab; results that still leak later years (dates, years in the text,
  things that did not exist yet, "2 days ago") are removed. With **Strict** on, sites that did not exist yet in
  that year are hidden too. The page is drawn in that year's look (11 looks from the 1998 "Google!" beta to today).
- **Google's old tabs work:** News, Groups, Gmail, Froogle, Maps, "more" and the rest open that Google service as
  it was on today's date in that year. Images opens Google Images in that year's look, with results from that
  year. In 1999-2001, "Try your query on" under the results opens AltaVista, Excite, Lycos, Yahoo! and the others
  as they were that day.
- **I'm Feeling Lucky** works like back then: with words it opens the first result of that year's search; with an
  empty box it opens Google's logo page of that time (Holiday Logos, later Doodles).
- **Clicking a result** opens the copy from the Internet Archive taken in that year or earlier, never later
  (strict lookup). Links inside archived pages stay in that year too. If that exact page was not saved back then,
  the site's front page of that year opens, with a note in that year's browser style. "The page cannot be
  displayed" is left for sites that did not exist yet (and archive outages).
- **YouTube:** searches get `before:YEAR+1-01-01` (server-side), newer cards, Shorts, ads and comments are
  hidden; before 2005 YouTube "does not exist".
- **Music:** the Billboard Year-End Hot 100 of the year, played through YouTube (one video per song, found once
  and remembered). The popup has a mini player: Previous, Play/Pause, Next and the song. **Show player** opens the
  big player on the right, in a Winamp / Windows Media Player / iTunes / Spotify look by era. **Hide player**
  closes it and the music keeps playing.
- **Tour:** after the install, Clippy or Rover (you pick) shows every button of the popup. **?** in the popup's
  title bar opens the tour again.

## Limits (honest)
- Google decides dates by its own estimate; a modern page can slip through the filter now and then.
- Google may show a captcha on unusual traffic; the extension then pauses (it never searches in the
  background).
- Links inside archived pages each cost one archive lookup (archive.org allows about 20 per minute).
- The music plays in a hidden page. Chrome closes it after about 30 s of silence (a long pause); Play then starts
  the same song at the same second, 1-2 s later. If YouTube refuses to play, open youtube.com once in this Chrome
  profile, then press Play.
- The hidden player is fine for personal use, not for the Chrome Web Store (YouTube wants a visible player).
- Clippy and Rover belong to Microsoft (taken from clippy.js, which has shared them for years); they are here
  for fun and personal use only.
- At a Chrome page zoom of 150 % or more the bottom of the popup is cut off (it fits up to 125 %).
- Archived Google sign-in pages (Gmail and others) are read-only: their forms cannot send anything. Never type a
  real password into an archived page.

## Develop
- Architecture and contracts: `ARCHITECTURE.md`; research behind every decision: `research/`.
- Unit tests (no network), in Git Bash: `node --test "tests/*/*.test.mjs"`
- Live checks in throwaway Chromium profiles, in Git Bash after `export PYTHONIOENCODING=utf-8 MSYS_NO_PATHCONV=1`.
  None of them sends anything to Google (they use archive.org, Wikimedia images and one YouTube embed load):
  - popup: `.venv/Scripts/python.exe tests/ui/popup_check.py`
  - tour: `.venv/Scripts/python.exe tests/tour/shots.py all` and `.venv/Scripts/python.exe tests/tour/behavior.py`
  - travel: `.venv/Scripts/python.exe tests/travel/visual_check.py`
  - music: `(cd tests/player && ../../.venv/Scripts/python.exe live_offscreen.py)`; headless YouTube may show a
    bot check, then 2 checks fail (the test browser, not the extension)
  - Google on saved pages: `.venv/Scripts/python.exe tests/live/render_fixture.py 2020_linux.html 2001`,
    `.venv/Scripts/python.exe tests/live/services_check.py 2005 News`, `.venv/Scripts/python.exe tests/live/resolver_check.py`,
    `.venv/Scripts/python.exe tests/live/lucky_check.py 2005`
  - fully stubbed, no network: `.venv/Scripts/python.exe tests/live/core_check.py` (core fixes; `--src=<dir>` checks
    another export) and `.venv/Scripts/python.exe tests/player/popup_width.py` (mini player width for every year)
- `tests/live/smoke.py` does real Google and YouTube searches: do not run it from this machine.

## License
- Yesteryear's own code: MIT (see `LICENSE`).
- `extension/src/vendor/98css/`: 98.css 0.1.21 (MIT) and the Pixelated MS Sans Serif font (CC BY-SA 3.0), see the
  files in that folder.
- `extension/src/vendor/clippy/`: data of clippyjs 0.1.0 (MIT); the Clippy and Rover characters, pictures and sounds
  belong to Microsoft.
- Year cards: meme pictures are loaded from Wikimedia (each under its own license, linked on the card); the music
  lists are the Billboard Year-End Hot 100 (titles and artists only); songs play from YouTube.
