import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { X, Play, Loader2, AlertCircle, Check, Layers, ChevronDown, ChevronRight, Folder, Search, CheckCircle, Database, Clock, Table2, AlertTriangle, Info, Save, Star, Download, FileCode, Globe, RefreshCw, Copy, Trash2, FileJson } from "lucide-react";
import { useSavedQueries } from "../../store/savedQueryStore";
import { useSettings } from "../../store/settingsStore";
import { save } from "@tauri-apps/plugin-dialog";
import { QueryEditor } from "../editor/QueryEditor";
import { useConnections } from "../../contexts/useConnections";
import { DatabaseConnection } from "../../contexts/ConnectionContext";
import { GridView, GridViewRef } from "../ui/GridView";
import { CompactSelection } from "@glideapps/glide-data-grid";
import { Dialog } from "../ui/Dialog";
import { splitStatements } from "../../utils/splitStatements";
import { getDefaultPort, isMySqlLike, isSelectLike } from "../../utils/sqlDialect";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/Select";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from "../ui/Menu";

interface MultiQueryDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface QueryResult {
  connectionName: string;
  databaseName: string;
  connectionId: string;
  rows: any[];
  columns: string[];
  rowsAffected: number;
  error?: string;
  duration: number;
  status?: 'running' | 'done' | 'error';
}

interface SelectedTarget {
  connectionId: string;
  database: string;
}

