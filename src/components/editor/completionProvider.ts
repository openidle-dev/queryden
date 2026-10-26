/**
 * SQL completion, DataGrip-style: what is offered — and in what order —
 * depends on where the caret is in the current statement.
 *
 * - After FROM / JOIN / UPDATE / INTO: tables and views (plus schemas), and
 *   foreign-key JOIN snippets that connect to tables already in the query.
 * - In SELECT / WHERE / ON / SET / ORDER BY …: the columns of the tables the
 *   statement references (even ones named after the caret, `SELECT | FROM t`)
 *   first, with their types, then functions, then everything else.
 * - After `::`, CAST(… AS, column definitions: data types.
 * - After a complete table reference: the clauses that can follow.
 * - `alias.` / `table.` / `schema.`: only that object's members.
 *
 * Pure: takes text + schema, returns plain items, so it is unit-tested
 * without Monaco. `QueryEditor` maps the items onto Monaco's types.
 */

import {
  detectCompletionClause,
  detectSchemaDotContext,
  extractExistingAliases,
  extractTableRefs,
  generateTableAlias,
  quoteIdentifierIfNeeded,
  tableKey,
  tokenizeSql,
  type CompletionSchemaLike,
  type TableRef,
} from "./completionContext";
import { builtinFunctionsFor, builtinLabel, type SqlDialect } from "./sqlBuiltins";

export type CompletionKind = "keyword" | "function" | "column" | "table" | "view" | "schema" | "type" | "snippet";

export interface CompletionItemLike {
  label: string;
  kind: CompletionKind;
  insertText: string;
  /** Insert text uses snippet syntax (`$0`, `${1:x}`). */
  snippet?: boolean;
  detail?: string;
  documentation?: string;
  sortText: string;
  /** Text Monaco filters on, when it differs from the label. */
  filterText?: string;
  /** Open parameter hints after inserting (function calls). */
  triggerParameterHints?: boolean;
  /** Reopen suggestions after inserting (`schema.`). */
  retrigger?: boolean;
  /** 1-based column where replacement starts; defaults to the word start. */
  replaceFromColumn?: number;
}

export interface CompletionRequest {
  /** Whole document. */
  text: string;
  /** Caret offset (0-based) into `text`. */
  offset: number;
  /** Start/end (0-based) of the statement around the caret. */
  statementStart: number;
  statementEnd: number;
  /** The caret's line and 1-based column (for `x.` contexts). */
  lineText: string;
  column: number;
  schema: CompletionSchemaLike | null;
  dialect: SqlDialect;
}

const KEYWORDS_COMMON = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN",
  "ON", "USING", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "UNION", "UNION ALL", "EXCEPT",
  "INTERSECT", "DISTINCT", "AS", "AND", "OR", "NOT", "IN", "NOT IN", "EXISTS", "NOT EXISTS", "BETWEEN",
  "LIKE", "IS NULL", "IS NOT NULL", "CASE", "WHEN", "THEN", "ELSE", "END", "ASC", "DESC", "NULLS FIRST",
  "NULLS LAST", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "WITH", "WITH RECURSIVE",
  "CREATE TABLE", "CREATE INDEX", "CREATE VIEW", "ALTER TABLE", "DROP TABLE", "DROP INDEX", "TRUNCATE",
  "PRIMARY KEY", "FOREIGN KEY", "REFERENCES", "DEFAULT", "NOT NULL", "UNIQUE", "CHECK", "CONSTRAINT",
  "BEGIN", "COMMIT", "ROLLBACK", "EXPLAIN", "TRUE", "FALSE", "NULL", "OVER", "PARTITION BY",
];
const KEYWORDS_BY_DIALECT: Record<SqlDialect, string[]> = {
  postgres: [
    "ILIKE", "NOT ILIKE", "RETURNING", "ON CONFLICT", "DO NOTHING", "DO UPDATE SET", "LATERAL", "FILTER",
    "WINDOW", "FETCH FIRST", "ROWS ONLY", "FOR UPDATE", "SKIP LOCKED", "EXPLAIN ANALYZE", "VACUUM", "ANALYZE",
    "CREATE OR REPLACE FUNCTION", "CREATE SCHEMA", "CREATE EXTENSION", "CREATE MATERIALIZED VIEW",
    "REFRESH MATERIALIZED VIEW", "GRANT", "REVOKE", "COPY", "DO", "SIMILAR TO", "IS DISTINCT FROM",
    "AT TIME ZONE", "INTERVAL", "GENERATED ALWAYS AS IDENTITY", "IF EXISTS", "IF NOT EXISTS", "CASCADE",
  ],
  mysql: [
    "ON DUPLICATE KEY UPDATE", "REPLACE INTO", "SHOW TABLES", "SHOW DATABASES", "SHOW COLUMNS FROM",
    "SHOW CREATE TABLE", "DESCRIBE", "USE", "AUTO_INCREMENT", "ENGINE", "STRAIGHT_JOIN", "REGEXP",
    "IF EXISTS", "IF NOT EXISTS", "FOR UPDATE", "LOCK IN SHARE MODE", "INTERVAL",
  ],
  sqlite: [
    "INSERT OR REPLACE INTO", "INSERT OR IGNORE INTO", "ON CONFLICT", "DO NOTHING", "DO UPDATE SET",
    "RETURNING", "PRAGMA", "AUTOINCREMENT", "WITHOUT ROWID", "GLOB", "IF EXISTS", "IF NOT EXISTS",
    "VACUUM", "ATTACH DATABASE",
  ],
};

