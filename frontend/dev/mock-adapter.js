/**
 * ============================================================
 *  DEVELOPMENT MOCK ADAPTER — NOT REAL DATA
 * ============================================================
 * Implements the same interface as the HTTP adapter (js/api/client.js)
 * from the timelines in ./fixtures.js. Only loaded with `?mock=<scenario>`.
 * The app shows a persistent badge whenever this adapter is active.
 */

import { ApiError } from "../js/api/client.js";
import { SCENARIOS, emptyJob } from "./fixtures.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const STORE = "mock-jobs";

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) || "{}");
  } catch {
    return {};
  }
}
function save(jobs) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(jobs));
  } catch {
    /* storage unavailable: in-memory only */
  }
}

export function snapshot(scenario, url, elapsedMs) {
  const state = emptyJob(url);
  for (const [at, apply] of scenario.frames) {
    if (at > elapsedMs) break;
    apply(state, url);
  }
  return structuredClone(state);
}

export function createMockAdapter(name, { now = () => Date.now(), latency = 140 } = {}) {
  const key = SCENARIOS[name] ? name : "heal";
  const scenario = SCENARIOS[key];
  const memory = load();

  return {
    name: "mock",
    isMock: true,
    scenario: key,
    scenarios: Object.keys(SCENARIOS),
    description: scenario.description,

    async createJob(url) {
      await wait(latency * 2);
      if (scenario.createError) {
        const e = scenario.createError;
        throw new ApiError(e.kind, e.message, e.status);
      }
      const id = `mock-${key}-${now().toString(36)}`;
      memory[id] = { url, startedAt: now(), scenario: key };
      save(memory);
      return { id };
    },

    async getJob(id) {
      await wait(latency);
      const rec = memory[id];
      if (!rec) throw new ApiError("not_found", "job not found", 404);
      const sc = SCENARIOS[rec.scenario] || scenario;
      const elapsed = now() - rec.startedAt;
      if (sc.offline && elapsed >= sc.offline[0] && elapsed < sc.offline[1]) {
        throw new ApiError("network", "Can’t reach the server. Check your connection and try again.");
      }
      return snapshot(sc, rec.url, elapsed);
    },

    async rerunJob(_id, url) {
      throw new ApiError("unsupported", "Re-run isn’t available on this backend yet.", 404);
    },
  };
}
