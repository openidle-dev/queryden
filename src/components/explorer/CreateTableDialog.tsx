import { useState } from "react";
import { X, Plus, Trash2, Check, AlertCircle, Loader2 } from "lucide-react";
import { CreateTablePayload } from "../../contexts/ConnectionContext";

interface CreateTableDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (payload: CreateTablePayload) => Promise<void>;
  dbType: string;
}

const getCommonTypes = (dbType: string) => {
  if (["postgres", "supabase", "cockroach"].includes(dbType)) {
    return ["SERIAL", "INTEGER", "BIGINT", "TEXT", "VARCHAR(255)", "BOOLEAN", "TIMESTAMP", "DATE", "JSONB", "UUID", "DECIMAL(10,2)", "BYTEA"];
  }
  if (["mysql", "mariadb"].includes(dbType)) {
    return ["INT AUTO_INCREMENT", "INT", "BIGINT", "TEXT", "VARCHAR(255)", "TINYINT(1)", "DATETIME", "DATE", "JSON", "DECIMAL(10,2)", "BLOB"];
  }
  return ["INTEGER PRIMARY KEY", "INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"];
};

export function CreateTableDialog({ isOpen, onClose, onCreate, dbType }: CreateTableDialogProps) {
  const commonTypes = getCommonTypes(dbType);
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState([
    { name: "id", type: commonTypes[0], nullable: false, primaryKey: true, defaultValue: "" },
    { name: "name", type: commonTypes[4] || "TEXT", nullable: false, primaryKey: false, defaultValue: "" }
  ]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const addColumn = () => {
    setColumns([...columns, { name: "", type: "TEXT", nullable: true, primaryKey: false, defaultValue: "" }]);
  };

  const removeColumn = (index: number) => {
    if (columns.length > 1) {
      setColumns(columns.filter((_, i) => i !== index));
    }
  };

  const handleColumnChange = (index: number, field: string, value: any) => {
    const newCols = [...columns];
    (newCols[index] as any)[field] = value;
    
    // If setting something as primary key, maybe unset others if it's single PK
    if (field === "primaryKey" && value === true) {
       // Optional: enforce single PK if needed for simplicity
    }
    
    setColumns(newCols);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tableName.trim()) {
      setError("Table name is required");
      return;
    }
    if (columns.some(c => !c.name.trim())) {
      setError("All columns must have a name");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: tableName,
        columns: columns
      });
      onClose();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] bg-[var(--surface-light)]">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Plus className="w-5 h-5 text-blue-400" /> Create New Table
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-[var(--border)] rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--text-secondary)]">Table Name</label>
            <input
              autoFocus
              type="text"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder="e.g. users, products"
              className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
            />
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-[var(--text-secondary)]">Columns</label>
              <button
                type="button"
                onClick={addColumn}
                className="flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add Column
              </button>
            </div>

            <div className="border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--input-bg)]">
              <table className="w-full text-left border-collapse">
                <thead className="bg-[var(--surface-light)] text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Name</th>
                    <th className="px-4 py-2 font-semibold">Type</th>
                    <th className="px-4 py-2 font-semibold text-center">PK</th>
                    <th className="px-4 py-2 font-semibold text-center">NULL</th>
                    <th className="px-4 py-2 font-semibold">Default</th>
                    <th className="px-4 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {columns.map((col, idx) => (
                    <tr key={idx} className="group hover:bg-[var(--border)]/30 transition-colors">
                      <td className="p-1 px-2">
                        <input
                          type="text"
                          value={col.name}
                          onChange={(e) => handleColumnChange(idx, "name", e.target.value)}
                          placeholder="column_name"
                          className="w-full bg-transparent border-none rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500/50 outline-none"
                        />
                      </td>
                      <td className="p-1 px-2">
                        <select
                          value={col.type}
                          onChange={(e) => handleColumnChange(idx, "type", e.target.value)}
                          className="w-full bg-transparent border-none rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-500/50 outline-none appearance-none cursor-pointer"
                        >
                          {commonTypes.map(t => <option key={t} value={t} className="bg-[var(--surface)]">{t}</option>)}
                        </select>
                      </td>
                      <td className="p-1 text-center">
                        <input
                          type="checkbox"
                          checked={col.primaryKey}
                          onChange={(e) => handleColumnChange(idx, "primaryKey", e.target.checked)}
                          className="w-4 h-4 rounded border-[var(--border)] bg-transparent text-blue-500 focus:ring-0 cursor-pointer"
                        />
                      </td>
                      <td className="p-1 text-center">
                        <input
                          type="checkbox"
                          checked={col.nullable}
                          onChange={(e) => handleColumnChange(idx, "nullable", e.target.checked)}
                          className="w-4 h-4 rounded border-[var(--border)] bg-transparent text-blue-500 focus:ring-0 cursor-pointer"
                        />
                      </td>
                      <td className="p-1 px-2">
                        <input
                          type="text"
                          value={col.defaultValue}
                          onChange={(e) => handleColumnChange(idx, "defaultValue", e.target.value)}
                          placeholder="NULL"
                          className="w-full bg-transparent border-none rounded px-2 py-1 text-[10px] focus:ring-1 focus:ring-blue-500/50 outline-none opacity-60 group-hover:opacity-100 transition-opacity"
                        />
                      </td>
                      <td className="p-1 text-center">
                        <button
                          type="button"
                          onClick={() => removeColumn(idx)}
                          className="p-1.5 text-red-500/50 hover:text-red-500 hover:bg-red-500/10 rounded transition-all"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg animate-in slide-in-from-top-2">
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium hover:bg-[var(--border)] rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={isSubmitting}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-semibold shadow-lg shadow-blue-500/20 transition-all active:scale-95"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Creating...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" /> Create Table
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
