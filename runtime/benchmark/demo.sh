#!/usr/bin/env bash
# Reproducible containment demo. Run on the VM as root:
#   runtime/benchmark/demo.sh          six core tests
#   runtime/benchmark/demo.sh --all    all twelve
set -euo pipefail
exec /opt/vultr-runtime/venv/bin/python "$(dirname "$0")/demo.py" "$@"
