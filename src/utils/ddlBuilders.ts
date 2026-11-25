/**
 * Pure builders for DDL / admin SQL (drop/create database, roles, copy).
 *
 * Why this exists: several of these statements used to interpolate catalog
 * or user input raw (`DROP DATABASE "${dbName}"`, `CREATE ROLE ${rolname}`,
 * `INSERT INTO ${targetDB}.${schema}.${table}` …). sqlx prepared statements
 * reject stacked queries, but a quote in a name still broke out of the
 * single statement and changed its meaning (`"a" WITH (FORCE) --`), and
 * legitimate quoted names simply errored. Every identifier here goes through
 * `quoteIdentifier` (doubling, dialect-aware) and every literal through
 * `escapeSqlStringLiteral`, so adversarial catalog content
 * (`evil"; DROP TABLE users; --`) becomes one inert identifier.
 *
 * Pure + unit-tested: the Tauri executed paths call these, so quoting bugs
 * are caught by `ddlBuilders.test.ts`, not by a broken production database.
 */
import { quoteIdentifier, type DatabaseType } from "./sqlSecurity";
import {
  escapeSqlStringLiteral,
  formatSqlLiteral,
  isMySqlLike,
  isPgLike,
  quoteIdentifierPart,
  splitDottedIdentifier,
} from "./sqlDialect";

export interface CreateDatabaseOptions {
  name: string;
  owner?: string;
  template?: string;
  encoding?: string;
  lcCollate?: string;
  lcCtype?: string;
  tablespace?: string;
  connectionLimit?: number;
  isTemplate?: boolean;
}

/** Strip one layer of `"…"`, `` `…` `` or `[…]` quoting (un-doubling inside). */
function stripIdentifierQuotes(part: string): string {
  const t = part.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if (first === '"' && last === '"') return t.slice(1, -1).replace(/""/g, '"');
    if (first === "`" && last === "`") return t.slice(1, -1).replace(/``/g, "`");
    if (first === "[" && last === "]") return t.slice(1, -1);
  }
  return t;
}

/**
 * Split a possibly schema-qualified display name (`reporting.deployments`,
 * `"my.schema"."my.table"`) into raw (unquoted) parts for catalog params
 * and re-quoting. Quote-aware: naive `split('.')` breaks quoted dots.
 */
export function splitDisplayName(name: string): { schema: string | null; table: string } {
  const parts = splitDottedIdentifier(name).map(stripIdentifierQuotes);
  if (parts.length > 1) {
    return { schema: parts[0], table: parts.slice(1).join(".") };
  }
  return { schema: null, table: parts[0] ?? name };
}

/** `DROP DATABASE` for PG/MySQL families. Throws for unsupported engines. */
export function buildDropDatabaseSql(dbType: string, dbName: string): string {
  if (!isPgLike(dbType) && !isMySqlLike(dbType)) {
    throw new Error(`Drop Database is not supported for ${dbType}`);
  }
  // A database name is one identifier: a dot in it is part of the name.
  return `DROP DATABASE ${quoteIdentifierPart(dbName, dbType)}`;
}

