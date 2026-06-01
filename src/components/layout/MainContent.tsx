import { useState, useEffect, useRef, useCallback, Suspense, lazy } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ResultsPanel } from "../results/ResultsPanel";
import { useConnections } from "../../contexts/useConnections";
import { useQueryHistory } from "../../store/queryHistoryStore";
import { useSettings } from "../../store/settingsStore";
import { Play, Plus, X, ChevronDown, ChevronRight, Terminal, Database, Sparkles, GitCompare, Save, Square, Activity, Loader2, CheckCircle, XCircle, Copy as CopyIcon, FolderOpen, Clipboard, Pencil } from "lucide-react";
import { useSavedQueries } from "../../store/savedQueryStore";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { Copy, FileText, BarChart2, Activity as ActivityIcon, Layers, Table } from "lucide-react";
import { EmptyStateLauncher } from "./EmptyStateLauncher";
import { logger } from "../../utils/logger";
import { getDefaultDatabaseName } from "../../config/app";
import { splitStatements } from "../../utils/splitStatements";
import { applyQueryLimit } from "../../utils/applyQueryLimit";
import { VariableSubstitutionDialog, extractVariables, substituteVariables, VariableValues } from "../ui/VariableSubstitutionDialog";
import { useLocalHistory } from "../../store/localHistoryStore";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/Select";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { quoteIdentifier, type DatabaseType } from "../../utils/sqlSecurity";

// Lazy-loaded editor — Monaco (core + SQL contribution) is the single
// heaviest dependency in the app. Pulling QueryEditor out of the cold-start
// bundle lets the rest of the shell paint immediately; the editor pane
// shows a brief placeholder, then fills in once Monaco is parsed.
const QueryEditor = lazy(() => import("../editor/QueryEditor").then(m => ({ default: m.QueryEditor })));

// Lazy-loaded modal/conditional dialogs — none of these need to be in the
// cold-start bundle. CompareDialog, DefinitionModal, and MultiQueryDialog
// each pull in their own Monaco instance; AIAssistantDialog and
// ActivityMonitor pull substantial sub-trees. They're only mounted when
// their open flag flips true (see render block below).
const CompareDialog = lazy(() => import("../tools/CompareDialog").then(m => ({ default: m.CompareDialog })));
const AIAssistantDialog = lazy(() => import("../tools/AIAssistantDialog").then(m => ({ default: m.AIAssistantDialog })));
const DefinitionModal = lazy(() => import("../tools/DefinitionModal").then(m => ({ default: m.DefinitionModal })));
const CloneDialog = lazy(() => import("../tools/CloneDialog").then(m => ({ default: m.CloneDialog })));
const ActivityMonitor = lazy(() => import("../tools/ActivityMonitor").then(m => ({ default: m.ActivityMonitor })));
const MultiQueryDialog = lazy(() => import("../tools/MultiQueryDialog").then(m => ({ default: m.MultiQueryDialog })));
const ERDDialog = lazy(() => import("../tools/ERDDialog").then(m => ({ default: m.ERDDialog })));
const PsqlWindow = lazy(() => import("../ui/PsqlWindow").then(m => ({ default: m.PsqlWindow })));
const LocalHistoryDialog = lazy(() => import("../ui/LocalHistoryDialog").then(m => ({ default: m.LocalHistoryDialog })));

