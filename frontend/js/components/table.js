/** Schema-driven, sortable data table. All cells are plain text. */

import { h, icon, replace } from "../dom.js";
import { cellValue, formatCell, sortRows } from "../model/schema.js";
import { safeHref } from "../url.js";

export function dataTable(rows, columns, { caption, filterable = rows.length > 8, rowMarker = null, markerLabel = "Status" } = {}) {
  let sortCol = null;
  let sortDir = "asc";
  let query = "";

  const tbody = h("tbody");
  const count = h("span", { class: "table__count t-micro c-3 t-num", "aria-live": "polite" });
  const headers = columns.map((col) => {
    const btn = h("button", { class: "th-btn", type: "button" }, h("span", { text: col.label }), h("span", { class: "th-btn__dir", "aria-hidden": "true" }, icon("chevron", { size: 12 })));
    const th = h("th", { scope: "col", class: `align-${col.align}`, "aria-sort": "none" }, btn);
    btn.addEventListener("click", () => {
      if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
      else {
        sortCol = col;
        sortDir = "asc";
      }
      render();
    });
    return { th, col };
  });

  function render() {
    for (const { th, col } of headers) {
      const active = sortCol === col;
      th.setAttribute("aria-sort", active ? (sortDir === "asc" ? "ascending" : "descending") : "none");
      th.classList.toggle("is-sorted", active);
      th.classList.toggle("is-desc", active && sortDir === "desc");
    }
    const q = query.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => columns.some((c) => formatCell(cellValue(r, c), c).toLowerCase().includes(q))) : rows;
    const sorted = sortRows(filtered, sortCol, sortDir);
    replace(
      tbody,
      sorted.length
        ? sorted.map((r) =>
            h(
              "tr",
              { class: rowMarker && rowMarker(r) ? "is-flagged" : null },
              rowMarker ? h("td", { class: "table__marker" }, rowMarker(r)) : null,
              columns.map((c) => {
                const v = cellValue(r, c);
                const text = formatCell(v, c);
                const href = c.type === "url" ? safeHref(v) : null;
                return h(
                  "td",
                  { class: `align-${c.align}${c.type === "money" || c.type === "number" ? " t-num" : ""}` },
                  href ? h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow", text }) : text
                );
              })
            )
          )
        : h("tr", null, h("td", { colspan: String(columns.length + (rowMarker ? 1 : 0)), class: "table__none c-3", text: "No records match your filter." }))
    );
    count.textContent = q ? `${sorted.length} of ${rows.length}` : `${rows.length} record${rows.length === 1 ? "" : "s"}`;
  }

  const filter = filterable
    ? h("input", {
        class: "input input--sm table__filter",
        type: "search",
        placeholder: "Filter",
        "aria-label": "Filter records",
        onInput: (e) => {
          query = e.target.value;
          render();
        },
      })
    : null;

  render();

  return h(
    "div",
    { class: "table" },
    h("div", { class: "table__tools" }, count, filter),
    h(
      "div",
      { class: "table__scroll", tabindex: "0", role: "region", "aria-label": caption || "Extracted records" },
      h("table", null, caption ? h("caption", { class: "sr-only", text: caption }) : null, h("thead", null, h("tr", null, rowMarker ? h("th", { scope: "col", class: "table__marker" }, h("span", { class: "sr-only", text: markerLabel })) : null, headers.map((x) => x.th))), tbody)
    )
  );
}
