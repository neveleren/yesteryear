"""Applies the v0.2 modules' INTEGRATION NEEDED changes (tour, travel, music) to extension/ itself, merged.

    .venv/Scripts/python.exe tests/integrate_v02.py

Every edit is an exact, single-match string replacement; the script stops at the first one that does not
match, before writing anything. Running it twice is refused (the popup already has the mini player).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
SNIPPET = (ROOT / "tests" / "player" / "fixtures" / "popup_mini_player.html").read_text(encoding="utf-8")

files = {}


def load(rel):
    if rel not in files:
        files[rel] = (EXT / rel).read_text(encoding="utf-8") if not rel.startswith("../") else (ROOT / rel[3:]).read_text(encoding="utf-8")
    return files[rel]


def rep(rel, old, new):
    text = load(rel)
    n = text.count(old)
    if n != 1:
        sys.exit(f"{rel}: expected 1 match, found {n}:\n{old}")
    files[rel] = text.replace(old, new)


if 'id="mini-player"' in load("src/ui/popup.html"):
    sys.exit("already integrated")

# ---- manifest: offscreen document for the music, version 0.2.0
manifest = json.loads(load("manifest.json"))
manifest["version"] = "0.2.0"
if "offscreen" not in manifest["permissions"]:
    manifest["permissions"].append("offscreen")
files["manifest.json"] = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"

# ---- service worker: tour + travel (music is already there)
rep("sw.js", 'import { initGoogle } from "./src/google/sw_google.js";\n',
    'import { initGoogle } from "./src/google/sw_google.js";\n'
    'import { initTour } from "./src/tour/sw_tour.js";\n'
    'import { initTravel } from "./src/travel/sw_travel.js";\n')
rep("sw.js", "initGoogle();\n", "initGoogle();\ninitTour();\ninitTravel();\n")

# ---- popup.html
rep("src/ui/popup.html", '  <link rel="stylesheet" href="popup.css">\n',
    '  <link rel="stylesheet" href="popup.css">\n  <link rel="stylesheet" href="../player/miniplayer.css">\n')
rep("src/ui/popup.html", """      <div class="title-bar-controls">
        <button type="button" id="close" aria-label="Close" title="Close"></button>
      </div>""", """      <div class="title-bar-controls">
        <button type="button" id="help" aria-label="Help" title="How it works"></button>
        <button type="button" id="close" aria-label="Close" title="Close"></button>
      </div>""")
rep("src/ui/popup.html", """      <div class="quick" id="quick" role="group" aria-label="Jump to year"></div>
""", """      <div class="quick" id="quick" role="group" aria-label="Jump to year"></div>

      <div class="travel-row">
        <button type="button" id="travel" class="default">Travel to 2010 &gt;&gt;</button>
      </div>
""")
rep("src/ui/popup.html", """      <div class="actions">
        <button type="button" id="music" disabled>Music of 2010...</button>
      </div>
""", SNIPPET)

# ---- popup.css: travel button (the old #music rule goes with the button)
rep("src/ui/popup.css", "#music { min-width: 120px; }\n", """
/* ---- Travel button (src/travel) --------------------------------------------------------------- */
.travel-row { margin-top: 10px; }
#travel { display: block; width: 100%; min-height: 30px; font-weight: bold; letter-spacing: 0.5px; }
""")

# ---- popup.js: mini player replaces the music button; travel; help
JS = "src/ui/popup.js"
rep(JS, "// and \"Music of <year>...\" which opens the music player in the side panel.\n",
    "// \"Travel to <year> >>\" (src/travel), the mini player (src/player/miniplayer.js) and \"?\" (src/tour).\n")
rep(JS, '} from "./logic.js";\n', '} from "./logic.js";\nimport { mountMiniPlayer } from "../player/miniplayer.js";\n')
rep(JS, "  lcdDigits, segmentsFor, quickYearButtons, musicLabel, statusText, sitesText, noteFor, debounce\n",
    "  lcdDigits, segmentsFor, quickYearButtons, statusText, sitesText, noteFor, debounce\n")
rep(JS, '  quick: $("quick"), music: $("music"), note: $("note"), close: $("close"),\n',
    '  quick: $("quick"), travel: $("travel"), note: $("note"), close: $("close"),\n')
rep(JS, "let windowId = null;                   // for sidePanel.open(), looked up before any click\n", "")
rep(JS, """function wireMusic() {
  el.music.addEventListener("click", () => {
    yearSaver.flush(); // the player reads the year from storage when it opens
    if (windowId === null) {
      showProblem("The music panel is not available here.");
      return;
    }
    try {
      // sidePanel.open() needs the user gesture, so it is called right here, before any await.
      chrome.sidePanel.open({ windowId }).then(
        () => window.close(),
        (err) => showProblem(`Could not open the music panel: ${errorText(err)}`)
      );
    } catch (err) {
      showProblem(`Could not open the music panel: ${errorText(err)}`);
    }
  });
}

