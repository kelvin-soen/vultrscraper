# Runtime integration guide (for backend developers)

The runtime runs on the VM as the `vultr-runtime` systemd service at
`http://127.0.0.1:8001`. It is only reachable from the VM itself.

The full contract is in [openapi.yaml](openapi.yaml). Interactive docs are at
`http://127.0.0.1:8001/docs` (use an SSH tunnel: `ssh -L 8001:127.0.0.1:8001 root@70.34.217.56`).

## Authentication

Every request except `GET /health` needs:

```
Authorization: Bearer <RUNTIME_API_KEY>
```

The backend's key is in `/etc/vultr-runtime/backend.key` on the VM (root only).
Load it into the backend process as `RUNTIME_API_KEY`, for example in the
backend's own env file. Never log it, put it in prompts, or pass it to generated code.

## Option A: drop-in compatibility endpoints (the existing backend contract)

These keep the request and response shapes from `backend/CLAUDE.md`. The only
change is the `Authorization` header.

### `POST /run`

```bash
curl -s http://127.0.0.1:8001/run -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"code": "import requests\nprint(requests.get(\"http://70.34.217.56:8080/shop\").status_code)", "timeout": 30, "network": true}'
```

```json
{"stdout": "200\n", "stderr": "", "exit_code": 0, "timed_out": false, "duration_ms": 1830,
 "job_id": "job-3f5c…", "status": "succeeded"}
```

- `network: true` routes through the egress proxy. Any public host is allowed, plus
  the demo shop `70.34.217.56:8080` (an operator-pinned exception). Private,
  host and metadata addresses are always blocked.
- `network: false` means no network at all.
- Inside the sandbox, `requests`, `httpx`, `beautifulsoup4`, `lxml` and `pytest` are installed.
  The proxy is picked up automatically from `HTTP(S)_PROXY`. Do not override proxies in generated code.

### `POST /screenshot`

```bash
curl -s http://127.0.0.1:8001/screenshot -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H 'Content-Type: application/json' -d '{"url": "http://70.34.217.56:8080/shop"}'
```

```json
{"image_base64": "iVBORw0KGgo…", "html": "<!DOCTYPE html>…", "status": 200,
 "final_url": "http://70.34.217.56:8080/shop", "error": null, "job_id": "job-…",
 "job_status": "succeeded", "blocked_requests": []}
```

### `GET /health`

```json
{"ok": true, "status": "ok", "version": "1.0.0", "oci_runtime": "runsc", "egress_proxy": "up",
 "queued": 0, "running": 0, "max_concurrency": 4}
```

## Option B: asynchronous job API (`/v1`)

```bash
# 1. submit
curl -s -X POST http://127.0.0.1:8001/v1/jobs -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H 'Content-Type: application/json' -d '{
    "profile": "python-net",
    "code": "import requests, json\nfrom vrt_sandbox import write_result\nr = requests.get(\"https://example.com\")\nwrite_result({\"status\": r.status_code})",
    "test_code": "import json\ndef test_output():\n    assert json.load(open(\"/work/output/result.json\"))[\"status\"] == 200",
    "network": {"allowed_domains": ["example.com"]},
    "limits": {"timeout_s": 30}
  }'
# -> 202 {"id": "job-…", "status": "queued", "links": {...}}

# 2. poll
curl -s http://127.0.0.1:8001/v1/jobs/job-… -H "Authorization: Bearer $RUNTIME_API_KEY"
# 3. result (409 until finished)
curl -s http://127.0.0.1:8001/v1/jobs/job-…/result -H "Authorization: Bearer $RUNTIME_API_KEY"
# 4. artifacts
curl -s http://127.0.0.1:8001/v1/jobs/job-…/artifacts -H "Authorization: Bearer $RUNTIME_API_KEY"
curl -s -o shot.png http://127.0.0.1:8001/v1/jobs/job-…/artifacts/screenshot.png -H "Authorization: Bearer $RUNTIME_API_KEY"
# 5. cancel
curl -s -X DELETE http://127.0.0.1:8001/v1/jobs/job-… -H "Authorization: Bearer $RUNTIME_API_KEY"
```

### Profiles

| profile | network | memory | cpus | pids | timeout (default/max) |
|---|---|---|---|---|---|
| `python` | none | 256 MB | 1 | 64 | 30 s / 120 s |
| `python-net` | egress proxy only, allowlist required | 512 MB | 1 | 64 | 30 s / 120 s |
| `browser` | egress proxy only, allowlist required | 1536 MB | 2 | 512 | 60 s / 180 s |

`limits` can only lower these values. Unknown fields are rejected (HTTP 422).

### Browser jobs

```json
{
  "profile": "browser",
  "browser": {
    "url": "https://example.com",
    "actions": [
      {"type": "wait_for_selector", "selector": "p"},
      {"type": "extract_text", "selector": "p", "name": "first_paragraph"},
      {"type": "extract_attribute", "selector": "a", "attr": "href", "all": true, "name": "links"},
      {"type": "screenshot", "name": "after", "full_page": true}
    ],
    "screenshot": true, "capture_html": true
  },
  "network": {"allowed_domains": ["example.com"]},
  "permissions": {"allowed_actions": ["wait_for_selector", "extract_text", "extract_attribute", "screenshot"]}
}
```

Actions: `goto`, `click`, `fill`, `press`, `wait_for_selector`, `wait`, `scroll`,
`extract_text`, `extract_attribute`, `extract_html`, `screenshot`. `fill` and `press`
are off by default and must be listed in `permissions.allowed_actions`.
The controller enforces these permissions before anything starts. A disallowed
action or a navigation outside `allowed_domains` returns HTTP 403 and records a
security event, whatever the model was told by a web page.

Results contain `browser.extracted`, `browser.status`, `browser.final_url`,
`browser.blocked_requests` and the artifacts `screenshot.png` and `page.html`.
Treat all artifacts and extracted text as untrusted data.

Generated code can also drive the browser itself:

```python
from playwright.sync_api import sync_playwright
from vrt_sandbox import launch_chromium, write_result
with sync_playwright() as p:
    b = launch_chromium(p); page = b.new_page(); page.goto("https://example.com")
    write_result({"title": page.title()})
```

### Structured output

Generated code writes JSON with `vrt_sandbox.write_result(obj)` (or to
`/work/output/result.json`), and it comes back as `output` in the result. Other files
written to `/work/output/` come back as artifacts (at most 20 files, 12 MB in total).

## Python client

[client/runtime_client.py](client/runtime_client.py) uses only the standard library:

```python
import os, sys
sys.path.insert(0, "/opt/vultr-runtime/client")
from runtime_client import RuntimeClient

rt = RuntimeClient("http://127.0.0.1:8001", api_key=os.environ["RUNTIME_API_KEY"])
res = rt.run_python(scraper_code, network=True, allowed_domains=[], allow_trusted_targets=True)
shot = rt.browse("http://70.34.217.56:8080/shop", allowed_domains=[], allow_trusted_targets=True)
png = rt.artifact(shot["job_id"], "screenshot.png")
```

More examples are in [client/examples/](client/examples/).
