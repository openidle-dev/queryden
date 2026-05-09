import { useState, useEffect, useRef } from "react";
import { X, Database, Check, Search, ChevronDown, ChevronRight } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";

interface SchemaSelectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (selectedSchemas: string[]) => void;
  connectionId: string;
  connectionName: string;
  databaseName: string;
  currentSchemas: string[];
}

export function SchemaSelectionDialog({ isOpen, onClose, onApply, connectionId, connectionName, databaseName, currentSchemas }: SchemaSelectionDialogProps) {
  const { loadAvailableSchemas, setSelectedSchemas } = useConnections();
  const [availableSchemas, setAvailableSchemas] = useState<string[]>([]);
  const [selectedSchemas, setSelectedSchemasState] = useState<string[]>(currentSchemas);
  const [isLoading, setIsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["selected"]));
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setIsLoading(true);
      setSearchTerm("");
      loadAvailableSchemas().then(schemas => {
        setAvailableSchemas(schemas);
        setIsLoading(false);
        setTimeout(() => searchInputRef.current?.focus(), 100);
      });
      setSelectedSchemasState(currentSchemas);
    }
  }, [isOpen]);

  const handleSave = async () => {
    await setSelectedSchemas(connectionId, databaseName, selectedSchemas);
    onApply(selectedSchemas);
    onClose();
  };

  const toggleSchema = (schema: string) => {
    setSelectedSchemasState(prev =>
      prev.includes(schema)
        ? prev.filter(s => s !== schema)
        : [...prev, schema]
    );
  };

  const selectAll = () => setSelectedSchemasState([...availableSchemas]);
  const deselectAll = () => setSelectedSchemasState([]);

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const filteredSchemas = availableSchemas.filter(s =>
    s.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const selectedFiltered = filteredSchemas.filter(s => selectedSchemas.includes(s));

  const systemSchemas = ["information_schema", "pg_catalog", "pg_toast", "pg_extensions", "topology"];
  const userSchemas = filteredSchemas.filter(s => !systemSchemas.includes(s));
  const systemSchemasFiltered = filteredSchemas.filter(s => systemSchemas.includes(s));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  if (!isOpen) return null;

  const renderSchemaItem = (schema: string, showCheckbox = true) => (
    <button
      key={schema}
      onClick={() => toggleSchema(schema)}
      className={`w-full flex items-center gap-2 px-2 py-1 rounded transition-all text-left text-xs group ${
        selectedSchemas.includes(schema)
          ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
          : "hover:bg-[var(--surface-raised)] text-[var(--text-primary)]"
      }`}
    >
      {showCheckbox && (
        <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
          selectedSchemas.includes(schema)
            ? "bg-[var(--color-accent)] border-[var(--color-accent)]"
            : "border-[var(--border)] group-hover:border-[var(--text-secondary)]"
        }`}>
          {selectedSchemas.includes(schema) && (
            <Check className="w-2.5 h-2.5 text-white" />
          )}
        </div>
      )}
      <span className="flex-1 font-mono truncate">{schema}</span>
      {selectedSchemas.includes(schema) && (
        <span className="text-[9px] text-[var(--color-accent)] font-bold shrink-0">ACTIVE</span>
      )}
    </button>
  );

  const renderGroup = (title: string, items: string[], groupKey: string, showEmpty = false) => {
    if (!showEmpty && items.length === 0) return null;
    const isExpanded = expandedGroups.has(groupKey);

    return (
      <div key={groupKey} className="mb-1">
        <button
          onClick={() => toggleGroup(groupKey)}
          className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--surface-raised)] text-left"
        >
          {isExpanded ? <ChevronDown className="w-3 h-3 text-[var(--text-secondary)]" /> : <ChevronRight className="w-3 h-3 text-[var(--text-secondary)]" />}
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">{title}</span>
          <span className="text-[9px] text-[var(--text-secondary)] ml-auto">{items.length}</span>
        </button>
        {isExpanded && (
          <div className="ml-4 mt-0.5 space-y-0.5">
            {items.map(s => renderSchemaItem(s))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200] backdrop-blur-[1px]" onKeyDown={handleKeyDown}>
      <div className="bg-[var(--surface)] rounded-xl shadow-2xl w-[550px] max-h-[700px] flex flex-col overflow-hidden border border-[var(--border)] animate-in fade-in zoom-in duration-100">
        {/* Header */}
        <div className="p-4 border-b border-[var(--border)] bg-gradient-to-r from-[var(--surface-raised)] to-[var(--surface)]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-[var(--color-accent)]/20 rounded">
                <Database className="w-4 h-4 text-[var(--color-accent)]" />
              </div>
              <div>
                <h3 className="text-sm font-bold tracking-wide">Select Schemas</h3>
                <p className="text-[10px] text-[var(--text-secondary)]">{databaseName} on {connectionName}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-full hover:bg-[var(--border)] transition-all">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Filter schemas..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg bg-[#111111] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-white placeholder:text-[var(--text-secondary)]"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar" ref={listRef}>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-5 h-5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full" />
              <span className="ml-3 text-sm text-[var(--text-secondary)]">Loading schemas...</span>
            </div>
          ) : availableSchemas.length === 0 ? (
            <div className="text-center py-12 text-sm text-[var(--text-secondary)]">
              <Database className="w-8 h-8 mx-auto mb-3 opacity-30" />
              No schemas found
            </div>
          ) : (
            <>
              {/* Quick actions */}
              <div className="flex items-center justify-between mb-3 px-1">
                <span className="text-[10px] text-[var(--text-secondary)]">
                  {selectedSchemas.length} of {availableSchemas.length} selected
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={selectAll}
                    className="text-[10px] px-2 py-1 rounded hover:bg-[var(--border)] font-bold"
                  >
                    Select All
                  </button>
                  <button
                    onClick={deselectAll}
                    className="text-[10px] px-2 py-1 rounded hover:bg-[var(--border)] font-bold"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Grouped schema list */}
              {searchTerm ? (
                /* Flat list when searching */
                <div className="space-y-0.5">
                  {filteredSchemas.length === 0 ? (
                    <div className="text-center py-6 text-xs text-[var(--text-secondary)]">
                      No schemas match "{searchTerm}"
                    </div>
                  ) : (
                    filteredSchemas.map(s => renderSchemaItem(s))
                  )}
                </div>
              ) : (
                /* Grouped view when not searching */
                <>
                  {renderGroup("Selected", selectedFiltered, "selected")}
                  {renderGroup("User Schemas", userSchemas.filter(s => !selectedSchemas.includes(s)), "user")}
                  {renderGroup("System Schemas", systemSchemasFiltered, "system", true)}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--surface-raised)] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[#333] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isLoading}
            className="px-6 py-2 text-xs font-bold rounded-lg bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-all shadow-lg shadow-[var(--color-accent)]/20 disabled:opacity-50"
          >
            Apply & Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
