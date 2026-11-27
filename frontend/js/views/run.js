/**
 * State 2 — live agent execution.
 *
 * Re-renders from the normalized job on every poll. Each region is only
 * rebuilt when its inputs change, so open disclosures and scroll positions
 * survive updates.
 */

import { h, icon, replace } from "../dom.js";
import { displayUrl, hostOf } from "../url.js";
import { formatClock } from "../model/format.js";
import { inferColumns, primaryColumn, formatCell, cellValue } from "../model/schema.js";
import { stageList } from "../components/stages.js";
import { attemptCard, button, mark, skeleton } from "../components/ui.js";
import { screenshotFrame, lightbox } from "../components/evidence.js";
import { cubeLoader } from "../components/cube.js";

export function runView({ url, startedAt = Date.now(), onViewReport, onRetry, onNew }) {
  const openSet = new Set();
  const sigs = {};
  let timer = null;
  let current = null;
  let titleEl = null;
  let urlEl = null;

  const cube = cubeLoader({ label: "Starting" });
  let settled = null; // Promise once the cube has landed on a terminal state
  const settledCbs = [];
  const statusText = h("span", { class: "run__status-text", text: "Starting" });
  const stageLabel = h("p", { class: "run__stage", "aria-live": "polite", text: "Starting the run" });
  const stageDetail = h("p", { class: "run__stage-detail c-3", text: "Contacting the backend" });
  const clock = h("span", { class: "run__clock t-num", text: "00:00", "aria-label": "Elapsed time" });
  const conn = h("div", { class: "conn", role: "status", "aria-live": "polite", hidden: true });

  const stagesEl = h("div", { class: "run__stages-inner" });
  const shotEl = h("div", { class: "panel__body" });
  const findingsEl = h("div", { class: "panel__body" });
  const attemptsEl = h("div", { class: "attempts" });
  const attemptsWrap = h("section", { class: "panel panel--flush", hidden: true, "aria-label": "Attempts" }, h("header", { class: "panel__head" }, h("h2", { class: "panel__title", text: "Attempts" }), h("span", { class: "panel__meta t-micro c-3", text: "Code and logs" })), attemptsEl);
  const outcomeEl = h("div", { class: "run__outcome", hidden: true, "aria-live": "polite" });

  const findingsMeta = h("span", { class: "panel__meta t-micro c-3 t-num" });

  const view = h(
    "section",
    { class: "view run", "aria-labelledby": "run-title" },
    h(
      "header",
      { class: "run__head" },
      h(
        "div",
        { class: "run__hero" },
        h("div", { class: "run__cube" }, cube.el),
        h(
          "div",
          { class: "run__heading" },
          h("p", { class: "run__status" }, statusText, h("span", { class: "run__sep", "aria-hidden": "true", text: "·" }), clock),
          stageLabel,
          stageDetail,
          h("p", { class: "run__target" }, h("span", { class: "run__title truncate", id: "run-title", text: hostOf(url) || url || "Loading run…", ref: (el) => (titleEl = el) }), h("span", { class: "run__url t-mono c-3 truncate", text: displayUrl(url), ref: (el) => (urlEl = el) }))
        )
      ),
      conn
    ),
    outcomeEl,
    h(
      "div",
      { class: "run__grid" },
      h("aside", { class: "run__stages", "aria-label": "Progress" }, stagesEl),
      h(
        "div",
        { class: "run__live" },
        h("section", { class: "panel", "aria-label": "Visual evidence" }, h("header", { class: "panel__head" }, h("h2", { class: "panel__title", text: "Visual evidence" }), h("span", { class: "panel__meta t-micro c-3", text: "Screenshot of the source page" })), shotEl),
        h("section", { class: "panel", "aria-label": "Findings" }, h("header", { class: "panel__head" }, h("h2", { class: "panel__title", text: "Findings" }), findingsMeta), findingsEl),
        attemptsWrap
      )
    )
  );

  // Initial placeholders until the first poll returns.
  replace(stagesEl, skeleton({ lines: 6 }));
  replace(shotEl, waitingShot());
  replace(findingsEl, waitingFindings("Waiting for the first scraper run."));

  const tick = () => {
    clock.textContent = formatClock(Date.now() - startedAt);
  };
  tick();
  timer = setInterval(tick, 1000);

  function changed(key, value) {
    const s = JSON.stringify(value);
    if (sigs[key] === s) return false;
    sigs[key] = s;
    return true;
  }

  function update(job) {
    if (!current && !url && job.url) {
      titleEl.textContent = hostOf(job.url) || job.url;
      urlEl.textContent = displayUrl(job.url);
    }
    current = job;
    const running = job.status === "running";
    view.classList.toggle("is-running", running);
    view.classList.toggle("is-finished", !running);

    const live = job.live;
    statusText.textContent = running ? (live.attempt ? `Attempt ${live.attempt}` : "Running") : job.outcome.label;
    if (stageLabel.textContent !== live.label) {
      stageLabel.textContent = live.label;
      stageLabel.classList.remove("is-new");
      void stageLabel.offsetWidth;
      stageLabel.classList.add("is-new");
    }
    stageDetail.textContent = live.detail;
    cube.setLabel(`${live.label}. ${live.detail}`);
    if (running) cube.setMode(live.mode);
    else if (!settled) {
      settled = cube.settle({ failed: job.status !== "done" });
      settled.then(() => settledCbs.splice(0).forEach((cb) => cb()));
    }

    if (!running && timer) {
      clearInterval(timer);
      timer = null;
    }

    if (changed("stages", [job.stages, job.repairs.map((r) => [r.state, r.steps])])) {
      replace(stagesEl, stageList(job));
    }

    if (changed("shot", !!job.screenshot && job.screenshot.length)) {
      replace(shotEl, job.screenshot ? screenshotFrame(job.screenshot, { onOpen: () => lightbox(job.screenshot, "Screenshot of the source page") }) : running ? waitingShot() : noShot());
      shotEl.classList.add("fade-in");
    }

    const preview = job.results.length ? job.results : job.finalAttempt?.output.items || [];
    const fromResults = job.results.length > 0;
    if (changed("findings", [preview.length, fromResults, job.finalAttempt?.n, job.finalAttempt?.verdict, running])) {
      findingsMeta.textContent = preview.length ? `${preview.length} record${preview.length === 1 ? "" : "s"}${fromResults ? "" : " · scraper output"}` : "";
      replace(findingsEl, preview.length ? findingsPreview(preview, job, fromResults) : waitingFindings(findingsEmptyText(job)));
    }

    if (changed("attempts", job.attempts.map((a) => [a.n, a.code.length, a.stdout.length, a.stderr.length, a.exitCode, a.verdict, a.reason, running]))) {
      attemptsWrap.hidden = job.attempts.length === 0;
      replace(
        attemptsEl,
        job.attempts.map((a, i) => attemptCard(a, { openSet, live: running && i === job.attempts.length - 1, idPrefix: "l" }))
      );
    }

    if (changed("outcome", [job.status, job.outcome])) {
      outcomeEl.hidden = running;
      if (!running) replace(outcomeEl, outcomeBanner(job));
    }
  }

  function outcomeBanner(job) {
    const o = job.outcome;
    const ok = o.kind === "verified" || o.kind === "repaired";
    const st = ok ? "done" : o.kind === "unverified" ? "skipped" : "failed";
    const actions = [];
    if (job.status === "done" || job.attempts.length) actions.push(button("View report", { variant: ok ? "primary" : "secondary", iconAfter: "arrowRight", onClick: onViewReport }));
    if (!ok) actions.push(button("Try again", { variant: ok ? "secondary" : "primary", iconName: "refresh", onClick: onRetry }));
    actions.push(button("New URL", { variant: "ghost", onClick: onNew }));
    return h(
      "div",
      { class: `outcome outcome--${o.kind}` },
      mark(st, { size: "lg" }),
      h("div", { class: "outcome__text" }, h("p", { class: "outcome__title", text: o.title }), o.detail ? h("p", { class: "outcome__detail t-small c-2", text: o.detail }) : null),
      h("div", { class: "outcome__actions" }, actions)
    );
  }

  return {
    el: view,
    update,
    setConnection({ state, failures, retryInMs }) {
      if (state === "ok") {
        conn.hidden = true;
        return;
      }
      conn.hidden = false;
      replace(conn, h("span", { class: "conn__dot", "aria-hidden": "true" }), h("span", { text: failures >= 3 ? `Connection lost — retrying in ${Math.round(retryInMs / 1000)} s` : "Reconnecting…" }));
    },
    /** Called once the cube has landed after done/failed (immediately if already). */
    onSettled(cb) {
      if (settled) settled.then(cb);
      else settledCbs.push(cb);
    },
    setFatal(message) {
      if (!settled) settled = cube.settle({ failed: true });
      stageLabel.textContent = "Run unavailable";
      stageDetail.textContent = message;
      if (timer) clearInterval(timer);
      timer = null;
      view.classList.remove("is-running");
      view.classList.add("is-finished");
      statusText.textContent = "Unavailable";
      outcomeEl.hidden = false;
      replace(
        outcomeEl,
        h(
          "div",
          { class: "outcome outcome--failed" },
          mark("failed", { size: "lg" }),
          h("div", { class: "outcome__text" }, h("p", { class: "outcome__title", text: "This run is no longer available" }), h("p", { class: "outcome__detail t-small c-2", text: message })),
          h("div", { class: "outcome__actions" }, button("Start again", { variant: "primary", iconName: "refresh", onClick: onRetry }), button("New URL", { variant: "ghost", onClick: onNew }))
        )
      );
      if (!current) {
        replace(stagesEl, h("p", { class: "t-small c-3", text: "No progress information." }));
        replace(shotEl, noShot());
        replace(findingsEl, waitingFindings("No data."));
      }
    },
    destroy() {
      if (timer) clearInterval(timer);
      cube.destroy();
    },
  };
}

