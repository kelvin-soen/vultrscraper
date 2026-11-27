"""Export the OpenAPI contract from the FastAPI app: python export_openapi.py ../openapi.yaml"""
import json
import sys

import yaml

from app.main import app

spec = app.openapi()
spec["components"]["securitySchemes"] = {"bearerAuth": {"type": "http", "scheme": "bearer"}}
for path, ops in spec["paths"].items():
    for op in ops.values():
        if path != "/health":
            op["security"] = [{"bearerAuth": []}]
            op.setdefault("responses", {})["401"] = {"description": "Missing or invalid API key"}
out = sys.argv[1] if len(sys.argv) > 1 else "../openapi.yaml"
with open(out, "w") as f:
    if out.endswith(".json"):
        json.dump(spec, f, indent=2)
    else:
        yaml.safe_dump(spec, f, sort_keys=False, allow_unicode=True)
print(f"wrote {out}")
