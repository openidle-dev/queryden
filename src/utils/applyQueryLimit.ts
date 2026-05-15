/**
 * Apply an automatic LIMIT clause to SELECT-like queries to prevent the UI
 * from freezing on very large result sets. Returns the query unchanged if
 * it isn't a candidate (DDL/DML without RETURNING, already has LIMIT, or is
 * a complex query — CTE, subquery, UNION/INTERSECT/EXCEPT).
 *
 * Pure helper extracted from MainContent so it can be unit-tested without
 * jsdom. Also strips a trailing `;` (with optional whitespace) before
 * appending the LIMIT clause — see #38, where `SELECT 1;` previously became
 * `SELECT 1; LIMIT 1000`, which Postgres parses as two statements and the
 * second is a syntax error.
 */
export function applyQueryLimit(query: string, maxRows: number): string {
  // Skip if not a SELECT-like query (strip comments first for accurate detection)
  const cleanQuery = query
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .toUpperCase();

  if (
    !cleanQuery.startsWith("SELECT") &&
    !cleanQuery.includes("RETURNING") &&
    !cleanQuery.startsWith("SHOW") &&
    !cleanQuery.startsWith("EXPLAIN")
  ) {
    return query;
  }

  // Skip if already has LIMIT (case insensitive)
  if (/\bLIMIT\s+\d+/i.test(query)) {
    return query;
  }

  // Skip complex queries - CTEs, subqueries, UNION, etc.
  const isComplexQuery =
    /\bWITH\s+\w+\s+AS\s*\(/i.test(query) || // CTE: WITH xx AS (...)
    /\(\s*SELECT\b/i.test(query) || // Subquery: (SELECT ...)
    /\bUNION\s+(ALL\s+)?/i.test(query) || // UNION / UNION ALL
    /\bINTERSECT\b/i.test(query) || // INTERSECT
    /\bEXCEPT\b/i.test(query); // EXCEPT

  if (isComplexQuery) {
    return query; // Don't modify complex queries
  }

  // Strip a trailing `;` (with optional surrounding whitespace) before
  // appending LIMIT — see #38.
  const trimmed = query.trim().replace(/;\s*$/, "");
  return `${trimmed} LIMIT ${maxRows}`;
}
