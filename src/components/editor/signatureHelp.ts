/**
 * Monaco signature help ("parameter hints") for SQL routines.
 *
 * DataGrip-style behaviour: typing `public.my_func(` or `my_func(1, ` pops a
 * hint showing `my_func(name type, …)` with the current argument highlighted
 * as you type commas. Trigger chars are `(` and `,` (plus Ctrl+Shift+Space).
 *
 * Argument lists come from the live catalog, cached per connection+database:
 *   - PostgreSQL / CockroachDB / Supabase: `pg_proc` — user functions AND
 *     builtins visible on the search_path, with return type and the
 *     function's comment (overloads surface as multiple signatures),
 *   - MySQL / MariaDB: `information_schema.PARAMETERS` for stored routines,
 *   - everything else, and any engine while disconnected: the static
 *     builtin catalog in `sqlBuiltins.ts`.
 *
 * The backward paren scan is quote-aware for `'...'` / `"..."` but
 * deliberately not dollar-quote-aware: signature help triggers on the edited
 * line while typing a call, where dollar bodies essentially never appear.
 */

import { builtinLabel, dialectForDbType, findBuiltin } from "./sqlBuiltins";

export interface SignatureParameter {
  label: string;
  documentation?: string;
}

export interface FunctionSignature {
  /** e.g. `public.my_func(a integer, b text DEFAULT 'x') → integer` */
  label: string;
  parameters: SignatureParameter[];
  documentation?: string;
  /** From the static builtin catalog rather than the server. */
  builtin?: boolean;
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
 * Split a qualified name on dots outside double-quoted identifiers, so
 * `"my.schema"."my.func"` stays two parts instead of four. Raw parts keep
 * their quotes; unquoting/folding happens in the caller.
 */
function splitQualifiedRaw(name: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let k = 0; k < name.length; k++) {
    const c = name[k];
    if (c === '"') {
      if (inQuotes && name[k + 1] === '"') {
        cur += '""';
        k++;
        continue;
      }
      inQuotes = !inQuotes;
      cur += c;
      continue;
    }
    if (c === "." && !inQuotes) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
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
  // Quote-aware dot split + case folding: PostgreSQL folds unquoted
  // identifiers to lower case (pg_proc.proname holds the folded name), so
  // `MY_FUNC(` / `Public.My_Func(` must look up `my_func`. Quoted parts
  // keep their exact case (`"My Func"` stays `My Func`).
  const parts = splitQualifiedRaw(m[1]).map((raw) => {
    const t = raw.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      return t.slice(1, -1).replace(/""/g, '"');
    }
    return t.toLowerCase();
  });
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
      // Unqualified names resolve like the server would: anything visible on
      // the search_path (pg_catalog builtins included), plus user functions
      // in other schemas so hints still work before a `SET search_path`.
      const params: unknown[] = [opts.name];
      let sql =
        "SELECT n.nspname AS schema, p.proname AS name, " +
        "pg_get_function_arguments(p.oid) AS args, " +
        "pg_get_function_result(p.oid) AS result, " +
        "obj_description(p.oid, 'pg_proc') AS doc " +
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE p.proname = $1 ";
      if (opts.schema) {
        sql += "AND n.nspname = $2 ";
        params.push(opts.schema);
      } else {
        sql +=
          "AND (pg_function_is_visible(p.oid) " +
          "OR n.nspname NOT IN ('pg_catalog', 'information_schema')) ";
      }
      sql += "ORDER BY pg_function_is_visible(p.oid) DESC, p.pronargs, p.oid LIMIT 20";
      const rows = (await db.select(sql, params)) as Array<{
        schema: string;
        name: string;
        args: string | null;
        result: string | null;
        doc: string | null;
      }>;
      signatures = rows.map((r) => {
        const showSchema = !!opts.schema || !["public", "pg_catalog"].includes(r.schema);
        const qualified = showSchema ? `${r.schema}.${r.name}` : r.name;
        const paramsList = splitTopLevelArgs(r.args || "").map((p) => p.trim()).filter(Boolean);
        return {
          label: `${qualified}(${r.args || ""})${r.result ? ` → ${r.result}` : ""}`,
          parameters: paramsList.map((p) => ({ label: p })),
          documentation: r.doc || undefined,
        };
      });
    } else if (["mysql", "mariadb"].includes(type) && (opts.schema || opts.database)) {
      const schema = opts.schema || opts.database;
      const rows = (await db.select(
        "SELECT PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DATA_TYPE AS dtype, ORDINAL_POSITION AS pos " +
          "FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? " +
          "ORDER BY ORDINAL_POSITION",
        [schema, opts.name],
      )) as Array<{ mode: string | null; name: string | null; dtype: string; pos: number }>;
      // Position 0 is a stored function's RETURNS clause.
      const returns = rows.find((r) => r.pos === 0)?.dtype;
      const paramsList = rows
        .filter((r) => r.pos !== 0 && r.name)
        .map((r) => `${r.mode && r.mode !== "IN" ? `${r.mode} ` : ""}${r.name} ${r.dtype}`);
      if (rows.length > 0) {
        signatures = [
          {
            label: `${opts.name}(${paramsList.join(", ")})${returns ? ` → ${returns}` : ""}`,
            parameters: paramsList.map((p) => ({ label: p })),
          },
        ];
      }
    }
  } catch {
    // Catalog unavailable (permissions, CockroachDB gaps): builtins still help.
    return builtinSignatures(type, opts.name);
  }

  if (signatures.length === 0 && !opts.schema) signatures = builtinSignatures(type, opts.name);
  sigCache.set(key, { ts: Date.now(), signatures });
  return signatures;
}

