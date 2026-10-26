// Helpers for SQL autocomplete context detection, extracted from QueryEditor.tsx
// so they can be unit-tested without spinning up Monaco.
//
// Both helpers solve the same underlying problem (issue #28): Monaco's default fuzzy matcher
// treats `.` as a member-access trigger and filters out completion labels that don't share a
// bare-name representation with the typed text. The fix is to detect `<prefix>.<typed>` context
// up-front and return tightly-scoped bare-name suggestions with a replacement range that covers
// only the text after the dot.

const IDENT_CHAR = /[A-Za-z0-9_]/;

interface DotContextBase {
  /** The identifier immediately before the dot, with its original casing. */
  prefix: string;
  /** 1-indexed Monaco column at which the replacement range should start (just after the `.`). */
  rangeStartColumn: number;
}

// Walk back from immediately before the cursor over identifier characters, then verify the next
// character is a `.`, then capture the identifier before that dot. Returns null if the cursor
// isn't sitting inside an `<identifier>.<partial>` context.
function findDotContext(
  lineContent: string,
  cursorColumn: number,
): DotContextBase | null {
  let i = cursorColumn - 2;
  while (i >= 0 && IDENT_CHAR.test(lineContent[i])) i--;
  if (i < 0 || lineContent[i] !== ".") return null;

  const dotIndex = i;
  let j = dotIndex - 1;
  while (j >= 0 && IDENT_CHAR.test(lineContent[j])) j--;
  const prefix = lineContent.substring(j + 1, dotIndex);
  if (!prefix) return null;

  return { prefix, rangeStartColumn: dotIndex + 2 };
}

export interface SchemaDotMatch {
  /** The schema identifier the user typed, with its original casing. */
  schema: string;
  /** Entries from `qualifiedNames` that live under this schema, in their original casing. */
  qualifiedNames: string[];
  /** Table/view/function-only portion of each match (what to render as the suggestion label). */
  bareNames: string[];
  /** 1-indexed Monaco column at which the replacement range should start. */
  rangeStartColumn: number;
}

// Detect whether the cursor sits inside a `<schema>.<partial>` autocomplete context against the
// given pool of schema-qualified names (typically `items.tables`, `items.views`, or
// `items.functions`). Returns null when the prefix isn't a real schema — callers should treat
// that case as "fall through to alias-or-table detection".
//
// Postgres exposes tables in the `public` schema as bare names (no `schema.` prefix). When the
// user explicitly types `public.`, those bare-named entries are still surfaced.
export function detectSchemaDotContext(
  lineContent: string,
  cursorColumn: number,
  qualifiedNames: readonly string[],
): SchemaDotMatch | null {
  const base = findDotContext(lineContent, cursorColumn);
  if (!base) return null;

  const prefixLower = base.prefix.toLowerCase();
  const prefixDot = prefixLower + ".";

  const qualifiedMatches = qualifiedNames.filter(
    n => n.toLowerCase().startsWith(prefixDot),
  );
  const bareNames = qualifiedMatches.map(n => n.substring(n.indexOf(".") + 1));

  if (prefixLower === "public") {
    for (const n of qualifiedNames) {
      if (!n.includes(".")) bareNames.push(n);
    }
  }

  if (bareNames.length === 0) return null;

  return {
    schema: base.prefix,
    qualifiedNames: qualifiedMatches,
    bareNames,
    rangeStartColumn: base.rangeStartColumn,
  };
}

// Minimal structural contract the completion provider needs. `SchemaItems`
// (ConnectionContext) satisfies this; keeping it structural avoids importing
// the context (and its Tauri/IPC chain) into the unit-testable helper layer.
export interface CompletionSchemaLike {
  tables?: string[];
  views?: string[];
  functions?: string[];
  /** User-defined types (enums, domains, composites) — offered after `::`. */
  types?: string[];
  columns?: { table_name: string; column_name: string; data_type?: string }[];
  foreignKeys?: { source_table: string; source_column: string; target_table: string; target_column: string }[];
  _ts?: number;
}

export interface CompletionSchemaSource {
  /** Schema of the globally-active (sidebar-connected) connection, if any. */
  globalItems: CompletionSchemaLike | null;
  globalConnId: string | null;
  /** Background-fetched schema for the tab's own target connection, if any. */
  tabItems: CompletionSchemaLike | null;
  tabConnId: string | null;
  /** Connection the active editor tab targets (`undefined` = no explicit target). */
  targetConnId: string | null | undefined;
}

