import { describe, it, expect } from "vitest";
// Monaco's own Monarch compiler + lexer, run headless with stub services so
// the grammar is tested exactly as the editor will execute it.
// @ts-expect-error - internal Monaco path, no .d.ts shipped
import { compile } from "monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js";
// @ts-expect-error - internal Monaco path, no .d.ts shipped
import { MonarchTokenizer } from "monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js";
import { encodeSemanticTokens, sqlMonarchLanguage } from "./sqlLanguage";
import { classifySqlSpans } from "./completionContext";

const tokenizer = new MonarchTokenizer(
  {
    languageIdCodec: { encodeLanguageId: () => 0 },
    isRegisteredLanguageId: () => false,
    getLanguageIdByLanguageName: () => null,
    requestBasicLanguageFeatures: () => {},
  },
  { getColorTheme: () => ({ tokenTheme: {} }) },
  "sql",
  compile("sql", sqlMonarchLanguage),
  { getValue: () => 20000, onDidChangeConfiguration: () => ({ dispose() {} }) },
);

/** `text` → [["select", "keyword"], …] with whitespace dropped and `.sql` stripped. */
function tokenize(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let state = tokenizer.getInitialState();
  for (const line of text.split("\n")) {
    const result = tokenizer.tokenize(line, true, state);
    result.tokens.forEach((t: { offset: number; type: string }, i: number) => {
      const end = result.tokens[i + 1]?.offset ?? line.length;
      const piece = line.slice(t.offset, end);
      if (piece.trim()) out.push([piece, t.type.replace(/\.sql$/, "")]);
    });
    state = result.endState;
  }
  return out;
}

const typeOf = (text: string, piece: string) => tokenize(text).find(([p]) => p === piece)?.[1];

describe("SQL grammar", () => {
  it("colours every clause keyword the same, regardless of case", () => {
    const sql = "select a from t join u on t.id = u.id left join v using (id) where x group by a having b order by a limit 1";
    for (const kw of ["select", "from", "join", "on", "left", "using", "where", "group", "by", "having", "order", "limit"]) {
      expect(typeOf(sql, kw), kw).toBe("keyword");
    }
    expect(typeOf("UPDATE t SET a = 1", "SET")).toBe("keyword");
  });

  it("matches the reference screenshot: keywords, identifiers, string", () => {
    expect(tokenize("select * from allie_matching_payments_lookup ampl\nwhere ampl.id_number = '5601125707083'")).toEqual([
      ["select", "keyword"],
      ["*", "operator"],
      ["from", "keyword"],
      ["allie_matching_payments_lookup", "identifier"],
      ["ampl", "identifier"],
      ["where", "keyword"],
      ["ampl", "identifier"],
      [".", "delimiter.dot"],
      ["id_number", "identifier"],
      ["=", "operator"],
      ["'5601125707083'", "string"],
    ]);
  });

  it("treats qualified names as identifiers even when they are keywords", () => {
    expect(typeOf("select u.type from t u", "type")).toBe("identifier");
    expect(typeOf("select user.id from t", "user")).toBe("identifier");
  });

  it("colours functions, types, numbers and comments", () => {
    expect(typeOf("select coalesce(a, 1)", "coalesce")).toBe("predefined");
    expect(typeOf("select my_func(a)", "my_func")).toBe("function");
    expect(typeOf("select a::jsonb", "jsonb")).toBe("type");
    expect(typeOf("create table t (id bigint)", "bigint")).toBe("type");
    expect(typeOf("select 1.5e3", "1.5e3")).toBe("number");
    expect(typeOf("select 1 -- note", "-- note")).toBe("comment");
  });

  it("keeps dollar-quoted bodies as one string (apostrophes inside don't leak)", () => {
    const toks = tokenize("DO $$ BEGIN RAISE NOTICE 'it''s'; END $$;\nselect 1");
    expect(toks[0]).toEqual(["DO", "keyword"]);
    expect(toks.find(([p]) => p === "select")?.[1]).toBe("keyword");
    expect(toks.some(([p, t]) => p.includes("RAISE") && t === "string")).toBe(true);
  });

  it("handles E'' escapes, nested comments, backticks and parameters", () => {
    const last = (sql: string) => { const t = tokenize(sql); return t[t.length - 1]; };
    expect(last("select E'it\\'s' , 1")).toEqual(["1", "number"]);
    expect(last("/* a /* b */ c */ select")).toEqual(["select", "keyword"]);
    expect(typeOf("select `my col` from t", "my col")).toBe("identifier");
    expect(typeOf("select $1", "$1")).toBe("variable");
    expect(typeOf("set @x = 1", "@x")).toBe("variable");
    expect(typeOf("select a @> b", "@>")).toBe("operator");
  });

  it("treats ARRAY[...] brackets as brackets, not identifiers", () => {
    expect(typeOf("select ARRAY['vip']", "'vip'")).toBe("string");
  });
});

describe("semantic token encoding", () => {
  it("encodes spans as Monaco relative 5-tuples across lines", () => {
    const text = "select * from users u\nwhere u.id = 1";
    const data = encodeSemanticTokens(text, classifySqlSpans(text));
    // users(table) at 0:14, u(alias) at 0:20, u(alias) at 1:6
    expect(data).toEqual([0, 14, 5, 0, 0, 0, 6, 1, 2, 0, 1, 6, 1, 2, 0]);
  });
});
