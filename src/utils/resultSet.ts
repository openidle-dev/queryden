/**
 * Whether the results panel has a row set to show. A query that matched no
 * rows still returns its columns, and the grid shows those headers.
 */
export function hasRowSet(rows: readonly unknown[], columns: readonly string[] | undefined): boolean {
  return rows.length > 0 || (columns?.length ?? 0) > 0;
}

/**
 * Keys the grid adds to result rows for its own bookkeeping (new / edited
 * rows, Multi-Query's merged view). Real columns may start with `_` too
 * (`_id`), so only these are ever treated as non-columns.
 */
const GRID_INTERNAL_KEYS = new Set(["_isNew", "_isModified", "_original", "_source_connection", "_source_database"]);

export function isGridInternalKey(key: string): boolean {
  return GRID_INTERNAL_KEYS.has(key);
}
