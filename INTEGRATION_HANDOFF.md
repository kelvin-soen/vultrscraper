# Integration handoff: intelligence dashboard

Branch `feature/intelligence-dashboard`, cut from `origin/main` at `b3d0cf9`, 2026-11-27.
Not merged. Nothing in `/root/app` was edited, and nothing was force-pushed.

> **Note for whoever merges:** `/root/app` has an untracked `INTEGRATION_HANDOFF.md` in its root
> (the earlier frontend + runtime handoff). This branch tracks a file with the same name, so
> `git merge`/`pull` in `/root/app` will refuse until that untracked file is renamed or moved.

## 0. TL;DR

| What | Status |
|---|---|
| Report redesigned into three views (Overview, Data & Evidence, Agent & Infrastructure), monochrome, existing 3D mark kept | Done. Inspected on real runs, in dark, light and mobile |
| Separate data-quality + anomaly layer: extraction verification and semantic plausibility kept apart | Done. Real runs below |
| Agent investigates unusual values (statistics, category priors, history, contained research, AI reasoning) and explains them. It never changes them | Done. Real glm-5.3 assessments below |
| Controlled anomaly scenario on the demo golf shop (`/shop?v=anomaly` + product pages) | Done. Live on `:8080` (see §8 about the shop restart) |
| Reusable, versioned scrapers with saved schema + verification criteria. New jobs reuse the last verified one and compare with history. Drift triggers self-healing | Done. Real runs below |
| Adaptive dashboard from a declarative spec + whitelisted, predefined frontend components (no executable frontend code) | Done |
| Backend integration | Small additive hook in `backend/main.py` (≈25 lines, §4). Everything else is a new package `backend/intelligence/`. `INTELLIGENCE=0` restores the old behaviour exactly |
| Tests | 19 backend unittest + 37 frontend node:test: all pass. 3 real end-to-end runs (twice), evidence in `docs/test-runs/` |

## 1. Implemented features

### 1.1 Intelligence dashboard (frontend)
- **Header**: identity, source, run meta, status pills ("Verified against the page", "2 values need review" jumps to the cards), actions.
- **Tabs** (ARIA tablist, arrow keys, `#overview|#data|#agent` in the URL, sticky).
- **Overview**: KPI row, key findings (deterministic sentences, never AI prose), *Needs review* anomaly cards, auto-selected charts, two-lane data quality.
- **Anomaly card**: four lanes. *Extraction* (is the value what the page says?), *Plausibility* (the signals), *Investigation* (assessment, confidence, method, model, time), *Outcome* (original value kept, suggestion marked "not applied"). An evidence disclosure lists E1–E4 with excerpts, URLs and fetch time, and marks the ones the analyst cited.
- **Charts** (SVG, monochrome, shape not hue: filled dot = record, ringed dot = flagged, grey band = reference range). *Price strip* by category (log scale when the range is wide), *median by category* with reference brackets (flagged values excluded), *change since last run* (only when prices changed). Hover and keyboard focus show tooltips. Every value is also in the table.
- **Data & Evidence**: sortable/filterable table with a review marker column, added *Category* and *Last run* columns, the existing screenshot evidence viewer, and the history comparison table.
- **Agent & Infrastructure**: scraper registry (version, reuse, fingerprint, saved schema, criteria, drift checks), run facts (attempts, repairs, AI code calls, vision checks, sandbox time, research budget, analysis time). Self-healing & attempts, methodology, scraper code and containment telemetry are now collapsed disclosures.
- Live run view gains a **"Checking plausibility"** stage, shown only when the backend reports it.
- Backends without the layer still work: `fallbackViews()` derives KPIs and a chart from the records and says "Plausibility analysis: not available on this backend".

### 1.2 Data quality and anomaly detection (`backend/intelligence/quality.py`)
Runs on every **verified** result. Deterministic, no AI.
- **Extraction lane** (checks): schema valid · every price in the visible page text · each price right after its product name (co-location) · screenshot agrees (vision verdict) · no duplicates.
- **Plausibility lane** (signals per record, weighted):
  - `category_band`: above 2× the top (or below ⅓ of the bottom) of the category's reference range. Weight 2 at 5× or more.
  - `category_peers`: 4× off the median of same-category peers on the page, counted only on the side where the value is also outside the band. Small groups otherwise flag the normal item.
  - `dataset_outlier`: robust z-score on log10(price) > 3.5 (n ≥ 6).
  - `history_jump`: ≥ 2.5× (or ≤ 1/2.5) vs the last **unflagged** observation of the product. Exact 10×/100× is reported as a digit/decimal-shift signature.
  - Flagged at score ≥ 2. Severity high at ≥ 4.
