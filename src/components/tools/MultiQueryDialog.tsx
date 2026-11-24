import { useState, useEffect, useCallback, useRef, useMemo, type SetStateAction, type ReactNode } from "react";
import { X, Play, Loader2, AlertCircle, Layers, ChevronDown, ChevronRight, Folder, Search, CheckCircle, Database, Clock, Table2, AlertTriangle, Info, Star, Download, FileCode, Globe, RefreshCw, Copy, Trash2, FileJson, Sheet, Bookmark, BookmarkPlus, Pencil, Save, Server } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { SavedQueryList } from "../explorer/SavedQueryList";
import { GroupCheckbox } from "./GroupCheckbox";
import { NodeTemplateEditorDialog } from "./NodeTemplateEditorDialog";
import { toCsv, toHtml, toInsertStatements, toXml } from "../../utils/exportFormats";
import { invokeCmd } from "../../lib/ipc";
import { dialectForDbType } from "../editor/sqlBuiltins";
import { settingsReady, useSettings } from "../../store/settingsStore";
import { useSavedQueries } from "../../store/savedQueryStore";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { isSaveShortcut, pruneMissingDatabases, restoreTargets, savedQueryConnectionId, type MultiQueryTarget } from "../../utils/multiQueryTargets";
import {
  editTemplate,
  filterConnectionNodes,
  groupCheckState,
  groupNodesByDatabase,
  isNodeGroupBy,
  sanitizeTemplates,
  templateMatch,
  toggleTargetGroup,
  upsertTemplate,
  isTargetIn,
  selectionAfterTemplateEdit,
  type ConnectionNode,
  type NodeGroupBy,
  type GroupCheckState,
  type NodeTemplate,
} from "../../utils/multiQueryNodes";
import { save } from "@tauri-apps/plugin-dialog";
import { QueryEditor } from "../editor/QueryEditor";
import { useConnections } from "../../contexts/useConnections";
import { GridView, GridViewRef } from "../ui/GridView";
import { CompactSelection } from "@glideapps/glide-data-grid";
import { Dialog } from "../ui/Dialog";
import { splitStatements } from "../../utils/splitStatements";
import { isGridInternalKey } from "../../utils/resultSet";
import { isMySqlLike, isSelectLike } from "../../utils/sqlDialect";
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

type SelectedTarget = MultiQueryTarget;
type SidebarTab = "targets" | "saved";
const GROUP_BY_LABELS: Record<NodeGroupBy, string> = { connection: "Server", database: "Database" };

