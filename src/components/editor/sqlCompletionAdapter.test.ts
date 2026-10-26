import { describe, it, expect, vi } from "vitest";
// Monaco's own word finder and suggest-list filter, so these tests see what
// the suggest widget would show, not just what the provider returned.
// @ts-expect-error - internal Monaco path, no .d.ts shipped
import { ensureValidWordDefinition, getWordAtText } from "monaco-editor/editor/common/core/wordHelper.js";
// @ts-expect-error - internal Monaco path, no .d.ts shipped
import { fuzzyScore } from "monaco-editor/base/common/filters.js";
import { provideSqlCompletions, statementBoundsAt, type CompletionModelLike, type MonacoSuggestion } from "./sqlCompletionAdapter";
import { sqlLanguageConfiguration } from "./sqlLanguage";
import type { CompletionSchemaLike } from "./completionContext";

const SCHEMA: CompletionSchemaLike = {
  tables: ["table1", "reporting.releases", "reporting.servers"],
  views: [],
  functions: ["reporting.build_release_summary"],
  types: [],
  columns: [
    { table_name: "table1", column_name: "id", data_type: "integer" },
    { table_name: "table1", column_name: "name", data_type: "text" },
    { table_name: "reporting.releases", column_name: "version", data_type: "text" },
  ],
  foreignKeys: [],
};

const KINDS = { keyword: 17, function: 1, column: 3, table: 5, view: 7, schema: 8, type: 24, snippet: 27 };
const wordDefinition = ensureValidWordDefinition(sqlLanguageConfiguration.wordPattern);

/** A model over `text` that answers like Monaco's TextModel. */
function modelOf(text: string): CompletionModelLike {
  const lines = text.split("\n");
  return {
    getLineContent: (n) => lines[n - 1],
    getValue: () => text,
    getOffsetAt: ({ lineNumber, column }) =>
      lines.slice(0, lineNumber - 1).reduce((sum, l) => sum + l.length + 1, 0) + column - 1,
    getWordUntilPosition: ({ lineNumber, column }) => {
      const w = getWordAtText(column, wordDefinition, lines[lineNumber - 1], 0);
      if (!w) return { word: "", startColumn: column, endColumn: column };
      return { word: w.word.slice(0, column - w.startColumn), startColumn: w.startColumn, endColumn: column };
    },
  };
}

/** Labels the suggest widget would list at `|`, in Monaco's filter order of acceptance. */
function visible(sqlWithCaret: string, schema: CompletionSchemaLike | null = SCHEMA): string[] {
  const offset = sqlWithCaret.indexOf("|");
  const text = sqlWithCaret.replace(/\|/g, "");
  const before = text.slice(0, offset);
  const lineNumber = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  const position = { lineNumber, column };
  const { suggestions } = provideSqlCompletions(modelOf(text), position, { schema, dialect: "postgres", hashComments: false }, { kinds: KINDS, insertAsSnippet: 4 });
  const lineText = text.split("\n")[lineNumber - 1];
  return suggestions
    .filter((s: MonacoSuggestion) => {
      const r = s.range;
      if (r.startLineNumber !== lineNumber || r.endLineNumber !== lineNumber) return false;
      if (r.startColumn > column || r.endColumn < column) return false;
      if (typeof s.kind !== "number" || !s.label) return false;
      const word = lineText.slice(r.startColumn - 1, column - 1);
      if (word.trim() === "") return true;
      const target = s.filterText ?? s.label;
      return !!fuzzyScore(word, word.toLowerCase(), 0, target, target.toLowerCase(), 0);
    })
    .sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0))
    .map((s) => s.label);
}

describe("provideSqlCompletions (as the suggest widget sees it)", () => {
  it("lists a schema's tables after `schema.`, and narrows as you type", () => {
    expect(visible("select * from reporting.|")).toEqual(["releases", "servers", "build_release_summary"]);
    // Monaco's filter is fuzzy: `re` also hits build_release_summary.
    expect(visible("select * from reporting.re|")[0]).toBe("releases");
    expect(visible("select * from reporting.re|")).not.toContain("servers");
    expect(visible("select *\nfrom reporting.|\nwhere 1 = 1")).toContain("servers");
  });

  it("lists the FROM table's columns in SELECT, wherever the caret is", () => {
    expect(visible("select | from table1").slice(0, 2)).toEqual(["id", "name"]);
    expect(visible("select na| from table1")[0]).toBe("name");
    expect(visible("select * from table1 where |").slice(0, 2)).toEqual(["id", "name"]);
    expect(visible("select 1;\n\nselect | from table1").slice(0, 2)).toEqual(["id", "name"]);
  });

  it("lists tables after FROM, matching bare names of qualified tables", () => {
    expect(visible("select * from |")).toEqual(expect.arrayContaining(["table1", "reporting.releases", "reporting"]));
    expect(visible("select * from rel|")).toContain("reporting.releases");
  });

  it("offers statement keywords while typing the first word", () => {
    expect(visible("sel|")).toContain("SELECT");
  });

  it("still offers keywords when a catalogue row is malformed", () => {
    const broken = { tables: ["t", null], columns: [null, { table_name: null, column_name: "c" }] } as unknown as CompletionSchemaLike;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(visible("select * from |", broken)).toContain("t");
    expect(visible("select * from t where |", broken)).toContain("AND");
    spy.mockRestore();
  });

  it("works with no schema loaded yet", () => {
    expect(visible("select * from table1 where |", null)).toContain("AND");
    expect(visible("select * from reporting.|", null)).toEqual([]);
  });

  it("stays silent after a lone `:` (a :variable), but not after `::`", () => {
    expect(visible("select :|")).toEqual([]);
    expect(visible("select 1::|")).toContain("integer");
  });
});

describe("statementBoundsAt", () => {
  it("finds the statement around the caret and the gap between statements", () => {
    const text = "select 1;\n\nselect * from t";
    expect(statementBoundsAt(text, text.length, { hashComments: false })).toEqual({ start: 11, end: text.length });
    expect(statementBoundsAt(text, 10, { hashComments: false })).toEqual({ start: 9, end: 11 });
  });
});