/** `CREATE DATABASE` for PG/MySQL families. Throws for unsupported engines. */
export function buildCreateDatabaseSql(dbType: string, payload: CreateDatabaseOptions): string {
  // Database, role, template, tablespace, charset and collation names are
  // single identifiers: a dot in one is part of the name.
  const qid = (n: string) => quoteIdentifierPart(n, dbType);
  if (isPgLike(dbType)) {
    let sql = `CREATE DATABASE ${qid(payload.name)}`;
    if (payload.owner) sql += ` OWNER = ${qid(payload.owner)}`;
    if (payload.template) sql += ` TEMPLATE = ${qid(payload.template)}`;
    // PG takes these as string literals — escape, don't interpolate.
    if (payload.encoding) sql += ` ENCODING = ${escapeSqlStringLiteral(payload.encoding)}`;
    if (payload.lcCollate) sql += ` LC_COLLATE = ${escapeSqlStringLiteral(payload.lcCollate)}`;
    if (payload.lcCtype) sql += ` LC_CTYPE = ${escapeSqlStringLiteral(payload.lcCtype)}`;
    if (payload.tablespace) sql += ` TABLESPACE = ${qid(payload.tablespace)}`;
    if (payload.connectionLimit !== undefined && Number.isInteger(payload.connectionLimit) && payload.connectionLimit >= -1) {
      sql += ` CONNECTION LIMIT = ${payload.connectionLimit}`;
    }
    if (payload.isTemplate !== undefined) sql += ` IS_TEMPLATE = ${payload.isTemplate ? "TRUE" : "FALSE"}`;
    return sql;
  }
  if (isMySqlLike(dbType)) {
    let sql = `CREATE DATABASE ${qid(payload.name)}`;
    // MySQL takes charset/collation as identifiers (backtick-quoting valid).
    if (payload.encoding) sql += ` CHARACTER SET ${qid(payload.encoding)}`;
    if (payload.lcCollate) sql += ` COLLATE ${qid(payload.lcCollate)}`;
    return sql;
  }
  throw new Error(`Create Database is not supported for ${dbType}`);
}

export interface RoleRecord {
  rolname: string;
  rolsuper?: boolean;
  rolinherit?: boolean;
  rolcreaterole?: boolean;
  rolcreatedb?: boolean;
  rolcanlogin?: boolean;
  rolreplication?: boolean;
  rolbypassrls?: boolean;
  rolpassword?: string | null;
  rolconnlimit?: number | null;
  rolvaliduntil?: string | null;
}

/** `CREATE ROLE … WITH …` from a `pg_roles` (+`pg_authid`) row. */
export function buildRoleDDL(role: RoleRecord, isLogin: boolean, dbType: string = "postgres"): string {
  let ddl = `CREATE ROLE ${quoteIdentifier(role.rolname, dbType as DatabaseType)} WITH`;
  const opts: string[] = [];
  opts.push(isLogin ? "LOGIN" : "NOLOGIN");
  opts.push(role.rolsuper ? "SUPERUSER" : "NOSUPERUSER");
  opts.push(role.rolcreatedb ? "CREATEDB" : "NOCREATEDB");
  opts.push(role.rolcreaterole ? "CREATEROLE" : "NOCREATEROLE");
  opts.push(role.rolinherit ? "INHERIT" : "NOINHERIT");
  opts.push(role.rolreplication ? "REPLICATION" : "NOREPLICATION");
  opts.push(role.rolbypassrls ? "BYPASSRLS" : "NOBYPASSRLS");
  if (role.rolpassword) {
    opts.push(`ENCRYPTED PASSWORD ${escapeSqlStringLiteral(role.rolpassword)}`);
  }
  const connLimit = Number.isInteger(role.rolconnlimit) ? (role.rolconnlimit as number) : -1;
  opts.push(`CONNECTION LIMIT ${connLimit}`);
  if (role.rolvaliduntil) {
    opts.push(`VALID UNTIL ${escapeSqlStringLiteral(role.rolvaliduntil)}`);
  } else {
    opts.push("VALID UNTIL 'infinity'");
  }
  ddl += "\n  " + opts.join("\n  ") + ";";
  return ddl;
}

export interface CopyInsertArgs {
  dbType: string;
  targetDb: string;
  targetSchema: string;
  targetTable: string;
  srcSchema: string;
  srcTable: string;
  /** Batch cap. Non-positive/non-numeric means "no LIMIT". */
  limit?: number;
}

/** `INSERT INTO targetDb.schema.table SELECT * FROM schema.table [LIMIT n]`. */
export function buildCopyInsertSql(args: CopyInsertArgs): string {
  const qid = (n: string) => quoteIdentifier(n, args.dbType as DatabaseType);
  const target = [args.targetDb, args.targetSchema, args.targetTable].map(qid).join(".");
  const source = qid(`${args.srcSchema}.${args.srcTable}`);
  let sql = `INSERT INTO ${target}\nSELECT * FROM ${source}`;
  if (args.limit !== undefined && Number.isFinite(args.limit) && (args.limit as number) > 0) {
    sql += ` LIMIT ${Math.floor(args.limit as number)}`;
  }
  return sql;
}

