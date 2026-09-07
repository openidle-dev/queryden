/**
 * Monaco signature help ("parameter hints") for SQL routines.
 *
 * DataGrip-style behaviour: typing `public.my_func(` or `my_func(1, ` pops a
 * hint showing `my_func(name type, …)` with the current argument highlighted
 * as you type commas. Trigger chars are `(` and `,` (plus Ctrl+Shift+Space).
 *
 * Argument lists come from the live catalog, cached per connection+database:
 *   - PostgreSQL / CockroachDB / Supabase: `pg_get_function_arguments(oid)`
 *     (overloads surface as multiple signatures),
 *   - MySQL / MariaDB: `information_schema.PARAMETERS`,
 *   - SQLite / others: no stored routines — no hints.
 *
 * The backward paren scan is quote-aware for `'...'` / `"..."` but
 * deliberately not dollar-quote-aware: signature help triggers on the edited
 * line while typing a call, where dollar bodies essentially never appear.
 */

export interface SignatureParameter {
  label: string;
  documentation?: string;
}

export interface FunctionSignature {
  /** e.g. `public.my_func(a integer, b text DEFAULT 'x')` */
  label: string;
  parameters: SignatureParameter[];
}

export interface CallTarget {
  /** Name parts without quotes, e.g. ["public", "my_func"] or ["my_func"]. */
  parts: string[];
  /** Offset of the enclosing `(` in the scanned text. */
  parenIndex: number;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
// Trailing qualified name at the end of the text before the call paren
// (the paren itself is excluded from the scanned slice).
const QUALIFIED_RE = new RegExp(`(${IDENT}(?:\\s*\\.\\s*${IDENT})*)\\s*$`);

// Clause keywords can never be a call target (`SELECT (`, `x IN (`) —
// without this, every parenthesized expression would fire a catalog query.
const NON_CALL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "ON", "USING",
  "AND", "OR", "NOT", "IN", "AS", "SET", "VALUES", "INTO", "UPDATE",
  "DELETE", "INSERT", "UNION", "EXCEPT", "INTERSECT", "WITH", "CASE",
  "WHEN", "THEN", "ELSE", "END", "CAST", "EXISTS", "BETWEEN", "LIKE",
  "ILIKE", "DISTINCT", "ALL", "ANY", "SOME", "RETURNING", "OVER",
  "PARTITION", "BY", "ASC", "DESC", "DO", "BEGIN",
]);

function isQuote(ch: string): boolean {
  return ch === "'" || ch === '"';
}

/**
 * Find the enclosing call `(` for a caret at the end of `text` (everything
 * before the caret), and the qualified function name in front of it.
 * Returns null outside a call (or when parens don't balance).
 */
