"""API key authentication. Keys are stored only as SHA-256 hashes in
/etc/vultr-runtime/api_keys.json: {"keys": [{"principal": "backend", "sha256": "..."}]}.
Create keys with:  python -m app.keys add <principal>"""
import hashlib
import hmac
import json
import os
import threading
import time

from fastapi import Header, HTTPException, Request

from .config import settings
from .events import security_event

_lock = threading.Lock()
_cache = {"mtime": None, "keys": []}


def _load():
    path = settings.api_keys_file
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return []
    with _lock:
        if _cache["mtime"] != mtime:
            with open(path, encoding="utf-8") as f:
                _cache["keys"] = json.load(f).get("keys", [])
            _cache["mtime"] = mtime
        return _cache["keys"]


def principal_for(key: str):
    if not key or len(key) > 256:
        return None
    digest = hashlib.sha256(key.encode()).hexdigest()
    found = None
    for entry in _load():
        if hmac.compare_digest(digest, entry.get("sha256", "")) and not entry.get("disabled"):
            found = entry["principal"]
    return found


def require_principal(request: Request, authorization: str = Header(None), x_api_key: str = Header(None)):
    key = None
    if authorization and authorization.lower().startswith("bearer "):
        key = authorization[7:].strip()
    elif x_api_key:
        key = x_api_key.strip()
    principal = principal_for(key) if key else None
    if not principal:
        security_event("auth_rejected", principal=None, detail={
            "path": request.url.path, "method": request.method,
            "reason": "missing credentials" if not key else "invalid credentials",
            "client": request.client.host if request.client else None, "ts": time.time()})
        raise HTTPException(status_code=401, detail="invalid or missing API key",
                            headers={"WWW-Authenticate": "Bearer"})
    return principal
