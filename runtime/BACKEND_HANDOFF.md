# Runtime handoff report: for the backend developer and agent

**Status (2026-11-27):** The secure sandbox runtime is **deployed and running** on
the VM. It implements the sandbox contract in `backend/CLAUDE.md` (`POST /run`,
`POST /screenshot`, `GET /health`) at `http://localhost:8001`.
**The backend needs one change:** send an API key on every request (section 2).

- Copy of this file on the VM: `/opt/vultr-runtime/BACKEND_HANDOFF.md`
- Source: branch `feature/runtime`, directory `runtime/` (not merged into `main`)
- Owner of `runtime/`: the runtime developer. Do not edit `runtime/`, and do not
  change the contract below without telling them.

---

## 1. What was built

A standalone execution service that runs AI-generated code and a real browser in
disposable, locked-down containers:

```
backend (port 8000) ──HTTP + API key──▶ runtime API 127.0.0.1:8001 (systemd: vultr-runtime)
                                          └─▶ one fresh gVisor container per request, destroyed afterwards
                                                └─▶ internet only via an SSRF-filtering egress proxy
```

- Every `/run` and `/screenshot` call gets its own container under **gVisor**. It runs
  as non-root, with a read-only filesystem, no Linux capabilities, and memory, CPU,
  process, time and output limits. The container is **destroyed after every call**,
  including on timeout and failure.
- **The sandbox has no secrets.** `VULTR_INFERENCE_KEY` and `/root/app/.env` are not
  reachable from inside it. All LLM calls stay in the backend.
- **Network:** generated code can only reach the internet through the runtime's proxy.
  Internal addresses are always blocked: `localhost`, `10.x`, `172.16-31.x`,
  `192.168.x`, `169.254.169.254` (cloud metadata), and the VM's own public IP.
  **The one exception is the demo shop `70.34.217.56:8080`**, allowed only for the
  `/run` and `/screenshot` endpoints.
- **Security benchmark:** 12/12 tests passed on this VM (timeouts, isolation, SSRF,
  prompt injection, secret hygiene, cleanup, memory, fork bomb, cross-job isolation,
  auth, output flood, cancellation). Results are in `runtime/benchmark/results/latest.json`
  and live at `GET /v1/security/benchmark`.

Installed packages inside the sandbox: Python 3.12, `requests`, `httpx`,
`beautifulsoup4`, `lxml`, `pytest`, `playwright` (Chromium). Nothing else can be
installed, because there's no PyPI access.

---

## 2. Required backend change: authentication

Every request except `GET /health` must send:

```
Authorization: Bearer <runtime API key>
```

Without it, the runtime returns **HTTP 401**, and `r.raise_for_status()` in
`sandbox_client.py` will raise.

**Where the key is:** `/etc/vultr-runtime/backend.key` (root only, one line, principal
`backend`). The backend runs as root, so it can read the file directly. Do not copy
the key into Git, logs, prompts or generated code.

### Suggested patch (backend/config.py)

```python
SANDBOX_URL = os.getenv("SANDBOX_URL", "http://localhost:8001")
MOCK_SANDBOX = os.getenv("MOCK_SANDBOX", "0") == "1"


def sandbox_key() -> str:
    """Runtime API key: env var SANDBOX_API_KEY, else /etc/vultr-runtime/backend.key."""
    key = os.getenv("SANDBOX_API_KEY", "").strip()
    if not key:
        try:
            key = Path("/etc/vultr-runtime/backend.key").read_text().strip()
        except OSError:
            key = ""
    if not key:
        raise RuntimeError("runtime API key missing (SANDBOX_API_KEY or /etc/vultr-runtime/backend.key)")
    return key
```

### Suggested patch (backend/sandbox_client.py, real mode only)

