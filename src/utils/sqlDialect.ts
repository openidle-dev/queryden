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
  | "sqlite";

const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

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

/** Default TCP port for an engine id. Falls back to 5432 for unknown. */
export function getDefaultPort(type: string | undefined | null): number {
  const t = (type || "").toLowerCase();
  if (t === "mysql" || t === "mariadb") return 3306;
  if (t === "cockroach") return 26257;
  if (t === "redshift" || t === "greenplum" || t === "timescale" || t === "neon" || t === "citus" || t === "alloydb") return 5432;
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
 * line comments and block comments.
 */
export function stripSqlToCode(sql: string): string {
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
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && i + 1 < sql.length) {
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
      const prev = i === 0 ? "\n" : sql[i - 1];
      if (prev === "\n" || prev === "\r" || prev === ";" || prev === " " || prev === "\t" || prev === "(") {
        const start = i;
        while (i < sql.length && sql[i] !== "\n") i++;
        blank(start, i);
        continue;
      }
      i++;
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
export function cleanSqlForKeywords(sql: string): string {
  return stripSqlToCode(sql).trim().toUpperCase();
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
 * (INSERT/UPDATE/DELETE ... RETURNING) and subquery selects.
 * DO blocks never count as selects even when their bodies contain
 * SELECT/RETURNING.
 */
export function isSelectLike(sql: string): boolean {
  if (isDoBlock(sql)) return false;
  const clean = cleanSqlForKeywords(sql);
  if (/^(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|DESC|VALUES|TABLE)\b/.test(clean)) return true;
  if (/\bRETURNING\b/.test(clean)) return true;
  if (/\(\s*SELECT\b/.test(clean)) return true;
  return false;
}

export interface DestructiveFlags {
  isTruncate: boolean;
  isDelete: boolean;
  hasWhere: boolean;
  isDrop: boolean;
  isDestructive: boolean;
}

/** Lexer-aware destructive-operation classification. */
export function classifyDestructive(sql: string): DestructiveFlags {
  const clean = cleanSqlForKeywords(sql);
  const isTruncate = /\bTRUNCATE\b/.test(clean);
  const isDelete = /\bDELETE\b/.test(clean);
  const hasWhere = /\bWHERE\b/.test(clean);
  const isDrop = /\bDROP\b/.test(clean);
  const isDestructive = isTruncate || (isDelete && !hasWhere) || isDrop;
  return { isTruncate, isDelete, hasWhere, isDrop, isDestructive };
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
