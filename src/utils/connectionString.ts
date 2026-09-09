/**
 * Connection-string builder for on-demand (lazy) database handles.
 *
 * Why this exists: opening the app with multiple saved connections connects
 * nothing (session restore is metadata-only by design), and tabs keep
 * targeting their own connections. Running a query must therefore be able to
 * connect its tab's target connection on demand — with the exact same
 * semantics as the manual sidebar connect (URL-encoded credentials, default
 * ports, SSH-tunnel endpoint swap, sqlite fallback). That logic used to be
 * copy-pasted across `ConnectionContext.connectToDatabase`, `executeQuery`,
 * `handleSave` and `handleAddRow`, each copy with slightly different bugs
 * (missing SSH support, wrong scheme fallback, unencoded credentials).
 *
 * This module is the single pure implementation. It is deliberately free of
 * Tauri/Node APIs (`encodeURIComponent` is a JS builtin) so it runs
 * identically on Windows, Linux and macOS and is unit-testable in Node.
 */

import { getDefaultPort } from "./sqlDialect";

export interface ConnectionStringInput {
  /** Engine id: postgres | supabase | cockroach | mysql | mariadb | sqlite | psql */
  type: string;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string | null;
  /** sqlite file path (or `:memory:` label); falls back to `queryden.db`. */
  filepath?: string | null;
}

/**
 * Build a `tauri-plugin-sql`-compatible connection string.
 *
 * - Credentials are URL-encoded (passwords with `@`, `/`, `:` or spaces).
 * - Missing host/port fall back to `localhost` + the engine default port.
 * - `psql` (CLI-console connection entries) maps to the postgres scheme —
 *   there is no `psql:` scheme in the SQL plugin; those entries describe a
 *   PostgreSQL server for libpq use (e.g. version detection).
 * - Unknown engine ids throw instead of silently picking a wrong scheme
 *   (a previous `handleSave` copy defaulted everything unknown to mysql).
 */
export function buildConnectionString(input: ConnectionStringInput): string {
  const type = (input.type || "").toLowerCase();

  if (type === "sqlite") {
    return `sqlite:${input.filepath || "queryden.db"}`;
  }

  const isPostgresFamily =
    type === "postgres" ||
    type === "supabase" ||
    type === "cockroach" ||
    type === "psql";
  const isMysqlFamily = type === "mysql" || type === "mariadb";

  if (!isPostgresFamily && !isMysqlFamily) {
    throw new Error(`Unsupported database type for connection string: ${input.type || "(empty)"}`);
  }

  const scheme = isPostgresFamily ? "postgres" : "mysql";
  const rawHost = input.host || "localhost";
  // Bracket IPv6 literals (`::1` → `[::1]`): a bare `::1` in the authority
  // (`...@::1:5432/...`) is not a valid URI and breaks the connection.
  const host = rawHost.includes(":") && !(rawHost.startsWith("[") && rawHost.endsWith("]"))
    ? `[${rawHost}]`
    : rawHost;
  const port = input.port || getDefaultPort(type === "psql" ? "postgres" : type);
  const database = input.database || "";
  const username = encodeURIComponent(input.username || "");
  const password = encodeURIComponent(input.password || "");

  return `${scheme}://${username}:${password}@${host}:${port}/${database}`;
}
