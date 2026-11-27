#!/usr/bin/env python3
"""SSRF-hardened egress proxy for the Vultr Agent Runtime.

The only network path out of a networked sandbox. Every request must carry
per-job credentials (HMAC of the job id). For every request the proxy:

  1. checks the destination port and the job's domain allowlist,
  2. resolves DNS itself (sandboxes have no resolver),
  3. rejects the request if ANY resolved address is non-public
     (loopback, private, link-local, CGNAT, multicast, reserved,
     metadata endpoints, host addresses, IPv4-mapped/6to4/Teredo/NAT64
     embeddings of those),
  4. connects to the exact address it validated (no second lookup, so
     DNS rebinding cannot swap the destination).

Redirects and browser subrequests arrive as new proxy requests and are
checked again. Host firewall rules (deploy/firewall.sh) additionally drop
any packet from the proxy network to private ranges or the host itself.
"""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import time

LISTEN_HOST = os.environ.get("VRT_PROXY_LISTEN", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("VRT_PROXY_PORT", "3128"))
KEY_FILE = os.environ.get("VRT_PROXY_KEY_FILE", "/run/secrets/proxy_hmac")
POLICY_DIR = os.environ.get("VRT_POLICY_DIR", "/policies")
EVENT_DIR = os.environ.get("VRT_EVENT_DIR", "/events")
ALLOWED_PORTS = {int(p) for p in os.environ.get("VRT_ALLOWED_PORTS", "80,443").split(",") if p}
MAX_HEADER = 32 * 1024
CONNECT_TIMEOUT = 10
IDLE_TIMEOUT = 60
MAX_CONNS_PER_JOB = 32
MAX_BYTES_PER_JOB = 256 * 1024 * 1024
MAX_EVENTS_PER_JOB = 2000

# Well-known metadata endpoints, blocked explicitly in addition to the range checks.
METADATA_IPS = {"169.254.169.254", "169.254.170.2", "100.100.100.200", "192.0.0.192", "fd00:ec2::254"}
EXTRA_BLOCKED = METADATA_IPS | {ip.strip() for ip in os.environ.get("VRT_BLOCKED_IPS", "").split(",") if ip.strip()}
# Operator-pinned exceptions "ip:port" (e.g. the team's demo site on the host).
# Only used by jobs whose policy sets allow_trusted_targets.
TRUSTED_TARGETS = set()
for t in os.environ.get("VRT_TRUSTED_TARGETS", "").split(","):
    t = t.strip()
    if t:
        ip, _, port = t.rpartition(":")
        TRUSTED_TARGETS.add((str(ipaddress.ip_address(ip.strip("[]"))), int(port)))

JOB_RE = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")
NAT64 = ipaddress.ip_network("64:ff9b::/96")

with open(KEY_FILE, "rb") as fh:
    KEY = fh.read().strip()

conn_count = {}
byte_count = {}
event_count = {}


def token_for(job_id):
    return hmac.new(KEY, job_id.encode(), hashlib.sha256).hexdigest()[:48]


