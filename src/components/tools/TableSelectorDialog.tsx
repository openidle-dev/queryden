import { useState, useMemo, useCallback } from "react";
import { Search, CheckSquare, Square, Table, AlertCircle } from "lucide-react";
import { cn } from "../../lib/cn";
import { Select } from "../ui/Select";
import {
  ALL_SCHEMAS_VALUE,
  decodeSchemaFilterValue,
  encodeSchemaFilterValue,
} from "../../utils/schemaFilterValue";

interface TableSelectorDialogProps {
  tables: string[];
  selected: string[];
  onConfirm: (selected: string[]) => void;
  onCancel: () => void;
}

function extractSchemas(tableNames: string[]): string[] {
  const schemas = new Set<string>();
  for (const t of tableNames) {
    const dot = t.indexOf(".");
    if (dot > 0) schemas.add(t.slice(0, dot));
  }
  return Array.from(schemas).sort();
}

export function TableSelectorDialog({
  tables,
  selected,
  onConfirm,
  onCancel,
}: TableSelectorDialogProps) {
  const [search, setSearch] = useState("");
  const [schemaFilter, setSchemaFilter] = useState<string | undefined>();
  const [selectedSet, setSelectedSet] = useState<Set<string>>(
    () => new Set(selected),
  );

  const schemas = useMemo(() => extractSchemas(tables), [tables]);

  const filteredTables = useMemo(() => {
    const lowerSearch = search.toLowerCase();
    return tables.filter((t) => {
      if (schemaFilter && !t.startsWith(`${schemaFilter}.`)) return false;
      if (
        search &&
        !t.toLowerCase().includes(lowerSearch)
      )
        return false;
      return true;
    });
  }, [tables, search, schemaFilter]);

  const allFilteredSelected = useMemo(
    () => filteredTables.every((t) => selectedSet.has(t)),
    [filteredTables, selectedSet],
  );

  const toggleTable = useCallback((table: string) => {
    setSelectedSet((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedSet((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const t of filteredTables) next.delete(t);
      } else {
        for (const t of filteredTables) next.add(t);
      }
      return next;
    });
  }, [filteredTables, allFilteredSelected]);

  const handleConfirm = useCallback(() => {
    if (selectedSet.size > 0) onConfirm(Array.from(selectedSet));
  }, [selectedSet, onConfirm]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--neutral-6)] bg-[var(--surface-elevated)] shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-[var(--accent-3)] rounded-lg">
            <Table className="w-4 h-4 text-[var(--accent-11)]" />
          </div>
          <h2 className="text-sm font-bold text-[var(--neutral-12)]">
            Select Tables
          </h2>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-[var(--neutral-6)] space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--neutral-9)]" />
            <input
              type="text"
              placeholder="Search tables..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-7 text-xs h-8 bg-[var(--surface-base)] border border-[var(--neutral-7)] rounded-md text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] outline-none focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30"
              autoFocus
            />
          </div>
          {schemas.length > 1 && (
            <Select
              selectSize="sm"
              className="w-36"
              value={encodeSchemaFilterValue(schemaFilter)}
              onValueChange={(v) => setSchemaFilter(decodeSchemaFilterValue(v))}
              options={[
                { label: "All Schemas", value: ALL_SCHEMAS_VALUE },
                ...schemas.map((s) => ({ label: s, value: encodeSchemaFilterValue(s) })),
              ]}
            />
          )}
        </div>

        <div className="flex items-center justify-between text-[11px] text-[var(--neutral-11)]">
          <button
            onClick={toggleAll}
            className="flex items-center gap-1.5 hover:text-[var(--neutral-12)] transition-colors"
          >
            {allFilteredSelected ? (
              <CheckSquare className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
            {allFilteredSelected ? "Deselect all" : "Select all"}
          </button>
          <span>
            {selectedSet.size} of {tables.length} table
            {tables.length !== 1 ? "s" : ""} selected
            {filteredTables.length < tables.length &&
              ` (${filteredTables.length} visible)`}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {filteredTables.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <AlertCircle className="w-6 h-6 text-[var(--neutral-9)] mx-auto mb-2" />
              <p className="text-xs text-[var(--neutral-11)]">
                {search || schemaFilter
                  ? "No tables match the current filters."
                  : "No tables found in this database."}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredTables.map((table) => {
              const isSelected = selectedSet.has(table);
              const { schema, tableName } = /^(.*?)\.(.*)$/.exec(table)?.groups
                ? {
                    schema: /^(.*?)\.(.*)$/.exec(table)![1],
                    tableName: /^(.*?)\.(.*)$/.exec(table)![2],
                  }
                : { schema: "", tableName: table };
              return (
                <label
                  key={table}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded-md cursor-pointer transition-colors",
                    isSelected
                      ? "bg-[var(--accent-3)] text-[var(--accent-11)]"
                      : "hover:bg-[var(--neutral-4)] text-[var(--neutral-12)]",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleTable(table)}
                    className="accent-[var(--accent-9)] w-3.5 h-3.5"
                  />
                  {schema && (
                    <span className="text-[10px] text-[var(--neutral-11)] font-mono">
                      {schema}.
                    </span>
                  )}
                  <span className="text-xs truncate min-w-0">{tableName}</span>
                  {isSelected && (
                    <span className="ml-auto text-[10px] text-[var(--accent-9)]">
                      selected
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--neutral-6)] bg-[var(--surface-elevated)] shrink-0">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-md border border-[var(--neutral-6)] text-[var(--neutral-11)] hover:bg-[var(--neutral-4)] hover:text-[var(--neutral-12)] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={selectedSet.size === 0}
          className="px-4 py-1.5 text-xs font-medium rounded-md bg-[var(--accent-9)] text-white hover:bg-[var(--accent-10)] disabled:bg-[var(--neutral-6)] disabled:text-[var(--neutral-11)] transition-colors"
        >
          Generate Diagram ({selectedSet.size})
        </button>
      </div>
    </div>
  );
}
