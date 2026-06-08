/**
 * Resolve which top-level SQL statement the caret sits in (or nearest to),
 * given the full editor text and a 0-based character offset.
 *
 * Why this exists: the editor's "run at cursor" command (Ctrl+Enter) and the
 * persistent "this block will run" highlight must agree on *exactly* which
 * statement is targeted, otherwise the highlight lies about what executes.
 * Both code paths call this one function so they can never drift.
 *
 * The resolution mirrors the long-standing run-at-cursor behaviour:
 *   - statements are separated on top-level-ish semicolons,
 *   - if the caret is inside a statement, that statement wins,
 *   - if the caret is in the whitespace between two statements, the one
 *     *before* the caret wins (you typically run what you just typed),
 *   - if the caret is past the last statement, the last statement wins,
 *   - otherwise fall back to the first statement.
 *
 * Note: this uses a plain `;` scan rather than the lexer-aware
 * {@link ./splitStatements} so it stays byte-for-byte compatible with the
 * existing run-at-cursor selection. Switching both paths to the lexer-aware
 * splitter is a deliberate follow-up, not part of this change.
 */
export interface CursorStatement {
  /** 0-based offset of the statement's first non-whitespace character. */
  start: number;
  /** 0-based offset of the terminating `;` (or end of text). */
  end: number;
  /** Trimmed statement text, without the terminating semicolon. */
  text: string;
  /** 1-based line number where the statement begins. */
  lineNumber: number;
}

/** Split `text` into the same statement spans the run-at-cursor path uses. */
function collectStatements(text: string): CursorStatement[] {
  const statements: CursorStatement[] = [];
  let searchFrom = 0;

  const lineAt = (pos: number): number => {
    let line = 1;
    for (let k = 0; k < pos; k++) {
      if (text.charCodeAt(k) === 10 /* \n */) line++;
    }
    return line;
  };

  while (searchFrom < text.length) {
    const semiPos = text.indexOf(";", searchFrom);
    const endPos = semiPos === -1 ? text.length : semiPos;

    // Skip leading whitespace so `start`/`lineNumber` anchor to real content.
    let startPos = searchFrom;
    while (startPos < endPos && /\s/.test(text[startPos])) {
      startPos++;
    }

    const statement = text.substring(startPos, endPos).trim();
    if (statement) {
      statements.push({ start: startPos, end: endPos, text: statement, lineNumber: lineAt(startPos) });
    }

    if (semiPos === -1) break;
    searchFrom = semiPos + 1;
  }

  return statements;
}

/**
 * Return the statement the caret targets, or `null` when there is no runnable
 * statement (empty / whitespace-only text).
 */
export function resolveStatementAtOffset(text: string, offset: number): CursorStatement | null {
  const statements = collectStatements(text);
  if (statements.length === 0) return null;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const next = statements[i + 1];

    // Caret inside the statement bounds.
    if (offset >= stmt.start && offset <= stmt.end) return stmt;

    // Caret in the gap after this statement and before the next one:
    // prefer the statement just before the caret.
    if (next && offset > stmt.end && offset < next.start) return stmt;
  }

  // Caret past the end of the last statement.
  const last = statements[statements.length - 1];
  if (offset > last.end) return last;

  // Fallback (e.g. caret in leading whitespace before the first statement).
  return statements[0];
}
