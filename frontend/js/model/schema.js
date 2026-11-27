/**
 * Schema inference for extracted records.
 *
 * The report is schema-driven: columns, types and summary statistics are
 * derived from whatever records the backend returns, so a product catalogue,
 * a staff directory or a list of articles all render sensibly.
 * Statistics are computed only from extracted values, never invented.
 */

import { formatMoney, formatNumber, humanizeKey } from "./format.js";

const CURRENCY_SUFFIX = /[_-](sek|usd|eur|gbp|nok|dkk|jpy|chf)$/i;
const MONEY_KEY = /(^|[_-])(price|cost|amount|total|fee|msrp)([_-]|$)/i;
const SAMPLE = 500;

/** @typedef {{key:string,label:string,type:'money'|'number'|'boolean'|'url'|'text'|'json',currency:string|null,align:'start'|'end'}} Column */

export function inferColumns(rows) {
  const records = rows.filter((r) => r && typeof r === "object" && !Array.isArray(r));
  if (!records.length) {
    // A flat list of primitives renders as a single "Value" column.
    return rows.length ? [{ key: "__value", label: "Value", type: typeOf(rows), currency: null, align: "start" }] : [];
  }
  const keys = [];
  const seen = new Set();
  for (const r of records.slice(0, SAMPLE)) {
    for (const k of Object.keys(r)) {
      if (k.startsWith("_") || seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
  }
  return keys.map((key) => {
    const values = records.slice(0, SAMPLE).map((r) => r[key]).filter((v) => v !== null && v !== undefined && v !== "");
    let type = typeOf(values);
    const cur = key.match(CURRENCY_SUFFIX);
    let currency = cur ? cur[1].toUpperCase() : null;
    if (type === "number" && (currency || MONEY_KEY.test(key))) type = "money";
    if (type !== "money") currency = null;
    return {
      key,
      label: humanizeKey(key),
      type,
      currency,
      align: type === "money" || type === "number" ? "end" : "start",
    };
  });
}

function typeOf(values) {
  if (!values.length) return "text";
  if (values.every((v) => typeof v === "number" && Number.isFinite(v))) return "number";
  if (values.every((v) => typeof v === "boolean")) return "boolean";
  if (values.every((v) => typeof v === "string" && /^https?:\/\//i.test(v))) return "url";
  if (values.some((v) => typeof v === "object")) return "json";
  return "text";
}

export function cellValue(row, col) {
  return col.key === "__value" ? row : row?.[col.key];
}

/** Display string for a cell. Always plain text: never HTML. */
export function formatCell(value, col) {
  if (value === null || value === undefined || value === "") return "—";
  switch (col.type) {
    case "money":
      return typeof value === "number" ? formatMoney(value, col.currency) : String(value);
    case "number":
      return typeof value === "number" ? formatNumber(value) : String(value);
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "json":
      try {
        return typeof value === "object" ? JSON.stringify(value) : String(value);
      } catch {
        return String(value);
      }
    default:
      return String(value);
  }
}

export function sortRows(rows, col, dir) {
  if (!col) return rows;
  const mult = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = cellValue(a, col);
    const vb = cellValue(b, col);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
    return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * mult;
  });
}

/** The column most likely to name each record (for evidence lists, captions). */
export function primaryColumn(columns) {
  return (
    columns.find((c) => /^(name|title|product|product_name|label|heading)$/i.test(c.key)) ||
    columns.find((c) => c.type === "text") ||
    columns[0] ||
    null
  );
}

/** Summary statistics computed from extracted values. */
export function summarize(rows, columns) {
  const stats = [{ key: "count", label: "Records", value: formatNumber(rows.length) }];
  const money = columns.find((c) => c.type === "money");
  const numeric = money || null;
  if (numeric) {
    const nums = rows.map((r) => cellValue(r, numeric)).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (nums.length >= 2) {
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const fmt = (n) => formatMoney(Math.round(n * 100) / 100, numeric.currency);
      stats.push(
        { key: "min", label: `Lowest ${numeric.label.toLowerCase()}`, value: fmt(sorted[0]) },
        { key: "median", label: `Median ${numeric.label.toLowerCase()}`, value: fmt(median) },
        { key: "max", label: `Highest ${numeric.label.toLowerCase()}`, value: fmt(sorted[sorted.length - 1]) }
      );
    }
  }
  return stats;
}
