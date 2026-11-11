window.__log = [];
window.__iframeApiLoaded = typeof window.YT !== 'undefined';
const f = document.getElementById('yt');
const post = (o) => f.contentWindow.postMessage(JSON.stringify(Object.assign({id: 1, channel: 'widget'}, o)), 'https://www.youtube.com');
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://www.youtube.com') return;
  let d; try { d = JSON.parse(e.data); } catch (_) { return; }
  const i = d.info || {};
  const vid = i.videoData && i.videoData.video_id;
  if (d.event === 'onReady' || d.event === 'onStateChange' || d.event === 'onError' || vid || i.playlistIndex !== undefined || i.currentTime !== undefined) {
    window.__log.push({t: Math.round(performance.now()), ev: d.event, state: i.playerState !== undefined ? i.playerState : (typeof i === 'number' ? i : undefined), vid, idx: i.playlistIndex, ct: i.currentTime !== undefined ? Math.round(i.currentTime * 10) / 10 : undefined, err: d.event === 'onError' ? d.info : undefined});
  }
});
f.addEventListener('load', () => {
  let n = 0;
  const h = setInterval(() => { post({event: 'listening'}); if (++n > 5) clearInterval(h); }, 300);
  setTimeout(() => post({event: 'command', func: 'playVideo', args: []}), 3000);
  setTimeout(() => post({event: 'command', func: 'nextVideo', args: []}), 11000);
  setTimeout(() => post({event: 'command', func: 'nextVideo', args: []}), 19000);
});
