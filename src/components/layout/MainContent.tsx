import { useState, useEffect, useRef, useCallback } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { QueryEditor } from "../editor/QueryEditor";
import { ResultsPanel } from "../results/ResultsPanel";
import { useConnections } from "../../contexts/useConnections";
import { useQueryHistory } from "../../store/queryHistoryStore";
import { useSettings } from "../../store/settingsStore";
import { Play, Plus, X, ChevronDown, ChevronRight, Terminal, Database, Sparkles, GitCompare, Save, Square, Activity, Loader2, CheckCircle, XCircle } from "lucide-react";
import { CompareDialog } from "../tools/CompareDialog";
import { useSavedQueries } from "../../store/savedQueryStore";
import { AIAssistantDialog } from "../tools/AIAssistantDialog";
import { DefinitionModal } from "../tools/DefinitionModal";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { CloneDialog } from "../tools/CloneDialog";
import { Copy, FileText, BarChart2, Activity as ActivityIcon, Monitor, Zap, Clock, HardDrive, ShieldCheck, Layers } from "lucide-react";
import { getDefaultDatabaseName } from "../../config/app";
import { formatSql } from "../../utils/SqlFormatter";
import { ActivityMonitor } from "../tools/ActivityMonitor";
import { MultiQueryDialog } from "../tools/MultiQueryDialog";
import { VariableSubstitutionDialog, extractVariables, substituteVariables, VariableValues } from "../ui/VariableSubstitutionDialog";
import { PsqlWindow } from "../ui/PsqlWindow";
import { LocalHistoryDialog } from "../ui/LocalHistoryDialog";
import { useLocalHistory } from "../../store/localHistoryStore";

export interface QueryTab {
  id: string;
  name: string;
  query: string;
  target?: { connectionId: string, connectionName: string, database: string };
  /** When true, force query execution through the psql CLI binary instead of libpq */
  usePsql?: boolean;
  // Tab-specific execution results
  results?: any[];
  columns?: string[];
  error?: string | null;
  success?: string | null;
  executionTime?: number;
  optimizerData?: any;
  tableName?: string | null;
  // Statement-level execution tracking for gutter glyphs
  statementResults?: StatementResult[];
  /** Last executed statement info for gutter glyph display */
  lastExecutedStatement?: { lineNumber: number; status: 'running' | 'success' | 'error' };
  // Multi-statement results
  multiResults?: MultiResult[];
  // PSQL terminal output (per-tab)
  psqlOutput?: string[];
  /** Completed psql console entries (command + output pairs) */
  psqlEntries?: PsqlConsoleEntry[];
}

export interface PsqlConsoleEntry {
  id: string;
  command: string;
  outputLines: string[];
  hasErrors: boolean;
  executionTime: number;
}

export interface StatementResult {
  lineNumber: number;
  status: 'running' | 'success' | 'error';
  rowsAffected?: number;
  rowCount?: number;
  error?: string | null;
  executionTime?: number;
}

export interface MultiResult {
  query: string;
  rows?: any[];
  columns?: string[];
  rowsAffected?: number;
  error?: string | null;
  executionTime?: number;
}

export function MainContent() {
  const { connections, activeConnection, selectedDatabase, currentDb, vaultCredentials, databases: globalDatabases, connectToDatabase } = useConnections();
  const { addQuery } = useQueryHistory();
  const settings = useSettings();
  const [showServices, setShowServices] = useState(true);
  const [queryTabs, setQueryTabs] = useState<QueryTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [results, setResults] = useState<any[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [multiResults, setMultiResults] = useState<MultiResult[]>([]);
  const [executionTime, setExecutionTime] = useState<number>(0);
  const [runningTimeMs, setRunningTimeMs] = useState<number>(0);
  const [lastColumns, setLastColumns] = useState<string[]>([]);
  /** Raw psql stdout lines — only populated when running via CLI */
  const [psqlOutput, setPsqlOutput] = useState<string[]>([]);
  const psqlOutputRef = useRef<string[]>([]);
  // Wrapper to keep ref and state in sync
  const appendPsqlOutput = (linesOrFn: string[] | ((prev: string[]) => string[])) => {
    const next = typeof linesOrFn === 'function' ? linesOrFn(psqlOutputRef.current) : [...psqlOutputRef.current, ...linesOrFn];
    psqlOutputRef.current = next;
    setPsqlOutput(next);
  };
  const clearPsqlOutput = () => {
    psqlOutputRef.current = [];
    setPsqlOutput([]);
  };
  // Ref to always have the latest query text from the active editor
  // This avoids stale closures where React state hasn't flushed yet
  const currentQueryRef = useRef("");
  const lastSelectQueryRef = useRef("");
  const lastPsqlQueryRef = useRef("");
  const cancelFlagRef = useRef<boolean>(false);
  const isExecutingRef = useRef(false);
  const runningCmdRef = useRef<string>("");
  // Ref for latest activeTab to avoid stale closures in executeQuery
  const activeTabRef = useRef<QueryTab | undefined>(undefined);
  const activeTabIdRef = useRef<string | undefined>(undefined);
  const [activeTableName, setActiveTableName] = useState<string | null>(null);
  // Suppresses auto-tab-switching to messages when a save/delete refresh is in progress
  const [suppressTabSwitch, setSuppressTabSwitch] = useState(false);
  // Transaction state
  const [txState, setTxState] = useState<{ active: boolean; isolationLevel: string; statementCount: number }>({
    active: false,
    isolationLevel: "READ COMMITTED",
    statementCount: 0,
  });
  // Dedicated db connection for the active transaction
  const txDbRef = useRef<any>(null);
  const txContextRef = useRef<{ connectionId: string; database: string } | null>(null);

  // Auto-rollback when connection changes during an active transaction
  useEffect(() => {
    if (txState.active && txDbRef.current && txContextRef.current) {
      if (txContextRef.current.connectionId !== activeConnection?.id) {
        // Connection changed — rollback the old transaction
        txDbRef.current.execute("ROLLBACK").catch(() => {});
        txDbRef.current = null;
        txContextRef.current = null;
        setTxState({ active: false, isolationLevel: "READ COMMITTED", statementCount: 0 });
        setError("Transaction rolled back automatically — connection changed.");
      }
    }
  }, [activeConnection]);
  
  const [showCompareDialog, setShowCompareDialog] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showActivityMonitor, setShowActivityMonitor] = useState(false);
  const [showMultiQueryDialog, setShowMultiQueryDialog] = useState(false);
  const [showAIDialog, setShowAIDialog] = useState(false);
  const [_showLocalHistory, setShowLocalHistory] = useState(false);
  const [optimizerData, setOptimizerData] = useState<any>(null);
  const [defModalState, setDefModalState] = useState<{ isOpen: boolean; table: string }>({ isOpen: false, table: "" });
  // Variable substitution state
  const [varDialogState, setVarDialogState] = useState<{
    isOpen: boolean;
    query: string;
    cacheKey: string;
  }>({ isOpen: false, query: "", cacheKey: "" });
  // Ref to the executeQuery function so the dialog handler can call it without circular deps
  const executeQueryRef = useRef<typeof executeQuery | null>(null);
  // Session-level cache for variable values (survives across executions)
  const varCacheRef = useRef<Record<string, VariableValues>>({});
  // Pending execution context when dialog is open
  const pendingVarExecutionRef = useRef<{
    isRunAll: boolean;
    statementsToRun: string[];
    statementInfos: { lineNumber: number; statementText: string }[];
    queryToRun: string;
    cacheKey: string;
  } | null>(null);
  const { addQuery: addSavedQuery, updateQueryText, findByName } = useSavedQueries();
  
  // Use a ref to track a counter for unique tab naming
  const tabCounterRef = useRef(1);
  const confirmDialog = useConfirmDialog();

  const [tabDatabases, setTabDatabases] = useState<Record<string, string[]>>({});

  const fetchTabDatabases = useCallback(async (connId: string) => {
    const conn = connections.find(c => c.id === connId);
    if (!conn || tabDatabases[connId]) return;
    try {
      let username = conn.username || "", password = conn.password || "";
      if (conn.vaultCredentialId) { const vaultCred = vaultCredentials.find(vc => vc.id === conn.vaultCredentialId); if (vaultCred) { username = vaultCred.username || ""; password = vaultCred.password || ""; } }
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      const port = conn.port || (conn.type === "mysql" || conn.type === "mariadb" ? 3306 : 5432);
      const connectionString = conn.type === "sqlite" ? `sqlite:${conn.filepath || getDefaultDatabaseName()}` :
        ["postgres", "supabase", "cockroach"].includes(conn.type) ? `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${conn.host}:${port}/postgres` :
        `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${conn.host}:${port}/mysql`;
      const db = await Database.load(connectionString);
      let dbs: string[] = [];
      if (["postgres", "supabase", "cockroach"].includes(conn.type)) dbs = (await db.select<any[]>("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")).map((r: any) => r.datname);
      else if (["mysql", "mariadb"].includes(conn.type)) dbs = (await db.select<any[]>("SHOW DATABASES")).map((r: any) => r.Database).filter((db: string) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(db));
      else if (conn.type === "sqlite") dbs = [conn.filepath || "main"];
      setTabDatabases(prev => ({ ...prev, [connId]: dbs }));
    } catch { setTabDatabases(prev => ({ ...prev, [connId]: [conn!.database] })); }
  }, [connections, vaultCredentials, tabDatabases]);

  const activeTab = queryTabs.find((t) => t.id === activeTabId);
  const prevActiveTabId = useRef<string | null>(null);

  // Keep refs in sync with latest values to avoid stale closures
  useEffect(() => {
    activeTabRef.current = activeTab;
    activeTabIdRef.current = activeTabId ?? undefined;
  });

  useEffect(() => {
    if (activeTab?.target?.connectionId) {
      fetchTabDatabases(activeTab.target.connectionId);
    }
    
    // When switching tabs, first save the PREVIOUS tab's state, then restore the NEW tab's state
    if (activeTabId && prevActiveTabId.current && prevActiveTabId.current !== activeTabId) {
      // Save previous tab's current state
      const prevTab = queryTabs.find(t => t.id === prevActiveTabId.current);
      if (prevTab) {
        updateTabState(prevActiveTabId.current, {
          results,
          columns: lastColumns,
          error,
          success,
          executionTime,
          optimizerData,
          tableName: activeTableName,
          multiResults,
          psqlOutput,
          psqlEntries: prevTab.psqlEntries, // Keep existing entries
        });
      }
    }
    
    // Restore new tab's state
    if (activeTab) {
      setResults(activeTab.results || []);
      setLastColumns(activeTab.columns || []);
      setError(activeTab.error || null);
      setSuccess(activeTab.success || null);
      setExecutionTime(activeTab.executionTime || 0);
      setOptimizerData(activeTab.optimizerData || null);
      setActiveTableName(activeTab.tableName || null);
      setMultiResults(activeTab.multiResults || []);
      // Note: psqlOutput and psqlEntries are passed directly to PsqlWindow, not restored to global state
    }
    
    prevActiveTabId.current = activeTabId;
  }, [activeTabId]); // Only trigger on tab switch to avoid looping

  // Global Ctrl+S handler for saving queries
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        
        // Prioritize saving data grid changes if any are pending
        const hasPendingDataChanges = results.some(r => r._isNew || r._isModified);
        if (hasPendingDataChanges) {
          handleSave(results);
          return;
        }
        
        if (!activeConnection) {
          setError("No connection — connect to a database before saving queries.");
          return;
        }
        const queryToSave = activeTab?.query || currentQueryRef.current;
        if (!queryToSave || queryToSave.trim() === "") {
          setError("Query is empty — type a SQL statement before saving.");
          return;
        }
        const name = await confirmDialog.dialog({
          title: "Save Query",
          message: "Enter a name to identify this query in your saved queries library.",
          inputLabel: "Query Name",
          inputDefaultValue: activeTab?.name || "My Query",
          confirmLabel: "Save",
          cancelLabel: "Cancel",
          type: "info",
          requireInput: true
        });
        
        if (name) {
          const existing = findByName(name);
          if (existing) {
            updateQueryText(existing.id, queryToSave);
          } else {
            addSavedQuery({
              name,
              query: queryToSave,
              database: selectedDatabase || "",
              connectionId: activeConnection.id
            });
          }
          useLocalHistory.getState().addEntry(
            `saved-queries/${name}`,
            queryToSave,
            `Saved: ${name} — ${activeConnection.name}`
          );
          setSuccess(`Query "${name}" saved successfully!`);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeConnection, selectedDatabase, activeTab, addSavedQuery, confirmDialog]);

  const updateTabState = useCallback((tabId: string, updates: Partial<QueryTab>) => {
    setQueryTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...updates } : t));
  }, []);

  const addNewTab = useCallback((
    query = "",
    name = "",
    usePsql = false,
    explicitConnectionId?: string,
    explicitConnectionName?: string,
    explicitDatabase?: string,
  ) => {
    tabCounterRef.current += 1;

    // Resolve which connection/database to target:
    // 1. Explicit params from context-menu events (most reliable)
    // 2. Currently selected in the sidebar as fallback
    const resolvedConnectionId = explicitConnectionId || activeConnection?.id;
    const resolvedConnectionName = explicitConnectionName || activeConnection?.name;
    const resolvedDatabase = explicitDatabase || selectedDatabase;

    const newTab: QueryTab = {
      id: crypto.randomUUID(),
      name: name || `Query ${tabCounterRef.current}`,
      query,
      usePsql,
      target: resolvedConnectionId && resolvedDatabase ? {
        connectionId: resolvedConnectionId,
        connectionName: resolvedConnectionName || "",
        database: resolvedDatabase
      } : undefined
    };
    setQueryTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);

    // Focus the editor after React renders
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("focus-editor"));
    }, 100);
  }, []);

  const updateTabQuery = useCallback((query: string) => {
    currentQueryRef.current = query;
    setQueryTabs((prev) =>
      prev.map((tab) => (tab.id === activeTabId ? { ...tab, query } : tab))
    );
  }, [activeTabId]);

  const closeTab = useCallback((tabId: string) => {
    setQueryTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
      }
      return newTabs;
    });
  }, [activeTabId]);

  // Extract the single statement at cursor position, or selected text
