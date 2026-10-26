/**
 * PostgreSQL object definitions built from the server's own deparsers
 * (`format_type`, `pg_get_constraintdef`, `pg_get_viewdef`,
 * `pg_get_functiondef`, `pg_get_indexdef`) — the same sources psql's `\d`
 * and pg_dump use — instead of reassembling DDL from information_schema,
 * which loses type modifiers (`varchar(80)` → `varchar`), identity columns,
 * CHECK constraints and multi-column keys.
 *
 * Every query takes the schema and name as separate text parameters and
 * resolves them server-side, so mixed-case and quoted names work and nothing
 * is interpolated into SQL.
 */

export interface DdlDb {
  select: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export type PgObjectKind = "auto" | "table" | "view" | "function";

export interface QualifiedName {
  schema: string | null;
  name: string;
}

/**
 * Parse `schema.name`, `"My Schema"."My Table"`, or `name(…)` the way
 * PostgreSQL resolves identifiers: unquoted parts fold to lower case, quoted
 * parts keep their case, and a trailing argument list is dropped.
 */
export function parseQualifiedName(raw: string): QualifiedName {
  const text = raw.trim().replace(/\s*\([^]*$/, "");
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      quoted = !quoted;
      wasQuoted = true;
      continue;
    }
    if (c === "." && !quoted) {
      parts.push(wasQuoted ? cur : cur.trim().toLowerCase());
      cur = "";
      wasQuoted = false;
      continue;
    }
    cur += c;
  }
  parts.push(wasQuoted ? cur : cur.trim().toLowerCase());
  const name = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : null;
  return { schema, name };
}

