/**
 * Self-healing visualisation.
 *
 * A repair round is the progression from a failed attempt to the corrected
 * one: failure → investigation → corrected scraper → execution → verification.
 * Every step state is derived from the attempts the backend reported.
 */

import { h } from "../dom.js";
import { mark, attemptCard } from "./ui.js";

const ROUND_STATE = {
  repaired: { label: "Repaired", status: "done" },
  failed: { label: "Repair failed", status: "failed" },
  unverified: { label: "Verification incomplete", status: "skipped" },
  in_progress: { label: "Repairing", status: "active" },
};

export function repairRound(round, { layout = "track", total = 1 } = {}) {
  const st = ROUND_STATE[round.state] || ROUND_STATE.in_progress;
  return h(
    "section",
    { class: `repair repair--${layout} repair--${round.state}`, "aria-label": `Repair ${round.index}` },
    h(
      "header",
      { class: "repair__head" },
      h("span", { class: "repair__title", text: total > 1 ? `Repair ${round.index}` : "Self-healing" }),
      h("span", { class: `repair__state repair__state--${st.status}` }, mark(st.status, { size: "sm" }), h("span", { text: st.label }))
    ),
    h(
      "ol",
      { class: "repair__steps" },
      round.steps.map((s) =>
        h(
          "li",
          { class: `repair__step repair__step--${s.status}` },
          h("span", { class: "repair__mark" }, mark(s.status, { size: "sm" })),
          h("span", { class: "repair__text" }, h("span", { class: "repair__label", text: s.label }), s.detail ? h("span", { class: "repair__detail", text: s.detail }) : null)
        )
      )
    )
  );
}

/** Report section: summary line, repair rounds, then the full attempt history. */
export function healingSection(job, { openSet } = {}) {
  const { attempts, repairs, outcome } = job;
  const intro =
    repairs.length === 0
      ? attempts.length === 1 && attempts[0].succeeded
        ? "The first scraper succeeded, so no repair was needed."
        : attempts.length === 0
          ? "No scraper attempts were reported."
          : "No repair attempts were reported for this run."
      : outcome.kind === "repaired"
        ? `The original extraction failed. The agent diagnosed the failure and recovered on attempt ${job.finalAttempt.n}.`
        : outcome.kind === "repair_failed"
          ? `The agent tried ${attempts.length} scrapers without producing verified results.`
          : "The agent attempted to repair the scraper.";

  return h(
    "div",
    { class: "healing" },
    h("p", { class: "healing__intro t-lead", text: intro }),
    repairs.length ? h("div", { class: "healing__rounds" }, repairs.map((r) => repairRound(r, { layout: "track", total: repairs.length }))) : null,
    attempts.length
      ? h(
          "div",
          { class: "healing__history" },
          h("h3", { class: "t-eyebrow", text: "Execution history" }),
          h("div", { class: "attempts" }, attempts.map((a) => attemptCard(a, { openSet, idPrefix: "r" })))
        )
      : null
  );
}
