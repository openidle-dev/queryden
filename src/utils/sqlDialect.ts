/**
 * Central SQL dialect helpers.
 *
 * Why this exists: statement classification (`isSelect`, `isDoBlock`,
 * destructive-operation detection), default ports, and identifier/literal
 * escaping were duplicated across MainContent, MultiQueryDialog,
 * ConnectionContext, CloneDialog and applyQueryLimit — each copy with
 * slightly different bugs (e.g. MainContent's DO regex missed
 * `DO LANGUAGE plpgsql $$`, ports missed mariadb/cockroach, destructive
 * checks matched keywords inside string literals like `deleted_items`).
 *
 * All keyword detection here runs on lexer-stripped SQL (strings,
 * dollar-quoted bodies and comments replaced with spaces) so keywords
 * inside literals, quoted identifiers, dollar bodies
 * or line and block comments never trigger false positives.
 */

export type KnownDbType =
  | "postgres"
  | "supabase"
  | "cockroach"
  | "mysql"
  | "mariadb"
  | "sqlite"
  | "sqlserver";

const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Lexer options for dialect-sensitive token handling.
 *
 * `hashComments`: treat `#` as a MySQL line comment. Default `false`:
 * PostgreSQL uses `#` inside operators (`#>`, `#>>` JSON operators, `#!`,
 * `#-`), so blanking `#…` unconditionally corrupts PG statements
 * (`SELECT doc#>'{a}'` would swallow the rest of the line). MySQL-family
 * callers opt in.
 */
export interface SqlLexerOptions {
  hashComments?: boolean;
}

/** True for PostgreSQL-wire-protocol engines. */
export function isPgLike(type: string | undefined | null): boolean {
  if (!type) return false;
  return ["postgres", "supabase", "cockroach"].includes(type.toLowerCase());
}

/** True for MySQL-wire-protocol engines. */
export function isMySqlLike(type: string | undefined | null): boolean {
  if (!type) return false;
  return ["mysql", "mariadb"].includes(type.toLowerCase());
}

/** True for SQL Server (MSSQL) connections. No driver exists yet (comingSoon); stubs ready. */
export function isSqlServerLike(type: string | undefined | null): boolean {
  if (!type) return false;
  return type.toLowerCase() === "sqlserver";
}

/**
 * Resolve `#` handling for an editor tab: the tab's own target connection
 * wins (a PostgreSQL tab must keep `#>` operators intact even when the
 * sidebar is on MySQL, and vice versa); untargeted tabs fall back to the
 * globally-active connection. Pure so statement splitting stays unit-testable.
 */
export function resolveTabHashComments(
  targetConnectionId: string | null | undefined,
  connections: { id: string; type: string }[],
  activeConnType: string | null | undefined,
): { hashComments: boolean } {
  const tabConn = targetConnectionId
    ? connections.find((c) => c.id === targetConnectionId)
    : undefined;
  return { hashComments: isMySqlLike(tabConn?.type ?? activeConnType ?? undefined) };
}

/** Default TCP port for an engine id. Falls back to 5432 for unknown. */
export function getDefaultPort(type: string | undefined | null): number {
  const t = (type || "").toLowerCase();
  if (t === "mysql" || t === "mariadb") return 3306;
  if (t === "sqlserver") return 1433;
  if (t === "cockroach") return 26257;
  if (t === "redshift") return 5439;
  if (t === "greenplum" || t === "timescale" || t === "neon" || t === "citus" || t === "alloydb") return 5432;
  if (t === "yugabyte") return 5433;
  if (t === "tidb") return 4000;
  if (t === "materialize") return 6875;
  if (t === "questdb") return 8812;
  return 5432;
}

/**
 * Replace the contents of string literals, quoted identifiers,
 * dollar-quoted bodies and comments with spaces (same length preserved).
 * Keyword scans on the result can't see inside those contexts.
 *
 * Handles single-quoted strings (with doubled-quote and backslash escapes),
 * double-quoted identifiers, backtick identifiers, dollar-quoted bodies,
 * line comments and block comments. `#` line comments only when
 * `opts.hashComments` is set (MySQL family) — otherwise `#` is passed
 * through untouched so PostgreSQL operators (`#>`, `#>>`) survive.
 */
