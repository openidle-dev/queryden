import type { DdlDb } from "./pgDdl";
import { escapeSqlStringLiteral, quoteIdentifierPart } from "./sqlDialect";

type Row = Record<string, unknown>;

/** First string value whose column matches one of `keys`, case-insensitively. */
function pick(row: Row | undefined, keys: string[]): string | null {
  if (!row) return null;
  for (const [k, v] of Object.entries(row)) {
    if (keys.includes(k.toLowerCase()) && typeof v === "string") return v;
  }
  return null;
}

const asBool = (v: unknown) => v === true || v === "t" || v === "true";

/**
 * `CREATE DATABASE` for an existing database: rebuilt from `pg_database` on
 * PostgreSQL / Supabase, `SHOW CREATE DATABASE` on CockroachDB and
 * MySQL / MariaDB. A SQLite database is its file, so there is nothing to show.
 */
export async function buildDatabaseDdl(db: DdlDb, dbType: string, name: string): Promise<string> {
  const t = dbType.toLowerCase();
  if (t === "postgres" || t === "supabase") {
    const rows = (await db.select(
      `SELECT pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS encoding,
              d.datcollate AS lc_collate, d.datctype AS lc_ctype, ts.spcname AS tablespace,
              d.datconnlimit AS connlimit, d.datistemplate AS is_template, d.datallowconn AS allow_conn,
              shobj_description(d.oid, 'pg_database') AS comment
         FROM pg_database d
         LEFT JOIN pg_tablespace ts ON ts.oid = d.dattablespace
        WHERE d.datname = $1`,
      [name],
    )) as Row[];
    const d = rows[0];
    if (!d) return `-- Database ${name} not found.`;
    const q = (s: string) => quoteIdentifierPart(s, "postgres");
    const options = [
      d.owner ? `OWNER = ${q(String(d.owner))}` : null,
      d.encoding ? `ENCODING = ${escapeSqlStringLiteral(String(d.encoding))}` : null,
      d.lc_collate ? `LC_COLLATE = ${escapeSqlStringLiteral(String(d.lc_collate))}` : null,
      d.lc_ctype ? `LC_CTYPE = ${escapeSqlStringLiteral(String(d.lc_ctype))}` : null,
      d.tablespace ? `TABLESPACE = ${q(String(d.tablespace))}` : null,
      d.connlimit != null ? `CONNECTION LIMIT = ${Number(d.connlimit)}` : null,
      `IS_TEMPLATE = ${asBool(d.is_template) ? "True" : "False"}`,
      `ALLOW_CONNECTIONS = ${asBool(d.allow_conn) ? "True" : "False"}`,
    ].filter(Boolean);
    let ddl = `CREATE DATABASE ${q(name)}\n    WITH\n    ${options.join("\n    ")};`;
    if (d.comment) ddl += `\n\nCOMMENT ON DATABASE ${q(name)} IS ${escapeSqlStringLiteral(String(d.comment))};`;
    return ddl;
  }
  if (t === "cockroach") {
    const rows = (await db.select(`SHOW CREATE DATABASE ${quoteIdentifierPart(name, "postgres")}`)) as Row[];
    const ddl = pick(rows[0], ["create_statement"]);
    return ddl ? ddl.trimEnd().replace(/;?$/, ";") : `-- Database ${name} not found.`;
  }
  if (t === "mysql" || t === "mariadb") {
    const rows = (await db.select(`SHOW CREATE DATABASE ${quoteIdentifierPart(name, "mysql")}`)) as Row[];
    const ddl = pick(rows[0], ["create database"]);
    return ddl ? ddl.trimEnd().replace(/;?$/, ";") : `-- Database ${name} not found.`;
  }
  return "-- A SQLite database is a single file; there is no CREATE DATABASE statement.";
}