- **Categories** (`categories.py`): the record's `category` field if present, else a keyword taxonomy on the name. Reference bands are documented *domain priors* (new-equipment retail, SEK). They are labelled as such everywhere and are never presented as facts about the site.

### 1.3 Investigation (`backend/intelligence/investigate.py`)
Bounded: at most 3 investigations and 3 research fetches per job, with a 240 s deadline.
- E1 **page**: listing text starting at the product name.
- E2 **statistics**: other unflagged peers in the category, the category prior, the dataset median.
- E3 **history**: the last unflagged observation (time, job id).
- E4 **research**: the product page linked from the listing (anchor text = product name), **same scheme+host+port only**, fetched through the **sandbox runtime** (`sandbox_client.screenshot`, so gVisor + SSRF egress proxy). Blocked requests and hidden instruction-like text on research pages become `security.events`.
- **AI analyst** (glm-5.3 via `ai_client._chat`, same 120 s limit). Page text is wrapped as untrusted. The answer is **validated**: the assessment must be one of `likely_source_error | plausible_unusual | extraction_error | inconclusive`, and the analyst may cite only evidence ids it was given (in `evidence_used` and in the explanation). Otherwise the answer is rejected and a **rule-based** assessment is used. The rule path never goes above medium confidence, and the UI shows which path was used.
- Output keeps `original_value`, `value_changed: false`, an optional `suggested_value` (never applied), `recommended_action`, the method and the model.

### 1.4 Versioned scrapers (`backend/intelligence/registry.py`, `history.py`)
- Per site (URL without query) a list of versions: code (text only), sha256 **with the `URL =` line normalised** (retargeting a saved scraper is reuse, not a new version), source, parent, status `active|superseded|retired`, runs, timestamps.
- **Saved extraction schema** (field types and requiredness) and **verification criteria** (required fields, accepted record-count range, ≥ 50 % of known products, evidence check required, vision check required/attempted). Both are inferred from the verified output.
- `POST /api/jobs` now **reuses the last verified scraper** for the site (attempt 1 `source: "saved"`, no code-model call). If it fails, the existing repair loop takes over.
- **Drift**: when a reused scraper *passes* verification but misses required fields or falls outside the accepted record count, the attempt is failed with `result drift vs saved scraper vN: …` and the existing self-healing repairs it. Changed product identity is reported, not healed.
- **History**: every verified record is stored per site and product (last 20). Flagged observations are stored but never used as a baseline.
- Storage: JSON files with atomic writes in `INTEL_DATA_DIR` (default `backend/data/intel/`, gitignored). They survive restarts, unlike jobs.
- `POST /api/scrapers/reset` also retires active versions. Versions and history are kept for the audit trail.

### 1.5 Dashboard specification (`backend/intelligence/dashboard.py`, `frontend/js/model/intel.js`, `frontend/js/dashboard/`)
- The backend emits `{"spec_version": 1, "views": [{id, label, blocks: [{type, ...props}]}]}`.
- Allowed block types: `kpis, findings, chart, anomalies, quality, table, evidence, history, scraper, agent`. Chart kinds: `price_strip, category_bars, price_change`.
- The frontend **validates** the spec (unknown views, types, kinds or spec versions are dropped; tested) and renders it only through `js/dashboard/registry.js`. All text goes through `textContent`. The CSP is unchanged.
- The backend chooses: charts appear only when meaningful (n ≥ 3, ≥ 2 categories, actual price changes), and the anomaly block only with findings.

### 1.6 Controlled anomaly scenario (`demo-site/server.py`, additive)
- `/shop?v=anomaly`: the `/shop` table with linked product names plus:
  - **Stealth 2 Driver listed at 64 950 kr.** Its product page says 6 495 kr: a listing typo. Expected outcome: *likely source error*.
  - **Circle T Tour Rat Putter at 52 000 kr**, the same on its product page, described as a tour-only collector piece (1 of 25). Expected outcome: *unusual but plausible*.
