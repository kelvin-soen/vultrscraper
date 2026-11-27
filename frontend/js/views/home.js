/** State 1 — URL input. */

import { h, icon } from "../dom.js";
import { validateUrl } from "../url.js";
import { DEMO_TARGETS } from "../config.js";

/**
 * @param {{ onSubmit: (url: string) => Promise<void>, initialUrl?: string, initialError?: string }} ctx
 */
export function homeView({ onSubmit, initialUrl = "", initialError = "" }) {
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
    )
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
