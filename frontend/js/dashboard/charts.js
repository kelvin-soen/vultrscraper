/**
 * Predefined chart components (SVG, monochrome). Each takes a validated spec block and
 * returns an element. Identity is carried by position and shape, never by hue:
 *   filled dot = a record, ringed dot = flagged for review, grey band = reference range.
 * All labels are set with textContent. Every value is also in the Data & Evidence table.
 */

import { h } from "../dom.js";
import { formatMoney } from "../model/format.js";

const NS = "http://www.w3.org/2000/svg";
const kr = (n) => formatMoney(Math.round(n), "SEK");

function s(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  if (text != null) el.textContent = String(text);
  return el;
}

/* ---- scales ------------------------------------------------------------ */

function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => span / m <= count) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  }
  return out;
}

function makeScale(values, kind, x0, x1) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (kind === "log") {
    const a = Math.log10(lo / 1.25);
    const b = Math.log10(hi * 1.25);
    const f = (v) => x0 + ((Math.log10(Math.max(v, 1)) - a) / (b - a)) * (x1 - x0);
    return { f, ticks: logTicks(10 ** a, 10 ** b) };
  }
  let ticks = niceTicks(0, hi * 1.05);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : hi;
  while (ticks[ticks.length - 1] < hi) ticks = ticks.concat(ticks[ticks.length - 1] + step);
  const top = ticks[ticks.length - 1] || hi;
  return { f: (v) => x0 + (v / top) * (x1 - x0), ticks };
}

const tickLabel = (v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v)));

/* ---- shell: responsive frame + shared tooltip -------------------------- */

function frame(block, draw, { minWidth = 320 } = {}) {
  const tip = h("div", { class: "viz__tip", role: "status", hidden: true });
  const canvas = h("div", { class: "viz__canvas" });
  const el = h(
    "figure",
    { class: `viz viz--${block.kind}` },
    h("figcaption", { class: "viz__head" }, h("p", { class: "viz__title", text: block.title || "" }), block.subtitle ? h("p", { class: "viz__sub", text: block.subtitle }) : null),
    canvas,
    tip
  );
  const show = (evt, value, ...lines) => {
    tip.replaceChildren(h("strong", { class: "viz__tip-value", text: value }), ...lines.filter(Boolean).map((l) => h("span", { text: l })));
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    const r = evt.target.getBoundingClientRect();
    const x = r.left + r.width / 2 - box.left;
    tip.style.setProperty("left", `${Math.min(Math.max(x, 80), box.width - 80)}px`);
    tip.style.setProperty("top", `${r.top - box.top - 8}px`);
  };
  const hide = () => (tip.hidden = true);
  let lastW = 0;
  const render = () => {
    const w = Math.max(minWidth, Math.round(canvas.clientWidth || 640));
    if (w === lastW) return;
    lastW = w;
    canvas.replaceChildren(draw(w, { show, hide }));
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(render).observe(canvas);
  queueMicrotask(render);
  return el;
}

/** Transparent hit target (>= 24px) carrying hover + keyboard focus. */
function hit(svg, cx, cy, r, ui, value, lines, label) {
  const t = s("circle", { cx, cy, r, class: "viz__hit", tabindex: 0, role: "img", "aria-label": label });
  const on = (e) => ui.show(e, value, ...lines);
  t.addEventListener("pointerenter", on);
  t.addEventListener("focus", on);
  t.addEventListener("pointerleave", ui.hide);
  t.addEventListener("blur", ui.hide);
  svg.append(t);
}

/* ---- price strip: one dot per record, grouped by category -------------- */

export function priceStrip(block) {
  const pts = block.points.filter((p) => typeof p.value === "number" && p.value > 0);
  const groups = [...new Set(pts.map((p) => p.group))];
  const order = groups
    .map((g) => ({ g, med: median(pts.filter((p) => p.group === g).map((p) => p.value)) }))
    .sort((a, b) => b.med - a.med)
    .map((x) => x.g);
  return frame(block, (W, ui) => {
    const left = Math.min(150, Math.max(96, W * 0.22));
    const right = 24;
    const row = 40;
    const top = 8;
    const H = top + order.length * row + 30;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "viz__svg", role: "group", "aria-label": block.title });
    const bandVals = pts.flatMap((p) => p.band || []);
    const sc = makeScale(pts.map((p) => p.value).concat(bandVals), block.scale === "log" ? "log" : "linear", left, W - right);
    for (const t of sc.ticks) {
      const x = sc.f(t);
      svg.append(s("line", { x1: x, x2: x, y1: top, y2: H - 26, class: "viz__grid" }));
      svg.append(s("text", { x, y: H - 8, class: "viz__tick", "text-anchor": "middle" }, tickLabel(t)));
    }
    order.forEach((g, gi) => {
      const y = top + gi * row + row / 2;
      const inG = pts.filter((p) => p.group === g);
      svg.append(s("text", { x: left - 14, y: y + 4, class: "viz__label", "text-anchor": "end" }, g));
      const band = inG.find((p) => p.band)?.band;
      if (band) svg.append(s("rect", { x: sc.f(band[0]), y: y - 9, width: Math.max(2, sc.f(band[1]) - sc.f(band[0])), height: 18, rx: 4, class: "viz__band" }));
      svg.append(s("line", { x1: left, x2: W - right, y1: y, y2: y, class: "viz__rule" }));
      for (const p of inG) {
        const x = sc.f(p.value);
        if (p.flagged) {
          svg.append(s("circle", { cx: x, cy: y, r: 8, class: "viz__ring" }));
          svg.append(s("circle", { cx: x, cy: y, r: 3, class: "viz__dot" }));
          const anchor = x > W - right - 120 ? "end" : "start";
          svg.append(s("text", { x: anchor === "end" ? x - 14 : x + 14, y: y - 10, class: "viz__callout", "text-anchor": anchor }, `${p.name} · ${kr(p.value)}`));
        } else {
          svg.append(s("circle", { cx: x, cy: y, r: 5, class: "viz__dot viz__dot--ringed" }));
        }
        hit(svg, x, y, 12, ui, kr(p.value), [p.name, p.flagged ? `${g} · flagged for review` : g], `${p.name}: ${kr(p.value)}`);
      }
    });
    return svg;
  });
}