- `/shop/product/<id>[?v=anomaly]` product pages.
- `/shop`, `?v=2`, `?v=evil`, `/`, 404 and `/shop/` are **byte-identical** to `main` (verified by diffing full HTTP responses, old server vs new).
- `SHOP_HOST` / `SHOP_PORT` env vars (defaults unchanged) so tests can run it on a free localhost port.

## 2. Architectural decisions
1. **Two lanes, never mixed.** "Extracted correctly" and "believable" are separate checks with separate UI. A 64 950 kr typo is a *verified extraction* of an *implausible value*.
2. **Values are immutable.** The layer adds findings next to the data. Correction is only ever a suggestion for a human.
3. **No fabricated verification.** Every check shows only what ran. "Not applicable" and "not available" are explicit. Rule fallbacks and AI answers are labelled. The analyst cannot cite evidence it was not given.
4. **Research stays inside the existing boundary**: same origin, linked from the page, through the sandbox runtime, budgeted. No new egress path.
5. **Isolated package with one thin hook**, so the backend owner's loop is untouched apart from four insertion points (§4) and the whole layer can be switched off.
6. **Spec, not code.** The backend decides *what*, the frontend owns *how*, and a whitelist sits between them.
7. **Robust statistics.** Peers exclude the record itself, flagged values are excluded from category insights and baselines, and peer signals are gated by the band. All three were found during real-data testing (§6).

## 3. API changes (all additive, backward compatible)

`GET /api/jobs/{id}`: new fields
```jsonc
{
  "created_at": "2026-11-27T13:27:54Z", "finished_at": "2026-11-27T13:28:27Z",
  "phase": "analyzing" | null,            // while status is still "running"
  "intel_drift": [ {...} ],               // internal: drift report of reused attempts
  "intelligence": {
    "version": 1, "status": "running" | "done" | "error", "error": null,
    "started_at", "finished_at", "duration_ms",
    "quality": { "checks": [{"id","lane":"extraction|plausibility","label","ok":true|false|null,"detail"}],
                 "summary": {"records","flagged","notes","plausible"},
                 "stats": {"count","min","max","median","mean","categorised",
                           "categories":[{"key","label","count","median","min","max","band","source"}]} },
    "records": [{"index","category","category_source","flagged","severity","signals":[str],
                 "previous_price","on_page","next_to_name","excerpt"}],
    "findings": [{"id":"F1","record_index","field":"price_sek","name","original_value","value_changed":false,
                  "category","severity","score","signals":[{"id","weight","detail",...}],"hint",
                  "extraction":{"on_page","next_to_name"},
                  "evidence":[{"id":"E1..E4","kind":"page|statistics|history|research","label","fact",
                               "url","excerpt","fetched_at","duration_ms","prices_found","error","skipped"}],
                  "assessment","assessment_label","confidence":"low|medium|high","explanation",
                  "evidence_used":["E1"],"suggested_value":6495|null,"recommended_action",
                  "method":"ai|rules","model":"glm-5.3"|null,"note","status":"open","duration_ms"}],
    "uninvestigated": [index], "scraper": {"version","parent","source","status","runs","reused","reused_code",
                 "new_version","code_sha256","schema","criteria","created_at","last_verified_at","site"},
    "drift": {"status":"stable|changed|drift","heal","reason","checks":[...],"version"} | null,
    "history": {"site","runs":[{"job_id","at","records"}],"compared"},
    "research": {"fetches_used","fetch_budget","investigation_budget"},
    "dashboard": {"spec_version":1,"views":[...]}
  }
}
```
Job `status` stays `running` until the intelligence layer finishes, so pollers keep polling. In the real runs it took 7 ms with no findings, and 10–13 s with two AI investigations.

New read-only routes (`backend/intelligence/api.py`):
| Route | Returns |
|---|---|
| `GET /api/intel/scrapers` | `{"sites":[{"site","versions","active_version","last_verified_at"}]}` |
| `GET /api/intel/scrapers/versions?url=…&include_code=false` | version history, newest first (code only on request) |
| `GET /api/intel/history?url=…` | earlier verified runs on the site |

Changed behaviour:
- `POST /api/jobs` reuses the last verified scraper for the site (was: always generate).
- `POST /api/jobs/{id}/rerun` falls back to the registry when the in-memory scraper is gone (for example after a restart).
- `POST /api/scrapers/reset` returns an extra `retired_versions` count.

