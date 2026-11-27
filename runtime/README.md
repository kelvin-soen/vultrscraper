# Vultr Agent Runtime: secure sandbox runtime

A standalone execution service that lets backend AI agents run generated Python
code and drive a real browser without being able to touch the host, internal
networks, credentials or each other. It does not depend on the LLM provider,
the agent framework or the backend's implementation: anything that can make HTTP
calls can use it.

```
Backend agents ──HTTP + API key──▶ Runtime API (FastAPI, 127.0.0.1:8001)
                                     │  schema validation (no unknown fields)
                                     │  tool permissions, limits, budgets, ownership
                                     ▼
                                Security controller ──Docker API──▶ disposable sandbox (gVisor)
                                     │                               non-root, read-only rootfs,
                                     │                               no caps, tmpfs only, cgroup limits
                                     │                                  │
                                     │                 python:  network = none
                                     │                 python-net / browser: internal per-job network
                                     │                                  ▼
                                     │                        Egress proxy (HMAC per job)
                                     │                        resolve → validate every IP → pin
                                     │                                  ▼  host firewall (iptables)
                                     ▼                              public internet only
                     results, artifacts, telemetry, security events
```

| Path | What it is |
|---|---|
| `controller/` | API, job queue and lifecycle, security controller (`app/executor.py`), telemetry |
| `sandbox-image/` | Sandbox image (Python 3.12, requests/httpx/bs4/lxml/pytest, Playwright Chromium) and the in-sandbox runner |
| `egress-proxy/` | SSRF-filtering forward proxy, the only way out of networked sandboxes |
| `deploy/` | `install.sh`, systemd unit, firewall rules, env template |
| `client/` | Lightweight Python client (stdlib only) |
| `benchmark/` | Security benchmark (12 tests), containment demo, controlled fixtures, results |
| `tests/` | Functional tests against the deployed service |
| `openapi.yaml` | API contract |
| `INTEGRATION.md` | How the backend integrates (examples, compatibility endpoints) |

## Job lifecycle

`queued → running → succeeded | failed | timeout | cancelled | error`

1. `POST /v1/jobs`. The schema is strict, and limits may only be lowered. Browser
   tools are checked against the job's permissions. Navigation targets are prechecked
   against the domain allowlist. The per-principal budget and the queue size are enforced.
2. A worker (at most `RUNTIME_MAX_CONCURRENCY` run at once) creates the sandbox.
   Networked profiles get their own internal network. The proxy is attached with a
   fixed IP, and a per-job egress policy file is written.
3. The controller supervises the container: it samples memory peaks from the cgroup,
   watches for cancellation and enforces an outer deadline (job timeout plus a grace period).
   Inside the sandbox, the runner enforces the job timeout on the generated code.
4. Results are read from a framed record in the container log. Artifacts are decoded
   and stored under `/var/lib/vultr-runtime/jobs/<id>/`.
5. On every path (success, failure, timeout, cancellation, controller error), the
   container is force-removed, the job network is removed and the egress policy is revoked.
   The controller then checks the result with Docker, and the outcome is recorded in
   `telemetry.cleanup`. A reaper runs every 60 s and at startup and destroys anything
   labelled `vrt.managed=1` that no running job owns.
6. Results are kept for `RUNTIME_JOB_TTL_HOURS` (24 h by default), then purged.

## Security architecture

Containment comes first. Everything a sandbox sees, runs or returns is untrusted.

