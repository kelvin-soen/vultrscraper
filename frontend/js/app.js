/**
 * App shell: one continuous experience across three states.
 *
 *   home  ──submit──▶  run  ──done──▶  report
 *
 * URL state: `?job=<id>` (plus `mock=<scenario>` in development) so a page
 * reload or shared link resumes the same job. Presentation lives in views/
 * and components/; API access lives in api/; interpretation in model/.
 */

import { brandMark, h, icon, replace } from "./dom.js";
import { resolveAdapter } from "./api/index.js";
import { pollJob } from "./api/client.js";
import { normalizeJob } from "./model/job.js";
import { homeView } from "./views/home.js";
import { runView } from "./views/run.js";
import { reportView } from "./views/report.js";
import { BRAND, REPORT_HANDOFF_MS } from "./config.js";
import { getEntry, loadSnapshot, recordRun, saveSnapshot } from "./model/history.js";

const root = document.getElementById("main");
const topbar = document.getElementById("topbar");

const state = {
  adapter: null,
  view: null, // { name, api }
  stopPoll: null,
  handoff: null,
  job: null,
  jobId: null,
  url: "",
  startedAt: 0,
  finishedAt: 0,
  raw: null,
  fromSnapshot: false,
};

/* ---- routing ----------------------------------------------------------- */

function currentParams() {
  return new URLSearchParams(location.search);
}

function setUrl(params, { replace: rep = false } = {}) {
  const keep = currentParams().get("mock");
  const p = new URLSearchParams(params);
  if (keep !== null) p.set("mock", keep);
  const qs = p.toString();
  const next = `${location.pathname}${qs ? `?${qs}` : ""}`;
  if (rep) history.replaceState({ job: p.get("job") }, "", next);
  else history.pushState({ job: p.get("job") }, "", next);
}

/* ---- shell ------------------------------------------------------------- */

function renderTopbar(name) {
  const home = h(
    "a",
    {
      class: "wordmark",
      href: location.pathname + (currentParams().get("mock") !== null ? `?mock=${encodeURIComponent(currentParams().get("mock"))}` : ""),
      "aria-label": `${BRAND.name} — start over`,
      onClick: (e) => {
        e.preventDefault();
        goHome();
      },
    },
    brandMark(),
    h("span", { class: "wordmark__text", text: BRAND.name })
  );
  const right = name === "home" ? null : h("button", { class: "btn btn--ghost btn--sm", type: "button", onClick: () => goHome() }, icon("arrowLeft", { size: 14 }), h("span", { text: "New" }));
  replace(topbar, h("div", { class: "topbar__inner" }, home, right));
  document.body.dataset.view = name;
}

function mount(name, api) {
  state.view?.api?.destroy?.();
  state.view = { name, api };
  renderTopbar(name);
  replace(root, api.el);
  api.el.classList.add("view--enter");
  window.scrollTo({ top: 0, behavior: "instant" });
  return Promise.resolve();
}

function stopWork() {
  state.stopPoll?.();
  state.stopPoll = null;
  clearTimeout(state.handoff);
  state.handoff = null;
}

/* ---- states ------------------------------------------------------------ */

function goHome({ push = true, url = "", error = "" } = {}) {
  stopWork();
  state.job = null;
  state.jobId = null;
  if (push) setUrl({});
  const view = homeView({ onSubmit: submit, initialUrl: url, initialError: error, onOpen: (entry) => openEntry(entry), onRunAgain: (entry) => runAgain(entry) });
  mount("home", view).then(() => view.focus());
  document.title = `${BRAND.name} — ${BRAND.tagline}`;
}

async function submit(url) {
  const { id } = await state.adapter.createJob(url);
  startRun(id, url, { push: true });
}

function startRun(id, url, { push = true, resumed = false } = {}) {
  stopWork();
  state.jobId = id;
  state.url = url;
  state.job = null;
  state.raw = null;
  state.fromSnapshot = false;
  const known = getEntry(id);
  // Times are only ever what this browser saw; a resumed run keeps its original start.
  state.startedAt = known?.startedAt || Date.now();
  state.finishedAt = known?.finishedAt || 0;
  if (push) setUrl({ job: id });
  if (!resumed || !known) recordRun(id, { url: url || undefined, startedAt: state.startedAt, status: "running" });

  const view = runView({
    url,
    startedAt: state.startedAt,
    onViewReport: () => showReport(),
    onRetry: () => retry(),
    onNew: () => goHome({ url: state.url }),
  });
  mount("run", view);
  document.title = `Running${url ? ` · ${url}` : ""} — ${BRAND.name}`;

  let first = true;
  state.stopPoll = pollJob(state.adapter, id, {
    onUpdate(raw) {
      const job = normalizeJob(raw, { id, url: state.url });
      if (!state.url && job.url) state.url = job.url;
      state.job = job;
      state.raw = raw;
      track(id, job, raw);
      // A reload of an already-finished job goes straight to the report.
      if (first && resumed && job.status === "done") {
        first = false;
        showReport();
        return;
      }
      first = false;
      view.update(job);
      if (job.status !== "running") {
        state.finishedAt = Date.now();
        document.title = `${job.outcome.label} · ${job.url} — ${BRAND.name}`;
        if (job.status === "done") {
          // Hand off only after the cube has landed in the logo pose.
          view.onSettled(() => {
            state.handoff = setTimeout(() => {
              if (state.view?.api === view) showReport();
            }, REPORT_HANDOFF_MS);
          });
        }
      }
    },
    onConnection: (c) => view.setConnection(c),
    onFatal: () => {
      // Persistent report URLs: the backend forgets jobs on restart, so fall back to
      // the copy saved in this browser (clearly labelled as such).
      const snap = loadSnapshot(id);
      if (snap) {
        state.raw = snap;
        state.fromSnapshot = true;
        state.job = normalizeJob(snap, { id, url: state.url });
        if (!state.url) state.url = state.job.url;
        showReport();
        return;
      }
      recordRun(id, { status: "gone" });
      view.setFatal("The backend no longer has this run, and no copy was saved in this browser. Jobs are kept in server memory, so a restart clears them.");
    },
  });
}