export function stripSqlToCode(sql: string, opts?: SqlLexerOptions): string {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    if (c === "'") {
      const start = i;
      // Backslash escapes only in MySQL strings and PostgreSQL E'…' strings
      // (same rule as splitStatements): `'C:\'` is a complete PG string.
      const backslashEscapes = !!opts?.hashComments || ((sql[i - 1] === "E" || sql[i - 1] === "e") && !/[\w$]/.test(sql[i - 2] ?? ""));
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === "\\" && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      blank(start + 1, Math.min(i - 1, sql.length));
      continue;
    }

    if (c === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      blank(start + 1, Math.min(i - 1, sql.length));
      continue;
    }

    if (c === "`") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      blank(start + 1, Math.min(i - 1, sql.length));
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      blank(start, i);
      continue;
    }

    if (c === "#") {
      if (opts?.hashComments) {
        // MySQL `#` line comment: consume to end of line regardless of the
        // preceding character (outside strings/quotes, where we never reach
        // this branch). `SELECT * FROM logs# LIMIT 1` must hide `# LIMIT 1`,
        // otherwise applyQueryLimit sees a limit that MySQL ignores.
        const start = i;
        while (i < sql.length && sql[i] !== "\n") i++;
        blank(start, i);
        continue;
      }
      // PostgreSQL and friends: `#` starts an operator (`#>`, `#>>`), not a
      // comment. Leave it (and the rest of the line) visible to keyword scans.
      i++;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      // PostgreSQL block comments nest; MySQL's don't.
      const start = i;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (!opts?.hashComments && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      blank(start, i);
      continue;
    }

    if (c === "$") {
      const m = DOLLAR_TAG_RE.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const closeIdx = sql.indexOf(tag, bodyStart);
        const end = closeIdx === -1 ? sql.length : closeIdx + tag.length;
        blank(i, end);
        i = end;
        continue;
      }
    }

    i++;
  }

  return out.join("");
}

/** Upper-cased, comment/string-free SQL for keyword tests. */
export function cleanSqlForKeywords(sql: string, opts?: SqlLexerOptions): string {
  return stripSqlToCode(sql, opts).trim().toUpperCase();
}

/**
 * Blank out line and block comments only, preserving strings, dollar
 * bodies and their delimiters. Used for start-anchored checks (DO blocks)
 * where blanking the dollar tag itself would destroy the signal.
 */
export function stripCommentsOnly(sql: string): string {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      blank(start, i);
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      blank(start, i);
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Anonymous DO block (PostgreSQL/Cockroach):
 * DO with a dollar-quoted body, a single-quoted body, or an explicit
 * LANGUAGE clause. Leading comments are ignored; a DO inside a string
 * can never match because matching anchors at the start of the query.
 */
export function isDoBlock(sql: string): boolean {
  const clean = stripCommentsOnly(sql).trim();
  return /^DO(\s+LANGUAGE\s+[A-Za-z_][A-Za-z0-9_]*)?\s+(\$|')/i.test(clean);
}

/**
 * Whether the statement returns rows and should go through `db.select()`.
 * Covers SELECT/WITH/SHOW/EXPLAIN/DESCRIBE plus DML with RETURNING
 * (INSERT/UPDATE/DELETE ... RETURNING). A DML statement whose only SELECT
 * is inside a subquery (e.g. `DELETE … WHERE id IN (SELECT …)`) does NOT
 * return rows and must go through `db.execute()`.
 * DO blocks never count as selects even when their bodies contain
 * SELECT/RETURNING.
 *
 * Pass `{ hashComments: true }` for MySQL-family connections so `#`
 * comments don't leak keywords into detection; the default preserves
 * PostgreSQL `#>`/`#>>` operators.
 */
export function isSelectLike(sql: string, opts?: SqlLexerOptions): boolean {
  if (isDoBlock(sql)) return false;
  const clean = cleanSqlForKeywords(sql, opts);
  if (/^(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|DESC|VALUES|TABLE)\b/.test(clean)) return true;
  if (/\bRETURNING\b/.test(clean)) return true;
  return false;
}

export interface DestructiveFlags {
  isTruncate: boolean;
  /** The statement itself is a DELETE (not a DELETE inside a CTE or body). */
  isDelete: boolean;
  /** The statement itself is an UPDATE (not `ON CONFLICT DO UPDATE`, `FOR UPDATE`). */
  isUpdate: boolean;
  /** WHERE at the statement's own level — one inside a subquery or CTE doesn't limit it. */
  hasWhere: boolean;
  isDrop: boolean;
  /** TRUNCATE, DROP, or DELETE/UPDATE that affects every row. */
  isDestructive: boolean;
}

/** Upper-case words at parenthesis depth 0 of already-cleaned SQL. */
function topLevelWords(clean: string): string[] {
  const words: string[] = [];
  let depth = 0;
  for (const m of clean.matchAll(/[()]|[A-Z_][A-Z0-9_$]*/g)) {
    if (m[0] === "(") depth++;
    else if (m[0] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) words.push(m[0]);
  }
  return words;
}

const STATEMENT_VERBS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "VALUES", "TABLE", "CALL", "COPY"]);

