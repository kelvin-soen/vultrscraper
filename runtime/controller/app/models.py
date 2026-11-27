"""Request/response schemas. Unknown fields are rejected everywhere, so callers
cannot smuggle Docker options, environment variables or mounts."""
import json
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DOMAIN_RE = re.compile(r"^(\*|(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Limits(Strict):
    timeout_s: Optional[int] = Field(None, ge=1, le=600, description="Wall-clock limit; capped by the profile maximum.")
    memory_mb: Optional[int] = Field(None, ge=64, le=4096, description="May only lower the profile limit.")
    cpus: Optional[float] = Field(None, gt=0, le=4, description="May only lower the profile limit.")
    max_output_kb: Optional[int] = Field(None, ge=1, le=4096, description="Cap for returned stdout/stderr each.")


class NetworkPolicy(Strict):
    allowed_domains: list[str] = Field(default_factory=list, max_length=50,
                                       description='Exact hosts, "*.example.com" for subdomains, or "*" for any public host.')
    allow_trusted_targets: bool = Field(False, description="Allow operator-pinned internal targets (e.g. the demo site).")

    @field_validator("allowed_domains")
    @classmethod
    def _domains(cls, v):
        out = []
        for d in v:
            d = d.strip().lower().rstrip(".")
            if len(d) > 253 or not DOMAIN_RE.match(d):
                raise ValueError(f"invalid domain pattern: {d!r}")
            out.append(d)
        return out


class BrowserAction(Strict):
    type: str = Field(..., max_length=40)
    url: Optional[str] = Field(None, max_length=2048)
    selector: Optional[str] = Field(None, max_length=1000)
    value: Optional[str] = Field(None, max_length=10000)
    key: Optional[str] = Field(None, max_length=50)
    attr: Optional[str] = Field(None, max_length=100)
    name: Optional[str] = Field(None, max_length=60)
    all: bool = False
    full_page: bool = True
    ms: Optional[int] = Field(None, ge=0, le=30000)
    y: Optional[int] = Field(None, ge=-100000, le=100000)
    timeout_ms: Optional[int] = Field(None, ge=100, le=60000)


class BrowserSpec(Strict):
    url: Optional[str] = Field(None, max_length=2048)
    html_content: Optional[str] = Field(None, max_length=512_000, description="Render this HTML instead of navigating.")
    actions: list[BrowserAction] = Field(default_factory=list, max_length=50)
    screenshot: bool = True
    full_page: bool = True
    capture_html: bool = True
    wait_until: Literal["load", "domcontentloaded", "networkidle", "commit"] = "load"
    viewport_width: int = Field(1366, ge=320, le=3840)
    viewport_height: int = Field(900, ge=240, le=2160)
    nav_timeout_ms: int = Field(30000, ge=1000, le=60000)


class Permissions(Strict):
    allowed_actions: Optional[list[str]] = Field(None, max_length=20,
                                                 description="Browser tools this job may use (subset of the known actions).")


class JobCreate(Strict):
    profile: Literal["python", "python-net", "browser"]
    code: Optional[str] = Field(None, max_length=100_000, description="Python source executed as main.py.")
    test_code: Optional[str] = Field(None, max_length=50_000, description="Optional pytest file run after the code.")
    inputs: Optional[dict[str, Any]] = Field(None, description="JSON written to /work/input.json (max 256 KB).")
    browser: Optional[BrowserSpec] = None
    network: Optional[NetworkPolicy] = None
    permissions: Optional[Permissions] = None
    limits: Optional[Limits] = None
    metadata: Optional[dict[str, str]] = Field(None, description="Opaque caller tags (max 20 keys).")

    @model_validator(mode="after")
    def _check(self):
        if self.inputs is not None and len(json.dumps(self.inputs)) > 256_000:
            raise ValueError("inputs exceed 256 KB")
        if self.metadata is not None and (len(self.metadata) > 20 or any(len(k) > 64 or len(v) > 256 for k, v in self.metadata.items())):
            raise ValueError("metadata too large")
        if self.profile in ("python", "python-net") and not self.code:
            raise ValueError("code is required for python profiles")
        if self.profile in ("python", "python-net") and self.browser is not None:
            raise ValueError("browser spec requires the browser profile")
        if self.profile == "browser" and self.browser is None and not self.code:
            raise ValueError("browser profile requires a browser spec or code")
        if self.profile == "python" and self.network is not None:
            raise ValueError("the python profile has no network; use python-net")
        if self.profile in ("python-net", "browser"):
            if self.network is None or not (self.network.allowed_domains or self.network.allow_trusted_targets):
                raise ValueError("networked profiles require network.allowed_domains (default-deny egress)")
        if self.browser and self.browser.url and not re.match(r"^https?://", self.browser.url, re.I):
            raise ValueError("browser.url must be http(s)")
        return self


class RunRequest(Strict):
    """Compatibility contract used by the backend (POST /run)."""
    code: str = Field(..., max_length=100_000)
    timeout: int = Field(30, ge=1, le=120)
    network: bool = True


class ScreenshotRequest(Strict):
    """Compatibility contract used by the backend (POST /screenshot)."""
    url: str = Field(..., max_length=2048)
    full_page: bool = True
    timeout: int = Field(60, ge=5, le=180)

    @field_validator("url")
    @classmethod
    def _url(cls, v):
        if not re.match(r"^https?://", v, re.I):
            raise ValueError("url must be http(s)")
        return v
