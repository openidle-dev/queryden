import { useState, useEffect, useRef, useCallback, Suspense, lazy } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ResultsPanel } from "../results/ResultsPanel";
import { useConnections } from "../../contexts/useConnections";
import type { EnsuredConnection } from "../../contexts/ConnectionContext";
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
import { mapSelectionStatementsToDocumentLines, mergeGlyphResults } from "../../utils/statementGlyphs";
import { applyQueryLimit } from "../../utils/applyQueryLimit";
import { classifyDestructive, formatSqlLiteral, getDefaultPort, isDoBlock as isDoBlockHelper, isSelectLike, splitDottedIdentifier, stripSqlToCode } from "../../utils/sqlDialect";
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
  const { connections, folders, activeConnection, selectedDatabase, currentDb, vaultCredentials, databases: globalDatabases, connectToDatabase, ensureConnectionDb, dropCachedConnection, initialLoadDone } = useConnections();
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
  // Which tab launched the currently-running query (#222). The tab glyph keys
  // off this (not the active tab) so the spinner stays on the owning tab when
  // the user switches tabs mid-run. The editor header / psql window /
  // results-panel loading use `activeTabIsExecuting` below. The top toolbar
  // Run/Cancel stays global — one query runs at a time, cancellable anywhere.
  const [executingTabId, setExecutingTabId] = useState<string | null>(null);
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
  const executionGenRef = useRef(0);
  // Per-run cancel token: holds a mutable flag for the currently-executing
  // run. When a new run starts it creates a fresh token; when the user
  // cancels, we set the current token to true (but leave old tokens alone).
  const currentRunCancelRef = useRef<{ current: boolean } | null>(null);
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
  const [tableSchema, setTableSchema] = useState<{
    columns: { name: string; type: string; nullable: boolean; default: string | null }[];
    foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[];
    primaryKeys?: string[];
  } | undefined>(undefined);
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
  // FK metadata cache keyed by "schema.tableName" — avoids redundant information_schema queries
  const fkCacheRef = useRef<Map<string, { columns: { name: string; type: string; nullable: boolean; default: string | null }[]; foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[] }>>(new Map());
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
      const port = conn.port || getDefaultPort(conn.type);
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
  // A tab targeting a known saved connection is runnable even when nothing is
  // globally connected: execution lazily establishes the target connection on
  // demand (SSH tunnel included), so no manual sidebar connect is needed.
  const tabTargetId = activeTab?.target?.connectionId;
  const canRunOnTabTarget = !!tabTargetId && connections.some((c) => c.id === tabTargetId);
  // True only when the *active* tab owns the running query (#222). Tab glyphs
  // use `executingTabId` directly; scoped loading indicators use this.
  const activeTabIsExecuting = isExecuting && executingTabId === activeTabId;

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

  const loadFKOptions = useCallback(async (fk: { refTable: string; refColumns: string[] }, search: string): Promise<{ pk: any; label: string }[]> => {
    // Resolve the FK lookup against the tab's target connection (lazy ensure
    // when it was never globally connected), not just the global handle.
    const fkTab = queryTabs.find(t => t.id === activeTabId);
    const fkTarget = fkTab?.target;
    const fkConn = (fkTarget
      ? connections.find(c => c.id === fkTarget.connectionId)
      : activeConnection) || activeConnection;
    if (!fkConn) return [];
    const refCol = fk.refColumns[0];
    const dbType = (fkConn.type || "postgres") as DatabaseType;
    const qTable = quoteIdentifier(fk.refTable, dbType);
    const qRefCol = quoteIdentifier(refCol, dbType);
    // Placeholders are dialect-specific: $1 on PostgreSQL-wire engines, ?
    // on MySQL/MariaDB (sqlx does not understand $n there).
    const isPgLikeFk = ["postgres", "supabase", "cockroach"].includes(dbType);
    const ph = isPgLikeFk ? "$1" : "?";
    try {
      const db = (fkTarget || !currentDb)
        ? (await ensureConnectionDb(fkConn.id, fkTarget?.database || selectedDatabase || fkConn.database)).db
        : currentDb;
      if (search) {
        const sample = await db.select(`SELECT * FROM ${qTable} LIMIT 1`);
        const displayCol = sample.length > 0
          ? Object.keys(sample[0]).find(k => k !== refCol && !k.endsWith("_id") && typeof sample[0][k] === "string") || refCol
          : refCol;
        const qDisplayCol = quoteIdentifier(displayCol, dbType);
        const likeOp = ["postgres", "supabase", "cockroach", "sqlite"].includes(dbType) ? "ILIKE" : "LIKE";
        const results = await db.select(
          `SELECT ${qRefCol}, ${qDisplayCol} FROM ${qTable} WHERE ${qDisplayCol} ${likeOp} ${ph} LIMIT 50`,
          [`%${search}%`]
        );
        return results.map((r: any) => ({ pk: r[refCol], label: String(r[displayCol] ?? r[refCol]) }));
      }
      // No search: single SELECT * already has refCol + all candidate display cols
      const rows = await db.select(`SELECT * FROM ${qTable} LIMIT 100`);
      if (rows.length === 0) return [];
      const displayCol = Object.keys(rows[0]).find(k => k !== refCol && !k.endsWith("_id") && typeof rows[0][k] === "string") || refCol;
      return rows.map((r: any) => ({ pk: r[refCol], label: String(r[displayCol] ?? r[refCol]) }));
    } catch {
      return [];
    }
  }, [currentDb, activeConnection, selectedDatabase, connections, queryTabs, activeTabId, ensureConnectionDb]);

  // ── Session persistence: restore open tabs on startup ────────────────────
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (!initialLoadDone) return;
    if (sessionRestoredRef.current) return;
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
      } finally {
        sessionRestoredRef.current = true;
      }
    })();
  }, [initialLoadDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-reconnect: restore the previously-active connection ─────────────
  // Startup connects nothing by design, so without this the restored tabs and
  // explorer greet the user fully DISCONNECTED (header, tree, Run) until
  // something is clicked — even though the session knows what was open.
  // Runs once, in the background, best effort: any failure just logs (+ a
  // non-blocking toast) and leaves the connection for manual connect. Never
  // prompts: connections still waiting for a vault-profile pick stay manual.
  const autoReconnectAttemptedRef = useRef(false);
  useEffect(() => {
    if (!initialLoadDone || autoReconnectAttemptedRef.current) return;
    autoReconnectAttemptedRef.current = true;
    (async () => {
      try {
        const { invokeCmd } = await import("../../lib/ipc");
        const { settingsReady, useSettings } = await import("../../store/settingsStore");
        const { canAutoReconnect } = await import("../../utils/autoReconnect");
        await settingsReady;
        if (!useSettings.getState().autoReconnect) return;
        if (activeConnRef.current) return; // user already connected manually
        const data = await invokeCmd("load_sessions");
        const connId = data.activeConnectionId;
        if (!connId) return;
        const target = connectionsRef.current.find((c) => c.id === connId);
        if (!target || !canAutoReconnect(target)) return;
        logger.debug(`Auto-reconnecting previous session connection: ${target.name}`);
        await connectToDatabase(connId, data.activeDatabase || undefined);
        window.dispatchEvent(new CustomEvent("expand-connection", { detail: { connectionId: connId } }));
        logger.debug(`Auto-reconnected: ${target.name}`);
      } catch (e) {
        // Background restore must never modal or block startup.
        logger.debug("Auto-reconnect failed (connect manually):", e);
        showToastMessage("Previous connection unavailable — click it in the explorer to reconnect.");
      }
    })();
    // connectToDatabase identity changes per render; the attempted-ref makes
    // this strictly once, using the first fresh closure after initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLoadDone]);

  // ── Session persistence: save tabs whenever they change ──────────────────
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Don't save until the restore attempt above has completed — otherwise
    // this fires on mount with the initial empty `queryTabs` and can win
    // the race against the (async) restore, wiping sessions.json with an
    // empty tab list before it's ever read back.
    if (!sessionRestoredRef.current) return;
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
        await invokeCmd("save_sessions", {
          tabs,
          activeTabId,
          activeConnectionId: activeConnection?.id ?? null,
          activeDatabase: selectedDatabase ?? null,
        });
      } catch (e) {
        logger.debug("Failed to save session:", e);
      }
    }, 500);
    return () => {
      if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    };
  }, [queryTabs, activeTabId, activeConnection?.id, selectedDatabase]);

  // Issue #51: invalidate the cached column-types when the active table
  // changes away from the one those types were collected for. An ad-hoc
  // query targeting a different table will reset `activeTableName` via
  // `executeQuery`; without this clear, stale types would mislabel cells.
  useEffect(() => {
    if (tableColumnTypes && tableColumnTypes.tableName !== activeTableName) {
      setTableColumnTypes(undefined);
    }
  }, [activeTableName, tableColumnTypes]);

  // Keep tableSchema in sync with activeTableName. When column types reference
  // a different table the stale FK schema must go. When tableColumnTypes is
  // undefined the FK schema was set independently (e.g. ad-hoc query FK cache)
  // and should NOT be cleared.
  useEffect(() => {
    if (!tableSchema) return;
    if (tableColumnTypes && tableColumnTypes.tableName !== activeTableName) {
      setTableSchema(undefined);
    }
  }, [activeTableName, tableColumnTypes, tableSchema]);

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
          // Note: statementResults are NOT touched here — they stay in tab
          // state and flow into QueryEditor via props, so glyphs survive tab
          // switches (#223).
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
      // Note: statementResults stay in tab state and flow into QueryEditor via props (#223)
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

  // Merge a batch of glyph results into a tab's existing marks (#223: one
  // checkmark per block that was run — accumulate, dedup by line, re-running
  // a block replaces its mark). Uses a functional update so mid-loop writes
  // never clobber marks appended by an overlapping write.
  const appendGlyphResults = useCallback((tabId: string, batch: StatementResult[]) => {
    if (batch.length === 0) return;
    setQueryTabs(prev => prev.map(t =>
      t.id === tabId
        ? { ...t, statementResults: mergeGlyphResults(t.statementResults || [], batch) }
        : t
    ));
  }, []);

  // Replace a tab's glyph set wholesale — used for the editor's prune
  // writeback (lines shifted by edits / destroyed blocks dropped).
  const setGlyphResults = useCallback((tabId: string, glyphResults: StatementResult[]) => {
    updateTabState(tabId, { statementResults: glyphResults });
  }, [updateTabState]);

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
    // Re-entrancy guard: drop a second trigger (e.g. a rapid double
    // Ctrl+Enter) while a run is already in flight. Previously the feedback
    // delay below let users press Run again before the spinner appeared,
    // firing the same query twice. The flag is set synchronously at the top
    // of the try block and cleared in `finally`, so a duplicate press is
    // dropped rather than double-executed. The variable-substitution dialog
    // returns early *before* the flag is set, so its re-trigger still runs.
    if (isExecutingRef.current) return;

    // Bump the execution generation. A newer run supersedes any older one that
    // is still unwinding: the generation checkpoints and the finally block
    // below no-op when their captured `gen` no longer matches the latest.
    const gen = ++executionGenRef.current;
    // Fresh run owns the global cancel flag (#212). Abandoned runs bail on
    // generation mismatch (checked in every loop below), so clearing here
    // can't resume them — and without it, a previous cancel would make this
    // run break out of its statement loop immediately.
    cancelFlagRef.current = false;
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
        // Map selection-relative lines back to document-absolute lines (#223):
        // splitStatements numbers from 1 relative to the selection text, so a
        // block on document line 14 would otherwise get a glyph on line 3.
        // statementInfo carries the selection's document start line when the
        // run came from the editor (smart-run / selection); the toolbar path
        // has no offset, so it falls back to 1.
        const baseLine = statementInfo?.lineNumber ?? 1;
        const mapped: { text: string; lineNumber: number }[] =
          mapSelectionStatementsToDocumentLines(parts, baseLine);
        statementsToRun = mapped.map((p) => p.text);
        statementInfos = mapped.map((p) => ({ lineNumber: p.lineNumber, statementText: p.text }));
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
    // Runs on lexer-stripped SQL so FROM inside 'strings' or DO $$ bodies
    // can't produce a bogus table name.
    let extractTableName: string | null = null;
    // Match on the original text but reject matches blanked out by the
    // lexer (FROM/JOIN inside 'strings', quoted identifiers, DO bodies,
    // or comments). Stripped SQL preserves length so indices align.
    const strippedForTable = stripSqlToCode(queryToRun);
    const tableRe = /(?:FROM|JOIN|UPDATE|INTO)\s+(?:"([^"]+)"(?:\."([^"]+)")?|([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?))\b/gi;
    let tableNameMatch: RegExpMatchArray | null = null;
    for (let m = tableRe.exec(queryToRun); m !== null; m = tableRe.exec(queryToRun)) {
      const probe = strippedForTable.slice(m.index, m.index + m[0].length);
      if (!/(FROM|JOIN|UPDATE|INTO)/i.test(probe)) continue;
      tableNameMatch = m;
      break;
    }
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
        extractTableName = detectedTable;
        setActiveTableName(detectedTable);
        if (currentTabId) updateTabState(currentTabId, { tableName: detectedTable });
      }
    }

    setError(null);
    setSuccess(null);
    setMultiResults([]);
    setRunningTimeMs(0);

    // Per-run cancellation: each run gets its own cancel token. When a new
    // run starts it does NOT clear the global cancelFlagRef immediately —
    // that would let a previously-cancelled run continue executing. Instead
    // we create a fresh local cancel flag and only check that one.
    const runCancelled = { current: false };
    currentRunCancelRef.current = runCancelled;

    // NOTE: no statementResults wipe here (#223) — glyphs accumulate across
    // runs (one checkmark per block that was run); new marks merge in below.
    const startTime = Date.now();
    let intervalId: any = null;
    
    try {
      // Show the running state immediately — synchronously, before any
      // awaited work. The first await is the `Database.load` connection
      // handshake far below, which can take seconds on a cold connection;
      // previously `setIsExecuting(true)` only ran *after* it, so the spinner
      // and tab indicator appeared seconds after Ctrl+Enter. Setting it here
      // makes feedback instant. The flag is cleared in `finally`; the
      // per-path `setIsExecuting(true)` calls below are now redundant no-ops.
      setIsExecuting(true);
      isExecutingRef.current = true;
      // Pin the spinner to the launching tab (#222).
      setExecutingTabId(currentTabId ?? null);

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

      // Compute query type immediately (needed by both libpq and CLI paths).
      // Lexer-aware: keywords inside strings/dollar bodies/comments are
      // invisible, and DO LANGUAGE variants count as DO blocks.
      const isDoBlock = isDoBlockHelper(queryToRun);
      const isSelect = isSelectLike(queryToRun);
      const { isTruncate, isDelete, hasWhere, isDestructive } = classifyDestructive(queryToRun);

      // Resolve credentials + effective endpoint (shared between libpq and
      // CLI paths). A tab targeting a never-connected connection lazily
      // establishes it here — SSH tunnel, vault reload, version detection —
      // so queries work without a manual sidebar connect. The globally
      // connected fast path is untouched (reuses currentDb + in-memory
      // creds). `ensured` is null only when reusing the live global handle.
      let ensured: EnsuredConnection | null = null;
      if (targetConn || !currentDb) {
        try {
          ensured = await ensureConnectionDb(
            actualConnection.id,
            actualDatabase || actualConnection.database,
          );
        } catch (ensureErr) {
          // PSQL-console entries (`type: "psql"`) may not be libpq-usable;
          // the CLI path can still proceed binary-only (stored credentials +
          // system-psql version fallback), so don't fail the run here. Every
          // other engine needs the handle — surface the real error.
          if (!useCliPath || actualConnection.type !== "psql") throw ensureErr;
          ensured = null;
        }
      }
      let username: string;
      let password: string;
      let port: number;
      let cliHost: string;
      if (ensured) {
        ({ username, password, port } = ensured);
        cliHost = ensured.host;
      } else {
        username = actualConnection.username || "";
        password = actualConnection.password || "";
        if (actualConnection.vaultCredentialId) {
          const vaultCred = vaultCredentials.find(vc => vc.id === actualConnection.vaultCredentialId);
          if (vaultCred) {
            username = vaultCred.username || "";
            password = vaultCred.password || "";
          }
        }
        port = actualConnection.port || getDefaultPort(actualConnection.type);
        cliHost = actualConnection.host || "localhost";
      }
      
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
        // 1. The lazily-ensured handle for THIS connection (correct server —
        //    currentDb may belong to a different connection entirely)
        // 2. Pre-stored: serverMajorVersion captured on connect
        // 3. System binary as last resort
        // `ensureConnectionDb` persists a fresh detection via updateConnection,
        // so prefer its returned connection object over the render-time one.
        let majorVersion: number | null =
          ensured?.connection.serverMajorVersion ?? actualConnection.serverMajorVersion ?? null;
        logger.debug("[CLI Path] Initial majorVersion:", majorVersion);

        const versionDb = ensured?.db ?? currentDb;
        if (majorVersion === null && versionDb) {
          logger.debug("[CLI Path] Detecting major version via live libpq handle...");
          try {
            const verRows = await versionDb.select("SELECT (regexp_matches(version(), E'^PostgreSQL (\\d+)'))[1]::int AS major") as any[];
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
          if (gen === executionGenRef.current) {
            setIsExecuting(false);
            isExecutingRef.current = false;
            setExecutingTabId(null);
          }
          return;
        }

        logger.debug("[CLI Path] Final majorVersion to use:", majorVersion);
        let toolStatus = await cliStore.checkTool("postgresql", majorVersion);
        logger.debug("[CLI Path] Tool status (checkTool):", toolStatus);

        if (toolStatus.needsDownload) {
          // Auto-download is available (MySQL, Mongo) — prompt user
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
            if (gen === executionGenRef.current) {
              setIsExecuting(false);
              isExecutingRef.current = false;
              setExecutingTabId(null);
            }
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
            if (gen === executionGenRef.current) {
              setIsExecuting(false);
              isExecutingRef.current = false;
              setExecutingTabId(null);
            }
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
              if (gen === executionGenRef.current) {
                setIsExecuting(false);
                isExecutingRef.current = false;
                setExecutingTabId(null);
              }
              return;
            }
            // User clicked "Check Again" — re-check after potential install
            toolStatus = await cliStore.checkTool("postgresql", majorVersion);
          }
          // Fall through to execute when psql is now available
        }
        
        // `cliHost`/`port`/`username`/`password` come from the shared
        // resolution above — the SSH-tunnel endpoint when applicable.
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
            // Bail on cancel OR supersession: an abandoned run must stop even
            // if a newer run already cleared the shared cancel flag (#212).
            if (cancelFlagRef.current || runCancelled.current || gen !== executionGenRef.current) break;
            const stmt = statementsToRun[i];

            // Handle meta-commands (\c, \x) entirely in the frontend; don't pass to psql.
            if (await handlePsqlMetaCommand(stmt)) {
              continue;
            }

            const stmtInfo = statementInfos[i];
            const lineNumber = stmtInfo?.lineNumber || 1;
            const isStmtSelect = isSelectLike(stmt);
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
          if (currentTabId) appendGlyphResults(currentTabId, statementResults);
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
              if (gen === executionGenRef.current) {
                setIsExecuting(false);
                isExecutingRef.current = false;
                setExecutingTabId(null);
              }
              return;
            }

            appendPsqlOutput([`Watching: ${queryToWatch} (every ${intervalSec}s). Press Stop to cancel.`]);
            
            while (!cancelFlagRef.current && !runCancelled.current && gen === executionGenRef.current && isExecutingRef.current) {
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
                if (cancelFlagRef.current || runCancelled.current || gen !== executionGenRef.current || !isExecutingRef.current) break;
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
            if (gen === executionGenRef.current) {
              setIsExecuting(false);
              isExecutingRef.current = false;
              setExecutingTabId(null);
            }
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
              if (gen === executionGenRef.current) {
                setIsExecuting(false);
                isExecutingRef.current = false;
                setExecutingTabId(null);
              }
              return;
            }

            if (isSelect) {
              const limitedQuery = applyQueryLimit(queryToRun, settings.maxRowsToDisplay);
              const { rows: cliRows, columns: cliCols } = await cliExecStmt(limitedQuery, true, currentPsqlExpanded, currentCliDatabase || "");
              rows = cliRows ?? [];
              rowsAffected = rows.length;
              statementResults.push({ lineNumber: stmtInfo.lineNumber, status: 'success', rowCount: rowsAffected, executionTime: Date.now() - stmtStartTime });
              // Store columns for the ResultPanel; glyphs accumulate (#223).
              if (currentTabId) {
                appendGlyphResults(currentTabId, statementResults);
                updateTabState(currentTabId, { columns: cliCols ?? [] });
              }
              setLastColumns(cliCols ?? []);
            } else {
              const { rowsAffected: affected } = await cliExecStmt(queryToRun, false, currentPsqlExpanded, currentCliDatabase || "");
              rowsAffected = affected ?? 0;
              setSuccess(isDoBlock ? "DO" : `Query executed successfully. ${rowsAffected} rows affected.`);
              rows = [];
              statementResults.push({ lineNumber: stmtInfo.lineNumber, status: 'success', rowsAffected, executionTime: Date.now() - stmtStartTime });
              if (currentTabId) appendGlyphResults(currentTabId, statementResults);
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
              if (gen === executionGenRef.current) {
                setIsExecuting(false);
                isExecutingRef.current = false;
                setExecutingTabId(null);
              }
              return;
          }
          if (currentTabId) appendGlyphResults(currentTabId, statementResults);
        }
        
        // Skip the libpq block entirely
        // Jump to the post-execution section. A cancelled/superseded run bails
        // silently — the newer run (or the cancel itself) owns the UI (#212).
        if (intervalId) clearInterval(intervalId);
        if (cancelFlagRef.current || runCancelled.current || gen !== executionGenRef.current) return;
        
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
        if (gen === executionGenRef.current) {
          setIsExecuting(false);
          isExecutingRef.current = false;
          setExecutingTabId(null);
        }
        return;
      }
      
      // ── Default: libpq path ──────────────────────────────────────────────────
      // Use the transaction-scoped connection if a transaction is active for this connection
      if (txState.active && txDbRef.current && txContextRef.current?.connectionId === actualConnection.id && txContextRef.current?.database === actualDatabase) {
        db = txDbRef.current;
      } else if (ensured) {
        // Tab-target (or unconnected-global) run: the lazily-established
        // handle — SSH tunnel, correct credentials and database included.
        // Established up front so this never throws here.
        db = ensured.db;
      } else if (!db) {
        // Unreachable: `ensured` covers every case where `db` starts null
        // (tab target, or no live global handle). Defensive only.
        throw new Error("No database connection selected");
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
            // Check the per-run cancel token, not the global one. This
            // prevents a cancelled run from continuing after a new run starts.
            if (runCancelled.current) break;
            
            const stmt = statementsToRun[i];
            const stmtInfo = statementInfos[i];
            const lineNumber = stmtInfo?.lineNumber || 1;

            const isStmtSelect = isSelectLike(stmt);
            
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
          
          // Store statement results for gutter glyphs (accumulate #223)
          if (currentTabId) {
            appendGlyphResults(currentTabId, statementResults);
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
            setSuccess(isDoBlock ? "DO" : `Query executed successfully. ${rowsAffected} rows affected.`);
            rows = [];
            statementResults.push({
              lineNumber: stmtInfo.lineNumber,
              status: 'success',
              rowsAffected,
              executionTime: Date.now() - stmtStartTime
            });
          }
          
          // Store statement results for gutter glyphs (accumulate #223)
          if (currentTabId) {
            appendGlyphResults(currentTabId, statementResults);
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
      // Check the per-run cancel token (not the global one) to decide
      // whether to bail early. A stale generation also bails.
      if (runCancelled.current || gen !== executionGenRef.current) return;

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
        // Keep lastSelectQueryRef in sync with the last data-returning query so
        // the toolbar refresh button and discard-revert always re-run the correct
        // SELECT (not a stale query from a previous table click).
        if (queryToRun) {
          lastSelectQueryRef.current = queryToRun;
        }
      }

      // Load FK metadata for the detected table so FK columns render as
      // clickable cells even when the table was opened via SQL editor.
      // Use extractTableName (local var) instead of activeTableName (stale closure).
      // Use db (the same connection used for the main query) instead of currentDb
      // because db may be a transaction-specific connection.
      if (isSelect && rows.length > 0 && extractTableName && db) {
        const dbType = actualConnection?.type;
        let schemaName: string | null = null;
        let tableName = extractTableName;
        if (extractTableName.includes('.')) {
          const parts = extractTableName.split('.');
          schemaName = parts[0];
          tableName = parts.slice(1).join('.');
        }
        // Resolve actual schema when none was specified (table resolved via search_path).
        if (!schemaName && ["postgres", "supabase", "cockroach"].includes(dbType || "")) {
          try {
            const schemaRows = await db.select(
              "SELECT n.nspname FROM pg_catalog.pg_class cl JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace WHERE cl.relname = $1 LIMIT 1",
              [tableName]
            );
            schemaName = (schemaRows as any[])?.[0]?.nspname || 'public';
          } catch {
            schemaName = 'public';
          }
        } else if (!schemaName) {
          schemaName = 'public';
        }
        const cacheKey = `${schemaName}.${tableName}`;
        const cached = fkCacheRef.current.get(cacheKey);
        if (cached) {
          setTableSchema(cached);
        } else {
          (async () => {
            try {
              let fks: any[] = [];
              let pks: string[] = [];
              if (["postgres", "supabase", "cockroach"].includes(dbType || "")) {
                [fks, pks] = await Promise.all([
                  db.select(`
                    SELECT kcu.column_name, tc.constraint_name,
                      ccu.table_schema AS foreign_table_schema,
                      ccu.table_name AS foreign_table_name,
                      ccu.column_name AS foreign_column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                    JOIN information_schema.constraint_column_usage ccu
                      ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.table_schema
                    WHERE tc.constraint_type = 'FOREIGN KEY'
                      AND tc.table_schema = $1 AND tc.table_name = $2
                  `, [schemaName, tableName]),
                  db.select(`
                    SELECT kcu.column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_name = kcu.constraint_name
                      AND tc.table_schema = kcu.table_schema
                    WHERE tc.table_schema = $1
                      AND tc.table_name = $2
                      AND tc.constraint_type = 'PRIMARY KEY'
                    ORDER BY kcu.ordinal_position
                  `, [schemaName, tableName]),
                ]);
                pks = (pks as any[]).map(p => p.column_name);
              } else if (["mysql", "mariadb"].includes(dbType || "")) {
                [fks, pks] = await Promise.all([
                  db.select(`
                    SELECT kcu.column_name, kcu.referenced_table_name, kcu.referenced_column_name
                    FROM information_schema.key_column_usage kcu
                    JOIN information_schema.table_constraints tc
                      ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
                    WHERE tc.constraint_type = 'FOREIGN KEY' AND kcu.table_schema = DATABASE() AND kcu.table_name = ?
                  `, [tableName]),
                  db.select(`
                    SELECT column_name
                    FROM information_schema.key_column_usage
                    WHERE table_schema = DATABASE()
                      AND table_name = ?
                      AND constraint_name = 'PRIMARY'
                    ORDER BY ordinal_position
                  `, [tableName]),
                ]);
                pks = (pks as any[]).map(p => p.column_name);
              } else if (dbType === "sqlite") {
                const quoted = quoteIdentifier(tableName, dbType as any);
                const [fkResults, pragmaInfo] = await Promise.all([
                  db.select(`PRAGMA foreign_key_list(${quoted})`) as Promise<any[]>,
                  db.select(`PRAGMA table_info(${quoted})`) as Promise<any[]>,
                ]);
                fks = fkResults;
                pks = pragmaInfo
                  .filter(c => c.pk > 0)
                  .sort((a, b) => a.pk - b.pk)
                  .map(c => c.name);
              }
              const fkMap: Record<string, { columns: string[]; refTable: string; refColumns: string[] }> = {};
              for (const fk of (fks || [])) {
                const colName = fk.column_name || fk.from;
                const refTbl = fk.foreign_table_name || fk.table;
                const refCol = fk.foreign_column_name || fk.to;
                const conName = fk.constraint_name || `${colName}_${refTbl}`;
                if (!fkMap[conName]) {
                  const refTable = (fk.foreign_table_schema && fk.foreign_table_schema !== 'public' && fk.foreign_table_schema !== schemaName)
                    ? `${fk.foreign_table_schema}.${refTbl}`
                    : refTbl;
                  fkMap[conName] = { columns: [], refTable, refColumns: [] };
                }
                fkMap[conName].columns.push(colName);
                fkMap[conName].refColumns.push(refCol);
              }
              const schemaData = { columns: [], foreignKeys: Object.values(fkMap), primaryKeys: pks };
              fkCacheRef.current.set(cacheKey, schemaData);
              setTableSchema(schemaData);
            } catch {
              setTableSchema(undefined);
            }
          })();
        }
      } else if (isSelect) {
        setTableSchema(undefined);
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
      if (cancelFlagRef.current || gen !== executionGenRef.current) return;

      const duration = Date.now() - startTime;
      let errorMsg = typeof err === 'string' ? err : err?.message || JSON.stringify(err) || "Failed to execute query";
      
      // Translate cryptic driver errors into actionable user advice
      let isConnectionLost = false;
      if (errorMsg.includes("closed pool") || errorMsg.includes("connection closed") || errorMsg.includes("Broken pipe")) {
        errorMsg = "Connection Lost: The database cluster has closed the connection pool (session timeout). Please click 'Connect' again in the Database Explorer to refresh the link.";
        isConnectionLost = true;
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
      
      if (gen !== executionGenRef.current) return; // cancelled/superseded: leave UI to the newer run
      if (isConnectionLost) {
        // Drop the cached lazy handle so the next run reconnects instead of
        // reusing the dead pool. Safe: single-flight execution means no newer
        // run can be using it (a cancel would have made this run stale above).
        await dropCachedConnection(actualConnection.id);
      }
      setError(errorMsg);
      if (currentTabId) {
        // Add error to statement results if we have line info. Merge into any
        // partial marks from a multi-statement run (#223) instead of wiping.
        const errorLineNumber = statementInfos?.[0]?.lineNumber || 1;
        const errorStatementResult: StatementResult = {
          lineNumber: errorLineNumber,
          status: 'error',
          error: errorMsg,
          executionTime: duration
        };

        appendGlyphResults(currentTabId, [errorStatementResult]);
        updateTabState(currentTabId, {
          error: errorMsg,
          success: null,
          executionTime: duration,
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
      // Only the latest generation may clear shared run state. A superseded
      // (stale) run reaching its finally must NOT touch shared state at all —
      // a newer run owns it (clearing the gate here would let a third run
      // double-execute alongside the newer one).
      if (gen === executionGenRef.current) {
        cancelFlagRef.current = false;
        setIsExecuting(false);
        isExecutingRef.current = false;
        setExecutingTabId(null);
      }
    }
  }, [activeConnection, selectedDatabase, addQuery, currentDb, vaultCredentials, settings, confirmDialog, appendGlyphResults, ensureConnectionDb, dropCachedConnection]);

  const cancelQuery = useCallback(() => {
    // Signal per-run cancel token so the libpq run-all loop stops early.
    // Each execution creates its own token, so this only affects the current
    // run — a later run gets a fresh uncancelled token.
    if (currentRunCancelRef.current) {
      currentRunCancelRef.current.current = true;
    }
    // Also set the global flag, which the CLI psql path (run-all, \watch,
    // post-exec bail, catch block) still checks as its cancel signal.
    cancelFlagRef.current = true;
    // Release the re-entrancy gate immediately (#212) — the old code held it
    // until the abandoned run's async work settled, so every subsequent Run
    // was silently swallowed (toolbar showed "Run" but nothing executed).
    // The bumped generation makes the abandoned run's catch/finally no-op,
    // so its late return can't clobber whatever runs after the cancel.
    executionGenRef.current++;
    isExecutingRef.current = false;
    setExecutingTabId(null);
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
        const port = activeConnection.port || getDefaultPort(activeConnection.type);

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
        if (detail.tableSchema) {
          setTableSchema({ columns: detail.tableSchema.columns, foreignKeys: detail.tableSchema.foreignKeys || [], primaryKeys: detail.tableSchema.primaryKeys || [] });
        } else {
          setTableSchema(undefined);
        }
        lastSelectQueryRef.current = detail.query;
        executeQuery(detail.query);
      } else {
        setActiveTableName(null);
        setTableColumnTypes(undefined);
        setTableSchema(undefined);
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
            await invokeCmd("save_sessions", {
              tabs,
              activeTabId: activeTabIdRef.current ?? null,
              activeConnectionId: activeConnRef.current?.id ?? null,
              activeDatabase: selectedDbRef.current ?? null,
            });
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
              await invokeCmd("save_sessions", {
                tabs: cleanTabs,
                activeTabId: activeTabIdRef.current ?? null,
                activeConnectionId: activeConnRef.current?.id ?? null,
                activeDatabase: selectedDbRef.current ?? null,
              });
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

  const getPrimaryKey = useCallback((columns: string[]): string | undefined => {
    // Only a SINGLE-column primary key can be expressed through this
    // one-column path. For a composite key, returning just one of its columns
    // would build `WHERE <one col> = …`, which matches on a non-unique value
    // and could UPDATE/DELETE the wrong rows. In that case return undefined so
    // callers fall back to the safe full-row WHERE match below.
    if (tableSchema?.primaryKeys && tableSchema.primaryKeys.length > 1) {
      return undefined;
    }
    if (tableSchema?.primaryKeys && tableSchema.primaryKeys.length === 1) {
      const [pk] = tableSchema.primaryKeys;
      if (columns.includes(pk)) return pk;
    }
    if (!activeTableName) return undefined;
    const baseTableName = activeTableName.includes('.') ? activeTableName.split('.').pop()! : activeTableName;
    const candidates = new Set(["id", "uuid", "uid", "pk", "row_id", "object_id", "key", "code", "_id", `${baseTableName.toLowerCase()}_id`]);
    return columns.find(c => candidates.has(c.toLowerCase()));
  }, [tableSchema, activeTableName]);

  const handleUpdateRow = useCallback(async (oldRow: any, newRow: any) => {
    // Quote with the query's actual target connection dialect, not the
    // globally active one — a tab can target a different engine (e.g. MySQL
    // needs backticks where PostgreSQL needs double quotes). Mirrors the
    // saveConn/conn resolution in handleSave; executeQuery resolves the same
    // target, so quoting must match it.
    const activeTabForUpdate = queryTabs.find(t => t.id === activeTabId);
    const updateTarget = activeTabForUpdate?.target;
    const updateConn = (updateTarget
      ? connections.find(c => c.id === updateTarget.connectionId)
      : activeConnection) || activeConnection;
    if (!updateConn) return;
    const uqid = (name: string) => quoteIdentifier(name, (updateConn.type || "postgres") as DatabaseType);
    if (!activeTableName) {
      setError("Table context missing: Select a table in the explorer or run a SELECT FROM query to enable edits.");
      return;
    }
    
    // Extract base table name for PK detection — schema.prefix.table_name should
    // produce `table_name_id`, not `schema.prefix.table_name_id`.
    const columns = Object.keys(oldRow);
    const pk = getPrimaryKey(columns);
    
    const setClauses: string[] = [];
    const whereClauses: string[] = [];
    
    for (const col of columns) {
      if (String(oldRow[col]) !== String(newRow[col])) {
        setClauses.push(`${uqid(col)} = ${formatSqlLiteral(newRow[col])}`);
      }
    }
    
    if (setClauses.length === 0) return;
    
    if (pk && oldRow[pk] !== undefined && oldRow[pk] !== null) {
      whereClauses.push(`${uqid(pk)} = ${formatSqlLiteral(oldRow[pk])}`);
    } else {
      for (const col of columns) {
        const val = oldRow[col];
        if (val === null) whereClauses.push(`${uqid(col)} IS NULL`);
        else whereClauses.push(`${uqid(col)} = ${formatSqlLiteral(val)}`);
      }
    }
    
    const sqlSet = setClauses.join(", ");
    const sqlWhere = whereClauses.length > 0 ? whereClauses.join(" AND ") : "TRUE";
    const updateQuery = `UPDATE ${uqid(activeTableName)} SET ${sqlSet} WHERE ${sqlWhere}`;

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
        const pk = getPrimaryKey(columns);
        
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
  }, [activeTableName, activeConnection, executeQuery, confirmDialog, connections, queryTabs, activeTabId]);

  const handleDeleteRow = useCallback(async (row: any) => {
    // Same target-connection quoting as handleUpdateRow (see above).
    const activeTabForDelete = queryTabs.find(t => t.id === activeTabId);
    const deleteTarget = activeTabForDelete?.target;
    const deleteConn = (deleteTarget
      ? connections.find(c => c.id === deleteTarget.connectionId)
      : activeConnection) || activeConnection;
    if (!deleteConn) return;
    const dqid = (name: string) => quoteIdentifier(name, (deleteConn.type || "postgres") as DatabaseType);
    if (!activeTableName) {
      setError("Table context missing: Cannot delete row without target table information.");
      return;
    }
    
    const { _isNew, _isModified, ...cleanRow } = row;
    const columns = Object.keys(cleanRow);
    const pk = getPrimaryKey(columns);
    
    const whereClauses: string[] = [];
    
    if (pk && cleanRow[pk] !== undefined && cleanRow[pk] !== null) {
      whereClauses.push(`${dqid(pk)} = ${formatSqlLiteral(cleanRow[pk])}`);
    } else {
      for (const col of columns) {
        const val = cleanRow[col];
        if (val === null) whereClauses.push(`${dqid(col)} IS NULL`);
        else whereClauses.push(`${dqid(col)} = ${formatSqlLiteral(val)}`);
      }
    }
    
    const deleteQuery = `DELETE FROM ${dqid(activeTableName)} WHERE ` + (whereClauses.length > 0 ? whereClauses.join(" AND ") : "FALSE");
    
    try {
      setSuppressTabSwitch(true);
      await executeQuery(deleteQuery);
      setResults(prev => prev.filter(r => {
        const pkItem = getPrimaryKey(columns);
        if (pkItem && cleanRow[pkItem] !== undefined && cleanRow[pkItem] !== null) {
          return String(r[pkItem]) !== String(cleanRow[pkItem]);
        }
        return !columns.every(col => String(r[col]) === String(cleanRow[col]));
      }));
    } finally {
      setSuppressTabSwitch(false);
    }
  }, [activeTableName, activeConnection, executeQuery, connections, queryTabs, activeTabId]);

  const handleSave = useCallback(async (currentResults: any[]) => {
    if (!activeTableName) return;
    // Resolve the save connection first: a tab targeting a known connection
    // is savable even with no global connection (lazy ensure below).
    const saveTab = queryTabs.find(t => t.id === activeTabId);
    const saveTargetConn = saveTab?.target
      ? connections.find(c => c.id === saveTab.target!.connectionId)
      : activeConnection;
    if (!saveTargetConn) return;
    
    const newRows = currentResults.filter(r => r._isNew);
    const modifiedRows = currentResults.filter(r => r._isModified && !r._isNew);
    // Capture the user's original SELECT query before any writes so we can
    // re-run it after save rather than replacing results with a generic
    // `SELECT * FROM table`. This preserves the user's column selection,
    // ORDER BY, LIMIT, and table aliases.
    const originalQuery = lastSelectQueryRef.current;
    
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
      // Lazily established (SSH tunnel included), so saving works on tabs
      // whose connection was never manually connected.
      const activeTab = queryTabs.find(t => t.id === activeTabId);
      const targetConn = activeTab?.target;
      const saveConn = targetConn
        ? connections.find(c => c.id === targetConn.connectionId)
        : activeConnection;
      const saveDbName = targetConn?.database || selectedDatabase || (activeConnection?.database ?? "");
      const conn = saveConn || activeConnection;
      if (!conn) return;
      const db = (await ensureConnectionDb(conn.id, saveDbName)).db;

      // Quote with the SAVE connection's dialect, not the globally active
      // one — a tab can target a different engine (e.g. MySQL needs
      // backticks where PostgreSQL needs double quotes).
      const saveType = conn.type || "postgres";
      const sqid = (name: string) => quoteIdentifier(name, saveType as DatabaseType);
      const isPgLikeSave = ["postgres", "supabase", "cockroach"].includes(saveType);
      const isMySqlLikeSave = saveType === "mysql" || saveType === "mariadb";

      // Split schema-qualified names respecting quotes so
      // `"my.schema"."my.table"` stays two parts, not four.
      const unquoteName = (s: string) =>
        s.trim().replace(/^"(.*)"$/s, "$1").replace(/^`(.*)`$/s, "$1").replace(/""/g, '"');
      const nameParts = splitDottedIdentifier(activeTableName).map(unquoteName);
      const schemaName = nameParts.length > 1
        ? nameParts.slice(0, -1).join(".")
        : (isMySqlLikeSave ? saveDbName : "public");
      const tableName = nameParts[nameParts.length - 1];

      // ─── Step 2: Validate NOT NULL + FK constraints (all providers) ───
      const rowsWithMissing: { rowIndex: number; missing: string[] }[] = [];

      for (let i = 0; i < newRows.length; i++) {
        const { _isNew, ...data } = newRows[i];
        const missing: string[] = [];

        // Check NOT NULL columns that don't have a DEFAULT (these must be provided).
        // Placeholders are dialect-specific: $1/$2 on PostgreSQL-wire
        // engines, ? on MySQL/MariaDB (sqlx does not understand $n there).
        if (["postgres", "supabase", "cockroach", "mysql", "mariadb"].includes(saveType)) {
          const ph1 = isPgLikeSave ? "$1" : "?";
          const ph2 = isPgLikeSave ? "$2" : "?";
          const notNullCols = await db.select(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = ${ph1} AND table_name = ${ph2}
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
        } else if (saveType === "sqlite") {
          const sqliteCols = await db.select(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`);
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
          query = `INSERT INTO ${sqid(activeTableName)} DEFAULT VALUES`;
          if (isMySqlLikeSave) {
             query = `INSERT INTO ${sqid(activeTableName)} () VALUES ()`;
          }
        } else {
          const cols = columns.map(c => sqid(c)).join(", ");
          const vals = columns.map(c => formatSqlLiteral(data[c])).join(", ");
          query = `INSERT INTO ${sqid(activeTableName)} (${cols}) VALUES (${vals})`;
        }
        await db.execute(query);
      }

      // ─── Step 5: Execute UPDATEs directly (bypass executeQuery so errors propagate) ───
      for (const row of modifiedRows) {
        const { _isModified, ...data } = row;
        
        // Find original row for WHERE clause (to prevent overwriting if no PK)
        // In a real app we'd need more robust change tracking, but this works for buffered edits
        const columns = Object.keys(data).filter(c => c !== '_isModified' && c !== '_isNew' && c !== '_original');
        // When no PK is found the fallback WHERE clause must use the pre-edit
        // values (`_original`) so the UPDATE actually matches the DB row.
        // Without this, a clause like `WHERE "name" = 'new_value'` would affect
        // 0 rows because the DB still has `'old_value'`.
        const originalData = (data as any)._original || data;
        
        const pk = getPrimaryKey(columns);
        
        const setClauses: string[] = [];
        const whereClauses: string[] = [];
        
        for (const col of columns) {
           setClauses.push(`${sqid(col)} = ${formatSqlLiteral(data[col])}`);
        }
        
        if (pk && data[pk] !== undefined && data[pk] !== null) {
          whereClauses.push(`${sqid(pk)} = ${formatSqlLiteral(data[pk])}`);
        } else {
          for (const col of columns) {
            const val = originalData[col];
            if (val === null || val === undefined) whereClauses.push(`${sqid(col)} IS NULL`);
            else whereClauses.push(`${sqid(col)} = ${formatSqlLiteral(val)}`);
          }
        }
        
        const sqlSet = setClauses.join(", ");
        const sqlWhere = whereClauses.length > 0 ? whereClauses.join(" AND ") : "TRUE";
        const updateQuery = `UPDATE ${sqid(activeTableName)} SET ${sqlSet} WHERE ${sqlWhere}`;
        
        await db.execute(updateQuery);
      }

      // ─── Step 6: Refresh to get server-side IDs etc. ───
      setSuccess(`Successfully saved ${newRows.length} new and ${modifiedRows.length} modified records.`);
      // Use the save db connection directly rather than going through
      // executeQuery, which may target a different connection/database
      // (stale lastSelectQueryRef) or have stale state. This ensures the
      // refresh reads from the same database that received the writes.
      // Prefer the user's original SELECT query so column selection, ORDER BY,
      // and LIMIT are preserved. Fall back to a full table scan if unavailable.
      let refreshedRows: any[];
      try {
        if (originalQuery) {
          refreshedRows = await db.select(originalQuery) as any[];
        } else {
          throw new Error("no original query");
        }
      } catch {
        const fallbackQuery = `SELECT * FROM ${sqid(activeTableName)} LIMIT 1000`;
        refreshedRows = await db.select(fallbackQuery) as any[];
      }
      setResults(refreshedRows);
      if (refreshedRows.length > 0) {
        setLastColumns(Object.keys(refreshedRows[0]));
      }
      // Stay on the saved record — scroll to the first modified row (located
      // by PK in the refreshed data) so the user doesn't have to hunt for it.
      // New rows can't be located (server-generated keys are unknown until
      // refresh, and refresh order is the query's business), so no scroll.
      setTimeout(() => {
        const firstModified = modifiedRows.length > 0 ? modifiedRows[0] : null;
        if (firstModified) {
          const pk = getPrimaryKey(Object.keys(firstModified));
          const pkVal = pk ? firstModified[pk] : undefined;
          if (pk && pkVal !== undefined) {
            const newIdx = refreshedRows.findIndex((r: any) => String(r[pk]) === String(pkVal));
            if (newIdx >= 0) {
              window.dispatchEvent(new CustomEvent("grid-scroll-to-row", { detail: { index: newIdx } }));
            }
          }
        }
      }, 50);
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
  }, [activeTableName, activeConnection, selectedDatabase, vaultCredentials, executeQuery, confirmDialog, connections, ensureConnectionDb]);

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
      // Merge user-supplied values on top (e.g. duplicated row data).
      // New rows go FIRST so the user sees the editable row immediately
      // without scrolling past the existing data.
      const merged = { ...baseRow, ...newRow, _isNew: true };
      setResults(prev => [merged, ...prev]);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("grid-scroll-to-row", { detail: { index: 0, focus: true } }));
      }, 50);
      return;
    }
    
    if (!activeTableName) return;
    // Same target-aware resolution as handleSave: addable without a global
    // connection when the tab targets a known connection.
    const addTab = queryTabs.find(t => t.id === activeTabId);
    const addTargetConn = addTab?.target
      ? connections.find(c => c.id === addTab.target!.connectionId)
      : activeConnection;
    if (!addTargetConn) return;

    // Persist directly via the same pattern as handleSave: create a dedicated
    // db connection, run INSERT via db.execute(), then SELECT-refresh on the
    // same connection.  This avoids the stale-lastSelectQueryRef and
    // setResults-not-called-for-non-SELECT problems that plagued the old path.
    let db: any;
    try {
      setSuppressTabSwitch(true);

      // ── Build a save-scoped connection (mirrors handleSave Step 1) ──────────
      // Lazily established (SSH tunnel included) so adds work on tabs whose
      // connection was never manually connected.
      const activeTab = queryTabs.find(t => t.id === activeTabId);
      const targetConn = activeTab?.target;
      const saveConn = targetConn
        ? connections.find(c => c.id === targetConn.connectionId)
        : activeConnection;
      const saveDbName = targetConn?.database || selectedDatabase || (activeConnection?.database ?? "");
      const conn = saveConn || activeConnection;
      if (!conn) return;
      db = (await ensureConnectionDb(conn.id, saveDbName)).db;

      // Quote with this operation's connection dialect (see handleSave).
      const addType = conn.type || "postgres";
      const aqid = (name: string) => quoteIdentifier(name, addType as DatabaseType);
      const isMySqlLikeAdd = addType === "mysql" || addType === "mariadb";

      // ── Build and run INSERT ───────────────────────────────────────────────
      const columns = Object.keys(newRow).filter(c => newRow[c] !== null);
      let query = "";
      if (columns.length === 0) {
        query = `INSERT INTO ${aqid(activeTableName)} DEFAULT VALUES`;
        if (isMySqlLikeAdd) {
          query = `INSERT INTO ${aqid(activeTableName)} () VALUES ()`;
        }
      } else {
        const cols = columns.map(c => aqid(c)).join(", ");
        const vals = columns.map(c => formatSqlLiteral(newRow[c])).join(", ");
        query = `INSERT INTO ${aqid(activeTableName)} (${cols}) VALUES (${vals})`;
      }
      await db.execute(query);

      // ── Refresh results on the same connection ─────────────────────────────
      const selectQuery = `SELECT * FROM ${aqid(activeTableName)} LIMIT 1000`;
      const refreshedRows = await db.select(selectQuery) as any[];
      setResults(refreshedRows);
      if (refreshedRows.length > 0) {
        setLastColumns(Object.keys(refreshedRows[0]));
      }
      // Scroll to the last row (the one we just inserted) so the user
      // doesn't have to hunt for it after the grid re-renders.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("grid-scroll-to-bottom"));
      }, 50);
    } catch (err) {
      throw err;
    } finally {
      setSuppressTabSwitch(false);
    }
  }, [activeTableName, activeConnection, executeQuery, confirmDialog, lastColumns, results, vaultCredentials, connections, selectedDatabase, queryTabs, activeTabId, ensureConnectionDb]);

  const handleFkCellClick = useCallback((fk: { refTable: string; refColumns: string[] }, fkValue: any) => {
    // Quote with the query's actual target connection dialect (same reason
    // as handleUpdateRow/handleDeleteRow): executeQuery resolves the tab's
    // target connection, so quoting must match it, not the global one.
    // The query itself lazily connects, so no global handle is required.
    const activeTabForFk = queryTabs.find(t => t.id === activeTabId);
    const fkTarget = activeTabForFk?.target;
    const fkConn = (fkTarget
      ? connections.find(c => c.id === fkTarget.connectionId)
      : activeConnection) || activeConnection;
    if (!fkConn) return;
    const dbType = (fkConn?.type || "postgres") as DatabaseType;
    const qTable = quoteIdentifier(fk.refTable, dbType);
    const whereClause = fk.refColumns.map((refCol, i) => {
      const qCol = quoteIdentifier(refCol, dbType);
      const val = fk.refColumns.length > 1 && Array.isArray(fkValue) ? fkValue[i] : fkValue;
      return `${qCol} = ${formatSqlLiteral(val)}`;
    }).join(" AND ");
    const query = `SELECT * FROM ${qTable} WHERE ${whereClause} LIMIT 1000`;
    setActiveTableName(fk.refTable);
    lastSelectQueryRef.current = query;
    executeQuery(query);
  }, [activeConnection, executeQuery, connections, queryTabs, activeTabId]);

  const handleFormatSql = useCallback(() => {
    window.dispatchEvent(new CustomEvent("format-sql"));
  }, []);

  const handleExplainPlan = useCallback(async () => {
    // Tab-target connections work without a global connect: execution below
    // lazily establishes the target.
    const explainTab = queryTabs.find(t => t.id === activeTabId);
    const explainConn = (explainTab?.target
      ? connections.find(c => c.id === explainTab.target!.connectionId)
      : activeConnection) || activeConnection;
    if (!explainConn) {
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
    if (["postgres", "supabase"].includes(explainConn.type)) {
      explainQuery = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queryToExplain}`;
    } else if (explainConn.type === "mysql") {
      explainQuery = `EXPLAIN FORMAT=JSON ${queryToExplain}`;
    } else {
      explainQuery = `EXPLAIN ${queryToExplain}`;
    }

    await executeQuery(explainQuery);
  }, [activeConnection, executeQuery, connections, queryTabs, activeTabId]);

  const handleVisualOptimize = useCallback(async () => {
    // Tab-target connections work without a global connect (lazy handle below).
    const optimizeTab = queryTabs.find(t => t.id === activeTabId);
    const optimizeTarget = optimizeTab?.target;
    const optimizeConn = (optimizeTarget
      ? connections.find(c => c.id === optimizeTarget.connectionId)
      : activeConnection) || activeConnection;
    if (!optimizeConn) {
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
    const dbType = optimizeConn.type;

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
      // Prefer the tab target's lazily-established handle (correct server even
      // when the globally connected database is a different connection).
      const optimizeDb = optimizeTarget || !currentDb
        ? (await ensureConnectionDb(
            optimizeConn.id,
            optimizeTarget?.database || selectedDatabase || optimizeConn.database,
          )).db
        : currentDb;
      const rows = await optimizeDb.select(explainQuery) as any[];
      
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
  }, [activeConnection, selectedDatabase, currentDb, connections, queryTabs, activeTabId, ensureConnectionDb]);

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

      {/* Combined Tool Window Bar - Top — when a database is selected or the
          active tab targets a known connection (lazy-connect on run).
          Without either, every action (Run, Format, Explain, Compare,
          Clone, Activity, AI, Save) is either disabled or pointless. See #84. */}
      {(isDatabaseReady || canRunOnTabTarget) && (
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
            disabled={!activeConnection && !canRunOnTabTarget}
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
            
            // Determine status for this tab. The running spinner is keyed to
            // the tab that launched the query (#222), not the active tab.
            const tabIsExecuting = executingTabId === tab.id && isExecuting;
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
                
                {/* Close Button — always available, including for the last tab
                    (closing it falls back to the EmptyStateLauncher). */}
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
                      runningCommand={activeTabIsExecuting ? (runningCmdRef.current || activeTab.query || "") : null}
                      isExecuting={activeTabIsExecuting}
                      executionTime={executionTime}
                      onRun={(q: string, info?: { lineNumber: number; statementText: string }) => executeQuery(q, info)}
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
                  onRun={(q: string, info?: { lineNumber: number; statementText: string }) => executeQuery(q, info)}
                  connectionName={activeTab?.target?.connectionName || activeConnection?.name || undefined}
                  databaseName={activeTab?.target?.database || selectedDatabase || undefined}
                  tabId={activeTabId!}
                  tabName={activeTab?.name}
                  isExecuting={activeTabIsExecuting}
                  hasError={!!error}
                  hasSuccess={!!success}
                  statementResults={activeTab?.statementResults}
                  onStatementResultsChange={(rs) => {
                    if (activeTabId) setGlyphResults(activeTabId, rs);
                  }}
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

        {(isDatabaseReady || canRunOnTabTarget) && showServices && !activeTab?.usePsql && (
          <>
            <PanelResizeHandle className="h-1 bg-[var(--neutral-6)] hover:bg-[var(--accent-9)] transition-colors cursor-row-resize select-none shrink-0 data-[resize-handle-state=drag]:bg-[var(--accent-9)] data-[resize-handle-state=hover]:bg-[var(--accent-9)]/60" />
            <Panel minSize={15} maxSize={85} defaultSize={40}>
              <ResultsPanel
            results={results}
            error={error}
            successMessage={success}
            multiResults={multiResults}
            isLoading={activeTabIsExecuting}
            executionTime={executionTime}
            tableName={activeTableName || undefined}
            columnTypes={tableColumnTypes?.types}
            tableSchema={tableSchema}
            loadFKOptions={loadFKOptions}
            onFkCellClick={handleFkCellClick}
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
              // Modified existing rows need server data to revert — the grid
              // only keeps a single `_original` snapshot per row, so a full
              // re-fetch is the reliable way to undo. New rows are pure-client
              // state and can be filtered out without a roundtrip, which is the
              // common case (user added rows, changed their mind).
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