/**
 * Lexer-aware destructive-operation classification of ONE statement
 * (callers classify each statement of a script separately: in
 * `DELETE FROM a; SELECT … WHERE x = 1` the WHERE belongs to the SELECT).
 */
export function classifyDestructive(sql: string, opts?: SqlLexerOptions): DestructiveFlags {
  const words = topLevelWords(cleanSqlForKeywords(sql, opts));
  // The statement's verb: the first verb at depth 0, past any WITH … AS (…).
  const verbIndex = words.findIndex((w) => STATEMENT_VERBS.has(w));
  const verb = verbIndex >= 0 ? words[verbIndex] : "";
  const isTruncate = verb === "TRUNCATE";
  const isDrop = verb === "DROP" || words[0] === "DROP";
  const isDelete = verb === "DELETE";
  const isUpdate = verb === "UPDATE";
  const hasWhere = verbIndex >= 0 && words.slice(verbIndex).includes("WHERE");
  const isDestructive = isTruncate || isDrop || ((isDelete || isUpdate) && !hasWhere);
  return { isTruncate, isDelete, isUpdate, hasWhere, isDrop, isDestructive };
}

/** Escape a string literal value: `'O''Brien'`. */
export function escapeSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Format a grid/driver value as a SQL literal for generated DML
 * (INSERT/UPDATE/DELETE/WHERE). Numbers and booleans are unquoted so they
 * work as-is on PostgreSQL, MySQL, and SQLite (`TRUE`/`FALSE` are valid in
 * all three); strings are single-quoted with escaping; objects/arrays
 * (e.g. decoded `jsonb`) are serialized to JSON first instead of becoming
 * `'[object Object]'`; null/undefined become `NULL`.
 */
export function formatSqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (typeof val === "object") return escapeSqlStringLiteral(JSON.stringify(val));
  return escapeSqlStringLiteral(String(val));
}

/** Split a possibly schema-qualified identifier on dots outside quotes. */
export function splitDottedIdentifier(identifier: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < identifier.length; i++) {
    const c = identifier[i];
    if (quote) {
      cur += c;
      if (c === quote) {
        if (identifier[i + 1] === quote) {
          cur += quote;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ".") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function unquotePart(part: string): { body: string; quotedWith: string | null } {
  const t = part.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return { body: t.slice(1, -1).replace(/""/g, '"'), quotedWith: '"' };
  }
  if (t.length >= 2 && t.startsWith("`") && t.endsWith("`")) {
    return { body: t.slice(1, -1).replace(/``/g, "`"), quotedWith: "`" };
  }
  if (t.length >= 2 && t.startsWith("[") && t.endsWith("]")) {
    return { body: t.slice(1, -1), quotedWith: "[" };
  }
  return { body: t, quotedWith: null };
}

/**
 * Quote one identifier segment with proper escaping (`"` → `""`,
 * `` ` `` → ` ``` `) instead of deleting the characters.
 */
export function quoteIdentifierPart(part: string, type: string): string {
  const { body } = unquotePart(part);
  const lower = (type || "").toLowerCase();
  if (["mysql", "mariadb"].includes(lower)) {
    return `\`${body.replace(/`/g, "``")}\``;
  }
  return `"${body.replace(/"/g, '""')}"`;
}

/**
 * Remove a trailing top-level `;` and any trailing line/block comments
 * without touching `;`/`--` inside strings or dollar bodies.
 */
export function stripTrailingSemicolonAndComments(sql: string): string {
  let s = sql;
  for (;;) {
    const trimmed = s.replace(/\s+$/, "");
    if (trimmed !== s) {
      s = trimmed;
      continue;
    }
    if (s.endsWith(";")) {
      const stripped = stripSqlToCode(s);
      const idx = s.length - 1;
      if (stripped[idx] === ";") {
        s = s.slice(0, -1);
        continue;
      }
      break;
    }
    if (s.endsWith("*/")) {
      const open = s.lastIndexOf("/*");
      if (open !== -1) {
        const stripped = stripSqlToCode(s.slice(0, open));
        void stripped;
        s = s.slice(0, open).replace(/\s+$/, "");
        continue;
      }
      break;
    }
    const m = /--[^\n]*$/.exec(s);
    if (m) {
      const start = m.index;
      const stripped = stripSqlToCode(s);
      if (/^\s*$/.test(stripped.slice(start))) {
        s = s.slice(0, start).replace(/\s+$/, "");
        continue;
      }
      break;
    }
    break;
  }
  return s;
}