/** Clauses that can follow a complete table reference. */
const AFTER_TABLE_KEYWORDS = [
  "JOIN", "LEFT JOIN", "INNER JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "ON", "USING", "WHERE",
  "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "SET", "VALUES", "SELECT", "RETURNING", "UNION", "AS",
];

const TYPES_BY_DIALECT: Record<SqlDialect, string[]> = {
  postgres: [
    "integer", "bigint", "smallint", "numeric", "numeric(12, 2)", "real", "double precision", "serial",
    "bigserial", "text", "varchar", "varchar(255)", "char", "boolean", "date", "time", "timestamp",
    "timestamptz", "interval", "uuid", "json", "jsonb", "bytea", "inet", "cidr", "money", "text[]",
    "integer[]", "tsvector", "xml",
  ],
  mysql: [
    "INT", "BIGINT", "SMALLINT", "TINYINT", "DECIMAL(12, 2)", "FLOAT", "DOUBLE", "VARCHAR(255)", "CHAR",
    "TEXT", "MEDIUMTEXT", "LONGTEXT", "BOOLEAN", "DATE", "DATETIME", "TIMESTAMP", "TIME", "YEAR", "JSON",
    "BLOB", "BINARY(16)", "ENUM", "SET",
  ],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC", "BOOLEAN", "DATE", "DATETIME"],
};

interface ColumnInfo {
  table: string;
  name: string;
  type?: string;
}

// Schema snapshots are immutable; index each once.
const columnIndexCache = new WeakMap<object, Map<string, ColumnInfo[]>>();
function columnIndex(schema: CompletionSchemaLike): Map<string, ColumnInfo[]> {
  let index = columnIndexCache.get(schema);
  if (!index) {
    index = new Map();
    for (const c of schema.columns ?? []) {
      const key = tableKey(c.table_name);
      let list = index.get(key);
      if (!list) {
        list = [];
        index.set(key, list);
      }
      list.push({ table: c.table_name, name: c.column_name, type: c.data_type });
    }
    columnIndexCache.set(schema, index);
  }
  return index;
}

const pad = (n: number) => String(n).padStart(5, "0");

/** `schema.table` with each part quoted only when needed. */
export function quoteQualified(name: string, dialect: SqlDialect): string {
  return name
    .split(".")
    .map((part) => quoteIdentifierIfNeeded(part, dialect))
    .join(".");
}

/** Columns of a referenced table, resolved through the public schema too. */
function columnsFor(ref: TableRef, index: Map<string, ColumnInfo[]>): ColumnInfo[] {
  const key = tableKey(ref.table);
  return index.get(key) ?? index.get(key.split(".").pop() ?? key) ?? [];
}

function functionItems(schema: CompletionSchemaLike | null, dialect: SqlDialect, rank: string): CompletionItemLike[] {
  const items: CompletionItemLike[] = [];
  const seen = new Set<string>();
  for (const f of builtinFunctionsFor(dialect)) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    items.push({
      label: f.name,
      kind: "function",
      insertText: f.params.length === 0 ? `${f.name}()` : `${f.name}($0)`,
      snippet: f.params.length > 0,
      detail: builtinLabel(f),
      documentation: f.doc,
      sortText: `${rank}${f.name.toLowerCase()}`,
      triggerParameterHints: f.params.length > 0,
    });
  }
  for (const fn of schema?.functions ?? []) {
    const lower = fn.toLowerCase();
    if (seen.has(fn.toUpperCase())) continue;
    items.push({
      label: fn,
      kind: "function",
      insertText: `${quoteQualified(fn, dialect)}($0)`,
      snippet: true,
      detail: "function",
      sortText: `${rank}${lower}`,
      triggerParameterHints: true,
    });
  }
  return items;
}

