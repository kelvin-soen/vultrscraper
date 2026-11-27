/** Vertical execution timeline. Stage states come from model/job.js only. */

import { h } from "../dom.js";
import { mark } from "./ui.js";
import { repairRound } from "./healing.js";

export function stageList(job, { compact = false } = {}) {
  return h(
    "ol",
    { class: `stages${compact ? " stages--compact" : ""}`, "aria-label": "Execution stages" },
    job.stages.map((s) => {
      const isRepair = s.key === "repair";
      const showDesc = s.status === "active" && s.description;
      return h(
        "li",
        { class: `stage stage--${s.status}`, dataset: { key: s.key }, "aria-current": s.status === "active" ? "step" : null },
        h("div", { class: "stage__rail" }, mark(s.status)),
        h(
          "div",
          { class: "stage__body" },
          h("p", { class: "stage__label", text: s.label }),
          showDesc ? h("p", { class: "stage__desc", text: s.description }) : null,
          s.detail ? h("p", { class: "stage__detail", text: s.detail }) : null,
          isRepair && job.repairs.length
            ? h("div", { class: "stage__repairs" }, job.repairs.map((r) => repairRound(r, { layout: "list", total: job.repairs.length })))
            : null
        )
      );
    })
  );
}
