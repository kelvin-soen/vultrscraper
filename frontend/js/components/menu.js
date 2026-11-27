/**
 * Compact menus, toasts and site favicons.
 *
 * menuButton: WAI-ARIA menu button. Enter/Space/ArrowDown open, arrows move,
 * Escape/Tab/outside click close, focus returns to the trigger.
 */

import { h, icon, replace } from "../dom.js";

let openMenu = null;

/**
 * @param {string} label
 * @param {Array<{label:string, icon?:string, hint?:string, onSelect:Function, disabled?:boolean, separator?:boolean}>} items
 */
export function menuButton(label, items, { iconName, variant = "secondary", align = "end", ariaLabel } = {}) {
  const id = `menu-${Math.random().toString(36).slice(2, 8)}`;
  const trigger = h(
    "button",
    { class: `btn btn--${variant} btn--sm menu__trigger`, type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": id, "aria-label": ariaLabel || null },
    iconName ? icon(iconName) : null,
    label ? h("span", { text: label }) : null,
    label ? h("span", { class: "menu__caret", "aria-hidden": "true" }, icon("chevron", { size: 12 })) : null
  );
  const list = h("div", { class: `menu__list menu__list--${align}`, role: "menu", id, hidden: true, "aria-label": ariaLabel || label });
  const wrap = h("div", { class: "menu" }, trigger, list);

  const entries = [];
  for (const it of items.filter(Boolean)) {
    if (it.separator) {
      list.append(h("div", { class: "menu__sep", role: "separator" }));
      continue;
    }
    const b = h(
      "button",
      { class: "menu__item", type: "button", role: "menuitem", tabindex: "-1", disabled: it.disabled || null, title: it.title || null },
      h("span", { class: "menu__icon" }, it.icon ? icon(it.icon, { size: 14 }) : null),
      h("span", { class: "menu__label", text: it.label }),
      it.hint ? h("span", { class: "menu__hint", text: it.hint }) : null
    );
    b.addEventListener("click", async () => {
      close({ focus: true });
      await it.onSelect?.(b);
    });
    entries.push(b);
    list.append(b);
  }

  const enabled = () => entries.filter((e) => !e.disabled);

  function open(focusIndex = 0) {
    if (openMenu && openMenu !== api) openMenu.close();
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    wrap.classList.add("is-open");
    openMenu = api;
    // Keep the list on screen: flip to the side that has room.
    list.classList.remove("menu__list--start", "menu__list--end");
    list.classList.add(`menu__list--${align}`);
    const r = list.getBoundingClientRect();
    if (r.left < 8) list.classList.replace("menu__list--end", "menu__list--start");
    else if (r.right > document.documentElement.clientWidth - 8) list.classList.replace("menu__list--start", "menu__list--end");
    const items = enabled();
    items[(focusIndex + items.length) % items.length]?.focus();
    document.addEventListener("pointerdown", onOutside, true);
  }
  function close({ focus = false } = {}) {
    if (list.hidden) return;
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    wrap.classList.remove("is-open");
    if (openMenu === api) openMenu = null;
    document.removeEventListener("pointerdown", onOutside, true);
    if (focus) trigger.focus();
  }
  function onOutside(e) {
    if (!wrap.contains(e.target)) close();
  }

  trigger.addEventListener("click", () => (list.hidden ? open(0) : close()));
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      open(-1);
    }
  });
  list.addEventListener("keydown", (e) => {
    const items = enabled();
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close({ focus: true });
    } else if (e.key === "Tab") {
      close();
    }
  });

  const api = { el: wrap, close };
  return wrap;
}

/* ---- toast -------------------------------------------------------------- */

let toastEl = null;
let toastTimer = null;

/** Short confirmation in a polite live region ("Copied", "Downloaded …"). */
export function toast(message, { tone = "ok", ms = 2200 } = {}) {
  if (!toastEl) {
    toastEl = h("div", { class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(toastEl);
  }
  clearTimeout(toastTimer);
  toastEl.className = `toast toast--${tone}`;
  replace(toastEl, h("span", { class: "toast__icon" }, icon(tone === "error" ? "x" : "check", { size: 14 })), h("span", { text: message }));
  void toastEl.offsetWidth;
  toastEl.classList.add("is-visible");
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), ms);
}

/* ---- favicon ------------------------------------------------------------ */

/**
 * The site's own /favicon.ico, loaded straight from that origin (no third-party
 * favicon service, so no one else learns which sites are scraped). Falls back to a
 * monogram when the site has none or the image fails. referrerpolicy=no-referrer.
 */
export function favicon(url, { size = 20, name = "" } = {}) {
  let host = "";
  let origin = "";
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      host = u.hostname.replace(/^www\./, "");
      origin = u.origin;
    }
  } catch {
    /* not a URL */
  }
  // Bare IP hosts have no meaningful letter: use the page title's initial instead.
  const src = /^[a-z]/i.test(host) ? host : String(name || "").trim();
  const letter = /^[a-z0-9]/i.test(src) ? src[0].toUpperCase() : "·";
  const box = h("span", { class: "favicon", style: { "--fav": `${size}px` }, "aria-hidden": "true" }, h("span", { class: "favicon__mono", text: letter }));
  if (!origin) return box;
  const img = h("img", { class: "favicon__img", alt: "", width: String(size), height: String(size), loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", src: `${origin}/favicon.ico` });
  img.addEventListener("load", () => {
    if (img.naturalWidth > 1) box.classList.add("has-img");
    else img.remove();
  });
  img.addEventListener("error", () => img.remove());
  box.append(img);
  return box;
}
