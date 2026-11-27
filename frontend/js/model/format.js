/** Formatting helpers. Pure functions, no DOM. */

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}

/** mm:ss clock for live elapsed counters. */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const nfCache = new Map();
function nf(key, opts) {
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat("en-GB", opts));
  return nfCache.get(key);
}

export function formatNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "");
  return nf(`n${Number.isInteger(n) ? 0 : 2}`, {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
  }).format(n);
}

/** Currency formatting; SEK/NOK/DKK rendered Nordic-style ("79 kr"). */
export function formatMoney(n, currency) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "");
  const code = (currency || "").toUpperCase();
  const frac = Number.isInteger(n) ? 0 : 2;
  if (code === "SEK" || code === "NOK" || code === "DKK") {
    // Nordic grouping with a (narrow) no-break space: 64 950 kr, matching the backend's text.
    const t = nf(`kr${frac}`, { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(n);
    return `${t.replace(/,/g, "\u202f").replace(/\./g, ",")} kr`;
  }
  if (code) {
    try {
      return nf(`c${code}${frac}`, {
        style: "currency",
        currency: code,
        minimumFractionDigits: frac,
        maximumFractionDigits: frac,
      }).format(n);
    } catch {
      /* unknown currency code: fall through */
    }
  }
  return formatNumber(n);
}

/** "price_sek" → "Price", "productName" → "Product name". */
export function humanizeKey(key, { stripCurrency = true } = {}) {
  let k = String(key);
  if (stripCurrency) k = k.replace(/[_-](sek|usd|eur|gbp|nok|dkk|jpy|chf)$/i, "");
  k = k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

export function pluralize(n, one, many = `${one}s`) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function formatTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** "just now", "4 min ago", "yesterday 14:02", "3 Nov 2026" — precise time goes in a title. */
export function relativeTime(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const s = Math.round((now - date) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86400000);
  if (days === 0) return `today ${hm}`;
  if (days === 1) return `yesterday ${hm}`;
  if (days < 7) return `${new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(date)} ${hm}`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined }).format(date);
}
