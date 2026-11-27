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
          { class: "ledger ledger--compact" },
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
                h("td", { class: "align-end", text: r.timedOut ? "Exceeded, killed" : r.timeoutS != null ? `${r.timeoutS} s` : dash }),
                h("td", { text: r.runtime || dash }),
                h("td", { text: r.removed === true ? "Destroyed" : r.removed === false ? "Retained" : dash })
              )
            )
          )
        )
      )
    : h("p", { class: "t-small c-3", text: attempts.length ? "No sandbox executions were reported for this run." : "No attempts were reported." });

  const caps = h("ul", { class: "caps" }, security.capabilities.map(capItem));

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

const BENCHMARK_TIP = "Runtime-wide test, not observed in this run";

function capItem(c) {
  if (c.evidence === "run") {
    const label = c.badge || "Observed in this run";
    return h(
      "li",
      { class: "cap cap--observed" },
      mark(c.status === "failed" ? "failed" : "done", { size: "sm", label }),
      h(
        "div",
        { class: "cap__body" },
        h("p", { class: "cap__label" }, h("span", { text: c.label }), h("span", { class: "cap__badge", text: label })),
        h("p", { class: "cap__note t-small c-2", text: c.notes.join(" ") || capitalize(c.status) })
      )
    );
  }
  if (c.evidence === "benchmark") {
    return h(
      "li",
      { class: "cap cap--benchmark", title: BENCHMARK_TIP },
      mark(c.status === "failed" ? "failed" : "done", { size: "sm", label: BENCHMARK_TIP }),
      h("div", { class: "cap__body" }, h("p", { class: "cap__label", text: c.label }), h("p", { class: "cap__note t-small c-3", text: c.notes[0] }))
    );
  }
  return h(
    "li",
    { class: "cap" },
    mark("skipped", { size: "sm", label: "Not reported for this run" }),
    h("div", { class: "cap__body" }, h("p", { class: "cap__label", text: c.label }), h("p", { class: "cap__note t-small c-3", text: "Not reported for this run." }))
  );
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
