/**
 * Evidence viewer: the real page screenshot beside the extracted values and
 * their verification status. Regions are highlighted ONLY when the backend
 * supplies coordinates; otherwise the viewer says so instead of guessing.
 */

import { h, icon } from "../dom.js";
import { mark } from "./ui.js";
import { cellValue, formatCell } from "../model/schema.js";

export function screenshotFrame(src, { alt = "Screenshot of the source page", boxes = [], onOpen } = {}) {
  const img = h("img", { src, alt, class: "shot__img", decoding: "async" });
  const layer = h("div", { class: "shot__boxes", "aria-hidden": "true" });
  const frame = h(
    "div",
    { class: "shot" },
    h("div", { class: "shot__chrome", "aria-hidden": "true" }, h("span"), h("span"), h("span")),
    h("div", { class: "shot__canvas" }, img, layer),
    onOpen
      ? h("button", { class: "shot__open", type: "button", "aria-label": "View screenshot full size", onClick: onOpen }, icon("expand", { size: 14 }))
      : null
  );

  const draw = () => {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    layer.replaceChildren();
    if (!W || !H) return;
    // Placeholder-sized images (e.g. a 1×1 mock PNG) are reported, not stretched.
    if (W < 32 || H < 32) {
      frame.classList.add("shot--tiny");
      frame.querySelector(".shot__canvas").append(h("p", { class: "shot__tiny t-small c-3", text: `The backend returned a ${W}×${H} px image, too small to show as evidence.` }));
      return;
    }
    for (const b of boxes) {
      if (!b.box) continue;
      layer.append(
        h("span", {
          class: `shot__box${b.active ? " is-active" : ""}`,
          dataset: { index: String(b.index) },
          style: {
            left: `${(b.box.x / W) * 100}%`,
            top: `${(b.box.y / H) * 100}%`,
            width: `${(b.box.w / W) * 100}%`,
            height: `${(b.box.h / H) * 100}%`,
          },
        })
      );
    }
  };
  if (img.complete) queueMicrotask(draw);
  img.addEventListener("load", draw);

  frame.setActive = (index) => {
    for (const el of layer.children) el.classList.toggle("is-active", el.dataset.index === String(index));
    const active = layer.querySelector(".is-active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  };
  return frame;
}

export function lightbox(src, alt) {
  const dlg = h(
    "dialog",
    { class: "lightbox", "aria-label": alt },
    h("button", { class: "lightbox__close btn btn--ghost btn--sm", type: "button", "aria-label": "Close", onClick: () => dlg.close() }, icon("x")),
    h("div", { class: "lightbox__scroll" }, h("img", { src, alt }))
  );
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/**
 * @param job normalized job
 * @param columns inferred columns
 * @param primary column naming each record
 */
export function evidenceViewer(job, columns, primary) {
  const { screenshot, results, evidence, finalAttempt } = job;
  const valueCol = columns.find((c) => c.type === "money") || columns.find((c) => c !== primary) || null;
  const setVerdict = finalAttempt?.verdict || "pending";

  if (!screenshot) {
    return h("div", { class: "empty" }, h("p", { class: "empty__title", text: "No screenshot available" }), h("p", { class: "empty__body", text: "The backend did not return visual evidence for this run, so values can’t be checked visually here." }));
  }

  const boxes = results.map((_, i) => ({ index: i, box: evidence.byIndex.get(i)?.box || null }));
  const frame = screenshotFrame(screenshot, { boxes, onOpen: () => lightbox(screenshot, "Screenshot of the source page") });

  const itemStatus = (i) => {
    const e = evidence.byIndex.get(i);
    if (e && e.verified !== null) return e.verified ? "done" : "failed";
    return setVerdict === "verified" ? "done" : setVerdict === "rejected" ? "failed" : "pending";
  };

  const list = results.length
    ? h(
        "ol",
        { class: "evidence__list" },
        results.map((r, i) => {
          const hasBox = !!boxes[i].box;
          const st = itemStatus(i);
          const content = [
            h("span", { class: "evidence__idx t-micro t-num c-3", text: String(i + 1).padStart(2, "0") }),
            h("span", { class: "evidence__name truncate", text: primary ? formatCell(cellValue(r, primary), primary) : JSON.stringify(r) }),
            valueCol ? h("span", { class: "evidence__value t-num", text: formatCell(cellValue(r, valueCol), valueCol) }) : null,
            mark(st, { size: "sm", label: st === "done" ? "Verified" : st === "failed" ? "Not verified" : "Not checked" }),
          ];
          const li = h("li", { class: "evidence__item" }, hasBox ? h("button", { class: "evidence__row", type: "button", "aria-label": `Locate item ${i + 1} in screenshot` }, content) : h("div", { class: "evidence__row" }, content));
          if (hasBox) {
            const btn = li.firstChild;
            const activate = () => {
              list.querySelectorAll(".evidence__row.is-active").forEach((x) => x.classList.remove("is-active"));
              btn.classList.add("is-active");
              frame.setActive(i);
            };
            btn.addEventListener("click", activate);
            btn.addEventListener("mouseenter", activate);
            btn.addEventListener("focus", activate);
          }
          return li;
        })
      )
    : h("p", { class: "t-small c-3", text: "No records were extracted to compare." });

  const verdictText =
    setVerdict === "verified"
      ? "The vision check confirmed the extracted values against this screenshot."
      : setVerdict === "rejected"
        ? "The vision check found that the extracted values did not match this screenshot."
        : "No visual verification verdict was reported for these values.";

  const notes = [
    h("p", { class: "evidence__verdict t-small" }, mark(setVerdict === "verified" ? "done" : setVerdict === "rejected" ? "failed" : "pending", { size: "sm" }), h("span", { text: verdictText })),
    finalAttempt?.reason && finalAttempt.reason !== "generated (not run yet)" ? h("p", { class: "evidence__reason t-small c-2", text: `“${finalAttempt.reason}”` }) : null,
    !evidence.hasBoxes && results.length
      ? h("p", { class: "t-micro c-3", text: evidence.hasItemVerdicts ? "Region coordinates were not provided, so values can’t be pinned to locations in the screenshot." : "Verification was reported for the set as a whole. Region coordinates were not provided, so values can’t be pinned to locations in the screenshot." })
      : evidence.hasBoxes
        ? h("p", { class: "t-micro c-3", text: "Hover or select a record to locate it in the screenshot." })
        : null,
  ];

  return h("div", { class: "evidence" }, h("div", { class: "evidence__shot" }, frame), h("div", { class: "evidence__side" }, h("div", { class: "evidence__notes" }, notes), list));
}
