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
  alert: ["M8 4.25v4.75", "M8 11.6v.15"],
  arrowUpRight: ["M5 11l6-6", "M6 5h5v5"],
  download: ["M8 2.5v8", "M4.5 7l3.5 3.5L11.5 7", "M3 13.5h10"],
  share: ["M8 10V2.5", "M5 5.5l3-3 3 3", "M3.5 8.5v5h9v-5"],
  more: ["M3.5 8h.01", "M8 8h.01", "M12.5 8h.01"],
  mail: ["M2.5 4h11v8h-11z", "M2.5 4.5L8 9l5.5-4.5"],
  link: ["M6.5 9.5l3-3", "M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1", "M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"],
  print: ["M4.5 6V2.5h7V6", "M4.5 11.5h-2v-5.5h11v5.5h-2", "M4.5 9.5h7v4h-7z"],
  file: ["M4 2.5h5l3 3v8H4z", "M9 2.5v3h3"],
  code: ["M6 5L3 8l3 3", "M10 5l3 3-3 3"],
  search: ["M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z", "M10.5 10.5l3 3"],
  clock: ["M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z", "M8 5v3l2 1.5"],
  trash: ["M3 4.5h10", "M6.5 4.5V3h3v1.5", "M4.5 4.5l.5 9h6l.5-9"],
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

/* ---- brand mark -------------------------------------------------------- */
/*
 * siftform. mark: the original tile-and-dot as a rounded isometric cube.
 * 32px grid. The silhouette is a pointy-top hexagon with rounded outer
 * corners; the faces are plain rhombi clipped to it, so the inner edges stay
 * crisp. Each face carries the dot: a circle (r 2.6) drawn flat on that face
 * via an affine matrix, so all three foreshorten correctly. Tones come from
 * --c-mark-* tokens (light and dark). icon.svg uses the same geometry.
 */
export const MARK = {
  outline:
    "M13.06 3.2Q16 1.5 18.94 3.2L25.61 7.05Q28.56 8.75 28.56 12.15L28.56 19.85Q28.56 23.25 25.61 24.95L18.94 28.8Q16 30.5 13.06 28.8L6.39 24.95Q3.44 23.25 3.44 19.85L3.44 12.15Q3.44 8.75 6.39 7.05Z",
  top: "M16 1.5L28.56 8.75L16 16L3.44 8.75Z",
  left: "M3.44 8.75L16 16L16 30.5L3.44 23.25Z",
  right: "M16 16L28.56 8.75L28.56 23.25L16 30.5Z",
  dotRadius: "2.6",
  /* matrix(u.x u.y v.x v.y cx cy): the face's two edge directions + its centre */
  dots: [
    "matrix(0.866 0.5 -0.866 0.5 16 8.75)",
    "matrix(0.866 0.5 0 1 9.72 19.625)",
    "matrix(0.866 -0.5 0 1 22.28 19.625)",
  ],
};

let markSeq = 0;

export function brandMark({ className = "wordmark__glyph" } = {}) {
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const clipId = `sf-mark-${++markSeq}`;
  const svg = svgEl("svg", { viewBox: "0 0 32 32", class: className, "aria-hidden": "true", focusable: "false" });
  const clip = svgEl("clipPath", { id: clipId });
  clip.append(svgEl("path", { d: MARK.outline }));
  const faces = svgEl("g", { "clip-path": `url(#${clipId})` });
  for (const face of ["top", "left", "right"]) {
    faces.append(svgEl("path", { d: MARK[face], class: `wordmark__${face}` }));
  }
  svg.append(clip, faces);
  for (const transform of MARK.dots) {
    svg.append(svgEl("circle", { r: MARK.dotRadius, transform, class: "wordmark__dot" }));
  }
  return svg;
}

/* ---- motion helpers ---------------------------------------------------- */

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Copy text. The async Clipboard API only exists in secure contexts (https or
 * localhost); the demo VM serves plain http, so fall back to a hidden textarea.
 */
export async function copyText(text) {
  const value = String(text ?? "");
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* permission denied or unfocused: try the fallback */
    }
  }
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.className = "sr-clip";
  const prev = document.activeElement;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (prev && typeof prev.focus === "function") prev.focus({ preventScroll: true });
  return ok;
}

/** Save text as a file via a temporary blob: URL (no server round trip). */
export function downloadText(name, text, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