export function parseCallTarget(text: string): CallTarget | null {
  let depth = 0;
  let quote: string | null = null;
  let i = text.length - 1;

  // Skip whitespace directly before the caret: `f(1,␣` still targets `f(`.
  while (i >= 0 && /\s/.test(text[i])) i--;

  for (; i >= 0; i--) {
    const c = text[i];
    if (quote) {
      // Inside a literal: a quote ends it unless escaped ('' / "" doubling;
      // backslash escapes are handled forward-only, good enough here).
      if (c === quote) {
        const prev = i > 0 ? text[i - 1] : "";
        const next = i + 1 < text.length ? text[i + 1] : "";
        if (prev === quote || next === quote) {
          // Doubled quote — skip both so we don't flip state twice.
          if (prev === quote) i--;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (isQuote(c)) {
      quote = c;
      continue;
    }
    if (c === ")") {
      depth++;
      continue;
    }
    if (c === "(") {
      if (depth === 0) break;
      depth--;
      continue;
    }
    // A top-level `;` ends the statement — nothing before it can own this call.
    if (c === ";" && depth === 0) return null;
  }
  if (i < 0) return null;

  const before = text.slice(0, i);
  const m = QUALIFIED_RE.exec(before);
  if (!m) return null;
  const parts = m[1]
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$/s, "$1"));
  if (parts.some((p) => p.length === 0)) return null;
  if (parts.length === 1 && NON_CALL_KEYWORDS.has(parts[0].toUpperCase())) return null;
  return { parts, parenIndex: i };
}

/**
 * Split an argument list on top-level commas. String literals, quoted
 * identifiers, dollar-quoted bodies and nested parens are skipped.
 */
export function splitTopLevelArgs(argsText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const tagRe = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

  const push = (end: number) => {
    parts.push(argsText.slice(start, end));
  };

  while (i < argsText.length) {
    const c = argsText[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < argsText.length) {
        if (argsText[i] === "\\" && i + 1 < argsText.length) {
          i += 2;
          continue;
        }
        if (argsText[i] === q) {
          if (argsText[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const m = tagRe.exec(argsText.slice(i));
      if (m) {
        const close = argsText.indexOf(m[0], i + m[0].length);
        i = close === -1 ? argsText.length : close + m[0].length;
        continue;
      }
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(argsText.length);
  return parts;
}

/**
 * Which 0-based argument the caret is typing: the number of top-level commas
 * between the enclosing `(` and the caret.
 */
export function countActiveParameter(argsSoFar: string): number {
  const parts = splitTopLevelArgs(argsSoFar);
  return Math.max(0, parts.length - 1);
}

export interface SignatureDb {
  select: (sql: string, params?: unknown[]) => Promise<never[] | Record<string, never>[] | unknown[]>;
}

interface CacheEntry {
  ts: number;
  signatures: FunctionSignature[];
}

const sigCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function clearSignatureHelpCache(): void {
  sigCache.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("connection-disconnected", clearSignatureHelpCache);
}

function cacheKey(connId: string, db: string, schema: string, name: string): string {
  return `${connId}|${db}|${schema}|${name}`.toLowerCase();
}

/**
 * Fetch overload signatures for `name` (optionally `schema`-qualified).
 * Returns [] when the engine has no routine catalog or nothing matches.
 */
export async function fetchFunctionSignatures(
  db: SignatureDb,
  dbType: string,
  opts: { connectionId: string; database: string; schema?: string; name: string },
): Promise<FunctionSignature[]> {
  const type = (dbType || "").toLowerCase();
  const key = cacheKey(opts.connectionId, opts.database, opts.schema || "", opts.name);
  const cached = sigCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.signatures;

  let signatures: FunctionSignature[] = [];
  try {
    if (["postgres", "supabase", "cockroach"].includes(type)) {
      const params: unknown[] = [opts.name];
      let sql =
        "SELECT n.nspname AS schema, p.proname AS name, " +
        "pg_get_function_arguments(p.oid) AS args " +
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE p.proname = $1 " +
        "AND n.nspname NOT IN ('pg_catalog', 'information_schema')";
      if (opts.schema) {
        sql += " AND n.nspname = $2";
        params.push(opts.schema);
      }
      sql += " ORDER BY (n.nspname = 'public') DESC, n.nspname, p.oid LIMIT 10";
      const rows = (await db.select(sql, params)) as Array<{ schema: string; name: string; args: string }>;
      signatures = rows.map((r) => {
        const qualified = r.schema === "public" && !opts.schema ? r.name : `${r.schema}.${r.name}`;
        const paramsList = splitTopLevelArgs(r.args || "").map((p) => p.trim()).filter(Boolean);
        return {
          label: `${qualified}(${r.args || ""})`,
          parameters: paramsList.map((p) => ({ label: p })),
        };
      });
    } else if (["mysql", "mariadb"].includes(type)) {
      if (!opts.schema && !opts.database) return [];
      const schema = opts.schema || opts.database;
      const rows = (await db.select(
        "SELECT PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DATA_TYPE AS dtype, ORDINAL_POSITION AS pos " +
          "FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? " +
          "ORDER BY ORDINAL_POSITION",
        [schema, opts.name],
      )) as Array<{ mode: string | null; name: string | null; dtype: string; pos: number }>;
      const paramsList = rows
        .filter((r) => r.pos !== 0 && r.name)
        .map((r) => `${r.mode && r.mode !== "IN" ? `${r.mode} ` : ""}${r.name} ${r.dtype}`);
      if (paramsList.length > 0 || rows.length > 0) {
        signatures = [
          {
            label: `${opts.name}(${paramsList.join(", ")})`,
            parameters: paramsList.map((p) => ({ label: p })),
          },
        ];
      }
    }
  } catch {
    return [];
  }

  sigCache.set(key, { ts: Date.now(), signatures });
  return signatures;
}

export interface SignatureConnCtx {
  db: SignatureDb | null;
  connectionId: string | null;
  dbType: string;
  database: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sigHelpDisposable: any = null;

/**
 * Register the global `sql` signature-help provider once (same pattern as
 * the completion/hover providers). `getConn` is read lazily per keystroke so
 * connection switches need no re-registration.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerSignatureHelp(monaco: any, getConn: () => SignatureConnCtx): void {
  if (sigHelpDisposable) return;
  sigHelpDisposable = monaco.languages.registerSignatureHelpProvider("sql", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provideSignatureHelp: async (model: any, position: any) => {
      try {
        const ctx = getConn();
        if (!ctx?.db || !ctx.connectionId) return null;
        const text = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const target = parseCallTarget(text);
        if (!target) return null;
        const parts = target.parts;
        const name = parts[parts.length - 1];
        const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
        const signatures = await fetchFunctionSignatures(ctx.db, ctx.dbType, {
          connectionId: ctx.connectionId,
          database: ctx.database,
          schema,
          name,
        });
        if (signatures.length === 0) return null;
        const activeParameter = countActiveParameter(text.slice(target.parenIndex + 1));
        return {
          value: {
            signatures: signatures.map((s) => ({
              label: s.label,
              parameters: s.parameters.map((p) => ({ label: p.label })),
            })),
            activeSignature: 0,
            activeParameter,
          },
          dispose() {},
        };
      } catch {
        return null;
      }
    },
  });
}