/** Signatures from the static builtin catalog for an engine id. */
export function builtinSignatures(dbType: string, name: string): FunctionSignature[] {
  return findBuiltin(dialectForDbType(dbType), name).map((f) => ({
    label: builtinLabel(f),
    parameters: f.params.map((p) => ({ label: p })),
    documentation: f.doc,
    builtin: true,
  }));
}

/**
 * Overload to highlight: the first one that has a slot for the argument
 * being typed (variadic ones always do). Falls back to the first overload.
 */
export function pickActiveSignature(signatures: FunctionSignature[], activeParameter: number): number {
  const idx = signatures.findIndex((s) => {
    const last = s.parameters[s.parameters.length - 1]?.label ?? "";
    const variadic = last === "..." || /^VARIADIC\b/i.test(last);
    return variadic || s.parameters.length > activeParameter;
  });
  return idx === -1 ? 0 : idx;
}

/**
 * Monaco parameter labels as [start, end) offsets into the signature label.
 * Plain string labels are located with `indexOf`, which highlights the
 * wrong slot when types repeat (`substr(text, integer, integer)`).
 */
export function parameterOffsets(sig: FunctionSignature): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  let from = sig.label.indexOf("(") + 1;
  for (const p of sig.parameters) {
    const start = sig.label.indexOf(p.label, from);
    if (start === -1) {
      offsets.push([0, 0]);
      continue;
    }
    offsets.push([start, start + p.label.length]);
    from = start + p.label.length;
  }
  return offsets;
}

export interface SignatureConnCtx {
  db: SignatureDb | null;
  connectionId: string | null;
  dbType: string;
  database: string;
}

// Bounded prefix for signature help: copying the whole document on every
// `(` / `,` keystroke makes the provider O(document) per trigger. Calls
// are almost always short, and parseCallTarget stops at the nearest
// unmatched `(` — earlier statements can never affect a reachable call —
// so only the current statement's prefix is needed.
const MAX_SIG_PREFIX_CHARS = 8000;

const SIG_DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Index just after the last top-level `;` in `text` (lexer-aware). */
function afterLastTopLevelSemicolon(text: string): number {
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "\\" && i + 1 < text.length) { i += 2; continue; }
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length) {
        if (text[i] === "*" && text[i + 1] === "/") { i += 2; break; }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const m = SIG_DOLLAR_TAG_RE.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? text.length : close + tag.length;
        continue;
      }
    }
    if (c === ";") last = i + 1;
    i++;
  }
  return last;
}

/**
 * Fetch only the current statement's prefix before the caret (bounded).
 * Uses offset-based ranging so cost is O(statement), not O(document).
 * Falls back to the full prefix when the model lacks offset APIs (tests).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSignaturePrefix(model: any, position: any): string {
  try {
    if (typeof model.getOffsetAt !== "function" || typeof model.getPositionAt !== "function") {
      return model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
    }
    const endOffset: number = model.getOffsetAt(position);
    const startOffset = Math.max(0, endOffset - MAX_SIG_PREFIX_CHARS);
    const startPos = model.getPositionAt(startOffset);
    const window: string = model.getValueInRange({
      startLineNumber: startPos.lineNumber,
      startColumn: startPos.column,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    return window.slice(afterLastTopLevelSemicolon(window));
  } catch {
    return "";
  }
}

/**
 * Signatures for a parsed call target (`["schema", "fn"]` or `["fn"]`):
 * the live catalog when connected, the builtin catalog otherwise.
 */
