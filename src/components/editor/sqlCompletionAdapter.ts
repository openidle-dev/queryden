/**
 * Monaco-facing half of SQL completion: model + caret in, Monaco suggestion
 * objects out. Kept out of `QueryEditor` so it is tested against Monaco's own
 * word and filter logic, and guarded so one bad catalogue row can never turn
 * every suggestion off.
 */

import { buildCompletions, type CompletionItemLike, type CompletionKind } from "./completionProvider";
import type { CompletionSchemaLike } from "./completionContext";
import type { SqlDialect } from "./sqlBuiltins";
import { splitStatements } from "../../utils/splitStatements";

export interface CompletionPosition {
  lineNumber: number;
  column: number;
}

export interface CompletionModelLike {
  getLineContent(lineNumber: number): string;
  getValue(): string;
  getOffsetAt(position: CompletionPosition): number;
  getWordUntilPosition(position: CompletionPosition): { word: string; startColumn: number; endColumn: number };
}

export interface CompletionSource {
  schema: CompletionSchemaLike | null;
  dialect: SqlDialect;
  hashComments: boolean;
}

/** Monaco enum values, injected so this module never imports Monaco. */
export interface MonacoCompletionEnums {
  kinds: Record<CompletionKind, number>;
  insertAsSnippet: number;
}

export interface MonacoSuggestion {
  label: string;
  kind: number;
  insertText: string;
  insertTextRules?: number;
  detail?: string;
  documentation?: string;
  sortText: string;
  filterText?: string;
  range: { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number };
  command?: { id: string; title: string };
}

/**
 * Bounds of the statement around `offset`. Between statements (a blank line
 * after `;`) it is the empty span up to the next statement, so the previous
 * statement's tables don't leak into suggestions.
 */
export function statementBoundsAt(text: string, offset: number, opts: { hashComments: boolean }): { start: number; end: number } {
  const statements = splitStatements(text, opts);
  for (const st of statements) {
    if (offset >= st.start && offset <= st.end) return { start: st.start, end: st.end };
  }
  let start = 0;
  let end = text.length;
  for (const st of statements) {
    if (st.end < offset) start = st.end + 1;
    else if (st.start > offset) {
      end = st.start;
      break;
    }
  }
  return { start, end };
}

let lastReportedError = "";

export function provideSqlCompletions(
  model: CompletionModelLike,
  position: CompletionPosition,
  source: CompletionSource,
  enums: MonacoCompletionEnums,
): { suggestions: MonacoSuggestion[] } {
  const lineText = model.getLineContent(position.lineNumber);
  const before = lineText.slice(0, position.column - 1);
  // A lone `:` starts a :variable, not a `::` cast.
  if (before.endsWith(":") && !before.endsWith("::")) return { suggestions: [] };

  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  const request = (schema: CompletionSchemaLike | null) => {
    const bounds = statementBoundsAt(text, offset, { hashComments: source.hashComments });
    return buildCompletions({
      text,
      offset,
      statementStart: bounds.start,
      statementEnd: bounds.end,
      lineText,
      column: position.column,
      schema,
      dialect: source.dialect,
    });
  };

  let items: CompletionItemLike[];
  try {
    items = request(source.schema);
  } catch (e) {
    // Report once per distinct failure, then still offer keywords and
    // built-in functions rather than nothing.
    const message = e instanceof Error ? e.message : String(e);
    if (message !== lastReportedError) {
      lastReportedError = message;
      console.error("SQL completion failed; offering keywords only:", e);
    }
    try {
      items = request(null);
    } catch {
      items = [];
    }
  }

  const word = model.getWordUntilPosition(position);
  const endColumn = Math.max(word.endColumn, position.column);
  return {
    suggestions: items.map((it) => ({
      label: it.label,
      kind: enums.kinds[it.kind],
      insertText: it.insertText,
      ...(it.snippet ? { insertTextRules: enums.insertAsSnippet } : {}),
      detail: it.detail,
      documentation: it.documentation,
      sortText: it.sortText,
      filterText: it.filterText,
      range: {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: Math.min(it.replaceFromColumn ?? word.startColumn, position.column),
        endColumn,
      },
      // Typing `fn(` straight after accepting shows its arguments.
      command: it.triggerParameterHints
        ? { id: "editor.action.triggerParameterHints", title: "" }
        : it.retrigger
          ? { id: "editor.action.triggerSuggest", title: "" }
          : undefined,
    })),
  };
}