export function MultiQueryDialog({ isOpen, onClose }: MultiQueryDialogProps) {
  const { connections, ensureConnectionDb } = useConnections();
  const settings = useSettings();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("targets");
  const [nodeFilter, setNodeFilter] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  // Template last used or saved; changing the selection afterwards marks it Modified.
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(null);
  const [expandedDbGroups, setExpandedDbGroups] = useState<Set<string>>(new Set());
  // Collapsed whenever the Nodes tab is shown; only a click on its header opens it.
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const groupBy: NodeGroupBy = isNodeGroupBy(settings.multiQueryGroupBy) ? settings.multiQueryGroupBy : "connection";
  const templates = useMemo(() => sanitizeTemplates(settings.multiQueryNodeTemplates), [settings.multiQueryNodeTemplates]);
  const [selectedTargets, commitSelectedTargets] = useState<SelectedTarget[]>([]);
  // Every selection intent supersedes pending discovery, even before it commits.
  const selectionOperation = useRef(0);
  const applyingTemplate = useRef(false);
  const [selectionPending, setSelectionPending] = useState(false);
  const beginSelection = () => {
    applyingTemplate.current = false;
    setSelectionPending(false);
    return ++selectionOperation.current;
  };
  const setSelectedTargets = (value: SetStateAction<SelectedTarget[]>) => {
    beginSelection();
    commitSelectedTargets(value);
  };
  const [collapsedConnections, setCollapsedConnections] = useState<Set<string>>(new Set());
  const [collapsedDbGroups, setCollapsedDbGroups] = useState<Set<string>>(new Set());
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
  // One timer for every toast, so a newer message isn't cut short by an
  // older one's timeout and none is left on screen.
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashToast = (message: string) => {
    setToastMessage(message);
    setShowToast(true);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setShowToast(false), 2500);
  };
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);
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

  // Selection and draft persist to settings only after the restore below has
  // run, so the empty initial state never overwrites what was saved.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setCollapsedConnections(new Set());
    setCollapsedDbGroups(new Set());
    let cancelled = false;
    setRestored(false);
    setSelectedTargets([]); setExpandedConnections(new Set()); setAvailableDatabases({}); setLoadingDatabases(new Set()); setResults([]); setQuery(""); setError(null); setShowMerged(false);
    dbListRequestsRef.current = new Map();
    setSidebarTab("targets");
    setNodeFilter(""); setSelectedOnly(false); setEditingTemplateId(null); setCurrentTemplateId(null); setTemplatesOpen(false); setExpandedDbGroups(new Set());

    void (async () => {
      await settingsReady;
      if (cancelled) return;
      const saved = useSettings.getState();
      const targets = restoreTargets(saved.multiQueryTargets, connections.map(c => c.id));
      setQuery(saved.multiQueryDraft ?? "");
      setSelectedTargets(targets);
      const targetConnIds = [...new Set(targets.map(t => t.connectionId))];
      setExpandedConnections(new Set(targetConnIds));
      setRestored(true);
      const restoreOperation = selectionOperation.current;

      // A failed fetch drops its ref entry, so only successfully listed connections prune targets.
      const listed: Record<string, string[]> = {};
      await Promise.all(targetConnIds.map(async id => {
        const dbs = await fetchDatabases(id);
        if (dbListRequestsRef.current.has(id)) listed[id] = dbs;
      }));
      if (!cancelled && restoreOperation === selectionOperation.current) setSelectedTargets(prev => pruneMissingDatabases(prev, listed));
    })();
    return () => { cancelled = true; selectionOperation.current++; applyingTemplate.current = false; };
    // Restore once per open; connections/fetchDatabases changing mid-session must not reset the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!restored) return;
    useSettings.getState().setSetting("multiQueryTargets", selectedTargets);
  }, [restored, selectedTargets]);

  // Draft saves debounced while typing, then flushed on close so the last keystrokes aren't lost.
  const latestDraftRef = useRef(query);
  latestDraftRef.current = query;
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => {
      if (useSettings.getState().multiQueryDraft !== query) useSettings.getState().setSetting("multiQueryDraft", query);
    }, 500);
    return () => clearTimeout(timer);
  }, [restored, query]);
  useEffect(() => {
    if (!restored) return;
    return () => {
      if (useSettings.getState().multiQueryDraft !== latestDraftRef.current) {
        useSettings.getState().setSetting("multiQueryDraft", latestDraftRef.current);
      }
    };
  }, [restored]);

  // Sync scroll to search
  useEffect(() => {
    if (columnSearch && columns.length > 0) {
      const idx = columns.findIndex(c => c.toLowerCase().includes(columnSearch.toLowerCase()));
      if (idx >= 0) {
        gridRef.current?.scrollToColumn(idx);
      }
    }
  }, [columnSearch, columns]);

  // In-flight/finished database-list requests per connection, so Select All,
  // expanding a node and the per-connection checkbox share one request.
  const dbListRequestsRef = useRef(new Map<string, Promise<string[]>>());

  /**
   * Every database on a connection, fetched through `ensureConnectionDb` —
   * the same path the editor uses, so SSH tunnels, vault credentials and
   * IPv6 hosts work. A failed request is not cached, so it can be retried.
   */
  const fetchDatabases = useCallback((connId: string): Promise<string[]> => {
    const pending = dbListRequestsRef.current.get(connId);
    if (pending) return pending;
    const conn = connections.find(c => c.id === connId);
    if (!conn) return Promise.resolve([]);

    const operation = selectionOperation.current;
    const requests = dbListRequestsRef.current;
    const request = (async () => {
      setLoadingDatabases(prev => new Set(prev).add(connId));
      try {
        if (conn.type === "sqlite") {
          const list = [conn.filepath || conn.database || "main"];
          setAvailableDatabases(prev => ({ ...prev, [connId]: list }));
          return list;
        }
        const { db } = await ensureConnectionDb(conn.id, conn.database || undefined);
        let dbs: string[] = [];
        if (["postgres", "supabase", "cockroach"].includes(conn.type)) {
          const rows = await db.select("SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname") as Array<{ datname: string }>;
          dbs = rows.map(r => r.datname);
        } else if (["mysql", "mariadb"].includes(conn.type)) {
          const rows = await db.select("SHOW DATABASES") as Array<Record<string, string>>;
          dbs = rows
            .map(r => r.Database ?? Object.values(r)[0])
            .filter(name => !["information_schema", "performance_schema", "mysql", "sys"].includes(name));
        }
        const list = dbs.length > 0 ? dbs : [conn.database].filter(Boolean);
        if (requests === dbListRequestsRef.current) setAvailableDatabases(prev => ({ ...prev, [connId]: list }));
        return list;
      } catch (e) {
        requests.delete(connId);
        if (operation === selectionOperation.current) setError(`Could not list databases for ${conn.name}: ${e instanceof Error ? e.message : String(e)}`);
        return [conn.database].filter(Boolean);
      } finally {
        if (requests === dbListRequestsRef.current) setLoadingDatabases(prev => { const next = new Set(prev); next.delete(connId); return next; });
      }
    })();
    dbListRequestsRef.current.set(connId, request);
    return request;
  }, [connections, ensureConnectionDb]);

  const [isExecuting, setIsExecuting] = useState(false);

  const executeQuery = async (queryText?: any, _statementInfo?: any) => {
    if (applyingTemplate.current) return;
    if (selectedTargets.length === 0) { setError("Please select at least one database"); return; }

    // Determine what text to run. Pre-split `__runAll` payloads (already
    // split by the editor under its own dialect) are reused verbatim;
    // otherwise the raw text is split PER TARGET below, because `#` is a
    // MySQL comment but a PostgreSQL operator start (`#>`, `#>>`) — one
    // shared split corrupts one side on mixed-dialect runs.
    let queryToRun = "";
    let preSplit: string[] | null = null;

    if (queryText && typeof queryText === 'object' && queryText.__runAll) {
      preSplit = queryText.statements || [];
    } else {
      queryToRun = typeof queryText === 'string' ? queryText : query;
      if (!queryToRun.trim()) { setError("Empty query"); return; }
    }

    if (preSplit && preSplit.length === 0) return;

    setError(null);
    setIsExecuting(true);

    // Issue 1 FIX: Auto-expand connections that have selected targets
    const targetConnectionIds = selectedTargets.map(t => t.connectionId);
    setExpandedConnections(prev => {
      const next = new Set(prev);
      targetConnectionIds.forEach(connId => {
        next.add(connId);
        void fetchDatabases(connId);
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

    const runTarget = async (target: SelectedTarget) => {
      const conn = connections.find(c => c.id === target.connectionId);
      if (!conn) return;
      const startTime = Date.now();

      // Split under this target's own dialect (see above). Statement
      // classification below already runs per target, so split + classify
      // stay aligned on mixed runs.
      const hashOpts = { hashComments: isMySqlLike(conn.type) };
      const targetStatements = preSplit ?? splitStatements(queryToRun, hashOpts).map(s => s.text);
      if (targetStatements.length === 0) return;

      try {
        // Same connection path as the editor: SSH tunnel, vault credentials,
        // IPv6 hosts and the per-database handle cache.
        const { db } = await ensureConnectionDb(conn.id, target.database);

        let lastRows: any[] = [];
        let lastCols: string[] = [];
        let totalAffected = 0;

        for (const stmt of targetStatements) {
          if (isSelectQueryFor(stmt, conn.type)) {
            const rows = await db.select(stmt) as any[];
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
    };

    // Run targets concurrently, a few at a time, instead of strictly one after
    // another: 8 databases no longer take 8x the slowest round trip.
    const queue = [...selectedTargets];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await runTarget(next);
    });
    await Promise.all(workers);
    setIsExecuting(false);
  };

  const getTargetStatus = (connId: string, db: string) => results.find(r => r.connectionId === connId && r.databaseName === db)?.status;

  const getSelectedCount = (connId: string) => selectedTargets.filter(t => t.connectionId === connId).length;
  const isTargetSelected = (connId: string, db: string) => selectedTargets.some(t => t.connectionId === connId && t.database === db);

  const filterActive = nodeFilter.trim() !== "" || selectedOnly;
  const visibleNodes = useMemo(
    () => filterConnectionNodes(connections, availableDatabases, selectedTargets, { query: nodeFilter, selectedOnly }),
    [connections, availableDatabases, selectedTargets, nodeFilter, selectedOnly],
  );
  const visibleTargets = useMemo(
    () => visibleNodes.flatMap(n => n.databases.map(database => ({ connectionId: n.connectionId, database }))),
    [visibleNodes],
  );
  const connectionById = useMemo(() => new Map(connections.map(c => [c.id, c])), [connections]);
  const modifiedTemplate = templates.find(t => t.id === currentTemplateId && selectedTargets.length > 0 && templateMatch(t.targets, selectedTargets) !== "exact");
  const activeTemplate = useMemo(
    () => templates.find(t => templateMatch(t.targets, selectedTargets) === "exact"),
    [templates, selectedTargets],
  );

  // Database-name filtering and grouping by database need every server's
  // database list, not just the expanded ones.
  const needAllLists = nodeFilter.trim() !== "" || groupBy === "database";
  useEffect(() => {
    if (!isOpen || !restored || !needAllLists) return;
    connections.forEach(c => { void fetchDatabases(c.id); });
    // fetchDatabases caches requests, including when connections change.
  }, [isOpen, restored, needAllLists, connections, fetchDatabases]);

  // Select All means every database on every connection, so the lists are
  // fetched first (they were only known for expanded connections, which made
  // Select All pick just each connection's default database). With a filter
  // active it toggles only what the filter shows.
  const [selectingAll, setSelectingAll] = useState(false);
  const toggleSelectAll = async () => {
    const operation = beginSelection();
    if (filterActive) {
      setSelectedTargets(prev => toggleTargetGroup(prev, visibleTargets));
      return;
    }
    if (selectedTargets.length > 0) {
      setSelectedTargets([]);
      return;
    }
    setSelectingAll(true);
    try {
      const lists = await Promise.all(connections.map(async conn => ({ conn, dbs: await fetchDatabases(conn.id) })));
      if (operation !== selectionOperation.current) return;
      setSelectedTargets(lists.flatMap(({ conn, dbs }) => dbs.map(db => ({ connectionId: conn.id, database: db }))));
      setExpandedConnections(new Set(connections.map(c => c.id)));
    } finally {
      setSelectingAll(false);
    }
  };

  const toggleTarget = (connId: string, db: string) => {
    setSelectedTargets(prev => {
        const idx = prev.findIndex(t => t.connectionId === connId && t.database === db);
        if (idx >= 0) return prev.filter((_, i) => i !== idx);
        return [...prev, { connectionId: connId, database: db }];
    });
  };

  /** Unfiltered, a server checkbox covers every database (lists fetched first); filtered, only the visible ones. */
  const toggleNodes = async (nodes: readonly ConnectionNode[]) => {
    const operation = beginSelection();
    let group: SelectedTarget[];
    if (filterActive) {
      group = nodes.flatMap(n => n.databases.map(database => ({ connectionId: n.connectionId, database })));
    } else {
      const lists = await Promise.all(nodes.map(async n => ({ id: n.connectionId, dbs: await fetchDatabases(n.connectionId) })));
      if (operation !== selectionOperation.current) return;
      group = lists.flatMap(({ id, dbs }) => dbs.map(database => ({ connectionId: id, database })));
      setExpandedConnections(prev => { const next = new Set(prev); nodes.forEach(n => next.add(n.connectionId)); return next; });
    }
    setSelectedTargets(prev => toggleTargetGroup(prev, group));
  };

  const nodeCheckState = (nodes: readonly ConnectionNode[]): GroupCheckState => {
    const all = nodes.flatMap(n => (filterActive ? n.databases : availableDatabases[n.connectionId] ?? n.databases)
      .map(database => ({ connectionId: n.connectionId, database })));
    const state = groupCheckState(selectedTargets, all);
    // Databases outside the known list (not fetched yet) still count as a partial selection.
    if (!filterActive && nodes.some(n => availableDatabases[n.connectionId] === undefined && getSelectedCount(n.connectionId) > 0)) return "some";
    return state;
  };

  const setGroupBy = (value: NodeGroupBy) => useSettings.getState().setSetting("multiQueryGroupBy", value);

  const confirmDialog = useConfirmDialog();
  const { addQuery: addSavedQuery, updateQueryText, findByName } = useSavedQueries();
  // Blocks a second save while the name dialog is open (button + Ctrl+S).
  const savingRef = useRef(false);

  const saveClusterQuery = async () => {
    if (savingRef.current) return;
    const queryToSave = query;
    if (!queryToSave.trim()) {
      setError("Query is empty — type a SQL statement before saving.");
      return;
    }
    savingRef.current = true;
    try {
      // Single-connection selections save under that connection; mixed ones save as global.
      const connectionId = savedQueryConnectionId(selectedTargets);
      const conn = connections.find(c => c.id === connectionId);
      const entered = await confirmDialog.dialog({
        title: "Save Query",
        message: `Save to your library${conn ? ` for ${conn.name}` : ""}. An existing query with the same name${conn ? " on this connection" : ""} is overwritten.`,
        inputLabel: "Query Name",
        inputDefaultValue: "Cluster Query",
        confirmLabel: "Save",
        cancelLabel: "Cancel",
        type: "info",
        requireInput: true,
      });
      const name = typeof entered === "string" ? entered.trim() : "";
      if (!name) return;
      const existing = findByName(name, connectionId);
      if (existing) await updateQueryText(existing.id, queryToSave, "");
      else await addSavedQuery({ name, query: queryToSave, database: "", connectionId });
      flashToast(`Saved query: ${name}`);
    } catch (e) {
      setError(`Could not save query: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      savingRef.current = false;
    }
  };
  const templatesNow = () => sanitizeTemplates(useSettings.getState().multiQueryNodeTemplates);
  const writeTemplates = (next: NodeTemplate[]) => useSettings.getState().setSetting("multiQueryNodeTemplates", next);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const saveNodeTemplate = async () => {
    if (savingRef.current) return;
    if (selectedTargets.length === 0) {
      setError("Select at least one database before saving a node template.");
      return;
    }
    savingRef.current = true;
    try {
      const entered = await confirmDialog.dialog({
        title: "Save Node Template",
        message: `Save the ${plural(selectedTargets.length, "selected database")} as a reusable template. An existing template with the same name is overwritten.`,
        inputLabel: "Template Name",
        inputDefaultValue: activeTemplate?.name ?? "",
        confirmLabel: "Save",
        cancelLabel: "Cancel",
        type: "info",
        requireInput: true,
      });
      const name = typeof entered === "string" ? entered.trim() : "";
      if (!name) return;
      const result = upsertTemplate(templatesNow(), name, selectedTargets, Date.now(), () => crypto.randomUUID());
      writeTemplates(result.templates);
      setCurrentTemplateId(result.template.id);
      flashToast(`${result.replaced ? "Updated" : "Saved"} template: ${name}`);
    } finally {
      savingRef.current = false;
    }
  };

  const applyTemplate = async (template: NodeTemplate) => {
    const targets = restoreTargets(template.targets, connections.map(c => c.id));
    const operation = beginSelection();
    applyingTemplate.current = true;
    setSelectionPending(true);
    const connIds = [...new Set(targets.map(t => t.connectionId))];
    const listed: Record<string, string[]> = {};
    await Promise.all(connIds.map(async id => {
      const dbs = await fetchDatabases(id);
      if (dbListRequestsRef.current.has(id)) listed[id] = dbs;
    }));
    if (operation !== selectionOperation.current) return;
    const finalized = pruneMissingDatabases(targets, listed);
    const missing = template.targets.length - finalized.length;
    commitSelectedTargets(finalized);
    applyingTemplate.current = false;
    setSelectionPending(false);
    setCurrentTemplateId(template.id);
    setExpandedConnections(prev => new Set([...prev, ...connIds]));
    flashToast(`Applied template: ${template.name} (${plural(finalized.length, "database")})`);
    setError(missing > 0 ? `${plural(missing, "database")} in "${template.name}" no longer exist${missing === 1 ? "s" : ""} and ${missing === 1 ? "was" : "were"} skipped.` : null);
  };

  const saveTemplateEdit = (id: string, name: string, targets: MultiQueryTarget[]): string | null => {
    const current = templatesNow();
    const result = editTemplate(current, id, name, targets, Date.now());
    if (result.error !== undefined) return result.error;
    writeTemplates(result.templates);
    setEditingTemplateId(null);

    const previous = current.find(t => t.id === id)?.targets ?? [];
    const nextSelection = selectionAfterTemplateEdit(previous, targets, selectedTargets, id === currentTemplateId, connections.map(c => c.id), availableDatabases);
    if (nextSelection) {
      setSelectedTargets(nextSelection);
      setCurrentTemplateId(id);
      setExpandedConnections(prev => new Set([...prev, ...nextSelection.map(t => t.connectionId)]));
      flashToast(`Updated template: ${name.trim()} — ${plural(nextSelection.length, "database")} selected`);
    } else {
      flashToast(`Updated template: ${name.trim()}`);
    }
    return null;
  };

  const updateTemplateFromSelection = async (template: NodeTemplate) => {
    if (selectedTargets.length === 0) {
      setError("Select at least one database to store in the template.");
      return;
    }
    const added = selectedTargets.filter(t => !isTargetIn(template.targets, t.connectionId, t.database)).length;
    const removed = template.targets.filter(t => !isTargetIn(selectedTargets, t.connectionId, t.database)).length;
    const changes = [added > 0 && `add ${plural(added, "database")}`, removed > 0 && `remove ${plural(removed, "database")}`].filter(Boolean).join(" and ");
    const ok = await confirmDialog.confirm({
      title: "Update node template",
      message: `Save the ${plural(selectedTargets.length, "selected database")} into "${template.name}"? This will ${changes}.`,
      confirmLabel: "Update",
      type: "info",
    });
    if (!ok) return;
    const result = editTemplate(templatesNow(), template.id, template.name, selectedTargets, Date.now());
    if (result.error !== undefined) {
      setError(result.error);
      return;
    }
    writeTemplates(result.templates);
    setCurrentTemplateId(template.id);
    flashToast(`Updated template: ${template.name} (${plural(selectedTargets.length, "database")})`);
  };

  const deleteTemplate = async (template: NodeTemplate) => {
    const ok = await confirmDialog.confirm({
      title: "Delete node template",
      message: `Delete the template "${template.name}"? The databases themselves are not affected.`,
      confirmLabel: "Delete",
      type: "danger",
    });
    if (!ok) return;
    writeTemplates(templatesNow().filter(t => t.id !== template.id));
    setEditingTemplateId(null);
  };

  const isTargetMissing = (t: SelectedTarget) => {
    if (!connectionById.has(t.connectionId)) return true;
    const listed = availableDatabases[t.connectionId];
    return !!listed && !listed.includes(t.database);
  };

  const saveClusterQueryRef = useRef(saveClusterQuery);
  saveClusterQueryRef.current = saveClusterQuery;

  // Capture phase on window runs before MainContent's bubble-phase Ctrl+S,
  // which would otherwise save the main editor tab behind this dialog.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSaveShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      void saveClusterQueryRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen]);

  const exportData = async (f: "csv" | "excel" | "json" | "xml" | "html" | "sql") => {
    if (!currentResult?.rows?.length) return;
    try {
        const mapping: Record<string, string> = {
          csv: "csv", json: "json", excel: "xlsx", xml: "xml", html: "html", sql: "sql"
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

        // Shared, tested serialisers (RFC 4180 CSV, escaped XML/HTML,
        // quoted SQL); Excel goes to the native .xlsx writer above.
        if (f === "excel") {
          // Real .xlsx, written natively by the backend (export.rs).
          await invokeCmd("export_xlsx", {
            path,
            sheetName: currentResult.databaseName || null,
            columns: cols,
            rows: rows.map(r => cols.map(c => r[c] ?? null)),
          });
          flashToast(`Exported ${rows.length} rows to Excel`);
          return;
        }
        if (f === "json") content = JSON.stringify(rows, null, 2);
        else if (f === "csv") content = toCsv(cols, rows);
        else if (f === "xml") content = toXml(cols, rows);
        else if (f === "html") content = toHtml(cols, rows);
        else if (f === "sql") {
          const dialect = dialectForDbType(connections.find(c => c.id === currentResult.connectionId)?.type);
          content = toInsertStatements("exported_data", cols, rows, dialect);
        }

        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(path, content);
        flashToast(`Exported ${f.toUpperCase()} successfully`);
    } catch (e: any) { setError(e.message); }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    flashToast("Copied to clipboard");
  };

  const generateSqlForSelected = (type: "INSERT" | "UPDATE" | "DELETE") => {
    const selectedRows = gridSelection.rows.toArray().map((idx: number) => sortedRows[idx]);
    if (selectedRows.length === 0 && contextMenu?.row) selectedRows.push(contextMenu.row);
    if (selectedRows.length === 0) return;

    const table = "target_table";
    const sqlColumns = selectedRows.length > 0
      ? Object.keys(selectedRows[0]).filter(k => !isGridInternalKey(k))
      : columns.filter(k => !isGridInternalKey(k));

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

  const renderTargetRow = (connId: string, db: string, label: string, icon: ReactNode, subtitle?: string) => {
    const selected = isTargetSelected(connId, db);
    const status = getTargetStatus(connId, db);
    const result = results.find(r => r.connectionId === connId && r.databaseName === db);
    return (
      <div
        key={`${connId}/${db}`}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all ${
          selected
            ? "bg-[var(--accent-9)]/15 text-[var(--accent-11)] border border-[var(--accent-9)]/30"
            : "hover:bg-[var(--neutral-4)] opacity-70 border border-transparent"
        }`}
      >
        <GroupCheckbox state={selected ? "all" : "none"} size="sm" label={`Select ${connectionById.get(connId)?.name ?? connId} / ${db}`} onChange={() => toggleTarget(connId, db)} />
        {result && <button type="button" aria-label={`Open result details for ${connectionById.get(connId)?.name ?? connId} / ${db}`} onClick={() => setStatusDetailModal(result)}
          onMouseEnter={() => { if (status) setHoveredStatus({ connId, db, result }); }} onMouseLeave={() => setHoveredStatus(null)}>
          {status === "running" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : status === "error" ? <AlertCircle className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}
        </button>}
        {icon}
        <div className="flex-1 min-w-0">
          <span className="text-[11px] truncate block font-medium">{label}</span>
          {subtitle && <span className="text-[9px] text-[var(--neutral-11)] truncate block">{subtitle}</span>}
        </div>
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
  };

  const renderConnectionNode = (node: ConnectionNode) => {
    const conn = connectionById.get(node.connectionId);
    if (!conn) return null;
    // A filter shows its matches without needing each server expanded by hand.
    const isExp = !collapsedConnections.has(conn.id) && (expandedConnections.has(conn.id) || filterActive);
    const count = getSelectedCount(conn.id);
    const total = (availableDatabases[conn.id] || [conn.database]).length;
    return (
      <div key={conn.id} className="mb-2">
        <div className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-[var(--neutral-4)] group bg-[var(--surface-panel)] border border-[var(--neutral-6)]">
          <button
            onClick={() => { setCollapsedConnections(prev => { const n = new Set(prev); if (isExp) n.add(conn.id); else n.delete(conn.id); return n; }); if (!isExp) void fetchDatabases(conn.id); setExpandedConnections(prev => { const n = new Set(prev); if (isExp) n.delete(conn.id); else n.add(conn.id); return n; }); }}
            className="p-1 rounded hover:bg-[var(--neutral-5)] transition-colors"
            aria-label={isExp ? "Collapse" : "Expand"}
          >
            {isExp ? <ChevronDown className="w-4 h-4 text-[var(--accent-11)]" /> : <ChevronRight className="w-4 h-4 text-[var(--accent-11)]" />}
          </button>
          <label className="flex-1 flex items-center gap-3 cursor-pointer min-w-0">
            <GroupCheckbox state={nodeCheckState([node])} label={`Select databases on ${conn.name}`} onChange={() => void toggleNodes([node])} />
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold truncate block">{conn.name}</span>
              <span className="text-[9px] text-[var(--neutral-11)] truncate block">{conn.type} • {conn.host}</span>
            </div>
            {loadingDatabases.has(conn.id) && (
              <Loader2 className="w-3 h-3 animate-spin text-[var(--neutral-11)]" aria-label="Loading databases" />
            )}
            {count > 0 && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent-9)]/20 text-[var(--accent-11)] font-bold"
                title={`${count} of ${total} databases selected`}
              >
                {count}
              </span>
            )}
          </label>
        </div>
        {isExp && (
          <div className="ml-4 pl-3 py-2 border-l-2 border-[var(--neutral-6)] space-y-1.5">
            {node.databases.map(db => renderTargetRow(conn.id, db, db, <Folder className={`w-4 h-4 ${isTargetSelected(conn.id, db) ? "text-[var(--accent-11)]" : "text-[var(--neutral-9)]"}`} />))}
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <>
      <Dialog
        open={isOpen}
        onClose={onClose}
        dismissOnEsc={!editingTemplateId && !statusDetailModal}
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
          <div className="w-[22rem] border-r border-[var(--neutral-6)] flex flex-col bg-[var(--surface-elevated)] shrink-0">
            {/* Sidebar Tabs */}
            <div className="flex border-b border-[var(--neutral-6)] bg-[var(--surface-panel)]">
              {([
                { id: "targets", label: "Nodes", icon: <Database className="w-3.5 h-3.5" /> },
                { id: "saved", label: "Saved Queries", icon: <Star className="w-3.5 h-3.5" /> },
              ]as { id: SidebarTab; label: string; icon: ReactNode }[]).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => { if (tab.id === "targets" && sidebarTab !== "targets") setTemplatesOpen(false); setSidebarTab(tab.id); }}
                  className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-all border-b-2 flex items-center justify-center gap-1.5 whitespace-nowrap ${sidebarTab === tab.id ? "text-[var(--accent-11)] border-[var(--accent-9)] bg-[var(--surface-base)]" : "text-[var(--neutral-11)] border-transparent hover:text-[var(--neutral-12)] hover:bg-[var(--neutral-4)]"}`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {sidebarTab === "targets" && (
              <div className="border-b border-[var(--neutral-6)] bg-[var(--surface-panel)]">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    onClick={() => setTemplatesOpen(!templatesOpen)}
                    aria-expanded={templatesOpen}
                    className="flex-1 flex items-center gap-2 min-w-0 text-left"
                  >
                    {templatesOpen ? <ChevronDown className="w-4 h-4 text-[var(--accent-11)] shrink-0" /> : <ChevronRight className="w-4 h-4 text-[var(--accent-11)] shrink-0" />}
                    <Bookmark className={`w-4 h-4 text-[var(--accent-11)] shrink-0 ${activeTemplate ? "fill-current" : ""}`} />
                    <span className="text-[11px] font-bold text-[var(--neutral-11)] uppercase tracking-wider shrink-0">Templates</span>
                    {templates.length > 0 && (
                      <span className="text-[9px] px-1.5 rounded-full bg-[var(--neutral-5)] text-[var(--neutral-11)] shrink-0">{templates.length}</span>
                    )}
                    {!templatesOpen && activeTemplate && (
                      <span className="text-[10px] font-semibold text-[var(--accent-11)] truncate" title="The selection matches this template">{activeTemplate.name}</span>
                    )}
                    {!templatesOpen && !activeTemplate && modifiedTemplate && (
                      <span className="text-[10px] font-semibold text-[var(--warning-11)] truncate" title="The selection has changed since this template was used">{modifiedTemplate.name} • Modified</span>
                    )}
                  </button>
                  <IconButton
                    size="xs"
                    icon={<BookmarkPlus />}
                    label="Save selection as template"
                    title="Save the selected databases as a node template"
                    onClick={() => void saveNodeTemplate()}
                    disabled={selectedTargets.length === 0}
                    className="text-[var(--accent-11)] hover:bg-[var(--accent-3)]"
                  />
                </div>
                {templatesOpen && (
                  templates.length === 0 ? (
                    <p className="px-3 pb-3 text-[10px] text-[var(--neutral-11)] opacity-70">
                      Select databases below, then click <BookmarkPlus className="w-3 h-3 inline -mt-0.5" /> to save them as a template you can re-select in one click.
                    </p>
                  ) : (
                    <div className="px-3 pb-3 space-y-1 max-h-56 overflow-y-auto scrollbar-thin">
                      {templates.map(template => {
                        const match = templateMatch(template.targets, selectedTargets);
                        const serverCount = new Set(template.targets.map(t => t.connectionId)).size;
                        const missing = template.targets.filter(isTargetMissing).length;
                        const modified = template.id === modifiedTemplate?.id;
                        return (
                          <div
                            key={template.id}
                            className={`group flex items-center gap-2 pl-2.5 pr-1 py-1.5 rounded-md border transition-all ${
                              match === "exact"
                                ? "border-[var(--accent-9)] bg-[var(--accent-9)]/10"
                                : match === "partial"
                                ? "border-[var(--accent-9)]/40"
                                : "border-transparent hover:border-[var(--neutral-6)] hover:bg-[var(--neutral-4)]"
                            }`}
                          >
                            <button
                              onClick={() => void applyTemplate(template)}
                              className="flex-1 flex items-center gap-2 min-w-0 text-left"
                              title={`Select ${plural(template.targets.length, "database")} on ${plural(serverCount, "server")}`}
                            >
                              <Bookmark className={`w-3.5 h-3.5 shrink-0 text-[var(--accent-11)] ${match === "exact" ? "fill-current" : ""}`} />
                              <span className="text-xs font-semibold truncate text-[var(--neutral-12)]">{template.name}</span>
                              {match === "exact" && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent-9)] text-white font-bold shrink-0">Active</span>}
                              {modified && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--warning-3)] text-[var(--warning-11)] font-bold shrink-0" title="The selection has changed since this template was used">Modified</span>}
                              {match === "partial" && !modified && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent-9)]/20 text-[var(--accent-11)] font-bold shrink-0">Partial</span>}
                              {missing > 0 && (
                                <span title={`${plural(missing, "database")} no longer exist${missing === 1 ? "s" : ""}`} className="shrink-0">
                                  <AlertTriangle className="w-3 h-3 text-[var(--warning-11)]" />
                                </span>
                              )}
                            </button>
                            <IconButton
                              size="xs"
                              icon={<Save />}
                              label="Update template with current selection"
                              title={`Save the ${plural(selectedTargets.length, "selected database")} into this template`}
                              onClick={() => void updateTemplateFromSelection(template)}
                              disabled={selectedTargets.length === 0 || match === "exact"}
                              className={`text-[var(--accent-11)] hover:bg-[var(--accent-3)] transition-opacity ${modified ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
                            />
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              <IconButton size="xs" icon={<Pencil />} label="Edit template" title="Edit name and databases" onClick={() => setEditingTemplateId(template.id)} />
                              <IconButton size="xs" icon={<Trash2 />} label="Delete template" title="Delete" onClick={() => void deleteTemplate(template)} className="text-[var(--danger-11)] hover:bg-[var(--danger-3)]" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
              </div>
            )}
            {sidebarTab === "targets" && (
              <div className="p-3 border-b border-[var(--neutral-6)] space-y-2 bg-[var(--surface-panel)]">
                <div className="flex justify-between items-center gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Database className="w-4 h-4 text-[var(--accent-11)] shrink-0" />
                    <span className="text-[11px] font-bold text-[var(--neutral-11)] uppercase tracking-wider">Sync Group</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="xs" variant="secondary" onClick={toggleSelectAll} loading={selectingAll} disabled={selectingAll || (filterActive && visibleTargets.length === 0)}>
                      {filterActive
                        ? (groupCheckState(selectedTargets, visibleTargets) === "all" ? "Clear Visible" : "Select Visible")
                        : (selectedTargets.length ? "Clear All" : "Select All")}
                    </Button>
                  </div>
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--neutral-11)]" />
                  <input
                    value={nodeFilter}
                    onChange={(e) => setNodeFilter(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape" && nodeFilter) { e.stopPropagation(); setNodeFilter(""); } }}
                    placeholder="Filter servers or databases…"
                    aria-label="Filter servers or databases"
                    className="w-full pl-7 pr-7 py-1.5 text-xs rounded bg-[var(--surface-base)] border border-[var(--neutral-6)] outline-none focus:border-[var(--accent-8)] text-[var(--neutral-12)]"
                  />
                  {nodeFilter && (
                    <button onClick={() => setNodeFilter("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--neutral-5)]" aria-label="Clear filter">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex rounded-md border border-[var(--neutral-6)] overflow-hidden" role="group" aria-label="Group nodes by">
                    {(Object.keys(GROUP_BY_LABELS) as NodeGroupBy[]).map(mode => (
                      <button
                        key={mode}
                        onClick={() => setGroupBy(mode)}
                        aria-pressed={groupBy === mode}
                        className={`px-2 py-1 text-[10px] font-semibold transition-colors ${groupBy === mode ? "bg-[var(--accent-9)] text-white" : "text-[var(--neutral-11)] hover:bg-[var(--neutral-4)]"}`}
                      >
                        {GROUP_BY_LABELS[mode]}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-[10px] text-[var(--neutral-11)] cursor-pointer select-none">
                    <input type="checkbox" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} className="accent-[var(--accent-9)]" />
                    Selected only
                  </label>
                </div>
              </div>
            )}
            {sidebarTab === "saved" && (
              <div className="p-4 border-b border-[var(--neutral-6)] flex items-center gap-2 bg-[var(--surface-panel)]">
                <Folder className="w-4 h-4 text-[var(--accent-11)]" />
                <span className="text-[11px] font-bold text-[var(--neutral-11)] uppercase tracking-wider">Saved Queries</span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
              {sidebarTab === "targets" && (
                <div className="space-y-2">
                  {visibleNodes.length === 0 && (
                    <p className="text-center py-6 text-[11px] opacity-50">
                      {connections.length === 0 ? "No connections yet." : selectedOnly && !nodeFilter.trim() ? "Nothing selected." : `No servers or databases match "${nodeFilter.trim()}".`}
                    </p>
                  )}
                  {groupBy === "connection" && visibleNodes.map(renderConnectionNode)}
                  {groupBy === "database" && groupNodesByDatabase(visibleNodes).map(group => {
                    const members = group.connectionIds.map(connectionId => ({ connectionId, database: group.database }));
                    const isExp = !collapsedDbGroups.has(group.database) && (expandedDbGroups.has(group.database) || filterActive);
                    const count = members.filter(t => isTargetSelected(t.connectionId, t.database)).length;
                    return (
                      <div key={group.database} className="mb-2">
                        <div className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-[var(--neutral-4)] bg-[var(--surface-panel)] border border-[var(--neutral-6)]">
                          <button
                            onClick={() => { setCollapsedDbGroups(prev => { const n = new Set(prev); if (isExp) n.add(group.database); else n.delete(group.database); return n; }); setExpandedDbGroups(prev => { const n = new Set(prev); if (isExp) n.delete(group.database); else n.add(group.database); return n; }); }}
                            className="p-1 rounded hover:bg-[var(--neutral-5)] transition-colors"
                            aria-label={isExp ? "Collapse" : "Expand"}
                          >
                            {isExp ? <ChevronDown className="w-4 h-4 text-[var(--accent-11)]" /> : <ChevronRight className="w-4 h-4 text-[var(--accent-11)]" />}
                          </button>
                          <label className="flex-1 flex items-center gap-3 cursor-pointer min-w-0">
                            <GroupCheckbox state={groupCheckState(selectedTargets, members)} label={`Select ${group.database} on visible servers`} onChange={() => setSelectedTargets(prev => toggleTargetGroup(prev, members))} />
                            <div className="flex-1 min-w-0">
                              <span className="text-xs font-semibold truncate block">{group.database}</span>
                              <span className="text-[9px] text-[var(--neutral-11)] truncate block">on {plural(group.connectionIds.length, "server")}</span>
                            </div>
                            {count > 0 && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent-9)]/20 text-[var(--accent-11)] font-bold" title={`${count} of ${members.length} servers selected`}>
                                {count}
                              </span>
                            )}
                          </label>
                        </div>
                        {isExp && (
                          <div className="ml-4 pl-3 py-2 border-l-2 border-[var(--neutral-6)] space-y-1.5">
                            {group.connectionIds.map(connId => {
                              const conn = connectionById.get(connId);
                              return renderTargetRow(connId, group.database, conn?.name ?? connId, <Server className={`w-4 h-4 ${isTargetSelected(connId, group.database) ? "text-[var(--accent-11)]" : "text-[var(--neutral-9)]"}`} />, conn ? `${conn.type} • ${conn.host ?? conn.filepath ?? ""}` : undefined);
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {loadingDatabases.size > 0 && needAllLists && (
                    <p className="flex items-center justify-center gap-1.5 py-2 text-[10px] opacity-60">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading database lists…
                    </p>
                  )}
                </div>
              )}
              {sidebarTab === "saved" && (
                <SavedQueryList
                  runLabel="Run on selected databases"
                  emptyHint="Save queries from the main editor (Ctrl+S) to reuse them here."
                  onOpen={(q) => {
                    setQuery(q.query);
                    flashToast(`Loaded query: ${q.name}`);
                  }}
                  onRun={(q) => {
                    setQuery(q.query);
                    void executeQuery(q.query);
                  }}
                />
              )}
            </div>
          </div>
          {/* Main area */}
          <PanelGroup direction="vertical" autoSaveId="multi-query-editor-split" className="flex-1 min-h-0 bg-[var(--surface-base)]">
            <Panel defaultSize={30} minSize={15} maxSize={80}>
            <div className="h-full p-4 flex flex-col gap-3 bg-[var(--surface-elevated)]">
               <div className="flex-1 min-h-0 relative rounded-xl border border-[var(--neutral-6)] overflow-hidden shadow-inner bg-[var(--surface-base)]"><QueryEditor value={query} onChange={setQuery} onRun={executeQuery} /></div>
               <div className="flex gap-2 shrink-0">
                 <Button
                   variant="primary"
                   size="md"
                   className="flex-1"
                   onClick={executeQuery}
                   loading={isExecuting}
                   disabled={selectionPending || !query.trim() || selectedTargets.length === 0}
                   leftIcon={isExecuting ? undefined : <Play className="w-4 h-4 fill-current" />}
                 >
                   {isExecuting ? `Executing SQL on ${selectedTargets.length} Nodes...` : `Execute SQL on ${selectedTargets.length} Nodes`}
                 </Button>
                 <Button
                   variant="secondary"
                   size="md"
                   onClick={() => void saveClusterQuery()}
                   disabled={!query.trim()}
                   leftIcon={<Star className="w-4 h-4" />}
                   title="Save to Saved Queries (Ctrl+S)"
                 >
                   Save
                 </Button>
               </div>
            </div>
            </Panel>
            <PanelResizeHandle className="h-1 bg-[var(--neutral-6)] hover:bg-[var(--accent-9)] transition-colors cursor-row-resize select-none shrink-0 data-[resize-handle-state=drag]:bg-[var(--accent-9)] data-[resize-handle-state=hover]:bg-[var(--accent-9)]/60" />
            <Panel minSize={15}>
            <div className="h-full flex flex-col overflow-hidden">
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
                        {settings.enabledExportFormats.includes("excel") && (
                          <button onClick={() => exportData("excel")} className="p-1.5 hover:text-[var(--accent-11)] opacity-70 hover:opacity-100 transition-opacity" title="Export Excel (.xlsx)"><Sheet className="w-3.5 h-3.5" /></button>
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
            </Panel>
          </PanelGroup>
        </div>
        {error && (<div className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-lg bg-[var(--danger-9)] shadow-2xl text-white px-6 py-4 rounded-2xl text-sm font-bold flex items-center gap-3 animate-in slide-in-from-bottom duration-300 z-[100]"><AlertCircle className="w-5 h-5 shrink-0" /><span className="flex-1 leading-tight">{error}</span><button onClick={() => setError(null)} className="p-1 hover:bg-white/10 rounded-lg"><X className="w-5 h-5" /></button></div>)}
        {showToast && (<div className="absolute bottom-6 right-6 bg-[var(--accent-9)] text-white px-6 py-3 rounded-2xl shadow-2xl text-xs font-bold z-[600] animate-in slide-in-from-right flex items-center gap-2"><CheckCircle className="w-4 h-4" />{toastMessage}</div>)}

        {/* Tooltip for hovered status */}
        {hoveredStatus && (
          <div className="absolute z-[200] bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-xl shadow-xl p-3 min-w-[200px] animate-in fade-in zoom-in-95 duration-200"
               style={{ bottom: 'auto', left: '22rem', top: '50%', transform: 'translateY(-50%)' }}>
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

      {editingTemplateId && (() => {
        const template = templates.find(t => t.id === editingTemplateId);
        if (!template) return null;
        return (
          <NodeTemplateEditorDialog
            key={template.id}
            template={template}
            connections={connections}
            availableDatabases={availableDatabases}
            loadingDatabases={loadingDatabases}
            fetchDatabases={fetchDatabases}
            currentSelection={selectedTargets}
            onSave={(name, targets) => saveTemplateEdit(template.id, name, targets)}
            onDelete={() => void deleteTemplate(template)}
            onClose={() => setEditingTemplateId(null)}
          />
        );
      })()}

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
