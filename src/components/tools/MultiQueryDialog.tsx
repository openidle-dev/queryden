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
      const port = conn.port || (conn.type === "mysql" || conn.type === "mariadb" ? 3306 : 5432);
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
      // Split by semicolon, being mindful that this is a simple split
      statementsToRun = queryToRun.split(';').map(s => s.trim()).filter(s => s.length > 0);
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
    
    const isSelectQuery = (stmt: string) => {
      const s = stmt.toUpperCase().trim();
      return s.startsWith("SELECT") || s.startsWith("WITH") || s.startsWith("SHOW") || 
             s.startsWith("DESCRIBE") || s.startsWith("EXPLAIN") || s.includes("RETURNING");
    };

    for (const target of selectedTargets) {
      const conn = connections.find(c => c.id === target.connectionId);
      if (!conn) continue;
      const startTime = Date.now();
      
      try {
        let username = conn.username || "", password = conn.password || "";
        if (conn.vaultCredentialId) { const vaultCred = vaultCredentials.find(vc => vc.id === conn.vaultCredentialId); if (vaultCred) { username = vaultCred.username || ""; password = vaultCred.password || ""; } }
        
        const Database = (await import("@tauri-apps/plugin-sql")).default;
        const port = conn.port || (conn.type === "mysql" || conn.type === "mariadb" ? 3306 : 5432);
        const connectionString = conn.type === "sqlite" ? `sqlite:${conn.filepath || "dbman.sqlite"}` :
          ["postgres", "supabase", "cockroach"].includes(conn.type) ? `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${conn.host}:${port}/${target.database}` :
          `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${conn.host}:${port}/${target.database}`;
        
        const db = await Database.load(connectionString);
        
        let lastRows: any[] = [];
        let lastCols: string[] = [];
        let totalAffected = 0;
        
        // Execute each statement sequentially
        for (const stmt of statementsToRun) {
          if (isSelectQuery(stmt)) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-[95vw] h-[90vh] bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header - Enhanced Visual Design */}
        <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-[var(--surface)] to-[var(--background)] border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-4">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-xl text-[var(--text-primary)] tracking-tight">Multi-Query Cluster</h2>
              <div className="flex items-center gap-4 text-[10px] mt-0.5">
                <span className="flex items-center gap-1 text-indigo-400 font-bold">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                  {selectedTargets.length} targets selected
                </span>
                {results.length > 0 && (
                  <span className="flex items-center gap-1 text-emerald-400 font-bold">
                    <CheckCircle className="w-3 h-3" />
                    {results.filter(r => !r.error).length} successful
                  </span>
                )}
                {results.some(r => r.error) && (
                  <span className="flex items-center gap-1 text-red-400 font-bold">
                    <AlertCircle className="w-3 h-3" />
                    {results.filter(r => r.error).length} errors
                  </span>
                )}
                {isExecuting && (
                  <span className="flex items-center gap-1 text-amber-400 animate-pulse">
                    <Loader2 className="w-3 h-3" />
                    Executing SQL...
                  </span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-red-500/10 hover:text-red-500 rounded-full transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar - Enhanced */}
          <div className="w-80 border-r border-[var(--border)] flex flex-col bg-[var(--surface)] shrink-0">
            {/* Sidebar Tabs */}
            <div className="flex border-b border-[var(--border)] bg-[var(--surface-raised)]">
              <button 
                onClick={() => setSidebarTab("targets")}
                className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-all border-b-2 flex items-center justify-center gap-2 ${sidebarTab === "targets" ? "text-indigo-400 border-indigo-400 bg-[var(--background)]/50" : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--border)]/10"}`}
              >
                <Database className="w-3.5 h-3.5" />
                Nodes
              </button>
              <button 
                onClick={() => setSidebarTab("saved")}
                className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-all border-b-2 flex items-center justify-center gap-2 ${sidebarTab === "saved" ? "text-indigo-400 border-indigo-400 bg-[var(--background)]/50" : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--border)]/10"}`}
              >
                <Star className="w-3.5 h-3.5" />
                Saved Queries
              </button>
            </div>

            {sidebarTab === "targets" ? (
              <div className="p-4 border-b border-[var(--border)] flex justify-between items-center bg-[var(--surface-raised)]">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-indigo-400" />
                  <span className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">Sync Group</span>
                </div>
                <button
                  onClick={toggleSelectAll}
                  className="px-3 py-1.5 rounded-lg text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 transition-all"
                >
                  {selectedTargets.length ? "Clear All" : "Select All"}
                </button>
              </div>
            ) : (
              <div className="p-3 border-b border-[var(--border)] bg-[var(--surface-raised)]">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <input
                    type="text"
                    placeholder="Search library..."
                    value={savedSearch}
                    onChange={(e) => setSavedSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-[11px] rounded-lg bg-[var(--background)] border border-[var(--border)] outline-none focus:border-indigo-500/50 transition-all"
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
                      <div className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-[var(--border)]/30 group bg-[var(--surface-raised)] border border-[var(--border)]">
                        <button
                          onClick={() => { setExpandedConnections(prev => { const n = new Set(prev); if (n.has(conn.id)) n.delete(conn.id); else { n.add(conn.id); loadDatabasesForConnection(conn.id); } return n; }); }}
                          className="p-1 rounded hover:bg-[var(--border)] transition-colors"
                        >
                          {isExp ? <ChevronDown className="w-4 h-4 text-indigo-400" /> : <ChevronRight className="w-4 h-4 text-indigo-400" />}
                        </button>
                        <div onClick={() => toggleConnAll(conn)} className={`flex-1 flex items-center gap-3 cursor-pointer`}>
                          <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                            count === (availableDatabases[conn.id] || [conn.database]).length
                              ? "bg-indigo-500 border-indigo-500 text-white"
                              : count > 0
                              ? "bg-indigo-500/30 border-indigo-500 text-indigo-400"
                              : "border-[var(--border)]"
                          }`}>
                            {count > 0 && <Check className="w-3 h-3" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-semibold truncate block">{conn.name}</span>
                            <span className="text-[9px] text-[var(--text-secondary)] truncate block">{conn.type} • {conn.host}</span>
                          </div>
                          {count > 0 && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 font-bold">
                              {count}
                            </span>
                          )}
                        </div>
                      </div>
                      {isExp && (
                        <div className="ml-4 pl-3 py-2 border-l-2 border-[var(--border)] space-y-1.5">
                          {(availableDatabases[conn.id] || [conn.database])?.map(db => {
                            const status = getTargetStatus(conn.id, db);
                            const result = results.find(r => r.connectionId === conn.id && r.databaseName === db);
                            return (
                              <div
                                key={db}
                                onClick={() => toggleTarget(conn.id, db)}
                                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all ${
                                  isTargetSelected(conn.id, db)
                                    ? "bg-indigo-500/15 text-indigo-400 border border-indigo-500/30"
                                    : "hover:bg-[var(--border)]/30 opacity-70 border border-transparent"
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
                                    <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                                  ) : status === 'done' ? (
                                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400 cursor-pointer hover:scale-110 transition-transform" />
                                  ) : status === 'error' ? (
                                    <AlertCircle className="w-3.5 h-3.5 text-red-500 cursor-pointer hover:scale-110 transition-transform" />
                                  ) : (
                                    <div className={`w-3.5 h-3.5 rounded-md border-2 ${
                                      isTargetSelected(conn.id, db)
                                        ? "bg-indigo-500 border-indigo-500"
                                        : "border-[var(--border)]"
                                    }`} />
                                  )}
                                </div>
                                <Folder className={`w-4 h-4 ${isTargetSelected(conn.id, db) ? "text-indigo-400" : "text-amber-500/60"}`} />
                                <span className="text-[11px] truncate flex-1 font-medium">{db}</span>
                                {status && (
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold cursor-pointer hover:scale-105 transition-transform ${
                                    status === 'done' ? "bg-emerald-500/20 text-emerald-400" :
                                    status === 'error' ? "bg-red-500/20 text-red-400" :
                                    "bg-amber-500/20 text-amber-400"
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
                        className="p-3 rounded-xl bg-[var(--surface-raised)] border border-[var(--border)] hover:border-indigo-500/50 hover:bg-indigo-500/5 cursor-pointer group transition-all"
                        title="Click to load this query"
                      >
                         <div className="flex items-center justify-between mb-1">
                           <span className="text-[11px] font-bold text-[var(--text-primary)] group-hover:text-indigo-400 transition-colors uppercase tracking-tight truncate mr-2">{q.name}</span>
                           <span className="text-[9px] opacity-40 italic shrink-0">{new Date(q.createdAt).toLocaleDateString()}</span>
                         </div>
                         <div className="text-[10px] text-[var(--text-secondary)] font-mono line-clamp-2 opacity-60 bg-[var(--background)]/50 p-1.5 rounded-md border border-[var(--border)]/50">
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
          <div className="flex-1 flex flex-col overflow-hidden bg-[var(--background)]">
            <div className="p-4 flex flex-col gap-3 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
               <div className="h-40 relative rounded-xl border border-[var(--border)] overflow-hidden shadow-inner bg-[var(--background)]"><QueryEditor value={query} onChange={setQuery} onRun={executeQuery} /></div>
               <button onClick={executeQuery} disabled={!query.trim() || selectedTargets.length === 0 || isExecuting} className={`w-full py-2.5 rounded-xl font-bold text-xs uppercase shadow-lg transition-all flex items-center justify-center gap-2 ${!query.trim() || selectedTargets.length === 0 || isExecuting ? "bg-[var(--border)] opacity-50 cursor-not-allowed" : "bg-gradient-to-r from-indigo-500 to-indigo-600 text-white hover:scale-[1.01] active:scale-[0.99] shadow-indigo-500/20"}`}>{isExecuting ? <><Loader2 className="w-4 h-4 animate-spin" />Executing SQL on {selectedTargets.length} Nodes...</> : <><Play className="w-4 h-4 fill-current" />Execute SQL on {selectedTargets.length} Nodes</>}</button>
            </div>
            <div className="flex-1 flex flex-col overflow-hidden">
               {results.length > 0 ? (<>
{/* IMPROVEMENT 2: Cluster Output Scrollbar - visible horizontal scrollbar */}
                  <div className="flex items-center bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--text-secondary) transparent' }}>
                    <button onClick={() => { setShowMerged(false); setActiveTab(0); }} className={`px-4 py-3 text-[11px] font-bold border-r border-[var(--border)] transition-all ${!showMerged && activeTab === 0 ? "bg-[var(--background)] text-indigo-400 border-b-2 border-indigo-400" : "opacity-60 hover:opacity-100"}`}>CLUSTER OUTPUT</button>
                    <button onClick={() => { setShowMerged(true); setActiveTab(0); }} className={`px-4 py-3 text-[11px] font-bold border-r border-[var(--border)] transition-all ${showMerged ? "bg-[var(--background)] text-emerald-400 border-b-2 border-emerald-400" : "opacity-60 hover:opacity-100"}`}>AGGREGATE RESULT</button>
                    {!showMerged && results.map((r, i) => {
                      const isActive = !showMerged && activeTab === i;
                      const hasError = r.error;
                      return (
                        <button 
                          key={`${r.connectionId}-${r.databaseName}`} 
                          onClick={() => { setActiveTab(i); setShowMerged(false); }} 
                          className={`px-4 py-3 text-[11px] font-bold border-r border-[var(--border)] whitespace-nowrap transition-all flex items-center gap-2 ${isActive ? "bg-[var(--background)] text-indigo-400 border-b-2 border-indigo-400" : "opacity-60 hover:opacity-100"}`}
                        >
                          <span className="max-w-[100px] truncate">{r.connectionName}</span> 
                          <span className="opacity-20 mx-1">/</span> 
                          <span className="max-w-[100px] truncate">{r.databaseName}</span>
                          {hasError && <AlertCircle className="w-3 h-3 text-red-400" />}
                          {r.status === 'done' && !hasError && <CheckCircle className="w-3 h-3 text-emerald-400" />}
                          {r.status === 'running' && <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />}
                        </button>
                      );
                    })}
                  </div>
                 <div className="flex items-center gap-2 px-4 py-2 bg-[var(--surface)] border-b border-[var(--border)] text-[10px]">
                    <span className="font-bold text-[var(--text-secondary)] opacity-80">{sortedRows.length} rows retrieved</span>
                    <div className="flex-1" />
                    <div className="flex items-center bg-[var(--background)] border border-[var(--border)] rounded-md px-1.5 py-0.5 shadow-sm">
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
                    <select 
                      value={selectedJumpCol}
                      onChange={(e) => { 
                        const val = e.target.value;
                        setSelectedJumpCol(val);
                        const v = parseInt(val); 
                        if (!isNaN(v)) {
                          // Visual selection feedback
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
                      className="bg-[var(--background)] border border-[var(--border)] rounded-md px-2 py-0.5 outline-none text-[10px] shadow-sm cursor-pointer hover:border-indigo-400"
                    >
                      <option value="" disabled>Jump To Column...</option>
                      {columns.map((c, i) => <option key={c} value={i.toString()}>{c}</option>)}
                    </select>
                    <div className="h-4 w-px bg-[var(--border)] mx-2" />
                    <div className="flex items-center gap-1">
                        {settings.enabledExportFormats.includes("csv") && (
                          <button onClick={() => exportData("csv")} className="p-1.5 hover:text-emerald-400 opacity-70 hover:opacity-100 transition-opacity" title="Export CSV"><Download className="w-3.5 h-3.5" /></button>
                        )}
                        {settings.enabledExportFormats.includes("json") && (
                          <button onClick={() => exportData("json")} className="p-1.5 hover:text-amber-400 opacity-70 hover:opacity-100 transition-opacity" title="Export JSON"><FileJson className="w-3.5 h-3.5" /></button>
                        )}
                        {settings.enabledExportFormats.includes("xml") && (
                          <button onClick={() => exportData("xml")} className="p-1.5 hover:text-blue-400 opacity-70 hover:opacity-100 transition-opacity" title="Export XML"><FileCode className="w-3.5 h-3.5" /></button>
                        )}
                        {settings.enabledExportFormats.includes("html") && (
                          <button onClick={() => exportData("html")} className="p-1.5 hover:text-orange-400 opacity-70 hover:opacity-100 transition-opacity" title="Export HTML"><Globe className="w-3.5 h-3.5" /></button>
                        )}
                        {settings.enabledExportFormats.includes("sql") && (
                          <button onClick={() => exportData("sql")} className="p-1.5 hover:text-cyan-400 opacity-70 hover:opacity-100 transition-opacity" title="Export SQL Insert"><Database className="w-3.5 h-3.5" /></button>
                        )}
                    </div>
                 </div>
                  <div className="flex-1 relative min-h-0 bg-[var(--background)]">
                    {/* Context Menu */}
                    {contextMenu && (
                      <div 
                        className="fixed z-[500] w-56 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl py-1.5 animate-in zoom-in-95 duration-100" 
                        style={{ top: contextMenu.y, left: contextMenu.x }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="px-3 py-1 text-[9px] uppercase font-bold text-[var(--text-secondary)] tracking-widest mb-1 border-b border-[var(--border)] pb-1">Selection Actions</div>
                        {contextMenu.col && (
                          <button 
                            onClick={() => { copyToClipboard(String(contextMenu.row[contextMenu.col!] || "")); setContextMenu(null); }} 
                            className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-indigo-500 hover:text-white flex items-center gap-2 transition-colors"
                          >
                            <Copy className="w-3.5 h-3.5" /> Copy Cell
                          </button>
                        )}
                        <button 
                          onClick={() => { copyToClipboard(JSON.stringify(contextMenu.row, null, 2)); setContextMenu(null); }} 
                          className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-indigo-500 hover:text-white flex items-center gap-2 transition-colors"
                        >
                          <FileJson className="w-3.5 h-3.5" /> Copy Row as JSON
                        </button>
                        <div className="my-1 border-t border-[var(--border)] opacity-50" />
                        
                        <div className="relative group/sql">
                          <button className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-indigo-500 hover:text-white flex items-center justify-between transition-colors">
                            <div className="flex items-center gap-2"><Database className="w-3.5 h-3.5" /> Generate SQL</div>
                            <ChevronRight className="w-3 h-3 opacity-50" />
                          </button>
                          <div className="hidden group-hover/sql:block absolute left-[calc(100%-8px)] top-0 w-48 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl py-1.5 animate-in slide-in-from-left-1 duration-150">
                             <div className="px-3 py-1 text-[9px] uppercase font-bold text-[var(--text-secondary)] tracking-widest mb-1 border-b border-[var(--border)] pb-1 opacity-60">Output Format</div>
                             <button 
                                onClick={() => generateSqlForSelected("INSERT")} 
                                className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-emerald-500 hover:text-white flex items-center gap-2 transition-colors"
                              >
                                <Database className="w-3.5 h-3.5" /> SQL INSERTs
                              </button>
                              <button 
                                onClick={() => generateSqlForSelected("UPDATE")} 
                                className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-amber-500 hover:text-white flex items-center gap-2 transition-colors"
                              >
                                <RefreshCw className="w-3.5 h-3.5" /> SQL UPDATEs
                              </button>
                              <button 
                                onClick={() => generateSqlForSelected("DELETE")} 
                                className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-red-500 hover:text-white flex items-center gap-2 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> SQL DELETEs
                              </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {currentResult?.error ? (
                      <div className="p-10 text-center"><AlertCircle className="w-12 h-12 text-rose-500 mx-auto mb-4 opacity-50" /><h3 className="font-bold text-rose-400 mb-2">Remote Execution Error</h3><pre className="text-xs text-rose-400/80 whitespace-pre-wrap font-mono bg-rose-500/5 p-4 rounded-xl border border-rose-500/20">{currentResult.error}</pre></div>
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
                        onCellContextMenu={(rowIdx, colIdx, e) => {
                          e.preventDefault();
                          setContextMenu({ x: e.pageX, y: e.pageY, row: sortedRows[rowIdx], col: columns[colIdx] });
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
        {error && (<div className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-lg bg-rose-600 shadow-2xl shadow-rose-900/40 text-white px-6 py-4 rounded-2xl text-sm font-bold flex items-center gap-3 animate-in slide-in-from-bottom duration-300 z-[100]"><AlertCircle className="w-5 h-5 shrink-0" /><span className="flex-1 leading-tight">{error}</span><button onClick={() => setError(null)} className="p-1 hover:bg-white/10 rounded-lg"><X className="w-5 h-5" /></button></div>)}
        {showToast && (<div className="absolute bottom-6 right-6 bg-indigo-600 text-white px-6 py-3 rounded-2xl shadow-2xl text-xs font-bold z-[600] animate-in slide-in-from-right flex items-center gap-2"><CheckCircle className="w-4 h-4" />{toastMessage}</div>)}
        
        {/* IMPROVEMENT 3: Tooltip for hovered status */}
        {hoveredStatus && (
          <div className="absolute z-[200] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl p-3 min-w-[200px] animate-in fade-in zoom-in-95 duration-200"
               style={{ bottom: 'auto', left: '320px', top: '50%', transform: 'translateY(-50%)' }}>
            <div className="flex items-center gap-2 mb-2">
              {hoveredStatus.result.status === 'running' && <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />}
              {hoveredStatus.result.status === 'done' && <CheckCircle className="w-4 h-4 text-emerald-400" />}
              {hoveredStatus.result.status === 'error' && <AlertCircle className="w-4 h-4 text-red-400" />}
              <span className="text-xs font-bold text-[var(--text-primary)]">
                {hoveredStatus.result.connectionName} / {hoveredStatus.db}
              </span>
            </div>
            <div className="text-[10px] text-[var(--text-secondary)] space-y-1">
              {hoveredStatus.result.status === 'running' && <p>Query is being executed...</p>}
              {hoveredStatus.result.status === 'done' && (
                <>
                  <p className="flex items-center gap-1"><Clock className="w-3 h-3" /> Duration: {hoveredStatus.result.duration}ms</p>
                  <p className="flex items-center gap-1"><Table2 className="w-3 h-3" /> Rows: {hoveredStatus.result.rowsAffected}</p>
                </>
              )}
              {hoveredStatus.result.status === 'error' && (
                <p className="text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Click for details</p>
              )}
            </div>
            <p className="text-[9px] text-[var(--text-secondary)] mt-2 pt-2 border-t border-[var(--border)]">Click for full details</p>
          </div>
        )}

        {/* IMPROVEMENT 3: Modal for detailed status information */}
        {statusDetailModal && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={() => setStatusDetailModal(null)} />
            <div className="relative w-[500px] max-h-[80vh] bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-raised)]">
                <div className="flex items-center gap-3">
                  {statusDetailModal.status === 'running' && <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />}
                  {statusDetailModal.status === 'done' && <CheckCircle className="w-5 h-5 text-emerald-400" />}
                  {statusDetailModal.status === 'error' && <AlertCircle className="w-5 h-5 text-red-400" />}
                  <div>
                    <h3 className="font-bold text-[var(--text-primary)]">
                      {statusDetailModal.status === 'running' ? 'Query Running' : 
                       statusDetailModal.status === 'done' ? 'Query Completed' : 'Query Error'}
                    </h3>
                    <p className="text-[10px] text-[var(--text-secondary)]">
                      {statusDetailModal.connectionName} / {statusDetailModal.databaseName}
                    </p>
                  </div>
                </div>
                <button onClick={() => setStatusDetailModal(null)} className="p-2 hover:bg-[var(--border)] rounded-lg transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {/* Execution Info Section */}
                <div className="bg-[var(--background)] rounded-xl p-4 border border-[var(--border)]">
                  <h4 className="text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Info className="w-4 h-4" /> Execution Details
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--border)]">
                      <span className="text-[10px] text-[var(--text-secondary)] block mb-1">Status</span>
                      <span className={`text-xs font-bold ${
                        statusDetailModal.status === 'done' ? 'text-emerald-400' :
                        statusDetailModal.status === 'error' ? 'text-red-400' : 'text-amber-400'
                      }`}>
                        {statusDetailModal.status?.toUpperCase()}
                      </span>
                    </div>
                    <div className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--border)]">
                      <span className="text-[10px] text-[var(--text-secondary)] block mb-1">Duration</span>
                      <span className="text-xs font-bold text-[var(--text-primary)] flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {statusDetailModal.duration}ms
                      </span>
                    </div>
                    {statusDetailModal.status !== 'error' && (
                      <div className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--border)]">
                        <span className="text-[10px] text-[var(--text-secondary)] block mb-1">Rows Affected</span>
                        <span className="text-xs font-bold text-[var(--text-primary)] flex items-center gap-1">
                          <Table2 className="w-3 h-3" /> {statusDetailModal.rowsAffected}
                        </span>
                      </div>
                    )}
                    <div className="bg-[var(--surface)] rounded-lg p-3 border border-[var(--border)]">
                      <span className="text-[10px] text-[var(--text-secondary)] block mb-1">Columns</span>
                      <span className="text-xs font-bold text-[var(--text-primary)]">{statusDetailModal.columns.length}</span>
                    </div>
                  </div>
                </div>

                {/* Error Section - only show if there's an error */}
                {statusDetailModal.error && (
                  <div className="bg-rose-500/10 rounded-xl p-4 border border-rose-500/30">
                    <h4 className="text-[11px] font-bold text-rose-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4" /> Error Details
                    </h4>
                    <div className="space-y-3">
                      <div className="bg-rose-500/10 rounded-lg p-3 border border-rose-500/20">
                        <span className="text-[10px] text-rose-400/60 block mb-1">Error Message</span>
                        <pre className="text-xs font-mono text-rose-400 whitespace-pre-wrap">{statusDetailModal.error}</pre>
                      </div>
                      {/* Check for additional error properties like stack trace */}
                      {(statusDetailModal.error as any)?.stack && (
                        <div className="bg-rose-500/10 rounded-lg p-3 border border-rose-500/20">
                          <span className="text-[10px] text-rose-400/60 block mb-1">Stack Trace</span>
                          <pre className="text-[10px] font-mono text-rose-400/80 whitespace-pre-wrap max-h-32 overflow-y-auto">{(statusDetailModal.error as any).stack}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Success/Warnings Section */}
                {statusDetailModal.status === 'done' && (
                  <div className="bg-emerald-500/10 rounded-xl p-4 border border-emerald-500/30">
                    <h4 className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <CheckCircle className="w-4 h-4" /> Query Result Summary
                    </h4>
                    <p className="text-xs text-emerald-400/80">
                      Query executed successfully on {statusDetailModal.databaseName} database.
                      {statusDetailModal.rowsAffected > 0 
                        ? ` Returned ${statusDetailModal.rowsAffected} rows with ${statusDetailModal.columns.length} columns.`
                        : ' No rows returned (possibly an UPDATE/DELETE operation).'}
                    </p>
                    {statusDetailModal.columns.length > 0 && (
                      <div className="mt-3">
                        <span className="text-[10px] text-emerald-400/60 block mb-2">Columns in result:</span>
                        <div className="flex flex-wrap gap-1">
                          {statusDetailModal.columns.map((col, i) => (
                            <span key={i} className="text-[10px] px-2 py-1 bg-emerald-500/20 text-emerald-400 rounded-md font-medium">
                              {col}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="px-5 py-4 border-t border-[var(--border)] bg-[var(--surface-raised)] flex justify-end">
                <button 
                  onClick={() => setStatusDetailModal(null)}
                  className="px-4 py-2 bg-[var(--border)] hover:bg-[var(--text-secondary)] text-[var(--text-primary)] text-xs font-bold rounded-lg transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}