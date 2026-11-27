#!/usr/bin/env python3
"""Containment demo: runs the six core security tests live on this host and
prints what was actually observed. Usage (on the VM):

    sudo runtime/benchmark/demo.sh            # six core tests
    sudo runtime/benchmark/demo.sh --all      # all twelve
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY = "/opt/vultr-runtime/venv/bin/python"
G, R, Y, B, D, X = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[2m", "\033[0m"


def mb(v):
    return f"{v / 1048576:.0f} MB" if v else "n/a"


def line(t):
    o, tel = t["observed"], t.get("telemetry") or {}
    i = t["id"]
    if i == "infinite_loop":
        return f"while True loop killed after {o.get('observed_wall_s')}s (limit {o.get('timeout_s')}s), status={o.get('status')}"
    if i == "sandbox_isolation":
        return (f"scanned {o.get('files_scanned_in_sandbox')} files as uid {o.get('sandbox_uid')}: host canary leaked={o.get('canary_leaked')}, "
                f"docker.sock visible={o.get('docker_socket_visible')}")
    if i == "ssrf":
        return (f"{o.get('blocked_or_unreachable')}/{o.get('forbidden_targets')} internal targets stopped "
                f"(metadata, loopback, private, host, DNS-rebinding, IPv6, {o.get('redirects_verified_blocked')} redirects); "
                f"public control={o.get('control_public_request')}; proxy connections to non-public IPs={len(o.get('proxy_connections_to_non_public_ips') or [])}")
    if i == "prompt_injection":
        hp = o.get("hostile_page", {})
        na = o.get("naive_agent_attempts", [])
        return (f"hostile page: {len(hp.get('proxy_blocked_subrequests', []))} exfil requests blocked, "
                f"{len(hp.get('allowed_connections_to_forbidden', []))} got through; "
                f"naive agent: {sum(a['blocked'] for a in na)}/{len(na)} injected actions refused")
    if i == "secret_hygiene":
        return f"{len(o.get('secrets_checked', []))} host/backend secrets checked, leaked: {o.get('leaked') or 'none'}"
    if i == "lifecycle":
        cs = o.get("cases", [])
        return (f"{sum(c['passed'] for c in cs)}/{len(cs)} jobs (ok/fail/timeout/net/browser) destroyed; "
                f"leftover sandboxes: {len(o.get('leftover_sandbox_containers', []))}")
    if i == "memory_exhaustion":
        return "; ".join(f"{c['case']}: {c['last_output'] or c['error']} (peak {c['memory_peak_mb']} MB / {c['limit_mb']} MB)"
                         for c in o.get("cases", []))
    if i == "process_exhaustion":
        return f"fork bomb stopped at {o.get('total')} processes (limit {o.get('pids_limit')})"
    if i == "cross_job_isolation":
        return f"concurrent job saw pids {o.get('b_visible_pids')}, other job's secret visible={o.get('token_visible_to_b')}"
    if i == "api_authentication":
        cs = o.get("checks", [])
        return f"{sum(c['passed'] for c in cs)}/{len(cs)} auth checks correct (no key/forged key 401, other owner 404, docker/env overrides 422)"
    if i == "output_exhaustion":
        a, b = o.get("runner_stdout", {}), o.get("direct_container_stdout", {})
        return (f"300 MB stdout -> {a.get('returned_bytes', 0) // 1024} KB returned; "
                f"100 MB raw log -> {mb(b.get('container_log_bytes'))} kept")
    if i == "cancellation":
        return f"running job cancelled and destroyed in {o.get('seconds_to_terminate_and_clean')}s"
    return ""


def main():
    args = ["--all"] if "--all" in sys.argv else ["--core"]
    out = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
    cmd = [PY, os.path.join(HERE, "run_benchmark.py"), "--json-out", out]
    if args == ["--core"]:
        cmd.append("--core")
    print(f"{B}Vultr Agent Runtime: live containment demo{X}")
    print(f"{D}running {'six core' if args == ['--core'] else 'all twelve'} tests against the deployed runtime...{X}\n")
    subprocess.run(cmd, stdout=subprocess.DEVNULL)
    rep = json.load(open(out))
    h = rep["runtime_health"]
    print(f"host={rep['host']}  isolation={h.get('oci_runtime')} (gVisor)  egress_proxy={h.get('egress_proxy')}\n")
    for t in rep["tests"]:
        tel = t.get("telemetry") or {}
        mark = f"{G}PASS{X}" if t["passed"] else f"{R}FAIL{X}"
        cid = (tel.get("container_id") or "")[:12] or "-"
        cl = (tel.get("cleanup") or {}).get("container_removed")
        print(f" {mark}  {B}{t['name']:<22}{X} [{t['priority']}]  {line(t)}")
        print(f"       {D}container {cid}  runtime={tel.get('oci_runtime') or '-'}  duration={tel.get('duration_ms') or '-'} ms  "
              f"mem peak={mb(tel.get('memory_peak_bytes'))}  exit={tel.get('exit_code')}  destroyed={cl}{X}")
        if t.get("error"):
            print(f"       {Y}{t['error']}{X}")
    s = rep["summary"]
    verdict = f"{G}ALL CONTAINMENT TESTS PASSED{X}" if rep["all_passed"] else f"{R}{s['failed']} TEST(S) FAILED{X}"
    print(f"\n {verdict}  ({s['passed']}/{s['total']})   results: /var/lib/vultr-runtime/benchmark/latest.json")
    return 0 if rep["all_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
