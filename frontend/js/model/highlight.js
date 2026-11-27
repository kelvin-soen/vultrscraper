/**
 * Tiny Python tokenizer for monochrome syntax highlighting.
 * Returns [{type, text}] tokens; the code view turns each into a span with
 * textContent, so generated code is never interpreted as markup.
 */

const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" ")
);
const BUILTINS = new Set("print len int str float list dict set tuple range enumerate open isinstance sorted min max sum any all zip map filter".split(" "));

const RE = new RegExp(
  [
    String.raw`(?<comment>#[^\n]*)`,
    String.raw`(?<string>[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))`,
    String.raw`(?<number>\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)`,
    String.raw`(?<word>[A-Za-z_][A-Za-z0-9_]*)`,
  ].join("|"),
  "g"
);

export function tokenizePython(src) {
  const text = String(src ?? "");
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(RE)) {
    if (m.index > last) tokens.push({ type: "plain", text: text.slice(last, m.index) });
    const g = m.groups;
    let type = "plain";
    if (g.comment) type = "comment";
    else if (g.string) type = "string";
    else if (g.number) type = "number";
    else if (g.word) {
      if (KEYWORDS.has(g.word)) type = "keyword";
      else if (BUILTINS.has(g.word)) type = "builtin";
      else if (text[m.index + g.word.length] === "(") type = "call";
    }
    tokens.push({ type, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ type: "plain", text: text.slice(last) });
  return tokens;
}
