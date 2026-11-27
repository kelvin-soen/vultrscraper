// Live stage mapping, exports (privacy whitelist, CSV safety), history comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveStage } from "../js/model/live.js";
import { normalizeJob } from "../js/model/job.js";
import { toCSV, toJSON, toMarkdown, emailSummary, scraperFile, slug } from "../js/model/export.js";
import { compareRecords, snapshotOf } from "../js/model/history.js";
import { relativeTime } from "../js/model/format.js";

const att = (o) => ({ n: 1, source: "generated", code: "", stdout: "", stderr: "", exit_code: null, verdict: "running", reason: "", ...o });

test("live stage follows the backend's real signals, in order", () => {
  assert.equal(liveStage({ status: "running", attempts: [] }).key, "open");
  assert.equal(liveStage({ status: "running", attempts: [], screenshot_base64: "iVBORw0KGgo" }).key, "prepare");
  const gen = liveStage({ status: "running", models: { code: "glm-5.3" }, attempts: [att({ reason: "generating scraper" })] });
  assert.equal(gen.key, "generate");
  assert.match(gen.detail, /glm-5\.3/);
  const saved = liveStage({ status: "running", attempts: [att({ source: "saved", reason: "running in sandbox" })] });
  assert.equal(saved.key, "execute");
  assert.match(saved.label, /saved scraper/);
  const ver = liveStage({ status: "running", attempts: [att({ reason: "checking output", stdout: '[{"name":"a","price_sek":1},{"name":"b","price_sek":2}]' })] });
  assert.equal(ver.key, "verify");
  assert.match(ver.detail, /2 extracted records/);
  const rep = liveStage({ status: "running", attempts: [att({ verdict: "fail", reason: "scraper returned an empty list" }), att({ n: 2, source: "repaired", reason: "repairing scraper" })] });
  assert.equal(rep.key, "repair");
  assert.match(rep.detail, /Attempt 1 failed/);
  assert.equal(liveStage({ status: "running", phase: "analyzing", attempts: [att({ verdict: "pass" })] }).key, "analyze");
});

test("live stage never claims completion while running", () => {
  const s = liveStage({ status: "running", attempts: [att({ verdict: "pass", reason: "ok" })] });
  assert.equal(s.terminal, false);
  assert.notEqual(s.key, "done");
  assert.equal(liveStage({ status: "done", results: [{ a: 1 }], attempts: [] }).key, "done");
  assert.equal(liveStage({ status: "failed", error: "boom", attempts: [] }).detail, "boom");
  // unknown reason is shown as-is, not mapped to a guessed stage
  assert.equal(liveStage({ status: "running", attempts: [att({ reason: "doing something new" })] }).detail, "doing something new");
});

test("'running' verdict is pending, not a finished verification", () => {
  const job = normalizeJob({ status: "running", attempts: [att({ reason: "running in sandbox", code: "x" })] });
  assert.equal(job.attempts[0].verdict, "pending");
  assert.ok(!job.stages.some((s) => s.detail.startsWith("Verdict:")));
});

const RAW = {
  id: "abc123def456",
  status: "done",
  url: "http://shop.example.com/list?x=1",
  title: "Shop, \"best\" | prices",
  attempts: [
    {
      n: 1, source: "generated", code: "URL = 'x'\nprint(1)", stdout: '[{"name":"=HYPERLINK(1)","price_sek":10}]', stderr: "/runtime/secret/path",
      exit_code: 0, verdict: "pass", reason: "1 items; evidence check ok", timed_out: false, duration_ms: 900,
      runtime_job_id: "job-SECRET", sandbox: { runtime: "gVisor (runsc)", container_removed: true },
    },
  ],
  results: [{ name: "=HYPERLINK(1)", price_sek: 10 }, { name: "Plain, with comma", price_sek: 7495 }],
  final_code: "URL = 'x'\nprint(1)",
  screenshot_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  models: { code: "glm-5.3", vision: "qwen" },
  security: { events: [{ kind: "ssrf", status: "blocked", detail: "blocked 169.254.169.254" }, { kind: "timeout", status: "passed", source: "benchmark", detail: "bench" }], benchmark: { oci_runtime: "runsc", tests: [{ id: "x" }] } },
};

