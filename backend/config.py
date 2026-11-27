"""Central config. Loads /root/app/.env (secrets) once."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

VULTR_BASE_URL = "https://api.vultrinference.com/v1"
CODE_MODEL = "glm-5.3"
# Tested 2026-11-27: nemotron reads image text correctly. clef-omni rejects chat
# completions ("decision model; use /v1/systemone").
VISION_MODEL = "nemotron-3-nano-omni-30b-a3b-reasoning"
CODE_MAX_TOKENS = 8000  # reasoning model: must be >= 4000
VISION_MAX_TOKENS = 8000

SANDBOX_URL = os.getenv("SANDBOX_URL", "http://localhost:8001")
MOCK_SANDBOX = os.getenv("MOCK_SANDBOX", "0") == "1"

MAX_ATTEMPTS = 3


def sandbox_key() -> str:
    """Runtime API key: env SANDBOX_API_KEY, else /etc/vultr-runtime/backend.key.
    Never log it, put it in prompts, or pass it into sandboxed code."""
    key = os.getenv("SANDBOX_API_KEY", "").strip()
    if not key:
        try:
            key = Path("/etc/vultr-runtime/backend.key").read_text().strip()
        except OSError:
            key = ""
    if not key:
        raise RuntimeError("runtime API key missing (SANDBOX_API_KEY or /etc/vultr-runtime/backend.key)")
    return key


def inference_key() -> str:
    key = os.getenv("VULTR_INFERENCE_KEY", "").strip()
    if not key:
        raise RuntimeError("VULTR_INFERENCE_KEY is not set (check /root/app/.env)")
    return key