function waitingShot() {
  return h("div", { class: "shot-wait" }, skeleton({ block: true }), h("p", { class: "shot-wait__text t-small c-3", text: "The screenshot appears here once the sandbox has loaded the page." }));
}

function noShot() {
  return h("p", { class: "t-small c-3 panel__empty", text: "No screenshot was returned for this run." });
}

function waitingFindings(text) {
  return h("p", { class: "t-small c-3 panel__empty", text });
}

function findingsEmptyText(job) {
  const a = job.finalAttempt;
  if (!a) return job.status === "running" ? "Waiting for the first scraper run." : "No records were extracted.";
  if (!a.ran) return job.status === "running" ? "Scraper generated. Waiting for it to run in the sandbox." : "The scraper was generated but no execution was reported.";
  if (a.failure) return `Attempt ${a.n} produced no usable records.`;
  return "No records yet.";
}

function findingsPreview(rows, job, fromResults) {
  const cols = inferColumns(rows);
  const primary = primaryColumn(cols);
  const value = cols.find((c) => c.type === "money") || cols.find((c) => c !== primary);
  const shown = rows.slice(0, 8);
  return h(
    "div",
    { class: "findings" },
    h(
      "ol",
      { class: "findings__list" },
      shown.map((r, i) =>
        h(
          "li",
          { class: "findings__row", style: { "--i": String(i) } },
          h("span", { class: "findings__name truncate", text: primary ? formatCell(cellValue(r, primary), primary) : JSON.stringify(r) }),
          value ? h("span", { class: "findings__value t-num", text: formatCell(cellValue(r, value), value) }) : null
        )
      )
    ),
    rows.length > shown.length ? h("p", { class: "t-micro c-3 findings__more", text: `+ ${rows.length - shown.length} more` }) : null,
    !fromResults ? h("p", { class: "t-micro c-3 findings__note", text: "Raw scraper output — not yet accepted as results." }) : null
  );
}
