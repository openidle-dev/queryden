/**
 * Pure shape-mapping helpers for schema introspection (completion + tree).
 *
 * Why this exists: `ConnectionContext.loadSchema` runs raw SQL per engine and
 * must reshape rows into the shared `SchemaItems` contract (`table_name` /
 * `column_name` pairs, FK quadruples) that the completion provider in
 * `QueryEditor.tsx` and the FK machinery consume. These mappers hold that
 * contract in unit-testable form — notably the gaps they close:
 * - MySQL previously loaded tables/views/procedures/FKs but never columns
 *   or scalar functions, so `table.` column completion and `fn(` hints were
 *   structurally blind on MySQL;
 * - SQLite loaded nothing at all (no branch), so its tree and completion
 *   were empty.
 */

/** Quote a SQLite identifier by doubling embedded quotes (`"` → `""`). */
export function quoteSqliteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ColumnPair {
  table_name: string;
  column_name: string;
}

export interface ForeignKeyQuad {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
}

/** information_schema.COLUMNS rows → shared column pairs (MySQL). */
export function mapMysqlColumns(
  rows: Array<{ TABLE_NAME?: unknown; COLUMN_NAME?: unknown }>,
): ColumnPair[] {
  const out: ColumnPair[] = [];
  for (const r of rows) {
    if (typeof r?.TABLE_NAME === "string" && typeof r?.COLUMN_NAME === "string") {
      out.push({ table_name: r.TABLE_NAME, column_name: r.COLUMN_NAME });
    }
  }
  return out;
}

/** information_schema.ROUTINES rows → bare routine names (MySQL). */
export function mapMysqlRoutineNames(rows: Array<{ ROUTINE_NAME?: unknown }>): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r?.ROUTINE_NAME === "string" && r.ROUTINE_NAME.length > 0) {
      out.push(r.ROUTINE_NAME);
    }
  }
  return out;
}

/**
 * `sqlite_master` name rows → table/view names, skipping SQLite's internal
 * bookkeeping tables (`sqlite_%`: `sqlite_sequence`, `sqlite_stat1`, …).
 */
export function mapSqliteMasterNames(rows: Array<{ name?: unknown }>): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r?.name === "string" && r.name.length > 0 && !r.name.startsWith("sqlite_")) {
      out.push(r.name);
    }
  }
  return out;
}

/** `PRAGMA table_info(t)` rows (`{ name }`) → shared column pairs. */
export function mapSqlitePragmaColumns(table: string, rows: Array<{ name?: unknown }>): ColumnPair[] {
  const out: ColumnPair[] = [];
  for (const r of rows) {
    if (typeof r?.name === "string" && r.name.length > 0) {
      out.push({ table_name: table, column_name: r.name });
    }
  }
  return out;
}

/**
 * `PRAGMA foreign_key_list(t)` rows (`{ table, from, to }`) → shared FK
 * quadruples. Rows missing any leg are dropped — a partial FK poisons JOIN
 * suggestions with unresolvable targets.
 */
export function mapSqliteForeignKeys(table: string, rows: Array<{ table?: unknown; from?: unknown; to?: unknown }>): ForeignKeyQuad[] {
  const out: ForeignKeyQuad[] = [];
  for (const r of rows) {
    if (
      typeof r?.table === "string" && r.table.length > 0 &&
      typeof r?.from === "string" && r.from.length > 0 &&
      typeof r?.to === "string" && r.to.length > 0
    ) {
      out.push({ source_table: table, source_column: r.from, target_table: r.table, target_column: r.to });
    }
  }
  return out;
}
