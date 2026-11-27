/** State 1 — URL input. */

import { h, icon, replace, copyText } from "../dom.js";
import { displayUrl, hostOf, validateUrl } from "../url.js";
import { DEMO_TARGETS } from "../config.js";
import { clearHistory, listHistory, removeEntry } from "../model/history.js";
import { favicon, menuButton, toast } from "../components/menu.js";
import { mark } from "../components/ui.js";
import { formatTime, relativeTime } from "../model/format.js";
import { reportLink } from "../components/report-actions.js";

/**
 * @param {{ onSubmit: (url: string) => Promise<void>, initialUrl?: string, initialError?: string }} ctx
 */
export function homeView({ onSubmit, initialUrl = "", initialError = "", onOpen, onRunAgain }) {
  let busy = false;

  const input = h("input", {
    id: "url-input",
    class: "urlbar__input",
    type: "text",
    inputmode: "url",
    autocomplete: "url",
    autocapitalize: "off",
    spellcheck: "false",
    enterkeyhint: "go",
    placeholder: "Paste a website URL",
    value: initialUrl,
    "aria-describedby": "url-error url-hint",
  });
  const submit = h("button", { class: "urlbar__submit", type: "submit", "aria-label": "Start extraction" }, icon("arrowRight", { size: 18 }), h("span", { class: "spinner", "aria-hidden": "true" }));
  const error = h("p", { id: "url-error", class: "urlbar__error", role: "alert", "aria-live": "polite" });

  const form = h(
    "form",
    { class: "urlbar", novalidate: true, autocomplete: "off" },
    h("label", { class: "sr-only", for: "url-input", text: "Website URL" }),
    input,
    submit
  );

  const setError = (msg) => {
    error.textContent = msg || "";
    form.classList.toggle("is-invalid", !!msg);
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  };
  const setBusy = (b) => {
    busy = b;
    form.classList.toggle("is-busy", b);
    input.readOnly = b;
    submit.disabled = b;
    submit.setAttribute("aria-label", b ? "Starting…" : "Start extraction");
  };
  const syncFilled = () => form.classList.toggle("is-filled", input.value.trim().length > 0);

  input.addEventListener("input", () => {
    if (form.classList.contains("is-invalid")) setError("");
    syncFilled();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const v = validateUrl(input.value);
    if (!v.ok) {
      setError(v.error);
      form.classList.remove("shake");
      void form.offsetWidth;
      form.classList.add("shake");
      input.focus();
      return;
    }
    input.value = v.url;
    setError("");
    setBusy(true);
    try {
      await onSubmit(v.url);
    } catch (err) {
      setBusy(false);
      setError(err?.message || "Something went wrong. Please try again.");
      input.focus();
    }
  });

  const hint = h(
    "p",
    { id: "url-hint", class: "home__hint" },
    h("span", { class: "c-3", text: "Try" }),
    DEMO_TARGETS.map((t, i) => [
      i > 0 ? h("span", { class: "home__dot", "aria-hidden": "true", text: "·" }) : null,
      h("button", {
        class: "link-btn",
        type: "button",
        text: t.label,
        onClick: () => {
          input.value = t.url;
          syncFilled();
          setError("");
          input.focus();
        },
      }),
    ])
  );

  const view = h(
    "section",
    { class: "view home", "aria-labelledby": "home-title" },
    h("div", { class: "art-layer", "aria-hidden": "true" }),
    h(
      "div",
      { class: "home__inner" },
      h("h1", { id: "home-title", class: "t-display home__title" }, h("span", { text: "Any website," }), " ", h("span", { class: "home__title-2", text: "as structured data." })),
      h("p", { class: "t-lead home__lead", text: "Paste a URL. An agent reads the page, writes a scraper, runs it in an isolated sandbox and checks the results against a screenshot — repairing itself when the page changes." }),
      form,
      error,
      hint
    ),
    recentSection({ onOpen, onRunAgain })
  );

  if (initialError) setError(initialError);
  syncFilled();

  return {
    el: view,
    focus: () => {
      if (matchMedia("(hover: hover)").matches) input.focus({ preventScroll: true });
    },
    setBusy,
    setError,
  };
}

/* ---- recent extractions (this browser only) ------------------------------ */

const STATUS = {
  verified: ["done", "Verified"],
  repaired: ["done", "Self-healed"],
  unverified: ["skipped", "Unverified"],
  failed: ["failed", "Failed"],
  repair_failed: ["failed", "Repair failed"],
  running: ["active", "Running"],
};

