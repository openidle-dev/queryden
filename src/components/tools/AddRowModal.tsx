import { useState, useEffect } from "react";
import { X, Save, AlertCircle, Type } from "lucide-react";

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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[var(--surface)] w-full max-w-lg rounded-lg shadow-2xl border border-[var(--border)] flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--color-accent)]/10 rounded">
              <Save className="w-5 h-5 text-[var(--color-accent)]" />
            </div>
            <div>
              <h3 className="text-lg font-bold">Add New Row</h3>
              <p className="text-xs text-[var(--text-secondary)]">Table: <span className="text-[var(--text-primary)] font-mono">{tableName}</span></p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-[var(--border)] rounded-full transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded flex items-center gap-3 text-rose-400 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4">
            {columns.map(col => {
              const isId = col.toLowerCase() === "id" || col.toLowerCase().endsWith("_id");
              
              return (
                <div key={col} className="space-y-1.5 focus-within:z-10 relative">
                  <label className="text-[10px] uppercase font-bold text-[var(--text-secondary)] tracking-wider flex items-center justify-between px-1">
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
                    placeholder={isId ? "Leave empty for auto-increment" : `Enter ${col}...`}
                    className="w-full bg-[var(--background)] border border-[var(--border)] focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]/20 outline-none rounded-md px-3 py-2 text-sm font-mono transition-all placeholder:opacity-30"
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-6 border-t border-[var(--border)] bg-[var(--background)]/30 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium hover:bg-[var(--border)] rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-2 px-5 py-2 bg-[var(--color-accent)] text-white rounded-md text-sm font-bold shadow-lg shadow-[var(--color-accent)]/20 hover:bg-[var(--color-accent-hover)] active:scale-95 transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            {isSaving ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
            Save Record
          </button>
        </div>
      </div>
    </div>
  );
}
