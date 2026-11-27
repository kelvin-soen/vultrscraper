/**
 * Recent extractions and saved reports, kept in THIS browser only (localStorage).
 *
 * Why client-side: the backend keeps jobs in memory and has no list endpoint, no
 * users and no persistence (see INTEGRATION_HANDOFF.md). So:
 *   - "Recent" only ever shows runs started or opened in this browser — never anyone
 *     else's (the backend's global /api/scrapers list is deliberately not shown);
 *   - finished reports are saved as a local copy, so a persistent report URL
 *     (?job=<id>) still opens after a backend restart, clearly marked as a saved copy;
 *   - historical comparison uses those local copies when the backend has no history.
 *
 * Saved copies drop the screenshot (size) and runtime ids. Storage failures (quota,
 * private mode) are swallowed: history is a convenience, never a dependency.
 */

const INDEX_KEY = "siftform.history.v1";
const SNAP_PREFIX = "siftform.report.v1.";
const MAX_ENTRIES = 40;
const MAX_SNAPSHOTS = 20;
const MAX_SNAPSHOT_CHARS = 600_000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function storage() {
  try {
    const s = globalThis.localStorage;
    const k = "__sf_probe";
    s.setItem(k, "1");
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

function read(key, fallback) {
  const s = storage();
  if (!s) return fallback;
  try {
    const v = JSON.parse(s.getItem(key) || "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Index entries, newest first. */
export function listHistory() {
  const items = read(INDEX_KEY, []);
  return Array.isArray(items) ? items.filter((e) => isObj(e) && typeof e.id === "string") : [];
}

export function getEntry(id) {
  return listHistory().find((e) => e.id === id) || null;
}

/**
 * Upsert an entry. Called when a run starts (url, startedAt) and on every status
 * change (title, status, outcome, records). Only fields we actually know are stored.
 */
export function recordRun(id, patch) {
  if (!id) return;
  const items = listHistory();
  const i = items.findIndex((e) => e.id === id);
  const prev = i >= 0 ? items[i] : { id };
  const next = { ...prev, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  if (i >= 0) items.splice(i, 1);
  items.unshift(next);
  write(INDEX_KEY, items.slice(0, MAX_ENTRIES));
}

export function removeEntry(id) {
  write(INDEX_KEY, listHistory().filter((e) => e.id !== id));
  storage()?.removeItem(SNAP_PREFIX + id);
}

export function clearHistory() {
  const s = storage();
  if (!s) return;
  for (const e of listHistory()) s.removeItem(SNAP_PREFIX + e.id);
  s.removeItem(INDEX_KEY);
}

/* ---- saved report copies --------------------------------------------------- */

const cap = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}\n…[truncated in saved copy]` : s);

/** Local copy of a finished raw job (screenshot and runtime ids removed). */
export function snapshotOf(raw) {
  if (!isObj(raw)) return null;
  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts.filter(isObj).map((a) => {
        const { runtime_job_id, ...rest } = a; // eslint-disable-line no-unused-vars
        return { ...rest, stdout: cap(a.stdout, 20000), stderr: cap(a.stderr, 4000) };
      })
    : [];
  const sec = isObj(raw.security) ? raw.security : {};
  return {
    id: raw.id,
    url: raw.url,
    title: raw.title,
    status: raw.status,
    error: raw.error,
    mode: raw.mode,
    scrape_mode: raw.scrape_mode,
    parent: raw.parent,
    attempts,
    results: Array.isArray(raw.results) ? raw.results : [],
    final_code: raw.final_code,
    created_at: raw.created_at,
    finished_at: raw.finished_at,
    models: raw.models,
    code_model_calls: raw.code_model_calls,
    vision_calls: raw.vision_calls,
    intelligence: raw.intelligence,
    security: {
      events: Array.isArray(sec.events) ? sec.events : [],
      benchmark: isObj(sec.benchmark) ? { passed: sec.benchmark.passed, total: sec.benchmark.total, finished_at: sec.benchmark.finished_at } : null,
    },
    _had_screenshot: !!raw.screenshot_base64,
  };
}

export function saveSnapshot(id, raw) {
  const snap = snapshotOf({ ...raw, id });
  if (!snap) return false;
  snap._saved = { at: new Date().toISOString() };
  let text = JSON.stringify(snap);
  if (text.length > MAX_SNAPSHOT_CHARS) {
    snap.intelligence = snap.intelligence ? { status: "absent_in_saved_copy" } : snap.intelligence;
    snap.attempts = snap.attempts.map((a, i, all) => (i === all.length - 1 ? a : { ...a, code: "", stdout: "", stderr: "" }));
    text = JSON.stringify(snap);
    if (text.length > MAX_SNAPSHOT_CHARS) return false;
  }
  const s = storage();
  if (!s) return false;
  const tryWrite = () => {
    try {
      s.setItem(SNAP_PREFIX + id, text);
      return true;
    } catch {
      return false;
    }
  };
  pruneSnapshots(id);
  if (tryWrite()) return true;
  pruneSnapshots(id, Math.floor(MAX_SNAPSHOTS / 2)); // quota: make room once
  return tryWrite();
}

export function loadSnapshot(id) {
  const snap = read(SNAP_PREFIX + id, null);
  return isObj(snap) ? snap : null;
}

function pruneSnapshots(keepId, max = MAX_SNAPSHOTS) {
  const s = storage();
  if (!s) return;
  const ids = listHistory().map((e) => e.id).filter((x) => x !== keepId && s.getItem(SNAP_PREFIX + x) !== null);
  for (const id of ids.slice(max - 1)) s.removeItem(SNAP_PREFIX + id);
}

/* ---- comparison ------------------------------------------------------------- */

export function siteKey(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return String(url || "");
  }
}

/** The most recent earlier saved report for the same site (URL without query). */
export function previousSnapshot(job) {
  const key = siteKey(job.url);
  for (const e of listHistory()) {
    if (e.id === job.id || e.status !== "done" || siteKey(e.url) !== key) continue;
    if (e.finishedAt && job.finishedAtMs && e.finishedAt >= job.finishedAtMs) continue;
    const snap = loadSnapshot(e.id);
    if (snap && Array.isArray(snap.results) && snap.results.length) return { entry: e, snap };
  }
  return null;
}

const normName = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Compare two record lists by name and the first numeric field present in both.
 * Returns null when there is nothing comparable (no shared name/value fields).
 */
export function compareRecords(current, previous) {
  const pick = (rows) => rows.filter(isObj);
  const cur = pick(current);
  const prev = pick(previous);
  if (!cur.length || !prev.length) return null;
  const keys = Object.keys(cur[0]);
  const nameKey = keys.find((k) => /^(name|title|product)$/i.test(k)) || keys.find((k) => typeof cur[0][k] === "string");
  const valueKey = keys.find((k) => typeof cur[0][k] === "number" && prev.some((r) => typeof r[k] === "number"));
  if (!nameKey || !valueKey) return null;

  const before = new Map(prev.map((r) => [normName(r[nameKey]), r]));
  const nowNames = new Set(cur.map((r) => normName(r[nameKey])));
  const rows = [];
  for (const r of cur) {
    const p = before.get(normName(r[nameKey]));
    if (p && typeof p[valueKey] === "number" && typeof r[valueKey] === "number" && p[valueKey] > 0) {
      rows.push({ name: String(r[nameKey]), before: p[valueKey], after: r[valueKey], flagged: false });
    }
  }
  const added = cur.filter((r) => !before.has(normName(r[nameKey]))).map((r) => String(r[nameKey]));
  const removed = prev.filter((r) => !nowNames.has(normName(r[nameKey]))).map((r) => String(r[nameKey]));
  const changed = rows.filter((r) => r.before !== r.after);
  return { nameKey, valueKey, rows, changed, added, removed };
}
