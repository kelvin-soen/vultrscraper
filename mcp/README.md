# siftform MCP server

A small [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) use
siftform to scrape structured product data from a web page. It speaks stdio and only calls the
public siftform API (default `http://70.34.217.56:8000`, override with `SIFTFORM_URL`).

## Tools

| Tool | What it does |
|---|---|
| `extract_data(url)` | `POST /api/jobs`, then polls `GET /api/jobs/{id}` every 2 s for up to 200 s. Returns the job summary. If the job is still running after 200 s, `status` is `"running"` and a `note` says to call `get_job` later. |
| `get_job(job_id)` | Returns the same summary for an existing job. |

The summary contains `job_id`, `status` (`done` / `failed` / `running`), `url`, `title`, `error`,
`result_count`, `results` (`[{name, price_sek}]`), `verification` (`verdict`, `reason`, number of
`attempts`), `security_events` (`kind`, `status`, `source`, `detail`) and `view_url` (the job in
the siftform UI).

`security_events[].source` is `"this_job"` for something that happened during this scrape (for
example an SSRF request `blocked`, a prompt injection `detected`) and `"benchmark"` for the
runtime-wide security benchmark, which was not observed in this job.

Jobs live in the backend's memory, so `get_job` returns a "job not found" error after the backend
restarts.

## Install

The system Python here has no `ensurepip`, so the venv is created without pip and the system
`pip3` installs into it:

```bash
cd /root/app/mcp
python3 -m venv --without-pip .venv
pip3 --python .venv/bin/python install -r requirements.txt
```

(Where `python3 -m venv .venv` works normally, `.venv/bin/pip install -r requirements.txt` does
the same.)

## Add it to Claude Code

```bash
claude mcp add --transport stdio --env SIFTFORM_URL=http://70.34.217.56:8000 siftform -- /root/app/mcp/.venv/bin/python /root/app/mcp/server.py
```

## Add it to Claude Desktop

Claude Desktop starts the server itself, so it must run on the same machine as the server files.
Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`) with the paths changed to where `mcp/` lives on that machine, then
restart Claude Desktop:

```json
{
  "mcpServers": {
    "siftform": {
      "command": "/root/app/mcp/.venv/bin/python",
      "args": ["/root/app/mcp/server.py"],
      "env": { "SIFTFORM_URL": "http://70.34.217.56:8000" }
    }
  }
}
```

## Example

Ask Claude: *"Use siftform to get the books and prices from https://books.toscrape.com/"*.
Claude calls `extract_data` with that URL and gets back (results trimmed):

```json
{
  "job_id": "75fb6b10dd9c",
  "status": "done",
  "title": "All products | Books to Scrape - Sandbox",
  "result_count": 20,
  "results": [
    { "name": "A Light in the Attic", "price_sek": 51 },
    { "name": "Tipping the Velvet", "price_sek": 53 }
  ],
  "verification": {
    "verdict": "pass",
    "reason": "20 items; evidence check: all 20 prices appear in the page text; vision check agrees: 20/20 visible prices matched [qwen3.8-flash-next]",
    "attempts": 1
  },
  "security_events": [
    { "kind": "ssrf", "status": "passed", "source": "benchmark", "detail": "Runtime security benchmark, 2026-11-27 15:00:38 UTC: SSRF protection test passed (runtime-wide test, not observed in this job)." }
  ],
  "view_url": "http://70.34.217.56:8000/?job=75fb6b10dd9c"
}
```

Note: `price_sek` is whatever number the backend extracted. books.toscrape.com lists prices in
GBP (£51.77), so the backend's value there is a rounded GBP amount, not SEK.

## Smoke test

`test_client.py` starts the server over stdio, lists the tools, runs `extract_data` and `get_job`
and checks the not-found error:

```bash
.venv/bin/python test_client.py                       # https://books.toscrape.com/
.venv/bin/python test_client.py https://example.com/  # any other URL
```