// DataGrip rule: an editor tab completes against ITS OWN connection, not
// whatever happens to be sidebar-active. When the tab targets a connection
// whose schema was background-fetched, that wins; when the tab targets the
// globally-active connection, the global schema wins (no duplicate fetch);
// with no usable cache for the target, fall back to whichever schema exists
// rather than completing against nothing.
export function pickCompletionSchema(src: CompletionSchemaSource): CompletionSchemaLike | null {
  const { globalItems, globalConnId, tabItems, tabConnId, targetConnId } = src;
  if (targetConnId) {
    if (tabConnId === targetConnId && tabItems) return tabItems;
    if (globalConnId === targetConnId && globalItems) return globalItems;
    return tabItems ?? globalItems ?? null;
  }
  return globalItems ?? tabItems ?? null;
}

// Smart alias generation - like DataGrip/DBeaver
// Generates alias from table name: "users" -> "u", "user_roles" -> "ur", "project_issue" -> "pi"
export function generateTableAlias(tableName: string, existingAliases: Set<string>): string {
  if (!tableName) return "t";
  // Remove schema prefix if present (e.g., "public.users" -> "users")
  const cleanName = tableName.includes('.') ? tableName.split('.').pop() || tableName : tableName;

  // Split by underscore or use first letters
  const words = cleanName.split(/[_-]/);

  // First character of a word, tolerating empty segments from leading or
  // repeated separators (e.g. "_migrations" -> ["", "migrations"]). Indexing
  // an empty string yields `undefined`, and `undefined + undefined` is NaN —
  // whose `.toLowerCase()` throws and kills the whole completion provider.
  const firstChar = (w: string | undefined): string => (w && w[0] ? w[0] : "");

  let alias: string;
  if (words.length >= 2) {
    // Multi-word: take first letter of first two words (e.g., "project_issue" -> "pi")
    alias = (firstChar(words[0]) + firstChar(words[1])).toLowerCase();
  } else if (cleanName.length >= 2) {
    // Single word: first 2 characters
    alias = cleanName.substring(0, 2).toLowerCase();
  } else {
    alias = cleanName.toLowerCase();
  }
  if (!alias) alias = "t";

  // If alias already exists, append number (like DBeaver: u, u2, u3)
  if (existingAliases.has(alias)) {
    let counter = 2;
    while (existingAliases.has(alias + counter)) {
      counter++;
    }
    alias = alias + counter;
  }

  return alias;
}

