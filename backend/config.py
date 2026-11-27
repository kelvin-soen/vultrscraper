"""Central config. Loads /root/app/.env (secrets) once."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

VULTR_BASE_URL = "https://api.vultrinference.com/v1"
CODE_MODEL = "glm-5.3"
VISION_MODEL = "clef-omni"  # untested; fallback: nemotron-3-nano-omni-30b-a3b-reasoning
CODE_MAX_TOKENS = 8000  # reasoning model: must be >= 4000

SANDBOX_URL = os.getenv("SANDBOX_URL", "http://localhost:8001")
MOCK_SANDBOX = os.getenv("MOCK_SANDBOX", "0") == "1"

MAX_ATTEMPTS = 3


def inference_key() -> str:
    key = os.getenv("VULTR_INFERENCE_KEY", "").strip()
    if not key:
        raise RuntimeError("VULTR_INFERENCE_KEY is not set (check /root/app/.env)")
    return key
