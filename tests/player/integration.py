"""The music module's INTEGRATION NEEDED changes, as code: builds a patched COPY of the extension.

    .venv/Scripts/python.exe tests/player/integration.py [target_dir]   (default: test-build-player)

Never touches extension/ itself: the integrator applies the same changes there by hand. Each edit is an
exact string replacement and fails loudly when the source has moved on.
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
SNIPPET = Path(__file__).resolve().parent / "fixtures" / "popup_mini_player.html"

MANIFEST_PERMISSION = "offscreen"

POPUP_HTML_CSS = (
    '  <link rel="stylesheet" href="popup.css">\n',
    '  <link rel="stylesheet" href="popup.css">\n  <link rel="stylesheet" href="../player/miniplayer.css">\n',
)
POPUP_HTML_ACTIONS = """      <div class="actions">
        <button type="button" id="music" disabled>Music of 2010...</button>
      </div>
"""

POPUP_JS_EDITS = [
    # 1. import the mini player
    ('} from "./logic.js";\n',
     '} from "./logic.js";\nimport { mountMiniPlayer } from "../player/miniplayer.js";\n'),
    # 2. the old music button is gone
    ('  quick: $("quick"), music: $("music"), note: $("note"), close: $("close"),\n',
     '  quick: $("quick"), note: $("note"), close: $("close"),\n'),
    ('let windowId = null;                   // for sidePanel.open(), looked up before any click\n', ''),
    ('  lcdDigits, segmentsFor, quickYearButtons, musicLabel, statusText, sitesText, noteFor, debounce\n',
     '  lcdDigits, segmentsFor, quickYearButtons, statusText, sitesText, noteFor, debounce\n'),
    ("""function wireMusic() {
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

""", ''),
    ('  el.music.textContent = musicLabel(year);\n', ''),
    ('wireMusic();\n',
     '// Its buttons first save a year that is still being chosen, as the old music button did.\n'
     'if (HAS_CHROME) mountMiniPlayer(document.getElementById("mini-player"), { onProblem: showProblem, beforeAction: () => yearSaver.flush() });\n'),
    ("""  chrome.windows?.getCurrent?.().then(
    (win) => { windowId = win.id; el.music.disabled = false; },
    (err) => showProblem(`Could not find this window: ${errorText(err)}`)
  );
""", ''),
]


def replace_once(text, old, new, where):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{where}: expected 1 match, found {count}:\n{old}")
    return text.replace(old, new)


def build(target: Path) -> Path:
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(EXT, target, ignore=shutil.ignore_patterns("_metadata"))

    manifest_path = target / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if MANIFEST_PERMISSION not in manifest["permissions"]:
        manifest["permissions"].append(MANIFEST_PERMISSION)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    popup_html = target / "src" / "ui" / "popup.html"
    html = popup_html.read_text(encoding="utf-8")
    if 'id="mini-player"' in html:
        return target              # extension/ is integrated already (tests/integrate_v02.py)
    html = replace_once(html, *POPUP_HTML_CSS, "popup.html css")
    html = replace_once(html, POPUP_HTML_ACTIONS, SNIPPET.read_text(encoding="utf-8"), "popup.html actions")
    popup_html.write_text(html, encoding="utf-8")

    popup_js = target / "src" / "ui" / "popup.js"
    js = popup_js.read_text(encoding="utf-8")
    for old, new in POPUP_JS_EDITS:
        js = replace_once(js, old, new, "popup.js")
    popup_js.write_text(js, encoding="utf-8")
    return target


if __name__ == "__main__":
    out = build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "test-build-player")
    print("built", out)
