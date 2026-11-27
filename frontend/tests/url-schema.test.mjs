import { test } from "node:test";
import assert from "node:assert/strict";
import { validateUrl, displayUrl, safeHref } from "../js/url.js";
import { inferColumns, summarize, formatCell, sortRows } from "../js/model/schema.js";
import { formatMoney, humanizeKey } from "../js/model/format.js";
import { tokenizePython } from "../js/model/highlight.js";

test("validateUrl accepts common inputs and normalizes them", () => {
  assert.equal(validateUrl("example.com").url, "https://example.com/");
  assert.equal(validateUrl("  https://shop.se/a?b=1 ").url, "https://shop.se/a?b=1");
  assert.equal(validateUrl("http://70.34.217.56:8080/shop?v=2").url, "http://70.34.217.56:8080/shop?v=2");
  assert.equal(validateUrl("localhost:8080/shop").url, "http://localhost:8080/shop");
});

test("validateUrl rejects with human messages", () => {
  for (const bad of ["", "   ", "not a url", "ftp://x.com", "javascript:alert(1)", "http://foo", "http://999.1.1.1", "https://user:pw@x.com"]) {
    const r = validateUrl(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error.length > 5);
  }
});

test("safeHref only allows http(s)", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("https://a.se"), "https://a.se/");
  assert.equal(displayUrl("https://a.se/shop/"), "a.se/shop");
});

test("schema inference: official result shape becomes Name + Price (SEK)", () => {
  const cols = inferColumns([{ name: "Kaffe", price_sek: 79 }, { name: "Bröd", price_sek: 35 }]);
  assert.deepEqual(cols.map((c) => [c.key, c.label, c.type, c.currency]), [
    ["name", "Name", "text", null],
    ["price_sek", "Price", "money", "SEK"],
  ]);
  assert.equal(formatCell(79, cols[1]), "79 kr");
});

test("schema inference hides _private keys and handles mixed shapes", () => {
  const cols = inferColumns([{ title: "A", url: "https://a.se", _evidence: {} }, { title: "B", rating: 4.5 }]);
  assert.deepEqual(cols.map((c) => c.key), ["title", "url", "rating"]);
  assert.equal(inferColumns(["a", "b"])[0].label, "Value");
  assert.deepEqual(inferColumns([]), []);
});

test("summary statistics are computed from extracted values only", () => {
  const rows = [{ name: "a", price_sek: 10 }, { name: "b", price_sek: 30 }, { name: "c", price_sek: 20 }];
  const stats = summarize(rows, inferColumns(rows));
  const byKey = Object.fromEntries(stats.map((s) => [s.key, s.value]));
  assert.equal(byKey.count, "3");
  assert.equal(byKey.min, "10 kr");
  assert.equal(byKey.median, "20 kr");
  assert.equal(byKey.max, "30 kr");
  // No money column → only a record count.
  assert.equal(summarize([{ t: "x" }], inferColumns([{ t: "x" }])).length, 1);
});

test("sorting is numeric-aware and stable on nulls", () => {
  const cols = inferColumns([{ n: "b", p: 2 }, { n: "a", p: 10 }, { n: "c", p: null }]);
  const sorted = sortRows([{ n: "b", p: 2 }, { n: "a", p: 10 }, { n: "c", p: null }], cols[1], "asc");
  assert.deepEqual(sorted.map((r) => r.n), ["b", "a", "c"]);
});

test("formatting helpers", () => {
  assert.equal(formatMoney(1299, "SEK"), "1\u202f299 kr");
  assert.equal(formatMoney(64950.5, "SEK"), "64\u202f950,50 kr");
  assert.equal(humanizeKey("productName"), "Product name");
  assert.equal(humanizeKey("price_usd"), "Price");
});

test("python tokenizer round-trips source text exactly", () => {
  const src = 'import json\n# c\nx = f"{a}" + \'b\'\nprint(len([1, 2.5]))\n"""doc\n"""';
  assert.equal(tokenizePython(src).map((t) => t.text).join(""), src);
  const types = new Set(tokenizePython(src).map((t) => t.type));
  for (const t of ["keyword", "comment", "string", "number", "builtin"]) assert.ok(types.has(t), t);
});
