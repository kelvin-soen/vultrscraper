/**
 * App shell: one continuous experience across three states.
 *
 *   home  ──submit──▶  run  ──done──▶  report
 *
 * URL state: `?job=<id>` (plus `mock=<scenario>` in development) so a page
 * reload or shared link resumes the same job. Presentation lives in views/
 * and components/; API access lives in api/; interpretation in model/.
 */

import { h, icon, replace } from "./dom.js";
import { resolveAdapter } from "./api/index.js";
import { pollJob } from "./api/client.js";
import { normalizeJob } from "./model/job.js";
import { homeView } from "./views/home.js";
import { runView } from "./views/run.js";
import { reportView } from "./views/report.js";
import { BRAND, REPORT_HANDOFF_MS } from "./config.js";

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
    h("span", { class: "wordmark__glyph", "aria-hidden": "true" }),
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
  const view = homeView({ onSubmit: submit, initialUrl: url, initialError: error });
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
  state.startedAt = Date.now();
  state.finishedAt = 0;
  if (push) setUrl({ job: id });

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
          state.handoff = setTimeout(() => {
            if (state.view?.api === view) showReport();
          }, REPORT_HANDOFF_MS);
        }
      }
    },
    onConnection: (c) => view.setConnection(c),
    onFatal: () => view.setFatal("The backend no longer knows this job. Jobs are kept in memory, so a server restart clears them."),
  });
}

function showReport() {
  if (!state.job) return;
  clearTimeout(state.handoff);
  const observed = state.finishedAt && !state.job.durationMs ? state.finishedAt - state.startedAt : null;
  const view = reportView(state.job, {
    onNew: () => goHome(),
    onRerun: () => rerun(),
    observedMs: observed,
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
  const { id } = await state.adapter.rerunJob(state.jobId, state.url);
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
