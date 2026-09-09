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
 * Split a possibly schema-qualified display name (`devops.deployments`,
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
  return `DROP DATABASE ${quoteIdentifier(dbName, dbType as DatabaseType)}`;
}

/** `CREATE DATABASE` for PG/MySQL families. Throws for unsupported engines. */
export function buildCreateDatabaseSql(dbType: string, payload: CreateDatabaseOptions): string {
  const qid = (n: string) => quoteIdentifier(n, dbType as DatabaseType);
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
      sql += ` CONNECTION_LIMIT = ${payload.connectionLimit}`;
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