| Requirement | Implementation |
|---|---|
| Stronger isolation | All sandboxes run under **gVisor (`runsc`)**, a user-space kernel. The controller refuses to start without it (`RUNTIME_ALLOW_RUNC_FALLBACK=0`). |
| Non-root | uid/gid 10001; setuid bits stripped from the image. |
| Capabilities / privilege escalation | `cap_drop=ALL`, `no-new-privileges`, `privileged=false`, private IPC. |
| Filesystem | Read-only rootfs. Writable `tmpfs` only: `/work` (64–128 MB), `/tmp` (64–256 MB), both `noexec,nosuid,nodev`, plus a bounded `/dev/shm`. No host mounts and no Docker socket. |
| Resource limits | Memory with swap disabled (cgroup, plus `RLIMIT_AS` for the Python profiles), CPU quota, process limit (gVisor-enforced `RLIMIT_NPROC`, with a host pids cgroup as backstop), `RLIMIT_FSIZE` 64 MB, nofile 4096, wall-clock timeout, output caps (stdout/stderr ≤ 4 MB, logs capped at 32 MB), artifacts ≤ 20 files / 12 MB. |
| Default-deny networking | The `python` profile uses `network_mode=none`. Networked profiles sit on an `internal` Docker network that has no route out. The only reachable endpoint is the proxy, and there is no DNS resolver in the sandbox. |
| Controlled egress / SSRF | Per-job proxy credentials (HMAC of the job ID), a per-job domain allowlist and ports 80/443 only. The proxy resolves DNS itself, rejects the request if **any** resolved address is non-public, and connects to the exact IP it validated, which defeats DNS rebinding. Blocked: loopback, RFC 1918, link-local, CGNAT, multicast, reserved and unspecified addresses; metadata IPs; the host's own addresses; IPv4-mapped, 6to4, NAT64 and Teredo embeddings; alternate IP encodings (they resolve to the same blocked addresses). Redirects and browser subrequests arrive as new proxy requests and are checked again. Chromium sends even loopback traffic to the proxy (`<-loopback>`) and WebRTC UDP is disabled. |
| Kernel-level enforcement | `deploy/firewall.sh` installs chains ahead of ufw and Docker. Job networks cannot reach the host or route anywhere. The proxy network cannot reach private ranges, metadata or host addresses, apart from operator-pinned trusted targets. This holds even if the proxy had a bug. |
| Credentials | Sandboxes get a fresh, minimal environment. API keys are stored hashed (`/etc/vultr-runtime/api_keys.json`). The proxy HMAC key is only in the proxy container. The Vultr inference key is never seen by the runtime. |
| Authentication / ownership | `Authorization: Bearer` on every endpoint except `/health`. Jobs are only visible to their owner (others get 404). Every rejection is logged as a security event. |
| Budgets | Global concurrency, queue size and per-principal active job limits (HTTP 429). |
| No caller-supplied Docker config | Strict schema (`extra=forbid`). Container options come only from fixed profiles. |
| Tool permissions | Browser actions come from a fixed vocabulary (no `evaluate`, no downloads). `fill`/`press` must be granted explicitly. Navigation is prechecked against the allowlist. All of this is enforced by the controller and the proxy, not by prompts. |
| Untrusted artifacts | Served as attachments with `nosniff` and a `sandbox` CSP. Names are sanitised and symlinks are ignored. |
| Public exposure gate | The controller refuses a non-loopback bind unless the core benchmark has passed on this host in the last 7 days. |

### gVisor vs rootless Docker (evaluation)

