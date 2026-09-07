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
  *   - `'single-quoted strings'` (with `''` and `\` escapes for MySQL / E'..')
  *   - `"double-quoted identifiers"` (with `""` escape)
  *   - `` `backtick identifiers` `` (MySQL, with ```` `` ```` and `\` escapes)
  *   - `$$ ... $$` and `$tag$ ... $tag$` dollar-quoted bodies
  *   - `--` and `#` (MySQL) line comments
  *   - `/* block comments *‌/`
 *
 * Empty statements (e.g. trailing `;`) are dropped.
 *
 * MySQL `DELIMITER` directives are honoured so procedures/triggers with
 * `;` inside `BEGIN ... END` survive as one statement:
 *   DELIMITER $$
 *   CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$
 *   DELIMITER ;
 *   SELECT 1
 * The DELIMITER lines themselves are consumed, never emitted.
 *
 * Refs: https://github.com/openidle-dev/queryden/issues/20
 */
export interface SqlStatement {
  /** Trimmed statement text, without the terminating semicolon/delimiter. */
  text: string;
  /** Byte offset of the first non-whitespace character of the statement. */
  start: number;
  /** Byte offset of the terminator (`;`/custom delimiter) or end of input. */
  end: number;
  /** 1-based line number in the original SQL where the statement begins. */
  lineNumber: number;
}

const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** True when `sql[stmtStart..pos]` holds only whitespace/comments. */
function isAtStatementStart(sql: string, stmtStart: number, pos: number): boolean {
  const raw = sql.slice(stmtStart, pos);
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
  const noHash = noLine
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("#");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
  return noHash.trim().length === 0;
}

export function splitStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let i = 0;
  let stmtStart = 0;
  let delimiter = ";";

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

    // Custom-delimiter terminator (MySQL DELIMITER mode): checked before
    // dollar-quote handling so `$$` as a delimiter isn't eaten as a quote.
    if (delimiter !== ";" && sql.startsWith(delimiter, i)) {
      emit(i);
      i += delimiter.length;
      stmtStart = i;
      continue;
    }

    // DELIMITER directive at a statement boundary: `DELIMITER $$` etc.
    // Only recognised at top level at the start of a statement so a table
    // called `delimiter` mid-query can never trigger it. Only the next
    // token is consumed (plus one newline), so `DELIMITER ; SELECT 2` on a
    // single line still leaves `SELECT 2` as a runnable statement.
    if (isAtStatementStart(sql, stmtStart, i)) {
      let j = i;
      while (j < sql.length && (sql[j] === " " || sql[j] === "\t" || sql[j] === "\r")) j++;
      if (
        sql.slice(j, j + 9).toUpperCase() === "DELIMITER" &&
        (j + 9 >= sql.length || /[\s;]/.test(sql[j + 9]))
      ) {
        let t = j + 9;
        while (t < sql.length && (sql[t] === " " || sql[t] === "\t" || sql[t] === "\r")) t++;
        if (sql[t] === ";") {
          // Bare `DELIMITER;` (no space) resets to the default.
          delimiter = ";";
          t++;
        } else {
          let tokEnd = t;
          while (tokEnd < sql.length && !/\s/.test(sql[tokEnd])) tokEnd++;
          const token = sql.slice(t, tokEnd);
          if (token.length > 0) delimiter = token;
          t = tokEnd;
        }
        while (t < sql.length && (sql[t] === " " || sql[t] === "\t" || sql[t] === "\r")) t++;
        if (sql[t] === "\n") t++;
        i = t;
        stmtStart = t;
        continue;
      }
    }

    if (c === "'") {
      i++;
      while (i < sql.length) {
        // Backslash escapes (MySQL \' \\, Postgres E'\'' / E'\\').
        // Treated universally: trailing-backslash-in-standard-string is far
        // rarer than MySQL backslash escapes, and missing it corrupts splits.
        if (sql[i] === "\\" && i + 1 < sql.length) {
          i += 2;
          continue;
        }
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

    if (c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") { i += 2; continue; }
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

    // MySQL `#` line comment (only when it starts a comment position).
    if (c === "#") {
      const prev = i === 0 ? "\n" : sql[i - 1];
      if (prev === "\n" || prev === "\r" || prev === ";" || prev === " " || prev === "\t" || prev === "(") {
        while (i < sql.length && sql[i] !== "\n") i++;
        continue;
      }
    }

    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "*" && sql[i + 1] === "/") { i += 2; break; }
        i++;
      }
      continue;
    }

    if (c === "$" && delimiter === ";") {
      const m = DOLLAR_TAG_RE.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const closeIdx = sql.indexOf(tag, bodyStart);
        i = closeIdx === -1 ? sql.length : closeIdx + tag.length;
        continue;
      }
    }

    if (delimiter === ";" && c === ";") {
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
