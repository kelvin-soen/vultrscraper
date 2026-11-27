/**
 * API client.
 *
 * An adapter exposes two methods that mirror the backend contract:
 *   createJob(url)          -> Promise<{ id }>
 *   getJob(id, { signal })  -> Promise<rawJob>
 *
 * The HTTP adapter talks to the FastAPI backend on the same origin (port
 * 8000 in production). The browser never calls the sandbox runner, Docker
 * or Vultr Inference directly; every operation goes through the backend.
 */

export class ApiError extends Error {
  /**
   * @param {'network'|'http'|'not_found'|'invalid'|'aborted'|'unsupported'} kind
   * @param {string} message
   * @param {number} [status]
   */
  constructor(kind, message, status) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status ?? null;
  }
}

async function readError(res) {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail) && body.detail[0]?.msg) return body.detail[0].msg;
    if (typeof body?.error === "string") return body.error;
  } catch {
    /* non-JSON error body */
  }
  return res.statusText || `Request failed (${res.status})`;
}

async function request(path, { method = "GET", body, signal, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (err) {
    if (signal?.aborted) throw new ApiError("aborted", "Request cancelled.");
    throw new ApiError("network", "Can’t reach the server. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (res.status === 404) throw new ApiError("not_found", await readError(res), 404);
  if (!res.ok) throw new ApiError("http", await readError(res), res.status);

  try {
    return await res.json();
  } catch {
    throw new ApiError("invalid", "The server returned an unreadable response.", res.status);
  }
}

export function createHttpAdapter(base = "") {
  return {
    name: "http",
    isMock: false,
    async createJob(url) {
      const data = await request(`${base}/api/jobs`, { method: "POST", body: { url } });
      if (!data || typeof data.id !== "string" || !data.id) {
        throw new ApiError("invalid", "The server did not return a job id.");
      }
      return { id: data.id };
    },
    async getJob(id, { signal } = {}) {
      const data = await request(`${base}/api/jobs/${encodeURIComponent(id)}`, { signal });
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new ApiError("invalid", "The server returned an unexpected job format.");
      }
      return data;
    },
    /**
     * POST /api/jobs/{id}/rerun — same request/response shape as createJob.
     * Announced by the backend as "coming soon": a 404/405 is reported as
     * kind "unsupported" so the UI can explain instead of failing loudly.
     */
    async rerunJob(id, url) {
      let data;
      try {
        data = await request(`${base}/api/jobs/${encodeURIComponent(id)}/rerun`, { method: "POST", body: { url } });
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501)) {
          throw new ApiError("unsupported", "Re-run isn’t available on this backend yet.", err.status);
        }
        throw err;
      }
      if (!data || typeof data.id !== "string" || !data.id) {
        throw new ApiError("invalid", "The server did not return a job id.");
      }
      return { id: data.id };
    },
  };
}

/** Agreed polling cadence while a job is running (backend contract). */
export const POLL_INTERVAL_MS = 2000;

/**
 * Poll a job until it reaches a terminal state.
 *
 * - Fixed cadence while healthy; exponential backoff (capped) on failures.
 * - Reports connection health so the UI can show "Reconnecting…".
 * - Stops on done/failed, on 404 (job unknown, e.g. backend restarted), or abort.
 *
 * @returns {() => void} stop function
 */
export function pollJob(adapter, id, { onUpdate, onConnection, onFatal, intervalMs = POLL_INTERVAL_MS, maxIntervalMs = 16000 } = {}) {
  const ctrl = new AbortController();
  let failures = 0;
  let timer = null;
  let stopped = false;

  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
  };

  async function tick() {
    if (stopped) return;
    try {
      const raw = await adapter.getJob(id, { signal: ctrl.signal });
      if (stopped) return;
      if (failures > 0) onConnection?.({ state: "ok", failures: 0 });
      failures = 0;
      const status = String(raw?.status || "").toLowerCase();
      onUpdate?.(raw);
      if (status === "done" || status === "failed") {
        stopped = true;
        return;
      }
      schedule(intervalMs);
    } catch (err) {
      if (stopped || err?.kind === "aborted") return;
      if (err?.kind === "not_found") {
        stopped = true;
        onFatal?.(err);
        return;
      }
      failures += 1;
      const delay = Math.min(maxIntervalMs, intervalMs * 2 ** Math.min(failures, 4));
      onConnection?.({ state: "retrying", failures, retryInMs: delay, error: err });
      schedule(delay);
    }
  }

  tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
    ctrl.abort();
  };
}
