// Which browser "chrome" (window look) belongs to a year, for the resolver and error pages.
// Netscape/IE4-5 up to 2001, IE6 2002-2006, IE7-8 2007-2010, early Chrome 2011-2015, modern Chrome 2016+.
export function browserEra(year) {
  const y = Number(year);
  if (y <= 2001) return "ie5";
  if (y <= 2006) return "ie6";
  if (y <= 2010) return "ie7";
  if (y <= 2015) return "chrome1";
  return "chrome2";
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return String(url || "").replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0]; }
}

// Tiny DOM builder (no innerHTML anywhere in this extension).
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
