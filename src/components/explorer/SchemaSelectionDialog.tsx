import { useState, useEffect, useRef } from "react";
import { Database, Check, Search, ChevronDown, ChevronRight } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";

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

  // Per-schema row: clickable button representing a list item, not chrome.
  // Keeps the raw <button> because Button/IconButton would change the
  // checkbox+label compound semantic. Tokens are cleaned up though.
  const renderSchemaItem = (schema: string, showCheckbox = true) => (
    <button
      key={schema}
      onClick={() => toggleSchema(schema)}
      className={`w-full flex items-center gap-2 px-2 py-1 rounded transition-all text-left text-xs group cursor-pointer ${
        selectedSchemas.includes(schema)
          ? "bg-[var(--accent-3)] text-[var(--accent-11)]"
          : "hover:bg-[var(--neutral-3)] text-[var(--neutral-12)]"
      }`}
    >
      {showCheckbox && (
        <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
          selectedSchemas.includes(schema)
            ? "bg-[var(--accent-9)] border-[var(--accent-9)]"
            : "border-[var(--neutral-7)] group-hover:border-[var(--neutral-11)]"
        }`}>
          {selectedSchemas.includes(schema) && (
            <Check className="w-2.5 h-2.5 text-white" />
          )}
        </div>
      )}
      <span className="flex-1 font-mono truncate">{schema}</span>
      {selectedSchemas.includes(schema) && (
        <span className="text-[9px] text-[var(--accent-11)] font-bold shrink-0">ACTIVE</span>
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
          className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--neutral-3)] text-left cursor-pointer"
        >
          {isExpanded ? <ChevronDown className="w-3 h-3 text-[var(--neutral-11)]" /> : <ChevronRight className="w-3 h-3 text-[var(--neutral-11)]" />}
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--neutral-11)]">{title}</span>
          <span className="text-[9px] text-[var(--neutral-11)] ml-auto">{items.length}</span>
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
    <Dialog open={isOpen} onClose={onClose} size="lg" className="max-h-[700px]">
      <Dialog.Title onClose={onClose}>
        <span className="inline-flex items-center gap-2">
          <div className="p-1 bg-[var(--accent-3)] rounded">
            <Database className="w-3.5 h-3.5 text-[var(--accent-11)]" />
          </div>
          <span className="flex flex-col leading-tight">
            <span>Select schemas</span>
            <span className="text-[10px] font-normal text-[var(--neutral-11)]">{databaseName} on {connectionName}</span>
          </span>
        </span>
      </Dialog.Title>

      <Dialog.Body className="flex flex-col gap-3 min-h-0">
        <Input
          ref={searchInputRef}
          placeholder="Filter schemas…"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          inputSize="sm"
          leftIcon={<Search />}
        />

        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-5 h-5 border-2 border-[var(--accent-9)] border-t-transparent rounded-full" />
              <span className="ml-3 text-sm text-[var(--neutral-11)]">Loading schemas…</span>
            </div>
          ) : availableSchemas.length === 0 ? (
            <div className="text-center py-12 text-sm text-[var(--neutral-11)]">
              <Database className="w-8 h-8 mx-auto mb-3 opacity-30" />
              No schemas found
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3 px-1">
                <span className="text-[10px] text-[var(--neutral-11)]">
                  {selectedSchemas.length} of {availableSchemas.length} selected
                </span>
                <div className="flex gap-1">
                  <Button variant="ghost" size="xs" onClick={selectAll}>Select all</Button>
                  <Button variant="ghost" size="xs" onClick={deselectAll}>Clear</Button>
                </div>
              </div>

              {searchTerm ? (
                <div className="space-y-0.5">
                  {filteredSchemas.length === 0 ? (
                    <div className="text-center py-6 text-xs text-[var(--neutral-11)]">
                      No schemas match "{searchTerm}"
                    </div>
                  ) : (
                    filteredSchemas.map(s => renderSchemaItem(s))
                  )}
                </div>
              ) : (
                <>
                  {renderGroup("Selected", selectedFiltered, "selected")}
                  {renderGroup("User schemas", userSchemas.filter(s => !selectedSchemas.includes(s)), "user")}
                  {renderGroup("System schemas", systemSchemasFiltered, "system", true)}
                </>
              )}
            </>
          )}
        </div>
      </Dialog.Body>

      <Dialog.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={isLoading} onClick={handleSave}>
          Apply &amp; refresh
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}
