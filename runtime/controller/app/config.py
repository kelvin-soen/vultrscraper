"""Runtime configuration, loaded from the environment (see deploy/runtime.env.example)."""
import ipaddress
import os
from dataclasses import dataclass, field


def _env(name, default):
    return os.environ.get(name, default)


@dataclass(frozen=True)
class ProfileLimits:
    name: str
    networked: bool
    default_timeout_s: int
    max_timeout_s: int
    memory_mb: int
    cpus: float
    pids: int
    tmpfs_work_mb: int
    tmpfs_tmp_mb: int
    shm_mb: int
    rlimit_as: bool
    nproc: int = 64            # process limit inside the sandbox (enforced by the gVisor kernel)
    max_output_kb: int = 1024


PROFILES = {
    # Generated Python code with no network at all (network_mode=none).
    # pids = host-side cgroup backstop (gVisor's own threads count against it);
    # nproc = per-sandbox process limit seen by generated code.
    "python": ProfileLimits("python", False, 30, 120, 256, 1.0, 512, 64, 64, 64, True, nproc=64),
    # Python scraping through the SSRF-filtering egress proxy only.
    "python-net": ProfileLimits("python-net", True, 30, 120, 512, 1.0, 512, 64, 64, 64, True, nproc=64),
    # Playwright Chromium through the egress proxy only.
    "browser": ProfileLimits("browser", True, 60, 180, 1536, 2.0, 1024, 128, 256, 512, False, nproc=256),
}

# Browser actions known to the runner. Anything else is rejected before a
# container is created, regardless of what the requesting agent was told.
KNOWN_ACTIONS = {"goto", "click", "fill", "press", "wait_for_selector", "wait", "scroll",
                 "extract_text", "extract_attribute", "extract_html", "screenshot"}
DEFAULT_ALLOWED_ACTIONS = KNOWN_ACTIONS - {"fill", "press"}


@dataclass(frozen=True)
class Settings:
    bind: str = _env("RUNTIME_BIND", "127.0.0.1")
    port: int = int(_env("RUNTIME_PORT", "8001"))
    data_dir: str = _env("RUNTIME_DATA_DIR", "/var/lib/vultr-runtime")
    config_dir: str = _env("RUNTIME_CONFIG_DIR", "/etc/vultr-runtime")
    sandbox_image: str = _env("RUNTIME_SANDBOX_IMAGE", "vultr-runtime-sandbox:latest")
    proxy_image: str = _env("RUNTIME_PROXY_IMAGE", "vultr-runtime-egress-proxy:latest")
    oci_runtime: str = _env("RUNTIME_OCI_RUNTIME", "runsc")
    allow_runc_fallback: bool = _env("RUNTIME_ALLOW_RUNC_FALLBACK", "0") == "1"
    max_concurrency: int = int(_env("RUNTIME_MAX_CONCURRENCY", "4"))
    max_queue: int = int(_env("RUNTIME_MAX_QUEUE", "50"))
    max_active_per_principal: int = int(_env("RUNTIME_MAX_ACTIVE_PER_PRINCIPAL", "6"))
    job_ttl_hours: int = int(_env("RUNTIME_JOB_TTL_HOURS", "24"))
    trusted_targets: str = _env("RUNTIME_TRUSTED_TARGETS", "")
    compat_allowed_domains: str = _env("RUNTIME_COMPAT_ALLOWED_DOMAINS", "*")
    job_net_prefix: str = "10.250"
    egress_subnet: str = "10.251.0.0/24"
    proxy_name: str = "vrt-egress-proxy"
    egress_network: str = "vrt-egress"
    firewall_script: str = _env("RUNTIME_FIREWALL_SCRIPT", "")

    @property
    def jobs_dir(self):
        return os.path.join(self.data_dir, "jobs")

    @property
    def policy_dir(self):
        return os.path.join(self.data_dir, "policies")

    @property
    def proxy_events_dir(self):
        return os.path.join(self.data_dir, "proxy-events")

    @property
    def benchmark_file(self):
        return os.path.join(self.data_dir, "benchmark", "latest.json")

    @property
    def api_keys_file(self):
        return os.path.join(self.config_dir, "api_keys.json")

    @property
    def proxy_key_file(self):
        return os.path.join(self.config_dir, "proxy_hmac.key")

    def is_loopback_bind(self):
        try:
            return ipaddress.ip_address(self.bind).is_loopback
        except ValueError:
            return self.bind == "localhost"


settings = Settings()
