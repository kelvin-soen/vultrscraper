"""Job queue, lifecycle, ownership, budgets and persistence."""
import asyncio
import ipaddress
import json
import logging
import os
import secrets
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlsplit

from .config import DEFAULT_ALLOWED_ACTIONS, KNOWN_ACTIONS, PROFILES, settings
from .events import security_event
from .executor import Executor, store_artifacts

log = logging.getLogger("vrt.jobs")
TERMINAL = {"succeeded", "failed", "timeout", "cancelled", "error"}


class PolicyViolation(Exception):
    def __init__(self, code, message, status=403):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass
class Job:
    id: str
    owner: str
    profile: str
    spec: dict
    limits: dict
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    error: Optional[str] = None
    telemetry: dict = field(default_factory=dict)
    result: Optional[dict] = None
    artifacts: list = field(default_factory=list)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    done_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def view(self):
        base = f"/v1/jobs/{self.id}"
        return {
            "id": self.id, "status": self.status, "profile": self.profile, "owner": self.owner,
            "created_at": self.created_at, "started_at": self.started_at, "finished_at": self.finished_at,
            "error": self.error, "metadata": self.spec.get("metadata"), "limits": self.limits,
            "telemetry": self.telemetry or None,
            "links": {"self": base, "result": f"{base}/result", "artifacts": f"{base}/artifacts"},
        }

    def record(self):
        return {"id": self.id, "owner": self.owner, "profile": self.profile, "spec": self.spec,
                "limits": self.limits, "status": self.status, "created_at": self.created_at,
                "started_at": self.started_at, "finished_at": self.finished_at, "error": self.error,
                "telemetry": self.telemetry, "artifacts": self.artifacts}


def _host_allowed(host, allowed):
    host = host.lower().rstrip(".")
    for pat in allowed:
        if pat == "*" or host == pat or (pat.startswith("*.") and host.endswith(pat[1:]) and host != pat[2:]):
            return True
    return False


