import { useState } from "react";
import { Plus, Trash2, AlertCircle } from "lucide-react";
import { CreateTablePayload } from "../../contexts/ConnectionContext";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

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
    <Dialog open={isOpen} onClose={onClose} size="xl">
      <Dialog.Title onClose={onClose}>
        <span className="inline-flex items-center gap-2">
          <Plus className="w-4 h-4 text-[var(--accent-9)]" />
          <span>Create New Table</span>
        </span>
      </Dialog.Title>

      <form onSubmit={handleSubmit} className="contents">
        <Dialog.Body className="space-y-4">
          <Input
            label="Table name"
            autoFocus
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            placeholder="e.g. users, products"
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[var(--neutral-12)]">Columns</label>
              <Button
                type="button"
                onClick={addColumn}
                variant="ghost"
                size="xs"
                leftIcon={<Plus className="w-3 h-3" />}
                className="text-[var(--accent-11)]"
              >
                Add column
              </Button>
            </div>

            <div className="border border-[var(--neutral-6)] rounded-md overflow-hidden bg-[var(--surface-base)]">
              <table className="w-full text-left border-collapse">
                <thead className="bg-[var(--neutral-3)] text-[10px] uppercase tracking-wider text-[var(--neutral-11)]">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Name</th>
                    <th className="px-3 py-2 font-semibold">Type</th>
                    <th className="px-3 py-2 font-semibold text-center">PK</th>
                    <th className="px-3 py-2 font-semibold text-center">NULL</th>
                    <th className="px-3 py-2 font-semibold">Default</th>
                    <th className="px-3 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--neutral-6)]">
                  {columns.map((col, idx) => (
                    <tr key={idx} className="group hover:bg-[var(--neutral-3)] transition-colors">
                      <td className="p-1 px-2">
                        <input
                          type="text"
                          value={col.name}
                          onChange={(e) => handleColumnChange(idx, "name", e.target.value)}
                          placeholder="column_name"
                          className="w-full bg-transparent border-none rounded px-2 py-1 text-xs text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] focus:ring-1 focus:ring-[var(--accent-8)]/40 outline-none"
                        />
                      </td>
                      <td className="p-1 px-2">
                        <select
                          value={col.type}
                          onChange={(e) => handleColumnChange(idx, "type", e.target.value)}
                          className="w-full bg-transparent border-none rounded px-2 py-1 text-xs text-[var(--neutral-12)] focus:ring-1 focus:ring-[var(--accent-8)]/40 outline-none appearance-none cursor-pointer"
                        >
                          {commonTypes.map(t => <option key={t} value={t} className="bg-[var(--surface-elevated)]">{t}</option>)}
                        </select>
                      </td>
                      <td className="p-1 text-center">
                        <input
                          type="checkbox"
                          checked={col.primaryKey}
                          onChange={(e) => handleColumnChange(idx, "primaryKey", e.target.checked)}
                          className="w-3.5 h-3.5 rounded border-[var(--neutral-6)] bg-transparent text-[var(--accent-9)] focus:ring-0 cursor-pointer"
                        />
                      </td>
                      <td className="p-1 text-center">
                        <input
                          type="checkbox"
                          checked={col.nullable}
                          onChange={(e) => handleColumnChange(idx, "nullable", e.target.checked)}
                          className="w-3.5 h-3.5 rounded border-[var(--neutral-6)] bg-transparent text-[var(--accent-9)] focus:ring-0 cursor-pointer"
                        />
                      </td>
                      <td className="p-1 px-2">
                        <input
                          type="text"
                          value={col.defaultValue}
                          onChange={(e) => handleColumnChange(idx, "defaultValue", e.target.value)}
                          placeholder="NULL"
                          className="w-full bg-transparent border-none rounded px-2 py-1 text-[10px] text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] focus:ring-1 focus:ring-[var(--accent-8)]/40 outline-none opacity-60 group-hover:opacity-100 transition-opacity"
                        />
                      </td>
                      <td className="p-1 text-center">
                        <IconButton
                          icon={<Trash2 />}
                          label="Remove column"
                          variant="ghost"
                          size="xs"
                          onClick={() => removeColumn(idx)}
                          disabled={columns.length <= 1}
                          className="text-[var(--danger-9)] hover:text-[var(--danger-10)] hover:bg-[var(--danger-3)]"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-3 p-3 bg-[var(--danger-3)] border border-[var(--danger-6)] rounded-md">
              <AlertCircle className="w-4 h-4 text-[var(--danger-9)] shrink-0 mt-0.5" />
              <p className="text-xs text-[var(--danger-11)]">{error}</p>
            </div>
          )}
        </Dialog.Body>

        <Dialog.Footer>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create Table"}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
