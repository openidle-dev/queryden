import type { DdlDb } from "./pgDdl";
import { quoteName } from "./sqlGenerate";

export type ForeignObjectKind = "fdw" | "foreign_server" | "user_mapping";

/** Option names whose values are credentials; shown masked in generated DDL. */
const SECRET_OPTIONS = new Set(["password", "passfile", "sslpassword", "secret", "api_key", "token"]);
const MASK = "********";

const q = (name: string) => quoteName(name, "postgres");
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** `{host=db1,port=5432}` (pg text[] `key=value` items) → an `OPTIONS (...)` clause, secrets masked. */
export function formatFdwOptions(options: readonly string[] | null | undefined, indent = "  "): string {
  if (!options || options.length === 0) return "";
  const items = options.map((item) => {
    const eq = item.indexOf("=");
    const key = eq >= 0 ? item.slice(0, eq) : item;
    const value = eq >= 0 ? item.slice(eq + 1) : "";
    return `${q(key)} ${literal(SECRET_OPTIONS.has(key.toLowerCase()) ? MASK : value)}`;
  });
  return `\n${indent}OPTIONS (${items.join(", ")})`;
}

type Row = Record<string, unknown>;

/** A pg text[] column decoded by the driver: a JSON array, or psql's `{a,b}` text. */
function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1);
    if (!inner) return [];
    return inner.match(/"(?:[^"\\]|\\.)*"|[^,]+/g)?.map((s) => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s)) ?? [];
  }
  return [];
}

/**
 * CREATE statements for a foreign-data wrapper, foreign server or user
 * mapping, read from the catalog. `server` names the server a user mapping
 * belongs to.
 */
export async function buildForeignObjectDdl(db: DdlDb, kind: ForeignObjectKind, name: string, server?: string): Promise<string> {
  if (kind === "fdw") {
    const rows = (await db.select(
      `SELECT fdw.fdwname AS name,
              CASE WHEN fdw.fdwhandler = 0 THEN NULL ELSE fdw.fdwhandler::regproc::text END AS handler,
              CASE WHEN fdw.fdwvalidator = 0 THEN NULL ELSE fdw.fdwvalidator::regproc::text END AS validator,
              pg_get_userbyid(fdw.fdwowner) AS owner,
              fdw.fdwoptions AS options,
              (SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                WHERE d.classid = 'pg_foreign_data_wrapper'::regclass AND d.objid = fdw.oid AND d.deptype = 'e' LIMIT 1) AS extension
         FROM pg_foreign_data_wrapper fdw
        WHERE fdw.fdwname = $1`,
      [name],
    )) as Row[];
    const fdw = rows[0];
    if (!fdw) return `-- Foreign-data wrapper ${name} not found.`;
    const lines = [
      fdw.extension ? `-- Created by extension ${fdw.extension}: CREATE EXTENSION ${q(String(fdw.extension))};` : null,
      `CREATE FOREIGN DATA WRAPPER ${q(name)}`
        + (fdw.handler ? `\n  HANDLER ${fdw.handler}` : "\n  NO HANDLER")
        + (fdw.validator ? `\n  VALIDATOR ${fdw.validator}` : "\n  NO VALIDATOR")
        + formatFdwOptions(textArray(fdw.options))
        + ";",
      fdw.owner ? `\nALTER FOREIGN DATA WRAPPER ${q(name)} OWNER TO ${q(String(fdw.owner))};` : null,
    ];
    return lines.filter(Boolean).join("\n");
  }

  if (kind === "foreign_server") {
    const rows = (await db.select(
      `SELECT srv.srvname AS name, fdw.fdwname AS wrapper, srv.srvtype AS type, srv.srvversion AS version,
              srv.srvoptions AS options, pg_get_userbyid(srv.srvowner) AS owner
         FROM pg_foreign_server srv
         JOIN pg_foreign_data_wrapper fdw ON fdw.oid = srv.srvfdw
        WHERE srv.srvname = $1`,
      [name],
    )) as Row[];
    const srv = rows[0];
    if (!srv) return `-- Foreign server ${name} not found.`;
    return [
      `CREATE SERVER ${q(name)}`
        + (srv.type ? `\n  TYPE ${literal(String(srv.type))}` : "")
        + (srv.version ? `\n  VERSION ${literal(String(srv.version))}` : "")
        + `\n  FOREIGN DATA WRAPPER ${q(String(srv.wrapper))}`
        + formatFdwOptions(textArray(srv.options))
        + ";",
      srv.owner ? `\nALTER SERVER ${q(name)} OWNER TO ${q(String(srv.owner))};` : null,
    ].filter(Boolean).join("\n");
  }

  if (!server) return `-- The server for user mapping ${name} is unknown.`;
  const rows = (await db.select(
    `SELECT um.usename AS usename, um.umoptions AS options
       FROM pg_user_mappings um
      WHERE um.srvname = $1 AND um.usename = $2`,
    [server, name],
  )) as Row[];
  const mapping = rows[0];
  if (!mapping) return `-- User mapping for ${name} on ${server} not found.`;
  const user = name.toLowerCase() === "public" ? "PUBLIC" : q(name);
  const options = textArray(mapping.options);
  return `CREATE USER MAPPING FOR ${user}\n  SERVER ${q(server)}${formatFdwOptions(options)};`
    + (mapping.options == null ? "\n-- Options are only visible to the server's owner or a superuser." : "");
}
