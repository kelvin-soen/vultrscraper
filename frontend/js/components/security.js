/**
 * Containment & security. Shows ONLY telemetry present in the job payload.
 * Capabilities without evidence in this run read "Not reported", never a
 * success indicator.
 */

import { h } from "../dom.js";
import { mark } from "./ui.js";
import { formatDuration } from "../model/format.js";

const dash = "—";

export function securitySection(job) {
  const { security, attempts } = job;
  const ranAttempts = security.runs;

  const runsTable = ranAttempts.length
    ? h(
        "div",
        { class: "table__scroll", tabindex: "0", role: "region", "aria-label": "Sandbox executions" },
        h(
          "table",
          { class: "ledger" },
          h(
            "thead",
            null,
            h("tr", null, ["Attempt", "Duration", "Exit", "Time limit", "Runtime", "Container"].map((t, i) => h("th", { scope: "col", class: i > 0 && i < 4 ? "align-end" : "align-start", text: t })))
          ),
          h(
            "tbody",
            null,
            ranAttempts.map((r) =>
              h(
                "tr",
                null,
                h("td", { text: `#${r.n}` }),
                h("td", { class: "align-end t-num", text: r.durationMs != null ? formatDuration(r.durationMs) : dash }),
                h("td", { class: "align-end t-num", text: r.exitCode != null ? String(r.exitCode) : dash }),
                h("td", { class: "align-end", text: r.timedOut ? "Exceeded · killed" : r.timeoutS != null ? `${r.timeoutS} s` : dash }),
                h("td", { text: r.runtime || dash }),
                h("td", { text: r.removed === true ? "Destroyed" : r.removed === false ? "Retained" : dash })
              )
            )
          )
        )
      )
    : h("p", { class: "t-small c-3", text: attempts.length ? "No sandbox executions were reported for this run." : "No attempts were reported." });

  const caps = h(
    "ul",
    { class: "caps" },
    security.capabilities.map((c) =>
      h(
        "li",
        { class: `cap${c.observed ? " cap--observed" : ""}` },
        mark(c.observed ? (c.status === "failed" ? "failed" : "done") : "skipped", { size: "sm", label: c.observed ? "Observed in this run" : "Not reported for this run" }),
        h(
          "div",
          { class: "cap__body" },
          h("p", { class: "cap__label", text: c.label }),
          h("p", { class: "cap__note t-small c-3", text: c.observed ? c.notes.join(" ") || capitalize(c.status) : "Not reported for this run." })
        )
      )
    )
  );

  return h(
    "div",
    { class: "security" },
    h(
      "p",
      { class: "t-lead security__intro", text: "Generated code is never executed in your browser. The backend hands each attempt to the sandbox runner instead of running it on the host. Below is only what the backend reported for this run." }
    ),
    h("div", { class: "security__grid" }, h("div", null, h("h3", { class: "t-eyebrow", text: "Sandbox executions" }), runsTable, !security.hasTelemetry && ranAttempts.length ? h("p", { class: "t-micro c-3 security__legend", text: "— not reported by the backend." }) : null), h("div", null, h("h3", { class: "t-eyebrow", text: "Containment signals" }), caps))
  );
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
