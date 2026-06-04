import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "../../../lib/cn";

export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

export interface FKMeta {
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface FKOption {
  pk: any;
  label: string;
}

type InputKind = "bool" | "date" | "datetime-local" | "time" | "number" | "text" | "textarea" | "fk";

function detectInputKind(type: string): InputKind {
  const t = type.toLowerCase().replace(/\(.*\)/, "").trim();
  if (t === "bool" || t === "boolean") return "bool";
  if (t === "date") return "date";
  if (t === "time" || t === "timetz" || t === "time without time zone" || t === "time with time zone") return "time";
  if (t.startsWith("timestamp") || t === "timestamptz" || t === "datetime") return "datetime-local";
  if (/^(int|smallint|bigint|tinyint|mediumint|numeric|decimal|float|double|real|serial|bigserial|money|smallmoney)/.test(t)) return "number";
  if (t === "json" || t === "jsonb") return "textarea";
  return "text";
}

function normalizeDateValue(val: any, kind: InputKind): string {
  if (val == null || val === "") return "";
  if (typeof val === "string") {
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return val;
      if (kind === "date") return d.toISOString().slice(0, 10);
      if (kind === "datetime-local") {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      if (kind === "time") {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      }
    } catch {}
    return val;
  }
  return String(val);
}

interface SchemaAwareFieldProps {
  column: ColumnMeta;
  fk?: FKMeta;
  value: any;
  onChange: (val: any) => void;
  error?: boolean;
  errorMessage?: string;
  disabled?: boolean;
  loadFKOptions?: (fk: FKMeta, search: string) => Promise<FKOption[]>;
}

function BoolField({ column, value, onChange, disabled }: {
  column: ColumnMeta;
  value: any;
  onChange: (val: any) => void;
  disabled?: boolean;
}) {
  const [triState, setTriState] = useState<boolean | null>(null);

  useEffect(() => {
    if (value === true || value === false) setTriState(value);
    else if (value === null || value === undefined || value === "") setTriState(null);
    else if (value === "true" || value === "1" || value === 1) setTriState(true);
    else if (value === "false" || value === "0" || value === 0) setTriState(false);
    else setTriState(null);
  }, [value]);

  const cycle = () => {
    if (!column.nullable) {
      const next = triState !== true;
      setTriState(next);
      onChange(next);
      return;
    }
    const next = triState === null ? true : triState === true ? false : null;
    setTriState(next);
    onChange(next);
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        role="checkbox"
        aria-checked={triState === true}
        disabled={disabled}
        onClick={cycle}
        className={cn(
          "w-5 h-5 rounded border-2 flex items-center justify-center transition-colors shrink-0",
          triState === true
            ? "bg-[var(--accent-9)] border-[var(--accent-9)] text-white"
            : triState === null && column.nullable
              ? "border-[var(--neutral-7)] bg-[var(--surface-base)] text-[var(--neutral-9)]"
              : "border-[var(--neutral-7)] bg-[var(--surface-base)]",
          disabled && "opacity-60 cursor-not-allowed",
          "cursor-pointer"
        )}
      >
        {triState === true && (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
        {triState === null && column.nullable && (
          <span className="text-[10px] font-bold leading-none">—</span>
        )}
      </button>
      <span className={cn(
        "text-xs font-mono",
        triState === null ? "text-[var(--neutral-9)]" : "text-[var(--neutral-12)]"
      )}>
        {triState === null ? column.nullable ? "NULL" : "false" : triState ? "true" : "false"}
      </span>
    </div>
  );
}

function FKField({ fk, value, onChange, error, loadFKOptions }: {
  fk: FKMeta;
  value: any;
  onChange: (val: any) => void;
  error?: boolean;
  loadFKOptions?: (fk: FKMeta, search: string) => Promise<FKOption[]>;
}) {
  const [options, setOptions] = useState<FKOption[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const reqCounterRef = useRef(0);

  useEffect(() => {
    if (value != null && value !== "") {
      const label = options.find(o => String(o.pk) === String(value))?.label;
      if (label) setSelectedLabel(label);
    }
  }, [value, options]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const loadOptions = useCallback(async (query: string) => {
    if (!loadFKOptions) return;
    const reqId = ++reqCounterRef.current;
    setLoading(true);
    try {
      const result = await loadFKOptions(fk, query);
      if (reqId !== reqCounterRef.current) return;
      setOptions(result);
    } catch {
      // loadFKOptions already swallows errors
    } finally {
      setLoading(false);
    }
  }, [loadFKOptions, fk]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    setOpen(true);
    if (val !== String(value ?? "")) {
      onChange(null);
      setSelectedLabel("");
    }
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => loadOptions(val), 250);
  };

  const handleFocus = () => {
    setOpen(true);
    if (options.length === 0) loadOptions("");
  };

  const handleSelect = (opt: FKOption) => {
    onChange(opt.pk);
    setSelectedLabel(opt.label);
    setSearch(opt.label);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={open ? search : selectedLabel || (value != null ? String(value) : "")}
        onChange={(e) => handleSearchChange(e.target.value)}
        onFocus={handleFocus}
        placeholder="Search…"
        className={cn(
          "w-full bg-[var(--surface-base)] border rounded-md px-3 py-2 text-sm font-mono",
          "text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] outline-none transition-colors",
          error
            ? "border-[var(--danger-9)] focus:border-[var(--danger-10)] focus:ring-1 focus:ring-[var(--danger-9)]/30"
            : "border-[var(--neutral-7)] focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30"
        )}
      />
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-md shadow-xl max-h-48 overflow-y-auto">
          {loading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-[var(--neutral-9)]">Loading…</div>
          )}
          {!loading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-[var(--neutral-9)]">No results</div>
          )}
          {options.map((opt, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleSelect(opt)}
              className={cn(
                "w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-[var(--accent-9)] hover:text-white transition-colors",
                String(opt.pk) === String(value) && "bg-[var(--accent-3)] text-[var(--accent-11)]"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SchemaAwareField({ column, fk, value, onChange, error, errorMessage, disabled, loadFKOptions }: SchemaAwareFieldProps) {
  const kind = fk ? "fk" : detectInputKind(column.type);
  const colName = column.name;

  const label = (
    <span className="flex items-center justify-between">
      <span>{colName}</span>
      <span className="flex items-center gap-2">
        {column.default != null && (
          <span className="text-[9px] font-normal text-[var(--neutral-9)]">default: {column.default}</span>
        )}
        {!column.nullable && (
          <span className="text-[9px] font-bold text-[var(--danger-9)]">*</span>
        )}
      </span>
    </span>
  );

  const errorText = error ? (errorMessage || "This field is required") : undefined;

  switch (kind) {
    case "bool":
      return (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-wider px-1">
            {label}
          </label>
          <BoolField column={column} value={value} onChange={onChange} disabled={disabled} />
          {errorText && <p className="text-[11px] text-[var(--danger-11)] px-1">{errorText}</p>}
        </div>
      );

    case "date":
    case "datetime-local":
    case "time":
      return (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-wider px-1">
            {label}
          </label>
          <input
            type={kind}
            value={normalizeDateValue(value, kind)}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={disabled}
            className={cn(
              "w-full bg-[var(--surface-base)] border rounded-md px-3 py-2 text-sm font-mono",
              "text-[var(--neutral-12)] outline-none transition-colors",
              error
                ? "border-[var(--danger-9)] focus:border-[var(--danger-10)] focus:ring-1 focus:ring-[var(--danger-9)]/30"
                : "border-[var(--neutral-7)] focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30",
              disabled && "opacity-60 cursor-not-allowed"
            )}
          />
          {errorText && <p className="text-[11px] text-[var(--danger-11)] px-1">{errorText}</p>}
        </div>
      );

    case "number":
      return (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-wider px-1">
            {label}
          </label>
          <input
            type="number"
            value={value ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v === "" ? null : Number(v));
            }}
            disabled={disabled}
            className="w-full bg-[var(--surface-base)] border border-[var(--neutral-7)] focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30 outline-none rounded-md px-3 py-2 text-sm font-mono text-[var(--neutral-12)] transition-colors disabled:opacity-60"
          />
          {errorText && <p className="text-[11px] text-[var(--danger-11)] px-1">{errorText}</p>}
        </div>
      );

    case "textarea":
      return (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-wider px-1">
            {label}
          </label>
          <textarea
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            rows={4}
            className={cn(
              "w-full bg-[var(--surface-base)] border rounded-md px-3 py-2 text-sm font-mono resize-y",
              "text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] outline-none transition-colors",
              error
                ? "border-[var(--danger-9)] focus:border-[var(--danger-10)] focus:ring-1 focus:ring-[var(--danger-9)]/30"
                : "border-[var(--neutral-7)] focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30",
              disabled && "opacity-60 cursor-not-allowed"
            )}
          />
          {errorText && <p className="text-[11px] text-[var(--danger-11)] px-1">{errorText}</p>}
        </div>
      );

    case "fk":
      return (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-wider px-1">
            <span className="flex items-center gap-1.5">
              {label}
              <span className="text-[9px] font-normal text-[var(--accent-9)]">
                → {fk!.refTable}
              </span>
            </span>
          </label>
          <FKField
            fk={fk!}
            value={value}
            onChange={onChange}
            error={error}
            loadFKOptions={loadFKOptions}
          />
          {errorText && <p className="text-[11px] text-[var(--danger-11)] px-1">{errorText}</p>}
        </div>
      );

    default:
      return (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-wider px-1">
            {label}
          </label>
          <input
            type="text"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className={cn(
              "w-full bg-[var(--surface-base)] border rounded-md px-3 py-2 text-sm font-mono",
              "text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] outline-none transition-colors",
              error
                ? "border-[var(--danger-9)] focus:border-[var(--danger-10)] focus:ring-1 focus:ring-[var(--danger-9)]/30"
                : "border-[var(--neutral-7)] focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30",
              disabled && "opacity-60 cursor-not-allowed"
            )}
          />
          {errorText && <p className="text-[11px] text-[var(--danger-11)] px-1">{errorText}</p>}
        </div>
      );
  }
}
