"""In-memory ring buffer of security events plus an append-only JSONL log."""
import collections
import json
import os
import threading
import time

from .config import settings

_lock = threading.Lock()
_events = collections.deque(maxlen=5000)
_seq = [0]


def security_event(kind, principal=None, job_id=None, detail=None):
    with _lock:
        _seq[0] += 1
        ev = {"seq": _seq[0], "ts": time.time(), "kind": kind, "principal": principal,
              "job_id": job_id, "detail": detail or {}}
        _events.append(ev)
    try:
        os.makedirs(settings.data_dir, exist_ok=True)
        with open(os.path.join(settings.data_dir, "security-events.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(ev, default=str) + "\n")
    except OSError:
        pass
    return ev


def list_events(principal=None, since_seq=0, limit=200):
    with _lock:
        evs = [e for e in _events if e["seq"] > since_seq and (principal is None or e["principal"] == principal)]
    return evs[-limit:]
