import {
  cleanSqlForKeywords,
  isDoBlock,
  stripTrailingSemicolonAndComments,
  type SqlLexerOptions,
} from "./sqlDialect";

/**
 * Apply an automatic LIMIT clause to plain SELECT queries to prevent the UI
 * from freezing on very large result sets. Returns the query unchanged if
 * it isn't a candidate (non-SELECT, already has LIMIT, or is a complex
 * query — CTE, subquery, UNION/INTERSECT/EXCEPT).
 *
 * Only SELECT/WITH/VALUES/TABLE statements are candidates. SHOW/EXPLAIN/
 * DESCRIBE and DML with RETURNING are row-returning (routed via select)
 * but must NOT get a LIMIT appended: `SHOW TABLES LIMIT 10` and
 * `INSERT ... RETURNING id LIMIT 10` are syntax errors.
 *
 * Pure helper extracted from MainContent so it can be unit-tested without
 * jsdom. Also strips a trailing `;` (with optional whitespace) before
 * appending the LIMIT clause — see #38, where `SELECT 1;` previously became
 * `SELECT 1; LIMIT 1000`, which Postgres parses as two statements and the
 * second is a syntax error.
 *
 * All keyword checks run on lexer-stripped SQL (strings, dollar bodies and
 * comments blanked) so e.g. `SELECT 'LIMIT 10'` or `SELECT 'a -- b'` can't
 * fool detection or corrupt the tail-strip.
 *
 * Pass `{ hashComments: true }` for MySQL-family connections so `#`
 * comments are blanked before LIMIT detection (`SELECT * FROM logs# LIMIT 1`
 * must not look limited — MySQL ignores that comment). The default
 * preserves PostgreSQL `#>`/`#>>` operators.
 */
export function applyQueryLimit(query: string, maxRows: number, opts?: SqlLexerOptions): string {
  const cleanQuery = cleanSqlForKeywords(query, opts);

  // Skip PL/pgSQL anonymous blocks (DO $$ ... $$; or DO LANGUAGE plpgsql $$ ... $$;)
  if (isDoBlock(query)) {
    return query;
  }

  if (
    !cleanQuery.startsWith("SELECT") &&
    !cleanQuery.startsWith("WITH") &&
    !cleanQuery.startsWith("VALUES") &&
    !cleanQuery.startsWith("TABLE")
  ) {
    return query;
  }

  // Skip if already has LIMIT (checked on stripped SQL so a literal
  // like 'LIMIT 10' doesn't count).
  if (/\bLIMIT\s+\d+/i.test(cleanQuery)) {
    return query;
  }

  // Skip complex queries - CTEs, subqueries, UNION, etc. (also on stripped SQL).
  const isComplexQuery =
    /\bWITH\s+\w+\s+AS\s*\(/i.test(cleanQuery) || // CTE: WITH xx AS (...)
    /\(\s*SELECT\b/i.test(cleanQuery) || // Subquery: (SELECT ...)
    /\bUNION\s+(ALL\s+)?/i.test(cleanQuery) || // UNION / UNION ALL
    /\bINTERSECT\b/i.test(cleanQuery) || // INTERSECT
    /\bEXCEPT\b/i.test(cleanQuery); // EXCEPT

  if (isComplexQuery) {
    return query; // Don't modify complex queries
  }

  // A non-positive or non-numeric limit (the setting's number input
  // accepts 0 / empty → NaN) would silently return zero rows (`LIMIT 0`)
  // or a syntax error (`LIMIT NaN`). Treat as "no auto-limit" instead.
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return query;
  }

  // Strip trailing whitespace/semicolons/comments in a lexer-aware way so
  // e.g. `SELECT 'a -- b'` isn't truncated inside its string literal.
  // Mid-query inline comments are preserved; only the tail is touched.
  const trimmed = stripTrailingSemicolonAndComments(query);
  return `${trimmed} LIMIT ${maxRows}`;
}
