import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeJob, normalizeVerdict, screenshotSrc, parseOutput } from "../js/model/job.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const ROWS = [
  { name: "Kaffe 500g", price_sek: 79 },
  { name: "Mjolk 1l", price_sek: 18 },
];
const attempt = (o = {}) => ({ n: 1, code: "print(1)", stdout: "", stderr: "", exit_code: null, verdict: "pending", reason: "", ...o });
const stage = (job, key) => job.stages.find((s) => s.key === key);

test("verdict vocabulary is normalized conservatively", () => {
  for (const v of ["ok", "PASS", "match", "verified", true]) assert.equal(normalizeVerdict(v), "verified");
  for (const v of ["fail", "mismatch", "wrong", "rejected", false]) assert.equal(normalizeVerdict(v), "rejected");
  for (const v of ["pending", "", null, undefined]) assert.equal(normalizeVerdict(v), "pending");
  assert.equal(normalizeVerdict("looks plausible"), "unknown");
});

test("empty running job: nothing is marked complete", () => {
  const job = normalizeJob({ status: "running", attempts: [], results: [], screenshot_base64: null }, { url: "https://x.se" });
  assert.equal(job.status, "running");
  assert.equal(job.stages.filter((s) => s.status === "done").length, 0);
  assert.equal(job.stages.filter((s) => s.status === "active").length, 1);
  assert.equal(stage(job, "access").status, "active");
  assert.equal(job.outcome.kind, "running");
});

test("screenshot only: access + capture done, generate active", () => {
  const job = normalizeJob({ status: "running", attempts: [], screenshot_base64: PNG });
  assert.equal(stage(job, "access").status, "done");
  assert.equal(stage(job, "capture").status, "done");
  assert.equal(stage(job, "generate").status, "active");
  assert.match(job.screenshot, /^data:image\/png;base64,/);
});

test("current backend step 1 (generated, not run) is not shown as verified", () => {
  const job = normalizeJob({
    status: "done",
    attempts: [attempt({ reason: "generated (not run yet)" })],
    results: [],
    screenshot_base64: PNG,
  });
  assert.equal(stage(job, "generate").status, "done");
  assert.equal(stage(job, "execute").status, "skipped");
  assert.equal(stage(job, "verify").status, "skipped");
  assert.equal(job.outcome.kind, "unverified");
  assert.equal(job.outcome.label, "Not executed");
});

test("happy path: verified on first attempt", () => {
  const job = normalizeJob({
    status: "done",
    attempts: [attempt({ stdout: JSON.stringify(ROWS), exit_code: 0, verdict: "ok", reason: "match" })],
    results: ROWS,
    screenshot_base64: PNG,
  });
  assert.equal(job.outcome.kind, "verified");
  assert.equal(stage(job, "extract").detail, "2 records found.");
  assert.equal(stage(job, "verify").status, "done");
  assert.equal(stage(job, "repair"), undefined, "no repair stage when nothing failed");
  assert.equal(job.repairs.length, 0);
});

test("self-healing: failed attempt then verified repair", () => {
  const job = normalizeJob({
    status: "done",
    attempts: [
      attempt({ stdout: "[]", exit_code: 0, verdict: "fail", reason: "0 items" }),
      attempt({ n: 2, stdout: JSON.stringify(ROWS), exit_code: 0, verdict: "ok" }),
    ],
    results: ROWS,
  });
  assert.equal(job.outcome.kind, "repaired");
  assert.equal(stage(job, "repair").status, "done");
  assert.equal(job.repairs.length, 1);
  assert.equal(job.repairs[0].state, "repaired");
  assert.deepEqual(
    job.repairs[0].steps.map((s) => s.status),
    ["failed", "done", "done", "done", "done"]
  );
  assert.equal(job.repairs[0].steps[0].detail, "0 items");
});

test("self-healing in progress: investigating while waiting for new code", () => {
  const job = normalizeJob({
    status: "running",
    attempts: [attempt({ stdout: "[]", exit_code: 0, verdict: "fail", reason: "0 items" })],
  });
  assert.equal(stage(job, "repair").status, "active");
  assert.equal(job.repairs.length, 1);
  const statuses = job.repairs[0].steps.map((s) => s.status);
  assert.deepEqual(statuses, ["failed", "active", "pending", "pending", "pending"]);
});

test("failed repair after max attempts", () => {
  const job = normalizeJob({
    status: "failed",
    error: "Maximum attempts reached",
    attempts: [
      attempt({ stdout: "[]", exit_code: 0, verdict: "fail" }),
      attempt({ n: 2, exit_code: 1, stderr: "Traceback\nAttributeError: x", verdict: "fail" }),
    ],
  });
  assert.equal(job.outcome.kind, "repair_failed");
  assert.equal(job.repairs[0].state, "failed");
  assert.equal(job.attempts[1].failure.kind, "crash");
  assert.equal(job.attempts[1].failure.message, "AttributeError: x");
});