class JobManager:
    def __init__(self):
        self.executor = Executor()
        self.jobs: dict[str, Job] = {}
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=settings.max_queue)
        self.workers = []
        self._lock = threading.Lock()

    # ------------------------------------------------------------ startup
    async def start(self):
        self.executor.ensure_dirs()
        self.ensure_firewall()
        await asyncio.to_thread(self.executor.ensure_egress)
        reaped = await asyncio.to_thread(self.executor.reap)
        if reaped["containers"] or reaped["networks"]:
            security_event("startup_reap", detail=reaped)
        self._load()
        for i in range(settings.max_concurrency):
            self.workers.append(asyncio.create_task(self._worker(i)))
        self.workers.append(asyncio.create_task(self._housekeeping()))

    def ensure_firewall(self):
        script = settings.firewall_script
        if not script:
            return
        ok = subprocess.run(["iptables", "-C", "INPUT", "-j", "VRT-INPUT"], capture_output=True).returncode == 0 and \
            subprocess.run(["iptables", "-C", "DOCKER-USER", "-j", "VRT-FORWARD"], capture_output=True).returncode == 0
        if not ok:
            env = dict(os.environ, RUNTIME_TRUSTED_TARGETS=settings.trusted_targets)
            r = subprocess.run([script], capture_output=True, text=True, env=env)
            security_event("firewall_applied", detail={"rc": r.returncode, "stderr": r.stderr[-500:]})

    def _load(self):
        if not os.path.isdir(settings.jobs_dir):
            return
        for jid in os.listdir(settings.jobs_dir):
            path = os.path.join(settings.jobs_dir, jid, "job.json")
            try:
                with open(path) as f:
                    rec = json.load(f)
            except (OSError, ValueError):
                continue
            job = Job(**{k: rec[k] for k in ("id", "owner", "profile", "spec", "limits", "status", "created_at",
                                            "started_at", "finished_at", "error", "telemetry", "artifacts")})
            if job.status not in TERMINAL:
                job.status, job.error, job.finished_at = "error", "runtime restarted during execution", time.time()
                self._persist(job)
            job.done_event.set()
            self.jobs[job.id] = job

    async def _housekeeping(self):
        while True:
            await asyncio.sleep(60)
            try:
                active = frozenset(j.id for j in self.jobs.values() if j.status == "running")
                reaped = await asyncio.to_thread(self.executor.reap, active)
                if reaped["containers"] or reaped["networks"]:
                    security_event("orphan_reaped", detail=reaped)
                self.ensure_firewall()
                cutoff = time.time() - settings.job_ttl_hours * 3600
                for job in list(self.jobs.values()):
                    if job.status in TERMINAL and (job.finished_at or 0) < cutoff:
                        self.purge(job)
            except Exception:  # noqa: BLE001
                log.exception("housekeeping failed")

    # ------------------------------------------------------------- submit
    def resolve_limits(self, req):
        prof = PROFILES[req.profile]
        lim = req.limits
        timeout = lim.timeout_s if lim and lim.timeout_s else prof.default_timeout_s
        memory = lim.memory_mb if lim and lim.memory_mb else prof.memory_mb
        cpus = lim.cpus if lim and lim.cpus else prof.cpus
        max_out = lim.max_output_kb if lim and lim.max_output_kb else prof.max_output_kb
        if timeout > prof.max_timeout_s:
            raise PolicyViolation("limit_exceeds_profile", f"timeout_s may not exceed {prof.max_timeout_s}", 422)
        if memory > prof.memory_mb:
            raise PolicyViolation("limit_exceeds_profile", f"memory_mb may not exceed {prof.memory_mb}", 422)
        if cpus > prof.cpus:
            raise PolicyViolation("limit_exceeds_profile", f"cpus may not exceed {prof.cpus}", 422)
        return {"timeout_s": timeout, "memory_mb": memory, "cpus": cpus, "max_output_kb": max_out}

    def enforce_tool_policy(self, principal, req):
        """Tool permissions are enforced here, outside any model or prompt."""
        if req.profile != "browser" or req.browser is None:
            return
        allowed = set(req.permissions.allowed_actions) if req.permissions and req.permissions.allowed_actions \
            else set(DEFAULT_ALLOWED_ACTIONS)
        unknown = allowed - KNOWN_ACTIONS
        if unknown:
            raise PolicyViolation("unknown_tool", f"unknown browser tools requested: {sorted(unknown)}")
        domains = req.network.allowed_domains if req.network else []
        for a in req.browser.actions:
            if a.type not in KNOWN_ACTIONS:
                raise PolicyViolation("unknown_tool", f"browser action {a.type!r} does not exist")
            if a.type not in allowed:
                raise PolicyViolation("tool_not_permitted", f"browser action {a.type!r} is not permitted for this job")
            if a.type == "goto":
                if not a.url or not a.url.lower().startswith(("http://", "https://")):
                    raise PolicyViolation("navigation_scheme_forbidden", "goto only allows http(s) URLs")
                host = urlsplit(a.url).hostname or ""
                self._precheck_host(host, domains, req)
        if req.browser.url:
            self._precheck_host(urlsplit(req.browser.url).hostname or "", domains, req)

    def _precheck_host(self, host, domains, req):
        """Fast rejection; the egress proxy remains the actual enforcement point."""
        try:
            ip = ipaddress.ip_address(host.strip("[]"))
            trusted = {t.strip() for t in settings.trusted_targets.split(",") if t.strip()}
            if req.network and req.network.allow_trusted_targets and any(t.rsplit(":", 1)[0] == str(ip) for t in trusted):
                return
            if not ip.is_global:
                raise PolicyViolation("navigation_forbidden_destination", f"navigation to non-public address {ip} is forbidden")
            if "*" not in domains:
                raise PolicyViolation("navigation_outside_allowlist", f"{host} is not in network.allowed_domains")
        except ValueError:
            if not _host_allowed(host, domains):
                raise PolicyViolation("navigation_outside_allowlist", f"{host!r} is not in network.allowed_domains")

    def submit(self, principal, req):
        try:
            limits = self.resolve_limits(req)
            self.enforce_tool_policy(principal, req)
        except PolicyViolation as pv:
            security_event("policy_violation", principal=principal,
                           detail={"code": pv.code, "message": pv.message, "profile": req.profile})
            raise
        with self._lock:
            active = sum(1 for j in self.jobs.values() if j.owner == principal and j.status in ("queued", "running"))
            if active >= settings.max_active_per_principal:
                security_event("budget_exceeded", principal=principal, detail={"active": active})
                raise PolicyViolation("budget_exceeded",
                                      f"too many active jobs ({active}/{settings.max_active_per_principal})", 429)
            if self.queue.full():
                raise PolicyViolation("queue_full", "runtime queue is full, retry later", 429)
            job = Job(id="job-" + secrets.token_hex(12), owner=principal, profile=req.profile,
                      spec=req.model_dump(exclude_none=True), limits=limits)
            self.jobs[job.id] = job
            self.queue.put_nowait(job)
        self._persist(job)
        return job

    # ------------------------------------------------------------ workers
    async def _worker(self, n):
        while True:
            job = await self.queue.get()
            try:
                if job.status != "queued":
                    continue
                job.status, job.started_at = "running", time.time()
                self._persist(job)

                def on_running(cid, job=job):
                    job.telemetry = {"container_id": cid, "oci_runtime": self.executor.oci_runtime}

                status, error, result, tel, artifacts = await asyncio.to_thread(
                    self.executor.run, job, job.limits, PROFILES[job.profile], on_running)
                job_dir = os.path.join(settings.jobs_dir, job.id)
                os.makedirs(job_dir, exist_ok=True)
                job.artifacts = store_artifacts(job_dir, artifacts)
                tel["artifacts"] = len(job.artifacts)
                job.status, job.error, job.telemetry, job.finished_at = status, error, tel, time.time()
                job.result = result
                with open(os.path.join(job_dir, "result.json"), "w") as f:
                    json.dump(result, f)
                for kind in tel.get("security_events", []):
                    security_event(kind, principal=job.owner, job_id=job.id,
                                   detail={"profile": job.profile, "container_id": tel.get("container_id")})
                if tel.get("blocked_operations"):
                    security_event("blocked_operations", principal=job.owner, job_id=job.id,
                                   detail={"count": len(tel["blocked_operations"]),
                                           "sample": tel["blocked_operations"][:5]})
            except Exception as e:  # noqa: BLE001
                log.exception("job %s crashed", job.id)
                job.status, job.error, job.finished_at = "error", f"controller error: {e}"[:300], time.time()
            finally:
                self._persist(job)
                job.done_event.set()
                self.queue.task_done()

    # ------------------------------------------------------------- access
    def get(self, job_id, principal) -> Optional[Job]:
        job = self.jobs.get(job_id)
        if job is None or job.owner != principal:
            if job is not None:
                security_event("ownership_denied", principal=principal, job_id=job_id)
            return None
        return job

    def load_result(self, job):
        if job.result is None and job.status in TERMINAL:
            try:
                with open(os.path.join(settings.jobs_dir, job.id, "result.json")) as f:
                    job.result = json.load(f)
            except (OSError, ValueError):
                pass
        return job.result

    def artifact_path(self, job, name):
        if not any(a["name"] == name for a in job.artifacts):
            return None
        return os.path.join(settings.jobs_dir, job.id, "artifacts", name)

    def cancel(self, job):
        if job.status == "queued":
            job.status, job.finished_at, job.error = "cancelled", time.time(), "cancelled before start"
            job.telemetry = {"job_id": job.id, "cancelled": True, "cleanup": {"container_removed": None,
                                                                             "note": "never started"}}
            self._persist(job)
            job.done_event.set()
            security_event("cancelled", principal=job.owner, job_id=job.id, detail={"phase": "queued"})
        elif job.status == "running":
            job.cancel_event.set()
        return job

    def purge(self, job):
        shutil.rmtree(os.path.join(settings.jobs_dir, job.id), ignore_errors=True)
        self.jobs.pop(job.id, None)

    def _persist(self, job):
        d = os.path.join(settings.jobs_dir, job.id)
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, "job.json.tmp")
        with open(tmp, "w") as f:
            json.dump(job.record(), f, default=str)
        os.replace(tmp, os.path.join(d, "job.json"))

    def stats(self):
        return {"queued": sum(1 for j in self.jobs.values() if j.status == "queued"),
                "running": sum(1 for j in self.jobs.values() if j.status == "running"),
                "max_concurrency": settings.max_concurrency}
