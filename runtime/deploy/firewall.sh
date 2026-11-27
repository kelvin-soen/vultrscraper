#!/usr/bin/env bash
# Network containment rules for the Vultr Agent Runtime (idempotent).
#
#   10.250.0.0/16  per-job internal sandbox networks (one /24 per job)
#   10.251.0.0/24  egress network of the SSRF-filtering proxy
#
# Sandboxes may not reach the host or route anywhere outside their job
# network. The proxy may not reach private ranges, metadata endpoints or
# the host, except operator-pinned trusted targets (RUNTIME_TRUSTED_TARGETS,
# "ip:port,ip:port"). This is enforced in the kernel, independent of the
# proxy's own application-level checks.
set -euo pipefail

JOB_NETS="10.250.0.0/16"
EGRESS_NET="10.251.0.0/24"
TRUSTED="${RUNTIME_TRUSTED_TARGETS:-}"
FORBIDDEN="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
HOST_IPS=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1)

# ---- traffic addressed to the host itself (INPUT, ahead of ufw)
iptables -N VRT-INPUT 2>/dev/null || iptables -F VRT-INPUT
for t in ${TRUSTED//,/ }; do
  ip="${t%:*}"; port="${t##*:}"
  iptables -A VRT-INPUT -s "$EGRESS_NET" -d "$ip" -p tcp --dport "$port" -j ACCEPT
done
iptables -A VRT-INPUT -s "$JOB_NETS" -j DROP
iptables -A VRT-INPUT -s "$EGRESS_NET" -m conntrack --ctstate NEW -j DROP
iptables -C INPUT -j VRT-INPUT 2>/dev/null || iptables -I INPUT 1 -j VRT-INPUT

# ---- forwarded traffic (DOCKER-USER is evaluated before Docker's own rules)
iptables -N VRT-FORWARD 2>/dev/null || iptables -F VRT-FORWARD
for t in ${TRUSTED//,/ }; do
  ip="${t%:*}"; port="${t##*:}"
  # Trusted target published through Docker (DNAT): match the original destination.
  iptables -A VRT-FORWARD -s "$EGRESS_NET" -p tcp -m conntrack --ctorigdst "$ip" --ctorigdstport "$port" -j ACCEPT
done
iptables -A VRT-FORWARD -s "$JOB_NETS" ! -d "$JOB_NETS" -j DROP
for n in $FORBIDDEN; do
  iptables -A VRT-FORWARD -s "$EGRESS_NET" -d "$n" -j DROP
done
for h in $HOST_IPS; do
  iptables -A VRT-FORWARD -s "$EGRESS_NET" -d "$h" -j DROP
done
iptables -A VRT-FORWARD -j RETURN
iptables -C DOCKER-USER -j VRT-FORWARD 2>/dev/null || iptables -I DOCKER-USER 1 -j VRT-FORWARD

echo "vultr-runtime firewall applied (trusted targets: ${TRUSTED:-none})"
