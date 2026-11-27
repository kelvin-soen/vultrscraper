import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHttpAdapter, pollJob, ApiError, POLL_INTERVAL_MS } from "../js/api/client.js";
import { snapshot } from "../dev/mock-adapter.js";
import { SCENARIOS } from "../dev/fixtures.js";
import { normalizeJob } from "../js/model/job.js";

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "x",
  json: async () => body,
});

test("polling cadence matches the backend contract (2 s)", () => {
  assert.equal(POLL_INTERVAL_MS, 2000);
});

test("http adapter uses relative paths and the agreed payloads", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init.method, init.body]);
    if (init.method === "POST") return json(200, { id: "abc" });
    return json(200, { status: "running" });
  };
  const api = createHttpAdapter("");
  assert.deepEqual(await api.createJob("https://a.se/"), { id: "abc" });
  await api.getJob("abc");
  assert.deepEqual(calls[0], ["/api/jobs", "POST", JSON.stringify({ url: "https://a.se/" })]);
  assert.equal(calls[1][0], "/api/jobs/abc");
});

test("http adapter surfaces FastAPI error detail", async () => {
  globalThis.fetch = async () => json(400, { detail: "url must start with http:// or https://" });
  await assert.rejects(createHttpAdapter().createJob("x"), (e) => e instanceof ApiError && e.kind === "http" && /must start/.test(e.message));
});

test("rerun reports 'unsupported' until the backend ships it", async () => {
  globalThis.fetch = async () => json(404, { detail: "Not Found" });
  await assert.rejects(createHttpAdapter().rerunJob("abc", "https://a.se/"), (e) => e.kind === "unsupported");
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/jobs/abc/rerun");
    assert.equal(init.body, JSON.stringify({ url: "https://a.se/" }));
    return json(200, { id: "def" });
  };
  assert.deepEqual(await createHttpAdapter().rerunJob("abc", "https://a.se/"), { id: "def" });
});

test("network failure becomes a friendly ApiError", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(createHttpAdapter().getJob("x"), (e) => e.kind === "network");
});

test("pollJob stops on done, backs off on failures, stops on 404", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const seq = [new ApiError("network", "down"), { status: "running" }, { status: "done" }];
    const updates = [];
    const conns = [];
    const adapter = {
      getJob: async () => {
        const next = seq.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    };
    pollJob(adapter, "id", { onUpdate: (r) => updates.push(r.status), onConnection: (c) => conns.push(c.state), intervalMs: 2000 });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      await Promise.resolve();
      mock.timers.tick(4000);
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(updates, ["running", "done"]);
    assert.deepEqual(conns, ["retrying", "ok"]);
    assert.equal(seq.length, 0);

    let fatal = null;
    pollJob({ getJob: async () => { throw new ApiError("not_found", "gone", 404); } }, "x", { onFatal: (e) => (fatal = e) });
    await new Promise((r) => setImmediate(r));
    assert.equal(fatal?.kind, "not_found");
  } finally {
    mock.timers.reset();
  }
});

test("every mock scenario ends in a consistent terminal state", () => {
  const expected = { success: "verified", heal: "repaired", "heal-fail": "repair_failed", timeout: "repaired", evil: "verified", unverified: "unverified", extended: "verified", offline: "verified", anomaly: "verified" };
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    if (sc.createError) continue;
    const raw = snapshot(sc, "http://demo.test/shop", 1e9);
    const job = normalizeJob(raw);
    assert.equal(job.outcome.kind, expected[name], name);
    // Snapshots along the way must never claim success early.
    for (let t = 0; t < 30000; t += 500) {
      const mid = normalizeJob(snapshot(sc, "http://demo.test/shop", t));
      if (mid.status === "running") assert.equal(mid.outcome.kind, "running", `${name}@${t}`);
    }
  }
});
