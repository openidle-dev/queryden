/**
 * Split a SQL script into top-level statements.
 *
 * Why this exists: PostgreSQL's extended query protocol — which the
 * Tauri SQL plugin uses for prepared statements — rejects multiple
 * commands per `execute` call with the error
 *
 *   "cannot insert multiple commands into a prepared statement"
 *
 * To run a multi-statement script we have to split it client-side and
 * execute each statement separately. A naive `sql.split(';')` corrupts
 * any query that contains a semicolon inside a string literal, a
 * dollar-quoted function body, or a comment. This scanner tracks the
 * SQL lexer state and only emits a split on a semicolon that is
 * genuinely at top level.
 *
 * Contexts that are skipped:
 *   - `'single-quoted strings'` (with `''` escape)
 *   - `"double-quoted identifiers"` (with `""` escape)
 *   - `$$ ... $$` and `$tag$ ... $tag$` dollar-quoted bodies
 *   - `-- line comments`
 *   - `/* block comments *‌/`
 *
 * Empty statements (e.g. trailing `;`) are dropped.
 *
 * Refs: https://github.com/openidle-dev/queryden/issues/20
 */
export interface SqlStatement {
  /** Trimmed statement text, without the terminating semicolon. */
  text: string;
  /** Byte offset of the first non-whitespace character of the statement. */
  start: number;
  /** Byte offset one past the terminating `;` (or end of input). */
  end: number;
  /** 1-based line number in the original SQL where the statement begins. */
  lineNumber: number;
}

const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

export function splitStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let i = 0;
  let stmtStart = 0;

  const emit = (end: number) => {
    const raw = sql.slice(stmtStart, end);
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    // Locate the first non-whitespace char to anchor `start` and lineNumber
    const leadingWs = raw.length - raw.trimStart().length;
    const realStart = stmtStart + leadingWs;
    let lineNumber = 1;
    for (let k = 0; k < realStart; k++) {
      if (sql.charCodeAt(k) === 10 /* \n */) lineNumber++;
    }
    statements.push({ text: trimmed, start: realStart, end, lineNumber });
  };

  while (i < sql.length) {
    const c = sql[i];

    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "*" && sql[i + 1] === "/") { i += 2; break; }
        i++;
      }
      continue;
    }

    if (c === "$") {
      const m = DOLLAR_TAG_RE.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const closeIdx = sql.indexOf(tag, bodyStart);
        i = closeIdx === -1 ? sql.length : closeIdx + tag.length;
        continue;
      }
    }

    if (c === ";") {
      emit(i);
      i++;
      stmtStart = i;
      continue;
    }

    i++;
  }

  // Trailing statement without a closing semicolon
  emit(i);

  return statements;
}
