import { useState, useEffect, useMemo } from "react";
import { Save, AlertCircle } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { SchemaAwareField, type ColumnMeta, type FKMeta, type FKOption } from "../ui/fields/SchemaAwareField";

interface AddRowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (row: any) => Promise<void>;
  columns: ColumnMeta[];
  foreignKeys?: FKMeta[];
  loadFKOptions?: (fk: FKMeta, search: string) => Promise<FKOption[]>;
  tableName: string;
}

export function AddRowModal({ isOpen, onClose, onSave, columns, foreignKeys, loadFKOptions, tableName }: AddRowModalProps) {
  const [row, setRow] = useState<Record<string, any>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<Set<string>>(new Set());

  const fkMap = useMemo(() => {
    const map = new Map<string, FKMeta>();
    if (foreignKeys) {
      for (const fk of foreignKeys) {
        for (const col of fk.columns) {
          map.set(col, fk);
        }
      }
    }
    return map;
  }, [foreignKeys]);

  useEffect(() => {
    if (isOpen) {
      const initialRow: Record<string, any> = {};
      for (const col of columns) {
        if (col.default != null && col.default !== "") {
          // For expressions like 'now()' or sequences, leave empty (let DB handle)
          if (col.default.includes("(") || col.default.includes("nextval")) {
            initialRow[col.name] = null;
          } else {
            initialRow[col.name] = col.default.replace(/^'|'$/g, "").replace(/::\w+/g, "").trim();
          }
        } else {
          initialRow[col.name] = "";
        }
      }
      setRow(initialRow);
      setError(null);
      setViolations(new Set());
    }
  }, [isOpen, columns]);

  const validate = (): Set<string> => {
    const v = new Set<string>();
    for (const col of columns) {
      if (!col.nullable && !col.default) {
        const val = row[col.name];
        if (val === null || val === undefined || val === "") {
          v.add(col.name);
        }
      }
    }
    return v;
  };

  const handleSave = async () => {
    const v = validate();
    setViolations(v);
    if (v.size > 0) return;

    setIsSaving(true);
    setError(null);
    try {
      const cleanedRow = { ...row };
      for (const key of Object.keys(cleanedRow)) {
        const col = columns.find(c => c.name === key);
        // Only coerce empty string → null for non-textual types (number, date, time)
        const nonTextPrefixes = ["int", "smallint", "bigint", "tinyint", "mediumint", "float", "double", "decimal", "numeric", "real", "money", "serial", "date", "time", "timestamp"];
        if (col && cleanedRow[key] === "" && nonTextPrefixes.some(p => col.type.toLowerCase().startsWith(p))) {
          cleanedRow[key] = null;
        }
      }

      await onSave(cleanedRow);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to add row");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRequestClose = () => {
    if (!isSaving) onClose();
  };

  const numViolations = violations.size;
  const hasViolations = numViolations > 0;

  return (
    <Dialog open={isOpen} onClose={handleRequestClose} size="lg" dismissOnBackdrop={!isSaving} dismissOnEsc={!isSaving}>
      <Dialog.Title onClose={handleRequestClose}>
        <span className="inline-flex items-center gap-3">
          <span className="p-1.5 bg-[var(--accent-3)] rounded">
            <Save className="w-4 h-4 text-[var(--accent-11)]" />
          </span>
          <span className="flex flex-col leading-tight">
            <span>Add new row</span>
            <span className="text-[10px] font-normal text-[var(--neutral-11)]">
              Table: <span className="text-[var(--neutral-12)] font-mono">{tableName}</span>
            </span>
          </span>
        </span>
      </Dialog.Title>

      <Dialog.Body className="space-y-4">
        {error && (
          <div className="p-3 bg-[var(--danger-3)] border border-[var(--danger-6)] rounded-md flex items-center gap-3 text-[var(--danger-11)] text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {hasViolations && (
          <div className="p-3 bg-[var(--danger-3)] border border-[var(--danger-6)] rounded-md flex items-center gap-3 text-[var(--danger-11)] text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {numViolations} required field{numViolations !== 1 ? "s" : ""} need{numViolations === 1 ? "s" : ""} a value
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 max-h-[60vh] overflow-y-auto pr-1">
          {columns.map(col => {
            const fk = fkMap.get(col.name);
            return (
              <SchemaAwareField
                key={col.name}
                column={col}
                fk={fk}
                value={row[col.name]}
                onChange={(val) => setRow(prev => ({ ...prev, [col.name]: val }))}
                error={violations.has(col.name)}
                loadFKOptions={loadFKOptions}
              />
            );
          })}
        </div>
      </Dialog.Body>

      <Dialog.Footer>
        <Button variant="ghost" size="sm" onClick={handleRequestClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          loading={isSaving}
          disabled={hasViolations && !isSaving}
          leftIcon={isSaving ? undefined : <Save className="w-3.5 h-3.5" />}
        >
          {hasViolations ? "Fix required fields" : "Save record"}
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}
