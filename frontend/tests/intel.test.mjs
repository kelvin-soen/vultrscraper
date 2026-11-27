import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIntel, validateSpec, fallbackViews, BLOCK_TYPES } from "../js/model/intel.js";
import { normalizeJob } from "../js/model/job.js";
import { ANOMALY_FIXTURE } from "../dev/intel-fixture.js";

test("spec validation keeps only whitelisted blocks and the three views", () => {
  const views = validateSpec({
    spec_version: 1,
    views: [
      { id: "overview", blocks: [{ type: "kpis", items: [] }, { type: "script", src: "x.js" }, { type: "chart", kind: "pie" }, { type: "chart", kind: "price_strip", points: [] }] },
      { id: "evil", blocks: [{ type: "kpis" }] },
    ],
  });
  assert.deepEqual(views.map((v) => v.id), ["overview", "data", "agent"]);
  assert.deepEqual(views[0].blocks.map((b) => b.type + (b.kind ? `:${b.kind}` : "")), ["kpis", "chart:price_strip"]);
  assert.equal(views[1].blocks.length, 0);
  assert.deepEqual(validateSpec({ spec_version: 2, views: [{ id: "overview", blocks: [{ type: "kpis" }] }] })[0].blocks, []);
});

test("fixture intelligence normalises: findings, flags, lanes", () => {
  const intel = normalizeIntel(ANOMALY_FIXTURE.intelligence);
  assert.equal(intel.status, "done");
  assert.deepEqual(intel.findings.map((f) => f.name), ["Stealth 2 Driver", "Circle T Tour Rat Putter"]);
  const driver = intel.findings[0];
  assert.equal(driver.original, 64950);
  assert.equal(driver.valueChanged, false);
  assert.equal(driver.assessment, "likely_source_error");
  assert.equal(driver.suggested, 6495);
  assert.ok(intel.flagged.has(0) && intel.flagged.has(10));
  assert.ok(intel.checks.some((c) => c.lane === "extraction") && intel.checks.some((c) => c.lane === "plausibility"));
  for (const v of intel.views) for (const b of v.blocks) assert.ok(BLOCK_TYPES.has(b.type));
});

test("unknown assessment words never show as a confident verdict", () => {
  const intel = normalizeIntel({ status: "done", findings: [{ id: "F1", assessment: "definitely_fine", confidence: "certain", evidence: [] }] });
  assert.equal(intel.findings[0].assessment, "inconclusive");
  assert.equal(intel.findings[0].confidence, "low");
});

test("analyze stage appears only when the backend reports intelligence", () => {
  const base = { status: "running", url: "http://x.test/", attempts: [{ n: 1, code: "x", stdout: "[]", exit_code: 0, verdict: "pass" }], results: [] };
  assert.ok(!normalizeJob(base).stages.some((s) => s.key === "analyze"));
  const running = normalizeJob({ ...base, phase: "analyzing", intelligence: { status: "running" } });
  assert.equal(running.stages.find((s) => s.key === "analyze").status, "active");
  const failed = normalizeJob({ ...base, status: "done", intelligence: { status: "error", error: "boom" } });
  assert.equal(failed.stages.find((s) => s.key === "analyze").status, "skipped");
});

test("fallback views never claim plausibility checks", () => {
  const job = normalizeJob({ status: "done", url: "http://x.test/", attempts: [{ n: 1, code: "x", stdout: "[]", exit_code: 0, verdict: "pass" }], results: [{ name: "a", price_sek: 10 }, { name: "b", price_sek: 20 }, { name: "c", price_sek: 30 }] });
  const views = fallbackViews(job);
  const types = views[0].blocks.map((b) => b.type);
  assert.ok(!types.includes("anomalies"));
  assert.ok(types.includes("quality"));
  assert.ok(views[0].blocks.find((b) => b.type === "chart").points.every((p) => p.flagged === false));
});
