"""Manage runtime API keys (stored as SHA-256 hashes only).

    python -m app.keys add <principal>      # prints the new key once
    python -m app.keys list
    python -m app.keys disable <principal>
"""
import hashlib
import json
import os
import secrets
import sys

from .config import settings


def _load():
    try:
        with open(settings.api_keys_file) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"keys": []}


def _save(data):
    os.makedirs(settings.config_dir, exist_ok=True)
    tmp = settings.api_keys_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, settings.api_keys_file)


def main(argv):
    if len(argv) < 1:
        print(__doc__)
        return 2
    data = _load()
    cmd = argv[0]
    if cmd == "add" and len(argv) == 2:
        key = "vrt_" + secrets.token_urlsafe(32)
        data["keys"].append({"principal": argv[1], "sha256": hashlib.sha256(key.encode()).hexdigest()})
        _save(data)
        print(key)
    elif cmd == "list":
        for k in data["keys"]:
            print(k["principal"], "disabled" if k.get("disabled") else "active")
    elif cmd == "disable" and len(argv) == 2:
        for k in data["keys"]:
            if k["principal"] == argv[1]:
                k["disabled"] = True
        _save(data)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
