"""Central config. Loads /root/app/.env (secrets) once."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

VULTR_BASE_URL = "https://api.vultrinference.com/v1"
# Benchmarked 2026-11-27 (write /shop, fix ?v=2, rendered Clas Ohlson; 2 runs each):
# glm-5.3-flash 6/6 working in 0.7-16 s; glm-5.3 5/6, up to 89 s and one 120 s timeout.
CODE_MODEL = "glm-5.3-flash"
CODE_FALLBACK_MODEL = "glm-5.3"  # tried once if the primary fails or times out
# Benchmarked 2026-11-27 on real shop + Clas Ohlson screenshots (12 runs each):
# qwen3.8-flash-next 12/12 correct in 2-9 s; nemotron with reasoning 9/12, 10-95 s
# (reasoning runaway); nemotron with reasoning off 10/12 in 1-2 s.
VISION_MODEL = "qwen3.8-flash-next"
# Used once if the primary vision model errors, times out or gives no usable answer.
VISION_FALLBACK_MODEL = "nemotron-3-nano-omni-30b-a3b-reasoning"
VISION_FALLBACK_EXTRA = {"reasoning": {"enabled": False}}
VISION_TIMEOUT_S = 60  # per vision call (primary and fallback each)
CODE_MAX_TOKENS = 16000  # reasoning model: must be >= 4000
VISION_MAX_TOKENS = 16000
AI_TIMEOUT_S = 120  # hard limit per AI call (incl. one retry on empty content)
AI_HTML_CHARS = 60000  # page HTML sent to the code model, after cleaning

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