export async function lookupSignatures(ctx: SignatureConnCtx | null, parts: string[]): Promise<FunctionSignature[]> {
  const name = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
  if (!ctx?.db || !ctx.connectionId) {
    return schema ? [] : builtinSignatures(ctx?.dbType ?? "", name);
  }
  return fetchFunctionSignatures(ctx.db, ctx.dbType, {
    connectionId: ctx.connectionId,
    database: ctx.database,
    schema,
    name,
  });
}

// ─── Inline parameter-name hints ─────────────────────────────────────────────

export interface CallSite {
  /** Name parts as written, unquoted and folded like `parseCallTarget`. */
  parts: string[];
  /** Each top-level argument's start offset and trimmed text. */
  args: Array<{ offset: number; text: string }>;
}

// `(` after these words is not a call: column lists, value lists, subqueries.
const NOT_A_CALL_AFTER = new Set(["INTO", "TABLE", "REFERENCES", "USING", "VALUES", "IN", "KEY", "INDEX", "EXISTS", "ON", "AS", "OVER", "FILTER", "WITHIN"]);
const MULTIWORD_TYPES = /^(double precision|character varying|bit varying|timestamp with(out)? time zone|time with(out)? time zone)(\s|\(|$)/i;

/** Every function call in `text` with its argument positions. */
export function findCallSites(text: string): CallSite[] {
  const sites: CallSite[] = [];
  const re = /((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*)\s*\(/g;
  const code = maskLiteralsAndComments(text);
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const nameText = text.slice(m.index, m.index + m[1].length);
    const parts = splitQualifiedRaw(nameText).map((raw) => {
      const t = raw.trim();
      return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
    });
    const last = parts[parts.length - 1].toUpperCase();
    if (parts.length === 1 && NON_CALL_KEYWORDS.has(last)) continue;
    const prevWord = /([A-Za-z_]+)\s*$/.exec(code.slice(0, m.index))?.[1]?.toUpperCase();
    if (prevWord && NOT_A_CALL_AFTER.has(prevWord)) continue;

    // Walk the argument list on the masked text (strings/comments blanked).
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let argStart = open + 1;
    const args: CallSite["args"] = [];
    let close = -1;
    for (let i = open; i < code.length; i++) {
      const c = code[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      } else if (c === "," && depth === 1) {
        args.push({ offset: argStart, text: text.slice(argStart, i) });
        argStart = i + 1;
      } else if (c === ";" && depth >= 1) break;
    }
    if (close === -1) continue;
    if (text.slice(argStart, close).trim() || args.length > 0) args.push({ offset: argStart, text: text.slice(argStart, close) });
    sites.push({
      parts,
      args: args.map((a) => {
        const lead = a.text.length - a.text.trimStart().length;
        return { offset: a.offset + lead, text: a.text.trim() };
      }),
    });
  }
  return sites;
}

/** Blank string literals, quoted-identifier-free comments and dollar bodies, same length. */
function maskLiteralsAndComments(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const start = i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") { i++; break; }
        i++;
      }
      blank(start + 1, i - 1);
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const start = i;
      while (i < text.length && text[i] !== "\n") i++;
      blank(start, i);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const start = i;
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      blank(start, i);
      continue;
    }
    if (c === "$") {
      const m = SIG_DOLLAR_TAG_RE.exec(text.slice(i));
      if (m) {
        const start = i;
        const close = text.indexOf(m[0], i + m[0].length);
        i = close === -1 ? text.length : close + m[0].length;
        blank(start, i);
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/**
 * The parameter name in a catalog argument like `p_name text`,
 * `INOUT total numeric DEFAULT 0` or `"Weird Name" int`; null when the
 * argument is unnamed (`integer`, `double precision`).
 */
export function parameterName(label: string): string | null {
  const rest = label.trim().replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, "").replace(/\s+DEFAULT\s[\s\S]*$/i, "");
  if (MULTIWORD_TYPES.test(rest)) return null;
  const m = /^("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s+\S/.exec(rest);
  return m ? m[1] : null;
}

/** Plain column references (`name`, `u.name`) need no label — they say what they are. */
function isPlainReference(arg: string): boolean {
  return /^((?:"[^"]+"|[A-Za-z_][\w$]*)\.)*(?:"[^"]+"|[A-Za-z_][\w$]*)$/.test(arg) && !/^(null|true|false)$/i.test(arg);
}

export interface ParameterHint {
  offset: number;
  label: string;
}

/**
 * Inline `name:` labels for calls to routines with named parameters (the
 * server catalog only — builtins have positional parameters). Shown for
 * literals and expressions, skipped for plain column references and for
 * single-argument calls, like IntelliJ/DataGrip.
 */
export async function parameterHints(
  text: string,
  resolve: (parts: string[]) => Promise<FunctionSignature[]>,
  maxCalls = 60,
): Promise<ParameterHint[]> {
  const hints: ParameterHint[] = [];
  for (const site of findCallSites(text).slice(0, maxCalls)) {
    if (site.args.length < 2) continue;
    const sigs = (await resolve(site.parts)).filter((s) => !s.builtin);
    const sig =
      sigs.find((s) => s.parameters.length === site.args.length) ??
      sigs.find((s) => s.parameters.length > site.args.length);
    if (!sig) continue;
    site.args.forEach((arg, i) => {
      const name = parameterName(sig.parameters[i]?.label ?? "");
      if (!name || !arg.text || isPlainReference(arg.text)) return;
      hints.push({ offset: arg.offset, label: `${name.replace(/^"|"$/g, "")}:` });
    });
  }
  return hints;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let inlayDisposable: any = null;

/** Register the inline parameter-name hint provider once (see `parameterHints`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerParameterInlayHints(monaco: any, getConn: (model: any) => SignatureConnCtx): void {
  if (inlayDisposable) return;
  inlayDisposable = monaco.languages.registerInlayHintsProvider("sql", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provideInlayHints: async (model: any, range: any) => {
      try {
        const ctx = getConn(model);
        if (!ctx?.db || !ctx.connectionId) return { hints: [], dispose() {} };
        const text: string = model.getValue();
        if (text.length > 200_000) return { hints: [], dispose() {} };
        const startOffset = model.getOffsetAt({ lineNumber: range.startLineNumber, column: 1 });
        const endOffset = model.getOffsetAt({ lineNumber: range.endLineNumber, column: model.getLineMaxColumn(range.endLineNumber) });
        const hints = await parameterHints(text, (parts) => lookupSignatures(ctx, parts));
        return {
          hints: hints
            .filter((h) => h.offset >= startOffset && h.offset <= endOffset)
            .map((h) => ({
              position: model.getPositionAt(h.offset),
              label: h.label,
              kind: monaco.languages.InlayHintKind.Parameter,
              paddingRight: true,
            })),
          dispose() {},
        };
      } catch {
        return { hints: [], dispose() {} };
      }
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sigHelpDisposable: any = null;

// Dev hot reload: drop this module's providers so the replacement registers
// fresh ones instead of stacking a second set.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    inlayDisposable?.dispose();
    sigHelpDisposable?.dispose();
  });
}

/**
 * Register the global `sql` signature-help provider once (same pattern as
 * the completion/hover providers). `getConn(model)` is read per keystroke,
 * so each editor resolves its own tab's connection and switches need no
 * re-registration.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerSignatureHelp(monaco: any, getConn: (model: any) => SignatureConnCtx): void {
  if (sigHelpDisposable) return;
  sigHelpDisposable = monaco.languages.registerSignatureHelpProvider("sql", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provideSignatureHelp: async (model: any, position: any) => {
      try {
        const ctx = getConn(model);
        const text = getSignaturePrefix(model, position);
        const target = parseCallTarget(text);
        if (!target) return null;
        const signatures = await lookupSignatures(ctx, target.parts);
        if (signatures.length === 0) return null;
        const activeParameter = countActiveParameter(text.slice(target.parenIndex + 1));
        return {
          value: {
            signatures: signatures.map((s) => {
              const offsets = parameterOffsets(s);
              return {
                label: s.label,
                documentation: s.documentation,
                parameters: s.parameters.map((_, i) => ({ label: offsets[i] })),
              };
            }),
            activeSignature: pickActiveSignature(signatures, activeParameter),
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