// Extract all aliases currently used in the query
export function extractExistingAliases(query: string): Set<string> {
  const aliases = new Set<string>();
  // Match patterns like "table_name AS alias" or "table_name alias" after FROM/JOIN
  const aliasPattern = /(?:FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN)\s+[\w"]+\.?\w+\s+(?:AS\s+)?(\w+)/gi;
  let match;
  while ((match = aliasPattern.exec(query)) !== null) {
    if (match[1] && match[1].length <= 3) {  // Short aliases only
      aliases.add(match[1].toLowerCase());
    }
  }
  return aliases;
}

// ─── Statement-scoped completion ────────────────────────────────────────────
// DataGrip ranks the columns of the tables a statement actually references
// above everything else, and offers tables after FROM/JOIN, types after `::`.
// These helpers work on a light token stream so string literals, comments and
// dollar-quoted bodies can never be mistaken for table references.

export interface SqlToken {
  kind: "word" | "quoted" | "punct";
  /** Identifier text without quotes for `quoted`; raw text otherwise. */
  text: string;
  start: number;
  end: number;
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Words, quoted identifiers and punctuation; strings and comments are skipped. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close === -1 ? sql.length : close + m[0].length;
        continue;
      }
    }
    if (c === '"' || c === "`") {
      const start = i;
      let text = "";
      i++;
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) { text += c; i += 2; continue; }
        if (sql[i] === c) { i++; break; }
        text += sql[i++];
      }
      tokens.push({ kind: "quoted", text, start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < sql.length && /[\w$]/.test(sql[i])) i++;
      tokens.push({ kind: "word", text: sql.slice(start, i), start, end: i });
      continue;
    }
    if (c === ":" && sql[i + 1] === ":") {
      tokens.push({ kind: "punct", text: "::", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ kind: "punct", text: c, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

export interface TableRef {
  /** Unquoted, dot-joined name as written (`app.users`, `Users`). */
  table: string;
  alias: string | null;
}

// Words that end a table reference rather than alias it.
const REF_STOP_WORDS = new Set([
  "on", "using", "where", "group", "order", "having", "limit", "offset", "join", "inner", "left",
  "right", "full", "cross", "natural", "outer", "lateral", "union", "intersect", "except", "set",
  "values", "returning", "window", "for", "select", "default", "as", "when", "then", "fetch",
  "tablesample", "with", "do", "partition", "straight_join", "ignore", "force", "use",
]);

const REF_INTRODUCERS = new Set(["from", "join", "update", "into", "table"]);

interface RefMatch {
  ref: TableRef;
  /** The name's parts (`schema`, `table`) as tokens. */
  nameTokens: SqlToken[];
  aliasToken: SqlToken | null;
  next: number;
}

/**
 * `fromItem`: the reference follows FROM/JOIN, where `name(` is a
 * set-returning function. After INTO/TABLE, `(` opens a column list.
 */
function readRef(tokens: SqlToken[], i: number, fromItem: boolean): RefMatch | null {
  let k = i;
  while (k < tokens.length && tokens[k].kind === "word" && ["only", "lateral"].includes(tokens[k].text.toLowerCase())) k++;
  const first = tokens[k];
  if (!first || first.kind === "punct") return null;
  if (first.kind === "word" && REF_STOP_WORDS.has(first.text.toLowerCase())) return null;
  const nameTokens = [first];
  k++;
  while (tokens[k]?.text === "." && tokens[k + 1] && tokens[k + 1].kind !== "punct") {
    nameTokens.push(tokens[k + 1]);
    k += 2;
  }
  // `FROM generate_series(1, 3) g` / `FROM reporting.report()`: a set-returning
  // function, not a table.
  if (fromItem && tokens[k]?.text === "(") return null;
  const parts = nameTokens.map((t) => t.text);
  let aliasToken: SqlToken | null = null;
  if (tokens[k]?.kind === "word" && tokens[k].text.toLowerCase() === "as") k++;
  const maybeAlias = tokens[k];
  if (
    maybeAlias &&
    (maybeAlias.kind === "quoted" ||
      (maybeAlias.kind === "word" && !REF_STOP_WORDS.has(maybeAlias.text.toLowerCase())))
  ) {
    aliasToken = maybeAlias;
    k++;
  }
  return { ref: { table: parts.join("."), alias: aliasToken?.text ?? null }, nameTokens, aliasToken, next: k };
}

function refsFromTokens(tokens: SqlToken[]): RefMatch[] {
  const refs: RefMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "word" || !REF_INTRODUCERS.has(t.text.toLowerCase())) continue;
    const lower = t.text.toLowerCase();
    const fromItem = lower === "from" || lower === "join";
    let parsed = readRef(tokens, i + 1, fromItem);
    while (parsed) {
      refs.push(parsed);
      i = parsed.next - 1;
      // Comma-separated FROM lists: `FROM a x, b y`.
      if (lower !== "from" || tokens[parsed.next]?.text !== ",") break;
      parsed = readRef(tokens, parsed.next + 1, true);
    }
  }
  return refs;
}

/**
 * Tables referenced by FROM / JOIN / UPDATE / INSERT INTO / comma lists
 * anywhere in `sql` — including after the caret, so `SELECT | FROM users u`
 * already knows about `users`. Subqueries contribute their own tables.
 */
export function extractTableRefs(sql: string): TableRef[] {
  return refsFromTokens(tokenizeSql(sql)).map((m) => m.ref);
}

export type SemanticKind = "table" | "schema" | "alias";

/**
 * Semantic highlighting spans: table and schema names where a statement
 * references them (FROM/JOIN/UPDATE/INTO and `table.column` qualifiers) and
 * every use of a table alias. Scoped per statement.
 */
export function classifySqlSpans(sql: string): Array<{ start: number; end: number; kind: SemanticKind }> {
  const tokens = tokenizeSql(sql);
  const spans: Array<{ start: number; end: number; kind: SemanticKind }> = [];
  const flush = (stmt: SqlToken[]) => {
    const refs = refsFromTokens(stmt);
    if (refs.length === 0) return;
    const marked = new Set<SqlToken>();
    const mark = (t: SqlToken, kind: SemanticKind) => {
      if (marked.has(t)) return;
      marked.add(t);
      spans.push({ start: t.start, end: t.end, kind });
    };
    const tableNames = new Set<string>();
    const aliases = new Set<string>();
    for (const r of refs) {
      r.nameTokens.forEach((t, i) => mark(t, i === r.nameTokens.length - 1 ? "table" : "schema"));
      tableNames.add(r.nameTokens[r.nameTokens.length - 1].text.toLowerCase());
      if (r.aliasToken) {
        mark(r.aliasToken, "alias");
        aliases.add(r.aliasToken.text.toLowerCase());
      }
    }
    for (let k = 0; k < stmt.length; k++) {
      const t = stmt[k];
      if (t.kind === "punct" || marked.has(t) || stmt[k - 1]?.text === ".") continue;
      const lower = t.text.toLowerCase();
      if (aliases.has(lower)) mark(t, "alias");
      else if (stmt[k + 1]?.text === "." && tableNames.has(lower)) mark(t, "table");
    }
  };
  let stmtStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === ";") {
      flush(tokens.slice(stmtStart, i));
      stmtStart = i + 1;
    }
  }
  flush(tokens.slice(stmtStart));
  return spans.sort((a, b) => a.start - b.start);
}