export interface QueryTab {
  id: string;
  name: string;
  query: string;
  /**
   * Snapshot of `query` when the tab was opened or last saved.
   * Used by `isTabDirty` (src/utils/editorDirty.ts) to gate the
   * "you have unsaved queries" prompt on app exit (issue #121).
   */
  originalQuery?: string;
  /**
   * When the tab was opened from a saved query, this tracks which saved
   * query it belongs to. Used to refresh originalQuery across all tabs
   * sharing the same saved query when one tab saves (issue #138).
   */
  savedQueryName?: string;
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
  /** Whether extended display (\x) is enabled for this tab's PSQL console */
  psqlExpanded?: boolean;
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
  const { connections, folders, activeConnection, selectedDatabase, currentDb, vaultCredentials, databases: globalDatabases, connectToDatabase, initialLoadDone } = useConnections();
  const { addQuery } = useQueryHistory();
  const settings = useSettings();
  // Gates the query toolbar, tab strip, and results panel. Until a database
  // is picked, the main pane shows EmptyStateLauncher instead of disabled
  // chrome. See #84.
  const isDatabaseReady = !!activeConnection && !!selectedDatabase;
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
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const showToastMessage = useCallback((msg: string) => {
    setToastMessage(msg);
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2000);
  }, []);
  /** Raw psql stdout lines — only populated when running via CLI */
  const [psqlOutput, setPsqlOutput] = useState<string[]>([]);
  const psqlOutputRef = useRef<string[]>([]);
  // Retain the last non-empty psqlOutput so PsqlWindow's live section doesn't
  // go blank before psqlEntries are committed (WebView2 on Windows can split
  // React 18's batch, creating a frame where neither liveOutput nor entries
  // carries the result).
  const stashPsqlOutputRef = useRef<string[]>([]);
  // Wrapper to keep ref and state in sync
  const appendPsqlOutput = (linesOrFn: string[] | ((prev: string[]) => string[])) => {
    const next = typeof linesOrFn === 'function' ? linesOrFn(psqlOutputRef.current) : [...psqlOutputRef.current, ...linesOrFn];
    psqlOutputRef.current = next;
    setPsqlOutput(next);
    stashPsqlOutputRef.current = next;
  };
  const clearPsqlOutput = () => {
    psqlOutputRef.current = [];
    setPsqlOutput([]);
    stashPsqlOutputRef.current = [];
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
  // Refs for activeConnection/selectedDatabase to avoid stale closures in addNewTab
  const activeConnRef = useRef(activeConnection);
  const selectedDbRef = useRef(selectedDatabase);
  const connectionsRef = useRef(connections);
  const foldersRef = useRef(folders);
  useEffect(() => { activeConnRef.current = activeConnection; }, [activeConnection]);
  useEffect(() => { selectedDbRef.current = selectedDatabase; }, [selectedDatabase]);
  useEffect(() => { connectionsRef.current = connections; }, [connections]);
  useEffect(() => { foldersRef.current = folders; }, [folders]);
  const [activeTableName, setActiveTableName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  /**
   * Column name -> SQL type for the current table-backed result set, plus the
   * table name those types belong to. Populated when the explorer opens a
   * known table (the explorer dispatches `run-specific-query` with a
   * `columnTypes` payload). When the active table later changes to something
   * else (e.g. user ran an ad-hoc query targeting a different table), the
   * types are invalidated by a useEffect below so the grid falls back to
   * the column-name heuristic rather than mislabeling unrelated columns.
   * See issue #51.
   */
  const [tableColumnTypes, setTableColumnTypes] = useState<
    { tableName: string; types: Record<string, string> } | undefined
  >(undefined);
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
  const [showERDDialog, setShowERDDialog] = useState(false);
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

  // Auto-save: debounced .sql file writer (#122).
  // On every query change, the debounce resets. When the user stops typing
  // for `autoSaveInterval` seconds, all tabs' current text is written to
  // `<autoSavePath>/{folderName}_{dbName}_{shortId}.sql`.
  // If autoSavePath is empty, falls back to `<appDataDir>/auto-save/`.
  // The folderName comes from the connection's parent folder (if any) or the
  // connection name; dbName from the selected database; shortId from the tab id.
  const autoSaveLastRef = useRef<Map<string, string>>(new Map());
  const autoSaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!settings.autoSaveEnabled) return;
    if (autoSaveDebounceRef.current) clearTimeout(autoSaveDebounceRef.current);
    const ms = Math.max(5000, settings.autoSaveInterval * 1000);
    autoSaveDebounceRef.current = setTimeout(async () => {
      const tabs = queryTabsRef.current;
      if (tabs.length === 0) return;
      try {
        const { join } = await import("@tauri-apps/api/path");
        const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
        let dir: string;
        if (settings.autoSavePath) {
          dir = settings.autoSavePath;
        } else {
          const { appDataDir } = await import("@tauri-apps/api/path");
          const base = await appDataDir();
          dir = await join(base, "auto-save");
        }
        await mkdir(dir, { recursive: true });
        const lastSaved = autoSaveLastRef.current;
        const writtenIds: string[] = [];
        for (const tab of tabs) {
          if (!tab.query || tab.query.trim() === "") continue;
          if (lastSaved.get(tab.id) === tab.query) continue;
          try {
            const conn = connectionsRef.current.find(
              c => c.id === (tab.target?.connectionId || activeConnRef.current?.id),
            );
            const folder = conn?.folderId
              ? foldersRef.current.find(f => f.id === conn.folderId)
              : null;
            const folderPart = (folder?.name || conn?.name || "unknown")
              .replace(/[^a-zA-Z0-9_-]/g, "_");
            const dbPart = (tab.target?.database || selectedDbRef.current || "none")
              .replace(/[^a-zA-Z0-9_-]/g, "_");
            const shortId = tab.id.slice(0, 8);
            const filePath = await join(dir, `${folderPart}_${dbPart}_${shortId}.sql`);
            await writeTextFile(filePath, tab.query);
            lastSaved.set(tab.id, tab.query);
            writtenIds.push(tab.id);
          } catch (e) {
            logger.error(`Auto-save failed for tab ${tab.id}:`, e);
          }
        }
        if (writtenIds.length > 0) {
          setQueryTabs(prev => prev.map(tab =>
            writtenIds.includes(tab.id) ? { ...tab, originalQuery: tab.query } : tab
          ));
        }
      } catch (e) {
        logger.error("Auto-save failed:", e);
      }
    }, ms);
    return () => {
      if (autoSaveDebounceRef.current) clearTimeout(autoSaveDebounceRef.current);
    };
  }, [settings.autoSaveEnabled, settings.autoSaveInterval, settings.autoSavePath, queryTabs]);

  async function getTabAutoSavePath(tab: QueryTab): Promise<string | null> {
    if (!tab.query || tab.query.trim() === "") return null;
    try {
      const { join } = await import("@tauri-apps/api/path");
      let dir: string;
      if (settings.autoSavePath) {
        dir = settings.autoSavePath;
      } else {
        const { appDataDir } = await import("@tauri-apps/api/path");
        dir = await appDataDir().then((b: string) => join(b, "auto-save"));
      }
      const conn = connectionsRef.current.find(
        c => c.id === (tab.target?.connectionId || activeConnRef.current?.id),
      );
      const folder = conn?.folderId
        ? foldersRef.current.find(f => f.id === conn.folderId)
        : null;
      const folderPart = (folder?.name || conn?.name || "unknown")
        .replace(/[^a-zA-Z0-9_-]/g, "_");
      const dbPart = (tab.target?.database || selectedDbRef.current || "none")
        .replace(/[^a-zA-Z0-9_-]/g, "_");
      const shortId = tab.id.slice(0, 8);
      return await join(dir, `${folderPart}_${dbPart}_${shortId}.sql`);
    } catch {
      return null;
    }
  }

  /** Cross-platform clipboard write: uses the modern async API first, falls
   *  back to execCommand('copy') for platforms where the async API isn't
   *  available (e.g. WebKitGTK on Linux). */
  async function copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to execCommand
    }
    // execCommand fallback — works in all webview engines (WebKitGTK,
    // WebView2, WKWebView) despite being technically deprecated.
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.top = "-9999px";
    el.setAttribute("readonly", "");
    document.body.appendChild(el);
    el.focus();
    el.select();
    try {
      document.execCommand("copy");
    } catch {
      // clipboard write failed on all paths
    }
    document.body.removeChild(el);
  }

  async function openTabFileInExplorer(tab: QueryTab): Promise<void> {
    // Resolve path and parent directory; handle empty tabs by using the
    // auto-save directory as fallback parent.
    let path: string | null = null;
    let parentDir: string | null = null;

    try {
      const { join, dirname, appDataDir } = await import("@tauri-apps/api/path");

      path = await getTabAutoSavePath(tab);
      if (path) {
        parentDir = await dirname(path);
      } else {
        parentDir = settings.autoSavePath
          ? settings.autoSavePath
          : await appDataDir().then((b: string) => join(b, "auto-save"));
      }

      const { mkdir } = await import("@tauri-apps/plugin-fs");
      if (parentDir) {
        await mkdir(parentDir, { recursive: true });
      }
    } catch {
      showToastMessage("Could not prepare file manager path");
    }

    if (path) {
      try {
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
        await revealItemInDir(path);
        return;
      } catch {
        showToastMessage("Could not reveal file, opening parent folder");
      }
    }

    if (parentDir) {
      try {
        const { openPath } = await import("@tauri-apps/plugin-opener");
        await openPath(parentDir);
        return;
      } catch {
        showToastMessage("Could not open file manager");
      }
    } else {
      showToastMessage("Could not open file manager");
    }
  }

  // Close tab context menu on outside click / Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      setContextMenu(null);
    };
    // Delay adding the listener so the menu's own render + click doesn't close itself
    const id = setTimeout(() => {
      document.addEventListener("click", handler);
      document.addEventListener("keydown", handler);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [contextMenu]);

  const qid = (name: string) => quoteIdentifier(name, (activeConnection?.type || "postgres") as DatabaseType);

  // ── Session persistence: restore open tabs on startup ────────────────────
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (!initialLoadDone) return;
    if (sessionRestoredRef.current) return;
    sessionRestoredRef.current = true;
    (async () => {
      try {
        const { invokeCmd } = await import("../../lib/ipc");
        const data = await invokeCmd("load_sessions");
        if (data.tabs.length === 0) return;
        const restored: QueryTab[] = data.tabs.map((t: any) => ({
          id: t.id,
          name: t.name,
          query: t.query ?? "",
          originalQuery: t.originalQuery ?? t.query ?? "",
          savedQueryName: t.savedQueryName,
          target: t.targetConnectionId
            ? { connectionId: t.targetConnectionId, connectionName: t.targetConnectionName || "", database: t.targetDatabase || "" }
            : undefined,
          usePsql: t.usePsql ?? false,
        }));
        setQueryTabs(restored);
        if (data.activeTabId && restored.some((t) => t.id === data.activeTabId)) {
          setActiveTabId(data.activeTabId);
        }
        tabCounterRef.current = restored.length + 1;
        logger.debug(`Restored ${restored.length} tabs from session`);
      } catch (e) {
        logger.debug("No saved session to restore:", e);
      }
    })();
  }, [initialLoadDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Session persistence: save tabs whenever they change ──────────────────
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = setTimeout(async () => {
      try {
        const { invokeCmd } = await import("../../lib/ipc");
        const tabs = queryTabs.map((t) => ({
          id: t.id,
          name: t.name,
          query: t.query ?? "",
          originalQuery: t.originalQuery,
          savedQueryName: t.savedQueryName,
          targetConnectionId: t.target?.connectionId,
          targetConnectionName: t.target?.connectionName,
          targetDatabase: t.target?.database,
          usePsql: t.usePsql ?? false,
        }));
        await invokeCmd("save_sessions", { tabs, activeTabId });
      } catch (e) {
        logger.debug("Failed to save session:", e);
      }
    }, 500);
    return () => {
      if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    };
  }, [queryTabs, activeTabId]);

  // Issue #51: invalidate the cached column-types when the active table
  // changes away from the one those types were collected for. An ad-hoc
  // query targeting a different table will reset `activeTableName` via
  // `executeQuery`; without this clear, stale types would mislabel cells.
  useEffect(() => {
    if (tableColumnTypes && tableColumnTypes.tableName !== activeTableName) {
      setTableColumnTypes(undefined);
    }
  }, [activeTableName, tableColumnTypes]);

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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
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
          // Mark the active tab as in-sync with persisted state so the
          // unsaved-changes prompt on app exit (#121) won't fire for it.
          // Also refresh originalQuery on any other tabs opened from the
          // same saved query so they reflect the latest persisted text (#138).
          if (activeTabIdRef.current) {
            setQueryTabs(prev => prev.map(t => {
              if (t.id === activeTabIdRef.current) {
                return { ...t, name, savedQueryName: name, originalQuery: queryToSave };
              }
              if (t.savedQueryName && t.savedQueryName === name) {
                return { ...t, originalQuery: queryToSave };
              }
              return t;
            }));
          }
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
    savedQueryName?: string,
  ) => {
    tabCounterRef.current += 1;

    // Resolve which connection/database to target:
    // 1. Explicit params from context-menu events (most reliable)
    // 2. Currently selected in the sidebar as fallback (via ref to avoid stale closure)
    const activeConn = activeConnRef.current;
    const selectedDb = selectedDbRef.current;
    const resolvedConnectionId = explicitConnectionId || activeConn?.id;
    const resolvedConnectionName = explicitConnectionName || activeConn?.name;
    const resolvedDatabase = explicitDatabase || selectedDb;

    const newTab: QueryTab = {
      id: crypto.randomUUID(),
      name: name || `Query ${tabCounterRef.current}`,
      query,
      // Snapshot original text so isTabDirty can detect unsaved edits.
      // For blank tabs this is "" (empty stays clean until typed into);
      // for tabs opened from a saved query this is the saved body.
      originalQuery: query,
      savedQueryName,
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

  const closeOthers = useCallback((tabId: string) => {
    setQueryTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      if (!tab) return prev;
      if (!prev.find((t) => t.id !== tabId)) return prev;
      setActiveTabId(tab.id);
      return [tab];
    });
  }, []);

  const closeAll = useCallback(() => {
    setQueryTabs([]);
    setActiveTabId(null);
  }, []);

  // Extract the single statement at cursor position, or selected text