function keywordItems(dialect: SqlDialect, rank: string, only?: string[]): CompletionItemLike[] {
  const words = only ?? [...KEYWORDS_COMMON, ...KEYWORDS_BY_DIALECT[dialect]];
  return words.map((k, i) => ({
    label: k,
    kind: "keyword" as const,
    insertText: `${k} `,
    sortText: `${rank}${only ? pad(i) : k.toLowerCase()}`,
  }));
}

function tableItems(
  schema: CompletionSchemaLike,
  dialect: SqlDialect,
  rank: string,
  withAlias: boolean,
  existingAliases: Set<string>,
): CompletionItemLike[] {
  const items: CompletionItemLike[] = [];
  const add = (name: string, kind: "table" | "view") => {
    const quoted = quoteQualified(name, dialect);
    const alias = withAlias ? generateTableAlias(name, existingAliases) : "";
    const bare = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
    items.push({
      label: name,
      kind,
      insertText: alias ? `${quoted} ${alias}` : quoted,
      detail: alias ? `${kind} → ${alias}` : kind,
      sortText: `${rank}0${bare.toLowerCase()}`,
      // Typing the bare name (`users`) must still find `app.users`.
      filterText: name.includes(".") ? `${bare} ${name}` : undefined,
    });
  };
  schema.tables?.forEach((t) => add(t, "table"));
  schema.views?.forEach((v) => add(v, "view"));
  const schemas = new Set<string>();
  for (const name of [...(schema.tables ?? []), ...(schema.views ?? [])]) {
    if (name.includes(".")) schemas.add(name.slice(0, name.indexOf(".")));
  }
  for (const sch of schemas) {
    items.push({
      label: sch,
      kind: "schema",
      insertText: `${quoteIdentifierIfNeeded(sch, dialect)}.`,
      detail: "schema",
      sortText: `${rank}1${sch.toLowerCase()}`,
      retrigger: true,
    });
  }
  return items;
}

/** FK snippets for `JOIN |`: tables that join to one already in the query. */
function joinSnippets(
  schema: CompletionSchemaLike,
  refs: TableRef[],
  dialect: SqlDialect,
  existingAliases: Set<string>,
): CompletionItemLike[] {
  const inScope = new Map<string, string>(); // table key → alias or name as written
  for (const r of refs) inScope.set(tableKey(r.table), r.alias ?? r.table);
  const items: CompletionItemLike[] = [];
  const seen = new Set<string>();
  for (const fk of schema.foreignKeys ?? []) {
    const src = tableKey(fk.source_table);
    const tgt = tableKey(fk.target_table);
    const pairs: Array<[string, string, string, string]> = [];
    if (inScope.has(src) && !inScope.has(tgt)) pairs.push([fk.target_table, fk.target_column, inScope.get(src)!, fk.source_column]);
    if (inScope.has(tgt) && !inScope.has(src)) pairs.push([fk.source_table, fk.source_column, inScope.get(tgt)!, fk.target_column]);
    for (const [table, column, otherQualifier, otherColumn] of pairs) {
      const alias = generateTableAlias(table, existingAliases);
      const text = `${quoteQualified(table, dialect)} ${alias} ON ${alias}.${quoteIdentifierIfNeeded(column, dialect)} = ${otherQualifier}.${quoteIdentifierIfNeeded(otherColumn, dialect)}`;
      if (seen.has(text)) continue;
      seen.add(text);
      items.push({
        label: text,
        kind: "snippet",
        insertText: text,
        detail: "join on foreign key",
        sortText: `0${pad(items.length)}`,
        filterText: `${table} ${text}`,
      });
    }
  }
  return items;
}

/** FK conditions for `… JOIN b ON |` between tables already in the query. */
function onConditions(schema: CompletionSchemaLike, refs: TableRef[], dialect: SqlDialect): CompletionItemLike[] {
  const qualifier = new Map<string, string>();
  for (const r of refs) qualifier.set(tableKey(r.table), r.alias ?? r.table);
  const items: CompletionItemLike[] = [];
  for (const fk of schema.foreignKeys ?? []) {
    const a = qualifier.get(tableKey(fk.source_table));
    const b = qualifier.get(tableKey(fk.target_table));
    if (!a || !b) continue;
    const text = `${a}.${quoteIdentifierIfNeeded(fk.source_column, dialect)} = ${b}.${quoteIdentifierIfNeeded(fk.target_column, dialect)}`;
    items.push({ label: text, kind: "snippet", insertText: text, detail: "foreign key", sortText: `0${pad(items.length)}` });
  }
  return items;
}