export function MultiQueryDialog({ isOpen, onClose }: MultiQueryDialogProps) {
  const { connections, vaultCredentials } = useConnections();
  const settings = useSettings();
  const { queries: savedQueries } = useSavedQueries();
  const [sidebarTab, setSidebarTab] = useState<"targets" | "saved">("targets");
  const [savedSearch, setSavedSearch] = useState("");
  const [selectedTargets, setSelectedTargets] = useState<SelectedTarget[]>([]);
  const [expandedConnections, setExpandedConnections] = useState<Set<string>>(new Set());
  const [availableDatabases, setAvailableDatabases] = useState<Record<string, string[]>>({});
  const [loadingDatabases, setLoadingDatabases] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QueryResult[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [showMerged, setShowMerged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [columnSearch, setColumnSearch] = useState("");
  const [gridSelection, setGridSelection] = useState<any>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
    current: undefined
  });
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [selectedJumpCol, setSelectedJumpCol] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [showToast, setShowToast] = useState(false);
  const [statusDetailModal, setStatusDetailModal] = useState<QueryResult | null>(null);
  const [hoveredStatus, setHoveredStatus] = useState<{ connId: string; db: string; result: QueryResult } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, row: any, col?: string } | null>(null);
  const gridRef = useRef<GridViewRef>(null);

  const getMergedResults = useCallback((): QueryResult[] => {
    if (results.length === 0) return [];
    const allColumns = new Set<string>();
    results.forEach(r => {
        if (r.columns && r.columns.length > 0) r.columns.forEach((c: string) => allColumns.add(c));
        else if (r.rows && r.rows.length > 0) Object.keys(r.rows[0]).forEach(c => allColumns.add(c));
    });
    const mergedColumns = Array.from(allColumns);
    const mergedRows: any[] = [];
    results.forEach(r => {
      if (r.rows) {
        r.rows.forEach((row: any) => {
          mergedRows.push({ ...row, _source_connection: r.connectionName, _source_database: r.databaseName });
        });
      }
    });
    return [{
      connectionName: "All Databases",
      databaseName: "Merged",
      connectionId: "merged",
      rows: mergedRows,
      columns: ["_source_connection", "_source_database", ...mergedColumns],
      rowsAffected: mergedRows.length,
      duration: results.reduce((sum, r) => sum + r.duration, 0)
    }];
  }, [results]);

  const displayResults = useMemo(() => showMerged ? getMergedResults() : results, [showMerged, results, getMergedResults]);
  const currentResult = displayResults?.[activeTab];

  const columns = useMemo(() => {
    if (!currentResult) return [];
    if (currentResult.columns && currentResult.columns.length > 0) return currentResult.columns;
    if (currentResult.rows && currentResult.rows.length > 0) return Object.keys(currentResult.rows[0]);
    return [];
  }, [currentResult]);

  const sortedRows = useMemo(() => {
    let rows = [...(currentResult?.rows || [])];
    if (!sortCol || !sortDir) return rows;
    return rows.sort((a, b) => {
      const aVal = a[sortCol], bVal = b[sortCol];
      if (aVal === bVal) return 0;
      if (aVal === null) return 1; if (bVal === null) return -1;
      if (typeof aVal === "number" && typeof bVal === "number") return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      return sortDir === "asc" ? String(aVal).localeCompare(String(bVal)) : String(bVal).localeCompare(String(aVal));
    });
  }, [currentResult, sortCol, sortDir]);

  useEffect(() => {
    if (isOpen) {
      setSelectedTargets([]); setExpandedConnections(new Set()); setAvailableDatabases({}); setLoadingDatabases(new Set()); setResults([]); setQuery(""); setError(null); setShowMerged(false);
      setSidebarTab("targets"); setSavedSearch("");
    }
  }, [isOpen]);

  // Sync scroll to search
  useEffect(() => {
    if (columnSearch && columns.length > 0) {
      const idx = columns.findIndex(c => c.toLowerCase().includes(columnSearch.toLowerCase()));
      if (idx >= 0) {
        gridRef.current?.scrollToColumn(idx);
      }
    }
  }, [columnSearch, columns]);

  const loadDatabasesForConnection = useCallback(async (connId: string, onComplete?: () => void) => {
    const conn = connections.find(c => c.id === connId);
    if (!conn || availableDatabases[connId] || loadingDatabases.has(connId)) {
      // If already loaded or loading, still call the callback
      if (onComplete) onComplete();
      return;
    }
    setLoadingDatabases(prev => new Set(prev).add(connId));
    try {
      let username = conn.username || "", password = conn.password || "";
      if (conn.vaultCredentialId) { const vaultCred = vaultCredentials.find(vc => vc.id === conn.vaultCredentialId); if (vaultCred) { username = vaultCred.username || ""; password = vaultCred.password || ""; } }
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      const port = conn.port || getDefaultPort(conn.type);
      const connectionString = conn.type === "sqlite" ? `sqlite:${conn.filepath || "dbman.sqlite"}` :
        ["postgres", "supabase", "cockroach"].includes(conn.type) ? `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${conn.host}:${port}/postgres` :
        `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${conn.host}:${port}/mysql`;
      const db = await Database.load(connectionString);
      let dbs: string[] = [];
      if (["postgres", "supabase", "cockroach"].includes(conn.type)) dbs = (await db.select<any[]>("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")).map((r: any) => r.datname);
      else if (["mysql", "mariadb"].includes(conn.type)) dbs = (await db.select<any[]>("SHOW DATABASES")).map((r: any) => r.Database).filter((db: string) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(db));
      else if (conn.type === "sqlite") dbs = [conn.filepath || "main"];
      setAvailableDatabases(prev => ({ ...prev, [connId]: dbs }));
      // Call the completion callback after databases are set
      if (onComplete) onComplete();
    } catch { setAvailableDatabases(prev => ({ ...prev, [connId]: [conn!.database] })); if (onComplete) onComplete(); }
    finally { setLoadingDatabases(prev => { const next = new Set(prev); next.delete(connId); return next; }); }
  }, [availableDatabases, loadingDatabases, connections, vaultCredentials]);

  const [isExecuting, setIsExecuting] = useState(false);

  const executeQuery = async (queryText?: any, _statementInfo?: any) => {
    if (selectedTargets.length === 0) { setError("Please select at least one database"); return; }

    // Determine what text to run
    let queryToRun = "";
    let statementsToRun: string[] = [];

    if (queryText && typeof queryText === 'object' && queryText.__runAll) {
      statementsToRun = queryText.statements || [];
    } else {
      queryToRun = typeof queryText === 'string' ? queryText : query;
      if (!queryToRun.trim()) { setError("Empty query"); return; }
      // Lexer-aware split so DO $$ bodies, strings and comments survive.
      // `#` handling: the same text runs on every selected target, which may
      // mix dialects — enable MySQL `#` comments when any target is
      // MySQL-family (otherwise PostgreSQL `#>` operators would corrupt).
      const anyMySql = selectedTargets.some(t => {
        const c = connections.find(x => x.id === t.connectionId);
        return c ? isMySqlLike(c.type) : false;
      });
      statementsToRun = splitStatements(queryToRun, { hashComments: anyMySql }).map(s => s.text);
    }

    if (statementsToRun.length === 0) return;

    setError(null);
    setIsExecuting(true);

    // Issue 1 FIX: Auto-expand connections that have selected targets
    const targetConnectionIds = selectedTargets.map(t => t.connectionId);
    setExpandedConnections(prev => {
      const next = new Set(prev);
      targetConnectionIds.forEach(connId => {
        next.add(connId);
        if (!availableDatabases[connId] && !loadingDatabases.has(connId)) {
          loadDatabasesForConnection(connId);
        }
      });
      return next;
    });

    // Setup initial running state
    const initialResults: QueryResult[] = selectedTargets.map(target => ({
      connectionName: connections.find(c => c.id === target.connectionId)?.name || "",
      databaseName: target.database,
      connectionId: target.connectionId,
      rows: [], columns: [], rowsAffected: 0, duration: 0, status: 'running'
    }));
    setResults(initialResults);
    setActiveTab(0);

    const isSelectQueryFor = (stmt: string, connType: string | undefined) =>
      isSelectLike(stmt, { hashComments: isMySqlLike(connType) });

    for (const target of selectedTargets) {
      const conn = connections.find(c => c.id === target.connectionId);
      if (!conn) continue;
      const startTime = Date.now();

      try {
        let username = conn.username || "", password = conn.password || "";
        if (conn.vaultCredentialId) { const vaultCred = vaultCredentials.find(vc => vc.id === conn.vaultCredentialId); if (vaultCred) { username = vaultCred.username || ""; password = vaultCred.password || ""; } }

        const Database = (await import("@tauri-apps/plugin-sql")).default;
        const port = conn.port || getDefaultPort(conn.type);
        const connectionString = conn.type === "sqlite" ? `sqlite:${conn.filepath || "dbman.sqlite"}` :
          ["postgres", "supabase", "cockroach"].includes(conn.type) ? `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${conn.host}:${port}/${target.database}` :
          `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${conn.host}:${port}/${target.database}`;

        const db = await Database.load(connectionString);

        let lastRows: any[] = [];
        let lastCols: string[] = [];
        let totalAffected = 0;

        // Execute each statement sequentially
        for (const stmt of statementsToRun) {
          if (isSelectQueryFor(stmt, conn.type)) {
            const rows = await db.select<any[]>(stmt);
            lastRows = rows;
            lastCols = rows.length > 0 ? Object.keys(rows[0]) : [];
            totalAffected += rows.length;
          } else {
            const result = await db.execute(stmt);
            totalAffected += (result.rowsAffected || 0);
          }
        }

        setResults(prev => prev.map(r => (r.connectionId === target.connectionId && r.databaseName === target.database)
          ? {
              ...r,
              status: 'done',
              rows: lastRows,
              columns: lastCols,
              rowsAffected: totalAffected,
              duration: Date.now() - startTime
            } : r));

      } catch (err: any) {
        setResults(prev => prev.map(r => (r.connectionId === target.connectionId && r.databaseName === target.database)
          ? { ...r, status: 'error', error: err?.message || String(err), duration: Date.now() - startTime } : r));
      }
    }
    setIsExecuting(false);
  };

  const getTargetStatus = (connId: string, db: string) => results.find(r => r.connectionId === connId && r.databaseName === db)?.status;

  const getSelectedCount = (connId: string) => selectedTargets.filter(t => t.connectionId === connId).length;
  const isTargetSelected = (connId: string, db: string) => selectedTargets.some(t => t.connectionId === connId && t.database === db);

  const toggleSelectAll = () => {
    if (selectedTargets.length === 0) {
      const all: SelectedTarget[] = [];
      connections.forEach(conn => (availableDatabases[conn.id] || [conn.database]).forEach(db => all.push({ connectionId: conn.id, database: db })));
      setSelectedTargets(all);
    } else setSelectedTargets([]);
  };

  const toggleTarget = (connId: string, db: string) => {
    setSelectedTargets(prev => {
        const idx = prev.findIndex(t => t.connectionId === connId && t.database === db);
        if (idx >= 0) return prev.filter((_, i) => i !== idx);
        return [...prev, { connectionId: connId, database: db }];
    });
  };

  const toggleConnAll = (conn: DatabaseConnection) => {
    // If databases aren't loaded yet, start loading them and select all AFTER loading completes
    if (!availableDatabases[conn.id] && !loadingDatabases.has(conn.id)) {
      // Start loading, then call toggleConnAll again after databases are loaded
      loadDatabasesForConnection(conn.id, () => {
        // This callback runs AFTER databases are set in state
        toggleConnAll(conn);
      });
      return; // Don't do anything yet, wait for callback
    }

    // Get ALL databases for this connection
    const dbs = availableDatabases[conn.id]?.length > 0 ? availableDatabases[conn.id] : [conn.database];
    const current = selectedTargets.filter(t => t.connectionId === conn.id);

    // If all databases are already selected, deselect all
    // Otherwise, select ALL databases from this connection
    if (current.length === dbs.length && current.length > 0) {
      setSelectedTargets(prev => prev.filter(t => t.connectionId !== conn.id));
    } else {
      // Select ALL databases from this connection
      const targetsToSelect = dbs.map(db => ({ connectionId: conn.id, database: db }));
      setSelectedTargets(prev => [...prev.filter(t => t.connectionId !== conn.id), ...targetsToSelect]);
    }
  };

  const exportData = async (f: "csv" | "excel" | "json" | "xml" | "html" | "sql") => {
    if (!currentResult?.rows?.length) return;
    try {
        const mapping: Record<string, string> = {
          csv: "csv", json: "json", excel: "xls", xml: "xml", html: "html", sql: "sql"
        };
        const ext = mapping[f] || "txt";
        const path = await save({
          filters: [{ name: f.toUpperCase(), extensions: [ext] }],
          defaultPath: `export_${Date.now()}.${ext}`
        });
        if (!path) return;

        let content = "";
        const rows = currentResult.rows;
        const cols = columns;

        if (f === "json") {
          content = JSON.stringify(rows, null, 2);
        } else if (f === "csv") {
          content = [cols.join(","), ...rows.map(r => cols.map(c => JSON.stringify(r[c])).join(","))].join("\n");
        } else if (f === "excel") {
          content = [cols.join("\t"), ...rows.map(r => cols.map(c => JSON.stringify(r[c])).join("\t"))].join("\n");
        } else if (f === "xml") {
          content = `<?xml version="1.0" encoding="UTF-8"?>\n<results>\n` +
                    rows.map(r => `  <row>\n${cols.map(c => `    <${c}>${String(r[c])}</${c}>`).join("\n")}\n  </row>`).join("\n") +
                    `\n</results>`;
        } else if (f === "html") {
          content = `<table border="1">\n  <thead>\n    <tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr>\n  </thead>\n  <tbody>\n` +
                    rows.map(r => `    <tr>${cols.map(c => `<td>${String(r[c])}</td>`).join("")}</tr>`).join("\n") +
                    `\n  </tbody>\n</table>`;
        } else if (f === "sql") {
          const table = "exported_data";
          content = rows.map(r => `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(c => {
            const v = r[c];
            if (v === null || v === undefined) return "NULL";
            if (typeof v === "number") return v;
            if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
            return `'${String(v).replace(/'/g, "''")}'`;
          }).join(", ")});`).join("\n");
        }

        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(path, content);
        setToastMessage(`Exported ${f.toUpperCase()} successfully`);
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2000);
    } catch (e: any) { setError(e.message); }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setToastMessage("Copied to clipboard");
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2000);
  };

  const generateSqlForSelected = (type: "INSERT" | "UPDATE" | "DELETE") => {
    const selectedRows = gridSelection.rows.toArray().map((idx: number) => sortedRows[idx]);
    if (selectedRows.length === 0 && contextMenu?.row) selectedRows.push(contextMenu.row);
    if (selectedRows.length === 0) return;

    const table = "target_table";
    const sqlColumns = selectedRows.length > 0
      ? Object.keys(selectedRows[0]).filter(k => !k.startsWith('_'))
      : columns.filter(k => !k.startsWith('_'));

    let sql = "";

    if (type === "INSERT") {
      sql = selectedRows.map((r: any) => `INSERT INTO ${table} (${sqlColumns.join(", ")}) VALUES (${sqlColumns.map(c => {
        const v = r[c];
        if (v === null || v === undefined) return "NULL";
        if (typeof v === "number") return v;
        if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
        return `'${String(v).replace(/'/g, "''")}'`;
      }).join(", ")});`).join("\n");
    } else if (type === "DELETE") {
      sql = selectedRows.map((r: any) => {
        const where = sqlColumns.map(c => `${c} = ${typeof r[c] === 'number' ? r[c] : (r[c] === null ? 'NULL' : `'${String(r[c]).replace(/'/g, "''")}'`)}`).join(" AND ");
        return `DELETE FROM ${table} WHERE ${where};`;
      }).join("\n");
    } else if (type === "UPDATE") {
      sql = selectedRows.map((r: any) => {
        const set = sqlColumns.map(c => `${c} = ${typeof r[c] === 'number' ? r[c] : (r[c] === null ? 'NULL' : `'${String(r[c]).replace(/'/g, "''")}'`)}`).join(", ");
        const where = sqlColumns.map(c => `${c} = ${typeof r[c] === 'number' ? r[c] : (r[c] === null ? 'NULL' : `'${String(r[c]).replace(/'/g, "''")}'`)}`).join(" AND ");
        return `UPDATE ${table} SET ${set} WHERE ${where};`;
      }).join("\n");
    }

    copyToClipboard(sql);
    setContextMenu(null);
  };

  if (!isOpen) return null;

  return (
    <>
      <Dialog
        open={isOpen}
        onClose={onClose}
        className="relative w-[95vw] h-[90vh] max-w-none rounded-2xl overflow-hidden"
        backdropClassName="bg-black/70 backdrop-blur-md"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-[var(--surface-elevated)] border-b border-[var(--neutral-6)] shrink-0">
          <div className="flex items-center gap-4">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-[var(--accent-9)] to-[var(--accent-10)] text-white shadow-lg shadow-[var(--accent-9)]/30">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-xl text-[var(--neutral-12)] tracking-tight">Multi-Query Cluster</h2>
              <div className="flex items-center gap-4 text-[10px] mt-0.5">
                <span className="flex items-center gap-1 text-[var(--accent-11)] font-bold">
                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-9)]" />
                  {selectedTargets.length} targets selected
                </span>
                {results.length > 0 && (
                  <span className="flex items-center gap-1 text-[var(--success-11)] font-bold">
                    <CheckCircle className="w-3 h-3" />
                    {results.filter(r => !r.error).length} successful
                  </span>
                )}
                {results.some(r => r.error) && (
                  <span className="flex items-center gap-1 text-[var(--danger-11)] font-bold">
                    <AlertCircle className="w-3 h-3" />
                    {results.filter(r => r.error).length} errors
                  </span>
                )}
                {isExecuting && (
                  <span className="flex items-center gap-1 text-[var(--warning-11)] animate-pulse">
                    <Loader2 className="w-3 h-3" />
                    Executing SQL...
                  </span>
                )}
              </div>
            </div>
          </div>
          <IconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar */}
          <div className="w-80 border-r border-[var(--neutral-6)] flex flex-col bg-[var(--surface-elevated)] shrink-0">
            {/* Sidebar Tabs */}
            <div className="flex border-b border-[var(--neutral-6)] bg-[var(--surface-panel)]">
              <button
                onClick={() => setSidebarTab("targets")}
                className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-all border-b-2 flex items-center justify-center gap-2 ${sidebarTab === "targets" ? "text-[var(--accent-11)] border-[var(--accent-9)] bg-[var(--surface-base)]" : "text-[var(--neutral-11)] border-transparent hover:text-[var(--neutral-12)] hover:bg-[var(--neutral-4)]"}`}
              >
                <Database className="w-3.5 h-3.5" />
                Nodes
              </button>
              <button
                onClick={() => setSidebarTab("saved")}
                className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-all border-b-2 flex items-center justify-center gap-2 ${sidebarTab === "saved" ? "text-[var(--accent-11)] border-[var(--accent-9)] bg-[var(--surface-base)]" : "text-[var(--neutral-11)] border-transparent hover:text-[var(--neutral-12)] hover:bg-[var(--neutral-4)]"}`}
              >
                <Star className="w-3.5 h-3.5" />
                Saved Queries
              </button>
            </div>

            {sidebarTab === "targets" ? (
              <div className="p-4 border-b border-[var(--neutral-6)] flex justify-between items-center bg-[var(--surface-panel)]">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-[var(--accent-11)]" />
                  <span className="text-[11px] font-bold text-[var(--neutral-11)] uppercase tracking-wider">Sync Group</span>
                </div>
                <Button size="xs" variant="secondary" onClick={toggleSelectAll}>
                  {selectedTargets.length ? "Clear All" : "Select All"}
                </Button>
              </div>
            ) : (
              <div className="p-3 border-b border-[var(--neutral-6)] bg-[var(--surface-panel)]">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--neutral-11)]" />
                  <input
                    type="text"
                    placeholder="Search library..."
                    value={savedSearch}
                    onChange={(e) => setSavedSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-[11px] rounded-lg bg-[var(--surface-base)] border border-[var(--neutral-7)] outline-none focus:border-[var(--accent-8)] transition-all"
                  />
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
              {sidebarTab === "targets" ? (
                <div className="space-y-2">
                  {connections.map(conn => {
                    const isExp = expandedConnections.has(conn.id);
                    const count = getSelectedCount(conn.id);
                    return (<div key={conn.id} className="mb-2">
                      <div className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-[var(--neutral-4)] group bg-[var(--surface-panel)] border border-[var(--neutral-6)]">
                        <button
                          onClick={() => { setExpandedConnections(prev => { const n = new Set(prev); if (n.has(conn.id)) n.delete(conn.id); else { n.add(conn.id); loadDatabasesForConnection(conn.id); } return n; }); }}
                          className="p-1 rounded hover:bg-[var(--neutral-5)] transition-colors"
                        >
                          {isExp ? <ChevronDown className="w-4 h-4 text-[var(--accent-11)]" /> : <ChevronRight className="w-4 h-4 text-[var(--accent-11)]" />}
                        </button>
                        <div onClick={() => toggleConnAll(conn)} className={`flex-1 flex items-center gap-3 cursor-pointer`}>
                          <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                            count === (availableDatabases[conn.id] || [conn.database]).length
                              ? "bg-[var(--accent-9)] border-[var(--accent-9)] text-white"
                              : count > 0
                              ? "bg-[var(--accent-9)]/30 border-[var(--accent-9)] text-[var(--accent-11)]"
                              : "border-[var(--neutral-7)]"
                          }`}>
                            {count > 0 && <Check className="w-3 h-3" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-semibold truncate block">{conn.name}</span>
                            <span className="text-[9px] text-[var(--neutral-11)] truncate block">{conn.type} • {conn.host}</span>
                          </div>
                          {count > 0 && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent-9)]/20 text-[var(--accent-11)] font-bold">
                              {count}
                            </span>
                          )}
                        </div>
                      </div>
                      {isExp && (
                        <div className="ml-4 pl-3 py-2 border-l-2 border-[var(--neutral-6)] space-y-1.5">
                          {(availableDatabases[conn.id] || [conn.database])?.map(db => {
                            const status = getTargetStatus(conn.id, db);
                            const result = results.find(r => r.connectionId === conn.id && r.databaseName === db);
                            return (
                              <div
                                key={db}
                                onClick={() => toggleTarget(conn.id, db)}
                                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all ${
                                  isTargetSelected(conn.id, db)
                                    ? "bg-[var(--accent-9)]/15 text-[var(--accent-11)] border border-[var(--accent-9)]/30"
                                    : "hover:bg-[var(--neutral-4)] opacity-70 border border-transparent"
                                }`}
                              >
                                <div
                                  className="relative"
                                  onMouseEnter={() => {
                                    if (status && result) {
                                      setHoveredStatus({ connId: conn.id, db, result });
                                    }
                                  }}
                                  onMouseLeave={() => setHoveredStatus(null)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (result) setStatusDetailModal(result);
                                  }}
                                >
                                  {status === 'running' ? (
                                    <Loader2 className="w-3.5 h-3.5 text-[var(--warning-11)] animate-spin" />
                                  ) : status === 'done' ? (
                                    <CheckCircle className="w-3.5 h-3.5 text-[var(--success-11)] cursor-pointer hover:scale-110 transition-transform" />
                                  ) : status === 'error' ? (
                                    <AlertCircle className="w-3.5 h-3.5 text-[var(--danger-11)] cursor-pointer hover:scale-110 transition-transform" />
                                  ) : (
                                    <div className={`w-3.5 h-3.5 rounded-md border-2 ${
                                      isTargetSelected(conn.id, db)
                                        ? "bg-[var(--accent-9)] border-[var(--accent-9)]"
                                        : "border-[var(--neutral-7)]"
                                    }`} />
                                  )}
                                </div>
                                <Folder className={`w-4 h-4 ${isTargetSelected(conn.id, db) ? "text-[var(--accent-11)]" : "text-[var(--neutral-9)]"}`} />
                                <span className="text-[11px] truncate flex-1 font-medium">{db}</span>
                                {status && (
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold cursor-pointer hover:scale-105 transition-transform ${
                                    status === 'done' ? "bg-[var(--success-3)] text-[var(--success-11)]" :
                                    status === 'error' ? "bg-[var(--danger-3)] text-[var(--danger-11)]" :
                                    "bg-[var(--warning-3)] text-[var(--warning-11)]"
                                  }`}>
                                    {status}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>);
                  })}
                </div>
              ) : (
                <div className="space-y-2">
                  {savedQueries
                    .filter(q => q.name.toLowerCase().includes(savedSearch.toLowerCase()) || q.query.toLowerCase().includes(savedSearch.toLowerCase()))
                    .map(q => (
                      <div
                        key={q.id}
                        onClick={() => {
                          setQuery(q.query);
                          setToastMessage(`Loaded query: ${q.name}`);
                          setShowToast(true);
                          setTimeout(() => setShowToast(false), 2000);
                        }}
                        className="p-3 rounded-xl bg-[var(--surface-panel)] border border-[var(--neutral-6)] hover:border-[var(--accent-8)] hover:bg-[var(--accent-9)]/5 cursor-pointer group transition-all"
                        title="Click to load this query"
                      >
                         <div className="flex items-center justify-between mb-1">
                           <span className="text-[11px] font-bold text-[var(--neutral-12)] group-hover:text-[var(--accent-11)] transition-colors uppercase tracking-tight truncate mr-2">{q.name}</span>
                           <span className="text-[9px] opacity-40 italic shrink-0">{new Date(q.createdAt).toLocaleDateString()}</span>
                         </div>
                         <div className="text-[10px] text-[var(--neutral-11)] font-mono line-clamp-2 opacity-60 bg-[var(--surface-base)] p-1.5 rounded-md border border-[var(--neutral-6)]">
                           {q.query}
                         </div>
                      </div>
                    ))}
                  {savedQueries.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-20 opacity-20 select-none">
                       <Save className="w-12 h-12 mb-2" />
                       <p className="text-xs font-bold uppercase tracking-widest">No Saved Queries</p>
                    </div>
                  )}
                  {savedQueries.length > 0 && savedQueries.filter(q => q.name.toLowerCase().includes(savedSearch.toLowerCase()) || q.query.toLowerCase().includes(savedSearch.toLowerCase())).length === 0 && (
                    <div className="text-center py-10 opacity-40">
                      <p className="text-[11px]">No results for "{savedSearch}"</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Main area */}
          <div className="flex-1 flex flex-col overflow-hidden bg-[var(--surface-base)]">
            <div className="p-4 flex flex-col gap-3 border-b border-[var(--neutral-6)] bg-[var(--surface-elevated)] shrink-0">
               <div className="h-40 relative rounded-xl border border-[var(--neutral-6)] overflow-hidden shadow-inner bg-[var(--surface-base)]"><QueryEditor value={query} onChange={setQuery} onRun={executeQuery} /></div>
               <Button
                 variant="primary"
                 size="md"
                 className="w-full"
                 onClick={executeQuery}
                 loading={isExecuting}
                 disabled={!query.trim() || selectedTargets.length === 0}
                 leftIcon={isExecuting ? undefined : <Play className="w-4 h-4 fill-current" />}
               >
                 {isExecuting ? `Executing SQL on ${selectedTargets.length} Nodes...` : `Execute SQL on ${selectedTargets.length} Nodes`}
               </Button>
            </div>
            <div className="flex-1 flex flex-col overflow-hidden">
               {results.length > 0 ? (<>
                  <div className="flex items-center bg-[var(--surface-elevated)] border-b border-[var(--neutral-6)] shrink-0 overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
                    <button onClick={() => { setShowMerged(false); setActiveTab(0); }} className={`px-4 py-3 text-[11px] font-bold border-r border-[var(--neutral-6)] transition-all ${!showMerged && activeTab === 0 ? "bg-[var(--surface-base)] text-[var(--accent-11)] border-b-2 border-[var(--accent-9)]" : "opacity-60 hover:opacity-100"}`}>CLUSTER OUTPUT</button>
                    <button onClick={() => { setShowMerged(true); setActiveTab(0); }} className={`px-4 py-3 text-[11px] font-bold border-r border-[var(--neutral-6)] transition-all ${showMerged ? "bg-[var(--surface-base)] text-[var(--success-11)] border-b-2 border-[var(--success-9)]" : "opacity-60 hover:opacity-100"}`}>AGGREGATE RESULT</button>
                    {!showMerged && results.map((r, i) => {
                      const isActive = !showMerged && activeTab === i;
                      const hasError = r.error;
                      return (
                        <button
                          key={`${r.connectionId}-${r.databaseName}`}
                          onClick={() => { setActiveTab(i); setShowMerged(false); }}
                          className={`px-4 py-3 text-[11px] font-bold border-r border-[var(--neutral-6)] whitespace-nowrap transition-all flex items-center gap-2 ${isActive ? "bg-[var(--surface-base)] text-[var(--accent-11)] border-b-2 border-[var(--accent-9)]" : "opacity-60 hover:opacity-100"}`}
                        >
                          <span className="max-w-[100px] truncate">{r.connectionName}</span>
                          <span className="opacity-20 mx-1">/</span>
                          <span className="max-w-[100px] truncate">{r.databaseName}</span>
                          {hasError && <AlertCircle className="w-3 h-3 text-[var(--danger-11)]" />}
                          {r.status === 'done' && !hasError && <CheckCircle className="w-3 h-3 text-[var(--success-11)]" />}
                          {r.status === 'running' && <Loader2 className="w-3 h-3 text-[var(--warning-11)] animate-spin" />}
                        </button>
                      );
                    })}
                  </div>
                 <div className="flex items-center gap-2 px-4 py-2 bg-[var(--surface-elevated)] border-b border-[var(--neutral-6)] text-[10px]">
                    <span className="font-bold text-[var(--neutral-11)] opacity-80">{sortedRows.length} rows retrieved</span>
                    <div className="flex-1" />
                    <div className="flex items-center bg-[var(--surface-base)] border border-[var(--neutral-7)] rounded-md px-1.5 py-0.5 shadow-sm">
                      <Search className="w-3 h-3 opacity-30 mr-1.5" />
                      <input
                        type="text"
                        placeholder="Jump to column..."
                        list="mq-column-list"
                        value={columnSearch}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const idx = columns.findIndex(c => c.toLowerCase() === columnSearch.toLowerCase());
                            if (idx >= 0) {
                              setGridSelection({
                                columns: CompactSelection.empty(),
                                rows: CompactSelection.empty(),
                                current: { cell: [idx, 0], range: { x: idx, y: 0, width: 1, height: 1 }, rangeStack: [] }
                              });
                              setTimeout(() => { gridRef.current?.scrollToColumn(idx); gridRef.current?.focus(); }, 10);
                            }
                          }
                        }}
                        onChange={(e) => {
                          const val = e.target.value;
                          setColumnSearch(val);
                          // Only jump automatically if it's an exact match from the list
                          if (columns.includes(val)) {
                            const idx = columns.indexOf(val);
                            setGridSelection({
                              columns: CompactSelection.empty(),
                              rows: CompactSelection.empty(),
                              current: { cell: [idx, 0], range: { x: idx, y: 0, width: 1, height: 1 }, rangeStack: [] }
                            });
                            setTimeout(() => { gridRef.current?.scrollToColumn(idx); gridRef.current?.focus(); }, 10);
                          }
                        }}
                        className="bg-transparent outline-none w-32 text-[10px]"
                      />
                      <datalist id="mq-column-list">
                        {columns.map(c => <option key={c} value={c} />)}
                      </datalist>
                    </div>
                    <div className="w-44">
                      <Select
                        selectSize="sm"
                        placeholder="Jump To Column..."
                        value={selectedJumpCol}
                        onValueChange={(val) => {
                          setSelectedJumpCol(val);
                          const v = parseInt(val);
                          if (!isNaN(v)) {
                            setGridSelection({
                              columns: CompactSelection.empty(),
                              rows: CompactSelection.empty(),
                              current: {
                                  cell: [v, 0],
                                  range: { x: v, y: 0, width: 1, height: 1 },
                                  rangeStack: []
                              }
                            });
                            setTimeout(() => {
                              gridRef.current?.scrollToColumn(v);
                              gridRef.current?.focus();
                            }, 10);
                          }
                        }}
                        options={columns.map((c, i) => ({ label: c, value: i.toString() }))}
                      />
                    </div>
                    <div className="h-4 w-px bg-[var(--neutral-6)] mx-2" />
                    <div className="flex items-center gap-1">
                        {settings.enabledExportFormats.includes("csv") && (
                          <button onClick={() => exportData("csv")} className="p-1.5 hover:text-[var(--accent-11)] opacity-70 hover:opacity-100 transition-opacity" title="Export CSV"><Download className="w-3.5 h-3.5" /></button>
                        )}
                        {settings.enabledExportFormats.includes("json") && (
                          <button onClick={() => exportData("json")} className="p-1.5 hover:text-[var(--accent-11)] opacity-70 hover:opacity-100 transition-opacity" title="Export JSON"><FileJson className="w-3.5 h-3.5" /></button>
                        )}
                        {settings.enabledExportFormats.includes("xml") && (
                          <button onClick={() => exportData("xml")} className="p-1.5 hover:text-[var(--accent-11)] opacity-70 hover:opacity-100 transition-opacity" title="Export XML"><FileCode className="w-3.5 h-3.5" /></button>
                        )}
                        {settings.enabledExportFormats.includes("html") && (
                          <button onClick={() => exportData("html")} className="p-1.5 hover:text-[var(--accent-11)] opacity-70 hover:opacity-100 transition-opacity" title="Export HTML"><Globe className="w-3.5 h-3.5" /></button>
                        )}
                        {settings.enabledExportFormats.includes("sql") && (
                          <button onClick={() => exportData("sql")} className="p-1.5 hover:text-[var(--accent-11)] opacity-70 hover:opacity-100 transition-opacity" title="Export SQL Insert"><Database className="w-3.5 h-3.5" /></button>
                        )}
                    </div>
                 </div>
                  <div className="flex-1 relative min-h-0 bg-[var(--surface-base)]">
                    {/* Context Menu */}
                    {contextMenu && (
                      <Menu x={contextMenu.x} y={contextMenu.y} className="z-[500]">
                        <MenuLabel bordered>Selection Actions</MenuLabel>
                        {contextMenu.col && (
                          <MenuItem icon={<Copy className="w-3.5 h-3.5" />} onClick={() => { copyToClipboard(String(contextMenu.row[contextMenu.col!] || "")); setContextMenu(null); }}>
                            Copy Cell
                          </MenuItem>
                        )}
                        <MenuItem icon={<FileJson className="w-3.5 h-3.5" />} onClick={() => { copyToClipboard(JSON.stringify(contextMenu.row, null, 2)); setContextMenu(null); }}>
                          Copy Row as JSON
                        </MenuItem>
                        <MenuSeparator />

                        <MenuSub icon={<Database className="w-3.5 h-3.5" />} label="Generate SQL">
                          <MenuLabel bordered subtle>Output Format</MenuLabel>
                          <MenuItem tone="success" icon={<Database className="w-3.5 h-3.5" />} onClick={() => generateSqlForSelected("INSERT")}>SQL INSERTs</MenuItem>
                          <MenuItem tone="warning" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => generateSqlForSelected("UPDATE")}>SQL UPDATEs</MenuItem>
                          <MenuItem tone="danger" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => generateSqlForSelected("DELETE")}>SQL DELETEs</MenuItem>
                        </MenuSub>
                      </Menu>
                    )}
                    {currentResult?.error ? (
                      <div className="p-10 text-center"><AlertCircle className="w-12 h-12 text-[var(--danger-9)] mx-auto mb-4 opacity-50" /><h3 className="font-bold text-[var(--danger-11)] mb-2">Remote Execution Error</h3><pre className="text-xs text-[var(--danger-11)] opacity-80 whitespace-pre-wrap font-mono bg-[var(--danger-3)] p-4 rounded-xl border border-[var(--danger-6)]">{currentResult.error}</pre></div>
                    ) : (
                      <GridView
                        ref={gridRef}
                        data={sortedRows}
                        columns={columns}
                        rowMarkers="both"
                        gridSelection={gridSelection}
                        onGridSelectionChange={setGridSelection}
                        onHeaderClicked={(idx) => {
                          const c = columns[idx];
                          if (sortCol === c) setSortDir(sortDir === "asc" ? "desc" : sortDir === "desc" ? null : "asc");
                          else { setSortCol(c); setSortDir("asc"); }
                        }}
                        onCellContextMenu={(rowIdx, colIdx, pos) => {
                          setContextMenu({ x: pos.clientX, y: pos.clientY, row: sortedRows[rowIdx], col: columns[colIdx] });
                        }}
                        columnWidths={columnWidths}
                        onColumnResized={(c, w) => setColumnWidths(prev => ({ ...prev, [c]: w }))}
                      />
                    )}
                  </div>
               </>) : (<div className="flex-1 flex flex-col items-center justify-center opacity-10 select-none"><Layers className="w-24 h-24 mb-4" /><p className="text-lg font-bold tracking-tight">Synchronized Query Engine Offline</p><p className="text-xs">Select cluster nodes and execute SQL commands to begin.</p></div>)}
            </div>
          </div>
        </div>
        {error && (<div className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-lg bg-[var(--danger-9)] shadow-2xl text-white px-6 py-4 rounded-2xl text-sm font-bold flex items-center gap-3 animate-in slide-in-from-bottom duration-300 z-[100]"><AlertCircle className="w-5 h-5 shrink-0" /><span className="flex-1 leading-tight">{error}</span><button onClick={() => setError(null)} className="p-1 hover:bg-white/10 rounded-lg"><X className="w-5 h-5" /></button></div>)}
        {showToast && (<div className="absolute bottom-6 right-6 bg-[var(--accent-9)] text-white px-6 py-3 rounded-2xl shadow-2xl text-xs font-bold z-[600] animate-in slide-in-from-right flex items-center gap-2"><CheckCircle className="w-4 h-4" />{toastMessage}</div>)}

        {/* Tooltip for hovered status */}
        {hoveredStatus && (
          <div className="absolute z-[200] bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-xl shadow-xl p-3 min-w-[200px] animate-in fade-in zoom-in-95 duration-200"
               style={{ bottom: 'auto', left: '320px', top: '50%', transform: 'translateY(-50%)' }}>
            <div className="flex items-center gap-2 mb-2">
              {hoveredStatus.result.status === 'running' && <Loader2 className="w-4 h-4 text-[var(--warning-11)] animate-spin" />}
              {hoveredStatus.result.status === 'done' && <CheckCircle className="w-4 h-4 text-[var(--success-11)]" />}
              {hoveredStatus.result.status === 'error' && <AlertCircle className="w-4 h-4 text-[var(--danger-11)]" />}
              <span className="text-xs font-bold text-[var(--neutral-12)]">
                {hoveredStatus.result.connectionName} / {hoveredStatus.db}
              </span>
            </div>
            <div className="text-[10px] text-[var(--neutral-11)] space-y-1">
              {hoveredStatus.result.status === 'running' && <p>Query is being executed...</p>}
              {hoveredStatus.result.status === 'done' && (
                <>
                  <p className="flex items-center gap-1"><Clock className="w-3 h-3" /> Duration: {hoveredStatus.result.duration}ms</p>
                  <p className="flex items-center gap-1"><Table2 className="w-3 h-3" /> Rows: {hoveredStatus.result.rowsAffected}</p>
                </>
              )}
              {hoveredStatus.result.status === 'error' && (
                <p className="text-[var(--danger-11)] flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Click for details</p>
              )}
            </div>
            <p className="text-[9px] text-[var(--neutral-11)] mt-2 pt-2 border-t border-[var(--neutral-6)]">Click for full details</p>
          </div>
        )}
      </Dialog>

      {/* Detailed status information modal */}
      {statusDetailModal && (
        <Dialog open={!!statusDetailModal} onClose={() => setStatusDetailModal(null)} className="w-[500px] max-w-[95vw] max-h-[80vh]">
          <Dialog.Title onClose={() => setStatusDetailModal(null)}>
            <span className="flex items-center gap-3">
              {statusDetailModal.status === 'running' && <Loader2 className="w-5 h-5 text-[var(--warning-11)] animate-spin" />}
              {statusDetailModal.status === 'done' && <CheckCircle className="w-5 h-5 text-[var(--success-11)]" />}
              {statusDetailModal.status === 'error' && <AlertCircle className="w-5 h-5 text-[var(--danger-11)]" />}
              <span className="flex flex-col leading-tight">
                <span>
                  {statusDetailModal.status === 'running' ? 'Query Running' :
                   statusDetailModal.status === 'done' ? 'Query Completed' : 'Query Error'}
                </span>
                <span className="text-[10px] font-normal text-[var(--neutral-11)]">
                  {statusDetailModal.connectionName} / {statusDetailModal.databaseName}
                </span>
              </span>
            </span>
          </Dialog.Title>

          <Dialog.Body className="space-y-4">
            {/* Execution Info Section */}
            <div className="bg-[var(--surface-base)] rounded-xl p-4 border border-[var(--neutral-6)]">
              <h4 className="text-[11px] font-bold text-[var(--neutral-11)] uppercase tracking-wider mb-3 flex items-center gap-2">
                <Info className="w-4 h-4" /> Execution Details
              </h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[var(--surface-elevated)] rounded-lg p-3 border border-[var(--neutral-6)]">
                  <span className="text-[10px] text-[var(--neutral-11)] block mb-1">Status</span>
                  <span className={`text-xs font-bold ${
                    statusDetailModal.status === 'done' ? 'text-[var(--success-11)]' :
                    statusDetailModal.status === 'error' ? 'text-[var(--danger-11)]' : 'text-[var(--warning-11)]'
                  }`}>
                    {statusDetailModal.status?.toUpperCase()}
                  </span>
                </div>
                <div className="bg-[var(--surface-elevated)] rounded-lg p-3 border border-[var(--neutral-6)]">
                  <span className="text-[10px] text-[var(--neutral-11)] block mb-1">Duration</span>
                  <span className="text-xs font-bold text-[var(--neutral-12)] flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {statusDetailModal.duration}ms
                  </span>
                </div>
                {statusDetailModal.status !== 'error' && (
                  <div className="bg-[var(--surface-elevated)] rounded-lg p-3 border border-[var(--neutral-6)]">
                    <span className="text-[10px] text-[var(--neutral-11)] block mb-1">Rows Affected</span>
                    <span className="text-xs font-bold text-[var(--neutral-12)] flex items-center gap-1">
                      <Table2 className="w-3 h-3" /> {statusDetailModal.rowsAffected}
                    </span>
                  </div>
                )}
                <div className="bg-[var(--surface-elevated)] rounded-lg p-3 border border-[var(--neutral-6)]">
                  <span className="text-[10px] text-[var(--neutral-11)] block mb-1">Columns</span>
                  <span className="text-xs font-bold text-[var(--neutral-12)]">{statusDetailModal.columns.length}</span>
                </div>
              </div>
            </div>

            {/* Error Section - only show if there's an error */}
            {statusDetailModal.error && (
              <div className="bg-[var(--danger-3)] rounded-xl p-4 border border-[var(--danger-6)]">
                <h4 className="text-[11px] font-bold text-[var(--danger-11)] uppercase tracking-wider mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> Error Details
                </h4>
                <div className="space-y-3">
                  <div className="bg-[var(--danger-3)] rounded-lg p-3 border border-[var(--danger-6)]">
                    <span className="text-[10px] text-[var(--danger-11)] opacity-60 block mb-1">Error Message</span>
                    <pre className="text-xs font-mono text-[var(--danger-11)] whitespace-pre-wrap">{statusDetailModal.error}</pre>
                  </div>
                  {/* Check for additional error properties like stack trace */}
                  {(statusDetailModal.error as any)?.stack && (
                    <div className="bg-[var(--danger-3)] rounded-lg p-3 border border-[var(--danger-6)]">
                      <span className="text-[10px] text-[var(--danger-11)] opacity-60 block mb-1">Stack Trace</span>
                      <pre className="text-[10px] font-mono text-[var(--danger-11)] opacity-80 whitespace-pre-wrap max-h-32 overflow-y-auto">{(statusDetailModal.error as any).stack}</pre>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Success/Warnings Section */}
            {statusDetailModal.status === 'done' && (
              <div className="bg-[var(--success-3)] rounded-xl p-4 border border-[var(--success-6)]">
                <h4 className="text-[11px] font-bold text-[var(--success-11)] uppercase tracking-wider mb-3 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4" /> Query Result Summary
                </h4>
                <p className="text-xs text-[var(--success-11)] opacity-80">
                  Query executed successfully on {statusDetailModal.databaseName} database.
                  {statusDetailModal.rowsAffected > 0
                    ? ` Returned ${statusDetailModal.rowsAffected} rows with ${statusDetailModal.columns.length} columns.`
                    : ' No rows returned (possibly an UPDATE/DELETE operation).'}
                </p>
                {statusDetailModal.columns.length > 0 && (
                  <div className="mt-3">
                    <span className="text-[10px] text-[var(--success-11)] opacity-60 block mb-2">Columns in result:</span>
                    <div className="flex flex-wrap gap-1">
                      {statusDetailModal.columns.map((col, i) => (
                        <span key={i} className="text-[10px] px-2 py-1 bg-[var(--success-3)] text-[var(--success-11)] rounded-md font-medium">
                          {col}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Dialog.Body>

          <Dialog.Footer>
            <Button variant="secondary" size="md" onClick={() => setStatusDetailModal(null)}>
              Close
            </Button>
          </Dialog.Footer>
        </Dialog>
      )}
    </>
  );
}