```python
def _headers() -> dict:
    return {"Authorization": f"Bearer {config.sandbox_key()}"}


def _real_run(code: str, timeout: int = 30) -> dict:
    r = httpx.post(
        f"{config.SANDBOX_URL}/run",
        json={"code": code, "timeout": timeout, "network": True},
        headers=_headers(),
        timeout=timeout + 60,
    )
    r.raise_for_status()
    return r.json()


def _real_screenshot(url: str) -> dict:
    r = httpx.post(f"{config.SANDBOX_URL}/screenshot", json={"url": url},
                   headers=_headers(), timeout=150)
    r.raise_for_status()
    return r.json()
```

Then run with `MOCK_SANDBOX=0` (the default).

Quick check from the VM:

```bash
curl -s http://localhost:8001/health
curl -s http://localhost:8001/run -H "Authorization: Bearer $(cat /etc/vultr-runtime/backend.key)" \
  -H 'Content-Type: application/json' -d '{"code":"print(42)","timeout":10,"network":false}'
```

---

## 3. Contract the backend uses (unchanged shapes, extra fields added)

### `POST /run`

Request (same as `backend/CLAUDE.md`):

```json
{"code": "<python source>", "timeout": 30, "network": true}
```

| field | rules |
|---|---|
| `code` | string, max 100,000 characters |
| `timeout` | 1–120 seconds (default 30) |
| `network` | `true`: internet via proxy plus the demo shop. `false`: no network at all |

Response:

```json
{"stdout": "[{\"name\": \"Kaffe 500g\", \"price_sek\": 79}]\n", "stderr": "", "exit_code": 0,
 "timed_out": false, "duration_ms": 1830, "job_id": "job-3f5c…", "status": "succeeded"}
```

- `status` is one of `succeeded`, `failed`, `timeout`, `cancelled`, `error`.
- On timeout: `timed_out: true`, `status: "timeout"`, and `exit_code` is usually `-9`.
  When the sandbox produced no result (for example it was killed for memory),
  `exit_code` is `-1` and `stderr` explains why (`"memory limit exceeded (OOM killed)"`).
- `stdout` and `stderr` are capped at **1 MB each**. Longer output is cut off.
- A scraper that prints JSON works as before: parse `stdout`.

### `POST /screenshot`

Request:

```json
{"url": "http://70.34.217.56:8080/shop"}
```

Optional fields: `"full_page": true` (default) and `"timeout": 60` (5–180).

Response:

```json
{"image_base64": "iVBORw0KGgo…", "html": "<!DOCTYPE html>…", "status": 200,
 "final_url": "http://70.34.217.56:8080/shop", "error": null,
 "job_id": "job-…", "job_status": "succeeded", "blocked_requests": []}
```

- `status` is the page's HTTP status, or `null` if navigation failed (then `error` is set).
- `image_base64` is a full-page PNG. `html` is the rendered DOM after JavaScript.
- `blocked_requests` lists page subrequests the proxy blocked (for example a hostile
  page trying to reach internal addresses).
- Typical duration: 3–8 seconds.

### `GET /health` (no auth)

```json
{"ok": true, "status": "ok", "version": "1.0.0", "oci_runtime": "runsc", "egress_proxy": "up",
 "queued": 0, "running": 0, "max_concurrency": 4}
```

### Errors the backend should handle

| HTTP | when | body |
|---|---|---|
| 401 | missing or invalid API key | `{"detail": "invalid or missing API key"}` |
| 422 | invalid request (unknown field, timeout > 120, URL not http(s)) | FastAPI validation error |
| 429 | more than **6** active jobs for the `backend` key, or queue full | `{"error": "budget_exceeded" or "queue_full", "detail": …}` |

At most **4 sandboxes run at the same time**; further requests wait in the queue.
The backend's 3-attempt loop is well within these limits.

---

## 4. Rules for the generated scraper code (put these in the code-generation prompt)

- Use `requests` (or `httpx`) normally. The proxy is configured automatically through
  `HTTP_PROXY`/`HTTPS_PROXY`. **Do not** set `proxies=`, `trust_env=False` or custom
  DNS; that removes the only route out.
- Inside the sandbox, the demo shop is `http://70.34.217.56:8080/...`
  (**not** `localhost`, which is blocked).
- Only ports 80 and 443 are allowed on public hosts. The demo shop's 8080 is the
  single exception.
