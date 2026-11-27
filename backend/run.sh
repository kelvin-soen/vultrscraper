#!/usr/bin/env bash
# Start the backend on port 8000.  Usage: ./run.sh   (MOCK_SANDBOX=1 ./run.sh for mock sandbox)
set -euo pipefail
cd "$(dirname "$0")"
export MOCK_SANDBOX="${MOCK_SANDBOX:-0}"
exec .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 "$@"