const quoteIdent = (s: string) => (/^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

/** `schema.name` with quoting only where PostgreSQL needs it. */
export function formatQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

// Resolve `$1` (schema, '' for none) + `$2` (name) to a relation OID: an
// explicit schema is used as-is, otherwise the search_path decides, like the
// server. "No schema" is '' rather than NULL so the parameter is always bound
// as text: a NULL binds as jsonb, and the cached prepared statement would then
// reject a later call that passes a real schema name.
const REL_OID = `(CASE WHEN $1::text = '' THEN to_regclass(quote_ident($2::text))
                       ELSE to_regclass(quote_ident($1::text) || '.' || quote_ident($2::text)) END)`;

interface RelRow {
  schema: string;
  name: string;
  kind: string;
}

async function rows<T>(db: DdlDb, sql: string, params: unknown[]): Promise<T[]> {
  return ((await db.select(sql, params)) as T[]) ?? [];
}

async function findRelation(db: DdlDb, q: QualifiedName): Promise<RelRow | null> {
  const found = await rows<RelRow>(
    db,
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = ${REL_OID}`,
    [q.schema ?? "", q.name],
  );
  if (found[0] || q.schema) return found[0] ?? null;
  // Unqualified and not on the search_path: any user schema that has it.
  const anywhere = await rows<RelRow>(
    db,
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1::text
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
      ORDER BY n.nspname
      LIMIT 1`,
    [q.name],
  );
  return anywhere[0] ?? null;
}

async function functionDdl(db: DdlDb, q: QualifiedName): Promise<string | null> {
  // Aggregates and window functions have no CREATE FUNCTION form; listing them
  // in the IN list would make pg_get_functiondef raise.
  const defs = await rows<{ def: string }>(
    db,
    `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = $2::text
        AND p.prokind IN ('f', 'p')
        AND (CASE WHEN $1::text = '' THEN pg_function_is_visible(p.oid) ELSE n.nspname = $1::text END)
      ORDER BY p.pronargs, p.oid`,
    [q.schema ?? "", q.name],
  );
  if (defs.length === 0 && !q.schema) {
    // Unqualified and not on the search_path: every user schema's overloads.
    const anywhere = await rows<{ def: string }>(
      db,
      `SELECT pg_get_functiondef(p.oid) AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = $1::text
          AND p.prokind IN ('f', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY n.nspname, p.pronargs, p.oid`,
      [q.name],
    );
    defs.push(...anywhere);
  }
  if (defs.length === 0) return null;
  return defs.map((d) => d.def.trimEnd().replace(/;?$/, ";")).join("\n\n");
}

async function viewDdl(db: DdlDb, rel: RelRow): Promise<string> {
  const [def] = await rows<{ def: string }>(
    db,
    `SELECT pg_get_viewdef(to_regclass(quote_ident($1::text) || '.' || quote_ident($2::text)), true) AS def`,
    [rel.schema, rel.name],
  );
  const keyword = rel.kind === "m" ? "CREATE MATERIALIZED VIEW" : "CREATE OR REPLACE VIEW";
  return `${keyword} ${formatQualified(rel.schema, rel.name)} AS\n${(def?.def ?? "").trimEnd().replace(/;?$/, ";")}`;
}

interface ColumnRow {
  name: string;
  type: string;
  notnull: boolean | string;
  def: string | null;
  identity: string;
  generated: string;
  comment: string | null;
}

async function tableDdl(db: DdlDb, rel: RelRow): Promise<string> {
  const params = [rel.schema, rel.name];
  const relExpr = `to_regclass(quote_ident($1::text) || '.' || quote_ident($2::text))`;

  const columns = await rows<ColumnRow>(
    db,
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull,
            pg_get_expr(d.adbin, d.adrelid) AS def,
            a.attidentity::text AS identity,
            a.attgenerated::text AS generated,
            col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ${relExpr} AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    params,
  );

  const constraints = await rows<{ name: string; def: string }>(
    db,
    `SELECT conname AS name, pg_get_constraintdef(oid, true) AS def
       FROM pg_constraint
      WHERE conrelid = ${relExpr} AND contype IN ('p', 'u', 'f', 'c', 'x')
      ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, conname`,
    params,
  );

  // Indexes that back a constraint are already printed by that constraint.
  const indexes = await rows<{ def: string }>(
    db,
    `SELECT pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
      WHERE i.indrelid = ${relExpr}
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
      ORDER BY i.indexrelid`,
    params,
  );

  const [tableComment] = await rows<{ comment: string | null }>(
    db,
    `SELECT obj_description(${relExpr}, 'pg_class') AS comment`,
    params,
  );

  const qualified = formatQualified(rel.schema, rel.name);
  const lines = columns.map((c) => {
    let line = `${quoteIdent(c.name)} ${c.type}`;
    if (c.generated === "s" && c.def) line += ` GENERATED ALWAYS AS (${c.def}) STORED`;
    else if (c.identity === "a") line += " GENERATED ALWAYS AS IDENTITY";
    else if (c.identity === "d") line += " GENERATED BY DEFAULT AS IDENTITY";
    else if (c.def) line += ` DEFAULT ${c.def}`;
    if (c.notnull === true || c.notnull === "t") line += " NOT NULL";
    return line;
  });
  for (const con of constraints) lines.push(`CONSTRAINT ${quoteIdent(con.name)} ${con.def}`);

  const kindWord = rel.kind === "f" ? "CREATE FOREIGN TABLE" : "CREATE TABLE";
  let ddl = `${kindWord} ${qualified} (\n${lines.map((l) => `  ${l}`).join(",\n")}\n)${rel.kind === "p" ? " PARTITION BY …" : ""};`;
  for (const idx of indexes) ddl += `\n\n${idx.def};`;
  if (tableComment?.comment) ddl += `\n\nCOMMENT ON TABLE ${qualified} IS ${quoteLiteral(tableComment.comment)};`;
  for (const c of columns) {
    if (c.comment) ddl += `\nCOMMENT ON COLUMN ${qualified}.${quoteIdent(c.name)} IS ${quoteLiteral(c.comment)};`;
  }
  return ddl;
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * DDL for `rawName`. With `kind: "auto"` the object type is resolved on the
 * server: a relation if one is visible under that name, otherwise a function.
 * A name typed as a call (`schema.fn()`) is looked up as a function first.
 */
export async function buildPgDdl(db: DdlDb, rawName: string, kind: PgObjectKind = "auto"): Promise<string> {
  const looksLikeCall = rawName.includes("(");
  const candidates = nameCandidates(rawName);

  const tryFunction = async () => {
    for (const q of candidates) {
      const fn = await functionDdl(db, q);
      if (fn) return fn;
    }
    return null;
  };

  if (kind === "function" || (kind === "auto" && looksLikeCall)) {
    const fn = await tryFunction();
    if (fn) return fn;
    if (kind === "function") return `-- Function ${rawName} not found`;
  }

  for (const q of candidates) {
    const rel = await findRelation(db, q);
    if (!rel) continue;
    if (rel.kind === "v" || rel.kind === "m") return viewDdl(db, rel);
    if (["r", "p", "f"].includes(rel.kind)) return tableDdl(db, rel);
    return `-- ${rawName} is a ${relKindLabel(rel.kind)}; no CREATE statement to show`;
  }

  if (kind === "auto" && !looksLikeCall) {
    const fn = await tryFunction();
    if (fn) return fn;
  }
  return `-- No table, view or function named ${rawName} is visible on the current search_path`;
}

/**
 * Names to try, in order: the exact text (explorer nodes pass real,
 * case-preserved names like `reporting.Releases`), then PostgreSQL's folded
 * reading of it (what the server would resolve for typed SQL).
 */
export function nameCandidates(rawName: string): QualifiedName[] {
  const folded = parseQualifiedName(rawName);
  const bare = rawName.trim().replace(/\s*\([^]*$/, "");
  const out: QualifiedName[] = [];
  if (!bare.includes('"')) {
    const dot = bare.lastIndexOf(".");
    out.push(dot === -1 ? { schema: null, name: bare } : { schema: bare.slice(0, dot), name: bare.slice(dot + 1) });
  }
  if (!out.some((q) => q.schema === folded.schema && q.name === folded.name)) out.push(folded);
  return out;
}

function relKindLabel(kind: string): string {
  switch (kind) {
    case "S": return "sequence";
    case "i":
    case "I": return "index";
    case "c": return "composite type";
    case "t": return "TOAST table";
    default: return `relation of kind '${kind}'`;
  }
}
