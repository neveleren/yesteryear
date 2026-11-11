// Google module, service-worker side: period logos as data: URLs.
// Logos are not bundled (trademark); they are fetched once from the Wayback Machine (paths read from the
// archived homepages in research/wb/dl) and cached in chrome.storage.local as "goog:logo:<era>".
const LOGOS = {
  "1998": ["https://web.archive.org/web/1999id_/http://www2.google.com/google.jpg",
           "https://web.archive.org/web/1999id_/http://www.google.com/google.jpg"],
  "1999": ["https://web.archive.org/web/2001id_/http://www.google.com/images/logo.gif"],
  "2002": ["https://web.archive.org/web/2003id_/http://www.google.com/images/logo.gif"],
  "2004": ["https://web.archive.org/web/2005id_/http://www.google.com/images/logo.gif"],
  "2007": ["https://web.archive.org/web/2008id_/http://www.google.com/intl/en_ALL/images/logo.gif"],
  "2010": ["https://web.archive.org/web/2011id_/http://www.google.com/intl/en_ALL/images/srpr/logo1w.png"],
  "2011": ["https://web.archive.org/web/2012id_/http://www.google.com/intl/en_ALL/images/srpr/logo1w.png"],
  "2014": ["https://web.archive.org/web/2014id_/http://www.google.com/images/srpr/logo9w.png"],
  "2016": ["https://web.archive.org/web/2018id_/http://www.google.com/images/branding/googlelogo/1x/googlelogo_white_background_color_272x92dp.png"],
  "2020": ["https://web.archive.org/web/2021id_/http://www.google.com/images/branding/googlelogo/1x/googlelogo_white_background_color_272x92dp.png"],
  "2024": ["https://web.archive.org/web/2024id_/http://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png"]
};

const inflight = new Map();

async function toDataUrl(resp) {
  const type = (resp.headers.get("content-type") || "image/png").split(";")[0];
  const buf = new Uint8Array(await resp.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

async function fetchLogo(era) {
  const key = `goog:logo:${era}`;
  const got = (await chrome.storage.local.get(key))[key];
  if (got && (got.dataUrl || Date.now() - got.at < 864e5)) return got.dataUrl ? { ok: true, dataUrl: got.dataUrl } : { ok: false };
  for (const url of LOGOS[era] || []) {
    try {
      const r = await fetch(url, { credentials: "omit" });
      if (!r.ok || !/^image\//.test(r.headers.get("content-type") || "")) continue;
      const dataUrl = await toDataUrl(r);
      if (dataUrl.length < 200) continue;
      await chrome.storage.local.set({ [key]: { dataUrl, at: Date.now() } });
      return { ok: true, dataUrl };
    } catch (_) { /* try the next one */ }
  }
  await chrome.storage.local.set({ [key]: { dataUrl: null, at: Date.now() } });   // retry tomorrow
  return { ok: false };
}

export function initGoogle() {
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "google:logo") return false;
    const era = String(msg.era || "");
    if (!inflight.has(era)) inflight.set(era, fetchLogo(era).finally(() => inflight.delete(era)));
    inflight.get(era).then(reply, () => reply({ ok: false }));
    return true;
  });
}