| | gVisor (`runsc`) | Rootless Docker |
|---|---|---|
| Protects against | Kernel exploits from the sandbox (syscalls are handled by gVisor's Sentry, not the host kernel) | Daemon or runtime compromise becoming host root |
| Works with the workloads | Yes: Python, pytest, Playwright Chromium (`--no-sandbox`, since gVisor is the sandbox) all verified | Yes |
| Impact on this shared VM | None: registered as an extra runtime, so teammates' containers stay on runc | Needs a second daemon per user, separate image store, slirp/pasta networking, and changes to how teammates run Docker |
| Measured cost | ~1 s Python start-up, ~5–8 s browser jobs | n/a |

**Decision:** gVisor is required for every sandbox. Rootless Docker would mainly
protect against a compromised Docker daemon. That is a smaller risk here, because
the daemon is not reachable from sandboxes, and running a second daemon on a shared
host would disrupt teammates. `userns-remap` was not enabled because it needs a
daemon-wide restart that affects all containers on the VM. Both are listed as
hardening steps for a dedicated host.

## Setup and deployment

Prerequisites on the host: Docker, gVisor registered as the runtime `runsc`
(`runsc install && systemctl reload docker`), Python 3 with `pip3`.

```bash
cd runtime
sudo deploy/install.sh        # builds images, installs to /opt/vultr-runtime, creates keys, starts the service
curl -s http://127.0.0.1:8001/health
```

What `install.sh` does (idempotent):

- Builds `vultr-runtime-sandbox:latest` and `vultr-runtime-egress-proxy:latest`.
- Installs the controller into `/opt/vultr-runtime` with its own venv.
- Creates `/etc/vultr-runtime/runtime.env` from `deploy/runtime.env.example`.
- Creates the API key for principal `backend` in `/etc/vultr-runtime/backend.key` and
  benchmark keys in `/etc/vultr-runtime/benchmark.keys` (all root 0600).
- Installs and starts `vultr-runtime.service`. `firewall.sh` runs before every start,
  and the controller re-applies it if the rules go missing.

Operations:

```bash
systemctl status vultr-runtime
journalctl -u vultr-runtime -f
cd /opt/vultr-runtime/controller && ../venv/bin/python -m app.keys add <principal>    # new API key (printed once)
../venv/bin/python -m app.keys disable <principal>
docker logs vrt-egress-proxy | tail                                                   # egress decisions
tail -f /var/lib/vultr-runtime/security-events.jsonl
```

Configuration lives in `/etc/vultr-runtime/runtime.env`: bind address, concurrency,
queue size, per-principal budget, trusted targets and the compatibility allowlist.
Restart the service after changing it.

## Tests and benchmark

```bash
sudo runtime/benchmark/demo.sh               # live demo of the six core containment tests
sudo runtime/benchmark/demo.sh --all         # all twelve
sudo /opt/vultr-runtime/venv/bin/python runtime/benchmark/run_benchmark.py --json-out out.json
sudo /opt/vultr-runtime/venv/bin/python runtime/tests/functional_test.py
```

Results go to `/var/lib/vultr-runtime/benchmark/latest.json`, which is served
(authenticated) at `GET /v1/security/benchmark` for the frontend. A copy of the
last run is committed in `benchmark/results/`.

Each test is judged on observations made outside the sandbox: controller telemetry,
the proxy's own allow/block decisions, `docker inspect` on the host, and canary
tokens the sandbox is never given. The six core tests are infinite loop, sandbox
isolation, SSRF, prompt injection, secret hygiene and lifecycle. `core_passed`
also requires every P0 test that was run to pass.

## Security limitations and remaining risks

- **Kernel and gVisor bugs.** gVisor greatly reduces exposure to the host kernel but
  does not remove it. Keep `runsc` and the kernel patched.
- **The controller is root-equivalent** (it uses the Docker socket). It listens on
  loopback only, and its API exposes no container options. Compromising it means
  compromising the host.
- **Shared Docker daemon.** Sandboxes share the daemon with teammates' containers.
  Rootless Docker or a dedicated sandbox host would isolate this further.
- **Domain fronting / CDN co-tenancy.** HTTPS is tunnelled without TLS inspection. A
  client could send a different SNI or Host header to the same validated public IP.
  This cannot reach internal addresses, but it can reach other sites on the same CDN IP.
- **`allowed_domains: ["*"]`** (used by the compatibility endpoints) allows any public
  host. Generated scrapers could exfiltrate data they were given to public servers.
  Sandboxes hold no secrets, but use narrow allowlists for sensitive jobs.
- **Trusted targets** (`70.34.217.56:8080`, the demo shop) are a deliberate pinned
  hole into the host for that one port.
- **Untrusted results.** Generated code runs as the same uid as the runner and can
  forge its own stdout and `result.json`. Security verdicts never depend on what the
  sandbox reports. Callers must still treat output, HTML and screenshots as hostile
  data, including prompt-injection text heading back to the LLM.
- **Denial of service.** Limits are per job and the number of concurrent jobs is
  bounded, but a principal can still use its full budget continuously. There is no
  per-principal CPU-time accounting.
- **IPv6.** Docker IPv6 is disabled on the runtime networks, so sandboxes have no IPv6
  path. If it is enabled later, mirror `firewall.sh` with `ip6tables`.
- **Persistence.** Job state is kept in memory plus JSON files. Jobs that are running
  when the controller restarts are marked `error`, and their sandboxes are reaped.
- **Browser profile memory.** Chromium needs ~200–250 MB of the 1536 MB limit, and gVisor
  adds overhead. Very large pages can hit the capture caps (5 MB HTML, 8 MB per artifact).