/* ---- category bars: median per category with reference range ----------- */

export function categoryBars(block) {
  const bars = block.bars.filter((b) => typeof b.value === "number");
  return frame(block, (W, ui) => {
    const left = Math.min(150, Math.max(96, W * 0.22));
    const right = 92;
    const row = 36;
    const H = bars.length * row + 30;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "viz__svg", role: "group", "aria-label": block.title });
    const max = Math.max(...bars.map((b) => Math.max(b.value, b.band?.[1] || 0)));
    const sc = makeScale([max], "linear", left, W - right);
    for (const t of sc.ticks) {
      const x = sc.f(t);
      svg.append(s("line", { x1: x, x2: x, y1: 0, y2: H - 26, class: "viz__grid" }));
      svg.append(s("text", { x, y: H - 8, class: "viz__tick", "text-anchor": "middle" }, tickLabel(t)));
    }
    bars.forEach((b, i) => {
      const y = i * row + row / 2;
      const x1 = sc.f(b.value);
      const th = 14;
      const r = Math.min(4, (x1 - left) / 2);
      svg.append(s("text", { x: left - 14, y: y + 4, class: "viz__label", "text-anchor": "end" }, b.label));
      svg.append(s("path", { d: `M${left} ${y - th / 2}H${x1 - r}Q${x1} ${y - th / 2} ${x1} ${y - th / 2 + r}V${y + th / 2 - r}Q${x1} ${y + th / 2} ${x1 - r} ${y + th / 2}H${left}Z`, class: "viz__bar" }));
      if (b.band) {
        const a = sc.f(b.band[0]);
        const z = sc.f(b.band[1]);
        svg.append(s("line", { x1: a, x2: z, y1: y + th / 2 + 4, y2: y + th / 2 + 4, class: "viz__range" }));
        svg.append(s("line", { x1: a, x2: a, y1: y + th / 2 + 1, y2: y + th / 2 + 7, class: "viz__range" }));
        svg.append(s("line", { x1: z, x2: z, y1: y + th / 2 + 1, y2: y + th / 2 + 7, class: "viz__range" }));
      }
      svg.append(s("text", { x: Math.max(x1, b.band ? sc.f(b.band[1]) : 0) + 8, y: y + 4, class: "viz__value" }, kr(b.value)));
      hit(svg, (left + x1) / 2, y, Math.max(12, (x1 - left) / 2), ui, kr(b.value), [`${b.label} · median of ${b.count}`, b.band ? `Typical ${kr(b.band[0])}–${kr(b.band[1])}` : null], `${b.label}: median ${kr(b.value)}`);
    });
    return svg;
  });
}

