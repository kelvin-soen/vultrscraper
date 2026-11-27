/**
 * Minimal, safe DOM builder.
 *
 * Every string child becomes a Text node, and attributes are set with
 * setAttribute. Nothing in the app uses innerHTML, so scraped content,
 * generated code and backend messages are always rendered as inert text.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
    else if (k === "text") el.textContent = String(v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === "ref") v(el);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "href" || k === "src") {
      const s = String(v);
      // Block script-capable URLs; images may use data:image/*.
      if (/^\s*(javascript|vbscript):/i.test(s)) continue;
      if (/^\s*data:/i.test(s) && !(k === "src" && /^data:image\//i.test(s))) continue;
      el.setAttribute(k, s);
    } else el.setAttribute(k, v === true ? "" : String(v));
  }
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

/* ---- icons ------------------------------------------------------------- */
/* A deliberately tiny set. 16px grid, 1.5px strokes, currentColor. */

const ICONS = {
  arrowRight: ["M3.5 8h9", "M8.5 4l4 4-4 4"],
  arrowLeft: ["M12.5 8h-9", "M7.5 4l-4 4 4 4"],
  check: ["M3.5 8.5l3 3 6-7"],
  x: ["M4.5 4.5l7 7", "M11.5 4.5l-7 7"],
  chevron: ["M6 4l4 4-4 4"],
  external: ["M6.5 3.5h-3v9h9v-3", "M9 3.5h3.5V7", "M12.5 3.5L7.5 8.5"],
  copy: ["M5.5 5.5h7v7h-7z", "M3.5 10.5v-7h7"],
  expand: ["M9.5 3.5h3v3", "M6.5 12.5h-3v-3", "M12.5 3.5l-3.5 3.5", "M3.5 12.5l3.5-3.5"],
  refresh: ["M12.5 8a4.5 4.5 0 1 1-1.4-3.3", "M12.5 3v2.5H10"],
  minus: ["M4.5 8h7"],
};

export function icon(name, { size = 16, label } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "icon");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/* ---- motion helpers ---------------------------------------------------- */

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
