#!/usr/bin/env python3
"""DEVELOPMENT ONLY: serve frontend/ and forward /api/* to a running backend.

Lets you work on the frontend locally against the real backend (real jobs, real
sandbox, real models) without deploying anything:

    python3 frontend/dev/proxy.py --backend http://70.34.217.56:8000 --port 5173

Only GET and POST on /api/* are forwarded; nothing else leaves this machine.
Stdlib only.
"""
import argparse
import http.server
import os
import urllib.error
import urllib.request

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_handler(backend: str):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=FRONTEND, **kw)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _forward(self, method: str):
            body = None
            if method == "POST":
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            req = urllib.request.Request(backend + self.path, data=body, method=method,
                                         headers={"Content-Type": "application/json",
                                                  "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    status, data = r.status, r.read()
            except urllib.error.HTTPError as e:
                status, data = e.code, e.read()
            except Exception as e:  # backend down: report as 502, like a real proxy
                status, data = 502, ('{"detail": "backend unreachable: %s"}' % type(e).__name__).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith("/api/"):
                return self._forward("GET")
            return super().do_GET()

        def do_POST(self):
            if self.path.startswith("/api/"):
                return self._forward("POST")
            self.send_error(405)

        def log_message(self, fmt, *args):
            if self.path.startswith("/api/") and "GET /api/jobs/" in (fmt % args):
                return  # polling noise
            super().log_message(fmt, *args)

    return Handler


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="http://127.0.0.1:8000")
    ap.add_argument("--port", type=int, default=5173)
    a = ap.parse_args()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(a.backend.rstrip("/")))
    print(f"frontend on http://127.0.0.1:{a.port}  ->  /api/* forwarded to {a.backend}")
    srv.serve_forever()
