"""Live check of the first-run tour in a throwaway Chromium profile (no Google traffic at all).

Builds test-build-tour/ from a COPY of extension/ with the tour's "INTEGRATION NEEDED" changes applied
(sw.js import + init, the popup's "?" button), then:
  1. fresh profile: the install opens welcome.html by itself;
  2. clicks through all seven steps with Clippy and with Rover, screenshot per step;
  3. checks tour:agent / tour:done in storage, and that "?" in the popup reopens the tour.
Screenshots: test-shots/tour/. Usage: .venv/Scripts/python.exe tests/tour/shots.py [clippy|rover|all]
"""
import json
import shutil
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "extension"
BUILD = ROOT / "test-build-tour"
PROFILE = ROOT / "test-profile-tour"
SHOTS = ROOT / "test-shots" / "tour"
WHICH = sys.argv[1] if len(sys.argv) > 1 else "all"
AGENTS = ["clippy", "rover"] if WHICH == "all" else [WHICH]
# When to take each step's picture (ms after its balloon appears): the moment its animation shows
# its signature pose (Clippy's wave, telescope, headphones...; Rover's suitcase, photo, clapperboard).
CAPTURE_MS = {
    "clippy": [900, 900, 1200, 2600, 1500, 1500, 900],
    "rover": [500, 1400, 600, 2500, 1700, 1600, 700],
}


def patch(path, old, new):
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"integration patch did not apply to {path}: {old!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def build():
    shutil.rmtree(BUILD, ignore_errors=True)
    shutil.copytree(SRC, BUILD, ignore=shutil.ignore_patterns("_metadata"))
    if "initTour" in (BUILD / "sw.js").read_text(encoding="utf-8"):
        return                     # extension/ is integrated already (tests/integrate_v02.py): a plain copy
    # sw.js: import + init (the integrator's change)
    patch(BUILD / "sw.js", 'import { initGoogle } from "./src/google/sw_google.js";\n',
          'import { initGoogle } from "./src/google/sw_google.js";\nimport { initTour } from "./src/tour/sw_tour.js";\n')
    patch(BUILD / "sw.js", "initGoogle();\n", "initGoogle();\ninitTour();\n")
    # popup.html: "?" before the close button
    patch(BUILD / "src/ui/popup.html",
          '<button type="button" id="close" aria-label="Close" title="Close"></button>',
          '<button type="button" id="help" aria-label="Help" title="How it works"></button>\n'
          '        <button type="button" id="close" aria-label="Close" title="Close"></button>')
    # popup.js: send tour:open
    patch(BUILD / "src/ui/popup.js",
          'el.close.addEventListener("click", () => window.close());\n',
          'el.close.addEventListener("click", () => window.close());\n'
          '// "?" opens the first-run tour again (src/tour/welcome.html) in a tab.\n'
          '$("help").addEventListener("click", () => {\n'
          '  try {\n'
          '    chrome.runtime.sendMessage({ type: "tour:open" }, () => { void chrome.runtime.lastError; window.close(); });\n'
          '  } catch { window.close(); }\n'
          '});\n')


def wait_balloon(page, timeout=15000):
    page.wait_for_selector(".yy-balloon:not([hidden])", timeout=timeout)


