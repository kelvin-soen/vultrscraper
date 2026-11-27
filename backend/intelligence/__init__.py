"""siftform. intelligence layer.

Isolated modules that run AFTER an extraction has been verified. They never change
extracted values; they add a separate, explainable layer on top:

- registry.py     versioned scrapers with saved extraction schemas and verification criteria
- history.py      historical observations per site and product
- categories.py   product category inference + reference price bands (domain priors)
- quality.py      deterministic data-quality checks, dataset statistics, anomaly signals
- investigate.py  bounded investigation of flagged records (contained research + AI reasoning)
- dashboard.py    declarative dashboard specification for the frontend (no executable code)
- pipeline.py     orchestration: analyze(job, html) -> job["intelligence"]
- api.py          additive FastAPI routes (/api/intel/...)

Two lanes are kept strictly apart:
  extraction verification  "is this value really what the page says?"  (verify.py + quality checks)
  semantic plausibility    "is what the page says believable?"          (signals + investigation)
"""

SCHEMA_VERSION = 1