test("JSON export is a whitelist: no runtime ids, logs, screenshot or benchmark internals", () => {
  const job = normalizeJob(RAW, { id: RAW.id });
  const text = toJSON(job, {});
  for (const bad of ["job-SECRET", "runtime_job_id", "/runtime/secret", "stdout", "stderr", "iVBORw0KGgo", "oci_runtime", "bench"]) {
    assert.ok(!text.includes(bad), `export must not contain ${bad}`);
  }
  const data = JSON.parse(text);
  assert.equal(data.schema, "siftform.report/v1");
  assert.equal(data.records.length, 2);
  assert.deepEqual(data.security_events, [{ kind: "ssrf", status: "blocked", detail: "blocked 169.254.169.254" }]);
  assert.ok(data.evidence.some((e) => e.kind === "screenshot"));
});

test("CSV quotes properly and neutralises spreadsheet formulas", () => {
  const csv = toCSV(normalizeJob(RAW));
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "name,price_sek");
  assert.equal(lines[1], "'=HYPERLINK(1),10");
  assert.equal(lines[2], '"Plain, with comma",7495');
});

test("Markdown escapes table pipes; email stays within mailto limits", () => {
  const job = normalizeJob(RAW);
  const md = toMarkdown(job, { link: "http://host/?job=abc" });
  assert.match(md, /^# Shop, "best" \\\| prices/m);
  assert.match(md, /\| Name \| Price \|/);
  assert.match(md, /Report:\*\* http:\/\/host\/\?job=abc/);
  const many = normalizeJob({ ...RAW, results: Array.from({ length: 400 }, (_, i) => ({ name: `Product number ${i} with a long name`, price_sek: 1000 + i })) });
  const mail = emailSummary(many, { link: "http://host/?job=abc" });
  assert.ok(mail.href.length <= 1800, `mailto length ${mail.href.length}`);
  assert.match(mail.body, /and \d+ more/);
  assert.match(mail.body, /Full report: http:\/\/host\/\?job=abc/);
});

test("scraper download is labelled verified/unverified", () => {
  const ok = scraperFile(normalizeJob(RAW));
  assert.ok(ok.verified);
  assert.match(ok.text, /produced the verified results/);
  const failed = scraperFile(normalizeJob({ ...RAW, status: "failed", final_code: null, attempts: [{ ...RAW.attempts[0], verdict: "fail" }] }));
  assert.equal(failed.verified, false);
  assert.match(failed.text, /did NOT produce verified results/);
  assert.equal(slug("http://70.34.217.56:8080/shop"), "70-34-217-56-8080-shop");
});

test("saved copies drop the screenshot and runtime ids", () => {
  const snap = snapshotOf(RAW);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes("iVBORw0KGgo"));
  assert.ok(!text.includes("job-SECRET"));
  assert.equal(snap._had_screenshot, true);
  assert.equal(normalizeJob(snap).hadScreenshot, true);
});

test("history comparison by name", () => {
  const prev = [{ name: "A", price_sek: 100 }, { name: "B", price_sek: 200 }, { name: "Gone", price_sek: 5 }];
  const cur = [{ name: "a", price_sek: 120 }, { name: "B", price_sek: 200 }, { name: "New", price_sek: 9 }];
  const c = compareRecords(cur, prev);
  assert.equal(c.rows.length, 2);
  assert.equal(c.changed.length, 1);
  assert.deepEqual(c.added, ["New"]);
  assert.deepEqual(c.removed, ["Gone"]);
  assert.equal(compareRecords([{ x: true }], [{ x: false }]), null);
});

test("relative times", () => {
  const now = new Date("2026-11-27T15:00:00");
  assert.equal(relativeTime(new Date("2026-11-27T14:59:40"), now), "just now");
  assert.equal(relativeTime(new Date("2026-11-27T14:50:00"), now), "10 min ago");
  assert.match(relativeTime(new Date("2026-11-26T09:05:00"), now), /^yesterday 09:05$/);
});
