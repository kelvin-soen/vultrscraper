"""End-to-end example of the backend's self-healing scraper loop against the runtime.

    RUNTIME_API_KEY=$(sudo cat /etc/vultr-runtime/backend.key) python scraper_flow.py http://70.34.217.56:8080/shop

The LLM call is stubbed out: inference stays in the backend (Vultr Serverless
Inference) and the runtime never sees model credentials.
"""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from runtime_client import RuntimeClient  # noqa: E402

URL = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
rt = RuntimeClient(os.environ.get("RUNTIME_URL", "http://127.0.0.1:8001"), api_key=os.environ["RUNTIME_API_KEY"])
host_is_demo = URL.startswith("http://70.34.217.56:8080")
net = {"allowed_domains": [] if host_is_demo else [URL.split("/")[2]], "allow_trusted_targets": host_is_demo}

# 1. Fetch HTML + screenshot in the sandboxed browser.
page = rt.run({"profile": "browser", "browser": {"url": URL}, "network": net})
html = rt.artifact(page["job_id"], "page.html").decode("utf-8", "replace") if page["status"] == "succeeded" else ""
print("page:", page["status"], page["browser"]["status"], len(html), "bytes of HTML")

# 2. (backend) Ask the model for a scraper. Treat `html` as untrusted data in the prompt.
scraper = f"""
import json, requests
from bs4 import BeautifulSoup
from vrt_sandbox import write_result
soup = BeautifulSoup(requests.get({URL!r}, timeout=15).text, "html.parser")
items = [{{"name": soup.title.text.strip() if soup.title else "", "price_sek": 0}}]
write_result(items)
print(json.dumps(items))
"""

# 3. Run the generated scraper with validation tests.
tests = """
import json
def test_shape():
    data = json.load(open('/work/output/result.json'))
    assert isinstance(data, list) and all({'name', 'price_sek'} <= set(d) for d in data)
"""
res = rt.run({"profile": "python-net", "code": scraper, "test_code": tests, "network": net,
              "limits": {"timeout_s": 30}})
print("scraper:", res["status"], "tests passed:", (res["tests"] or {}).get("passed"))
print("output:", json.dumps(res["output"]))
print("telemetry:", json.dumps({k: res["telemetry"][k] for k in ("container_id", "duration_ms", "memory_peak_bytes",
                                                                  "egress", "cleanup")}, default=str)[:400])

# 4. Save the screenshot for the vision check.
if page["status"] == "succeeded":
    png = rt.artifact(page["job_id"], "screenshot.png")
    print("screenshot (base64, for the vision model):", base64.b64encode(png)[:60].decode(), "...")
