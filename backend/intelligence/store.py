"""Tiny JSON file store with atomic writes. One file per collection.

Location: env INTEL_DATA_DIR, default backend/data/intel/. Tests point it at a temp dir.
"""
import json
import os
import tempfile
import threading
from pathlib import Path

_DEFAULT_DIR = Path(__file__).resolve().parent.parent / "data" / "intel"


def data_dir() -> Path:
    d = Path(os.getenv("INTEL_DATA_DIR") or _DEFAULT_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


class JsonStore:
    """Load-modify-save under one lock. Small data (demo scale), so whole-file writes are fine."""

    def __init__(self, name: str, directory: Path | None = None):
        self.name = name
        self._dir = Path(directory) if directory else None
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        d = self._dir or data_dir()
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{self.name}.json"

    def load(self) -> dict:
        with self._lock:
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return {}

    def save(self, data: dict) -> None:
        with self._lock:
            path = self.path
            fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{self.name}.", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=1)
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)

    def update(self, fn):
        """fn(data) mutates data in place and may return a value, which is passed through."""
        with self._lock:
            data = self.load()
            out = fn(data)
            self.save(data)
            return out
