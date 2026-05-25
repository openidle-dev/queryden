import { useState, useEffect } from "react";
import { Save, AlertCircle, Type } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";

interface AddRowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (row: any) => Promise<void>;
  columns: string[];
  tableName: string;
}

export function AddRowModal({ isOpen, onClose, onSave, columns, tableName }: AddRowModalProps) {
  const [row, setRow] = useState<Record<string, any>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      const initialRow = columns.reduce((acc, col) => ({ ...acc, [col]: "" }), {});
      setRow(initialRow);
      setError(null);
    }
  }, [isOpen, columns]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const cleanedRow = { ...row };
      Object.keys(cleanedRow).forEach(key => {
        if (cleanedRow[key] === "") cleanedRow[key] = null;
      });

      await onSave(cleanedRow);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to add row");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} size="lg">
      <Dialog.Title onClose={onClose}>
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

        <div className="grid grid-cols-1 gap-4">
          {columns.map(col => {
            const isId = col.toLowerCase() === "id" || col.toLowerCase().endsWith("_id");

            return (
              <div key={col} className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-wider flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5">
                    <Type className="w-3 h-3 opacity-50" />
                    {col}
                  </span>
                  {isId && <span className="text-[8px] font-normal opacity-50 italic">Auto-gen?</span>}
                </label>
                <input
                  type="text"
                  value={row[col] ?? ""}
                  onChange={(e) => setRow(prev => ({ ...prev, [col]: e.target.value }))}
                  placeholder={isId ? "Leave empty for auto-increment" : `Enter ${col}…`}
                  className="w-full bg-[var(--surface-base)] border border-[var(--neutral-7)] focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30 outline-none rounded-md px-3 py-2 text-sm font-mono text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] transition-colors"
                />
              </div>
            );
          })}
        </div>
      </Dialog.Body>

      <Dialog.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          loading={isSaving}
          leftIcon={isSaving ? undefined : <Save className="w-3.5 h-3.5" />}
        >
          Save record
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}
