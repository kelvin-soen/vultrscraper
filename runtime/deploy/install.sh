#!/usr/bin/env bash
# Build and (re)deploy the Vultr Agent Runtime on this host. Idempotent.
# Run as root from the repository:  sudo runtime/deploy/install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/vultr-runtime
CONF=/etc/vultr-runtime

command -v runsc >/dev/null || { echo "gVisor (runsc) is required: https://gvisor.dev/docs/user_guide/install/"; exit 1; }
docker info --format '{{json .Runtimes}}' | grep -q runsc || { echo "runsc is not registered with Docker (runsc install && systemctl reload docker)"; exit 1; }

echo "==> building images"
docker build -q -t vultr-runtime-sandbox:latest "$SRC/sandbox-image"
docker build -q -t vultr-runtime-egress-proxy:latest "$SRC/egress-proxy"

echo "==> installing controller to $DEST"
mkdir -p "$DEST"
rsync -a --delete --exclude benchmark/results "$SRC/controller" "$SRC/deploy" "$SRC/benchmark" "$SRC/client" "$DEST/"
chmod 0755 "$DEST/deploy/firewall.sh"
if [ ! -x "$DEST/venv/bin/python" ]; then
  python3 -m venv --without-pip "$DEST/venv"
fi
pip3 --python "$DEST/venv/bin/python" install -q -r "$DEST/controller/requirements.txt"

echo "==> configuration in $CONF"
install -d -m 0700 "$CONF"
install -d -m 0711 /var/lib/vultr-runtime
[ -f "$CONF/runtime.env" ] || install -m 0600 "$SRC/deploy/runtime.env.example" "$CONF/runtime.env"
# Synthetic credential in the controller environment, used only by the
# secret-hygiene benchmark to prove backend credentials never reach sandboxes.
grep -q '^VRT_SYNTHETIC_BACKEND_CREDENTIAL=' "$CONF/runtime.env" || \
  echo "VRT_SYNTHETIC_BACKEND_CREDENTIAL=SYNTHCRED-$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$CONF/runtime.env"
install -d -m 0755 /var/lib/vultr-runtime/bench-fixtures
cd "$DEST/controller"
set -a; . "$CONF/runtime.env"; set +a
if [ ! -f "$CONF/backend.key" ]; then
  umask 077
  "$DEST/venv/bin/python" -m app.keys add backend > "$CONF/backend.key"
  echo "    created API key for principal 'backend' in $CONF/backend.key"
fi
if [ ! -f "$CONF/benchmark.keys" ]; then
  umask 077
  { echo "BENCH_KEY=$("$DEST/venv/bin/python" -m app.keys add benchmark)";
    echo "BENCH_OTHER_KEY=$("$DEST/venv/bin/python" -m app.keys add benchmark-other)"; } > "$CONF/benchmark.keys"
fi

echo "==> systemd service"
install -m 0644 "$SRC/deploy/vultr-runtime.service" /etc/systemd/system/vultr-runtime.service
systemctl daemon-reload
systemctl enable -q vultr-runtime
systemctl restart vultr-runtime
for i in $(seq 1 30); do
  if curl -fsS "http://${RUNTIME_BIND}:${RUNTIME_PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://${RUNTIME_BIND}:${RUNTIME_PORT}/health" && echo
echo "==> done"
