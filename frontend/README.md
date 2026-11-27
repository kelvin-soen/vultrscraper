# Frontend

Static, dependency-free frontend for the self-healing scraper. Served by the
FastAPI backend from this folder. No build step.

- **Integration contract and backend asks:** [INTEGRATION.md](INTEGRATION.md)
- **Tests:** `node --test tests/*.test.mjs` (Node 20+, no install)
- **Dev with fixtures:** `python3 -m http.server 5173`, then open `/?mock=heal`

## Experience

One continuous page with three states:

1. **Input**: the siftform. wordmark, a one-line promise and a single URL field.
   Validation is inline, Enter submits, and quick links fill the demo shop URLs.
2. **Live run**: a stage timeline derived from real job data, the screenshot
   once captured, a findings preview from scraper output, and attempt cards
   with expandable code, stdout and stderr. Repairs appear as a nested
   self-healing progression.
3. **Intelligence dashboard**: three views. *Overview* (KPIs, key findings,
   anomaly investigations, auto-selected charts, two-lane data quality),
   *Data & Evidence* (table with review flags, screenshot evidence, history)
   and *Agent & Infrastructure* (scraper registry, run facts, and expandable
   attempts, methodology, code and containment). The content is a declarative
   spec from the backend's intelligence layer, validated against a whitelist
   (`js/model/intel.js`) and rendered only by predefined components
   (`js/dashboard/`). See `../INTEGRATION_HANDOFF.md`. Mock: `/?mock=anomaly`.

## Structure

```
index.html            shell + strict CSP
css/tokens.css        design tokens (type, space, radii, colour, motion, art hooks)
css/base.css          reset + typography primitives
css/components.css    buttons, inputs, marks, panels, code, tables, evidence…
css/views.css         home / run / report layouts
js/app.js             state machine + routing (?job=<id>)
js/api/               HTTP adapter, polling, adapter selection
js/model/             pure logic: job interpretation, schema inference, formatting
js/components/        UI building blocks (no fetch, no global state)
js/views/             the three states
js/dashboard/         spec block registry + SVG charts (predefined components only)
js/components/cube.js live 3D loader: the logo as a rolling die, driven by js/model/live.js
js/model/export.js    Markdown / CSV / JSON / e-mail / scraper exports (field whitelist)
js/model/history.js   recent runs + saved report copies (this browser only)
dev/                  DEVELOPMENT ONLY: mock adapter + fixtures (?mock=), proxy.py
                      (frontend against a live backend), cube.html (loader lab),
                      e2e-live.mjs (end-to-end check against a real backend)
tests/                node:test suites for model, schema, url, client, fixtures
```

Presentation never fetches. API code never touches the DOM. All
interpretation of backend data lives in `js/model/job.js`.

## Design system

- **Colour:** pure greyscale in light and dark (follows the OS setting). There
  are no hues. Status is carried by **shape**: filled = done, crossed outline =
  failed, spinning arc = active, ring = waiting, dashed = not run.
- **Type:** system grotesk stack (Geist/Inter if installed, otherwise SF/Segoe)
  and a mono stack. 10-step scale, tight tracking on display sizes, tabular
  figures for numbers.
- **Space:** 4 px grid tokens (`--space-*`). **Radii:** 6–22 px plus full pills.
- **Borders over shadows:** 1 px hairlines. Shadows only on floating elements.
- **Motion:** 140/240/420 ms with one ease-out curve, and
  `prefers-reduced-motion` respected.
- **Future art layer:** every view has an inert `.art-layer` slot and
  `--art-*` tokens, so generative or dithered visuals can be added later
  without touching components.

The product is **siftform.** (always lowercase, with the period). The name lives in `js/config.js`. The mark is the original tile-and-dot as a rounded isometric cube: three faces in one tone, each with the dot in perspective (`--c-mark-*` tokens), drawn by `brandMark()` in `js/dom.js`; `icon.svg` is the same geometry for the favicon.