Environment: `INTELLIGENCE=0` disables the layer, `INTEL_AI=0` uses rule-based assessments only, `INTEL_DATA_DIR` sets the storage folder.

## 4. Backend changes in `main.py` (the only edits to existing backend code)
Four insertion points, shown in full by `git diff b3d0cf9 -- backend/main.py`:
1. Imports + `app.include_router(intel_router)`, before the static mount.
2. In the attempt loop: after `_check_attempt` passes, `intel_hook.drift_check(...)` may turn a reused scraper's pass into a repair.
3. On success: `job.update(results, final_code)`, then `intel_hook.after_success(...)`, then `status="done"` and `finished_at`.
4. `created_at`/`finished_at` on jobs. Registry reuse in `create_job`, registry fallback in `rerun_job`, `on_reset()` in reset.

Every hook function catches its own exceptions. If the layer fails, the job still finishes `done` with `intelligence.status = "error"`, and the UI says "extraction results are unaffected".

## 5. Security boundaries (unchanged)
- AI-written code still runs only in the sandbox runtime. Saved scrapers are run exactly like generated ones.
- Research fetches go through the same runtime `/screenshot` endpoint (gVisor + SSRF egress proxy). They are same-origin only and only follow links present on the scraped page. The budget is enforced in code.
- Page text in prompts is marked untrusted. Analyst output is validated structurally and cannot add sources.
- No new secrets. The analyst reuses `ai_client` (key stays in the backend). Nothing new reaches the sandbox.
- Frontend: no `innerHTML`, CSP unchanged, spec whitelist, `http(s)` links only with `noopener noreferrer nofollow`.
- Containment telemetry is unchanged and kept honest: "observed this run" vs "verified by benchmark".

## 6. Test results

### 6.1 Automated
- `cd backend && .venv/bin/python -m unittest discover -s tests -v`: **19 passed**. Covers categories, demo-site variants (old ones unchanged, anomaly content), quality flags on the clean and anomaly pages, investigation (rules, valid AI answer, AI citing unknown evidence rejected, invalid assessment rejected, budget, same-origin link filter, injection on a research page), registry (versions, reuse with a retargeted URL, drift, retire), a pipeline two-run story, and `main.py` integration with `MOCK_SANDBOX=1` (reuse means no code-model call; the versions endpoint works).
- `cd frontend && node --test tests/*.test.mjs`: **37 passed**. Covers spec whitelist validation, fixture normalisation, unknown assessment words downgraded, the analyze stage appearing only when reported, fallback views never claiming plausibility, money formatting, and all existing suites.

### 6.2 Real end-to-end runs (VM, real sandbox, real glm-5.3 + nemotron)
Isolated instance from this branch on `127.0.0.1:8100` with its own data dir, against the real runtime and demo shop. The full sequence was run twice with the same outcomes. Final pass (JSON in `docs/test-runs/`, screenshots stripped):

| Run | URL | Attempts | AI code calls | Extraction | Scraper | Intelligence |
|---|---|---|---|---|---|---|
| 1 `cdf1d0d73ad1` | `/shop` | 1 generated → pass | 1 | evidence ✓, vision 10/10 ✓ | v1 created | 0 flags, 7 ms |
| 2 `21edcfbb2a89` | `/shop?v=anomaly` | 1 **saved** → pass | **0** | evidence ✓, vision 11/11 ✓ | v1 **reused** (runs = 2) | **2 findings**, 13.4 s, 2 of 3 research fetches |
| 3 `0438bd00c421` | `/shop?v=2` | saved → `[]` → repaired → pass | 1 | evidence ✓, vision 10/10 ✓ | **v2** (parent v1), v1 superseded | 0 flags. "2 of 10 known products changed price; largest regular change: Apex Pro Iron Set −14 %" |

Run 2 findings (real glm-5.3 output, validated):
- **Stealth 2 Driver 64 950 kr**: *likely source error*, high confidence, suggested 6 495 kr (not applied). Cited E1–E4: listing shows 64 950, the product page shows 6 495, the last run recorded 6 495, exactly 10×, 6.8× the top of the driver range.
- **Circle T Tour Rat Putter 52 000 kr**: *unusual but plausible*, medium confidence, no suggestion. Same price on the listing and product page, and the product page describes a tour-only collector piece, 1 of 25.

