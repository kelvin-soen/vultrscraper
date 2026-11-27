/**
 * The siftform. mark as a live 3D die.
 *
 * The logo (dom.js MARK) is an isometric cube: three rhombus faces, a dot drawn flat
 * on each, clipped to the silhouette hexagon with rounded outer corners. This
 * component renders the SAME construction from a real rotating cube every frame:
 *
 *   - orientation R = Q · R0, where R0 is the logo pose (cube axes → the logo's
 *     three iso edge directions) and Q a world rotation;
 *   - visible faces shaded by a light fitted so that, in the logo pose, the faces get
 *     exactly the --c-mark-top/left/right tones;
 *   - the dot on every face as an affine-projected circle (the logo's own technique);
 *   - the silhouette = convex hull of the projected corners, rounded with the logo's
 *     corner offset (in the logo pose this reproduces MARK.outline point for point).
 *
 * Every move is a whole number of quarter turns about the logo's cube axes, so each
 * landing is a symmetry of the cube: it lands in the logo pose every time. When
 * settled the exact static logo paths are swapped in, so "ready" is the brand mark
 * itself, not an approximation. No pips: every face carries the logo's single dot.
 *
 * Motion only reflects what the caller reports (setMode). It never advances by
 * itself towards "done"; settle() is called by the run view only when the backend
 * says the job is done.
 */

import { MARK, prefersReducedMotion } from "../dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const S3 = Math.sqrt(3);
const S2 = Math.SQRT2;

/* Logo pose: columns are where the cube axes e1, e2, e3 point (world: x right, y up,
 * z toward the viewer). Derived from the logo's edges a=(-12.56,-7.25), b=(12.56,-7.25),
 * c=(0,14.5) in SVG space; det = +1. */
const U1 = [-1 / S2, 1 / Math.sqrt(6), -1 / S3];
const U2 = [1 / S2, 1 / Math.sqrt(6), -1 / S3];
const U3 = [0, -Math.sqrt(2 / 3), -1 / S3];
const UP = [-U3[0], -U3[1], -U3[2]]; // scene "up": normal of the logo's top face

const K = 14.5 / (2 * Math.sqrt(2 / 3)); // viewBox units per cube unit (half-edge = 1)
const CX = 16;
const CY = 16;
const DOT_R = (2 * 2.6) / 14.5; // dot radius in cube units (logo: r 2.6 on a 14.5 edge)
const ROUND = 3.394; // logo outline: distance from a hull corner to where rounding starts

/* ---- tiny quaternion kit ----------------------------------------------- */
const qAxis = (ax, ang) => {
  const s = Math.sin(ang / 2);
  return [Math.cos(ang / 2), ax[0] * s, ax[1] * s, ax[2] * s];
};
const qMul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qNorm = (q) => {
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n);
};
const qRot = (q, v) => {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};

