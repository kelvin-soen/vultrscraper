# Handoff: frontend integration and product polish

Branch `feature/frontend-polish`, cut from `origin/main` at `4c0a575` (2026-11-27).
Not merged. Nothing was force-pushed, and nothing on the VM was touched.

## 0. TL;DR

| What | Status |
|---|---|
| Reconcile the unmerged `feature/intelligence-dashboard` with main's latest backend (saved-scraper reuse, rendered mode, qwen vision) | **Merged on this branch**, conflicts resolved in `backend/main.py` without dropping either side. 19/19 backend tests pass |
| 3D cube loader: the exact siftform. mark as a rolling die (no pips), settling into the logo pose | Done (`js/components/cube.js`). Rest pose matches `MARK.outline` to 0.009 viewBox units, and settle swaps in the exact static mark |
| Loader stage and text driven by real backend stages (open → generate / reuse → sandbox → verify → repair → analyze) | Done (`js/model/live.js`). Nothing is simulated. Unknown reasons are shown verbatim |
| Report toolbar: Run again · Share ▾ (copy link, email summary) · Export ▾ (Markdown, CSV, JSON, Python scraper, print/PDF) | Done. Every action tested against real runs (§4) |
| Recent history, favicons, search/sort, per-value copy, timestamps, toasts, responsive, empty/loading/error states | Done |
| Saved reports, persistent report URLs, historical comparison, reusable scrapers | Done **as far as the backend allows**. See §5 for what still needs backend work |
| Cancellation | **Not offered**: the backend has no cancel endpoint (§5.1). The UI never shows a fake cancel button |

## 1. Branch reconciliation

- `origin/main` (backend owner): new jobs start from the saved scraper, rendered mode for JavaScript sites, qwen vision with nemotron fallback, `models` on jobs.
- `origin/feature/intelligence-dashboard` (our earlier frontend work, never merged): three-view dashboard, intelligence layer (`backend/intelligence/`), versioned scraper registry, anomaly demo variant of the shop.
- Merge commit `ea7e763`. The only conflict was `backend/main.py`:
  - `scrapers.get()` (which has a `mode`) stays the primary source of saved scrapers. The intelligence registry is a **fallback** that survives restarts (`_registry_saved`).
  - Registry versions now store `mode`, so a rendered-mode scraper is reused as rendered (`registry.record_verified(..., mode=)`).
  - `intel_hook.after_success` runs before `status = "done"`. `created_at`/`finished_at` are set on every exit path, including the JavaScript-page early exit.
  - Test stub updated for `write_scraper(url, html, mode)`.
- `INTELLIGENCE=0` still restores main's behaviour exactly.

## 2. Loader (`js/components/cube.js`, `js/model/live.js`)

**Geometry.** The logo is an isometric cube clipped to a rounded hexagon, with a dot drawn flat on each face. The loader builds the same construction from a real rotating cube every frame:
orientation `R = Q·R0` (R0 = the logo pose), visible faces shaded by a light fitted so the logo pose gives exactly `--c-mark-top/left/right`, affine-projected dots, and the silhouette = convex hull of the projected corners rounded with the logo's own corner offset. Every move is a whole number of quarter turns about the logo's cube axes, so **every landing is the logo pose**. `settle()` finishes the current move, does a small landing squash, and swaps in the static `MARK` paths. Light/dark theme, `prefers-reduced-motion` (static mark), and tab-hidden (rAF pauses) are handled.

**Stages** (from `GET /api/jobs/{id}`, polled every 2 s):

| Backend signal | Loader text | Motion |
|---|---|---|
| no attempts, no screenshot | Opening the page | slow roll |
| screenshot, no attempts | Page captured · Preparing the extraction | roll |
| attempt `verdict: running`, `reason: generating scraper` | Writing a scraper · *glm-5.3* is writing Python… | tumble (toss + twist) |
| `running in sandbox`, `source: saved` | Running the saved scraper · no AI call | quick rolls |
| `running in sandbox` | Running in the sandbox · attempt *n* | quick rolls |
| `checking output` | Verifying results · checking *N* extracted records… | quarter-turn spins |
| `repairing scraper` | Repairing the scraper · Attempt *n* failed: *reason* | anticipation roll |
| `phase: analyzing` (intelligence branch only) | Checking plausibility | slow spins |
| `status: done` | Report ready → cube settles → report | settle |
| `status: failed` | Extraction failed · *error* | settles, greyed out |

The report opens only after the cube has landed (`runView.onSettled`). Older payloads without the `running` vocabulary fall back to inference from the fields that exist (code present? exit code present?). The mock fixtures use this path.

Lab page: `/dev/cube.html` drives every mode by hand.

## 3. Report actions and exports

`[Run again] [Share ▾] [Export ▾]` (one button, two menus). "New" stays in the top bar.