/** `SELECT COUNT(*) as count FROM [db.]schema.table`. */
export function buildCountSql(dbType: string, schema: string, table: string, db?: string): string {
  const parts = db ? [db, schema, table] : [schema, table];
  const qualified = parts.map((p) => quoteIdentifier(p, dbType as DatabaseType)).join(".");
  return `SELECT COUNT(*) as count FROM ${qualified}`;
}

export interface CopyPreviewArgs {
  dbType: string;
  /** Display name for comments (never executed). */
  tableDisplay: string;
  targetDb: string;
  srcSchema: string;
  srcTable: string;
  colNames: string[];
  /** One sample row, or null when the table is empty. */
  sampleRow: Record<string, unknown> | null;
  /** Current database display name for the pg_dump hint comment. */
  currentDbDisplay: string;
}

/** Human-readable copy script (displayed, user runs it explicitly). */
export function buildCopyPreviewSql(args: CopyPreviewArgs): string {
  const qid = (n: string) => quoteIdentifier(n, args.dbType as DatabaseType);
  const srcQualified = qid(`${args.srcSchema}.${args.srcTable}`);
  const colList = args.colNames.map(qid).join(", ");
  const copySQL = `
-- Fast data copy using PostgreSQL COPY command
-- This script will copy all data from ${args.tableDisplay} to ${args.targetDb}.

-- Method 1: Using INSERT with SELECT (works across databases if same server)
INSERT INTO ${qid(`${args.targetDb}.${args.srcSchema}.${args.srcTable}`)} (${colList})
SELECT ${colList} FROM ${srcQualified};

-- Note: For cross-server copying, use pg_dump/pg_restore:
-- pg_dump -t ${args.srcTable} ${args.currentDbDisplay} | psql -h targethost -d ${args.targetDb}

-- Alternative: Generate batch INSERTs for safer cross-server copy
-- The following generates INSERT statements:
`;

  if (args.sampleRow) {
    const values = args.colNames.map((col) => formatSqlLiteral(args.sampleRow?.[col]));
    return copySQL + `\n-- Example INSERT:\nINSERT INTO ${qid(`${args.targetDb}.${args.srcSchema}.${args.srcTable}`)} (${colList}) VALUES (${values.join(", ")});`;
  }

  return copySQL + `\n-- Table ${args.tableDisplay} appears to be empty.`;
}

/**
 * `ALTER DATABASE … RENAME TO …` (PostgreSQL, Supabase, CockroachDB). MySQL
 * and MariaDB have no rename (RENAME DATABASE was removed in 5.1.23) and a
 * SQLite database is a file, so those throw with the reason.
 */
export function buildRenameDatabaseSql(dbType: string, from: string, to: string): string {
  if (isMySqlLike(dbType)) {
    throw new Error("MySQL and MariaDB cannot rename a database. Create a new one and move the tables with RENAME TABLE old_db.t TO new_db.t.");
  }
  if (!isPgLike(dbType)) throw new Error(`Rename Database is not supported for ${dbType}.`);
  const trimmed = to.trim();
  if (!trimmed) throw new Error("The new database name is empty.");
  if (trimmed === from) throw new Error("The new name is the same as the current one.");
  // Database names are a single identifier: a dot in one is part of the name.
  return `ALTER DATABASE ${quoteIdentifierPart(from, "postgres")} RENAME TO ${quoteIdentifierPart(trimmed, "postgres")}`;
}

/** True when a rename/drop failed because other sessions are connected (PostgreSQL SQLSTATE 55006). */
export function isDatabaseInUseError(message: string): boolean {
  return /being accessed by other users|55006/i.test(message);
}

