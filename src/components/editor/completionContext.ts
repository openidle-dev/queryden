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

export interface AliasDotMatch {
  /** The identifier the user typed before the dot (alias or table name), original casing. */
  alias: string;
  /** The (possibly schema-qualified) table the alias resolves to. */
  tableName: string;
  /** Bare column names belonging to the resolved table, in their stored order. */
  columnNames: string[];
  /** 1-indexed Monaco column at which the replacement range should start. */
  rangeStartColumn: number;
}

// Words that the alias-extraction regex can accidentally capture as an "alias" but which are
// really the start of the next SQL clause. Lifted from the existing ON-context resolver in
// QueryEditor.tsx so the two stay in lockstep.
const ALIAS_RESERVED = new Set([
  "on", "where", "left", "right", "inner", "cross", "full", "natural",
  "join", "and", "or", "set", "select", "from", "group", "order", "having",
  "limit", "offset", "using", "as", "returning",
]);

const ALIAS_PATTERN =
  /(?:FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|FULL\s+JOIN|NATURAL\s+JOIN)\s+["']?(\w+(?:\.\w+)?)["']?(?:\s+(?:AS\s+)?(\w+))?/gi;

// Detect whether the cursor sits inside an `<alias>.<partial>` or `<table>.<partial>` autocomplete
// context. Resolves the prefix against aliases declared by FROM/JOIN clauses in `queryText`, with
// a fallback for when the prefix is the table name itself (no alias).
//
// `columns` is the flat column list from `globalSchemaItems.columns` where `table_name` is the
// schema-qualified table identifier (e.g. `"app.users"`) or a bare name for public-schema tables.
export function detectAliasDotContext(
  lineContent: string,
  cursorColumn: number,
  queryText: string,
  columns: readonly { table_name: string; column_name: string }[],
): AliasDotMatch | null {
  const base = findDotContext(lineContent, cursorColumn);
  if (!base) return null;

  const prefixLower = base.prefix.toLowerCase();

  // Step 1: try to resolve the prefix as an alias declared in FROM/JOIN.
  let resolvedTable: string | null = null;
  let m: RegExpExecArray | null;
  ALIAS_PATTERN.lastIndex = 0;
  while ((m = ALIAS_PATTERN.exec(queryText)) !== null) {
    const tableName = m[1];
    const aliasName = m[2];
    if (!aliasName) continue;
    const aliasLower = aliasName.toLowerCase();
    if (ALIAS_RESERVED.has(aliasLower)) continue;
    if (aliasLower === prefixLower) {
      resolvedTable = tableName;
      break;
    }
  }

  // Step 2: fall back to treating the prefix as a literal table name (no alias) — covers
  // `SELECT users.id FROM users` and `SELECT app.users.id FROM app.users`.
  if (!resolvedTable) {
    const directMatch = columns.find(c => {
      const tLower = c.table_name.toLowerCase();
      return tLower === prefixLower || tLower.endsWith("." + prefixLower);
    });
    if (directMatch) resolvedTable = directMatch.table_name;
  }

  if (!resolvedTable) return null;

  const tableLower = resolvedTable.toLowerCase();
  const columnNames = columns
    .filter(c => c.table_name.toLowerCase() === tableLower)
    .map(c => c.column_name);

  if (columnNames.length === 0) return null;

  return {
    alias: base.prefix,
    tableName: resolvedTable,
    columnNames,
    rangeStartColumn: base.rangeStartColumn,
  };
}

// Static (schema-free) suggestion matching for SQL keywords and builtin
// functions. Disconnected users still get these, so the predicate is shared
// between the no-schema fallback and the connected pre-filter in
// QueryEditor.tsx. Case-insensitive; empty input matches everything.
export function matchesStaticLabel(label: string, word: string): boolean {
  if (!word) return true;
  const labelLower = label.toLowerCase();
  const wordLower = word.toLowerCase();
  return labelLower.startsWith(wordLower) || labelLower.includes(wordLower);
}

// Issue #97: when a suggestion label is schema-qualified (e.g. `app.users`) and the user types a
// bare table name (e.g. `users`), a strict `label.startsWith(currentWord)` pre-filter rejects it
// before Monaco's matcher ever sees the suggestion. This predicate accepts both the qualified
// prefix (`app` → `app.users`) and the post-dot bare-name prefix (`users` → `app.users`) so
// schema-qualified entries survive the pre-filter. Case-insensitive on both sides.
export function matchesQualifiedOrBareName(
  label: string,
  currentWord: string,
): boolean {
  if (!currentWord) return true;
  const labelLower = label.toLowerCase();
  const wordLower = currentWord.toLowerCase();
  if (labelLower.startsWith(wordLower)) return true;
  const dotIdx = labelLower.indexOf(".");
  return dotIdx >= 0 && labelLower.substring(dotIdx + 1).startsWith(wordLower);
}

// Minimal structural contract the completion provider needs. `SchemaItems`
// (ConnectionContext) satisfies this; keeping it structural avoids importing
// the context (and its Tauri/IPC chain) into the unit-testable helper layer.
export interface CompletionSchemaLike {
  tables?: string[];
  views?: string[];
  functions?: string[];
  columns?: { table_name: string; column_name: string }[];
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