/* ---- easing ------------------------------------------------------------- */
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
const easeInOutBack = (t) => {
  const c = 1.2 * 1.525;
  return t < 0.5 ? (Math.pow(2 * t, 2) * ((c + 1) * 2 * t - c)) / 2 : (Math.pow(2 * t - 2, 2) * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
};

/* ---- geometry ------------------------------------------------------------ */
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const f = (n) => (Math.round(n * 1000) / 1000).toString();

function roundedPath(poly) {
  const n = poly.length;
  if (n < 3) return "";
  let d = "";
  for (let i = 0; i < n; i++) {
    const v = poly[i];
    const pv = poly[(i - 1 + n) % n];
    const nx = poly[(i + 1) % n];
    const lp = Math.hypot(pv[0] - v[0], pv[1] - v[1]) || 1;
    const ln = Math.hypot(nx[0] - v[0], nx[1] - v[1]) || 1;
    const o = Math.min(ROUND, 0.45 * lp, 0.45 * ln);
    const a = [v[0] + ((pv[0] - v[0]) * o) / lp, v[1] + ((pv[1] - v[1]) * o) / lp];
    const b = [v[0] + ((nx[0] - v[0]) * o) / ln, v[1] + ((nx[1] - v[1]) * o) / ln];
    d += `${i ? "L" : "M"}${f(a[0])} ${f(a[1])}Q${f(v[0])} ${f(v[1])} ${f(b[0])} ${f(b[1])}`;
  }
  return `${d}Z`;
}

/* ---- tones ----------------------------------------------------------------- */
function grey(css, fallback) {
  const m = String(css || "").trim().match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return fallback;
  const hex = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Light fitted so the logo pose reproduces the three face tones exactly. */
function fitLight(top, left, right) {
  const nT = UP, nL = U2.map((v) => -v), nR = U1.map((v) => -v);
  const lx = (right - left) / (nR[0] - nL[0]);
  const ly = (top - (left + right) / 2) / (nT[1] - nL[1]);
  const s = top - nT[1] * ly; // = A + nT.z * lz
  const A = s * 0.55;
  const lz = (s - A) / nT[2];
  // sanity: left/right reproduce as well (symmetric normals) — kept for readability
  return { A, L: [lx, ly, lz] };
}

/* ---------------------------------------------------------------------------- */

const MODES = {
  // backend stage -> motion vocabulary
  open: { kind: "roll", dur: 820, pause: 420, hop: 1 },
  prepare: { kind: "roll", dur: 760, pause: 360, hop: 1 },
  generate: { kind: "tumble", dur: 1250, pause: 260, hop: 1 },
  execute: { kind: "roll", dur: 520, pause: 120, hop: 1 },
  verify: { kind: "spin", dur: 760, pause: 300, hop: 0.35 },
  repair: { kind: "repair", dur: 900, pause: 160, hop: 1 },
  analyze: { kind: "spin", dur: 1150, pause: 380, hop: 0.25 },
};

export function cubeLoader({ label = "Working" } = {}) {
  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const uid = `sf-cube-${Math.random().toString(36).slice(2, 8)}`;
  const svg = svgEl("svg", { viewBox: "-6 -8 44 46", class: "cube__svg", "aria-hidden": "true", focusable: "false" });
  const shadow = svgEl("ellipse", { class: "cube__shadow", cx: "16", cy: "33.2", rx: "10", ry: "1.7" });
  const body = svgEl("g", { class: "cube__body" });
  const clip = svgEl("clipPath", { id: uid });
  const clipPath = svgEl("path");
  clip.append(clipPath);
  const faces = svgEl("g", { "clip-path": `url(#${uid})` });
  const dots = svgEl("g");
  body.append(faces, dots);
  svg.append(clip, shadow, body);

  const el = document.createElement("div");
  el.className = "cube";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  el.append(svg);

  /* pools: at most 3 faces / 3 dots are ever visible on a convex cube */
  const facePaths = [0, 1, 2].map(() => svgEl("path", { class: "cube__face" }));
  const dotEls = [0, 1, 2].map(() => svgEl("circle", { r: "1", class: "wordmark__dot cube__dot" }));
  faces.append(...facePaths);
  dots.append(...dotEls);

  let light = null;
  let dotFill = "";
  let tonesFromDom = false;
  const readTones = () => {
    tonesFromDom = el.isConnected;
    const cs = getComputedStyle(el);
    const top = grey(cs.getPropertyValue("--c-mark-top"), 85);
    const left = grey(cs.getPropertyValue("--c-mark-left"), 42);
    const right = grey(cs.getPropertyValue("--c-mark-right"), 10);
    light = fitLight(top, left, right);
    dotFill = cs.getPropertyValue("--c-mark-dot").trim() || "#fff";
  };
  const scheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  const onScheme = () => {
    readTones();
    if (!raf) draw(state.q, 0, 1);
  };
  scheme?.addEventListener?.("change", onScheme);

  const state = {
    q: [1, 0, 0, 0], // rest orientation (always a cube symmetry between moves)
    mode: "open",
    move: null, // {from, axisFn, start, dur, ...}
    pauseUntil: 0,
    settling: null, // {resolve}
    landing: null, // {start}
    settled: false,
    lastAxis: null,
  };

  function draw(q, hop, squash) {
    if (!light || (!tonesFromDom && el.isConnected)) readTones();
    const R = [qRot(q, U1), qRot(q, U2), qRot(q, U3)]; // world images of cube axes
    const lift = hop * K; // viewBox units upward along scene-up
    const ox = CX + UP[0] * lift;
    const oy = CY - UP[1] * lift;
    const proj = (w) => [ox + K * w[0], oy - K * w[1]];

    // squash about the lowest projected point (contact with the floor)
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      corners.push(proj([R[0][0] * sx + R[1][0] * sy + R[2][0] * sz, R[0][1] * sx + R[1][1] * sy + R[2][1] * sz, R[0][2] * sx + R[1][2] * sy + R[2][2] * sz]));
    }
    const floorY = Math.max(...corners.map((c) => c[1]));
    const sq = (p) => (squash === 1 ? p : [CX + (p[0] - CX) * (2 - squash), floorY + (p[1] - floorY) * squash]);

    clipPath.setAttribute("d", roundedPath(hull(corners.map(sq))));

    let used = 0;
    for (let i = 0; i < 3; i++) {
      for (const s of [-1, 1]) {
        const n = R[i].map((v) => v * s);
        if (n[2] <= 1e-4 || used >= 3) continue;
        const t1 = R[(i + 1) % 3], t2 = R[(i + 2) % 3];
        const c = n;
        const pts = [
          [c[0] + t1[0] + t2[0], c[1] + t1[1] + t2[1], c[2] + t1[2] + t2[2]],
          [c[0] + t1[0] - t2[0], c[1] + t1[1] - t2[1], c[2] + t1[2] - t2[2]],
          [c[0] - t1[0] - t2[0], c[1] - t1[1] - t2[1], c[2] - t1[2] - t2[2]],
          [c[0] - t1[0] + t2[0], c[1] - t1[1] + t2[1], c[2] - t1[2] + t2[2]],
        ].map((w) => sq(proj(w)));
        const lum = Math.max(0, Math.min(255, light.A + n[0] * light.L[0] + n[1] * light.L[1] + n[2] * light.L[2]));
        const tone = `rgb(${Math.round(lum)},${Math.round(lum)},${Math.round(lum)})`;
        const fp = facePaths[used];
        fp.setAttribute("d", `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join("L")}Z`);
        fp.setAttribute("fill", tone);
        fp.setAttribute("stroke", tone);
        fp.removeAttribute("visibility");

        const C = sq(proj(c));
        const Ua = sq(proj([c[0] + t1[0] * DOT_R, c[1] + t1[1] * DOT_R, c[2] + t1[2] * DOT_R]));
        const Va = sq(proj([c[0] + t2[0] * DOT_R, c[1] + t2[1] * DOT_R, c[2] + t2[2] * DOT_R]));
        const de = dotEls[used];
        de.setAttribute("transform", `matrix(${f(Ua[0] - C[0])} ${f(Ua[1] - C[1])} ${f(Va[0] - C[0])} ${f(Va[1] - C[1])} ${f(C[0])} ${f(C[1])})`);
        de.style.fill = dotFill;
        de.setAttribute("opacity", String(Math.min(1, n[2] * 6)));
        de.removeAttribute("visibility");
        used++;
      }
    }
    for (let k = used; k < 3; k++) {
      facePaths[k].setAttribute("visibility", "hidden");
      dotEls[k].setAttribute("visibility", "hidden");
    }

    const air = Math.max(0, hop);
    shadow.setAttribute("rx", f(10 * (1 - Math.min(0.45, air * 0.5)) * (2 - squash)));
    shadow.setAttribute("opacity", f(Math.max(0.25, 1 - air * 0.9)));
  }

  /* exact static logo for the settled state */
  function showLogo() {
    while (faces.firstChild) faces.removeChild(faces.firstChild);
    while (dots.firstChild) dots.removeChild(dots.firstChild);
    clipPath.setAttribute("d", MARK.outline);
    for (const face of ["top", "left", "right"]) faces.append(svgEl("path", { d: MARK[face], class: `wordmark__${face}` }));
    for (const transform of MARK.dots) dots.append(svgEl("circle", { r: MARK.dotRadius, transform, class: "wordmark__dot" }));
    shadow.setAttribute("rx", "10");
    shadow.setAttribute("opacity", "1");
    el.classList.add("is-settled");
  }

  function pickMove(now) {
    const m = MODES[state.mode] || MODES.prepare;
    const horiz = [U1, U2, U1.map((v) => -v), U2.map((v) => -v)];
    // avoid immediately undoing the previous roll
    const choices = horiz.filter((a) => !state.lastAxis || a.some((v, i) => Math.abs(v + state.lastAxis[i]) > 1e-6));
    const axis = choices[Math.floor(Math.random() * choices.length)];
    state.lastAxis = axis;
    if (m.kind === "roll") return { kind: "roll", start: now, dur: m.dur, pause: m.pause, rot: [[axis, Math.PI / 2]], hop: "edge", ease: easeInOut };
    if (m.kind === "spin") {
      const dir = Math.random() < 0.5 ? 1 : -1;
      return { kind: "spin", start: now, dur: m.dur, pause: m.pause, rot: [[UP, (dir * Math.PI) / 2]], hop: m.hop, ease: easeInOutBack };
    }
    if (m.kind === "repair") {
      // anticipation backwards, then a decisive roll the other way
      return { kind: "repair", start: now, dur: m.dur, pause: m.pause, rot: [[axis, -Math.PI / 2]], hop: "edge", ease: easeInOutBack };
    }
    // tumble: a toss with a half turn + a quarter twist (product of symmetries)
    const other = horiz.find((a) => a !== axis && a.some((v, i) => Math.abs(Math.abs(v) - Math.abs(axis[i])) > 1e-6)) || U2;
    return { kind: "tumble", start: now, dur: m.dur, pause: m.pause, rot: [[axis, Math.PI], [UP, Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1)], [other, 0]], hop: 0.95, ease: easeInOut };
  }

  function moveQ(mv, t) {
    const e = mv.ease(t);
    let q = state.q;
    for (const [ax, ang] of mv.rot) if (ang) q = qMul(qAxis(ax, ang * e), q);
    return qNorm(q);
  }

  function moveHop(mv, t) {
    if (mv.hop === "edge") {
      // centre height of a cube pivoting on its edge
      const th = (Math.PI / 2) * Math.min(1, Math.max(0, mv.ease(t)));
      return (S2 * Math.cos(Math.PI / 4 - th) - 1) * 0.9;
    }
    return mv.hop * 4 * t * (1 - t);
  }

  let raf = 0;
  function frame(now) {
    raf = 0;
    if (state.settled) return;

    if (state.landing) {
      const t = Math.min(1, (now - state.landing.start) / 360);
      const squash = 1 - 0.07 * Math.sin(Math.PI * t) * (1 - t * 0.4);
      draw(state.q, 0, squash);
      if (t >= 1) {
        state.settled = true;
        showLogo();
        const r = state.settling?.resolve;
        state.settling = null;
        r?.();
        return;
      }
      raf = requestAnimationFrame(frame);
      return;
    }

    if (!state.move) {
      if (state.settling) {
        state.landing = { start: now };
        raf = requestAnimationFrame(frame);
        return;
      }
      if (now < state.pauseUntil) {
        draw(state.q, 0, 1);
        raf = requestAnimationFrame(frame);
        return;
      }
      state.move = pickMove(now);
    }

    const mv = state.move;
    const t = Math.min(1, (now - mv.start) / mv.dur);
    if (t >= 1) {
      // land exactly on the symmetry (no float drift)
      let q = state.q;
      for (const [ax, ang] of mv.rot) if (ang) q = qMul(qAxis(ax, ang), q);
      state.q = snap(qNorm(q));
      state.move = null;
      state.pauseUntil = now + mv.pause;
      // small landing squash between moves
      draw(state.q, 0, 0.965);
    } else {
      draw(moveQ(mv, t), moveHop(mv, t), 1);
    }
    raf = requestAnimationFrame(frame);
  }

  /* quaternion components of cube symmetries in this frame are combos of 0, ±1/2, ±1/√2, ±1 */
  function snap(q) {
    const vals = [0, 0.5, Math.SQRT1_2, 1, Math.sqrt(3) / 2];
    // renormalise tiny drift only; exact rounding is not required for rendering
    return qNorm(q.map((v) => {
      const s = Math.sign(v), a = Math.abs(v);
      const c = vals.reduce((b, x) => (Math.abs(x - a) < Math.abs(b - a) ? x : b), 0);
      return Math.abs(c - a) < 1e-3 ? s * c : v;
    }));
  }

  const reduced = prefersReducedMotion();
  if (reduced) {
    showLogo();
    el.classList.add("is-reduced");
    state.settled = true;
  } else {
    draw(state.q, 0, 1);
    raf = requestAnimationFrame(frame);
  }

  return {
    el,
    /** Backend stage changed. Takes effect at the next move (a move always lands). */
    setMode(mode) {
      state.mode = mode;
      el.dataset.mode = mode;
    },
    setLabel(text) {
      el.setAttribute("aria-label", text);
    },
    /** Finish the current move, land, and show the exact logo. Resolves when settled. */
    settle({ failed = false } = {}) {
      el.classList.toggle("is-failed", failed);
      if (state.settled) return Promise.resolve();
      return new Promise((resolve) => {
        state.settling = { resolve };
        if (!raf) raf = requestAnimationFrame(frame);
      });
    },
    destroy() {
      state.settled = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      scheme?.removeEventListener?.("change", onScheme);
    },
  };
}
