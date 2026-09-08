import { useState, useMemo, useCallback, useEffect } from "react";
import {
  X,
  Search,
  RotateCw,
  Image,
  Columns,
  Key,
  Table,
  AlertCircle,
  Loader2,
  Filter,
  Plus,
} from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { Dialog } from "../ui/Dialog";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { ERDCanvas } from "./ERDCanvas";
import { useERData, type ERTable } from "./useERData";
import { TableSelectorDialog } from "./TableSelectorDialog";

interface ERDDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// Radix Select forbids empty-string item values; "All Schemas" (no filter)
// uses undefined by design, so map it through a non-empty sentinel.
const ALL_SCHEMAS_SENTINEL = "__all_schemas__";

function extractSchemas(tableNames: string[]): string[] {
  const schemas = new Set<string>();
  let hasUnprefixed = false;
  for (const t of tableNames) {
    const dot = t.indexOf(".");
    if (dot > 0) schemas.add(t.slice(0, dot));
    else hasUnprefixed = true;
  }
  if (hasUnprefixed) schemas.add("public");
  return Array.from(schemas).sort();
}

async function fetchSQLiteTables(db: any): Promise<string[]> {
  try {
    const rows = await db.select(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    return rows.map((r: any) => r.name ?? "");
  } catch {
    return [];
  }
}

function filterTables(
  tables: ERTable[],
  search: string,
  schemaFilter: string | undefined,
): Set<string> {
  const visible = new Set<string>();
  const lowerSearch = search.toLowerCase();
  for (const t of tables) {
    if (schemaFilter && t.schema !== schemaFilter) continue;
    if (search && !t.tableName.toLowerCase().includes(lowerSearch)) continue;
    visible.add(t.id);
  }
  return visible;
}

function getRelatedTableIds(
  tableId: string,
  edges: { source: string; target: string }[],
): Set<string> {
  const related = new Set<string>([tableId]);
  const queue = [tableId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const e of edges) {
      if (e.source === current && !related.has(e.target)) {
        related.add(e.target);
        queue.push(e.target);
      }
      if (e.target === current && !related.has(e.source)) {
        related.add(e.source);
        queue.push(e.source);
      }
    }
  }
  return related;
}