| Action | Output | Notes |
|---|---|---|
| Copy link | `http(s)://<origin>/?job=<id>` | No mock flag, no hash. Disabled for mock data |
| Email summary | `mailto:?subject=…&body=…` | Opens the user's mail client; nothing is sent by siftform. Records are trimmed to keep the URL ≤ 1800 chars ("…and N more") |
| Copy as Markdown | Title, source, status, records table, needs-review, verification per attempt, this-run security events | Pipes escaped |
| Records as CSV | Raw keys and raw values, UTF-8 BOM, CRLF | Text starting with `= + - @` is prefixed with `'` (spreadsheet formula injection) |
| Results as JSON | `siftform.report/v1`: report, records, metadata (fields, models, attempts, reuse), verification, evidence references, this-run security events, plausibility findings | **Whitelist** (§6) |
| Python scraper | `final_code` with a header (source, verified or not, requirements) | Falls back to the last attempt's code, labelled **unverified** |
| Print or save as PDF | `window.print()` with a print stylesheet: all three views in order, light, no controls, absolute timestamps | |

Clipboard: the demo VM is plain `http`, where `navigator.clipboard` does not exist, so `copyText` falls back to a hidden-textarea `execCommand("copy")`. Every action ends in a toast; failures say so.

## 4. Testing (real backend)

Local frontend against the live backend: `python3 frontend/dev/proxy.py --backend http://70.34.217.56:8000` (serves `frontend/`, forwards `/api/*`). Nothing was deployed or restarted on the VM, and `POST /api/scrapers/reset` was **not** called (it would wipe the team's demo state). Test jobs used `/shop/` (trailing slash), which is its own saved-scraper key, so the team's `/shop` scraper was left alone.

- Unit: `cd frontend && node --test tests/*.test.mjs` → **47/47**. Backend: `MOCK_SANDBOX=1 .venv/bin/python -m unittest discover -s tests` → **19/19**.
- End-to-end: `frontend/dev/e2e-live.mjs` (Playwright + local Chrome, real jobs). Results: see §4.1, screenshots in `docs/screenshots/polish/`.

<!-- E2E_RESULTS -->

## 5. What still depends on backend changes

1. **Cancellation.** There is no `POST /api/jobs/{id}/cancel`. The runtime already supports cancelling a run (its benchmark has a cancellation test), so the backend needs a cancel flag checked between steps in `_run_job` plus a runtime cancel call. The UI shows no cancel button until then. Leaving the run view keeps the job running, and it stays in Recent.
2. **Persistence and ownership.** Jobs live in server memory, with no list endpoint and no users. So:
   - Recent history and saved reports are per browser (localStorage). They never show anyone else's runs.
   - A shared report link works for others only while the server still has the job. After a restart only the creator's browser has a (labelled) saved copy, without the screenshot.
   - Needed: persist jobs (SQLite) and add an owner or share token.
3. **Share links expose the raw job.** `GET /api/jobs/{id}` is unauthenticated and returns everything, including `runtime_job_id`, sandbox telemetry, the benchmark, stdout/stderr and the code. The ids are 48 random bits, so they can't be enumerated, but anyone with a link can read the raw JSON. Exports strip all of this; the link can't. Recommended: a public projection (`GET /api/reports/{share_token}`) that returns only the export whitelist.
4. **`GET /api/scrapers` is global.** It lists every site anyone has scraped. The UI deliberately never calls it. Consider restricting it to the admin/demo reset flow.
5. **Timestamps.** `created_at`/`finished_at` exist only with this branch's backend. Against the current live server (main) the UI shows times observed by the browser and says so (tooltip, JSON `times_observed_by: "browser"`).
6. **Intelligence layer.** Merged here but not running on the VM. Until the backend is restarted from this branch, the report uses `fallbackViews` ("Plausibility analysis: not available on this backend") and the comparison comes from this browser's saved copies.
7. **Favicons.** Loaded straight from the scraped site's `/favicon.ico` (no third-party service), with the page-title initial as fallback. The backend could return the page's `<link rel=icon>` from the screenshot HTML for better coverage.
8. **Unreachable sites don't fail fast.** For a domain that doesn't resolve, the runtime's `/screenshot` returns the browser's error page as if it were content. The backend then spends 3 code-model attempts (~3.5 min) on it before failing with "no working scraper after 3 attempts". The UI reports this honestly (repair stages, then "Extraction failed"), but `sandbox_client.screenshot` should treat a navigation error / non-2xx `status` as `could not load page` up front.
9. **Anomaly demo** (`/shop?v=anomaly`) needs the shop restarted from this branch's `demo-site/server.py` (see `INTEGRATION_HANDOFF.md` §8).

## 6. Privacy and security notes

- Exports are built from an explicit field whitelist (`js/model/export.js`). They never contain `runtime_job_id`, sandbox telemetry, benchmark details, raw stdout/stderr, the screenshot or the API key. Unit-tested (`tests/polish.test.mjs`) and checked again end to end on real exports.
- Saved copies (localStorage) drop the screenshot and runtime ids. Mock runs (`?mock=`) never enter history.
- CSP: `img-src` now allows `http:`/`https:` for site favicons only. Scripts, styles and API calls stay same-origin. Favicons load with `referrerpolicy=no-referrer`.
- No `innerHTML` anywhere. All scraped text is rendered as text nodes.

## 7. Deploying (for the backend owner)

1. Review and merge `feature/frontend-polish` (it contains `feature/intelligence-dashboard`).
2. Restart the backend (:8000). The frontend is static, so for a **frontend-only** update just pull: no restart needed, the new UI works against the current backend.
3. Optional: restart the shop from this branch for `?v=anomaly`.
