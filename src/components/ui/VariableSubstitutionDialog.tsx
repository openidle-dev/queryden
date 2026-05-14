import { useState, useEffect, useRef } from "react";
import { X, Variable, Hash, Calendar, ToggleLeft, AlertCircle } from "lucide-react";

export interface QueryVariable {
  name: string;
  defaultValue?: string;
  isOptional: boolean;
  type: "text" | "number" | "date" | "boolean";
  position: number; // position in query for ordering
}

export interface VariableValues {
  [name: string]: string;
}

interface VariableSubstitutionDialogProps {
  /** The raw query text */
  query: string;
  /** Variables extracted from the query */
  variables: QueryVariable[];
  /** Cached values from previous executions (session-level) */
  cachedValues?: VariableValues;
  /** Called when user confirms with values */
  onConfirm: (values: VariableValues, remember: boolean) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

interface VariableMatch {
  start: number;
  end: number;
  name: string;
  defaultValue?: string;
  isOptional: boolean;
}

const VAR_RE = /^:([a-zA-Z_][a-zA-Z0-9_]*)(?::([^:?]+))?(\?)?/;
const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Scan SQL and locate every real `:name` variable reference.
 *
 * Skips contexts where a colon does NOT introduce a variable:
 *   - the `::` cast operator (e.g. `value::jsonb`)
 *   - single-quoted string literals (`'foo:bar'`)
 *   - double-quoted identifiers (`"foo:bar"`)
 *   - dollar-quoted bodies (`$$ ... :foo ... $$` and `$tag$ ... $tag$`)
 *   - `--` line comments and `/* ... *​/` block comments
 *
 * Both extractVariables and substituteVariables route through this so
 * they apply the exact same rules. See issue #19.
 */
function findVariableMatches(query: string): VariableMatch[] {
  const matches: VariableMatch[] = [];
  let i = 0;
  while (i < query.length) {
    const c = query[i];

    // Single-quoted string literal; `''` is the SQL escape for a literal `'`.
    if (c === "'") {
      i++;
      while (i < query.length) {
        if (query[i] === "'") {
          if (query[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted identifier; same `""` escape pattern as `''`.
    if (c === '"') {
      i++;
      while (i < query.length) {
        if (query[i] === '"') {
          if (query[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // `--` line comment runs to end of line.
    if (c === "-" && query[i + 1] === "-") {
      while (i < query.length && query[i] !== "\n") i++;
      continue;
    }

    // `/* ... */` block comment. Not handling Postgres-style nesting —
    // very rare in practice, and worst-case we under-skip rather than
    // over-skip, which only risks false positives we can fix later.
    if (c === "/" && query[i + 1] === "*") {
      i += 2;
      while (i < query.length) {
        if (query[i] === "*" && query[i + 1] === "/") { i += 2; break; }
        i++;
      }
      continue;
    }

    // Dollar-quoted block: `$tag$ ... $tag$` or `$$ ... $$`. The tag may
    // be empty or `[A-Za-z_][A-Za-z0-9_]*`. A lone `$1` is a positional
    // parameter — not a quote — and correctly fails this regex.
    if (c === "$") {
      const m = DOLLAR_TAG_RE.exec(query.slice(i));
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const closeIdx = query.indexOf(tag, bodyStart);
        i = closeIdx === -1 ? query.length : closeIdx + tag.length;
        continue;
      }
    }

    // `::` cast operator — skip both colons so neither is mistaken for
    // a variable introducer.
    if (c === ":" && query[i + 1] === ":") {
      i += 2;
      continue;
    }

    // Real variable: `:name`, `:name:default`, `:name?`, `:name:default?`.
    if (c === ":") {
      const m = VAR_RE.exec(query.slice(i));
      if (m) {
        matches.push({
          start: i,
          end: i + m[0].length,
          name: m[1],
          defaultValue: m[2],
          isOptional: !!m[3],
        });
        i += m[0].length;
        continue;
      }
    }

    i++;
  }
  return matches;
}

/** Parse :varName patterns from a SQL query string.
 *  Supports:
 *  - :varname — required text variable
 *  - :varname:default — text with default value
 *  - :varname? — optional (empty string if not provided)
 *  - :varname:default? — optional with default
 *  - :varname:NUMBER — typed as number
 *  - :varname:DATE — typed as date
 */
export function extractVariables(query: string): QueryVariable[] {
  const vars: QueryVariable[] = [];
  for (const m of findVariableMatches(query)) {
    let inferredType: QueryVariable["type"] = "text";
    if (m.defaultValue !== undefined) {
      if (/^\d+(\.\d+)?$/.test(m.defaultValue)) {
        inferredType = "number";
      } else if (/^\d{4}-\d{2}-\d{2}/.test(m.defaultValue)) {
        inferredType = "date";
      } else if (m.defaultValue === "true" || m.defaultValue === "false") {
        inferredType = "boolean";
      }
    }
    if (!vars.find(v => v.name === m.name)) {
      vars.push({
        name: m.name,
        defaultValue: m.defaultValue,
        isOptional: m.isOptional,
        type: inferredType,
        position: m.start,
      });
    }
  }
  return vars;
}

/** Substitute :varName patterns in a query with provided values.
 *  Handles string escaping for SQL safety. Respects the same context
 *  rules as extractVariables — a `:foo` inside a string literal or
 *  function body is left untouched.
 */
export function substituteVariables(
  query: string,
  values: VariableValues
): string {
  const matches = findVariableMatches(query);
  let result = "";
  let lastEnd = 0;
  for (const m of matches) {
    result += query.slice(lastEnd, m.start);
    const userValue = values[m.name];
    const effective =
      userValue !== undefined && userValue !== "" ? userValue : m.defaultValue;
    if (effective !== undefined) {
      const safe = String(effective).replace(/'/g, "''");
      result += `'${safe}'`;
    } else {
      result += "NULL";
    }
    lastEnd = m.end;
  }
  result += query.slice(lastEnd);
  return result;
}

export function VariableSubstitutionDialog({
  query,
  variables,
  cachedValues = {},
  onConfirm,
  onCancel,
}: VariableSubstitutionDialogProps) {
  const [values, setValues] = useState<VariableValues>(() => {
    const initial: VariableValues = {};
    for (const v of variables) {
      initial[v.name] = cachedValues[v.name] ?? v.defaultValue ?? "";
    }
    return initial;
  });
  const [remember, setRemember] = useState(false);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
    }
  };

  const typeIcon = (type: QueryVariable["type"]) => {
    switch (type) {
      case "number":
        return <Hash className="w-3 h-3 text-[var(--color-accent)]" />;
      case "date":
        return <Calendar className="w-3 h-3 text-[var(--color-accent)]" />;
      case "boolean":
        return <ToggleLeft className="w-3 h-3 text-[var(--color-accent)]" />;
      default:
        return <Variable className="w-3 h-3 text-[var(--color-accent)]" />;
    }
  };

  const inputType = (v: QueryVariable) => {
    if (v.type === "number") return "number";
    if (v.type === "date") return "date";
    return "text";
  };

  const placeholder = (v: QueryVariable) => {
    if (v.isOptional) return "Optional — leave empty to use NULL";
    return v.defaultValue ? `Default: ${v.defaultValue}` : "Enter value...";
  };

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-[var(--surface)] rounded-lg shadow-2xl w-full max-w-lg border border-[var(--color-accent)]">
        {/* Header */}
        <div className="p-4 border-b border-[var(--border)] flex items-center gap-3">
          <Variable className="w-5 h-5 text-[var(--color-accent)]" />
          <h2 className="text-sm font-semibold flex-1 text-[var(--text-primary)]">
            Query Variables
          </h2>
          <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
            {variables.length} variable{variables.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={onCancel}
            className="p-1 hover:bg-[var(--border)] rounded transition-colors text-[var(--text-secondary)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Variable list */}
        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-4">
          {variables.length === 0 ? (
            <div className="text-center py-8 text-[var(--text-secondary)] text-xs">
              No variables found in query.
            </div>
          ) : (
            variables.map((v) => (
              <div key={v.name} className="space-y-1">
                <div className="flex items-center gap-2">
                  {typeIcon(v.type)}
                  <label className="text-xs font-medium text-[var(--text-primary)]">
                    :{v.name}
                  </label>
                  {v.isOptional && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-warning)]/20 text-[var(--color-warning)]">
                      optional
                    </span>
                  )}
                  {v.defaultValue && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-info)]/20 text-[var(--color-info)]">
                      default: {v.defaultValue}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    ref={v === variables[0] ? firstInputRef : undefined}
                    type={inputType(v)}
                    value={values[v.name] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                    }
                    placeholder={placeholder(v)}
                    className="flex-1 bg-[var(--background)] border border-[var(--border)] rounded px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]"
                  />
                  {v.isOptional && values[v.name] === "" && (
                    <span className="flex items-center text-[10px] text-[var(--text-secondary)] italic px-2">
                      NULL
                    </span>
                  )}
                </div>
              </div>
            ))
          )}

          {/* Preview */}
          <div className="mt-4 pt-4 border-t border-[var(--border)]">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="w-3 h-3 text-[var(--color-info)]" />
              <span className="text-[10px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                Substitution Preview
              </span>
            </div>
            <pre
              className="text-[10px] text-[var(--text-secondary)] bg-[var(--background)] rounded p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed max-h-24 overflow-y-auto"
            >
              {substituteVariables(query, values)}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[var(--border)] flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Remember values for session
          </label>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-xs rounded hover:bg-[var(--surface-hover)] text-[var(--text-secondary)]"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(values, remember)}
              className="px-4 py-2 text-xs rounded bg-[var(--color-accent)] hover:opacity-80 text-white"
            >
              Execute
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
