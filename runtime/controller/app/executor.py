"""Security controller: turns a validated job into one disposable, locked-down
container, supervises it, collects results and destroys everything it created.

Callers never influence container configuration directly: every option below
is derived from a fixed profile plus limits that may only be lowered."""
import base64
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import subprocess
import threading
import time

import docker
from docker.errors import APIError, NotFound
from docker.types import IPAMConfig, IPAMPool, LogConfig, Ulimit

from .config import settings

LABEL = "vrt.managed"
MARK_BEGIN = "@@VRT_RESULT_BEGIN@@"
MARK_END = "@@VRT_RESULT_END@@"
SPEC_CHUNK = 100_000
MAX_SPEC_B64 = 1_500_000
LOG_MAX = "32m"
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


def _now():
    return time.time()


def proxy_token(job_id):
    with open(settings.proxy_key_file, "rb") as f:
        key = f.read().strip()
    return hmac.new(key, job_id.encode(), hashlib.sha256).hexdigest()[:48]


def host_addresses():
    """Global addresses of this host, blocked as egress destinations."""
    out = set()
    try:
        data = json.loads(subprocess.run(["ip", "-j", "addr"], capture_output=True, text=True, timeout=5).stdout)
        for itf in data:
            for a in itf.get("addr_info", []):
                ip = ipaddress.ip_address(a["local"])
                if ip.is_global:
                    out.add(str(ip))
    except Exception:  # noqa: BLE001
        pass
    return sorted(out)


