/**
 * Editor sessions (see `src-tauri/patches/tauri-plugin-sql/src/session.rs`).
 *
 * Each editor tab runs its SQL on its own dedicated server connection, so
 * `BEGIN … COMMIT` across separate runs, `SET work_mem`, `SET ROLE`,
 * `SET session_replication_role`, temp tables and every other session
 * setting behave as they do in psql or DataGrip. Every statement returns its
 * rows (if any) and its affected-row count, plus server NOTICE/WARNING lines.
 */
import { invoke } from "@tauri-apps/api/core";

export interface SessionColumn {
  name: string;
  typeName: string;
}

export interface SessionResultSet {
  /** Empty for statements that return no rows (UPDATE, DDL, DO, TRUNCATE…). */
  columns: SessionColumn[];
  /** Positional values; duplicate column names survive. */
  rows: unknown[][];
  rowsAffected: number;
  /** More rows existed than the requested maximum. */
  truncated: boolean;
}

export interface SessionRunOutput {
  results: SessionResultSet[];
  notices: string[];
}

/** The `@tauri-apps/plugin-sql` Database handle (its `path` is the pool key). */
export interface SessionDb {
  path: string;
}

function localTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function runInSession(db: SessionDb, sessionId: string, sql: string, maxRows?: number): Promise<SessionRunOutput> {
  return invoke<SessionRunOutput>("plugin:sql|run", {
    db: db.path,
    session: sessionId,
    query: sql,
    maxRows: maxRows && Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : null,
    timeZone: localTimeZone(),
  });
}

/** Ask the server to cancel the session's running statement. */
export function cancelSession(db: SessionDb, sessionId: string): Promise<boolean> {
  return invoke<boolean>("plugin:sql|cancel", { db: db.path, session: sessionId });
}

/** Close the session's connection (rolls back any open transaction). */
export function endSession(db: SessionDb, sessionId: string): Promise<boolean> {
  return invoke<boolean>("plugin:sql|end_session", { db: db.path, session: sessionId });
}

/**
 * Positional rows → the row objects the results grid uses. Duplicate column
 * names (`SELECT a.id, b.id`) get unique keys — `id`, `id (2)` — instead of
 * the second silently overwriting the first.
 */
export function toRowObjects(set: SessionResultSet): { columns: string[]; rows: Record<string, unknown>[] } {
  const seen = new Map<string, number>();
  const columns = set.columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    return n === 1 ? c.name : `${c.name} (${n})`;
  });
  const rows = set.rows.map((values) => {
    const row: Record<string, unknown> = {};
    columns.forEach((key, i) => {
      row[key] = values[i];
    });
    return row;
  });
  return { columns, rows };
}

/** The result set to show in the grid: the last one that returned columns. */
export function primaryRowSet(output: SessionRunOutput): SessionResultSet | undefined {
  for (let i = output.results.length - 1; i >= 0; i--) {
    if (output.results[i].columns.length > 0) return output.results[i];
  }
  return undefined;
}

export type TransactionEffect = "begin" | "end" | null;

/**
 * Whether a statement opens or closes a transaction, so the toolbar's
 * transaction indicator follows BEGIN/COMMIT typed in the editor too.
 * `ROLLBACK TO SAVEPOINT` keeps the transaction open.
 */
export function transactionEffect(cleanUpperSql: string): TransactionEffect {
  if (/^(BEGIN|START\s+TRANSACTION)\b/.test(cleanUpperSql) && !/^BEGIN\s+ATOMIC\b/.test(cleanUpperSql)) return "begin";
  if (/^ROLLBACK\s+(WORK\s+|TRANSACTION\s+)?TO\b/.test(cleanUpperSql)) return null;
  if (/^(COMMIT|END|ROLLBACK|ABORT)\b/.test(cleanUpperSql)) return "end";
  return null;
}

/** Character offset (0-based) from a psql-style `POSITION: n` line, if any. */
export function errorPosition(message: string): number | null {
  const m = /^POSITION: (\d+)$/m.exec(message);
  return m ? Number(m[1]) - 1 : null;
}