/** Keep the local history entry (and the saved copy) in step with the backend. */
function track(id, job, raw) {
  const prev = getEntry(id);
  const patch = {
    url: job.url || undefined,
    title: job.title || undefined,
    status: job.status,
    outcome: job.outcome.kind,
    outcomeLabel: job.outcome.label,
    records: job.results.length,
    reused: job.attempts[0]?.source === "saved",
    attempts: job.attempts.length,
    createdAt: job.createdAt ? job.createdAt.getTime() : undefined,
  };
  if (job.status !== "running" && !prev?.finishedAt) patch.finishedAt = job.finishedAt ? job.finishedAt.getTime() : Date.now();
  recordRun(id, patch);
  if (job.status !== "running" && !prev?.saved) {
    if (saveSnapshot(id, raw)) recordRun(id, { saved: true });
  }
}

/** Open a history entry: live from the backend, or the saved copy if it is gone. */
function openEntry(entry) {
  startRun(entry.id, entry.url, { push: true, resumed: true });
}

async function runAgain(entry) {
  state.url = entry.url;
  state.jobId = entry.id;
  try {
    await rerun();
  } catch (err) {
    goHome({ url: entry.url, error: err?.message || "Couldn’t start a new run." });
  }
}

function showReport() {
  if (!state.job) return;
  clearTimeout(state.handoff);
  const entry = getEntry(state.jobId) || {};
  const finished = state.finishedAt || entry.finishedAt || 0;
  const started = state.startedAt || entry.startedAt || 0;
  const observed = finished && started && !state.job.durationMs ? finished - started : null;
  const view = reportView(state.job, {
    onNew: () => goHome(),
    onRerun: () => rerun(),
    observedMs: observed,
    observed: { startedAt: started || null, finishedAt: finished || null },
    fromSnapshot: state.fromSnapshot,
    isMock: !!state.adapter?.isMock,
  });
  mount("report", view);
  document.title = `${state.job.title || state.job.url} — ${BRAND.name}`;
}

async function retry() {
  if (!state.url) return goHome();
  try {
    const { id } = await state.adapter.createJob(state.url);
    startRun(id, state.url, { push: true });
  } catch (err) {
    goHome({ url: state.url, error: err?.message || "Couldn’t start a new run." });
  }
}

/** Re-run via POST /api/jobs/{id}/rerun (announced by the backend; may not exist yet). */
async function rerun() {
  let id;
  try {
    ({ id } = await state.adapter.rerunJob(state.jobId, state.url));
  } catch (err) {
    // The parent job is gone (backend restart) or rerun is unsupported: a new job on
    // the same URL also starts from the site's saved scraper on this backend.
    if (err?.status !== 404 && err?.status !== 409 && err?.kind !== "unsupported") throw err;
    ({ id } = await state.adapter.createJob(state.url));
  }
  startRun(id, state.url, { push: true });
}

/* ---- boot -------------------------------------------------------------- */

function route({ push = false } = {}) {
  const id = currentParams().get("job");
  if (id) {
    startRun(id, state.url || "", { push, resumed: true });
  } else {
    goHome({ push });
  }
}

async function boot() {
  try {
    state.adapter = await resolveAdapter();
  } catch (err) {
    console.error(err);
    replace(root, h("p", { class: "boot-error", text: "The development mock could not be loaded." }));
    return;
  }

  if (state.adapter.isMock) mountDevBadge(state.adapter);

  window.addEventListener("popstate", () => route());
  route();
}

function mountDevBadge(adapter) {
  const select = h(
    "select",
    {
      class: "devbadge__select",
      "aria-label": "Mock scenario",
      onChange: (e) => {
        const p = new URLSearchParams();
        p.set("mock", e.target.value);
        location.search = p.toString();
      },
    },
    adapter.scenarios.map((s) => h("option", { value: s, selected: s === adapter.scenario, text: s }))
  );
  document.body.append(
    h(
      "aside",
      { class: "devbadge", role: "note", "aria-label": "Development fixture active" },
      h("span", { class: "devbadge__dot", "aria-hidden": "true" }),
      h("span", { class: "devbadge__label", text: "Mock data — not a real run" }),
      select
    )
  );
}

boot();