class Executor:
    def __init__(self):
        self.client = docker.from_env(timeout=120)
        self._slot_lock = threading.Lock()
        self._slots = set()
        self.oci_runtime = self._detect_runtime()

    # ------------------------------------------------------------- setup
    def _detect_runtime(self):
        runtimes = self.client.info().get("Runtimes", {})
        if settings.oci_runtime in runtimes:
            return settings.oci_runtime
        if settings.allow_runc_fallback:
            return "runc"
        raise RuntimeError(f"OCI runtime {settings.oci_runtime!r} not available; refusing to start "
                           f"(set RUNTIME_ALLOW_RUNC_FALLBACK=1 to accept weaker isolation)")

    def ensure_dirs(self):
        for d, mode in ((settings.data_dir, 0o711), (settings.jobs_dir, 0o700), (settings.policy_dir, 0o755),
                        (settings.proxy_events_dir, 0o700), (os.path.dirname(settings.benchmark_file), 0o755)):
            os.makedirs(d, exist_ok=True)
            os.chmod(d, mode)
        os.chown(settings.proxy_events_dir, 10002, 10002)
        if not os.path.exists(settings.proxy_key_file):
            os.makedirs(settings.config_dir, exist_ok=True)
            with open(settings.proxy_key_file, "w") as f:
                f.write(os.urandom(32).hex())
        os.chown(settings.proxy_key_file, 0, 10002)
        os.chmod(settings.proxy_key_file, 0o440)

    def ensure_egress(self):
        try:
            self.client.networks.get(settings.egress_network)
        except NotFound:
            self.client.networks.create(
                settings.egress_network, driver="bridge", internal=False, labels={"vrt.component": "egress"},
                ipam=IPAMConfig(pool_configs=[IPAMPool(subnet=settings.egress_subnet, gateway="10.251.0.1")]),
                options={"com.docker.network.bridge.name": "vrt-egress0",
                         "com.docker.network.bridge.enable_icc": "false"})
        image_id = self.client.images.get(settings.proxy_image).id
        env = {"VRT_TRUSTED_TARGETS": settings.trusted_targets, "VRT_BLOCKED_IPS": ",".join(host_addresses())}
        try:
            c = self.client.containers.get(settings.proxy_name)
        except NotFound:
            c = None
        if c is not None:
            env_now = c.attrs["Config"].get("Env") or []
            stale = c.attrs.get("Image") != image_id or \
                f"VRT_TRUSTED_TARGETS={env['VRT_TRUSTED_TARGETS']}" not in env_now or \
                f"VRT_BLOCKED_IPS={env['VRT_BLOCKED_IPS']}" not in env_now
            if not stale:
                if c.status != "running":
                    c.start()
                return
            c.remove(force=True)
            for _ in range(40):
                try:
                    self.client.containers.get(settings.proxy_name)
                    time.sleep(0.25)
                except NotFound:
                    break
        self.client.containers.run(
            settings.proxy_image, name=settings.proxy_name, detach=True, network=settings.egress_network,
            restart_policy={"Name": "unless-stopped"}, read_only=True, cap_drop=["ALL"],
            security_opt=["no-new-privileges:true"], user="10002:10002", mem_limit="256m", memswap_limit="256m",
            pids_limit=256, nano_cpus=int(1e9), dns=["1.1.1.1", "8.8.8.8"], environment=env,
            volumes={settings.policy_dir: {"bind": "/policies", "mode": "ro"},
                     settings.proxy_events_dir: {"bind": "/events", "mode": "rw"},
                     settings.proxy_key_file: {"bind": "/run/secrets/proxy_hmac", "mode": "ro"}},
            labels={"vrt.component": "egress-proxy"},
            log_config=LogConfig(type="json-file", config={"max-size": "20m", "max-file": "2"}))

    def proxy_running(self):
        try:
            return self.client.containers.get(settings.proxy_name).status == "running"
        except Exception:  # noqa: BLE001
            return False

    def reap(self, active_job_ids=frozenset()):
        """Destroy sandboxes and job networks that belong to no active job
        (crash recovery and periodic safety net)."""
        removed = {"containers": [], "networks": []}
        for c in self.client.containers.list(all=True, filters={"label": f"{LABEL}=1"}):
            if c.labels.get("vrt.job") in active_job_ids:
                continue
            try:
                c.remove(force=True)
                removed["containers"].append(c.name)
            except NotFound:
                pass
        for n in self.client.networks.list(filters={"label": f"{LABEL}=1"}):
            if n.attrs.get("Labels", {}).get("vrt.job") in active_job_ids:
                continue
            self._remove_network(n.name)
            removed["networks"].append(n.name)
        return removed

    # ----------------------------------------------------------- helpers
    def _alloc_slot(self):
        with self._slot_lock:
            for i in range(1, 250):
                if i not in self._slots:
                    self._slots.add(i)
                    return i
        raise RuntimeError("no free network slots")

    def _free_slot(self, slot):
        with self._slot_lock:
            self._slots.discard(slot)

    def _remove_network(self, name):
        try:
            net = self.client.networks.get(name)
        except NotFound:
            return True
        try:
            net.disconnect(settings.proxy_name, force=True)
        except (NotFound, APIError):
            pass
        try:
            net.remove()
        except NotFound:
            pass
        except APIError:
            # A container may still be detaching; retry once.
            time.sleep(0.5)
            try:
                net.remove()
            except (NotFound, APIError):
                pass
        try:
            self.client.networks.get(name)
            return False
        except NotFound:
            return True

    @staticmethod
    def _cgroup_peak_path(cid):
        for p in (f"/sys/fs/cgroup/system.slice/docker-{cid}.scope/memory.peak",
                  f"/sys/fs/cgroup/docker/{cid}/memory.peak"):
            if os.path.exists(p):
                return p
        return None

    def _sample_memory(self, cid, state):
        path = state.get("peak_path") or self._cgroup_peak_path(cid)
        if path:
            state["peak_path"] = path
            try:
                with open(path) as f:
                    v = int(f.read().strip())
                state["peak"] = max(state.get("peak", 0), v)
                state["source"] = "cgroup.memory.peak"
                return
            except (OSError, ValueError):
                pass
        if _now() - state.get("last_stats", 0) >= 1.0:
            state["last_stats"] = _now()
            try:
                st = self.client.api.stats(cid, stream=False, one_shot=True)
                v = st.get("memory_stats", {}).get("usage")
                if v:
                    state["peak"] = max(state.get("peak", 0), int(v))
                    state["source"] = "docker.stats.usage(sampled)"
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _parse_result(logs: bytes):
        text = logs.decode("utf-8", "replace")
        b = text.rfind(MARK_BEGIN)
        e = text.rfind(MARK_END)
        if b == -1 or e == -1 or e < b:
            return None
        payload = "".join(text[b + len(MARK_BEGIN):e].split())
        try:
            return json.loads(base64.b64decode(payload))
        except Exception:  # noqa: BLE001
            return None

    # --------------------------------------------------------------- run
    def run(self, job, limits, prof, on_running):
        """Execute one job. Returns (status, error, result, telemetry, artifacts)."""
        job_id = job.id
        spec = job.spec
        t_start = _now()
        tel = {
            "job_id": job_id, "profile": prof.name, "oci_runtime": self.oci_runtime, "container_id": None,
            "queued_ms": int((t_start - job.created_at) * 1000), "timeout_s": limits["timeout_s"],
            "timed_out": False, "cancelled": False, "oom_killed": False, "exit_code": None,
            "memory_limit_bytes": limits["memory_mb"] * 1024 * 1024, "memory_peak_bytes": None,
            "blocked_operations": [], "security_events": [], "egress": {"allowed": 0, "blocked": 0},
            "cleanup": {"container_removed": None, "network_removed": None, "policy_revoked": None},
        }
        net_name = slot = cid = None
        policy_path = os.path.join(settings.policy_dir, f"{job_id}.json")
        events_path = os.path.join(settings.proxy_events_dir, f"{job_id}.jsonl")
        result = None
        error = None
        status = "failed"
        try:
            env = {"HOME": "/work/home", "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1"}
            egress = None
            if prof.networked:
                slot = self._alloc_slot()
                net_name = f"vrt-{job_id}"
                subnet = f"{settings.job_net_prefix}.{slot}.0/24"
                proxy_ip = f"{settings.job_net_prefix}.{slot}.2"
                net = self.client.networks.create(
                    net_name, driver="bridge", internal=True, labels={LABEL: "1", "vrt.job": job_id},
                    ipam=IPAMConfig(pool_configs=[IPAMPool(subnet=subnet, gateway=f"{settings.job_net_prefix}.{slot}.1")]))
                net.connect(settings.proxy_name, ipv4_address=proxy_ip)
                nw = spec.get("network") or {}
                egress = {"allowed_domains": nw.get("allowed_domains", []),
                          "allow_trusted_targets": bool(nw.get("allow_trusted_targets")),
                          "expires_at": _now() + limits["timeout_s"] + 300}
                tmp = policy_path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(egress, f)
                os.chmod(tmp, 0o644)
                os.replace(tmp, policy_path)
                tok = proxy_token(job_id)
                purl = f"http://{job_id}:{tok}@{proxy_ip}:3128"
                env.update({"HTTP_PROXY": purl, "HTTPS_PROXY": purl, "http_proxy": purl, "https_proxy": purl,
                            "NO_PROXY": "", "no_proxy": "", "VRT_PROXY_SERVER": f"http://{proxy_ip}:3128",
                            "VRT_PROXY_USER": job_id, "VRT_PROXY_PASS": tok})

            runner_spec = {
                "profile": prof.name, "code": spec.get("code"), "test_code": spec.get("test_code"),
                "inputs": spec.get("inputs"), "browser": spec.get("browser"),
                "timeout_s": limits["timeout_s"], "memory_mb": limits["memory_mb"],
                "rlimit_as": prof.rlimit_as, "nproc": prof.nproc,
                "max_output_bytes": limits["max_output_kb"] * 1024,
            }
            b64 = base64.b64encode(json.dumps(runner_spec).encode()).decode()
            if len(b64) > MAX_SPEC_B64:
                raise ValueError("job spec too large")
            chunks = [b64[i:i + SPEC_CHUNK] for i in range(0, len(b64), SPEC_CHUNK)]
            env["VRT_SPEC_CHUNKS"] = str(len(chunks))
            for i, c in enumerate(chunks):
                env[f"VRT_SPEC_{i}"] = c

            policies = {
                "oci_runtime": self.oci_runtime,
                "user": "10001:10001 (non-root)",
                "read_only_rootfs": True,
                "cap_drop": ["ALL"],
                "no_new_privileges": True,
                "network": "none" if not prof.networked else "internal per-job network; egress only via SSRF-filtering proxy",
                "egress_policy": egress and {k: v for k, v in egress.items() if k != "expires_at"},
                "memory_mb": limits["memory_mb"], "swap": "disabled",
                "cpus": limits["cpus"], "pids_limit": prof.nproc, "host_pids_backstop": prof.pids,
                "tmpfs": {"/work": f"{prof.tmpfs_work_mb}m noexec,nosuid,nodev",
                          "/tmp": f"{prof.tmpfs_tmp_mb}m noexec,nosuid,nodev", "/dev/shm": f"{prof.shm_mb}m"},
                "timeout_s": limits["timeout_s"], "max_output_kb": limits["max_output_kb"],
                "log_cap": LOG_MAX, "mounts": "none (no host paths, no Docker socket)",
                "env": "fresh, no host or backend credentials",
            }
            tel["policies"] = policies

            create_kwargs = dict(
                image=settings.sandbox_image, name=f"vrt-sbx-{job_id}", detach=True, environment=env,
                user="10001:10001", working_dir="/work", hostname="sandbox", runtime=self.oci_runtime,
                read_only=True,
                tmpfs={"/work": f"rw,noexec,nosuid,nodev,size={prof.tmpfs_work_mb}m,mode=1777",
                       "/tmp": f"rw,noexec,nosuid,nodev,size={prof.tmpfs_tmp_mb}m,mode=1777"},
                shm_size=f"{prof.shm_mb}m",
                mem_limit=f"{limits['memory_mb']}m", memswap_limit=f"{limits['memory_mb']}m",
                nano_cpus=int(limits["cpus"] * 1e9), pids_limit=prof.pids,
                ulimits=[Ulimit(name="nofile", soft=4096, hard=4096), Ulimit(name="core", soft=0, hard=0)],
                cap_drop=["ALL"], security_opt=["no-new-privileges:true"], ipc_mode="private",
                init=True, privileged=False, labels={LABEL: "1", "vrt.job": job_id, "vrt.profile": prof.name},
                log_config=LogConfig(type="json-file", config={"max-size": LOG_MAX, "max-file": "1"}),
            )
            if prof.networked:
                create_kwargs["network"] = net_name
            else:
                create_kwargs["network_mode"] = "none"

            container = self.client.containers.create(**create_kwargs)
            cid = container.id
            tel["container_id"] = cid
            tel["container_name"] = f"vrt-sbx-{job_id}"
            container.start()
            on_running(cid)

            # Supervise: outer deadline is the job timeout plus a grace period
            # for container start-up and result emission.
            deadline = _now() + limits["timeout_s"] + (25 if prof.name == "browser" else 10)
            mem = {}
            while True:
                st = self.client.api.inspect_container(cid)["State"]
                if not st.get("Running"):
                    break
                self._sample_memory(cid, mem)
                if job.cancel_event.is_set():
                    tel["cancelled"] = True
                    self.client.api.kill(cid)
                    break
                if _now() > deadline:
                    tel["timed_out"] = True
                    tel["security_events"].append("timeout_enforced_by_controller")
                    self.client.api.kill(cid)
                    break
                time.sleep(0.25)
            # Wait for the kill to land.
            for _ in range(40):
                st = self.client.api.inspect_container(cid)["State"]
                if not st.get("Running"):
                    break
                time.sleep(0.25)
            tel["exit_code"] = st.get("ExitCode")
            tel["oom_killed"] = bool(st.get("OOMKilled"))
            tel["started_at"] = st.get("StartedAt")
            tel["finished_at"] = st.get("FinishedAt")
            tel["memory_peak_bytes"] = mem.get("peak")
            tel["memory_source"] = mem.get("source")
            logs = self.client.api.logs(cid, stdout=True, stderr=True)
            tel["container_log_bytes"] = len(logs)
            result = self._parse_result(logs)
        except Exception as e:  # noqa: BLE001
            error = f"runtime error: {e.__class__.__name__}: {e}"[:500]
        finally:
            # ---- destroy everything this job created, then verify
            if cid:
                try:
                    self.client.api.remove_container(cid, force=True)
                except NotFound:
                    pass
                except APIError as e:
                    error = error or f"cleanup error: {e}"[:300]
                try:
                    self.client.api.inspect_container(cid)
                    tel["cleanup"]["container_removed"] = False
                except NotFound:
                    tel["cleanup"]["container_removed"] = True
            if net_name:
                tel["cleanup"]["network_removed"] = self._remove_network(net_name)
            if slot:
                self._free_slot(slot)
            if os.path.exists(policy_path):
                os.remove(policy_path)
            if prof.networked:
                tel["cleanup"]["policy_revoked"] = not os.path.exists(policy_path)
            tel["cleanup"]["verified_at"] = _now()
            # Egress decisions logged by the proxy for this job.
            if os.path.exists(events_path):
                with open(events_path, encoding="utf-8") as f:
                    for line in f:
                        try:
                            ev = json.loads(line)
                        except ValueError:
                            continue
                        if ev.get("action") == "blocked":
                            tel["egress"]["blocked"] += 1
                            if len(tel["blocked_operations"]) < 200:
                                tel["blocked_operations"].append({
                                    "source": "egress-proxy", "operation": f"{ev.get('method')} {ev.get('host')}:{ev.get('port')}",
                                    "reason": ev.get("reason"), "resolved": ev.get("resolved"), "ts": ev.get("ts")})
                        elif ev.get("action") == "allowed":
                            tel["egress"]["allowed"] += 1
                            dests = tel["egress"].setdefault("destinations", [])
                            if len(dests) < 100:
                                dests.append({"host": ev.get("host"), "port": ev.get("port"),
                                              "connected_ip": ev.get("connected_ip"),
                                              "trusted_target": ev.get("trusted_target", False)})
                os.remove(events_path)
            tel["duration_ms"] = int((_now() - t_start) * 1000)

        # ---- interpret outcome
        artifacts = []
        if result is not None:
            for a in result.pop("artifacts", []) or []:
                artifacts.append(a)
            br = result.get("browser") or {}
            for b in br.get("blocked_requests", []):
                if len(tel["blocked_operations"]) < 250:
                    tel["blocked_operations"].append({"source": "browser", "operation": b.get("url"), "reason": b.get("reason")})
            for a in br.get("actions", []):
                if a.get("type") == "download":
                    tel["blocked_operations"].append({"source": "browser", "operation": "download", "reason": a.get("error")})
            if result.get("stdout_truncated") or result.get("stderr_truncated"):
                tel["security_events"].append("output_truncated")
            if result.get("timed_out"):
                tel["timed_out"] = True
                tel["security_events"].append("timeout_enforced_in_sandbox")
        if tel["oom_killed"]:
            tel["security_events"].append("oom_killed")
        if tel["egress"]["blocked"]:
            tel["security_events"].append("egress_blocked")
        if tel["cancelled"]:
            tel["security_events"].append("cancelled")
        tel["output"] = None if result is None else {
            k: result.get(k) for k in ("stdout_bytes", "stdout_truncated", "stderr_bytes", "stderr_truncated")}
        tel["code_exit_code"] = None if result is None else result.get("exit_code")

        if tel["cancelled"]:
            status = "cancelled"
        elif tel["timed_out"]:
            status, error = "timeout", error or f"execution exceeded {limits['timeout_s']}s"
        elif tel["oom_killed"]:
            status, error = "failed", error or "memory limit exceeded (OOM killed)"
        elif error:
            status = "error"
        elif result is None:
            status, error = "failed", f"sandbox exited without a result (exit code {tel['exit_code']})"
        elif result.get("runner_error"):
            status, error = "failed", "runner error"
        elif result.get("exit_code") not in (None, 0):
            status, error = "failed", f"code exited with {result.get('exit_code')}"
        elif result.get("tests") and not result["tests"].get("passed"):
            status, error = "failed", "validation tests failed"
        elif (result.get("browser") or {}).get("error") and not spec.get("code"):
            status, error = "failed", result["browser"]["error"]
        else:
            status = "succeeded"
        return status, error, result, tel, artifacts


def store_artifacts(job_dir, artifacts):
    """Persist artifacts decoded from the (untrusted) runner result."""
    adir = os.path.join(job_dir, "artifacts")
    os.makedirs(adir, exist_ok=True)
    listing = []
    for a in artifacts:
        name = str(a.get("name", ""))
        if not SAFE_NAME.match(name) or name.startswith("."):
            continue
        try:
            data = base64.b64decode(a.get("data_b64", ""))
        except Exception:  # noqa: BLE001
            continue
        with open(os.path.join(adir, name), "wb") as f:
            f.write(data)
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        listing.append({"name": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                        "content_type": ctype})
    return listing
