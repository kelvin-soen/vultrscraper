# Frontend ⇄ backend integration

The frontend is static HTML/CSS/JS (ES modules, **no build step**). FastAPI
serves it from `frontend/` on port 8000 via the existing `StaticFiles` mount
in `backend/main.py`. No backend changes are needed to serve it.

All calls use **relative paths** on the same origin. The browser never talks to
the sandbox runner, Docker or Vultr Inference.

## Endpoints used

| Method | Path | Request | Response | Status |
| --- | --- | --- | --- | --- |
| `POST` | `/api/jobs` | `{"url": "..."}` | `{"id": "..."}` | Used |
| `GET` | `/api/jobs/{id}` | — | job object (below) | Polled every **2 s** while `status == "running"`; stops on `done`/`failed` |
| `POST` | `/api/jobs/{id}/rerun` | `{"url": "..."}` | `{"id": "..."}` | Wired to “Run again” on the report. A 404/405/501 reply is shown as “Re-run isn’t available on this backend yet.” |

Error handling:

- `400`/`422` from FastAPI: the `detail` string is shown under the URL input.
- `404` on `GET /api/jobs/{id}`: the run view explains that jobs are kept in
  memory and a server restart clears them, and offers to start again.
- Network failures while polling: the UI shows “Reconnecting…” and backs off
  exponentially (2 s → 16 s max), then resumes when the backend answers.
- Malformed or partial payloads never crash the UI. Missing fields render as
  “pending”, “not run” or “not reported”.

## Job object: fields the frontend reads

The official contract, all of which is used:

```jsonc
{
  "status": "running" | "done" | "failed",
  "url": "http://70.34.217.56:8080/shop",
  "error": "RuntimeError: ..." | null,
  "attempts": [
    {
      "n": 1,
      "code": "import requests ...",   // shown as text, never executed
      "stdout": "[{...}]",             // parsed as JSON for the live preview
      "stderr": "",
      "exit_code": 0 | null,           // null = not run yet
      "verdict": "pending" | "ok" | "fail" | ...,
      "reason": "All 6 prices match"
    }
  ],
  "results": [{ "name": "Kaffe 500g", "price_sek": 79 }],
  "screenshot_base64": "iVBORw0..." | null
}
```

### How the UI interprets it (`js/model/job.js`)

Stages are shown as complete **only when the payload proves it**:

| Stage | Marked done when |
| --- | --- |
| Accessing website | `screenshot_base64` is present, or an attempt exists |
| Capturing visual evidence | `screenshot_base64` is present |
| Generating scraper | `attempts[0].code` is non-empty |
| Executing in isolated sandbox | `attempts[0].exit_code !== null` (or stdout/stderr present). Non-zero exit = failed |
| Extracting information | stdout parses as a non-empty JSON array. `[]` = failed (“no records”) |
| Verifying results | `verdict` is a verified word. A rejected word = failed |
| Repairing scraper | Shown only if attempt 1 failed or there are more attempts. Done when the last attempt is verified |
| Preparing results | `status == "done"` |

**Verdict vocabulary** (case-insensitive). Please keep to these words, or tell
us which ones you use:

- verified: `ok`, `pass`, `passed`, `match`, `verified`, `valid`, `correct`, `true`, `yes`, `success`
- rejected: `fail`, `failed`, `mismatch`, `wrong`, `invalid`, `incorrect`, `false`, `no`, `rejected`, `error`, `empty`, `timeout`
- pending: `pending`, `""`, `null`, `unknown`, `skipped`
- anything else: shown verbatim as “Verdict: …”, never as verified

**Outcomes**: `verified` (first attempt verified), `repaired` (more than one
attempt, last one verified), `repair_failed`, `failed`, `unverified`
(generated but not run, or no verdict reported).

The current `main` backend (step 1) generates code and marks the job `done`
without running it. The UI shows this accurately as **“Scraper generated, not
executed”**, not as success.

## Optional extensions (additive, not required)

The frontend already understands these fields if the backend chooses to add
them. Nothing breaks without them; the related UI shows “not reported”.

```jsonc
{
  "title": "Demo Shop",                       // report headline (else the hostname)
  "created_at": "2026-11-27T12:00:00Z",       // with finished_at: real duration
  "finished_at": "2026-11-27T12:00:21Z",
  "models": { "code": "glm-5.3", "vision": "clef-omni" },
  "attempts": [{
    "timed_out": true,                        // already returned by POST /run: please copy it through
    "duration_ms": 30000,                     // already returned by POST /run: please copy it through
    "sandbox": { "runtime": "gVisor (runsc)", "network": "egress allow-list",
                 "timeout_s": 30, "container_removed": true }
  }],
  "evidence": [{ "index": 0, "bbox": [x, y, w, h], "verified": true }],   // screenshot pixel coords
  "security": { "events": [
    { "kind": "ssrf" | "filesystem" | "prompt_injection" | "secrets" | "timeout" | "cleanup",
      "status": "blocked" | "passed" | "detected", "detail": "..." }
  ]},
  "steps": [{ "key": "access", "status": "done", "detail": "..." }]       // overrides derived stages
}
```

**Most valuable, cheapest asks:**

1. Copy `timed_out` and `duration_ms` from the sandbox `/run` response into
   each attempt. This lights up the *infinite-loop termination* signal and
   real sandbox durations.
2. Copy `container_removed` (if the runner reports it) to light up *automatic
   container destruction*.
3. Use the verdict words above.

Every containment signal (infinite loop, filesystem, SSRF, prompt injection,
secrets, cleanup) is displayed as **“Not reported for this run”** unless one
of these fields provides evidence. Nothing is hardcoded as passed.

## Security posture of the frontend

- No `innerHTML` anywhere. All backend and scraped strings are rendered via
  `textContent` (`js/dom.js`). Generated code is tokenized and shown as text.
- Strict CSP in `index.html`: same-origin scripts, styles and API, `data:`
  images only for screenshots, no third-party requests, no inline scripts.
- Screenshots are accepted only as base64 image data (`screenshotSrc`).
- Links are rendered only for `http(s)` URLs, with `rel="noopener noreferrer nofollow"`.

## Development without the backend

Open `index.html` through any static server with `?mock=<scenario>`:

```bash
cd frontend && python3 -m http.server 5173
# http://localhost:5173/?mock=heal
```

Scenarios (`frontend/dev/fixtures.js`): `success`, `heal`, `heal-fail`,
`timeout`, `evil`, `unverified`, `extended`, `error`, `offline`.
The mock is loaded only when `?mock=` is present, and a persistent
“Mock data — not a real run” badge is shown whenever it is active.

## Running against the real backend locally

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
MOCK_SANDBOX=1 .venv/bin/uvicorn main:app --port 8000
# http://localhost:8000/
```

Without `VULTR_INFERENCE_KEY` the job fails at “Generating scraper”, and the
UI shows the backend’s error at that stage. This was used to verify the
integration end to end.