test("timeout is reported as infinite-loop termination only when timed_out is true", () => {
  const withTimeout = normalizeJob({ status: "done", attempts: [attempt({ exit_code: -9, timed_out: true, duration_ms: 30000 })] });
  const cap = withTimeout.security.capabilities.find((c) => c.key === "timeout");
  assert.equal(cap.observed, true);
  assert.equal(withTimeout.attempts[0].failure.kind, "timeout");

  const plain = normalizeJob({ status: "done", attempts: [attempt({ exit_code: 0, stdout: "[]" })] });
  for (const c of plain.security.capabilities) assert.equal(c.observed, false, `${c.key} must not be claimed`);
  assert.equal(plain.security.hasTelemetry, false);
});

test("job failure marks the next stage failed and the rest not reached", () => {
  const job = normalizeJob({ status: "failed", error: "RuntimeError: VULTR_INFERENCE_KEY is not set", attempts: [], screenshot_base64: PNG });
  assert.equal(stage(job, "generate").status, "failed");
  assert.match(stage(job, "generate").detail, /VULTR_INFERENCE_KEY/);
  assert.equal(stage(job, "execute").status, "skipped");
  assert.equal(job.outcome.kind, "failed");
});

test("backend-provided steps take precedence", () => {
  const job = normalizeJob({
    status: "running",
    steps: [
      { key: "access", status: "done" },
      { key: "inspect", status: "running", detail: "Reading 42 kB of HTML" },
      { key: "custom_step", status: "pending" },
    ],
  });
  assert.equal(job.hasBackendSteps, true);
  assert.deepEqual(job.stages.map((s) => s.status), ["done", "active", "pending"]);
  assert.equal(job.stages[1].label, "Inspecting page structure");
  assert.equal(job.stages[2].label, "Custom step");
});

test("evidence boxes only when coordinates are provided", () => {
  const none = normalizeJob({ status: "done", results: ROWS });
  assert.equal(none.evidence.hasBoxes, false);
  const some = normalizeJob({ status: "done", results: ROWS, evidence: [{ index: 1, bbox: [10, 20, 30, 40], verified: true }] });
  assert.equal(some.evidence.hasBoxes, true);
  assert.deepEqual(some.evidence.byIndex.get(1).box, { x: 10, y: 20, w: 30, h: 40 });
});

test("screenshotSrc rejects non-base64 payloads", () => {
  assert.equal(screenshotSrc('"><script>alert(1)</script>'), null);
  assert.equal(screenshotSrc("javascript:alert(1)//AAAAAAAAAAAA"), null);
  assert.equal(screenshotSrc(null), null);
  assert.match(screenshotSrc(PNG), /^data:image\/png;base64,iVBOR/);
  assert.match(screenshotSrc("/9j/4AAQSkZJRgABAQAAAQABAAD"), /^data:image\/jpeg/);
});

test("parseOutput never throws", () => {
  assert.deepEqual(parseOutput("[1,2]").items, [1, 2]);
  assert.equal(parseOutput("nope").items, null);
  assert.ok(parseOutput("{}").error);
  assert.equal(parseOutput("").error, null);
});

test("malformed payloads degrade gracefully", () => {
  for (const raw of [null, "x", 42, [], { attempts: "nope", results: {} }, { attempts: [null, 5] }]) {
    const job = normalizeJob(raw);
    assert.ok(job.stages.length > 0);
    assert.equal(job.status, "running");
  }
});

test("benchmark events are never shown as observed in this run", () => {
  const bench = (kind) => ({ kind, status: "passed", source: "benchmark", detail: `Runtime security benchmark: ${kind} passed.` });
  const job = normalizeJob({
    status: "done",
    created_at: "2026-11-27T12:00:00Z",
    attempts: [attempt({ exit_code: 0, stdout: "[]" })],
    security: {
      events: [{ kind: "ssrf", status: "blocked", detail: "metadata request blocked" }, { kind: "prompt_injection", status: "detected", detail: "hidden instruction" }, bench("ssrf"), bench("prompt_injection"), bench("secrets")],
      benchmark: { passed: 12, total: 12, finished_at: "2026-11-27T11:06:26Z" },
    },
  });
  const cap = (k) => job.security.capabilities.find((c) => c.key === k);

  assert.equal(cap("ssrf").evidence, "run");
  assert.equal(cap("ssrf").badge, "Blocked in this run");
  assert.deepEqual(cap("ssrf").notes, ["metadata request blocked"]);
  assert.equal(cap("prompt_injection").badge, "Detected in this run");
  assert.deepEqual(cap("prompt_injection").notes, ["hidden instruction"]);

  assert.equal(cap("secrets").evidence, "benchmark");
  assert.equal(cap("secrets").observed, false);
  assert.deepEqual(cap("secrets").notes, ["Verified by runtime security benchmark (12/12, 11:06 UTC)"]);
  assert.equal(cap("filesystem").evidence, "none");
});