export type CompletionClause = "table" | "column" | "keyword" | "type" | "any";

const TABLE_CLAUSE = new Set(["from", "join", "update", "into", "table"]);
const COLUMN_CLAUSE = new Set([
  "select", "where", "on", "and", "or", "by", "having", "set", "returning", "when", "then", "else",
  "not", "distinct", "case", "between", "like", "ilike", "in",
]);

/**
 * What belongs at the caret, given the statement text before it (the word
 * being typed excluded): tables after FROM/JOIN, columns in SELECT/WHERE/ON,
 * keywords right after a complete table reference, types after `::`.
 */
export function detectCompletionClause(beforeCaret: string): CompletionClause {
  const tokens = tokenizeSql(beforeCaret);
  // Drop the partially typed word: it is what we are completing.
  if (tokens.length > 0 && tokens[tokens.length - 1].end === beforeCaret.length && tokens[tokens.length - 1].kind !== "punct") {
    tokens.pop();
  }
  const last = tokens[tokens.length - 1];
  if (!last) return "keyword";
  if (last.text === "::") return "type";

  const lower = (t: SqlToken | undefined) => (t ? t.text.toLowerCase() : "");
  const prev = tokens[tokens.length - 2];
  // `ALTER COLUMN x TYPE |`, `ADD COLUMN x |`
  if (lower(last) === "type" && tokens.slice(-4).some((t) => lower(t) === "column")) return "type";
  if (last.kind !== "punct" && lower(prev) === "column" && lower(tokens[tokens.length - 3]) === "add") return "type";

  const open = enclosingParen(tokens);
  if (open !== -1) {
    const before = tokens.slice(Math.max(0, open - 4), open).map(lower);
    // CAST(x AS |
    if (lower(last) === "as" && lower(tokens[open - 1]) === "cast") return "type";
    // CREATE TABLE t (id |, name |
    if (before.includes("table") && before.includes("create") && last.kind !== "punct" && (prev?.text === "(" || prev?.text === ",")) {
      return "type";
    }
    // INSERT INTO t ( | — the column list of the insert target.
    if (before.includes("into") && (last.text === "(" || last.text === ",")) return "column";
  }

  for (let k = tokens.length - 1; k >= 0; k--) {
    const tk = tokens[k];
    if (tk.kind !== "word") continue;
    const w = tk.text.toLowerCase();
    if (TABLE_CLAUSE.has(w)) {
      // `FROM |` / `FROM a, |` want a table; `FROM users u |` wants JOIN/WHERE.
      const after = tokens.slice(k + 1);
      if (after.length === 0 || after[after.length - 1].text === ",") return "table";
      return "keyword";
    }
    if (COLUMN_CLAUSE.has(w)) return "column";
    if (w === "values" || w === "limit" || w === "offset") return "any";
  }
  return "any";
}

/** Index of the innermost unclosed `(`, or -1. */
function enclosingParen(tokens: SqlToken[]): number {
  let depth = 0;
  for (let k = tokens.length - 1; k >= 0; k--) {
    if (tokens[k].text === ")") depth++;
    else if (tokens[k].text === "(") {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

/** Normalised lookup key matching `columns[].table_name` (public schema dropped). */
export function tableKey(name: string): string {
  const lower = name.toLowerCase();
  return lower.startsWith("public.") ? lower.slice("public.".length) : lower;
}

/**
 * Quote an identifier only when the engine requires it: PostgreSQL folds
 * unquoted names to lower case, so `createdAt` must be written `"createdAt"`;
 * MySQL needs backticks only for characters outside `[A-Za-z0-9_$]`.
 */
export function quoteIdentifierIfNeeded(name: string, dialect: "postgres" | "mysql" | "sqlite"): string {
  if (dialect === "mysql") {
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `\`${name.replace(/`/g, "``")}\``;
  }
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * The (possibly schema-qualified) name under a 0-based character offset in
 * `line`, as written (quotes kept), and whether it is called (`name(`).
 * Ctrl+click uses this to open the right definition: a set-returning
 * function in FROM is a function, not a table.
 */
export function qualifiedNameAt(line: string, offset: number): { name: string; isCall: boolean } | null {
  const tokens = tokenizeSql(line);
  let idx = tokens.findIndex((t) => t.kind !== "punct" && offset >= t.start && offset < t.end);
  if (idx === -1) return null;
  let first = idx;
  while (first >= 2 && tokens[first - 1].text === "." && tokens[first - 2].kind !== "punct") first -= 2;
  let last = idx;
  while (tokens[last + 1]?.text === "." && tokens[last + 2] && tokens[last + 2].kind !== "punct") last += 2;
  idx = last;
  return {
    name: line.slice(tokens[first].start, tokens[last].end),
    isCall: tokens[idx + 1]?.text === "(",
  };
}