# ---------------------------------------------------------------- IP policy
def ip_block_reason(ip_str):
    """Return why an address is forbidden, or None if it is a public address."""
    try:
        ip = ipaddress.ip_address(ip_str.split("%")[0])
    except ValueError:
        return "unparseable-address"
    if ip.version == 6:
        if ip.ipv4_mapped:
            r = ip_block_reason(str(ip.ipv4_mapped))
            return f"ipv4-mapped:{r}" if r else None
        if ip.sixtofour:
            r = ip_block_reason(str(ip.sixtofour))
            if r:
                return f"6to4:{r}"
        if ip.teredo:
            return "teredo"
        if ip in NAT64:
            r = ip_block_reason(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
            if r:
                return f"nat64:{r}"
    if str(ip) in EXTRA_BLOCKED:
        return "metadata-or-host-address"
    if ip.is_unspecified:
        return "unspecified"
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link-local"
    if ip.is_multicast:
        return "multicast"
    if ip.is_private:
        return "private-network"
    if ip.is_reserved:
        return "reserved"
    if not ip.is_global:
        return "non-global"
    return None


def domain_allowed(host, allowed):
    host = host.lower().rstrip(".")
    for pat in allowed:
        pat = pat.lower().rstrip(".")
        if pat == "*":
            return True
        if pat.startswith("*."):
            if host.endswith(pat[1:]) and host != pat[2:]:
                return True
        elif host == pat:
            return True
    return False


def is_ip_literal(host):
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        return False


# ------------------------------------------------------------------- events
def log_event(job_id, **ev):
    ev["ts"] = time.time()
    line = json.dumps(ev, default=str)
    print(json.dumps({"job": job_id, **ev}, default=str), flush=True)
    if not job_id or not JOB_RE.match(job_id):
        return
    n = event_count.get(job_id, 0)
    if n >= MAX_EVENTS_PER_JOB:
        return
    event_count[job_id] = n + 1
    try:
        with open(os.path.join(EVENT_DIR, f"{job_id}.jsonl"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_policy(job_id):
    try:
        with open(os.path.join(POLICY_DIR, f"{job_id}.json"), encoding="utf-8") as f:
            pol = json.load(f)
    except (OSError, ValueError):
        return None
    if pol.get("expires_at", 0) < time.time():
        return None
    return pol


# ------------------------------------------------------------------ helpers
async def respond(writer, code, reason, extra_headers=None, body=b""):
    hdrs = [f"HTTP/1.1 {code} {reason}", "Connection: close", f"Content-Length: {len(body)}",
            "Content-Type: text/plain; charset=utf-8"]
    hdrs += extra_headers or []
    writer.write(("\r\n".join(hdrs) + "\r\n\r\n").encode() + body)
    try:
        await writer.drain()
    except ConnectionError:
        pass


async def block(writer, job_id, reason, **info):
    log_event(job_id, action="blocked", reason=reason, **info)
    await respond(writer, 403, "Forbidden", [f"X-VRT-Blocked: {reason}"],
                  f"blocked by sandbox egress policy: {reason}\n".encode())


async def pipe(reader, writer, job_id):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), timeout=IDLE_TIMEOUT)
            if not data:
                break
            byte_count[job_id] = byte_count.get(job_id, 0) + len(data)
            if byte_count[job_id] > MAX_BYTES_PER_JOB:
                log_event(job_id, action="blocked", reason="egress-byte-budget-exceeded")
                break
            writer.write(data)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


def parse_auth(headers):
    val = headers.get("proxy-authorization", "")
    if not val.lower().startswith("basic "):
        return None
    try:
        user, _, pw = base64.b64decode(val[6:].strip()).decode().partition(":")
    except Exception:  # noqa: BLE001
        return None
    if not JOB_RE.match(user) or not hmac.compare_digest(pw, token_for(user)):
        return None
    return user


# ------------------------------------------------------------------ handler
async def handle(reader, writer):
    job_id = None
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
        writer.close()
        return
    try:
        lines = head.decode("latin-1").split("\r\n")
        method, target, _version = lines[0].split(" ", 2)
        headers = {}
        raw_headers = []
        for ln in lines[1:]:
            if not ln:
                continue
            k, _, v = ln.partition(":")
            headers[k.strip().lower()] = v.strip()
            raw_headers.append((k.strip(), v.strip()))
    except ValueError:
        await respond(writer, 400, "Bad Request")
        writer.close()
        return

    job_id = parse_auth(headers)
    if not job_id:
        await respond(writer, 407, "Proxy Authentication Required", ['Proxy-Authenticate: Basic realm="vrt"'])
        writer.close()
        return

    policy = load_policy(job_id)
    if policy is None:
        await block(writer, job_id, "no-active-policy", target=target[:300])
        writer.close()
        return

    # Destination parsing
    if method.upper() == "CONNECT":
        hostport = target
        path = None
    else:
        m = re.match(r"^http://([^/?#]+)(.*)$", target, re.I)
        if not m:
            await block(writer, job_id, "unsupported-request-target", target=target[:300])
            writer.close()
            return
        hostport, path = m.group(1), m.group(2) or "/"
        if "@" in hostport:
            hostport = hostport.rsplit("@", 1)[1]
    if hostport.startswith("["):
        host, _, rest = hostport[1:].partition("]")
        port = int(rest[1:]) if rest.startswith(":") and rest[1:].isdigit() else (443 if path is None else 80)
    else:
        host, sep, p = hostport.rpartition(":")
        if not sep or not p.isdigit():
            host, port = hostport, (443 if path is None else 80)
        else:
            port = int(p)
    host = host.strip().lower().rstrip(".")
    info = {"method": method, "host": host[:253], "port": port}

    if not host or len(host) > 253:
        await block(writer, job_id, "invalid-host", **info)
        writer.close()
        return

    trusted = False
    if policy.get("allow_trusted_targets") and is_ip_literal(host):
        trusted = (str(ipaddress.ip_address(host.strip("[]"))), port) in TRUSTED_TARGETS

    if not trusted:
        if port not in ALLOWED_PORTS:
            await block(writer, job_id, "port-not-allowed", **info)
            writer.close()
            return
        if not domain_allowed(host, policy.get("allowed_domains", [])) and not (
                is_ip_literal(host) and "*" in policy.get("allowed_domains", [])):
            await block(writer, job_id, "domain-not-in-allowlist", **info)
            writer.close()
            return

    if conn_count.get(job_id, 0) >= MAX_CONNS_PER_JOB:
        await block(writer, job_id, "connection-limit", **info)
        writer.close()
        return

    # Resolve once, validate every address, connect to a validated address.
    try:
        infos = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(
            host.strip("[]"), port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP), timeout=5)
        addrs = []
        for fam, _t, _p, _c, sa in infos:
            if sa[0] not in addrs:
                addrs.append(sa[0])
    except (OSError, asyncio.TimeoutError) as e:
        log_event(job_id, action="error", reason="dns-resolution-failed", error=str(e)[:200], **info)
        await respond(writer, 502, "Bad Gateway", ["X-VRT-Error: dns-resolution-failed"])
        writer.close()
        return
    info["resolved"] = addrs[:8]
    if not trusted:
        for a in addrs:
            r = ip_block_reason(a)
            if r:
                await block(writer, job_id, f"forbidden-destination:{r}", **info)
                writer.close()
                return
    v4 = [a for a in addrs if ":" not in a]
    dest = (v4 or addrs)[0]

    conn_count[job_id] = conn_count.get(job_id, 0) + 1
    try:
        try:
            up_r, up_w = await asyncio.wait_for(asyncio.open_connection(dest, port), timeout=CONNECT_TIMEOUT)
        except (OSError, asyncio.TimeoutError) as e:
            log_event(job_id, action="error", reason="upstream-connect-failed", error=str(e)[:200],
                      connected_ip=dest, **info)
            await respond(writer, 502, "Bad Gateway", ["X-VRT-Error: upstream-connect-failed"])
            writer.close()
            return
        log_event(job_id, action="allowed", connected_ip=dest, trusted_target=trusted, **info)
        if path is None:
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
        else:
            out = [f"{method} {path} HTTP/1.1"]
            for k, v in raw_headers:
                if k.lower() in ("proxy-authorization", "proxy-connection", "connection", "keep-alive"):
                    continue
                out.append(f"{k}: {v}")
            out.append("Connection: close")
            up_w.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
            await up_w.drain()
        await asyncio.gather(pipe(reader, up_w, job_id), pipe(up_r, writer, job_id))
    finally:
        conn_count[job_id] = max(0, conn_count.get(job_id, 1) - 1)
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


async def main():
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT, limit=MAX_HEADER)
    print(json.dumps({"event": "proxy-started", "port": LISTEN_PORT, "trusted_targets": sorted(TRUSTED_TARGETS),
                      "allowed_ports": sorted(ALLOWED_PORTS)}), flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
