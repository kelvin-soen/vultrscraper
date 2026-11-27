"""Lightweight Python client for the Vultr Agent Runtime (stdlib only).

    from runtime_client import RuntimeClient
    rt = RuntimeClient("http://127.0.0.1:8001", api_key=os.environ["RUNTIME_API_KEY"])

    # Run generated scraper code with egress to the demo shop only
    res = rt.run_python(code, network=True, allowed_domains=[], allow_trusted_targets=True)
    print(res["status"], res["stdout"])

    # Screenshot + HTML of a page
    shot = rt.browse("https://example.com", allowed_domains=["example.com"])
    png = rt.artifact(shot["job_id"], "screenshot.png")
"""
import json
import time
import urllib.error
import urllib.request


class RuntimeError_(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body}")
        self.status, self.body = status, body


class RuntimeClient:
    def __init__(self, base_url="http://127.0.0.1:8001", api_key=None, timeout=30):
        self.base = base_url.rstrip("/")
        self.key = api_key
        self.timeout = timeout

    # ------------------------------------------------------------- http
    def _req(self, method, path, body=None, raw=False, timeout=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.key:
            req.add_header("Authorization", f"Bearer {self.key}")
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                payload = r.read()
                return payload if raw else json.loads(payload or b"null")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                text = json.loads(text)
            except ValueError:
                pass
            raise RuntimeError_(e.code, text) from None

    # -------------------------------------------------------------- api
    def health(self):
        return self._req("GET", "/health")

    def submit(self, job: dict):
        return self._req("POST", "/v1/jobs", job)

    def job(self, job_id):
        return self._req("GET", f"/v1/jobs/{job_id}")

    def result(self, job_id):
        return self._req("GET", f"/v1/jobs/{job_id}/result")

    def artifacts(self, job_id):
        return self._req("GET", f"/v1/jobs/{job_id}/artifacts")

    def artifact(self, job_id, name) -> bytes:
        return self._req("GET", f"/v1/jobs/{job_id}/artifacts/{name}", raw=True)

    def cancel(self, job_id):
        return self._req("DELETE", f"/v1/jobs/{job_id}")

    def wait(self, job_id, timeout=300, poll=0.5):
        end = time.time() + timeout
        while time.time() < end:
            j = self.job(job_id)
            if j["status"] in ("succeeded", "failed", "timeout", "cancelled", "error"):
                return self.result(job_id)
            time.sleep(poll)
        raise TimeoutError(f"job {job_id} did not finish in {timeout}s")

    def run(self, job: dict, timeout=300):
        return self.wait(self.submit(job)["id"], timeout=timeout)

    # ---------------------------------------------------------- helpers
    def run_python(self, code, network=False, allowed_domains=None, allow_trusted_targets=False,
                   test_code=None, inputs=None, timeout_s=30):
        job = {"profile": "python-net" if network else "python", "code": code, "limits": {"timeout_s": timeout_s}}
        if network:
            job["network"] = {"allowed_domains": allowed_domains or [], "allow_trusted_targets": allow_trusted_targets}
        if test_code:
            job["test_code"] = test_code
        if inputs is not None:
            job["inputs"] = inputs
        return self.run(job, timeout=timeout_s + 90)

    def browse(self, url, allowed_domains, actions=None, allow_trusted_targets=False, timeout_s=60,
               screenshot=True, full_page=True):
        job = {"profile": "browser",
               "browser": {"url": url, "actions": actions or [], "screenshot": screenshot, "full_page": full_page},
               "network": {"allowed_domains": allowed_domains, "allow_trusted_targets": allow_trusted_targets},
               "limits": {"timeout_s": timeout_s}}
        return self.run(job, timeout=timeout_s + 120)
