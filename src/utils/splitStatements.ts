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
 *   - `--` line comments and `/* block comments *‌/`
 *   - `#` line comments, but ONLY with `{ hashComments: true }` (MySQL):
 *     by default `#` is code so PostgreSQL `#>`/`#>>` operators survive.
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

export function splitStatements(sql: string, opts?: { hashComments?: boolean }): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let i = 0;
  let stmtStart = 0;
  let delimiter = ";";
  const hashComments = opts?.hashComments === true;
  // Incremental "are we still at a statement start" flag. The old code
  // called isAtStatementStart(sql, stmtStart, i) on EVERY character, which
  // slices sql[stmtStart..i] plus regex/split passes — O(n²) over a long
  // statement, run on every keystroke and every Run All. Instead flip this
  // to false on the first non-whitespace, non-comment character and reset
  // it whenever stmtStart moves. The expensive DELIMITER scan below only
  // runs while the flag is still true (a few leading chars per statement).
  let atStmtStart = true;

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
      atStmtStart = true;
      continue;
    }

    // DELIMITER directive at a statement boundary: `DELIMITER $$` etc.
    // Only recognised at top level at the start of a statement so a table
    // called `delimiter` mid-query can never trigger it. Only the next
    // token is consumed (plus one newline), so `DELIMITER ; SELECT 2` on a
    // single line still leaves `SELECT 2` as a runnable statement.
    // Guarded by the incremental atStmtStart flag (O(1)) instead of
    // re-scanning sql[stmtStart..i] on every character (O(n²)).
    if (atStmtStart) {
      let j = i;
      while (j < sql.length && (sql[j] === " " || sql[j] === "\t" || sql[j] === "\r")) j++;
      // Allow comments/newlines between stmtStart and DELIMITER: only
      // whitespace scanned above; if j hits a comment marker, this isn't a
      // bare DELIMITER line — fall through to the comment branches below,
      // which preserve atStmtStart.
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
        atStmtStart = true;
        continue;
      }
    }

    if (c === "'") {
      atStmtStart = false;
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
      atStmtStart = false;
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
      atStmtStart = false;
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

    // `#` handling is dialect-gated (default: code, not a comment):
    // MySQL treats `#` to end-of-line as a comment (`SELECT * FROM logs#
    // LIMIT 1` must hide `# LIMIT 1`, otherwise limit-safety checks see a
    // limit MySQL ignores) — callers pass `{ hashComments: true }`.
    // PostgreSQL uses `#` inside operators (`#>`, `#>>` JSON operators,
    // `#!`, `#-`), so the default preserves it: `SELECT doc#>'{a}'; ...`
    // must still split into two statements.
    if (c === "#" && hashComments) {
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

    if (c === "$" && delimiter === ";") {
      const m = DOLLAR_TAG_RE.exec(sql.slice(i));
      if (m) {
        atStmtStart = false;
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
      atStmtStart = true;
      continue;
    }

    // Whitespace/newlines before the first real token keep us at the
    // statement start; any other character ends the leading trivia.
    if (c !== " " && c !== "\t" && c !== "\r" && c !== "\n") {
      atStmtStart = false;
    }
    i++;
  }

  // Trailing statement without a closing semicolon
  emit(i);

  return statements;
}