Bugs found by real-data testing and fixed: a retargeted saved scraper was stored as a new version (fixed by URL-line normalisation, with a test). Category evidence and insights included the flagged value (now excluded). Small-group peers flagged the normal driver (now band-gated). Price strings wrapped and KPIs overflowed (no-break spaces, content-sized KPI columns). The mobile grid overflowed (one column under 860 px).

### 6.3 Visual inspection (`docs/screenshots/`)
All from the real run 2 report unless noted: 01 overview · 02 anomaly card (source error) · 03 evidence E1–E4 · 04 anomaly card (plausible) · 05 charts · 06 data quality two lanes · 07 data table with flags · 08 evidence viewer with the real sandbox screenshot · 09 scraper registry · 10 technical disclosures + containment · 11 light mode · 12–13 mobile (375 px). Checked for: no horizontal overflow at 375 px, no clipped KPI values, readable charts in both themes.

## 7. Development without the backend
`cd frontend && python3 -m http.server 5173`, then `/?mock=anomaly`. This is a **labelled fixture** (the badge says "Mock data — not a real run"), generated by `backend/tools/gen_intel_fixture.py`: the real pipeline against a local copy of the demo shop with a reference parser and **no AI**. Regenerate after changing the pipeline or spec.

## 8. Current state on the VM (what I touched)
| Thing | State | How to undo |
|---|---|---|
| `/root/work-intelligence/` | rsync copy of this branch (not a git checkout) + `data/` (registry/history of the test instance) + `logs/` | `rm -rf` **only after** the shop no longer runs from it (next row) |
| tmux `intel-dev` | this branch's backend on **127.0.0.1:8100** (localhost only), `INTEL_DATA_DIR=/root/work-intelligence/data`, reuses `/root/app/backend/.venv` read-only, reads the key from `/root/app/.env` | `tmux kill-session -t intel-dev` |
| tmux `shop` (:8080) | **restarted** at 13:21 UTC from `/root/work-intelligence/demo-site/server.py` so the sandbox can reach `?v=anomaly`. Done only after checking: the VM's shop code equals `main` (sha256), all existing routes are byte-identical, and there was no traffic for 167 s | `tmux kill-session -t shop && tmux new-session -d -s shop python3 /root/app/demo-site/server.py` (restores main's shop; the anomaly variant disappears) |
| `/root/app`, :8000 backend, :8001 runtime | **untouched** | none |

## 9. Remaining integration steps
1. **Review and merge** `feature/intelligence-dashboard` (rename the untracked `/root/app/INTEGRATION_HANDOFF.md` first). Conflict risk is limited to the four `main.py` hunks if `main.py` has changed since `b3d0cf9`.
2. **Restart the backend** (:8000) after merging. Optionally set `INTEL_DATA_DIR` to a persistent path. Without a restart the frontend still works against the old backend (fallback views), but there is no intelligence layer.
3. **Shop**: after merging, point tmux `shop` back at `/root/app/demo-site/server.py` (same content), then `/root/work-intelligence` can be deleted.
4. **Demo script**: `POST /api/scrapers/reset` → new job `/shop` (v1 generated) → new job `/shop?v=anomaly` (v1 reused, 2 findings, ~35 s) → new job `/shop?v=2` (heal to v2) → optional `/shop?v=evil` (security events).
5. Add `?v=anomaly` to `DEMO_TARGETS` in `frontend/js/config.js` if you want a quick link (left out to avoid changing the home screen during the backend owner's work).

## 10. Known limitations / follow-ups
- The schema is still `{name, price_sek}`. Categories are inferred from names, and the taxonomy and bands are golf-specific priors (generic data falls back to dataset statistics only).
- Research reuses `/screenshot` (it renders a full page, ~3 s per fetch). A lighter runtime fetch endpoint would be faster.
- Findings have `status: "open"`, but there is no UI to resolve or acknowledge them yet.
- Jobs are still in memory. Registry and history persist in JSON files: fine for the demo, but use SQLite for concurrency beyond it.
- Drift-triggered healing is unit-tested and wired, but no real page today makes a reused scraper pass while dropping fields or volume, so it was not exercised end to end.