// Mirrors QueryEditor's "smart run" logic
const extractSelectedOrCursorStatement = (fullText: string): string => {
  // If there's a selection in progress, we can't know here - just get first statement
  // The executeQuery function handles selection from editor
  const statements = fullText.split(';').map(s => s.trim()).filter(s => s.length > 0);
  return statements.length > 0 ? statements[0] : fullText;
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

    // Extract single statement from full query — used when no specific query
    // is provided (e.g. toolbar Run button without selection). Uses the
    // context-aware splitter so a semicolon inside a string, dollar-quoted
    // body, or comment is not treated as a statement terminator.
    const extractSingleStatement = (query: string): string => {
      const parts = splitStatements(query);
      return parts.length > 0 ? parts[0].text : query;
    };

    // Check if this is an explicit "run all" request from Ctrl+Shift+Enter.
    // We may also *promote* a plain string selection to run-all below if it
    // turns out to contain multiple top-level statements (issue #20).
    let isRunAll = !!(specificQuery && typeof specificQuery === 'object' && specificQuery.__runAll);
    let statementsToRun: string[] = isRunAll ? specificQuery.statements : [];
    let statementInfos: { lineNumber: number; statementText: string }[] = isRunAll
      ? specificQuery.statementInfos
      : (statementInfo ? [statementInfo] : []);

    // Read from the provided specific text block, otherwise fallback to the global ref
    let finalQueryText = "";
    if (isRunAll) {
      // Use the joined script as the "display" text — never sent to the
      // server as one piece; the loop further down runs each statement
      // individually. Keeping this non-empty satisfies the queryToRun
      // guard below and gives downstream code (history snapshot, table
      // name match) a meaningful string to inspect.
      finalQueryText = statementsToRun.join(";\n");
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

    // Issue #20: if a plain-string selection actually contains multiple
    // top-level statements, promote it to the multi-statement loop.
    // PostgreSQL's extended query protocol (which the Tauri SQL plugin uses)
    // rejects multi-statement prepared queries with "cannot insert multiple
    // commands into a prepared statement", and the libpq path further down
    // sends one execute() per statement only when isRunAll is set.
    if (!isRunAll && typeof specificQuery === "string") {
      const parts = splitStatements(queryToRun);
      if (parts.length > 1) {
        isRunAll = true;
        statementsToRun = parts.map(p => p.text);
        statementInfos = parts.map(p => ({ lineNumber: p.lineNumber, statementText: p.text }));
      }
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
    // Match the first identifier after FROM/JOIN/UPDATE/INTO, handling:
    //   - Quoted identifiers: "MyTable", "my_schema"."MyTable"
    //   - Schema-qualified: schema.table
    //   - Excludes CTE aliases and subqueries
    const tableNameMatch = queryToRun.match(/(?:FROM|JOIN|UPDATE|INTO)\s+(?:"([^"]+)"(?:\."([^"]+)")?|([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?))\b/i);
    if (tableNameMatch) {
      let detectedTable = "";
      if (tableNameMatch[1]) {
        detectedTable = tableNameMatch[2]
          ? `${tableNameMatch[1]}.${tableNameMatch[2]}`
          : tableNameMatch[1];
      } else if (tableNameMatch[3]) {
        detectedTable = tableNameMatch[3];
      }
      // Only update if it looks like a simple table name and not a complex subquery
      if (detectedTable && !detectedTable.startsWith("(")) {
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

        const initialDatabase = targetConn ? targetConn.database : selectedDatabase;
        let currentCliDatabase = initialDatabase || "";
        let currentPsqlExpanded = currentTab?.psqlExpanded ?? false;
        
        // Resolve major version from three sources (most reliable first):
        // 1. Stale-check: re-detect from live libpq connection if currentDb is available
        // 2. Pre-stored: serverMajorVersion captured on connect
        // 3. System binary as last resort
        let majorVersion: number | null = actualConnection.serverMajorVersion || null;
        logger.debug("[CLI Path] Initial majorVersion:", majorVersion);

        if (majorVersion === null && currentDb) {
          logger.debug("[CLI Path] Detecting major version via currentDb.select...");
          try {
            const verRows = await currentDb.select("SELECT (regexp_matches(version(), E'^PostgreSQL (\\d+)'))[1]::int AS major") as any[];
            majorVersion = verRows[0]?.major || null;
            logger.debug("[CLI Path] SQL check result:", majorVersion);
          } catch (e) {
            logger.debug("[CLI Path] SQL check failed:", e);
          }
        }

        // Still no version → check for system psql in PATH
        if (majorVersion === null) {
          logger.debug("[CLI Path] Falling back to system tool detection...");
          const sysTool = await cliStore.checkSystemTool("postgresql");
          logger.debug("[CLI Path] System tool available:", sysTool.available);
          if (sysTool.available) {
            majorVersion = 0;
          }
        }

        // Still no version known — bail out with a clear error
        if (majorVersion === null) {
          const msg = "PostgreSQL version unknown. Connect to the database first so QueryDen can detect the server version.";
          appendPsqlOutput([`ERROR: ${msg}`]);
          setError(msg);
          if (currentTabId) {
            const errEntry: PsqlConsoleEntry = {
              id: crypto.randomUUID(),
              command: runningCmdRef.current || queryToRun,
              outputLines: psqlOutputRef.current.length > 0 ? [...psqlOutputRef.current] : [`ERROR: ${msg}`],
              hasErrors: true,
              executionTime: 0,
            };
            updateTabState(currentTabId, {
              psqlEntries: [...(currentTab?.psqlEntries || []), errEntry],
              psqlOutput: [],
            });
            psqlOutputRef.current = [];
            setPsqlOutput([]);
          }
          setIsExecuting(false);
      isExecutingRef.current = false;
          return;
        }

        logger.debug("[CLI Path] Final majorVersion to use:", majorVersion);
        let toolStatus = await cliStore.checkTool("postgresql", majorVersion);
        logger.debug("[CLI Path] Tool status (checkTool):", toolStatus);

        if (toolStatus.needsDownload) {
          // Auto-download is available (MySQL, Mongo, Redis) — prompt user
          const filename = toolStatus.downloadFilename || `psql-${majorVersion}.tar.gz`;
          const confirmed = await confirmDialog.confirm({
            title: "Download CLI Tool",
            message: `The CLI tool for version ${majorVersion} is not installed.\n\nDownload "${filename}"?`,
            confirmLabel: "Download",
            type: "info",
          });
          if (!confirmed) {
            const errMsg = "CLI tool download cancelled.";
            appendPsqlOutput([`ERROR: ${errMsg}`]);
            setError(errMsg);
            if (currentTabId) {
              const errEntry: PsqlConsoleEntry = {
                id: crypto.randomUUID(),
                command: runningCmdRef.current || queryToRun,
                outputLines: psqlOutputRef.current.length > 0 ? [...psqlOutputRef.current] : [`ERROR: ${errMsg}`],
                hasErrors: true,
                executionTime: 0,
              };
              updateTabState(currentTabId, {
                psqlEntries: [...(currentTab?.psqlEntries || []), errEntry],
                psqlOutput: [],
              });
              psqlOutputRef.current = [];
              setPsqlOutput([]);
            }
            setIsExecuting(false);
      isExecutingRef.current = false;
            return;
          }
          appendPsqlOutput([`Downloading CLI tool ${majorVersion}...`]);
          try {
            await cliStore.downloadVersion("postgresql", majorVersion);
            appendPsqlOutput([`CLI tool ${majorVersion} downloaded and ready.`]);
          } catch (dlErr: any) {
            const msg = `Download failed: ${dlErr.message || String(dlErr)}`;
            appendPsqlOutput([`ERROR: ${msg}`]);
            setError(msg);
            if (currentTabId) {
              const errEntry: PsqlConsoleEntry = {
                id: crypto.randomUUID(),
                command: runningCmdRef.current || queryToRun,
                outputLines: psqlOutputRef.current.length > 0 ? [...psqlOutputRef.current] : [`ERROR: ${msg}`],
                hasErrors: true,
                executionTime: 0,
              };
              updateTabState(currentTabId, {
                psqlEntries: [...(currentTab?.psqlEntries || []), errEntry],
                psqlOutput: [],
              });
              psqlOutputRef.current = [];
              setPsqlOutput([]);
            }
            setIsExecuting(false);
      isExecutingRef.current = false;
            return;
          }
        } else if (!toolStatus.available) {
          // Tool not available and cannot be auto-downloaded — show install guide
          // with a "Check Again" retry loop so users can install and retry
          // without closing/reopening the PSQL tab.
          const installHint = toolStatus.installHint || "PostgreSQL client (psql) not found. Please install it and restart QueryDen.";
          while (!toolStatus.available) {
            const shouldOpenPage = await confirmDialog.confirm({
              title: "psql Not Found",
              message: installHint,
              confirmLabel: "Open Download Page",
              cancelLabel: "Check Again",
              type: "info",
            });
            if (shouldOpenPage) {
              try {
                const { openUrl } = await import("@tauri-apps/plugin-opener");
                await openUrl("https://www.postgresql.org/download/");
              } catch (e) {
                logger.error("[CLI Path] Failed to open URL:", e);
              }
              appendPsqlOutput([`ERROR: ${installHint}`]);
              setError("psql not found");
              if (currentTabId) {
                const errEntry: PsqlConsoleEntry = {
                  id: crypto.randomUUID(),
                  command: runningCmdRef.current || queryToRun,
                  outputLines: psqlOutputRef.current.length > 0 ? [...psqlOutputRef.current] : [`ERROR: ${installHint}`],
                  hasErrors: true,
                  executionTime: 0,
                };
                updateTabState(currentTabId, {
                  psqlEntries: [...(currentTab?.psqlEntries || []), errEntry],
                  psqlOutput: [],
                });
                psqlOutputRef.current = [];
                setPsqlOutput([]);
              }
              setIsExecuting(false);
              isExecutingRef.current = false;
              return;
            }
            // User clicked "Check Again" — re-check after potential install
            toolStatus = await cliStore.checkTool("postgresql", majorVersion);
          }
          // Fall through to execute when psql is now available
        }
        
        const cliHost = actualConnection.host || "localhost";
        // currentCliDatabase is already defined above, potentially updated by \c command
        logger.debug("[CLI Path] Using database for execution:", currentCliDatabase);
        
        // Helper: execute a single statement via CLI and return normalized rows/columns + stdout
        const cliExecStmt = async (stmt: string, wantRows: boolean, isExpanded: boolean, dbName: string) => {
          logger.debug("[cliExecStmt] Executing:", stmt, "Expanded:", isExpanded, "DB:", dbName);
          const result = await cliStore.executeQuery(
            "postgresql", stmt, cliHost, port, dbName, username, password, majorVersion, isExpanded
          );
          logger.debug("[cliExecStmt] Result received from cliStore:", { 
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
        const handlePsqlMetaCommand = async (stmt: string): Promise<boolean> => {
          const trimmed = stmt.trim();
          
          // \c (connect)
          const connectMatch = trimmed.match(/^\\(?:c|connect)\s+([\w"$.]+)\s*$/i);
          if (connectMatch) {
            const newDb = connectMatch[1].replace(/"/g, '');

            // Verify connection before switching
            try {
              await cliStore.testConnection("postgresql", cliHost, port, newDb, username, password, majorVersion);

              currentCliDatabase = newDb;
              logger.debug("[CLI Path] Statement level \\c:", newDb);
              if (currentTabId) {
                updateTabState(currentTabId, {
                  target: {
                    connectionId: actualConnection.id,
                    connectionName: actualConnection.name || "",
                    database: newDb
                  }
                });
              }
              appendPsqlOutput([`You are now connected to database "${newDb}" as user "${username}".`]);
            } catch (err: any) {
              const errMsg = err.message || String(err);
              appendPsqlOutput([`psql: error: \\connect: ${errMsg}`]);
              logger.error("[CLI Path] \\c failed:", errMsg);
            }
            return true;
          }

          // \x (expanded)
          const expandedMatch = trimmed.match(/^\\x(?:\s+(on|off))?\s*$/i);
          if (expandedMatch) {
            const mode = expandedMatch[1]?.toLowerCase();
            if (mode === "on") currentPsqlExpanded = true;
            else if (mode === "off") currentPsqlExpanded = false;
            else currentPsqlExpanded = !currentPsqlExpanded;

            logger.info("[CLI Path] Statement level \\x:", currentPsqlExpanded);
            if (currentTabId) {
              updateTabState(currentTabId, { psqlExpanded: currentPsqlExpanded });
            }
            appendPsqlOutput([`Expanded display is ${currentPsqlExpanded ? 'on' : 'off'}.`]);
            return true;
          }

          return false;
        };

        if (isRunAll && statementsToRun.length > 0) {
          for (let i = 0; i < statementsToRun.length; i++) {
            if (cancelFlagRef.current) break;
            const stmt = statementsToRun[i];

            // Handle meta-commands (\c, \x) entirely in the frontend; don't pass to psql.
            if (await handlePsqlMetaCommand(stmt)) {
              continue;
            }

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
                const { rows: stmtRows, columns: stmtCols } = await cliExecStmt(limitedStmt, true, currentPsqlExpanded, currentCliDatabase);
                const safeRows = stmtRows ?? [];
                multiResults.push({ query: stmt, rows: safeRows, columns: stmtCols, rowsAffected: safeRows.length, lineNumber });
                statementResults.push({ lineNumber, status: 'success', rowCount: safeRows.length, executionTime: Date.now() - stmtStartTime });
              } else {
                const { rowsAffected: affected } = await cliExecStmt(stmt, false, currentPsqlExpanded, currentCliDatabase);
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
              if (currentTabId) {
                const errEntry: PsqlConsoleEntry = {
                  id: crypto.randomUUID(),
                  command: runningCmdRef.current || queryToRun,
                  outputLines: psqlOutputRef.current.length > 0 ? [...psqlOutputRef.current] : [`ERROR: ${msg}`],
                  hasErrors: true,
                  executionTime: 0,
                };
                updateTabState(currentTabId, {
                  psqlEntries: [...(currentTab?.psqlEntries || []), errEntry],
                  psqlOutput: [],
                });
                psqlOutputRef.current = [];
                setPsqlOutput([]);
              }
              setIsExecuting(false);
              isExecutingRef.current = false;
              return;
            }

            appendPsqlOutput([`Watching: ${queryToWatch} (every ${intervalSec}s). Press Stop to cancel.`]);
            
            while (!cancelFlagRef.current && isExecutingRef.current) {
              try {
                // psql \watch typically shows the grid output repeatedly
                await cliExecStmt(queryToWatch, true, currentPsqlExpanded, currentCliDatabase);
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
            
            // Commit accumulated watch output as a persistent entry
            if (currentTabId) {
              const watchCmd = runningCmdRef.current || queryToRun;
              const watchOutput = psqlOutputRef.current;
              const watchEntry: PsqlConsoleEntry = {
                id: crypto.randomUUID(),
                command: watchCmd,
                outputLines: watchOutput.length > 0 ? [...watchOutput] : ["(watch cancelled)"],
                hasErrors: watchOutput.some(l => l.startsWith("ERROR:") || l.startsWith("FATAL:")),
                executionTime: Date.now() - startTime,
              };
              updateTabState(currentTabId, {
                psqlEntries: [...(currentTab?.psqlEntries || []), watchEntry],
                psqlOutput: [],
              });
              psqlOutputRef.current = [];
              setPsqlOutput([]);
            }
            setIsExecuting(false);
            isExecutingRef.current = false;
            return;
          }

          try {
            // Handle \c, \x entirely in the frontend; flush confirmation message and exit.
            if (await handlePsqlMetaCommand(queryToRun)) {
              if (currentTabId) {
                const currentOutput = psqlOutputRef.current;
                const newEntry: PsqlConsoleEntry = {
                  id: crypto.randomUUID(),
                  command: runningCmdRef.current || queryToRun,
                  outputLines: [...currentOutput],
                  hasErrors: currentOutput.some(l => l.startsWith("psql: error:")),
                  executionTime: Date.now() - startTime,
                };
                updateTabState(currentTabId, {
                  psqlEntries: [...(currentTab?.psqlEntries || []), newEntry],
                  psqlOutput: [],
                });
                psqlOutputRef.current = [];
                setPsqlOutput([]);
              }
              setIsExecuting(false);
              isExecutingRef.current = false;
              return;
            }

            if (isSelect) {
              const limitedQuery = applyQueryLimit(queryToRun, settings.maxRowsToDisplay);
              const { rows: cliRows, columns: cliCols } = await cliExecStmt(limitedQuery, true, currentPsqlExpanded, currentCliDatabase || "");
              rows = cliRows ?? [];
              rowsAffected = rows.length;
              statementResults.push({ lineNumber: stmtInfo.lineNumber, status: 'success', rowCount: rowsAffected, executionTime: Date.now() - stmtStartTime });
              // Store columns for the ResultPanel
              if (currentTabId) updateTabState(currentTabId, { statementResults, columns: cliCols ?? [] });
              setLastColumns(cliCols ?? []);
            } else {
              const { rowsAffected: affected } = await cliExecStmt(queryToRun, false, currentPsqlExpanded, currentCliDatabase || "");
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
                psqlOutputRef.current = [];
                setPsqlOutput([]);
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
    const handleNewTabWrapper = (e: Event) => {
      const detail = (e as CustomEvent<{ connectionId?: string; connectionName?: string; database?: string }>).detail || {};
      addNewTab("", "", false, detail.connectionId, detail.connectionName, detail.database);
    };

    const handleNewTabPsql = (e: Event) => {
      const detail = (e as CustomEvent<{ connectionId?: string; connectionName?: string; database?: string }>).detail || {};
      addNewTab("", "", true, detail.connectionId, detail.connectionName, detail.database);
    };

    const handleNewTabWithText = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      addNewTab(detail.query || "", detail.name || "", false, undefined, undefined, undefined, detail.savedQueryName);
    };

    const handleOpenDefinition = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.name) {
        setDefModalState({ isOpen: true, table: detail.name });
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;
      // Ctrl+N or Cmd+N - New query tab
      if (isMod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        addNewTab();
      }
    };

    // Ctrl+PageUp / Ctrl+PageDown tab cycling (#139)
    const handleSwitchToPreviousTab = () => {
      const tabs = queryTabsRef.current;
      if (tabs.length <= 1) return;
      const currentIndex = tabs.findIndex((t) => t.id === activeTabIdRef.current);
      const prevIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
      const prevTab = tabs[prevIndex];
      setActiveTabId(prevTab.id);
      currentQueryRef.current = prevTab.query;
      setTimeout(() => window.dispatchEvent(new CustomEvent("focus-editor")), 50);
    };

    const handleSwitchToNextTab = () => {
      const tabs = queryTabsRef.current;
      if (tabs.length <= 1) return;
      const currentIndex = tabs.findIndex((t) => t.id === activeTabIdRef.current);
      const nextIndex = currentIndex >= tabs.length - 1 ? 0 : currentIndex + 1;
      const nextTab = tabs[nextIndex];
      setActiveTabId(nextTab.id);
      currentQueryRef.current = nextTab.query;
      setTimeout(() => window.dispatchEvent(new CustomEvent("focus-editor")), 50);
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
        // Issue #51: when the explorer opens a known table it passes the
        // column -> SQL type map so the data grid can pick the date/time
        // overlay editor by real type rather than by column-name substring.
        // Tag the types with the table they belong to so a later table change
        // invalidates them (see effect on `activeTableName` below).
        if (detail.columnTypes) {
          setTableColumnTypes({ tableName: detail.name, types: detail.columnTypes });
        } else {
          setTableColumnTypes(undefined);
        }
        lastSelectQueryRef.current = detail.query;
        executeQuery(detail.query);
      } else {
        setActiveTableName(null);
        setTableColumnTypes(undefined);
        lastSelectQueryRef.current = "";
      }
    };

    const handleShowLocalHistory = () => setShowLocalHistory(true);

    window.addEventListener("run-specific-query", handleRunSpecific);
    window.addEventListener("open-query-window", handleNewTabWrapper);
    window.addEventListener("open-query-window-psql", handleNewTabPsql);
    window.addEventListener("open-query-with-text", handleNewTabWithText);
    window.addEventListener("open-definition", handleOpenDefinition);
    window.addEventListener("show-local-history", handleShowLocalHistory);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("switch-to-previous-tab", handleSwitchToPreviousTab);
    window.addEventListener("switch-to-next-tab", handleSwitchToNextTab);
    window.addEventListener("tx-control", handleTxControl);

    return () => {
      window.removeEventListener("run-specific-query", handleRunSpecific);
      window.removeEventListener("open-query-window", handleNewTabWrapper);
      window.removeEventListener("open-query-window-psql", handleNewTabPsql);
      window.removeEventListener("open-query-with-text", handleNewTabWithText);
      window.removeEventListener("open-definition", handleOpenDefinition);
      window.removeEventListener("show-local-history", handleShowLocalHistory);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("switch-to-previous-tab", handleSwitchToPreviousTab);
      window.removeEventListener("switch-to-next-tab", handleSwitchToNextTab);
      window.removeEventListener("tx-control", handleTxControl);
    };
  }, [addNewTab, executeQuery]);

  // ── Unsaved queries: intercept window close (issue #121) ─────────────
  // When the user triggers an OS-level close (X button, Alt+F4, Cmd+Q,
  // taskbar Close) and any query editor tab is dirty, prompt before
  // letting the window die. Standard untrusted-close pattern.
  const queryTabsRef = useRef<QueryTab[]>([]);
  useEffect(() => { queryTabsRef.current = queryTabs; }, [queryTabs]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        // Lazy import keeps editorDirty out of the cold-start chunk too.
        const { getDirtyTabs } = await import("../../utils/editorDirty");
        if (cancelled) return;
        unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          // Save the current session before close so tabs are restored on next open.
          try {
            const { invokeCmd } = await import("../../lib/ipc");
            const tabs = queryTabsRef.current.map((t) => ({
              id: t.id,
              name: t.name,
              query: t.query ?? "",
          originalQuery: t.originalQuery ?? t.query ?? "",
              savedQueryName: t.savedQueryName,
              targetConnectionId: t.target?.connectionId,
              targetConnectionName: t.target?.connectionName,
              targetDatabase: t.target?.database,
              usePsql: t.usePsql ?? false,
            }));
            await invokeCmd("save_sessions", { tabs, activeTabId: activeTabIdRef.current ?? null });
          } catch { /* non-critical */ }

          const dirty = getDirtyTabs(queryTabsRef.current);
          if (dirty.length === 0) return; // let the window close

          // Build a human-readable list of dirty tabs. Use the tab's name as-is
          // (e.g. "Query 3") rather than guessing "Untitled" — the auto-numbered
          // names ARE the user-facing identifiers in the tab strip.
          const MAX = 5;
          const names = dirty.slice(0, MAX).map(t => t.name || "Untitled").map(n => `  • ${n}`);
          const remaining = dirty.length > MAX ? `\n  …and ${dirty.length - MAX} more` : "";
          const body =
            `You have unsaved changes in ${dirty.length} query tab${dirty.length === 1 ? "" : "s"}:\n\n` +
            names.join("\n") + remaining + "\n\nDiscard them and exit?";

          // Block the OS-level close until the user resolves the prompt.
          event.preventDefault();

          const discard = await confirmDialog.confirm({
            title: "Unsaved queries",
            message: body,
            confirmLabel: "Discard",
            cancelLabel: "Cancel",
            type: "danger",
          });

          if (discard) {
            // Overwrite the session with clean state so these tabs don't
            // re-prompt on next startup — the user chose to discard,
            // so the persisted snapshot should treat current content
            // as the new authoritative baseline (issue #121, #138).
            try {
              const { invokeCmd } = await import("../../lib/ipc");
              const cleanTabs = queryTabsRef.current.map((t) => ({
                id: t.id,
                name: t.name,
                query: t.query ?? "",
                originalQuery: t.query ?? "",
                savedQueryName: t.savedQueryName,
                targetConnectionId: t.target?.connectionId,
                targetConnectionName: t.target?.connectionName,
                targetDatabase: t.target?.database,
                usePsql: t.usePsql ?? false,
              }));
              await invokeCmd("save_sessions", { tabs: cleanTabs, activeTabId: activeTabIdRef.current ?? null });
            } catch { /* non-critical */ }
            try {
              await getCurrentWindow().destroy();
            } catch (err) {
              logger.error("Failed to close window after Discard:", err);
            }
          }
          // Cancel → do nothing; preventDefault above keeps the app alive.
        });
      } catch (err) {
        // Outside Tauri (vitest, plain browser) — skip silently.
        logger.debug("onCloseRequested not available:", err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [confirmDialog]);

  // ── Unsaved queries: intercept webview reload (right-click → Reload, F5, Ctrl+R) ──
  // The Tauri `onCloseRequested` only handles OS-level close (X button, Alt+F4).
  // Beforeunload catches browser-style reloads that skip the onCloseRequested path.
  // Since beforeunload is synchronous, we pre-import getDirtyTabs into a ref.
  const getDirtyTabsRef = useRef<(tabs: any[]) => any[]>(() => []);
  useEffect(() => {
    import("../../utils/editorDirty").then((m) => {
      getDirtyTabsRef.current = m.getDirtyTabs;
    });
  }, []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      const dirty = getDirtyTabsRef.current(queryTabsRef.current);
      if (dirty.length > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

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
        setClauses.push(`${qid(col)} = ${formatSqlValue(newRow[col])}`);
      }
    }
    
    if (setClauses.length === 0) return;
    
    if (pk && oldRow[pk] !== undefined && oldRow[pk] !== null) {
      whereClauses.push(`${qid(pk)} = ${formatSqlValue(oldRow[pk])}`);
    } else {
      for (const col of columns) {
        const val = oldRow[col];
        if (val === null) whereClauses.push(`${qid(col)} IS NULL`);
        else whereClauses.push(`${qid(col)} = ${formatSqlValue(val)}`);
      }
    }
    
    const sqlSet = setClauses.join(", ");
    const sqlWhere = whereClauses.length > 0 ? whereClauses.join(" AND ") : "TRUE";
    const updateQuery = `UPDATE ${qid(activeTableName)} SET ${sqlSet} WHERE ${sqlWhere}`;

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
    
    const { _isNew, _isModified, ...cleanRow } = row;
    const columns = Object.keys(cleanRow);
    const pkCandidates = ["id", "uuid", "uid"];
    const pk = columns.find(c => pkCandidates.includes(c.toLowerCase()));
    
    const whereClauses: string[] = [];
    
    if (pk && cleanRow[pk] !== undefined && cleanRow[pk] !== null) {
      whereClauses.push(`${qid(pk)} = ${formatSqlValue(cleanRow[pk])}`);
    } else {
      for (const col of columns) {
        const val = cleanRow[col];
        if (val === null) whereClauses.push(`${qid(col)} IS NULL`);
        else whereClauses.push(`${qid(col)} = ${formatSqlValue(val)}`);
      }
    }
    
    const deleteQuery = `DELETE FROM ${qid(activeTableName)} WHERE ` + (whereClauses.length > 0 ? whereClauses.join(" AND ") : "FALSE");
    
    try {
      setSuppressTabSwitch(true);
      await executeQuery(deleteQuery);
      setResults(prev => prev.filter(r => {
        const pkItem = columns.find(c => pkCandidates.includes(c.toLowerCase()));
        if (pkItem && cleanRow[pkItem] !== undefined && cleanRow[pkItem] !== null) {
          return String(r[pkItem]) !== String(cleanRow[pkItem]);
        }
        return !columns.every(col => String(r[col]) === String(cleanRow[col]));
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
      // Suppress tab switch during the entire save flow so intermediate
      // INSERT/UPDATE executeQuery calls don't switch to the Messages tab.
      setSuppressTabSwitch(true);

      // ─── Step 1: Build a DB connection for the save operation ───
      // Respect the active tab's target database, same as executeQuery does.
      // Also respect the target connection's own credentials (host, port, type)
      // when the tab's target points to a different connection than the
      // globally active one. Without this, INSERT/UPDATE would use the wrong
      // database or wrong server credentials.
      const activeTab = queryTabs.find(t => t.id === activeTabId);
      const targetConn = activeTab?.target;
      const saveConn = targetConn
        ? connections.find(c => c.id === targetConn.connectionId)
        : activeConnection;
      const saveDbName = targetConn?.database || selectedDatabase || activeConnection.database;
      const conn = saveConn || activeConnection;
      let username = conn.username || "";
      let password = conn.password || "";
      if (conn.vaultCredentialId) {
        const vaultCred = vaultCredentials.find(vc => vc.id === conn.vaultCredentialId);
        if (vaultCred) { username = vaultCred.username || ""; password = vaultCred.password || ""; }
      }
      const encodedUser = encodeURIComponent(username);
      const encodedPass = encodeURIComponent(password);
      const port = conn.port || (conn.type === "mysql" || conn.type === "mariadb" ? 3306 : 5432);
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      let connectionString = "";
      let db: any;
      if (conn.type === "sqlite") {
        connectionString = `sqlite:${conn.filepath || "queryden.db"}`;
      } else if (["postgres", "supabase", "cockroach"].includes(conn.type)) {
        connectionString = `postgres://${encodedUser}:${encodedPass}@${conn.host}:${port}/${saveDbName}`;
      } else {
        connectionString = `mysql://${encodedUser}:${encodedPass}@${conn.host}:${port}/${saveDbName}`;
      }
      db = await Database.load(connectionString);

      const tableParts = activeTableName.split(".");
      const schemaName = tableParts.length > 1 ? tableParts[0] : "public";
      const tableName = tableParts.length > 1 ? tableParts.slice(1).join(".") : activeTableName;

      // ─── Step 2: Validate NOT NULL + FK constraints (all providers) ───
      const rowsWithMissing: { rowIndex: number; missing: string[] }[] = [];

      for (let i = 0; i < newRows.length; i++) {
        const { _isNew, ...data } = newRows[i];
        const missing: string[] = [];

        // Check NOT NULL columns that don't have a DEFAULT (these must be provided)
        if (["postgres", "supabase", "cockroach", "mysql", "mariadb"].includes(activeConnection.type)) {
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
        } else if (activeConnection.type === "sqlite") {
          const sqliteCols = await db.select(`PRAGMA table_info("${tableName}")`);
          for (const col of sqliteCols) {
            if (col.notnull === 1 && (col.dflt_value === null || col.dflt_value === undefined)) {
              const colName = col.name;
              const val = data[colName];
              if (val === null || val === undefined || String(val).trim() === "") {
                missing.push(colName);
              }
            }
          }
        }

        // FK columns are NOT validated client-side — many real-world schemas
        // have NOT NULL FK columns that the ORM auto-populates (e.g. create_uid,
        // company_id). Let the database engine enforce FK constraints and surface
        // any violation in the error dialog.

        if (missing.length > 0) {
          rowsWithMissing.push({ rowIndex: i, missing });
        }
      }

      // ─── Step 3: Report all validation errors in a dialog (don't switch to Messages tab) ───
      if (rowsWithMissing.length > 0) {
        const errorLines = rowsWithMissing.map(({ rowIndex, missing }) =>
          `Row ${rowIndex + 1}: Missing required column${missing.length > 1 ? "s" : ""} — ${missing.join(", ")}`
        );
        await confirmDialog.dialog({
          title: "Cannot Save: Required Columns Are Missing",
          message:
            `Fill in the highlighted columns above and try saving again.\n\n` +
            errorLines.join("\n"),
          type: "danger",
        });
        return;
      }

      // ─── Step 4: Execute INSERTs directly (bypass executeQuery so errors propagate) ───
      for (const row of newRows) {
        const { _isNew, _isModified, ...data } = row;
        const columns = Object.keys(data).filter(c => data[c] !== null && data[c] !== undefined);
        
        let query = "";
        if (columns.length === 0) {
          query = `INSERT INTO ${qid(activeTableName)} DEFAULT VALUES`;
          if (activeConnection.type === "mysql" || activeConnection.type === "mariadb") {
             query = `INSERT INTO ${qid(activeTableName)} () VALUES ()`;
          }
        } else {
          const cols = columns.map(c => qid(c)).join(", ");
          const vals = columns.map(c => formatSqlValue(data[c])).join(", ");
          query = `INSERT INTO ${qid(activeTableName)} (${cols}) VALUES (${vals})`;
        }
        await db.execute(query);
      }

      // ─── Step 5: Execute UPDATEs directly (bypass executeQuery so errors propagate) ───
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
        
        for (const col of columns) {
           setClauses.push(`${qid(col)} = ${formatSqlValue(data[col])}`);
        }
        
        if (pk && data[pk] !== undefined && data[pk] !== null) {
          whereClauses.push(`${qid(pk)} = ${formatSqlValue(data[pk])}`);
        } else {
          for (const col of columns) {
            const val = data[col];
            if (val === null) whereClauses.push(`${qid(col)} IS NULL`);
            else whereClauses.push(`${qid(col)} = ${formatSqlValue(val)}`);
          }
        }
        
        const sqlSet = setClauses.join(", ");
        const sqlWhere = whereClauses.length > 0 ? whereClauses.join(" AND ") : "TRUE";
        const updateQuery = `UPDATE ${qid(activeTableName)} SET ${sqlSet} WHERE ${sqlWhere}`;
        
        await db.execute(updateQuery);
      }

      // ─── Step 6: Refresh to get server-side IDs etc. ───
      setSuccess(`Successfully saved ${newRows.length} new and ${modifiedRows.length} modified records.`);
      await executeQuery(lastSelectQueryRef.current);
    } catch (err: any) {
      await confirmDialog.dialog({
        title: "Failed to Save",
        message: err?.message || String(err),
        type: "danger",
      });
    } finally {
      setIsExecuting(false);
      isExecutingRef.current = false;
      setSuppressTabSwitch(false);
    }
  }, [activeTableName, activeConnection, selectedDatabase, vaultCredentials, executeQuery, confirmDialog, connections]);

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
        let sql = `INSERT INTO ${qid(activeTableName)} DEFAULT VALUES`;
        if (activeConnection.type === "mysql") {
          sql = `INSERT INTO ${qid(activeTableName)} () VALUES ()`;
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
        let sql = `INSERT INTO ${qid(activeTableName)} DEFAULT VALUES`;
        if (activeConnection.type === "mysql" || activeConnection.type === "mariadb") {
          sql = `INSERT INTO ${qid(activeTableName)} () VALUES ()`;
        }
        await executeQuery(sql);
        await executeQuery(lastSelectQueryRef.current);
      } else {
        const cols = columns.map(c => qid(c)).join(", ");
        const vals = columns.map(c => formatSqlValue(newRow[c])).join(", ");
        const query = `INSERT INTO ${qid(activeTableName)} (${cols}) VALUES (${vals})`;
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
    window.dispatchEvent(new CustomEvent("format-sql"));
  }, []);

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
      logger.debug(`[VisualOptimizer] DB Type: ${dbType}`);
      logger.debug(`[VisualOptimizer] Raw rows:`, JSON.stringify(rows).slice(0, 500));

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
    <div className="flex-1 flex flex-col min-w-0 h-full bg-[var(--surface-base)]">
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
      <div className="h-8 flex items-center px-3 bg-[var(--surface-panel)] text-[11px] border-b border-[var(--neutral-6)] gap-2 select-none overflow-x-auto shrink-0">
        <Database className="w-3.5 h-3.5 text-[var(--accent-11)] opacity-70 shrink-0" />

        {/* Connection Selector */}
        <Select
          selectSize="sm"
          className="w-auto min-w-[8rem] font-bold uppercase tracking-wider"
          placeholder="Disconnected"
          value={activeTab?.target?.connectionId || activeConnection?.id || undefined}
          options={connections.map(c => ({ label: c.name, value: c.id }))}
          onValueChange={async (connId) => {
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
        />

        <ChevronRight className="w-3 h-3 opacity-20 shrink-0" />

        {/* Database Selector */}
        {(() => {
          const currentConnId = activeTab?.target?.connectionId || activeConnection?.id;
          const dbs = currentConnId && tabDatabases[currentConnId] ? tabDatabases[currentConnId] : (currentConnId === activeConnection?.id ? globalDatabases : []);

          const currentDbName = activeTab?.target?.database || selectedDatabase;
          const allDbs = [...dbs];
          if (currentDbName && !allDbs.includes(currentDbName)) allDbs.unshift(currentDbName);

          const dbOptions = allDbs.length > 0
            ? allDbs.map(db => ({ label: db, value: db }))
            : [{ label: currentDbName || "No Database", value: currentDbName || "__none__" }];

          return (
            <Select
              selectSize="sm"
              className="w-auto min-w-[8rem] font-medium"
              placeholder="No Database"
              value={currentDbName || undefined}
              options={dbOptions}
              onValueChange={async (dbName) => {
                if (dbName === "__none__") return;
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
            />
          );
        })()}

        <ChevronRight className="w-3 h-3 opacity-20 shrink-0" />
        <span className="text-[var(--neutral-11)] whitespace-nowrap">{activeTab?.name || "No Active Tab"}</span>
      </div>

      {/* Combined Tool Window Bar - Top — only when a database is selected.
          Without a target DB, every action (Run, Format, Explain, Compare,
          Clone, Activity, AI, Save) is either disabled or pointless. See #84. */}
      {isDatabaseReady && (
      <div className="h-12 flex items-center gap-1 px-2 bg-[var(--surface-panel)] border-b border-[var(--neutral-6)] shrink-0">
        {isExecuting ? (
          <Button variant="destructive" size="sm" onClick={cancelQuery} leftIcon={<Square className="w-3.5 h-3.5" fill="currentColor" />}>
            Cancel {runningTimeMs > 0 && `(${(runningTimeMs / 1000).toFixed(1)}s)`}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              // Always use run-query-smart to get the correct line number from cursor position
              window.dispatchEvent(new CustomEvent("run-query-smart"));
            }}
            disabled={!activeConnection}
            title="Run first statement (Ctrl+Enter in editor for statement at cursor, Ctrl+Shift+Enter for all)"
            leftIcon={<Play className="w-4 h-4" />}
          >
            Run
          </Button>
        )}
        <IconButton
          onClick={() => addNewTab()}
          label="New Query Tab"
          icon={<Plus />}
        />
        <div className="w-px h-6 bg-[var(--neutral-6)] mx-1" />
        <IconButton
          onClick={handleFormatSql}
          label="Format SQL (Prettify)"
          icon={<FileText />}
        />
        <IconButton
          onClick={handleExplainPlan}
          disabled={!activeTab?.query || isExecuting}
          label="Explain Plan (Analyze Performance)"
          icon={<BarChart2 />}
        />
        <IconButton
          onClick={handleVisualOptimize}
          disabled={!activeTab?.query || isExecuting}
          label="Visual Query Optimizer & Heuristics"
          icon={<Activity />}
        />
        <div className="w-px h-6 bg-[var(--neutral-6)] mx-1" />
        <IconButton
          label="Compare Schemas / Merge (Beta)"
          onClick={() => setShowCompareDialog(true)}
          icon={<GitCompare />}
        />
        <IconButton
          label="Clone Database / Snapshot"
          onClick={() => setShowCloneDialog(true)}
          icon={<Copy />}
        />
        <IconButton
          label="Performance Monitor / pg_stat_activity"
          onClick={() => setShowActivityMonitor(true)}
          icon={<ActivityIcon />}
          className={showActivityMonitor ? "bg-[var(--accent-3)] text-[var(--accent-11)] hover:bg-[var(--accent-4)]" : undefined}
        />
        <IconButton
          label="Multi-Query (Run query across multiple databases)"
          onClick={() => setShowMultiQueryDialog(true)}
          icon={<Layers />}
          className={showMultiQueryDialog ? "bg-[var(--accent-3)] text-[var(--accent-11)] hover:bg-[var(--accent-4)]" : undefined}
        />
        <IconButton
          label="ER Diagram"
          onClick={async () => {
            if (activeTab?.target && (activeTab.target.connectionId !== activeConnection?.id || activeTab.target.database !== selectedDatabase)) {
              try {
                await connectToDatabase(activeTab.target.connectionId, activeTab.target.database);
              } catch {
                showToastMessage("Failed to connect — cannot open ER Diagram");
                return;
              }
            }
            setShowERDDialog(true);
          }}
          icon={<Table />}
          className={showERDDialog ? "bg-[var(--accent-3)] text-[var(--accent-11)] hover:bg-[var(--accent-4)]" : undefined}
        />
        <IconButton
          label="Save Query (Ctrl+S)"
          onClick={async () => {
            if (!activeConnection) return;
            const queryToSave = activeTab?.query || currentQueryRef.current;
            if (!queryToSave || queryToSave.trim() === "") return;
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
              if (activeTabIdRef.current) {
                setQueryTabs(prev => prev.map(t => {
                  if (t.id === activeTabIdRef.current) {
                    return { ...t, name, savedQueryName: name, originalQuery: queryToSave };
                  }
                  if (t.savedQueryName && t.savedQueryName === name) {
                    return { ...t, originalQuery: queryToSave };
                  }
                  return t;
                }));
              }
              setSuccess(`Query "${name}" saved successfully!`);
            }
          }}
          icon={<Save />}
        />
        <div className="flex-1" />
        <Button
          size="xs"
          onClick={() => setShowAIDialog(true)}
          className="font-bold uppercase bg-[var(--accent-3)] text-[var(--accent-11)] border border-[var(--accent-6)] hover:bg-[var(--accent-4)] hover:border-[var(--accent-7)] mr-2"
          leftIcon={<Sparkles className="w-3.5 h-3.5" />}
        >
          AI Assistant
        </Button>
        <button
          onClick={() => setShowServices(!showServices)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm cursor-pointer ${showServices ? 'bg-[var(--neutral-4)]' : 'hover:bg-[var(--neutral-4)]'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2m0 0h2a2 2 0 012 2v6a2 2 0 01-2 2H9a2 2 0 01-2-2v-6a2 2 0 012-2h2" />
          </svg>
          Results
          {showServices ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
      </div>
      )}

      {/* Query Tabs - DataGrip Style — visible whenever tabs exist, even
          before a database is connected (#84 relaxed: restored sessions
          should render immediately). */}
      {queryTabs.length > 0 && (
      <div className="flex items-center bg-[var(--surface-panel)] border-b border-[var(--neutral-6)] shrink-0 overflow-x-auto no-scrollbar">
        <div className="flex items-center flex-nowrap min-w-0">
          {queryTabs.map((tab) => {
            // Get connection name for the tab (from target or active connection)
            const tabConnectionName = tab.target?.connectionName || activeConnection?.name || "No Connection";
            const tabConnectionId = tab.target?.connectionId || activeConnection?.id;
            const tabConnection = connections.find(c => c.id === tabConnectionId);
            const tabColor = tabConnection?.color || "var(--accent-9)";
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
                    ? "bg-[var(--surface-base)] border-[var(--accent-9)] text-[var(--accent-11)]"
                    : "bg-[var(--surface-elevated)] border-transparent text-[var(--neutral-11)] hover:bg-[var(--neutral-4)]"
                }`}
                onClick={() => {
                  setActiveTabId(tab.id);
                  currentQueryRef.current = tab.query;
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent("focus-editor"));
                  }, 50);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
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
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--warning-11)]" />
                  ) : tabHasError ? (
                    <XCircle className="w-3.5 h-3.5 text-[var(--danger-11)]" />
                  ) : tabHasSuccess ? (
                    <CheckCircle className="w-3.5 h-3.5 text-[var(--success-11)]" />
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
                      <span className="text-[9px] font-bold text-[var(--accent-11)] opacity-80 shrink-0">[{displayConnName}]</span>
                      {tab.usePsql && (
                        <span className="text-[8px] font-bold text-[var(--accent-11)] bg-[var(--accent-3)] px-1 py-0.5 rounded shrink-0 border border-[var(--accent-6)]">psql</span>
                      )}
                      <span className="truncate">{tab.name}</span>
                    </span>
                  <span className="text-[9px] opacity-60 font-normal truncate w-full" title={`${tab.target?.database || selectedDatabase}`}>
                    {tab.target?.database || selectedDatabase || "No Database"}
                  </span>
                </div>
                
                {/* Close Button */}
                {queryTabs.length > 1 && (
                  <IconButton
                    size="xs"
                    label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    icon={<X />}
                    className="shrink-0"
                  />
                )}
              </div>
            );
          })}
        </div>
        
        {/* New Tab Button */}
        <IconButton
          size="sm"
          onClick={() => addNewTab()}
          label="New Query Tab"
          icon={<Plus />}
          className="shrink-0 ml-1"
        />
      </div>
      )}

      {/* Tab context menu */}
      {contextMenu && (() => {
        const ctxTab = queryTabs.find(t => t.id === contextMenu.tabId);
        if (!ctxTab) return null;
        return (
          <Menu x={contextMenu.x} y={contextMenu.y}>
            <MenuItem
              icon={<X className="w-3.5 h-3.5" />}
              onClick={async () => { closeTab(ctxTab.id); setContextMenu(null); }}
            >
              Close
            </MenuItem>
            <MenuItem
              icon={<X className="w-3.5 h-3.5" />}
              onClick={() => { closeOthers(ctxTab.id); setContextMenu(null); }}
              disabled={queryTabs.length <= 1}
            >
              Close Others
            </MenuItem>
            <MenuItem
              icon={<X className="w-3.5 h-3.5" />}
              onClick={() => { closeAll(); setContextMenu(null); }}
              disabled={queryTabs.length <= 1}
            >
              Close All
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Pencil className="w-3.5 h-3.5" />}
              onClick={() => {
                const newName = window.prompt("Rename tab:", ctxTab.name);
                if (newName && newName.trim()) {
                  updateTabState(ctxTab.id, { name: newName.trim() });
                }
                setContextMenu(null);
              }}
            >
              Rename
            </MenuItem>
            <MenuItem
              icon={<CopyIcon className="w-3.5 h-3.5" />}
              onClick={() => {
                addNewTab(ctxTab.query, ctxTab.name + " (copy)", ctxTab.usePsql,
                  ctxTab.target?.connectionId, ctxTab.target?.connectionName, ctxTab.target?.database);
                setContextMenu(null);
              }}
            >
              Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Clipboard className="w-3.5 h-3.5" />}
              onClick={async () => {
                const path = await getTabAutoSavePath(ctxTab);
                if (path) {
                  await copyToClipboard(path);
                  showToastMessage("Copied to clipboard");
                }
                setContextMenu(null);
              }}
            >
              Copy File Path
            </MenuItem>
            <MenuItem
              icon={<FolderOpen className="w-3.5 h-3.5" />}
              onClick={async () => {
                await openTabFileInExplorer(ctxTab);
                setContextMenu(null);
              }}
            >
              Open in Explorer
            </MenuItem>
          </Menu>
        );
      })()}

      {/* Query Editor and Results */}
      <PanelGroup direction="vertical" className="flex-1 min-h-0">
        {/* Top panel: Editor or Dashboard — must be a Panel for PanelGroup to work */}
        <Panel minSize={20} maxSize={80}>
          {!activeTab && queryTabs.length === 0 ? (
            <EmptyStateLauncher />
          ) : activeTab ? (
            activeTab.usePsql ? (
              <div className="h-full flex flex-col">
                <div className="flex-1 min-h-0">
                  <Suspense fallback={null}>
                    <PsqlWindow
                      entries={activeTab.psqlEntries || []}
                      liveOutput={psqlOutput.length > 0 ? psqlOutput : stashPsqlOutputRef.current}
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
                  </Suspense>
                </div>
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="h-full w-full bg-[var(--surface-base)]" aria-hidden="true" />
                }
              >
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
              </Suspense>
            )
          ) : (
            <div className="h-full flex flex-col items-center justify-center bg-[var(--surface-base)] p-6 text-center">
              <p className="text-sm text-[var(--neutral-11)]">
                Press <kbd className="px-1.5 py-0.5 mx-1 text-[10px] font-bold rounded bg-[var(--surface-elevated)] border border-[var(--neutral-6)]">Ctrl+N</kbd>
                or click <Plus className="inline w-3.5 h-3.5 mx-0.5 align-text-bottom" /> in the tab bar to start a query.
              </p>
            </div>
          )}
        </Panel>

        {isDatabaseReady && showServices && !activeTab?.usePsql && (
          <>
            <PanelResizeHandle className="h-1 bg-[var(--neutral-6)] hover:bg-[var(--accent-9)] transition-colors cursor-row-resize select-none shrink-0 data-[resize-handle-state=drag]:bg-[var(--accent-9)] data-[resize-handle-state=hover]:bg-[var(--accent-9)]/60" />
            <Panel minSize={15} maxSize={85} defaultSize={40}>
              <ResultsPanel
            results={results}
            error={error}
            successMessage={success}
            multiResults={multiResults}
            isLoading={isExecuting}
            executionTime={executionTime}
            tableName={activeTableName || undefined}
            columnTypes={tableColumnTypes?.types}
            forcedColumns={lastColumns}
            onUpdateRow={handleUpdateRow}
            onDeleteRow={handleDeleteRow}
            onAddRow={handleAddRow}
            onResultsChange={setResults}
            onRefresh={lastSelectQueryRef.current ? () => executeQuery(lastSelectQueryRef.current) : undefined}
            onSave={handleSave}
            onDiscard={async () => {
              // Clear any previous messages so discarding doesn't leave stale
              // success/error text visible on the Messages tab.
              setError(null);
              setSuccess(null);
              // Modified existing rows need server data to revert — nothing in
              // the codebase preserves pre-edit values, so the only way to undo
              // a cell edit is to re-fetch. New rows are pure-client state and
              // can be filtered out without a roundtrip, which is the common
              // case (user added rows, changed their mind).
              setSuppressTabSwitch(true);
              const hasModifications = results.some(r => r._isModified && !r._isNew);
              if (hasModifications && lastSelectQueryRef.current) {
                await executeQuery(lastSelectQueryRef.current);
              } else {
                setResults(prev =>
                  prev
                    .filter(r => !r._isNew)
                    .map(({ _isNew, _isModified, ...rest }) => rest)
                );
              }
              setSuppressTabSwitch(false);
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

      {/* Modal dialogs are gated by their open flag so React.lazy can keep
          them out of the cold-start bundle. Each dialog's chunk only loads
          when the user first opens it. */}
      <Suspense fallback={null}>
        {showCompareDialog && (
          <CompareDialog isOpen={showCompareDialog} onClose={() => setShowCompareDialog(false)} />
        )}
        {showCloneDialog && (
          <CloneDialog isOpen={showCloneDialog} onClose={() => setShowCloneDialog(false)} />
        )}
        {showActivityMonitor && (
          <ActivityMonitor isOpen={showActivityMonitor} onClose={() => setShowActivityMonitor(false)} />
        )}
        {showMultiQueryDialog && (
          <MultiQueryDialog isOpen={showMultiQueryDialog} onClose={() => setShowMultiQueryDialog(false)} />
        )}
        {showERDDialog && (
          <ERDDialog isOpen={showERDDialog} onClose={() => setShowERDDialog(false)} />
        )}
        {showAIDialog && (
          <AIAssistantDialog isOpen={showAIDialog} onClose={() => setShowAIDialog(false)} currentQuery={activeTab?.query || ""} onUpdateQuery={updateTabQuery} />
        )}
        {defModalState.isOpen && (
          <DefinitionModal
            isOpen={defModalState.isOpen}
            tableName={defModalState.table}
            onClose={() => setDefModalState({ isOpen: false, table: "" })}
          />
        )}
        {_showLocalHistory && (
          <LocalHistoryDialog
            isOpen={_showLocalHistory}
            onClose={() => setShowLocalHistory(false)}
            dirPath="saved-queries"
          />
        )}
      </Suspense>

      {showToast && toastMessage && (
        <div className="fixed bottom-4 right-4 z-50 bg-[var(--neutral-12)] text-[var(--neutral-1)] px-4 py-2 rounded-md shadow-lg text-sm animate-in fade-in slide-in-from-bottom-2">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