- Print the result as JSON on stdout (unchanged). Optionally,
  `from vrt_sandbox import write_result; write_result(obj)` also works.
- The working directory `/work` is writable (64 MB). Everything else is read-only.
- Memory 512 MB, 1 CPU, 64 processes, wall-clock limit `timeout`.

---

## 5. Security notes for the backend

- **Treat everything returned as untrusted:** `stdout`, `stderr`, `html`, the screenshot,
  and `blocked_requests`. The page and the generated code can contain prompt-injection
  text. Keep wrapping it as data in prompts, as `backend/CLAUDE.md` already says.
- Never send `VULTR_INFERENCE_KEY` or the runtime key inside `code`. The sandbox could
  print it back, and it would end up in UI or logs.
- `/run` and `/screenshot` allow **any public host** plus the demo shop. For a tighter
  policy (one domain only), use the `/v1/jobs` API with `network.allowed_domains`.

---

## 6. Optional: richer API (`/v1/jobs`)

Asynchronous jobs with telemetry, artifacts, validation tests and browser actions.
Full contract: `runtime/openapi.yaml`. Examples: `runtime/INTEGRATION.md`.
Python client: `/opt/vultr-runtime/client/runtime_client.py`.

| endpoint | purpose |
|---|---|
| `POST /v1/jobs` | queue a job (profiles `python`, `python-net`, `browser`), returns `202 {"id": …}` |
| `GET /v1/jobs/{id}` | status plus telemetry |
| `GET /v1/jobs/{id}/result` | stdout, stderr, `output`, `tests`, `browser`, artifacts, telemetry (409 until finished) |
| `GET /v1/jobs/{id}/artifacts[/{name}]` | list or download (`screenshot.png`, `page.html`, files from `/work/output/`) |
| `DELETE /v1/jobs/{id}` | cancel, which kills and destroys the sandbox |
| `GET /v1/security/events` | security events for this key (blocked egress, timeouts, OOM, policy violations) |
| `GET /v1/security/benchmark` | latest security benchmark JSON (for the frontend security panel) |

Telemetry available per job, useful for showing "every attempt" in the UI:
`container_id`, `oci_runtime`, `duration_ms`, `memory_peak_bytes`, `exit_code`,
`timed_out`, `oom_killed`, `policies` (applied limits), `blocked_operations`,
`egress.destinations`, `cleanup.container_removed`.

`/run` and `/screenshot` return `job_id`. With it, the backend can fetch full telemetry
via `GET /v1/jobs/{job_id}` (same key) and show it next to each attempt.

---

## 7. Operations and troubleshooting

| symptom | check |
|---|---|
| connection refused on :8001 | `systemctl status vultr-runtime`, `journalctl -u vultr-runtime -n 50` |
| 401 | header missing, or key not read from `/etc/vultr-runtime/backend.key` |
| scraper gets `403` with header `X-VRT-Blocked: …` | the proxy blocked that destination (internal address, wrong port, not allowed) |
| `ProxyError` / `ConnectionError` to the demo shop | demo shop not running on `70.34.217.56:8080` (`ss -tlnp \| grep 8080`) |
| `/screenshot` returns `status: null` | read `error`; usually an unreachable URL or a navigation timeout |
| slow responses | `GET /health`: `queued` > 0 means all 4 slots are busy |

Live security demo for the video (runs on the VM, ~1 minute):

```bash
/root/work-runtime/runtime/benchmark/demo.sh          # six core containment tests
/root/work-runtime/runtime/benchmark/demo.sh --all    # all twelve
```

## 8. Known open items

- The demo shop on port 8080 was not running at handoff. The pinned exception was
  verified with a temporary test page on `70.34.217.56:8080`.
- `feature/runtime` is not merged into `main` (no direct merges into `main` by the
  runtime developer). The service runs from `/opt/vultr-runtime`, independent of
  which branch is checked out.
- `feature/runtime` changes the root `.gitignore`: the line ignoring `runtime/` was
  removed, because it hid the runtime source directory.
