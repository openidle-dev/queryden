/**
 * Column type helpers for grid cell rendering.
 *
 * Issue #51: the data grid previously chose date/time editors based on whether
 * the column NAME contained "date" or "time". That misses real datetime columns
 * like `effective_from TIMESTAMP` and false-positives on `update_time_label TEXT`.
 *
 * When we know the SQL type of a column (e.g. from schema introspection for a
 * table-backed result set) we should match on that. When we don't (ad-hoc query
 * result with no table-level schema available) we fall back to the original
 * name-based heuristic so we don't regress existing behavior.
 */

/**
 * SQL date/time type tokens we recognize across PostgreSQL, MySQL/MariaDB,
 * SQLite, and CockroachDB. Stored normalized to upper case for fast lookup.
 *
 * Includes the bare keywords plus the PostgreSQL `udt_name` short forms
 * (`timestamptz`, `timetz`) that information_schema returns alongside
 * `data_type`.
 */
const DATE_TIME_TYPES = new Set<string>([
  "DATE",
  "TIME",
  "TIMETZ",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "DATETIME",
  "SMALLDATETIME",
  "TIMESTAMP WITHOUT TIME ZONE",
  "TIMESTAMP WITH TIME ZONE",
  "TIME WITHOUT TIME ZONE",
  "TIME WITH TIME ZONE",
]);

/**
 * Returns true if the column should render with the date/time overlay editor.
 *
 * Strategy:
 *  1. If `sqlType` is provided, decide solely on the SQL type — this is the
 *     authoritative path and avoids false positives like `update_time_label TEXT`.
 *  2. If `sqlType` is undefined (ad-hoc query result with no schema), fall back
 *     to the name-based heuristic that was in place before #51.
 */
export function isDateTimeType(
  sqlType: string | undefined,
  columnName: string,
): boolean {
  if (sqlType && sqlType.trim() !== "") {
    const normalized = sqlType.trim().toUpperCase();
    if (DATE_TIME_TYPES.has(normalized)) return true;
    // PostgreSQL data_type sometimes arrives with trailing precision, e.g.
    // "timestamp(6) without time zone". Strip a leading type keyword before
    // any "(" or whitespace and try again so we still catch it.
    const head = normalized.split(/[(\s]/, 1)[0];
    return DATE_TIME_TYPES.has(head);
  }
  const low = columnName.toLowerCase();
  return low.includes("date") || low.includes("time");
}
