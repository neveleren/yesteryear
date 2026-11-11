// Mini player for the toolbar popup: Previous / Play-Pause / Next, the scrolling "Artist - Title",
// and "Show player", which opens the side panel. The popup's HTML holds the markup (ids mp-*); this
// module only wires it: mountMiniPlayer(document.getElementById("mini-player"), {onProblem, beforeAction}).
// beforeAction runs synchronously before every button (the popup saves a year still being chosen).
import { connectMusic } from "./remote.js";
import { liveTime, trackText } from "./music_state.js";
import { formatTime } from "./playlist.js";

export function mountMiniPlayer(root, { onProblem = () => {}, beforeAction = () => {} } = {}) {
  const q = (id) => root.querySelector(`#${id}`);
  const el = {
    legend: q("mp-legend"), screen: q("mp-screen"), marquee: q("mp-marquee"), text: q("mp-text"),
    time: q("mp-time"), prev: q("mp-prev"), play: q("mp-play"), next: q("mp-next"), show: q("mp-show")
  };
  let state = null;
  let windowId = null;
  let shownText = null;

  const music = connectMusic(render);

  const command = (cmd) => () => {
    try { beforeAction(); } catch (_) { /* the music still answers */ }
    music.control(cmd);
  };
  el.play.addEventListener("click", command("toggle"));
  el.prev.addEventListener("click", command("prev"));
  el.next.addEventListener("click", command("next"));

  if (el.show) {
    el.show.disabled = true;
    // Looked up before any click: sidePanel.open() must run inside the click, with no await before it.
    chrome.windows?.getCurrent?.().then(
      (win) => { windowId = win.id; el.show.disabled = false; },
      (err) => onProblem(`Could not find this window: ${err?.message || err}`)
    );
    el.show.addEventListener("click", () => {
      if (windowId === null) return;
      try { beforeAction(); } catch (_) { /* open the player anyway */ }
      try {
        chrome.sidePanel.open({ windowId }).then(
          () => window.close(),
          (err) => onProblem(`Could not open the player: ${err?.message || err}`)
        );
      } catch (err) {
        onProblem(`Could not open the player: ${err?.message || err}`);
      }
    });
  }

  function render(s) {
    state = s;
    if (el.legend) el.legend.textContent = `Music of ${s.year}`;
    const line = s.problem && s.status ? s.status : s.track ? `${s.index + 1}. ${trackText(s)}` : "No songs for this year";
    setText(line);
    el.screen?.classList.toggle("problem", s.problem);
    el.screen?.classList.toggle("on", s.playing);
    el.play.classList.toggle("is-playing", s.playing);
    el.play.setAttribute("aria-label", s.playing ? "Pause" : "Play");
    el.play.title = s.playing ? "Pause" : "Play";
    tick();
  }

  function tick() {
    if (!state || !el.time) return;
    el.time.textContent = state.loading ? "--:--" : formatTime(liveTime(state));
  }

  // Scrolls only when the line does not fit.
  function setText(line) {
    if (line === shownText) return;
    shownText = line;
    el.text.textContent = line;
    el.marquee.classList.remove("scroll");
    requestAnimationFrame(() => {
      if (shownText !== line || el.text.scrollWidth <= el.marquee.clientWidth + 1) return;
      el.text.textContent = `${line}   ***   ${line}   ***   `;
      el.marquee.style.setProperty("--mp-marquee-s", `${Math.max(6, Math.round(line.length / 4))}s`);
      el.marquee.classList.add("scroll");
    });
  }

  const timer = setInterval(() => { if (state?.playing) tick(); }, 500);

  return {
    get state() { return state; },
    close() { clearInterval(timer); music.close(); }
  };
}
