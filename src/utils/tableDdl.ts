import { buildPgDdl, type DdlDb } from "./pgDdl";
import { splitTableName, tableReference } from "./sqlGenerate";
import { dialectForDbType } from "../components/editor/sqlBuiltins";

type Row = Record<string, unknown>;

/** First value of the first row whose key matches one of `keys`, case-insensitively. */
function pick(rows: Row[], keys: string[]): string | null {
  const row = rows[0];
  if (!row) return null;
  for (const [k, v] of Object.entries(row)) {
    if (keys.includes(k.toLowerCase()) && typeof v === "string") return v;
  }
  return null;
}

/**
 * CREATE statement for a result's table on any supported engine:
 * PostgreSQL / Supabase through the catalog-based builder, CockroachDB and
 * MySQL / MariaDB through `SHOW CREATE TABLE`, SQLite from `sqlite_master`
 * (with the table's indexes and triggers).
 */
export async function buildTableDdl(db: DdlDb, dbType: string, table: string, schema?: string): Promise<string> {
  const dialect = dialectForDbType(dbType);
  const name = tableReference({ table, schema, dialect }, true);

  if (dbType === "postgres" || dbType === "supabase") {
    return buildPgDdl(db, name, "auto");
  }
  if (dbType === "cockroach" || dbType === "mysql" || dbType === "mariadb") {
    const rows = (await db.select(`SHOW CREATE TABLE ${name}`)) as Row[];
    const ddl = pick(rows, ["create_statement", "create table", "create view"]);
    return ddl ? `${ddl.trimEnd().replace(/;?$/, ";")}` : `-- No definition found for ${name}.`;
  }
  if (dbType === "sqlite") {
    const rows = (await db.select(
      "SELECT sql FROM sqlite_master WHERE tbl_name = $1 AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name",
      [splitTableName(table).table],
    )) as Row[];
    const statements = rows.map((r) => String(r.sql).trimEnd().replace(/;?$/, ";"));
    return statements.length > 0 ? statements.join("\n\n") : `-- No definition found for ${name}.`;
  }
  return `-- DDL is not available for ${dbType} connections.`;
}