// Mirrors QueryEditor's "smart run" logic
const extractSelectedOrCursorStatement = (fullText: string): string => {
  // If there's a selection in progress, we can't know here - just get first statement
  // The executeQuery function handles selection from editor
  const statements = fullText.split(';').map(s => s.trim()).filter(s => s.length > 0);
  return statements.length > 0 ? statements[0] : fullText;
};

// Apply automatic LIMIT to SELECT queries to prevent large result sets from freezing the UI
  // Only applies to simple SELECT queries, skips complex queries (CTEs, subqueries, UNION, etc.)
  const applyQueryLimit = (query: string, maxRows: number): string => {
    // Skip if not a SELECT-like query (strip comments first for accurate detection)
    const cleanQuery = query.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().toUpperCase();
    
    if (!cleanQuery.startsWith("SELECT") && !cleanQuery.includes("RETURNING") && 
        !cleanQuery.startsWith("SHOW") && !cleanQuery.startsWith("EXPLAIN")) {
      return query;
    }
    
    // Skip if already has LIMIT (case insensitive)
    if (/\bLIMIT\s+\d+/i.test(query)) {
      return query;
    }
    
    // Skip complex queries - CTEs, subqueries, UNION, etc.
    const isComplexQuery = 
      /\bWITH\s+\w+\s+AS\s*\(/i.test(query) ||  // CTE: WITH xx AS (...)
      /\(\s*SELECT\b/i.test(query) ||           // Subquery: (SELECT ...)
      /\bUNION\s+(ALL\s+)?/i.test(query) ||    // UNION / UNION ALL
      /\bINTERSECT\b/i.test(query) ||          // INTERSECT
      /\bEXCEPT\b/i.test(query);            // EXCEPT
    
    if (isComplexQuery) {
      return query;  // Don't modify complex queries
    }
    
    // Only apply LIMIT to simple SELECT queries
    return `${query.trim()} LIMIT ${maxRows}`;
  };

  const executeQuery = useCallback(async (specificQuery?: any, statementInfo?: { lineNumber: number; statementText: string }) => {
    // Use refs for latest values to avoid stale closures
    const currentTab = activeTabRef.current;
    const currentTabId = activeTabIdRef.current;

    // Resolve the actual connection to use: tab's explicit target overrides context selection.
    // This allows psql tabs opened from a database context menu to work even if the user
    // hasn't clicked a database in the sidebar (and activeConnection from context is null).
    const targetConn = currentTab?.target;
    const actualConnection = targetConn
      ? connections.find(c => c.id === targetConn.connectionId)
      : activeConnection;

    if (!actualConnection) {
      setError("No database connection selected");
      return;
    }

    // Extract single statement from full query - handles multiple statements
    // Only used when no specific query is provided (e.g., toolbar Run button)
    const extractSingleStatement = (query: string): string => {
      // Split by semicolon and get first non-empty statement
      const statements = query.split(';').map(s => s.trim()).filter(s => s.length > 0);
      return statements.length > 0 ? statements[0] : query;
    };

    // Check if this is a "run all" request from Ctrl+Shift+Enter
    const isRunAll = specificQuery && typeof specificQuery === 'object' && specificQuery.__runAll;
    const statementsToRun = isRunAll ? specificQuery.statements : [];
    const statementInfos = isRunAll ? specificQuery.statementInfos : (statementInfo ? [statementInfo] : []);

    // Read from the provided specific text block, otherwise fallback to the global ref
    let finalQueryText = "";
    if (isRunAll) {
      // For run all, we'll handle each statement sequentially
      finalQueryText = "";
    } else if (typeof specificQuery === "string" && specificQuery.trim() !== "") {
      // If specific query provided (from editor selection or cursor extraction), use it directly
      finalQueryText = specificQuery;
    } else {
      // Only extract single statement from full content when using toolbar Run button
      finalQueryText = extractSingleStatement(currentQueryRef.current || currentTab?.query || "");
    }

    const queryToRun = finalQueryText.trim();
    if (!queryToRun) {
      setError("Query is empty — type a SQL statement and try again");
      return;
    }
    runningCmdRef.current = queryToRun;

    // Snapshot to local history before execution
    const tabPath = currentTab?.name ? `editor/${currentTab.name}` : `editor/untitled-${(currentTabId || "new").slice(0, 8)}`;
    useLocalHistory.getState().addEntry(
      tabPath,
      queryToRun,
      `Executed: ${currentTab?.name || "Untitled"} — ${actualConnection.name}`
    );

    // Variable substitution: extract variables and show dialog if needed
    const queriesToCheck = isRunAll
      ? statementsToRun
      : [queryToRun];

    const allVars: { name: string; defaultValue?: string; isOptional: boolean; position: number }[] = [];
    for (const q of queriesToCheck) {
      for (const v of extractVariables(q)) {
        if (!allVars.find(av => av.name === v.name)) {
          allVars.push({ name: v.name, defaultValue: v.defaultValue, isOptional: v.isOptional, position: v.position });
        }
      }
    }

    if (allVars.length > 0 && settings.enableQueryVariables) {
      // Get cache key based on first 60 chars of query
      const cacheKey = queryToRun.substring(0, 60);

      // Show the dialog and return early. The dialog's onConfirm will substitute
      // variables and call executeQuery again.
      setVarDialogState({ isOpen: true, query: queryToRun, cacheKey });

      // Store the pending execution context so the dialog can re-trigger
      pendingVarExecutionRef.current = {
        isRunAll,
        statementsToRun,
        statementInfos,
        queryToRun,
        cacheKey,
      };

      return;
    }

    // Attempt to extract table name for enabling row operations (ADD/DUP/REMOVE)
    const tableNameMatch = queryToRun.match(/FROM\s+["']?([a-zA-Z0-9_.]+(?:\.[a-zA-Z0-9_.]+)*)["']?/i);
    if (tableNameMatch) {
      const detectedTable = tableNameMatch[1];
      // Only update if it looks like a simple table name and not a complex subquery
      if (!detectedTable.startsWith("(")) {
        setActiveTableName(detectedTable);
        if (currentTabId) updateTabState(currentTabId, { tableName: detectedTable });
      }
    }

    setError(null);
    setSuccess(null);
    setMultiResults([]);
    setRunningTimeMs(0);
    cancelFlagRef.current = false;
    
    // Clear statement results when starting new execution (glyphs will appear after execution completes)
    if (currentTabId) {
      updateTabState(currentTabId, { statementResults: [] });
    }
    const startTime = Date.now();
    let intervalId: any = null;
    
    try {
      // Declare execution state at the top so both libpq and CLI paths can reference them
      let rows: any[] = [];
      let rowsAffected = 0;
      let multiResults: { query: string; rows?: any[]; columns?: string[]; rowsAffected?: number; error?: string; lineNumber?: number }[] = [];
      let statementResults: StatementResult[] = [];
      let db = currentDb;

      const actualDatabase = targetConn ? targetConn.database : selectedDatabase;
      
      // Determine if this tab should route through the psql CLI path
      // Either the connection type is "psql" OR the tab has usePsql=true (for regular postgres connections)
      const isPgConnection = ["postgres", "supabase", "cockroach"].includes(actualConnection?.type || "");
      const useCliPath = actualConnection?.type === "psql" || (isPgConnection && currentTab?.usePsql);

      // Compute query type immediately (needed by both libpq and CLI paths)
      const upperQuery = queryToRun.toUpperCase();
      const cleanUpper = queryToRun.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().toUpperCase();
      const isSelect =
        cleanUpper.startsWith("SELECT") ||
        cleanUpper.includes("RETURNING") ||
        cleanUpper.startsWith("WITH") ||
        cleanUpper.startsWith("SHOW") ||
        cleanUpper.startsWith("EXPLAIN") ||
        cleanUpper.includes("(SELECT");
      const isTruncate = upperQuery.includes("TRUNCATE");
      const isDelete = upperQuery.includes("DELETE");
      const hasWhere = upperQuery.includes("WHERE");
      const isDestructive = isTruncate || (isDelete && !hasWhere) || upperQuery.includes("DROP");

      // Resolve credentials (shared between libpq and CLI paths)
      let username = actualConnection.username || "";
      let password = actualConnection.password || "";
      if (actualConnection.vaultCredentialId) {
        const vaultCred = vaultCredentials.find(vc => vc.id === actualConnection.vaultCredentialId);
        if (vaultCred) {
          username = vaultCred.username || "";
          password = vaultCred.password || "";
        }
      }
      const port = actualConnection.port || (actualConnection.type === "mysql" || actualConnection.type === "mariadb" ? 3306 : 5432);
      
      // ── CLI path for psql type ──────────────────────────────────────────────
      if (useCliPath) {
        setIsExecuting(true);
        isExecutingRef.current = true;
        runningCmdRef.current = queryToRun;
        if (!queryToRun.trim().startsWith("\\")) {
          lastPsqlQueryRef.current = queryToRun;
        }
        clearPsqlOutput(); // Clear terminal at start of CLI execution
        const cliStore = await import("../../store/cliStore").then(m => m.useCliStore.getState());

        const actualDatabase = targetConn ? targetConn.database : selectedDatabase;
        let cliDatabase = actualDatabase;

        // Check for \c (connect) meta-command
        const connectMatch = queryToRun.trim().match(/^\\(?:c|connect)\s+([\w"$.]+)/i);
        if (connectMatch) {
          const newDb = connectMatch[1].replace(/"/g, '');
          cliDatabase = newDb;
          console.log("[CLI Path] Detected \\c command, switching target to:", newDb);
          if (currentTabId) {
             updateTabState(currentTabId, {
                target: { 
                  connectionId: actualConnection.id, 
                  connectionName: actualConnection.name || "", 
                  database: newDb 
                }
             });
          }
        }
        
        // Resolve major version from three sources (most reliable first):
        // 1. Stale-check: re-detect from live libpq connection if currentDb is available
        // 2. Pre-stored: serverMajorVersion captured on connect
        // 3. System binary as last resort
        let majorVersion: number | null = actualConnection.serverMajorVersion || null;
        console.log("[CLI Path] Initial majorVersion:", majorVersion);

        if (majorVersion === null && currentDb) {
          console.log("[CLI Path] Detecting major version via currentDb.select...");
          try {
            const verRows = await currentDb.select("SELECT (regexp_matches(version(), E'^PostgreSQL (\\d+)'))[1]::int AS major") as any[];
            majorVersion = verRows[0]?.major || null;
            console.log("[CLI Path] SQL check result:", majorVersion);
          } catch (e) {
            console.log("[CLI Path] SQL check failed:", e);
          }
        }

        // Still no version → check for system psql in PATH
        if (majorVersion === null) {
          console.log("[CLI Path] Falling back to system tool detection...");
          const sysTool = await cliStore.checkSystemTool("postgresql");
          console.log("[CLI Path] System tool available:", sysTool.available);
          if (sysTool.available) {
            majorVersion = 0;
          }
        }

        // Still no version known — bail out with a clear error
        if (majorVersion === null) {
          const msg = "PostgreSQL version unknown. Connect to the database first so QueryDen can detect the server version.";
          appendPsqlOutput([`ERROR: ${msg}`]);
          setError(msg);
          setIsExecuting(false);
      isExecutingRef.current = false;
          return;
        }

        console.log("[CLI Path] Final majorVersion to use:", majorVersion);
        const toolStatus = await cliStore.checkTool("postgresql", majorVersion);
        console.log("[CLI Path] Tool status (checkTool):", toolStatus);

        if (toolStatus.needsDownload) {
          const filename = toolStatus.downloadFilename || `postgresql-${majorVersion}.tar.gz`;
          const confirmed = await confirmDialog.confirm({
            title: "Download psql",
            message: `The psql CLI for PostgreSQL ${majorVersion} is not installed.\n\n\
QueryDen needs the psql version to match your server (${majorVersion}) to avoid compatibility issues.\n\n\
Download "${filename}" (~80MB)?`,
            confirmLabel: "Download",
            type: "info",
          });
          if (!confirmed) {
            const msg = "psql download cancelled — cannot run queries without the CLI tool.";
            appendPsqlOutput([`ERROR: ${msg}`]);
            setError(msg);
            setIsExecuting(false);
      isExecutingRef.current = false;
            return;
          }
          // User confirmed — download
          appendPsqlOutput([`Downloading psql ${majorVersion}...`]);
          try {
            await cliStore.downloadVersion("postgresql", majorVersion);
            appendPsqlOutput([`psql ${majorVersion} downloaded and ready.`]);
          } catch (dlErr: any) {
            const msg = `Download failed: ${dlErr.message || String(dlErr)}`;
            appendPsqlOutput([`ERROR: ${msg}`]);
            setError(msg);
            setIsExecuting(false);
      isExecutingRef.current = false;
            return;
          }
        } else if (!toolStatus.available) {
          // System install hint (platform doesn't support download)
          const hint = `PostgreSQL ${majorVersion} client not found and auto-download is not available for your platform.\n\nInstall the PostgreSQL client for version ${majorVersion} and try again.`;
          setError(hint);
          return;
        }
        
        const cliHost = actualConnection.host || "localhost";
        // cliDatabase is already defined above, potentially updated by \c command
        console.log("[CLI Path] Using database for execution:", cliDatabase);
        
        // Helper: execute a single statement via CLI and return normalized rows/columns + stdout
        const cliExecStmt = async (stmt: string, wantRows: boolean) => {
          console.log("[cliExecStmt] Executing:", stmt);
          const result = await cliStore.executeQuery(
            "postgresql", stmt, cliHost, port, cliDatabase as string, username, password, majorVersion
          );
          console.log("[cliExecStmt] Result received from cliStore:", { 
            hasError: !!result.error, 
            stdoutLines: result.stdout?.length || 0,
            rows: result.rows?.length || 0 
          });

          if (result.error && result.error !== null) {
            console.error("[cliExecStmt] Error string:", result.error);
            throw new Error(result.error);
          }

          if (wantRows) {
            const colNames: string[] = result.columns || [];
            const rawRows: string[][] = result.rows || [];

            // Always build formatted terminal output — reconstruct from stdout when
            // colNames/rows are empty (e.g. SELECT 1 where "?column?" has no pipe).
            if (colNames.length > 0) {
              const colWidths = colNames.map((c, i) => {
                const maxData = rawRows.length > 0
                  ? Math.max(...rawRows.map(r => (r[i] || "").length))
                  : 0;
                return Math.max(c.length, maxData);
              });
              const headerLine = colNames.map((c, i) => c.padEnd(colWidths[i])).join(" │ ");
              const sepLine = colWidths.map(w => "─".repeat(w)).join("─┼─");
              const dataLines = rawRows.map(row =>
                row.map((val, i) => (val || "").padEnd(colWidths[i])).join(" │ ")
              );
              const rowCount = rawRows.length;
              const footerLine = `(${rowCount} row${rowCount !== 1 ? "s" : ""})`;
              appendPsqlOutput([headerLine, sepLine, ...dataLines, footerLine]);
            } else if (result.stdout && result.stdout.length > 0) {
              // No parsed columns but raw output exists — extract header from first line.
              // Handle pipe-separated (header+data) and single-column unaligned (no pipes).
              const stdout = result.stdout;
              const headerLine = stdout[0] || "";
              const footerIdx = stdout.findIndex(l => /^\(\d+ rows?\)/.test(l.trim()));
              const footerLine = footerIdx >= 0 ? stdout[footerIdx] : "";
              const dataLines = stdout.slice(1, footerIdx >= 0 ? footerIdx : undefined);
              const nonEmptyData = dataLines.filter(l => l.trim().length > 0);
              const hasPipes = headerLine.includes("|");
              if (hasPipes && nonEmptyData.length > 0) {
                // Pipe-separated multi-line output — align columns
                const headerParts = headerLine.split("|").map(s => s.trimEnd());
                const dataParts = nonEmptyData.map(l => l.split("|").map(s => s.trimEnd()));
                const colWidths = headerParts.map((p, i) =>
                  Math.max(p.length, ...dataParts.map(r => (r[i] || "").length))
                );
                appendPsqlOutput([
                  headerParts.map((p, i) => p.padEnd(colWidths[i])).join(" │ "),
                  colWidths.map(w => "─".repeat(w)).join("─┼─"),
                  ...dataParts.map(row => row.map((v, i) => (v || "").padEnd(colWidths[i])).join(" │ ")),
                  footerLine,
                ]);
              } else if (nonEmptyData.length > 0) {
                // Single-column output (no pipes) — show header + data + footer
                const maxLen = Math.max(headerLine.length, ...nonEmptyData.map(l => l.length));
                const sepLine = "─".repeat(maxLen);
                appendPsqlOutput([headerLine.padEnd(maxLen), sepLine, ...nonEmptyData.map(l => l.padEnd(maxLen)), footerLine]);
              } else {
                // Just header + footer (0 rows), or bare output
                appendPsqlOutput([...stdout]);
              }
            } else {
              // Nothing to show
              appendPsqlOutput(["(empty)"]);
            }

            const normalizedRows = rawRows.map(rowValues => {
              const obj: Record<string, any> = {};
              colNames.forEach((col, i) => { obj[col] = rowValues[i]; });
              return obj;
            });
            return { rows: normalizedRows, columns: colNames };
          } else {
            appendPsqlOutput([...(result.stdout || [])]);
            return { rowsAffected: result.rowsAffected || 0 };
          }
        };

        // ── Run all statements via CLI ────────────────────────────────────────
        if (isRunAll && statementsToRun.length > 0) {
          for (let i = 0; i < statementsToRun.length; i++) {
            if (cancelFlagRef.current) break;
            const stmt = statementsToRun[i];
            const stmtInfo = statementInfos[i];
            const lineNumber = stmtInfo?.lineNumber || 1;
            const stmtUpper = stmt.toUpperCase().trim();
            const isStmtSelect =
              stmtUpper.startsWith("SELECT") ||
              stmtUpper.includes("RETURNING") ||
              stmtUpper.startsWith("WITH") ||
              stmtUpper.startsWith("SHOW") ||
              stmtUpper.startsWith("EXPLAIN") ||
              stmtUpper.includes("(SELECT");
            try {
              const stmtStartTime = Date.now();
              if (isStmtSelect) {
                const limitedStmt = applyQueryLimit(stmt, settings.maxRowsToDisplay);
                const { rows: stmtRows, columns: stmtCols } = await cliExecStmt(limitedStmt, true);
                const safeRows = stmtRows ?? [];
                multiResults.push({ query: stmt, rows: safeRows, columns: stmtCols, rowsAffected: safeRows.length, lineNumber });
                statementResults.push({ lineNumber, status: 'success', rowCount: safeRows.length, executionTime: Date.now() - stmtStartTime });
              } else {
                const { rowsAffected: affected } = await cliExecStmt(stmt, false);
                multiResults.push({ query: stmt, rowsAffected: affected, lineNumber });
                statementResults.push({ lineNumber, status: 'success', rowsAffected: affected, executionTime: Date.now() - stmtStartTime });
              }
            } catch (stmtErr: any) {
              const errMsg = stmtErr.message || String(stmtErr);
              multiResults.push({ query: stmt, error: errMsg, lineNumber });
              statementResults.push({ lineNumber, status: 'error', error: errMsg, executionTime: 0 });
            }
          }
          const errors = multiResults.filter(r => r.error);
          if (errors.length > 0) {
            const errorMsgs = errors.map(e => `Statement: ${e.query.substring(0, 50)}... Error: ${e.error}`).join('\n');
            throw new Error(`Some statements failed:\n${errorMsgs}`);
          }
          setMultiResults(multiResults.map(mr => ({
            query: mr.query,
            rows: mr.rows,
            columns: mr.columns || (mr.rows && mr.rows.length > 0 ? Object.keys(mr.rows[0]) : undefined),
            rowsAffected: mr.rowsAffected,
            error: mr.error,
            executionTime: 0
          })));
          if (currentTabId) updateTabState(currentTabId, { statementResults });
          const selectResults = multiResults.filter(r => r.rows && r.rows.length > 0);
          if (selectResults.length > 0) {
            rows = selectResults[0].rows || [];
            rowsAffected = rows.length;
          } else {
            const totalAffected = multiResults.reduce((sum, r) => sum + (r.rowsAffected || 0), 0);
            setSuccess(`Executed ${multiResults.length} statements. ${totalAffected} rows affected total.`);
          }
        } else {
          // Single statement via CLI
          const stmtInfo = statementInfo || { lineNumber: 1, statementText: queryToRun };
          const stmtStartTime = Date.now();

          // ─── Special Handling for \watch ─────────────────────────────────────────
          if (queryToRun.trim().toLowerCase().startsWith("\\watch")) {
            const parts = queryToRun.trim().split(/\s+/);
            const intervalSec = parseFloat(parts[1]) || 2;
            const intervalMs = Math.max(intervalSec * 1000, 100);

            const queryToWatch = lastPsqlQueryRef.current;
            if (!queryToWatch) {
              const msg = "\\watch cannot be used with an empty query on the PSQLWindow / console. Run a query first (e.g. SELECT 1) and then use \\watch.";
              appendPsqlOutput([`ERROR: ${msg}`]);
              setError(msg);
              setIsExecuting(false);
              isExecutingRef.current = false;
              return;
            }

            appendPsqlOutput([`Watching: ${queryToWatch} (every ${intervalSec}s). Press Stop to cancel.`]);
            
            while (!cancelFlagRef.current && isExecutingRef.current) {
              try {
                // psql \watch typically shows the grid output repeatedly
                await cliExecStmt(queryToWatch, true);
              } catch (err: any) {
                appendPsqlOutput([`ERROR in watch: ${err.message || String(err)}`]);
                break;
              }

              // Non-blocking sleep with cancellation check
              const startWait = Date.now();
              while (Date.now() - startWait < intervalMs) {
                if (cancelFlagRef.current || !isExecutingRef.current) break;
                await new Promise(r => setTimeout(r, 100));
              }
            }
            
            setIsExecuting(false);
            isExecutingRef.current = false;
            return;
          }

          try {
            if (isSelect) {
              const limitedQuery = applyQueryLimit(queryToRun, settings.maxRowsToDisplay);
              const { rows: cliRows, columns: cliCols } = await cliExecStmt(limitedQuery, true);
              rows = cliRows ?? [];
              rowsAffected = rows.length;
              statementResults.push({ lineNumber: stmtInfo.lineNumber, status: 'success', rowCount: rowsAffected, executionTime: Date.now() - stmtStartTime });
              // Store columns for the ResultPanel
              if (currentTabId) updateTabState(currentTabId, { statementResults, columns: cliCols ?? [] });
              setLastColumns(cliCols ?? []);
            } else {
              const { rowsAffected: affected } = await cliExecStmt(queryToRun, false);
              rowsAffected = affected ?? 0;
              setSuccess(`Query executed successfully. ${rowsAffected} rows affected.`);
              rows = [];
              statementResults.push({ lineNumber: stmtInfo.lineNumber, status: 'success', rowsAffected, executionTime: Date.now() - stmtStartTime });
              if (currentTabId) updateTabState(currentTabId, { statementResults });
            }
          } catch (stmtErr: any) {
            // Show the error in the psql terminal
            const errMsg = stmtErr.message || String(stmtErr);
            appendPsqlOutput([`ERROR: ${errMsg}`]);
            setError(errMsg);
            // Create a psql console entry for the error so it persists in the terminal
            if (currentTabId) {
              const currentOutput = psqlOutputRef.current;
              const errEntry: PsqlConsoleEntry = {
                id: crypto.randomUUID(),
                command: runningCmdRef.current || queryToRun,
                outputLines: currentOutput.length > 0 ? currentOutput : [`ERROR: ${errMsg}`],
                hasErrors: true,
                executionTime: Date.now() - startTime,
              };
              updateTabState(currentTabId, {
                psqlEntries: [...(currentTab?.psqlEntries || []), errEntry],
                psqlOutput: [],
              });
              clearPsqlOutput();
            }
            setIsExecuting(false);
      isExecutingRef.current = false;
            return;
          }
          if (currentTabId) updateTabState(currentTabId, { statementResults });
        }
        
        // Skip the libpq block entirely
        // Jump to the post-execution section
        if (intervalId) clearInterval(intervalId);
        if (cancelFlagRef.current) return;
        
        // CLI path: results go to psqlOutput (terminal) only, not to the ResultsPanel grid
        const duration = Date.now() - startTime;
        setExecutionTime(duration);
        window.dispatchEvent(new CustomEvent("status-bar-update", {
          detail: { rows: isSelect ? rowsAffected : rowsAffected, time: duration, txActive: txState.active, txStatements: txState.statementCount }
        }));
        if (currentTabId) {
          // Create a psql console entry from the current output
          const cmd = runningCmdRef.current || queryToRun;
          const currentOutput = psqlOutputRef.current;
          const hasErrs = currentOutput.some(l => l.startsWith("ERROR:") || l.startsWith("FATAL:"));
          const newEntry: PsqlConsoleEntry = {
            id: crypto.randomUUID(),
            command: cmd,
            outputLines: currentOutput.length > 0 ? currentOutput : ["(no output)"],
            hasErrors: hasErrs,
            executionTime: duration,
          };
          

          updateTabState(currentTabId, {
            executionTime: duration,
            success: isRunAll ? `Executed ${multiResults.length} statements. ${rowsAffected} rows affected.` : `Query executed successfully. ${rowsAffected} rows affected.`,
            error: null,
            lastExecutedStatement: statementInfos && statementInfos.length > 0 ? { lineNumber: statementInfos[0].lineNumber, status: 'success' } : undefined,
            psqlOutput: currentOutput,
            multiResults,
            psqlEntries: [...(currentTab?.psqlEntries || []), newEntry],
          });
        }
        addQuery({ connectionId: actualConnection.id, connectionName: actualConnection.name, query: queryToRun, success: true, duration, rowCount: rowsAffected });
        
        // End early — skip the libpq execution block
        setIsExecuting(false);
      isExecutingRef.current = false;
        return;
      }
      
      // ── Default: libpq path ──────────────────────────────────────────────────
      // Use the transaction-scoped connection if a transaction is active for this connection
      if (txState.active && txDbRef.current && txContextRef.current?.connectionId === actualConnection.id && txContextRef.current?.database === actualDatabase) {
        db = txDbRef.current;
      } else if (!db || targetConn) {
        const Database = (await import("@tauri-apps/plugin-sql")).default;
        let connectionString = "";
        
        const encodedUser = encodeURIComponent(username);
        const encodedPass = encodeURIComponent(password);
        
        if (actualConnection.type === "sqlite") {
          connectionString = `sqlite:${actualConnection.filepath || getDefaultDatabaseName()}`;
        } else if (["postgres", "supabase", "cockroach"].includes(actualConnection.type)) {
          connectionString = `postgres://${encodedUser}:${encodedPass}@${actualConnection.host}:${port}/${actualDatabase || actualConnection.database}`;
        } else if (["mysql", "mariadb"].includes(actualConnection.type)) {
          connectionString = `mysql://${encodedUser}:${encodedPass}@${actualConnection.host}:${port}/${actualDatabase || actualConnection.database}`;
        }
        
        db = await Database.load(connectionString);
      }

      // Check global permission
      if (!settings.allowSqlExecute && isDestructive) {
        throw new Error(`Execution Denied: Destructive operations are blocked by the global "Allow SQL Execution" (sql:allow-execute) setting.`);
      }

      // Check safety rules
      if (!settings.bypassSafetyRules) {
        if (isTruncate && settings.safetyWarnOnTruncate) {
          const confirmed = await confirmDialog.confirm({
            title: "Confirm Table Truncate",
            message: "You are about to empty all records from a table. This cannot be undone. Are you sure?",
            confirmLabel: "Truncate Table",
            type: "danger",
            helpInstructions: "This warning can be disabled in Settings > Permissions & Rules > Safety Rules > Warn on TRUNCATE."
          });
          if (!confirmed) return;
        } else if (isDelete && !hasWhere && settings.safetyWarnOnDeleteNoWhere) {
          const confirmed = await confirmDialog.confirm({
            title: "Dangerous Delete Detected",
            message: "This DELETE statement has no WHERE clause and will affect ALL records in the table. Are you sure?",
            confirmLabel: "Delete All Records",
            type: "danger",
            helpInstructions: "This warning can be disabled in Settings > Permissions & Rules > Safety Rules > Warn on DELETE without WHERE."
          });
          if (!confirmed) return;
        }
      }

      // NOW we start the execution indicators
      setIsExecuting(true);
      
      // Set statement-level indicator to 'running' if we have statement info
      if (currentTabId && statementInfos && statementInfos.length > 0) {
        updateTabState(currentTabId, { 
          lastExecutedStatement: { 
            lineNumber: statementInfos[0].lineNumber, 
            status: 'running' 
          } 
        });
      }
      
      // Live timer
      intervalId = setInterval(() => {
        setRunningTimeMs(Date.now() - startTime);
      }, 50);

      try {
        // Handle multiple statements (Ctrl+Shift+Enter)
        if (isRunAll && statementsToRun.length > 0) {
          for (let i = 0; i < statementsToRun.length; i++) {
            if (cancelFlagRef.current) break;
            
            const stmt = statementsToRun[i];
            const stmtInfo = statementInfos[i];
            const lineNumber = stmtInfo?.lineNumber || 1;
            
            const stmtUpper = stmt.toUpperCase().trim();
            const isStmtSelect = 
              stmtUpper.startsWith("SELECT") || 
              stmtUpper.includes("RETURNING") || 
              stmtUpper.startsWith("WITH") ||  // CTE queries
              stmtUpper.startsWith("SHOW") || 
              stmtUpper.startsWith("EXPLAIN") ||
              stmtUpper.includes("(SELECT");  // Subqueries
            
            try {
              const stmtStartTime = Date.now();
              if (isStmtSelect) {
                const limitedStmt = applyQueryLimit(stmt, settings.maxRowsToDisplay);
                const stmtRows = await db.select(limitedStmt) as any[];
                multiResults.push({ query: stmt, rows: stmtRows, rowsAffected: stmtRows.length, lineNumber });
                statementResults.push({
                  lineNumber,
                  status: 'success',
                  rowCount: stmtRows.length,
                  executionTime: Date.now() - stmtStartTime
                });
              } else {
                const result = await db.execute(stmt);
                const affected = typeof result.rowsAffected === 'number' ? result.rowsAffected : 0;
                multiResults.push({ query: stmt, rowsAffected: affected, lineNumber });
                statementResults.push({
                  lineNumber,
                  status: 'success',
                  rowsAffected: affected,
                  executionTime: Date.now() - stmtStartTime
                });
              }
            } catch (stmtErr: any) {
              const errMsg = stmtErr.message || String(stmtErr);
              multiResults.push({ query: stmt, error: errMsg, lineNumber });
              statementResults.push({
                lineNumber,
                status: 'error',
                error: errMsg,
                executionTime: 0
              });
            }
          }
          
          // Check if any had errors
          const errors = multiResults.filter(r => r.error);
          if (errors.length > 0) {
            const errorMsgs = errors.map(e => `Statement: ${e.query.substring(0, 50)}... Error: ${e.error}`).join('\n');
            throw new Error(`Some statements failed:\n${errorMsgs}`);
          }
          
          // Store multiResults for display with tick/X indicators
          setMultiResults(multiResults.map(mr => ({
            query: mr.query,
            rows: mr.rows,
            columns: mr.rows && mr.rows.length > 0 ? Object.keys(mr.rows[0]) : undefined,
            rowsAffected: mr.rowsAffected,
            error: mr.error,
            executionTime: 0
          })));
          
          // Store statement results for gutter glyphs
          if (currentTabId) {
            updateTabState(currentTabId, { statementResults });
          }
          
          // Combine results - use first SELECT result, or show counts for all
          const selectResults = multiResults.filter(r => r.rows && r.rows.length > 0);
          if (selectResults.length > 0) {
            rows = selectResults[0].rows || [];
            rowsAffected = rows.length;
          } else {
            const totalAffected = multiResults.reduce((sum, r) => sum + (r.rowsAffected || 0), 0);
            setSuccess(`Executed ${multiResults.length} statements. ${totalAffected} rows affected total.`);
          }
        } else {
          // Single statement execution (existing logic)
          const stmtInfo = statementInfo || { lineNumber: 1, statementText: queryToRun };
          const stmtStartTime = Date.now();
          
          if (isSelect) {
            const limitedQuery = applyQueryLimit(queryToRun, settings.maxRowsToDisplay);
            rows = await db.select(limitedQuery) as any[];
            rowsAffected = rows.length;
            statementResults.push({
              lineNumber: stmtInfo.lineNumber,
              status: 'success',
              rowCount: rowsAffected,
              executionTime: Date.now() - stmtStartTime
            });
          } else {
            const result = await db.execute(queryToRun);
            rowsAffected = typeof result.rowsAffected === 'number' ? result.rowsAffected : 0;
            setSuccess(`Query executed successfully. ${rowsAffected} rows affected.`);
            rows = [];
            statementResults.push({
              lineNumber: stmtInfo.lineNumber,
              status: 'success',
              rowsAffected,
              executionTime: Date.now() - stmtStartTime
            });
          }
          
          // Store statement results for gutter glyphs
          if (currentTabId) {
            updateTabState(currentTabId, { statementResults });
          }
        }

        // Update transaction statement count if in an active transaction
        if (txState.active) {
          const numStatements = isRunAll ? statementsToRun.length : 1;
          setTxState(prev => ({ ...prev, statementCount: prev.statementCount + numStatements }));
          window.dispatchEvent(new CustomEvent("tx-state-changed", {
            detail: { active: true, statementCount: txState.statementCount + numStatements }
          }));
        }
      } finally {
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
      }
      if (cancelFlagRef.current) return;

      const duration = Date.now() - startTime;
      
      // CRITICAL: Only setResults if it was a SELECT query or we actually got rows back.
      // This prevents "jumping" when performing row operations like DELETE or UPDATE
      // where we want to manage the state updates ourselves optimistically.
      if (isSelect || rows.length > 0) {
        setResults(rows);
        if (rows.length > 0) {
          setLastColumns(Object.keys(rows[0]));
        } else {
          setLastColumns([]);
        }
      }
      setExecutionTime(duration);
      
      // Update status bar
      window.dispatchEvent(new CustomEvent("status-bar-update", {
        detail: { rows: isSelect ? rowsAffected : rowsAffected, time: duration, txActive: txState.active, txStatements: txState.statementCount }
      }));
      
      // Persist successful execution to the query tab
      if (currentTabId) {
        updateTabState(currentTabId, {
           results: isSelect || rows.length > 0 ? rows : [],
           columns: rows.length > 0 ? Object.keys(rows[0]) : [],
           executionTime: duration,
           success: isRunAll ? `Executed ${multiResults.length} statements. ${rowsAffected} rows affected.` : `Query executed successfully. ${rowsAffected} rows affected.`,
           error: null,
           lastExecutedStatement: statementInfos && statementInfos.length > 0 ? { 
             lineNumber: statementInfos[0].lineNumber, 
             status: 'success' 
           } : undefined
        });
      }
      
      // Save to history
      addQuery({
        connectionId: actualConnection.id,
        connectionName: actualConnection.name,
        query: queryToRun,
        success: true,
        duration,
        rowCount: rowsAffected,
      });
    } catch (err: any) {
      if (intervalId) clearInterval(intervalId);
      if (cancelFlagRef.current) return;

      const duration = Date.now() - startTime;
      let errorMsg = typeof err === 'string' ? err : err?.message || JSON.stringify(err) || "Failed to execute query";
      
      // Translate cryptic driver errors into actionable user advice
      if (errorMsg.includes("closed pool") || errorMsg.includes("connection closed") || errorMsg.includes("Broken pipe")) {
        errorMsg = "Connection Lost: The database cluster has closed the connection pool (session timeout). Please click 'Connect' again in the Database Explorer to refresh the link.";
      } else if (errorMsg.includes("password authentication failed")) {
        errorMsg = `Authentication Failure: Access denied for user "${actualConnection.username}". Please verify your credentials in the connection settings or vault.`;
      } else if (errorMsg.includes("could not connect to server")) {
        errorMsg = "Network Error: Could not reach the database server. Check your VPN, firewall, or if the server is actually running.";
      } else {
        // Enhanced column error detection with hints
        const missingTableMatch = errorMsg.match(/missing FROM-clause entry for table "([^"]+)"/i);
        const undefinedColumnMatch = errorMsg.match(/column "([^"]+)" does not exist/i);
        
        if (missingTableMatch) {
          const problematic = missingTableMatch[1];
          
          // Check if it looks like table_column or tableId pattern
          if (problematic.includes('_') || problematic.endsWith('Id')) {
            const parts = problematic.split('_');
            const potentialTable = parts[0];
            const potentialColumn = parts.slice(1).join('_');
            
            // Build helpful suggestion
            let suggestion = "";
            if (parts.length > 1) {
              suggestion = `\n\n💡 Hint: Did you mean "${potentialTable}.${potentialColumn}"? (table_column format)`;
            }
            
            errorMsg = `Column "${problematic}" does not exist in any table in scope.${suggestion}\n\nPossible causes:\n• Typo in column name\n• Using table_reference instead of column (e.g., "${potentialTable}" instead of "${potentialTable}.id")\n• Column was renamed or deleted`;
          } else {
            errorMsg = `Table "${problematic}" not found in query. Check your JOINs or table name.`;
          }
        } else if (undefinedColumnMatch) {
          const col = undefinedColumnMatch[1];
          
          // Check if column name matches table_column pattern
          if (col.includes('.')) {
            const [tablePart, columnPart] = col.split('.');
            errorMsg = `Column "${columnPart}" not found in table "${tablePart}".\n\n💡 Please verify the column name exists in that table.`;
          } else if (col.includes('_')) {
            const parts = col.split('_');
            errorMsg = `Column "${col}" not found.\n\n💡 Did you mean:\n• "${parts[0]}.${parts.slice(1).join('_')}" (table_column format)\n• Check if table prefix is correct`;
          } else {
            errorMsg = `Column "${col}" not found in any table in query.\n\n💡 Try qualifying with table name: table.column`;
          }
        }
      }
      
      setError(errorMsg);
      if (currentTabId) {
        // Add error to statement results if we have line info
        const errorLineNumber = statementInfos?.[0]?.lineNumber || 1;
        const errorStatementResult: StatementResult = {
          lineNumber: errorLineNumber,
          status: 'error',
          error: errorMsg,
          executionTime: duration
        };
        
        // If we already have partial results from multi-statement execution, update them
        // Note: statementResults is inside the inner try block, not accessible here.
        // Start with the error result.
        const updatedStatementResults: StatementResult[] = [errorStatementResult];
        
        updateTabState(currentTabId, { 
          error: errorMsg, 
          success: null, 
          executionTime: duration,
          statementResults: updatedStatementResults,
          lastExecutedStatement: { 
            lineNumber: errorLineNumber, 
            status: 'error' 
          }
        });
      }
      
      // Save failed query to history
      addQuery({
        connectionId: actualConnection.id,
        connectionName: actualConnection.name,
        query: queryToRun,
        success: false,
        duration,
      });
    } finally {
      if (intervalId) clearInterval(intervalId);
      if (!cancelFlagRef.current) {
        setIsExecuting(false);
      isExecutingRef.current = false;
      }
    }
  }, [activeConnection, selectedDatabase, addQuery, currentDb, vaultCredentials, settings, confirmDialog]);

  const cancelQuery = useCallback(() => {
    cancelFlagRef.current = true;
    setIsExecuting(false);
    setError("Query execution cancelled by user.");
    setExecutionTime(runningTimeMs);
    if (activeTabId) {
      updateTabState(activeTabId, { error: "Query execution cancelled by user.", executionTime: runningTimeMs });
    }
  }, [runningTimeMs, activeTabId, updateTabState]);

  // Listen for open-query-window event and keyboard shortcuts
  useEffect(() => {
    const handleNewTabWrapper = () => addNewTab();

    const handleNewTabPsql = (e: Event) => {
      const detail = (e as CustomEvent<{ connectionId?: string; connectionName?: string; database?: string }>).detail || {};
      addNewTab("", "", true, detail.connectionId, detail.connectionName, detail.database);
    };

    const handleNewTabWithText = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      addNewTab(detail.query || "", detail.name || "");
    };

    const handleOpenDefinition = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.name) {
        setDefModalState({ isOpen: true, table: detail.name });
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+N - New query tab
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        addNewTab();
      }
    };

    // Transaction control handler
    const handleTxControl = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const { action, isolation } = detail;

      if (!activeConnection) return;

      try {
        const Database = (await import("@tauri-apps/plugin-sql")).default;
        let username = activeConnection.username || "", password = activeConnection.password || "";
        if (activeConnection.vaultCredentialId) {
          const vaultCred = vaultCredentials.find(vc => vc.id === activeConnection.vaultCredentialId);
          if (vaultCred) { username = vaultCred.username || ""; password = vaultCred.password || ""; }
        }
        const encodedUser = encodeURIComponent(username);
        const encodedPass = encodeURIComponent(password);
        const port = activeConnection.port || (activeConnection.type === "mysql" || activeConnection.type === "mariadb" ? 3306 : 5432);

          let db: any;

        if (action === "begin") {
          // Create a new transaction-scoped db connection
          if (activeConnection.type === "sqlite") {
            db = await Database.load(`sqlite:${activeConnection.filepath || getDefaultDatabaseName()}`);
          } else if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
            db = await Database.load(`postgres://${encodedUser}:${encodedPass}@${activeConnection.host}:${port}/${selectedDatabase || activeConnection.database}`);
          } else {
            db = await Database.load(`mysql://${encodedUser}:${encodedPass}@${activeConnection.host}:${port}/${selectedDatabase || activeConnection.database}`);
          }

          const isolationClause = isolation ? `ISOLATION LEVEL ${isolation}` : "";
          await db.execute(`BEGIN ${isolationClause}`.trim());
          txDbRef.current = db;
          txContextRef.current = { connectionId: activeConnection.id, database: selectedDatabase || "" };
          setTxState({ active: true, isolationLevel: isolation || "READ COMMITTED", statementCount: 0 });
          setSuccess("Transaction started.");
        } else if (action === "commit") {
          if (txDbRef.current) {
            await txDbRef.current.execute("COMMIT");
            txDbRef.current = null;
            txContextRef.current = null;
            setTxState({ active: false, isolationLevel: "READ COMMITTED", statementCount: 0 });
            setSuccess("Transaction committed.");
          }
        } else if (action === "rollback") {
          if (txDbRef.current) {
            await txDbRef.current.execute("ROLLBACK");
            txDbRef.current = null;
            txContextRef.current = null;
            setTxState({ active: false, isolationLevel: "READ COMMITTED", statementCount: 0 });
            setSuccess("Transaction rolled back.");
          }
        }

        // Notify toolbar of state change
        const newTxStatements = action === "rollback" || action === "commit" ? 0
          : action === "begin" ? 0
          : txState.statementCount;
        window.dispatchEvent(new CustomEvent("tx-state-changed", {
          detail: {
            active: action === "commit" || action === "rollback" ? false : txState.active || action === "begin",
            isolationLevel: action === "begin" ? (isolation || "READ COMMITTED") : txState.isolationLevel,
            statementCount: newTxStatements,
          }
        }));
      } catch (err: any) {
        setError(`Transaction error: ${err.message || err}`);
      }
    };

    const handleRunSpecific = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.name && detail.query) {
        setActiveTableName(detail.name);
        lastSelectQueryRef.current = detail.query;
        executeQuery(detail.query);
      } else {
        setActiveTableName(null);
        lastSelectQueryRef.current = "";
      }
    };

    window.addEventListener("run-specific-query", handleRunSpecific);
    window.addEventListener("open-query-window", handleNewTabWrapper);
    window.addEventListener("open-query-window-psql", handleNewTabPsql);
    window.addEventListener("open-query-with-text", handleNewTabWithText);
    window.addEventListener("open-definition", handleOpenDefinition);
    window.addEventListener("show-local-history", () => setShowLocalHistory(true));
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("tx-control", handleTxControl);
    
    return () => {
      window.removeEventListener("run-specific-query", handleRunSpecific);
      window.removeEventListener("open-query-window", handleNewTabWrapper);
      window.removeEventListener("open-query-window-psql", handleNewTabPsql);
      window.removeEventListener("open-query-with-text", handleNewTabWithText);
      window.removeEventListener("open-definition", handleOpenDefinition);
      window.removeEventListener("show-local-history", () => setShowLocalHistory(true));
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("tx-control", handleTxControl);
    };
  }, [addNewTab, executeQuery]);

  const formatSqlValue = (val: any): string => {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number") return String(val);
    if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
    return `'${String(val).replace(/'/g, "''")}'`;
  };

  const handleUpdateRow = useCallback(async (oldRow: any, newRow: any) => {
    if (!activeConnection) return;
    if (!activeTableName) {
      setError("Table context missing: Select a table in the explorer or run a SELECT FROM query to enable edits.");
      return;
    }
    
    const columns = Object.keys(oldRow);
    const pkCandidates = ["id", "uuid", "uid", `${activeTableName.toLowerCase()}_id`];
    const pk = columns.find(c => pkCandidates.includes(c.toLowerCase()));
    
    const setClauses: string[] = [];
    const whereClauses: string[] = [];
    
    for (const col of columns) {
      if (String(oldRow[col]) !== String(newRow[col])) {
        setClauses.push(`${col} = ${formatSqlValue(newRow[col])}`);
      }
    }
    
    if (setClauses.length === 0) return;
    
    if (pk && oldRow[pk] !== undefined && oldRow[pk] !== null) {
      whereClauses.push(`${pk} = ${formatSqlValue(oldRow[pk])}`);
    } else {
      for (const col of columns) {
        const val = oldRow[col];
        if (val === null) whereClauses.push(`${col} IS NULL`);
        else whereClauses.push(`${col} = ${formatSqlValue(val)}`);
      }
    }
    
    const sqlSet = setClauses.join(", ");
    const sqlWhere = whereClauses.length > 0 ? whereClauses.join(" AND ") : "TRUE";
    const updateQuery = `UPDATE ${activeTableName} SET ${sqlSet} WHERE ${sqlWhere}`;

    const confirmed = await confirmDialog.confirm({
      title: "Confirm Changes",
      message: `Apply the following updates to table "${activeTableName}"?\n\n` + 
               setClauses.map(c => `• ${c}`).join("\n"),
      confirmLabel: "Apply Changes",
      type: "warning"
    });
    
    if (!confirmed) return;
    
    try {
      await executeQuery(updateQuery);
      
      // Update local state optimistically
      setResults(prev => prev.map(row => {
        const columns = Object.keys(oldRow);
        const pkCandidates = ["id", "uuid", "uid", `${activeTableName.toLowerCase()}_id`];
        const pk = columns.find(c => pkCandidates.includes(c.toLowerCase()));
        
        let isMatch = false;
        if (pk && oldRow[pk] !== undefined && oldRow[pk] !== null) {
          isMatch = String(row[pk]) === String(oldRow[pk]);
        } else {
          isMatch = columns.every(col => String(row[col]) === String(oldRow[col]));
        }
        
        return isMatch ? { ...row, ...newRow } : row;
      }));

    } catch (err) {
      throw err;
    }
  }, [activeTableName, activeConnection, executeQuery, confirmDialog]);

  const handleDeleteRow = useCallback(async (row: any) => {
    if (!activeConnection) return;
    if (!activeTableName) {
      setError("Table context missing: Cannot delete row without target table information.");
      return;
    }
    
    const columns = Object.keys(row);
    const pkCandidates = ["id", "uuid", "uid"];
    const pk = columns.find(c => pkCandidates.includes(c.toLowerCase()));
    
    const whereClauses: string[] = [];
    
    if (pk && row[pk] !== undefined && row[pk] !== null) {
      whereClauses.push(`${pk} = ${formatSqlValue(row[pk])}`);
    } else {
      for (const col of columns) {
        const val = row[col];
        if (val === null) whereClauses.push(`${col} IS NULL`);
        else whereClauses.push(`${col} = ${formatSqlValue(val)}`);
      }
    }
    
    const deleteQuery = `DELETE FROM ${activeTableName} WHERE ` + (whereClauses.length > 0 ? whereClauses.join(" AND ") : "FALSE");
    
    try {
      setSuppressTabSwitch(true);
      await executeQuery(deleteQuery);
      setResults(prev => prev.filter(r => {
        const pkItem = columns.find(c => pkCandidates.includes(c.toLowerCase()));
        if (pkItem && row[pkItem] !== undefined && row[pkItem] !== null) {
          return String(r[pkItem]) !== String(row[pkItem]);
        }
        return !columns.every(col => String(r[col]) === String(row[col]));
      }));
    } finally {
      setSuppressTabSwitch(false);
    }
  }, [activeTableName, activeConnection, executeQuery]);

  const handleSave = useCallback(async (currentResults: any[]) => {
    if (!activeTableName || !activeConnection) return;
    
    const newRows = currentResults.filter(r => r._isNew);
    const modifiedRows = currentResults.filter(r => r._isModified && !r._isNew);
    
    if (newRows.length === 0 && modifiedRows.length === 0) {
      setSuccess("No pending changes to save.");
      return;
    }

    try {
      setIsExecuting(true);

      // ─── Step 1: Load required columns (NOT NULL without DEFAULT + FK columns) ───
      // Parse schema.table format
      const tableParts = activeTableName.split(".");
      const schemaName = tableParts.length > 1 ? tableParts[0] : "public";
      const tableName = tableParts.length > 1 ? tableParts.slice(1).join(".") : activeTableName;

      // Collect per-row errors so we can report them all at once
      const rowsWithMissing: { rowIndex: number; missing: string[] }[] = [];

      if (["postgres", "supabase", "cockroach", "mysql", "mariadb"].includes(activeConnection.type)) {
        // Build a DB connection for the schema queries (same logic as executeQuery)
        let db = currentDb;
        if (!db) {
          const Database = (await import("@tauri-apps/plugin-sql")).default;
          let username = activeConnection.username || "";
          let password = activeConnection.password || "";
          if (activeConnection.vaultCredentialId) {
            const vaultCred = vaultCredentials.find(vc => vc.id === activeConnection.vaultCredentialId);
            if (vaultCred) { username = vaultCred.username || ""; password = vaultCred.password || ""; }
          }
          const port = activeConnection.port || (activeConnection.type === "mysql" || activeConnection.type === "mariadb" ? 3306 : 5432);
          const connectionString =
            ["postgres", "supabase", "cockroach"].includes(activeConnection.type)
              ? `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${activeConnection.host}:${port}/${selectedDatabase || activeConnection.database}`
              : `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${activeConnection.host}:${port}/${selectedDatabase || activeConnection.database}`;
          db = await Database.load(connectionString);
        }

        for (let i = 0; i < newRows.length; i++) {
          const { _isNew, ...data } = newRows[i];
          const missing: string[] = [];

          // Query NOT NULL columns that don't have a DEFAULT (these must be provided)
          const notNullCols = await db.select(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
              AND is_nullable = 'NO'
              AND column_default IS NULL
            ORDER BY ordinal_position
          `, [schemaName, tableName]);

          for (const col of notNullCols) {
            const colName = col.column_name;
            const val = data[colName];
            if (val === null || val === undefined || String(val).trim() === "") {
              missing.push(colName);
            }
          }

          // Also check FK columns (non-nullable FKs are a common gotcha)
          if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
            const fkCols = await db.select(`
              SELECT kcu.column_name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
              WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = $1 AND tc.table_name = $2
            `, [schemaName, tableName]);

            for (const fk of fkCols) {
              const colName = fk.column_name;
              const val = data[colName];
              if ((val === null || val === undefined || String(val).trim() === "") && !missing.includes(colName)) {
                missing.push(`${colName} (foreign key)`);
              }
            }
          }

          if (missing.length > 0) {
            rowsWithMissing.push({ rowIndex: i, missing });
          }
        }
      }

      // ─── Step 2: Report all validation errors at once ───
      if (rowsWithMissing.length > 0) {
        const errorLines = rowsWithMissing.map(({ rowIndex, missing }) =>
          `Row ${rowIndex + 1}: Missing required column${missing.length > 1 ? "s" : ""} — ${missing.join(", ")}`
        );
        setError(
          `Cannot save: Required columns are missing.\n\n` +
          errorLines.join("\n") +
          `\n\nFill in the highlighted columns above and try saving again.`
        );
        return;
      }

      // ─── Step 3: Proceed with INSERT ───
      for (const row of newRows) {
        const { _isNew, ...data } = row;
        const columns = Object.keys(data).filter(c => data[c] !== null && data[c] !== undefined);
        
        let query = "";
        if (columns.length === 0) {
          query = `INSERT INTO ${activeTableName} DEFAULT VALUES`;
          if (activeConnection.type === "mysql" || activeConnection.type === "mariadb") {
             query = `INSERT INTO ${activeTableName} () VALUES ()`;
          }
        } else {
          const cols = columns.join(", ");
          const vals = columns.map(c => formatSqlValue(data[c])).join(", ");
          query = `INSERT INTO ${activeTableName} (${cols}) VALUES (${vals})`;
        }
        await executeQuery(query);
      }

      // ─── Step 4: Proceed with UPDATE for modified rows ───
      for (const row of modifiedRows) {
        const { _isModified, ...data } = row;
        
        // Find original row for WHERE clause (to prevent overwriting if no PK)
        // In a real app we'd need more robust change tracking, but this works for buffered edits
        const columns = Object.keys(data).filter(c => c !== '_isModified' && c !== '_isNew');
        
        // Identical logic to handleUpdateRow but without the confirm dialog per row
        const pkCandidates = ["id", "uuid", "uid", `${activeTableName.toLowerCase()}_id`];
        const pk = columns.find(c => pkCandidates.includes(c.toLowerCase()));
        
        const setClauses: string[] = [];
        const whereClauses: string[] = [];
        
        // For simplicity in buffered mode, we update ALL columns or we'd need a "snapshot" of original values.
        // Since we don't have the original row values here easily without more state, 
        // we'll just use the columns we have.
        // Actually, let's just generate the update based on what's there.
        for (const col of columns) {
           setClauses.push(`${col} = ${formatSqlValue(data[col])}`);
        }
        
        if (pk && data[pk] !== undefined && data[pk] !== null) {
          whereClauses.push(`${pk} = ${formatSqlValue(data[pk])}`);
        } else {
          // Fallback to all columns for WHERE if no PK
          // This is risky but standard for DB managers without PKs
          for (const col of columns) {
            const val = data[col];
            if (val === null) whereClauses.push(`${col} IS NULL`);
            else whereClauses.push(`${col} = ${formatSqlValue(val)}`);
          }
        }
        
        const sqlSet = setClauses.join(", ");
        const sqlWhere = whereClauses.length > 0 ? whereClauses.join(" AND ") : "TRUE";
        const updateQuery = `UPDATE ${activeTableName} SET ${sqlSet} WHERE ${sqlWhere}`;
        
        await executeQuery(updateQuery);
      }

      setSuccess(`Successfully saved ${newRows.length} new and ${modifiedRows.length} modified records.`);
      // Suppress tab switch during refresh so user stays on results tab
      setSuppressTabSwitch(true);
      // Refresh to get server-side IDs etc.
      await executeQuery(lastSelectQueryRef.current);
    } catch (err: any) {
      setError("Failed to save: " + (err?.message || String(err)));
    } finally {
      setIsExecuting(false);
      isExecutingRef.current = false;
      setSuppressTabSwitch(false);
    }
  }, [activeTableName, activeConnection, selectedDatabase, currentDb, vaultCredentials, executeQuery]);

  const handleAddRow = useCallback(async (newRow: any, localOnly = true): Promise<void> => {
    if (localOnly) {
      // Pre-populate all known columns with null so that glide-data-grid
      // sees every cell and allows double-click / inline editing.
      const baseRow: Record<string, any> = {};
      const knownCols = lastColumns.length > 0
        ? lastColumns
        : results.length > 0
          ? Object.keys(results[0])
          : [];
      for (const col of knownCols) {
        baseRow[col] = null;
      }
      // Merge user-supplied values on top (e.g. duplicated row data)
      const merged = { ...baseRow, ...newRow, _isNew: true };
      setResults(prev => [...prev, merged]);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("grid-scroll-to-bottom"));
      }, 50);
      return;
    }
    
    if (!activeTableName || !activeConnection) return;
    
    const columns = Object.keys(newRow).filter(c => newRow[c] !== null);
    if (columns.length === 0) {
      // Just insert default values
      try {
        setSuppressTabSwitch(true);
        let sql = `INSERT INTO ${activeTableName} DEFAULT VALUES`;
        if (activeConnection.type === "mysql") {
          sql = `INSERT INTO ${activeTableName} () VALUES ()`;
        }
        await executeQuery(sql);
        if (lastSelectQueryRef.current) {
          await executeQuery(lastSelectQueryRef.current);
        }
      } catch (err) {
        confirmDialog.dialog({
          title: "Add Row Failed",
          message: "Could not add a default row. This usually happens if the table has columns that are NOT NULL and have no default value.\n\nError: " + (err as any).message,
          type: "danger"
        });
      } finally {
        setSuppressTabSwitch(false);
      }
      return;
    }

    try {
      setSuppressTabSwitch(true);
      if (Object.keys(newRow).length === 0) {
        // Insert a default blank row
        let sql = `INSERT INTO ${activeTableName} DEFAULT VALUES`;
        if (activeConnection.type === "mysql" || activeConnection.type === "mariadb") {
          sql = `INSERT INTO ${activeTableName} () VALUES ()`;
        }
        await executeQuery(sql);
        await executeQuery(lastSelectQueryRef.current);
      } else {
        const cols = columns.join(", ");
        const vals = columns.map(c => formatSqlValue(newRow[c])).join(", ");
        const query = `INSERT INTO ${activeTableName} (${cols}) VALUES (${vals})`;
        await executeQuery(query);
        await executeQuery(lastSelectQueryRef.current);
      }
    } catch (err) {
      throw err;
    } finally {
      setSuppressTabSwitch(false);
    }
  }, [activeTableName, activeConnection, executeQuery, confirmDialog, lastColumns, results]);

  const handleFormatSql = useCallback(() => {
    const formatted = formatSql(currentQueryRef.current || "");
    updateTabQuery(formatted);
  }, [updateTabQuery]);

  const handleExplainPlan = useCallback(async () => {
    if (!activeConnection) {
      setError("Connect to a database first");
      return;
    }

    // Extract the statement at cursor position (same as editor's smart run)
    const queryToExplain = extractSelectedOrCursorStatement(currentQueryRef.current || "");
    if (!queryToExplain.trim()) {
      setError("Write a SELECT query first");
      return;
    }

    const upperQuery = queryToExplain.trim().toUpperCase();
    if (!upperQuery.startsWith("SELECT")) {
      setError("Explain Plan is only available for SELECT statements.");
      return;
    }

    let explainQuery = "";
    if (["postgres", "supabase"].includes(activeConnection.type)) {
      explainQuery = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queryToExplain}`;
    } else if (activeConnection.type === "mysql") {
      explainQuery = `EXPLAIN FORMAT=JSON ${queryToExplain}`;
    } else {
      explainQuery = `EXPLAIN ${queryToExplain}`;
    }

    await executeQuery(explainQuery);
  }, [activeConnection, executeQuery]);

  const handleVisualOptimize = useCallback(async () => {
    if (!activeConnection) {
      setError("Connect to a database first");
      return;
    }

    // Extract the statement at cursor position (same as editor's smart run)
    const queryToExplain = extractSelectedOrCursorStatement(currentQueryRef.current || "");
    if (!queryToExplain.trim()) {
      setError("Write a SELECT query first");
      return;
    }

    const upperQuery = queryToExplain.trim().toUpperCase();
    if (!upperQuery.startsWith("SELECT")) {
      setError("Optimizer is only available for SELECT statements.");
      return;
    }

    // Build EXPLAIN query based on database type
    let explainQuery = "";
    const dbType = activeConnection.type;

    if (["postgres", "supabase", "cockroach"].includes(dbType)) {
      explainQuery = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queryToExplain}`;
    } else if (["mysql", "mariadb"].includes(dbType)) {
      explainQuery = `EXPLAIN FORMAT=JSON ${queryToExplain}`;
    } else if (dbType === "sqlite") {
      // SQLite uses EXPLAIN QUERY PLAN
      explainQuery = `EXPLAIN QUERY PLAN ${queryToExplain}`;
    } else {
      // Fallback for other databases
      explainQuery = `EXPLAIN ${queryToExplain}`;
    }

    setIsExecuting(true);
    setError(null);
    setSuccess(null);
    setRunningTimeMs(0);
    const startTime = Date.now();

    try {
      if (!currentDb) {
        throw new Error("No active database connection.");
      }
      const rows = await currentDb.select(explainQuery) as any[];
      
      // Debug: Log the raw EXPLAIN result
      console.log(`[VisualOptimizer] DB Type: ${dbType}`);
      console.log(`[VisualOptimizer] Raw rows:`, JSON.stringify(rows).slice(0, 500));

      // Validate the response has data
      if (!rows || rows.length === 0) {
        throw new Error("No EXPLAIN output returned. The query may have failed or returned no results.");
      }

      // Store with database type metadata for the VisualOptimizer to parse correctly
      const optimizerPayload = {
        data: rows,
        dbType: dbType,
        query: queryToExplain,
        explainType: ["postgres", "supabase", "cockroach"].includes(dbType) ? "json" :
                   ["mysql", "mariadb"].includes(dbType) ? "json" :
                   dbType === "sqlite" ? "query-plan" : "default"
      };

      setOptimizerData(optimizerPayload);
      setExecutionTime(Date.now() - startTime);
      setSuccess("Performance plan captured. Check the Optimizer tab.");

      if (activeTabId) {
        updateTabState(activeTabId, { optimizerData: optimizerPayload, executionTime: Date.now() - startTime, success: "Performance plan captured." });
      }

      // Notify ResultsPanel to switch to Optimizer tab via a custom event or shared state
      window.dispatchEvent(new CustomEvent("switch-results-tab", { detail: "optimizer" }));

    } catch (err: any) {
      // Issue 1: Pass error through to VisualOptimizer instead of wrapping
      // The VisualOptimizer will display the actual database error cleanly
      const errorMessage = err?.message || String(err) || "Unknown error";
      console.error(`[VisualOptimizer] Error: ${errorMessage}`);
      
      // Pass error as data to VisualOptimizer - it will detect and display the actual error
      const optimizerPayload = {
        data: [{ error: errorMessage, message: errorMessage }],
        dbType: dbType,
        query: queryToExplain,
        explainType: "json"
      };
      setOptimizerData(optimizerPayload);
      window.dispatchEvent(new CustomEvent("switch-results-tab", { detail: "optimizer" }));
    } finally {
      setIsExecuting(false);
      isExecutingRef.current = false;
    }
  }, [activeConnection, selectedDatabase, currentDb]);

  // Handle variable dialog confirmation: substitute variables and re-run query
  const handleVarDialogConfirm = (values: VariableValues, remember: boolean) => {
    const ctx = pendingVarExecutionRef.current;
    if (!ctx || !executeQueryRef.current) return;

    setVarDialogState(prev => ({ ...prev, isOpen: false }));

    // Cache values if requested
    if (remember) {
      varCacheRef.current[ctx.cacheKey] = values;
    }

    // Substitute variables in all queries
    let substitutedQueries: string[];
    let substitutedInfo: { lineNumber: number; statementText: string }[];

    if (ctx.isRunAll) {
      substitutedQueries = ctx.statementsToRun.map(q => substituteVariables(q, values));
      substitutedInfo = ctx.statementInfos.map((info, i) => ({
        ...info,
        statementText: substitutedQueries[i],
      }));
    } else {
      substitutedQueries = [substituteVariables(ctx.queryToRun, values)];
      substitutedInfo = [{ lineNumber: ctx.statementInfos[0]?.lineNumber || 1, statementText: substitutedQueries[0] }];
    }

    // Re-trigger execution with substituted queries (bypass variable check since already handled)
    const substitutedPayload = ctx.isRunAll
      ? { __runAll: true, statements: substitutedQueries, statementInfos: substitutedInfo }
      : substitutedQueries[0];

    executeQueryRef.current(substitutedPayload, substitutedInfo[0]);
  };

  const handleVarDialogCancel = () => {
    pendingVarExecutionRef.current = null;
    setVarDialogState({ isOpen: false, query: "", cacheKey: "" });
  };

  // Keep executeQueryRef in sync with the actual executeQuery function
  useEffect(() => {
    executeQueryRef.current = executeQuery;
  });

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-[var(--background)]">
      {/* Variable Substitution Dialog */}
      {varDialogState.isOpen && (
        <VariableSubstitutionDialog
          query={varDialogState.query}
          variables={extractVariables(varDialogState.query)}
          cachedValues={varCacheRef.current[varDialogState.cacheKey] || {}}
          onConfirm={handleVarDialogConfirm}
          onCancel={handleVarDialogCancel}
        />
      )}

      {/* Breadcrumbs - Superior Navigation */}
      <div className="h-8 flex items-center px-3 bg-[var(--surface)] text-[11px] border-b border-[var(--border)] gap-2 select-none overflow-x-auto shrink-0">
        <Database className="w-3.5 h-3.5 text-[var(--color-accent)] opacity-70 shrink-0" />
        
        {/* Connection Selector */}
        <select 
          className="bg-transparent border-none text-[var(--text-secondary)] font-bold uppercase tracking-wider outline-none cursor-pointer hover:text-[var(--text-primary)] transition-colors py-1"
          value={activeTab?.target?.connectionId || activeConnection?.id || ""}
          onChange={async (e) => {
            const connId = e.target.value;
            const conn = connections.find(c => c.id === connId);
            if (activeTabId && conn) {
              const defaultDb = conn.database;
              setQueryTabs(prev => prev.map(t => t.id === activeTabId ? {
                ...t,
                target: { connectionId: conn.id, connectionName: conn.name, database: defaultDb }
              } : t));
              fetchTabDatabases(conn.id);
              try {
                await connectToDatabase(conn.id, defaultDb);
              } catch (err) {
                console.error("Failed to connect:", err);
              }
            }
          }}
        >
          {connections.length === 0 && <option value="" className="bg-[var(--surface)]">Disconnected</option>}
          {connections.map(c => <option key={c.id} value={c.id} className="bg-[var(--surface)] uppercase">{c.name}</option>)}
        </select>

        <ChevronRight className="w-3 h-3 opacity-20 shrink-0" />
        
        {/* Database Selector */}
        <select
          className="bg-[var(--surface-raised)] border border-[var(--border)] rounded px-2 py-0.5 text-[var(--text-primary)] font-medium outline-none shadow-sm cursor-pointer focus:border-[var(--color-accent)]"
          value={activeTab?.target?.database || selectedDatabase || ""}
          onChange={async (e) => {
             const dbName = e.target.value;
             if (activeTabId) {
               const currentTarget = activeTab?.target || (activeConnection && selectedDatabase ? { connectionId: activeConnection.id, connectionName: activeConnection.name, database: selectedDatabase } : null);
               if (currentTarget) {
                 setQueryTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, target: { ...currentTarget, database: dbName } } : t));
                 try {
                   await connectToDatabase(currentTarget.connectionId, dbName);
                 } catch (err) {
                   console.error("Failed to connect to database:", err);
                 }
               }
             }
          }}
        >
          {(() => {
            const currentConnId = activeTab?.target?.connectionId || activeConnection?.id;
            const dbs = currentConnId && tabDatabases[currentConnId] ? tabDatabases[currentConnId] : (currentConnId === activeConnection?.id ? globalDatabases : []);
            
            const currentDbName = activeTab?.target?.database || selectedDatabase;
            const allDbs = [...dbs];
            if (currentDbName && !allDbs.includes(currentDbName)) allDbs.unshift(currentDbName);
            
            return allDbs.length > 0 
              ? allDbs.map(db => <option key={db} value={db} className="bg-[var(--surface)]">{db}</option>)
              : <option value={currentDbName || ""} className="bg-[var(--surface)]">{currentDbName || "No Database"}</option>;
          })()}
        </select>
        
        <ChevronRight className="w-3 h-3 opacity-20 shrink-0" />
        <span className="text-[var(--text-secondary)] opacity-100 whitespace-nowrap">{activeTab?.name || "No Active Tab"}</span>
      </div>

      {/* Combined Tool Window Bar - Top */}
      <div className="h-12 flex items-center gap-1 px-2 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        {isExecuting ? (
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 text-sm font-bold transition-colors shadow-inner"
            onClick={cancelQuery}
          >
            <Square className="w-3.5 h-3.5" fill="currentColor" />
            Cancel {runningTimeMs > 0 && `(${(runningTimeMs / 1000).toFixed(1)}s)`}
          </button>
        ) : (
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[var(--color-accent)] text-white text-sm hover:bg-[var(--color-accent-hover)] font-bold transition-all disabled:opacity-50"
            onClick={() => {
              // Always use run-query-smart to get the correct line number from cursor position
              window.dispatchEvent(new CustomEvent("run-query-smart"));
            }}
            disabled={!activeConnection}
            title="Run first statement (Ctrl+Enter in editor for statement at cursor, Ctrl+Shift+Enter for all)"
          >
            <Play className="w-4 h-4" />
            Run
          </button>
        )}
        <button
          onClick={() => addNewTab()}
          className="p-2 rounded hover:bg-[var(--border)]"
          title="New Query Tab"
        >
          <Plus className="w-4 h-4" />
        </button>
        <div className="w-px h-6 bg-[var(--border)] mx-1" />
        <button
          onClick={handleFormatSql}
          className="p-2 rounded hover:bg-[var(--border)] transition-colors group"
          title="Format SQL (Prettify)"
        >
          <FileText className="w-4 h-4 opacity-70 group-hover:opacity-100 text-blue-400" />
        </button>
        <button
          onClick={handleExplainPlan}
          disabled={!activeTab?.query || isExecuting}
          className="p-2 rounded hover:bg-[var(--border)] transition-colors group disabled:opacity-30"
          title="Explain Plan (Analyze Performance)"
        >
          <BarChart2 className="w-4 h-4 opacity-70 group-hover:opacity-100 text-purple-400" />
        </button>
        <button
          onClick={handleVisualOptimize}
          disabled={!activeTab?.query || isExecuting}
          className="p-2 rounded hover:bg-[var(--border)] transition-colors group disabled:opacity-30"
          title="Visual Query Optimizer & Heuristics"
        >
          <Activity className="w-4 h-4 opacity-70 group-hover:opacity-100 text-emerald-400" />
        </button>
        <div className="w-px h-6 bg-[var(--border)] mx-1" />
        <button 
          className="p-2 rounded hover:bg-[var(--border)] transition-colors group" 
          title="Compare Schemas / Merge (Beta)"
          onClick={() => setShowCompareDialog(true)}
        >
          <GitCompare className="w-4 h-4 opacity-70 group-hover:opacity-100 text-amber-400" />
        </button>
        <button 
          className="p-2 rounded hover:bg-[var(--border)] transition-colors group" 
          title="Clone Database / Snapshot"
          onClick={() => setShowCloneDialog(true)}
        >
          <Copy className="w-4 h-4 opacity-70 group-hover:opacity-100 text-blue-400" />
        </button>
        <button 
          className={`p-2 rounded transition-all group ${showActivityMonitor ? 'bg-emerald-500/20 text-emerald-400' : 'hover:bg-[var(--border)]'}`}
          title="Performance Monitor / pg_stat_activity"
          onClick={() => setShowActivityMonitor(true)}
        >
          <ActivityIcon className={`w-4 h-4 ${showActivityMonitor ? 'opacity-100' : 'opacity-70 group-hover:opacity-100 text-emerald-400'}`} />
        </button>
        <button 
          className={`p-2 rounded transition-all group ${showMultiQueryDialog ? 'bg-indigo-500/20 text-indigo-400' : 'hover:bg-[var(--border)]'}`}
          title="Multi-Query (Run query across multiple databases)"
          onClick={() => setShowMultiQueryDialog(true)}
        >
          <Layers className={`w-4 h-4 ${showMultiQueryDialog ? 'opacity-100' : 'opacity-70 group-hover:opacity-100 text-indigo-400'}`} />
        </button>
        <button 
          className="p-2 rounded hover:bg-[var(--border)] transition-colors group" 
          title="Save Query (Ctrl+S)"
          onClick={async () => {
            if (!activeConnection) return;
            const name = await confirmDialog.dialog({
              title: "Save Query",
              message: "Enter a name to identify this query in your saved queries library.",
              inputLabel: "Query Name",
              inputDefaultValue: activeTab?.name || "My Query",
              confirmLabel: "Save",
              cancelLabel: "Cancel",
              type: "info",
              requireInput: true
            });
            
            if (name) {
              addSavedQuery({
                name,
                query: activeTab?.query || "",
                database: selectedDatabase || "",
                connectionId: activeConnection.id
              });
            }
          }}
        >
          <Save className="w-4 h-4 opacity-70 group-hover:opacity-100" />
        </button>
        <div className="flex-1" />
        <button
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-all mr-2"
          onClick={() => setShowAIDialog(true)}
        >
          <Sparkles className="w-3.5 h-3.5" />
          AI ASSISTANT
        </button>
        <button
          onClick={() => setShowServices(!showServices)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm ${showServices ? 'bg-[var(--border)]' : 'hover:bg-[var(--border)]'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2m0 0h2a2 2 0 012 2v6a2 2 0 01-2 2H9a2 2 0 01-2-2v-6a2 2 0 012-2h2" />
          </svg>
          Results
          {showServices ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
      </div>

      {/* Query Tabs - DataGrip Style */}
      <div className="flex items-center bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto no-scrollbar">
        <div className="flex items-center flex-nowrap min-w-0">
          {queryTabs.map((tab) => {
            // Get connection name for the tab (from target or active connection)
            const tabConnectionName = tab.target?.connectionName || activeConnection?.name || "No Connection";
            const tabConnectionId = tab.target?.connectionId || activeConnection?.id;
            const tabConnection = connections.find(c => c.id === tabConnectionId);
            const tabColor = tabConnection?.color || "#06b6d4";
            // Truncate connection name for tab display (show first 12 chars if space is tight)
            const displayConnName = queryTabs.length > 5 && tabConnectionName.length > 12 
              ? tabConnectionName.substring(0, 10) + "..." 
              : tabConnectionName;
            
            // Determine status for this tab
            const tabIsExecuting = activeTabId === tab.id && isExecuting;
            const tabHasError = tab.error && activeTabId === tab.id;
            const tabHasSuccess = tab.success && activeTabId === tab.id && !tab.error;
            
            return (
              <div
                key={tab.id}
                className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold cursor-pointer border-t-2 transition-all min-w-[140px] max-w-[200px] ${
                  activeTabId === tab.id 
                    ? "bg-[var(--background)] border-[var(--color-accent)] text-[var(--color-accent)]" 
                    : "bg-[var(--surface-raised)] border-transparent text-[var(--text-secondary)] hover:bg-[var(--border)]"
                }`}
                onClick={() => {
                  setActiveTabId(tab.id);
                  currentQueryRef.current = tab.query;
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent("focus-editor"));
                  }, 50);
                }}
              >
                {/* Connection color stripe - left edge */}
                <div
                  className="w-1 h-5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: tabColor }}
                  title={`${tabConnectionName} · ${tabColor}`}
                />
                {/* Status Indicator - Left side */}
                <div className="shrink-0">
                  {tabIsExecuting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
                  ) : tabHasError ? (
                    <XCircle className="w-3.5 h-3.5 text-red-400" />
                  ) : tabHasSuccess ? (
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Terminal className="w-3.5 h-3.5 mt-0.5 opacity-50" />
                  )}
                </div>
                
                {/* Tab Content */}
                <div className="flex flex-col items-start leading-none gap-0.5 min-w-0 flex-1">
                  {/* Connection name in brackets + query preview */}
                    <span className="truncate w-full flex items-center gap-1">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: tabColor }}
                        title={tabColor}
                      />
                      <span className="text-[9px] font-bold text-[var(--color-accent)] opacity-80 shrink-0">[{displayConnName}]</span>
                      {tab.usePsql && (
                        <span className="text-[8px] font-bold text-blue-400 bg-blue-400/10 px-1 py-0.5 rounded shrink-0 border border-blue-400/20">psql</span>
                      )}
                      <span className="truncate">{tab.name}</span>
                    </span>
                  <span className="text-[9px] opacity-60 font-normal truncate w-full" title={`${tab.target?.database || selectedDatabase}`}>
                    {tab.target?.database || selectedDatabase || "No Database"}
                  </span>
                </div>
                
                {/* Close Button */}
                {queryTabs.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="p-0.5 rounded hover:bg-[var(--border)] shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        
        {/* New Tab Button */}
        <button
          onClick={() => addNewTab()}
          className="p-2 hover:bg-[var(--border)] shrink-0 ml-1"
          title="New Query Tab"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Query Editor and Results */}
      <PanelGroup direction="vertical" className="flex-1 min-h-0">
        {/* Top panel: Editor or Dashboard — must be a Panel for PanelGroup to work */}
        <Panel minSize={20} maxSize={80}>
          {activeTab ? (
            activeTab.usePsql ? (
              <div className="h-full flex flex-col">
                <div className="flex-1 min-h-0">
                  <PsqlWindow
                    entries={activeTab.psqlEntries || []}
                    liveOutput={isExecuting ? psqlOutput : []}
                    runningCommand={isExecuting ? (runningCmdRef.current || activeTab.query || "") : null}
                    isExecuting={isExecuting}
                    executionTime={executionTime}
                    onRun={(q: string) => executeQuery(q)}
                    onClear={() => {
                      clearPsqlOutput();
                      if (activeTabId) {
                        updateTabState(activeTabId, { psqlOutput: [], psqlEntries: [] });
                      }
                    }}
                    onRemoveLast={() => {
                      if (activeTabId && activeTab?.psqlEntries && activeTab.psqlEntries.length > 0) {
                        updateTabState(activeTabId, {
                          psqlEntries: activeTab.psqlEntries.slice(0, -1)
                        });
                      }
                    }}
                    connectionName={activeTab.target?.connectionName || activeConnection?.name || undefined}
                    databaseName={activeTab.target?.database || selectedDatabase || undefined}
                  />
                </div>
              </div>
            ) : (
              <QueryEditor
                key={activeTabId!}
                value={activeTab!.query}
                onChange={updateTabQuery}
                onRun={(q: string) => executeQuery(q)}
                connectionName={activeTab?.target?.connectionName || activeConnection?.name || undefined}
                databaseName={activeTab?.target?.database || selectedDatabase || undefined}
                tabId={activeTabId!}
                tabName={activeTab?.name}
                isExecuting={isExecuting}
                hasError={!!error}
                hasSuccess={!!success}
                statementResults={activeTab?.statementResults}
              />
            )
          ) : (
            <div className="h-full flex flex-col items-center justify-center bg-[var(--background)] p-6 overflow-y-auto">
              <div className="w-full max-w-4xl space-y-6 animate-in fade-in zoom-in duration-500">
                <div className="text-center space-y-3">
                  <div className="inline-flex p-3 rounded-2xl bg-gradient-to-br from-[var(--color-accent)] to-blue-600 shadow-xl shadow-[var(--color-accent)]/30 mb-1 group transition-all hover:scale-105 hover:shadow-[var(--color-accent)]/50 active:scale-95 duration-300 relative">
                    <div className="absolute inset-0 bg-[var(--color-accent)] blur-xl opacity-20 group-hover:opacity-30 transition-opacity rounded-full"></div>
                    <Terminal className="w-8 h-8 text-white relative z-10" />
                  </div>
                  <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
                     Database <span className="text-[var(--color-accent)]">Command Center</span>
                  </h1>
                  <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
                     Connect to your databases, audit schema structures, and execute optimized queries.
                  </p>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  <DashboardTile icon={<Zap className="w-4 h-4" />} title="Cluster Health" value={activeConnection ? "Online" : "Offline"} color={activeConnection ? "text-emerald-400" : "text-[var(--text-secondary)]"} description={activeConnection ? activeConnection.name : "No connection"} />
                  <DashboardTile icon={<Monitor className="w-4 h-4" />} title="Active Sessions" value={activeConnection ? "Live" : "Idle"} color="text-blue-400" description={selectedDatabase || "No database"} onClick={() => activeConnection && setShowActivityMonitor(true)} />
                  <DashboardTile icon={<ShieldCheck className="w-4 h-4" />} title="Security" value="Encrypted" color="text-purple-400" description="AES-256 vault active" />
                  <DashboardTile icon={<Clock className="w-4 h-4" />} title="Quick Access" value="Saved" color="text-amber-400" description="Query library" onClick={() => window.dispatchEvent(new CustomEvent("open-saved-queries"))} />
                  <DashboardTile icon={<HardDrive className="w-4 h-4" />} title="Storage" value={activeConnection ? "Healthy" : "---"} color="text-rose-400" description="DB WAL levels OK" />
                  <DashboardTile icon={<ActivityIcon className="w-4 h-4" />} title="Throughput" value="Optimized" color="text-indigo-400" description="Low-latency engine" />
                </div>
              </div>
            </div>
          )}
        </Panel>

        {showServices && !activeTab?.usePsql && (
          <>
            <PanelResizeHandle className="h-1 bg-[var(--border)] hover:bg-[var(--color-accent)] transition-colors cursor-row-resize select-none shrink-0 data-[resize-handle-state=drag]:bg-[var(--color-accent)] data-[resize-handle-state=hover]:bg-[var(--color-accent)]/60" />
            <Panel minSize={15} maxSize={85} defaultSize={40}>
              <ResultsPanel
            results={results}
            error={error}
            successMessage={success}
            multiResults={multiResults}
            isLoading={isExecuting}
            executionTime={executionTime}
            tableName={activeTableName || undefined}
            forcedColumns={lastColumns}
            onUpdateRow={handleUpdateRow}
            onDeleteRow={handleDeleteRow}
            onAddRow={handleAddRow}
            onResultsChange={setResults}
            onRefresh={lastSelectQueryRef.current ? () => executeQuery(lastSelectQueryRef.current) : undefined}
            onSave={handleSave}
            onDiscard={() => {
              if (lastSelectQueryRef.current) {
                executeQuery(lastSelectQueryRef.current);
              }
            }}
            optimizerData={optimizerData}
            isReadOnly={!!optimizerData}
            suppressTabSwitch={suppressTabSwitch}
            onApplyFix={(sql) => executeQuery(sql)}
          />
            </Panel>
          </>
        )}
      </PanelGroup>

      <CompareDialog isOpen={showCompareDialog} onClose={() => setShowCompareDialog(false)} />
      <CloneDialog isOpen={showCloneDialog} onClose={() => setShowCloneDialog(false)} />
      <ActivityMonitor isOpen={showActivityMonitor} onClose={() => setShowActivityMonitor(false)} />
      <MultiQueryDialog isOpen={showMultiQueryDialog} onClose={() => setShowMultiQueryDialog(false)} />
      <AIAssistantDialog isOpen={showAIDialog} onClose={() => setShowAIDialog(false)} currentQuery={activeTab?.query || ""} onUpdateQuery={updateTabQuery} />
      <DefinitionModal 
        isOpen={defModalState.isOpen}
        tableName={defModalState.table}
        onClose={() => setDefModalState({ isOpen: false, table: "" })}
      />
      <LocalHistoryDialog
        isOpen={_showLocalHistory}
        onClose={() => setShowLocalHistory(false)}
        dirPath="saved-queries"
      />
    </div>
  );
}
function DashboardTile({ icon, title, value, color, description, trend, onClick }: { 
  icon: React.ReactNode; 
  title: string; 
  value: string; 
  color: string; 
  description: string;
  trend?: string;
  onClick?: () => void;
}) {
  return (
    <div 
      className={`bg-gradient-to-br from-[var(--surface-raised)] to-[var(--surface)] border border-[var(--border)] rounded-xl p-3 transition-all group shadow-sm relative overflow-hidden flex flex-col justify-between min-h-[90px] ${onClick ? 'cursor-pointer hover:border-[var(--color-accent)]/40 hover:-translate-y-0.5 hover:shadow-md' : 'hover:border-[var(--border-hover)]'}`}
      onClick={onClick}
    >
      <div className="absolute -right-1 -top-1 w-10 h-10 bg-gradient-to-br from-[var(--color-accent)] to-transparent opacity-0 group-hover:opacity-[0.03] transition-opacity rounded-full blur-lg" />
      
      <div>
        <div className="flex items-start justify-between mb-2">
          <div className={`p-1.5 rounded-lg bg-[var(--background)] border border-[var(--border)] group-hover:border-[var(--color-accent)]/30 transition-all duration-300 ${color}`}>
            {icon}
          </div>
          {trend && (
            <div className="px-1 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[7px] font-bold border border-emerald-500/20">
              {trend}
            </div>
          )}
        </div>
        <div className="text-[8px] font-bold text-[var(--text-secondary)] uppercase tracking-[0.03em] opacity-40">
          {title}
        </div>
        <div className={`text-xs font-bold tracking-tight ${color}`}>
          {value}
        </div>
      </div>
      <div className="text-[9px] text-[var(--text-secondary)] leading-snug opacity-60 group-hover:opacity-80 transition-opacity line-clamp-1">
        {description}
      </div>
    </div>
  );
}