function entryStatus(e) {
  if (e.status === "gone") return ["skipped", "No longer on server"];
  if (e.status === "running") return STATUS.running;
  return STATUS[e.outcome] || (e.status === "done" ? ["done", "Done"] : e.status === "failed" ? STATUS.failed : ["pending", "Unknown"]);
}

function recentSection({ onOpen, onRunAgain }) {
  const section = h("section", { class: "recent", "aria-labelledby": "recent-title" });
  let query = "";
  let showAll = false;

  function render() {
    const all = listHistory();
    if (!all.length) {
      replace(section);
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const q = query.trim().toLowerCase();
    const matches = q ? all.filter((e) => `${e.title || ""} ${e.url || ""}`.toLowerCase().includes(q)) : all;
    const LIMIT = 6;
    const shown = showAll || q ? matches : matches.slice(0, LIMIT);

    const search =
      all.length > 4
        ? h(
            "label",
            { class: "recent__search" },
            icon("search", { size: 14 }),
            h("input", {
              class: "recent__input",
              type: "search",
              placeholder: "Search history",
              "aria-label": "Search recent extractions",
              value: query,
              onInput: (e) => {
                query = e.target.value;
                const pos = e.target.selectionStart;
                render();
                const inp = section.querySelector(".recent__input");
                inp?.focus();
                inp?.setSelectionRange(pos, pos);
              },
            })
          )
        : null;

    replace(
      section,
      h(
        "header",
        { class: "recent__head" },
        h("h2", { id: "recent-title", class: "recent__title", text: "Recent" }),
        h("span", { class: "recent__scope", text: "Saved in this browser" }),
        search
      ),
      shown.length
        ? h("ul", { class: "recent__list" }, shown.map((e) => recentRow(e, { onOpen, onRunAgain, refresh: render })))
        : h("p", { class: "recent__none", text: `Nothing in your history matches “${query.trim()}”.` }),
      h(
        "div",
        { class: "recent__foot" },
        !q && !showAll && matches.length > LIMIT ? h("button", { class: "link-btn", type: "button", text: `Show all ${matches.length}`, onClick: () => ((showAll = true), render()) }) : h("span"),
        h("button", {
          class: "link-btn recent__clear",
          type: "button",
          text: "Clear history",
          onClick: () => {
            if (!confirm("Remove all recent extractions and saved reports from this browser? Runs on the server are not affected.")) return;
            clearHistory();
            render();
            toast("History cleared");
          },
        })
      )
    );
  }

  render();
  return section;
}

function recentRow(e, { onOpen, onRunAgain, refresh }) {
  const [st, label] = entryStatus(e);
  const host = (hostOf(e.url) || e.url || "").replace(/^www\./, "");
  const when = e.finishedAt || e.startedAt;
  const date = when ? new Date(when) : null;
  const facts = [];
  if (typeof e.records === "number" && e.status !== "running") facts.push(`${e.records} record${e.records === 1 ? "" : "s"}`);
  if (e.reused) facts.push("saved scraper");
  const open = h(
    "button",
    { class: "recent__open", type: "button", onClick: () => onOpen?.(e), "aria-label": `Open report for ${e.title || host}` },
    favicon(e.url, { size: 20, name: e.title }),
    h(
      "span",
      { class: "recent__text" },
      h("span", { class: "recent__name truncate", text: e.title || host || "Untitled" }),
      h("span", { class: "recent__url truncate t-mono", text: displayUrl(e.url || "") })
    ),
    h("span", { class: "recent__status" }, mark(st, { size: "sm" }), h("span", { class: "recent__label", text: label })),
    h("span", { class: "recent__facts t-num", text: facts.join(" · ") }),
    date ? h("time", { class: "recent__when t-num", datetime: date.toISOString(), title: formatTime(date), text: relativeTime(date) }) : h("span")
  );
  const more = menuButton(
    "",
    [
      { label: "Open report", icon: "arrowRight", onSelect: () => onOpen?.(e) },
      { label: "Run again", icon: "refresh", disabled: !e.url, onSelect: () => onRunAgain?.(e) },
      {
        label: "Copy link",
        icon: "link",
        onSelect: async () => {
          const ok = await copyText(reportLink({ id: e.id }));
          toast(ok ? "Report link copied" : "Couldn’t copy the link", { tone: ok ? "ok" : "error" });
        },
      },
      { separator: true },
      {
        label: "Remove from history",
        icon: "trash",
        onSelect: () => {
          removeEntry(e.id);
          refresh();
          toast("Removed from history");
        },
      },
    ],
    { iconName: "more", variant: "ghost", ariaLabel: `More actions for ${e.title || host}` }
  );
  return h("li", { class: `recent__row recent__row--${st}` }, open, more);
}
