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
  // Match :varname with optional :default and optional ?
  const regex = /:([a-zA-Z_][a-zA-Z0-9_]*)(?::([^:?]+))?(\?)?/g;
  let match;

  while ((match = regex.exec(query)) !== null) {
    const fullName = match[1];
    const defaultVal = match[2];
    const isOptional = !!match[3];

    // Determine type from default value
    let inferredType: QueryVariable["type"] = "text";
    if (defaultVal !== undefined) {
      if (/^\d+(\.\d+)?$/.test(defaultVal)) {
        inferredType = "number";
      } else if (/^\d{4}-\d{2}-\d{2}/.test(defaultVal)) {
        inferredType = "date";
      } else if (defaultVal === "true" || defaultVal === "false") {
        inferredType = "boolean";
      }
    }

    // Avoid duplicates — take first occurrence only
    if (!vars.find(v => v.name === fullName)) {
      vars.push({
        name: fullName,
        defaultValue: defaultVal,
        isOptional,
        type: inferredType,
        position: match.index,
      });
    }
  }

  return vars;
}

/** Substitute :varName patterns in a query with provided values.
 *  Handles string escaping for SQL safety.
 */
export function substituteVariables(
  query: string,
  values: VariableValues
): string {
  let result = query;
  for (const [name, value] of Object.entries(values)) {
    // Escape single quotes in string values for SQL safety
    const safeValue = String(value).replace(/'/g, "''");
    result = result.replace(new RegExp(`:${name}(?::[^:?]+)?(\\?)?`, "g"), `'${safeValue}'`);
  }
  // Remove any remaining unsubstituted optional variables (replace with NULL or empty)
  result = result.replace(/:'([^']*)'(?::([^'?]+))?(\?)?/g, (_, name, _def, opt) => {
    return opt ? "NULL" : `'${name}'`;
  });
  // Clean up any literal remaining variable references that weren't substituted
  result = result.replace(/ :[a-zA-Z_][a-zA-Z0-9_]*(?::[^:?]+)?(\?)?/g, " NULL");
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