export function ERDDialog({ isOpen, onClose }: ERDDialogProps) {
  const { currentDb, activeConnection, selectedDatabase, schemaItems } =
    useConnections();
  const confirmDialog = useConfirmDialog();

  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [showSelector, setShowSelector] = useState(true);
  const [search, setSearch] = useState("");
  const [schemaFilter, setSchemaFilter] = useState<string | undefined>(
    undefined,
  );
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [pkOnly, setPkOnly] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sqliteTables, setSqliteTables] = useState<string[] | null>(null);
  const connectionType = activeConnection?.type;

  const isSQLite = connectionType === "sqlite";
  const allTableNames = useMemo(() => {
    if (isSQLite && sqliteTables) return sqliteTables;
    return schemaItems?.tables ?? [];
  }, [isSQLite, sqliteTables, schemaItems?.tables]);

  const selectedSchemaList = useMemo(() => {
    if (selectedTables.length > 0) return extractSchemas(selectedTables);
    return extractSchemas(allTableNames);
  }, [selectedTables, allTableNames]);

  const schemaList = useMemo(() => {
    return extractSchemas(allTableNames);
  }, [allTableNames]);

  const handleTableSelect = useCallback(
    (tables: string[]) => {
      setSelectedTables(tables);
      setShowSelector(false);
      setRefreshKey((k) => k + 1);
    },
    [],
  );

  const handleAddTables = useCallback(() => {
    setShowSelector(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setSelectedTables([]);
      setShowSelector(true);
      setSearch("");
      setSchemaFilter(undefined);
      setPkOnly(false);
      setShowAllColumns(false);
      setRefreshKey(0);

      if (isSQLite && currentDb) {
        fetchSQLiteTables(currentDb).then(setSqliteTables);
      }
    }
  }, [isOpen, isSQLite, currentDb]);

  useEffect(() => {
    if (
      allTableNames.length === 1 &&
      selectedTables.length === 0 &&
      showSelector
    ) {
      handleTableSelect([allTableNames[0]]);
    }
  }, [allTableNames, selectedTables.length, showSelector, handleTableSelect]);

  const { data, isLoading, error } = useERData(
    currentDb,
    connectionType,
    schemaItems,
    selectedDatabase,
    schemaList,
    selectedTables,
    refreshKey,
  );

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setSearch("");
    setSchemaFilter(undefined);
    setPkOnly(false);
    setShowAllColumns(false);
  }, []);

  const visibleTableIds = useMemo(() => {
    if (!data?.tables) return new Set<string>();
    const filtered = filterTables(data.tables, search, schemaFilter);
    if (!search) return filtered;
    const expanded = new Set<string>();
    for (const id of filtered) {
      const related = getRelatedTableIds(id, data.edges);
      for (const r of related) expanded.add(r);
    }
    return expanded;
  }, [data, search, schemaFilter]);

  const filteredNodes = useMemo(() => {
    if (!data?.nodes) return [];
    return data.nodes.filter((n) => visibleTableIds.has(n.id));
  }, [data, visibleTableIds]);

  const filteredEdges = useMemo(() => {
    if (!data?.edges) return [];
    return data.edges.filter(
      (e) => visibleTableIds.has(e.source) && visibleTableIds.has(e.target),
    );
  }, [data, visibleTableIds]);

  const processedNodes = useMemo(() => {
    let nodes = filteredNodes;
    if (pkOnly) {
      nodes = nodes.map((node) => {
        const tableData = data?.tables.find((t) => t.id === node.id);
        if (!tableData) return node;
        return {
          ...node,
          data: {
            ...node.data,
            columns: tableData.columns.filter((c) => c.isPK),
          },
        };
      });
    } else if (!showAllColumns) {
      nodes = nodes.map((node) => {
        const tableData = data?.tables.find((t) => t.id === node.id);
        if (!tableData) return node;
        return {
          ...node,
          data: {
            ...node.data,
            columns: tableData.columns.filter((c) => c.isPK || c.isFK),
          },
        };
      });
    }
    return nodes;
  }, [filteredNodes, pkOnly, showAllColumns, data?.tables]);

  const selectedTableInfo = useMemo(() => {
    if (!data?.tables) return null;
    for (const id of visibleTableIds) {
      const t = data.tables.find((x) => x.id === id);
      if (t) return t;
    }
    return null;
  }, [data, visibleTableIds]);

  const exportSVG = useCallback(async () => {
    try {
      const el = document.querySelector(".react-flow") as HTMLElement;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const clone = el.cloneNode(true) as HTMLElement;
      const inner = clone.innerHTML;
      const svgData = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${rect.width}" height="${rect.height}">`,
        `  <defs>`,
        `    <style>`,
        `      .react-flow__node { cursor: grab; }`,
        `      .react-flow__node-tableNode > div { border: 2px solid #cdced7; border-radius: 8px; background: #fff; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }`,
        `      .react-flow__handle { opacity: 0.6; }`,
        `      .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`,
        `      .font-mono { font-family: monospace; }`,
        `    </style>`,
        `  </defs>`,
        `  <foreignObject x="0" y="0" width="${rect.width}" height="${rect.height}">`,
        `    <xhtml:div xmlns:xhtml="http://www.w3.org/1999/xhtml" style="width:${rect.width}px;height:${rect.height}px;position:relative;overflow:hidden">`,
        inner,
        `    </xhtml:div>`,
        `  </foreignObject>`,
        `</svg>`,
      ].join("\n");

      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        filters: [{ name: "SVG Image", extensions: ["svg"] }],
        defaultPath: `erd-${selectedDatabase || "schema"}.svg`,
      });
      if (path) {
        await writeTextFile(path, svgData);
      }
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      confirmDialog.dialog({ title: "Export Failed", message: errMsg, confirmLabel: "OK", type: "danger" });
    }
  }, [selectedDatabase]);

  const hasFilters = search !== "" || schemaFilter !== undefined;
  const visibleCount = visibleTableIds.size;
  const totalSelected = data?.tables?.length ?? 0;

  const hasNoConnection = !currentDb || !activeConnection;
  const hasNoTables =
    !hasNoConnection &&
    !isLoading &&
    !error &&
    data &&
    data.tables.length === 0;

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      className="w-full h-full max-w-[95vw] max-h-[90vh] rounded-xl overflow-hidden"
    >
      <div className="flex flex-col h-full">
        {showSelector ? (
          <>
            {allTableNames.length === 0 && !isLoading && !isSQLite ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="text-center">
                  <Filter className="w-8 h-8 text-[var(--neutral-9)] mx-auto mb-3" />
                  <p className="text-sm text-[var(--neutral-11)]">
                    No tables found in this database.
                  </p>
                  <button
                    onClick={onClose}
                    className="mt-4 px-4 py-1.5 text-xs font-medium rounded-md bg-[var(--accent-9)] text-white hover:bg-[var(--accent-10)] transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : allTableNames.length === 1 ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-[var(--accent-9)] animate-spin" />
              </div>
            ) : (
              <TableSelectorDialog
                tables={allTableNames}
                selected={selectedTables}
                onConfirm={handleTableSelect}
                onCancel={onClose}
              />
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--neutral-6)] bg-[var(--surface-elevated)] shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-1.5 bg-[var(--accent-3)] rounded-lg">
                  <Table className="w-4 h-4 text-[var(--accent-11)]" />
                </div>
                <h2 className="text-sm font-bold text-[var(--neutral-12)]">
                  ER Diagram
                </h2>
                <span className="text-[10px] text-[var(--neutral-11)]">
                  {activeConnection?.name || ""}
                  {selectedDatabase ? ` / ${selectedDatabase}` : ""}
                </span>
                {selectedTables.length > 0 && (
                  <button
                    onClick={handleAddTables}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border border-[var(--neutral-6)] text-[var(--neutral-11)] hover:text-[var(--neutral-12)] hover:bg-[var(--neutral-4)] transition-colors"
                  >
                    <Plus className="w-2.5 h-2.5" />
                    Add tables
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                {selectedSchemaList.length > 1 && (
                  <Select
                    selectSize="sm"
                    className="w-36"
                    value={schemaFilter ?? ALL_SCHEMAS_SENTINEL}
                    onValueChange={(v) =>
                      setSchemaFilter(v === ALL_SCHEMAS_SENTINEL ? undefined : v)
                    }
                    options={[
                      { label: "All Schemas", value: ALL_SCHEMAS_SENTINEL },
                      ...selectedSchemaList.map((s) => ({ label: s, value: s })),
                    ]}
                  />
                )}

                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--neutral-9)]" />
                  <Input
                    type="text"
                    placeholder="Search tables..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-7 text-[11px] h-7 w-40"
                  />
                </div>

                <IconButton
                  label={
                    showAllColumns
                      ? "Compact view (hide data columns)"
                      : "Show all columns"
                  }
                  icon={<Columns />}
                  size="sm"
                  variant="ghost"
                  className={
                    !showAllColumns ? "text-[var(--accent-9)]" : undefined
                  }
                  onClick={() => setShowAllColumns(!showAllColumns)}
                />

                <IconButton
                  label={pkOnly ? "Show all columns" : "PKs only"}
                  icon={<Key />}
                  size="sm"
                  variant="ghost"
                  className={pkOnly ? "text-[var(--accent-9)]" : undefined}
                  onClick={() => setPkOnly(!pkOnly)}
                />

                <IconButton
                  label="Refresh"
                  icon={<RotateCw />}
                  size="sm"
                  variant="ghost"
                  onClick={refresh}
                />

                <IconButton
                  label="Export SVG"
                  icon={<Image />}
                  size="sm"
                  variant="ghost"
                  onClick={exportSVG}
                  disabled={!data?.nodes.length}
                />

                <IconButton
                  label="Close"
                  icon={<X />}
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                />
              </div>
            </div>

            <div className="flex-1 relative bg-[var(--surface-base)]">
              {hasNoConnection ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <AlertCircle className="w-8 h-8 text-[var(--neutral-9)] mx-auto mb-3" />
                    <p className="text-sm text-[var(--neutral-11)]">
                      Connect to a database to view the ER diagram.
                    </p>
                  </div>
                </div>
              ) : isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <Loader2 className="w-8 h-8 text-[var(--accent-9)] mx-auto mb-3 animate-spin" />
                    <p className="text-sm text-[var(--neutral-11)]">
                      Loading schema data...
                    </p>
                  </div>
                </div>
              ) : error ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center max-w-md">
                    <AlertCircle className="w-8 h-8 text-[var(--danger-9)] mx-auto mb-3" />
                    <p className="text-sm text-[var(--neutral-11)]">{error}</p>
                  </div>
                </div>
              ) : hasNoTables ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <Filter className="w-8 h-8 text-[var(--neutral-9)] mx-auto mb-3" />
                    <p className="text-sm text-[var(--neutral-11)]">
                      {search || schemaFilter
                        ? "No tables match the current filters."
                        : "No tables or foreign key relationships found."}
                    </p>
                  </div>
                </div>
              ) : (
                <ERDCanvas
                  initialNodes={processedNodes as any}
                  initialEdges={filteredEdges as any}
                />
              )}
            </div>

            <div className="flex items-center justify-between px-4 py-1.5 border-t border-[var(--neutral-6)] bg-[var(--surface-elevated)] shrink-0 text-[10px] text-[var(--neutral-11)]">
              <span>
                {hasFilters
                  ? `${visibleCount} of ${totalSelected} table${totalSelected !== 1 ? "s" : ""}`
                  : `${totalSelected} table${totalSelected !== 1 ? "s" : ""}`}
                {data?.edges?.length
                  ? ` · ${data.edges.length} relationship${data.edges.length !== 1 ? "s" : ""}`
                  : ""}
                {selectedTables.length > 0 && data?.tables && (
                  <span className="ml-1 text-[var(--neutral-9)]">
                    (of {selectedTables.length} selected)
                  </span>
                )}
              </span>
              <span>
                {selectedTableInfo
                  ? `${selectedTableInfo.schema ? `${selectedTableInfo.schema}.` : ""}${selectedTableInfo.tableName} · ${selectedTableInfo.columns.length} column${selectedTableInfo.columns.length !== 1 ? "s" : ""}`
                  : "Click a table to select"}
              </span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