""", """// ---- Time travel (src/travel) ------------------------------------------------------------------
const TRAVEL_LAST_KEY = "travel:last"; // year of the last trip, written by src/travel/sw_travel.js
const travelLabel = (year) => `Travel to ${year} >>`;

function wireTravel() {
  el.travel.addEventListener("click", async () => {
    const to = shownYear();
    yearSaver.cancel(); // saved below, together with the switch
    draftYear = null;
    state = { ...state, year: to, enabled: true };
    render();
    if (!HAS_CHROME) return;
    el.travel.disabled = true;
    try {
      const last = Number((await chrome.storage.local.get(TRAVEL_LAST_KEY))[TRAVEL_LAST_KEY]);
      const from = Number.isFinite(last) && last > 0 ? last : new Date().getFullYear();
      // Travelling switches the time machine on: Google and YouTube are in that year on arrival.
      await setState({ year: to, enabled: true });
      const reply = await chrome.runtime.sendMessage({ type: "travel:go", from, to });
      if (!reply?.ok) throw new Error(reply?.reason || "no answer");
      window.close();
    } catch (err) {
      el.travel.disabled = false;
      showProblem(`Could not travel: ${errorText(err)}`);
    }
  });
}

""")
rep(JS, "  el.music.textContent = musicLabel(year);\n", "  el.travel.textContent = travelLabel(year);\n")
rep(JS, "wireMusic();\n", "wireTravel();\n"
    "// Its buttons first save a year that is still being chosen, as the old music button did.\n"
    'if (HAS_CHROME) mountMiniPlayer(document.getElementById("mini-player"), { onProblem: showProblem, beforeAction: () => yearSaver.flush() });\n')
rep(JS, 'el.close.addEventListener("click", () => window.close());\n', """el.close.addEventListener("click", () => window.close());
// "?" opens the first-run tour again (src/tour/welcome.html) in a tab.
$("help").addEventListener("click", () => {
  try {
    chrome.runtime.sendMessage({ type: "tour:open" }, () => { void chrome.runtime.lastError; window.close(); });
  } catch { window.close(); }
});
""")
rep(JS, """  chrome.windows?.getCurrent?.().then(
    (win) => { windowId = win.id; el.music.disabled = false; },
    (err) => showProblem(`Could not find this window: ${errorText(err)}`)
  );
""", "")

# ---- UI static test: the music button became the mini player
rep("../tests/ui/static.test.mjs",
    """    assert.match(html, /<button type="button" id="music"[^>]*>Music of \\d{4}\\.\\.\\.<\\/button>/);\n""",
    """    assert.match(html, /<fieldset class="mini-player" id="mini-player">/);
    assert.match(html, /<button type="button" id="mp-show" disabled>Show player<\\/button>/);
""")

for rel, text in files.items():
    path = (ROOT / rel[3:]) if rel.startswith("../") else (EXT / rel)
    path.write_text(text, encoding="utf-8", newline="\n")
    print("wrote", path.relative_to(ROOT))