def main():
    build()
    SHOTS.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(PROFILE, ignore_errors=True)
    errors = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), channel="chromium", headless=True,
            args=["--host-resolver-rules=MAP google.com ~NOTFOUND, MAP *.google.com ~NOTFOUND", f"--disable-extensions-except={BUILD}", f"--load-extension={BUILD}", "--lang=en-US",
                  "--autoplay-policy=no-user-gesture-required"],
            locale="en-US", viewport={"width": 1280, "height": 800})
        ctx.route("https://www.google.com/**", lambda route: route.abort())  # never touch Google
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext = sw.url.split("/")[2]
        welcome_url = f"chrome-extension://{ext}/src/tour/welcome.html"

        # 1. The install opened the tour by itself.
        page = None
        for _ in range(50):
            page = next((pg for pg in ctx.pages if pg.url.startswith(welcome_url)), None)
            if page:
                break
            ctx.pages[0].wait_for_timeout(200)
        print("auto-opened on install:", bool(page))
        if not page:
            errors.append("welcome.html did not open on install")
            page = ctx.new_page()
            page.goto(welcome_url)
        page.on("console", lambda m: errors.append(f"console {m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.set_viewport_size({"width": 1280, "height": 800})
        page.wait_for_selector("#picker:not([hidden])")
        page.wait_for_timeout(2500)  # previews start their idle animations
        page.screenshot(path=str(SHOTS / "00_picker.png"))
        print("shown flag:", sw.evaluate("chrome.storage.local.get('tour:shown')"))

        for agent in AGENTS:
            page.goto(welcome_url)
            page.wait_for_selector("#picker:not([hidden])")
            # 98.css draws checkboxes and radios on their labels; the inputs themselves are invisible.
            page.click(f"#choice-{agent} .field-row label")
            if page.is_checked("#opt-sound"):
                page.click("label[for=opt-sound]")
            if not page.is_checked(f"#pick-{agent}") or page.is_checked("#opt-sound"):
                errors.append("picker labels did not toggle the inputs")
            page.click("#start")
            wait_balloon(page)
            for i in range(7):
                page.wait_for_timeout(CAPTURE_MS[agent][i])
                info = page.evaluate("""() => {
                    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
                    return { title: document.querySelector('#tour-title')?.textContent,
                             agent: r(document.querySelector('.yy-agent')), balloon: r(document.querySelector('.yy-balloon')),
                             ants: [...document.querySelectorAll('.yy-ants')].map(r),
                             side: document.querySelector('.yy-balloon')?.dataset.side };
                }""")
                print(agent, i + 1, json.dumps(info))
                page.screenshot(path=str(SHOTS / f"{agent}_{i + 1}.png"))
                if i < 6:
                    page.click("#tour-next")
                    wait_balloon(page)
            page.click("#tour-next")  # "Let's go!"
            page.wait_for_selector("#done:not([hidden])", timeout=15000)
            page.screenshot(path=str(SHOTS / f"{agent}_done.png"))
            stored = page.evaluate("chrome.storage.local.get(['tour:agent', 'tour:done', 'tour:sound'])")
            print("storage after", agent, stored)
            if stored.get("tour:agent") != agent or stored.get("tour:done") is not True:
                errors.append(f"storage wrong after {agent}: {stored}")

        # 3. "?" in the popup: opens the tour when none is open, reuses the open tab otherwise.
        def tour_tabs():
            return sw.evaluate("""async () => (await chrome.tabs.query({}))
                .filter((t) => (t.url || t.pendingUrl || '').includes('/src/tour/welcome.html')).length""")

        def press_help(shot=None):
            popup = ctx.new_page()
            popup.goto(f"chrome-extension://{ext}/src/ui/popup.html")
            popup.wait_for_selector("#help")
            popup.wait_for_timeout(600)
            if shot:
                popup.screenshot(path=str(SHOTS / shot), clip={"x": 0, "y": 0, "width": 320, "height": 470})
            try:
                popup.click("#help")
            except Exception:  # the popup page closes itself after sending
                pass
            ctx.pages[0].wait_for_timeout(1500)

        sw.evaluate("""async () => { for (const t of await chrome.tabs.query({}))
            if ((t.url || '').includes('/src/tour/welcome.html')) await chrome.tabs.remove(t.id); }""")
        print("tour tabs after closing all:", tour_tabs())
        press_help("popup_help_button.png")
        first = tour_tabs()
        press_help()
        second = tour_tabs()
        print("tour tabs after ? / after ? again:", first, second)
        if first != 1 or second != 1:
            errors.append(f"? should open exactly one tour tab and then reuse it: {first}, {second}")
        ctx.close()
    print("problems:", errors or "none")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