/* ---- price change: before → after per product -------------------------- */

export function priceChange(block) {
  const rows = block.rows.filter((r) => typeof r.before === "number" && typeof r.after === "number");
  const changed = rows.filter((r) => r.before !== r.after);
  const unchanged = rows.length - changed.length;
  const fig = frame(block, (W, ui) => {
    const left = Math.min(190, Math.max(110, W * 0.28));
    const right = 70;
    const row = 34;
    const H = changed.length * row + 30;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "viz__svg", role: "group", "aria-label": block.title });
    const vals = changed.flatMap((r) => [r.before, r.after]);
    const kind = Math.max(...vals) / Math.min(...vals) > 20 ? "log" : "linear";
    const sc = makeScale(vals, kind, left, W - right);
    for (const t of sc.ticks) {
      const x = sc.f(t);
      svg.append(s("line", { x1: x, x2: x, y1: 0, y2: H - 26, class: "viz__grid" }));
      svg.append(s("text", { x, y: H - 8, class: "viz__tick", "text-anchor": "middle" }, tickLabel(t)));
    }
    changed.forEach((r, i) => {
      const y = i * row + row / 2;
      const a = sc.f(r.before);
      const b = sc.f(r.after);
      svg.append(s("text", { x: left - 14, y: y + 4, class: `viz__label${r.flagged ? " viz__label--flag" : ""}`, "text-anchor": "end" }, r.name));
      svg.append(s("line", { x1: a, x2: b, y1: y, y2: y, class: "viz__link" }));
      svg.append(s("circle", { cx: a, cy: y, r: 4, class: "viz__dot viz__dot--before" }));
      svg.append(s("circle", { cx: b, cy: y, r: r.flagged ? 8 : 5, class: r.flagged ? "viz__ring" : "viz__dot viz__dot--ringed" }));
      if (r.flagged) svg.append(s("circle", { cx: b, cy: y, r: 3, class: "viz__dot" }));
      const pct = (r.after / r.before - 1) * 100;
      const label = `${pct > 0 ? "+" : "−"}${Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)).toLocaleString("en-GB") : Math.abs(pct).toFixed(0)}%`;
      svg.append(s("text", { x: W - right + 20, y: y + 4, class: "viz__value" }, label));
      hit(svg, b, y, 12, ui, kr(r.after), [r.name, `was ${kr(r.before)} (${label})`, r.flagged ? "flagged for review" : null], `${r.name}: ${kr(r.before)} to ${kr(r.after)}`);
    });
    return svg;
  });
  if (unchanged) fig.append(h("p", { class: "viz__foot", text: `${unchanged} other product${unchanged === 1 ? "" : "s"} kept the same price. Hollow dot: last run. Filled: now.` }));
  else fig.append(h("p", { class: "viz__foot", text: "Hollow dot: last run. Filled: now." }));
  return fig;
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export const CHARTS = { price_strip: priceStrip, category_bars: categoryBars, price_change: priceChange };