/**
 * Ends every other session on `dbName` (PostgreSQL / Supabase), returning one
 * row per session ended. Takes the name as `$1`.
 */
export const TERMINATE_DATABASE_SESSIONS_SQL =
  "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()";

/** Maintenance statements for a database, opened in an editor for review before running. */
export function buildDatabaseMaintenanceSql(dbType: string, dbName: string): string | null {
  const t = dbType.toLowerCase();
  if (t === "postgres" || t === "supabase") {
    return `-- Maintenance for ${dbName}. VACUUM cannot run inside a transaction block.\n`
      + "VACUUM (VERBOSE, ANALYZE);\n\n"
      + "-- Reclaims disk space but locks each table exclusively while it runs:\n-- VACUUM (FULL, VERBOSE, ANALYZE);\n\n"
      + "-- Rebuild indexes (PostgreSQL 12+ can do it without blocking writes):\n"
      + `-- REINDEX DATABASE CONCURRENTLY ${quoteIdentifierPart(dbName, "postgres")};`;
  }
  if (t === "sqlite") {
    return "-- Maintenance for this SQLite file.\nANALYZE;\nVACUUM;\nPRAGMA integrity_check;";
  }
  if (isMySqlLike(t)) {
    const db = escapeSqlStringLiteral(dbName);
    return `-- MySQL / MariaDB maintain tables one at a time. Run this, then run the statements it returns.\n`
      + `SELECT CONCAT('ANALYZE TABLE \`', table_schema, '\`.\`', table_name, '\`; OPTIMIZE TABLE \`', table_schema, '\`.\`', table_name, '\`;') AS maintenance\n`
      + `FROM information_schema.tables\nWHERE table_schema = ${db} AND table_type = 'BASE TABLE'\nORDER BY table_name;`;
  }
  return null;
}

/** A session connected to a database, as listed before disconnecting it. */
export interface DatabaseSession {
  pid: number;
  usename: string | null;
  application_name: string | null;
  client_addr: string | null;
  state: string | null;
  /** Seconds since the session connected. */
  connected_secs?: number | null;
  /** Seconds since it entered its current state. */
  state_secs?: number | null;
  /** Its current or last statement, cut to 500 characters. */
  query?: string | null;
}

/** Other sessions on the database named `$1`, longest-connected first. */
export const LIST_DATABASE_SESSIONS_SQL =
  "SELECT pid, usename::text AS usename, application_name, client_addr::text AS client_addr, state, "
  + "EXTRACT(EPOCH FROM now() - backend_start)::bigint AS connected_secs, "
  + "EXTRACT(EPOCH FROM now() - state_change)::bigint AS state_secs, "
  + "left(query, 500) AS query "
  + "FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY backend_start, pid";

/** `42s`, `5m 3s`, `3h 12m`, `2d 4h`; empty for an unknown duration. */
export function formatDurationShort(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/**
 * Ends exactly the sessions `pids` on the database named `$1`, so anyone who
 * connected after the warning was shown is left alone (and a reused pid on
 * another database is not touched). Throws on a non-integer pid.
 */
export function buildTerminateSessionsSql(pids: readonly number[]): string {
  if (pids.length === 0) throw new Error("No sessions to disconnect.");
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid session id: ${pid}`);
  }
  return `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = $1 AND pid IN (${pids.join(", ")})`;
}

/** One line per session for a warning, e.g. `odoo · Odoo · 10.0.0.4 · idle in transaction (pid 4211)`. */
export function describeDatabaseSessions(sessions: readonly DatabaseSession[], max = 10): string {
  const lines = sessions.slice(0, max).map((s) => {
    const parts = [s.usename || "unknown user", s.application_name || null, s.client_addr || "local socket", s.state || "unknown state"];
    return `• ${parts.filter(Boolean).join(" · ")} (pid ${s.pid})`;
  });
  if (sessions.length > max) lines.push(`• …and ${sessions.length - max} more`);
  return lines.join("\n");
}