function typeItems(schema: CompletionSchemaLike | null, dialect: SqlDialect): CompletionItemLike[] {
  const builtin = TYPES_BY_DIALECT[dialect].map((t, i) => ({
    label: t,
    kind: "type" as const,
    insertText: t,
    detail: "type",
    sortText: `0${pad(i)}`,
  }));
  const custom = (schema?.types ?? []).map((t) => ({
    label: t,
    kind: "type" as const,
    insertText: quoteQualified(t, dialect),
    detail: "user-defined type",
    sortText: `1${t.toLowerCase()}`,
  }));
  return [...builtin, ...custom];
}

/** `x.|` → members of x: a table alias / table's columns, or a schema's tables. */
function dotItems(req: CompletionRequest, refs: TableRef[]): CompletionItemLike[] | null {
  const before = req.lineText.slice(0, req.column - 1);
  const m = /((?:"[^"]+"|`[^`]+`|[\w$]+))\.([\w$]*)$/.exec(before);
  if (!m) return null;
  const qualifier = m[1].replace(/^["`]|["`]$/g, "");
  const replaceFromColumn = req.column - m[2].length;
  const schema = req.schema;
  if (!schema) return [];
  const index = columnIndex(schema);
  const lower = qualifier.toLowerCase();

  // Alias or table name used in this statement.
  const ref =
    refs.find((r) => r.alias?.toLowerCase() === lower) ??
    refs.find((r) => tableKey(r.table) === tableKey(qualifier) || tableKey(r.table).split(".").pop() === lower);
  const columns = ref ? columnsFor(ref, index) : index.get(tableKey(qualifier)) ?? [];
  if (columns.length > 0) {
    return columns.map((c, i) => ({
      label: c.name,
      kind: "column" as const,
      insertText: quoteIdentifierIfNeeded(c.name, req.dialect),
      detail: c.type ? `${c.type} · ${c.table}` : c.table,
      sortText: pad(i),
      replaceFromColumn,
    }));
  }

  // `schema.` → that schema's tables, views and functions.
  const tables = detectSchemaDotContext(req.lineText, req.column, schema.tables ?? []);
  const views = detectSchemaDotContext(req.lineText, req.column, schema.views ?? []);
  const fns = detectSchemaDotContext(req.lineText, req.column, schema.functions ?? []);
  const out: CompletionItemLike[] = [];
  tables?.bareNames.forEach((n, i) =>
    out.push({ label: n, kind: "table", insertText: quoteIdentifierIfNeeded(n, req.dialect), detail: `table in ${qualifier}`, sortText: `0${pad(i)}`, replaceFromColumn }),
  );
  views?.bareNames.forEach((n, i) =>
    out.push({ label: n, kind: "view", insertText: quoteIdentifierIfNeeded(n, req.dialect), detail: `view in ${qualifier}`, sortText: `1${pad(i)}`, replaceFromColumn }),
  );
  fns?.bareNames.forEach((n, i) =>
    out.push({
      label: n,
      kind: "function",
      insertText: `${quoteIdentifierIfNeeded(n, req.dialect)}($0)`,
      snippet: true,
      detail: `function in ${qualifier}`,
      sortText: `2${pad(i)}`,
      replaceFromColumn,
      triggerParameterHints: true,
    }),
  );
  return out;
}

const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const names = (list: unknown): string[] => (Array.isArray(list) ? list.filter(isName) : []);

// Catalogue rows come from many engines and fetch paths; one null name must
// not throw out of the provider and take every suggestion with it.
const cleanSchemaCache = new WeakMap<object, CompletionSchemaLike>();
function cleanSchema(schema: CompletionSchemaLike): CompletionSchemaLike {
  let clean = cleanSchemaCache.get(schema);
  if (!clean) {
    clean = {
      tables: names(schema.tables),
      views: names(schema.views),
      functions: names(schema.functions),
      types: names(schema.types),
      columns: (Array.isArray(schema.columns) ? schema.columns : []).filter(
        (c) => !!c && isName(c.table_name) && isName(c.column_name),
      ).map((c) => (typeof c.data_type === "string" || c.data_type === undefined ? c : { ...c, data_type: undefined })),
      foreignKeys: (Array.isArray(schema.foreignKeys) ? schema.foreignKeys : []).filter(
        (fk) => !!fk && isName(fk.source_table) && isName(fk.source_column) && isName(fk.target_table) && isName(fk.target_column),
      ),
      _ts: schema._ts,
    };
    cleanSchemaCache.set(schema, clean);
  }
  return clean;
}

export function buildCompletions(rawReq: CompletionRequest): CompletionItemLike[] {
  const req = rawReq.schema ? { ...rawReq, schema: cleanSchema(rawReq.schema) } : rawReq;
  const statement = req.text.slice(req.statementStart, req.statementEnd);
  const caretInStatement = Math.max(0, Math.min(req.offset - req.statementStart, statement.length));
  const beforeCaret = statement.slice(0, caretInStatement);
  const refs = extractTableRefs(statement);
  const { schema, dialect } = req;

  const dot = dotItems(req, refs);
  if (dot) return dot;

  const clause = detectCompletionClause(beforeCaret);
  if (clause === "type") return typeItems(schema, dialect);

  const existingAliases = extractExistingAliases(statement);
  const index = schema ? columnIndex(schema) : null;
  const items: CompletionItemLike[] = [];

  // Columns of the tables this statement references (with types).
  const scopedColumns = (rank: string) => {
    if (!index) return;
    if (refs.length === 0) {
      // No FROM yet (`SELECT |`): offer columns from everywhere, ranked low.
      let count = 0;
      for (const list of index.values()) {
        for (const c of list) {
          if (count++ >= 2000) return;
          items.push({
            label: c.name,
            kind: "column",
            insertText: quoteIdentifierIfNeeded(c.name, dialect),
            detail: c.type ? `${c.type} · ${c.table}` : c.table,
            sortText: `8${c.name.toLowerCase()}`,
          });
        }
      }
      return;
    }
    const multipleTables = refs.length > 1;
    const seen = new Set<string>();
    refs.forEach((ref, refIndex) => {
      columnsFor(ref, index).forEach((c, colIndex) => {
        const qualifier = ref.alias ?? ref.table.split(".").pop()!;
        const key = `${qualifier}.${c.name}`;
        if (seen.has(key)) return;
        seen.add(key);
        const quoted = quoteIdentifierIfNeeded(c.name, dialect);
        items.push({
          label: multipleTables ? `${qualifier}.${c.name}` : c.name,
          kind: "column",
          // With several tables in scope, qualify so the column is unambiguous.
          insertText: multipleTables ? `${quoteIdentifierIfNeeded(qualifier, dialect)}.${quoted}` : quoted,
          detail: c.type ? `${c.type} · ${c.table}` : c.table,
          // The table's own column order, as DataGrip lists them.
          sortText: `${rank}${pad(refIndex)}${pad(colIndex)}`,
          filterText: multipleTables ? `${c.name} ${qualifier}.${c.name}` : undefined,
        });
      });
    });
  };

  const lastIntroducer = (() => {
    const tokens = tokenizeSql(beforeCaret);
    for (let k = tokens.length - 1; k >= 0; k--) {
      const w = tokens[k].kind === "word" ? tokens[k].text.toUpperCase() : "";
      if (["FROM", "JOIN", "UPDATE", "INTO", "TABLE"].includes(w)) return w;
    }
    return null;
  })();

  switch (clause) {
    case "table": {
      const fromItem = lastIntroducer === "FROM" || lastIntroducer === "JOIN";
      if (schema) {
        if (lastIntroducer === "JOIN") items.push(...joinSnippets(schema, refs, dialect, existingAliases));
        items.push(...tableItems(schema, dialect, "1", fromItem, existingAliases));
      }
      items.push(...keywordItems(dialect, "9", ["LATERAL", "ONLY", "SELECT"]));
      break;
    }
    case "keyword":
      items.push(...keywordItems(dialect, "0", AFTER_TABLE_KEYWORDS));
      items.push(...keywordItems(dialect, "5"));
      break;
    case "column": {
      const lastWord = tokenizeSql(beforeCaret).filter((t) => t.kind === "word").pop()?.text.toUpperCase();
      if (lastWord === "ON" && schema) items.push(...onConditions(schema, refs, dialect));
      scopedColumns("1");
      items.push(...functionItems(schema, dialect, "3"));
      items.push(...keywordItems(dialect, "4"));
      if (schema) items.push(...tableItems(schema, dialect, "6", false, existingAliases));
      break;
    }
    default:
      scopedColumns("1");
      items.push(...keywordItems(dialect, "2"));
      items.push(...functionItems(schema, dialect, "3"));
      if (schema) items.push(...tableItems(schema, dialect, "4", lastIntroducer === "FROM" || lastIntroducer === "JOIN", existingAliases));
  }

  // De-duplicate on what gets inserted (a keyword phrase and a table can share a label).
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = `${it.kind}:${it.insertText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
