import { useRef, useEffect, memo, useCallback, useMemo } from "react";
import "./monacoSetup";
import Editor, { OnMount } from "@monaco-editor/react";
import { defineMonacoThemes, resolveMonacoTheme } from "../../utils/monacoThemes";
import { Code as CodeIcon, Loader2, CheckCircle, XCircle } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { useConnections } from "../../contexts/useConnections";
import { useSettings } from "../../store/settingsStore";
import { useLocalHistory } from "../../store/localHistoryStore";
import { format } from "sql-formatter";
import {
  extractTableRefs,
  pickCompletionSchema,
  qualifiedNameAt,
  quoteIdentifierIfNeeded,
  type CompletionSchemaLike,
} from "./completionContext";
import { provideSqlCompletions } from "./sqlCompletionAdapter";
import { dialectForDbType, type SqlDialect } from "./sqlBuiltins";
import { resolveStatementAtOffset } from "../../utils/statementAtCursor";
import { variableSpans } from "../ui/VariableSubstitutionDialog";
import { splitStatements } from "../../utils/splitStatements";
import { resolveTabHashComments } from "../../utils/sqlDialect";
import {
  clearSignatureHelpCache,
  lookupSignatures,
  registerParameterInlayHints,
  registerSignatureHelp,
  type SignatureConnCtx,
} from "./signatureHelp";

// Global tracking to prevent duplicate provider registration across component mounts
let sqlProviderDisposable: any = null;
let sqlFormatterDisposable: any = null;
let sqlHoverProviderDisposable: any = null;
// Dev hot reload: an old provider would keep reading this module's stale
// state next to the replacement's, so drop them with the old module.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sqlProviderDisposable?.dispose();
    sqlFormatterDisposable?.dispose();
    sqlHoverProviderDisposable?.dispose();
  });
}
/**
 * What the global providers need from one mounted editor. Monaco providers
 * are registered once per language, so each finds its editor's state
 * through the model it is called with. (These used to be module singletons:
 * a second editor — the Multi Query dialog's — overwrote the tab's target,
 * schema and dialect, and completion went dead until the next tab switch.)
 */
interface EditorLanguageState {
  /** Sidebar-active connection's schema. */
  globalItems: CompletionSchemaLike | null;
  globalConnId: string | null;
  /** Background-fetched schema for the tab's own connection + database. */
  tabItems: CompletionSchemaLike | null;
  tabConnId: string | null;
  /** The tab's explicit target (`undefined` = none). */
  targetConnId: string | null | undefined;
  dialect: SqlDialect;
  hashComments: boolean;
  /** Connection signature help / parameter hints query. */
  conn: SignatureConnCtx;
}

const NO_CONN: SignatureConnCtx = { db: null, connectionId: null, dbType: "", database: "" };
const newLanguageState = (): EditorLanguageState => ({
  globalItems: null,
  globalConnId: null,
  tabItems: null,
  tabConnId: null,
  targetConnId: undefined,
  dialect: "postgres",
  hashComments: false,
  conn: NO_CONN,
});
// Read-only SQL viewers (Definition, Compare) have no editor state.
const VIEWER_STATE = newLanguageState();
const languageStateByModel = new WeakMap<object, EditorLanguageState>();
const liveLanguageStates = new Set<EditorLanguageState>();

function languageStateFor(model: object): EditorLanguageState {
  return languageStateByModel.get(model) ?? VIEWER_STATE;
}

function completionSchemaFor(state: EditorLanguageState): CompletionSchemaLike | null {
  return pickCompletionSchema({
    globalItems: state.globalItems,
    globalConnId: state.globalConnId,
    tabItems: state.tabItems,
    tabConnId: state.tabConnId,
    targetConnId: state.targetConnId,
  });
}

/**
 * Drop cached schemas (tens of MB on wide databases) and connection handles
 * when a connection is closed. Mounted editors refill from context.
 */
export function resetEditorSchemaCache(): void {
  for (const state of liveLanguageStates) {
    state.globalItems = null;
    state.globalConnId = null;
    state.tabItems = null;
    state.tabConnId = null;
    state.conn = NO_CONN;
  }
  clearSignatureHelpCache();
}

// Listen for connection-disconnected at module scope so the cache is released
// even when no <QueryEditor> is currently mounted. This module is only loaded
// once the editor is first used, so registering once is sufficient.
if (typeof window !== "undefined") {
  window.addEventListener("connection-disconnected", resetEditorSchemaCache);
}

// Statement execution status for inline indicators
export interface StatementStatus {
  lineNumber: number;
  status: 'running' | 'success' | 'error';
  statementText: string;
}

interface QueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun?: (query?: any, statementInfo?: { lineNumber: number; statementText: string }) => void;
  connectionName?: string;
  databaseName?: string;
  /**
   * Explicit connection/database this tab targets. Completion (and hover)
   * resolve against this connection's schema — background-fetching it when
   * the tab was never sidebar-connected — instead of only the globally
   * active connection. `undefined` = untargeted (global schema applies).
   */
  targetConnectionId?: string;
  targetDatabase?: string;
  isExecuting?: boolean;
  hasError?: boolean;
  hasSuccess?: boolean;
  tabId?: string;
  tabName?: string;
  lastExecutedStatement?: {
    lineNumber: number;
    status: 'running' | 'success' | 'error';
  };
  statementResults?: StatementResult[];
  /**
   * Writeback for glyph line tracking (#223). The editor moves gutter glyphs
   * live as text shifts (sticky Monaco decorations) and prunes glyphs whose
   * block was cut/blanked; it reports the resulting set so tab state stays
   * in sync across tab switches and remounts.
   */
  onStatementResultsChange?: (results: StatementResult[]) => void;
  /**
   * Called with the editor API on mount (`mounted = true`) and again on
   * dispose (`mounted = false`), so the toolbar Run / Explain / Optimizer
   * buttons act on exactly what Ctrl+Enter would run.
   */
  onEditorApi?: (api: QueryEditorApi, mounted: boolean) => void;
  /** Run all statements once after mount (saved query ▶), then call `onRunOnMountDone`. */
  runOnMount?: boolean;
  /**
   * Server-reported error position: `offset` (0-based) into `statementText`,
   * which starts on `statementLine`. Rendered as a squiggle like DataGrip.
   */
  errorMarker?: { statementText: string; statementLine: number; offset: number; message: string } | null;
  onRunOnMountDone?: () => void;
}

/** Read-only handle the host uses to ask the editor what Ctrl+Enter would run. */
export interface QueryEditorApi {
  /** The selection when there is one, else the statement under the caret. */
  getStatementAtCursor: () => { text: string; lineNumber: number } | null;
}

export interface StatementResult {
  lineNumber: number;
  status: 'running' | 'success' | 'error';
  rowsAffected?: number;
  rowCount?: number;
  error?: string | null;
  executionTime?: number;
}

// Show intention actions popup (Alt+Enter)
const showIntentionActions = (editor: any, monaco: any, onRunRef: React.MutableRefObject<any>) => {
  const model = editor.getModel();
  const selection = editor.getSelection();
  const position = editor.getPosition();
  if (!model || !position) return;

  const lineContent = model.getLineContent(position.lineNumber);
  const hasSelection = selection && !selection.isEmpty();
  const selectedText = hasSelection ? model.getValueInRange(selection) : '';

  // Build context-aware actions
  const actions: { label: string; action: () => void; disabled?: boolean }[] = [];

  // Always available
  actions.push({ label: "Format SQL", action: () => editor.getAction('editor.action.formatDocument')?.run() });

  // When text is selected
  if (hasSelection && selectedText.trim()) {
    actions.push({ 
      label: "Execute Selection as Single Statement", 
      action: () => {
        const startPos = selection.getStartPosition();
        onRunRef.current?.(selectedText, { lineNumber: startPos.lineNumber, statementText: selectedText });
      }
    });
  }

  // Add LIMIT clause to SELECT statements
  const upperLine = lineContent.toUpperCase();
  if (upperLine.trim().startsWith('SELECT') && !upperLine.includes('LIMIT')) {
    actions.push({
      label: "Add LIMIT clause",
      action: () => {
        const lastSemi = lineContent.lastIndexOf(';');
        const insertPos = lastSemi === -1 ? lineContent.length : lastSemi;
        editor.executeEdits('add-limit', [{
          range: new monaco.Range(position.lineNumber, insertPos + 1, position.lineNumber, insertPos + 1),
          text: ' LIMIT 100'
        }]);
      }
    });
  }

  // Qualify table names (add schema prefix)
  if (upperLine.includes(' FROM ') || upperLine.includes(' JOIN ')) {
    actions.push({
      label: "Qualify table names with schema",
      action: () => {
        editor.trigger('keyboard', 'type', { text: 'public.' });
      }
    });
  }

  // Build and show popup
  const editorDom = editor.getDomNode();
  if (!editorDom) return;

  const cursorCoords = editor.getScrolledVisiblePosition(position);
  const editorRect = editorDom.getBoundingClientRect();
  const menuX = editorRect.left + cursorCoords.left;
  const menuY = editorRect.top + cursorCoords.top + 30;

  const existing = document.getElementById("intention-actions-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "intention-actions-menu";
  menu.className = "fixed z-[9999] bg-[var(--surface-elevated)] border border-[var(--neutral-6)] rounded-lg shadow-2xl py-1 min-w-[200px]";
  menu.style.left = `${menuX}px`;
  menu.style.top = `${menuY}px`;

  // Add header with lightbulb icon
  const header = document.createElement("div");
  header.className = "px-3 py-1.5 text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-widest border-b border-[var(--neutral-6)] mb-1";
  header.innerHTML = "💡 Intention Actions";
  menu.appendChild(header);

  actions.forEach(item => {
    const btn = document.createElement("button");
    btn.className = `w-full px-3 py-2 text-left text-xs flex items-center gap-2 transition-colors ${
      item.disabled
        ? "text-[var(--neutral-11)] opacity-40 cursor-not-allowed"
        : "hover:bg-[var(--accent-9)] hover:text-white"
    }`;
    btn.innerHTML = `<span>💡</span><span>${item.label}</span>`;
    if (!item.disabled) {
      btn.onclick = () => { item.action(); menu.remove(); };
    }
    menu.appendChild(btn);
  });

  // Close on click outside
  const closeMenu = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      window.removeEventListener("click", closeMenu);
    }
  };
  window.addEventListener("click", closeMenu);

  document.body.appendChild(menu);

  // Keep menu in viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${menuY - rect.height - 10}px`;
  });
};

// Memoize to prevent unnecessary re-renders when parent state changes
export const QueryEditor = memo(function QueryEditor({
  value,
  onChange,
  onRun,
  connectionName,
  databaseName,
  targetConnectionId,
  targetDatabase,
  tabId,
  tabName,
  isExecuting,
  hasError,
  hasSuccess,
  lastExecutedStatement: _lastExecutedStatement,
  statementResults,
  onStatementResultsChange,
  onEditorApi,
  runOnMount,
  onRunOnMountDone,
  errorMarker,
}: QueryEditorProps) {
  const { theme } = useTheme();
  const settings = useSettings();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<any[]>([]);
  const onRunRef = useRef<any>(null);
  const lastSnapshotRef = useRef<string>("");
  const snapshotTimerRef = useRef<any>(null);
  const { schemaItems, currentDb, activeConnection, selectedDatabase, ensureSchemaFor, ensureConnectionDb, connections, vaultCredentials } = useConnections();
  // `#` comment handling follows the TAB's target connection dialect: a tab
  // on PostgreSQL must keep `#>` operators intact even when the sidebar sits
  // on MySQL (and vice versa). Untargeted tabs fall back to the active
  // connection. A ref because handleEditorMount's handlers outlive renders —
  // reading the prop directly would pin the dialect from mount time across
  // connection switches.
  const hashOptsRef = useRef<{ hashComments: boolean }>({ hashComments: false });
  hashOptsRef.current = resolveTabHashComments(targetConnectionId, connections, activeConnection?.type);
  
  onRunRef.current = onRun;

  // Auto-snapshot: debounce editor changes and save to local history
  const saveSnapshot = useCallback((content: string) => {
    if (!content.trim()) return;
    if (content === lastSnapshotRef.current) return;
    lastSnapshotRef.current = content;
    const path = tabName ? `editor/${tabName}` : `editor/untitled-${tabId?.slice(0, 8) || 'new'}`;
    useLocalHistory.getState().addEntry(path, content, `Edited: ${tabName || 'Untitled'}`);
  }, [tabId, tabName]);

  useEffect(() => {
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      saveSnapshot(value);
    }, 5000);
    return () => { if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current); };
  }, [value, saveSnapshot]);

  // This editor's slice of what the global providers read (see
  // EditorLanguageState). Bound to the Monaco model on mount.
  const langStateRef = useRef<EditorLanguageState>(newLanguageState());
  useEffect(() => {
    const state = langStateRef.current;
    liveLanguageStates.add(state);
    return () => {
      liveLanguageStates.delete(state);
    };
  }, []);

  useEffect(() => {
    langStateRef.current.globalItems = schemaItems;
    langStateRef.current.globalConnId = activeConnection?.id ?? null;
  }, [schemaItems, activeConnection?.id]);

  // Whether the tab runs somewhere other than the sidebar's connection and
  // database — then completion, hover and parameter hints use its own.
  const targetsElsewhere =
    !!targetConnectionId &&
    (activeConnection?.id !== targetConnectionId || (!!targetDatabase && targetDatabase !== selectedDatabase));
  const mayConnect = settings.autoReconnect !== false;

  // Tab-targeted schema: background-fetch the schema of the tab's own
  // connection + database (fresh tabs inheriting the previous connection,
  // restored sessions, multi-connection work) without a sidebar click. The
  // explorer tree is never touched; suggestions appear once the fetch
  // resolves. The fetch connects, so it honors "Reconnect previous
  // connection on startup". `vaultCredentials` in deps retries after a
  // vault-profile pick (background fetches can't prompt).
  useEffect(() => {
    const state = langStateRef.current;
    state.targetConnId = targetConnectionId ?? undefined;
    if (!targetConnectionId || !mayConnect || (!targetsElsewhere && schemaItems)) {
      state.tabItems = null;
      state.tabConnId = null;
      return;
    }
    let cancelled = false;
    if (state.tabConnId !== targetConnectionId) state.tabItems = null;
    state.tabConnId = targetConnectionId;
    // Always resolve through the context cache (hit = same ref, no work):
    // a disconnect may have evicted it since the last run.
    ensureSchemaFor(targetConnectionId, targetDatabase)
      .then((items) => {
        if (!cancelled) state.tabItems = items;
      })
      .catch(() => {
        if (!cancelled) state.tabItems = null;
      });
    return () => {
      cancelled = true;
    };
    // ensureSchemaFor identity changes per render (plain context closure);
    // depend on the stable inputs instead — cache hits make refires cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetConnectionId, targetDatabase, targetsElsewhere, schemaItems, connections, vaultCredentials, mayConnect]);

  // Completion dialect follows the TAB's connection (else the active one).
  const completionDbType = connections.find((c) => c.id === targetConnectionId)?.type ?? activeConnection?.type;
  useEffect(() => {
    const dialect = dialectForDbType(completionDbType);
    langStateRef.current.dialect = dialect;
    langStateRef.current.hashComments = dialect === "mysql";
  }, [completionDbType]);

  // Connection for signature help / parameter hints: the tab's own when it
  // targets elsewhere (lazily connected, cached by the context), otherwise
  // the sidebar's live handle.
  useEffect(() => {
    const state = langStateRef.current;
    if (!targetsElsewhere) {
      state.conn = {
        db: currentDb || null,
        connectionId: activeConnection?.id || null,
        dbType: activeConnection?.type || "",
        database: selectedDatabase || activeConnection?.database || "",
      };
      return;
    }
    state.conn = NO_CONN;
    if (!mayConnect || !targetConnectionId) return;
    let cancelled = false;
    ensureConnectionDb(targetConnectionId, targetDatabase)
      .then((ensured) => {
        if (cancelled) return;
        state.conn = {
          db: ensured.db,
          connectionId: targetConnectionId,
          dbType: ensured.connection.type,
          database: targetDatabase || ensured.connection.database || "",
        };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsElsewhere, targetConnectionId, targetDatabase, currentDb, activeConnection, selectedDatabase, mayConnect, vaultCredentials]);

  // Error squiggle at the server-reported position. The statement's first
  // line is located in the document (it may start mid-line after a previous
  // statement), then the offset is walked from there.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    if (!errorMarker) {
      monaco.editor.setModelMarkers(model, "queryden-run", []);
      return;
    }
    try {
      const { statementText, statementLine, offset, message } = errorMarker;
      const lineText = model.getLineContent(statementLine);
      const head = statementText.split("\n")[0].trim().slice(0, 60);
      const startColumn = Math.max(0, lineText.indexOf(head)) + 1;
      const start = model.getOffsetAt({ lineNumber: statementLine, column: startColumn }) + Math.min(offset, statementText.length);
      const pos = model.getPositionAt(start);
      const word = model.getWordAtPosition(pos);
      monaco.editor.setModelMarkers(model, "queryden-run", [{
        severity: monaco.MarkerSeverity.Error,
        message,
        startLineNumber: pos.lineNumber,
        startColumn: word?.startColumn ?? pos.column,
        endLineNumber: pos.lineNumber,
        endColumn: word?.endColumn ?? pos.column + 1,
      }]);
    } catch {
      monaco.editor.setModelMarkers(model, "queryden-run", []);
    }
  }, [errorMarker]);

  // Create a stable fingerprint of statementResults so the effect fires reliably
  // even when React batches state updates and the array reference doesn't change.
  const statementResultsFingerprint = useMemo(() => {
    if (!statementResults || statementResults.length === 0) return '';
    return statementResults.map(r => `${r.lineNumber}:${r.status}:${r.executionTime || 0}`).join(',');
  }, [statementResults]);

  // Live mirror for the throttled prune listener registered at mount (it
  // outlives renders, so it must not close over stale props).
  const onGlyphChangeRef = useRef(onStatementResultsChange);
  onGlyphChangeRef.current = onStatementResultsChange;
  const onEditorApiRef = useRef(onEditorApi);
  onEditorApiRef.current = onEditorApi;
  const runOnMountRef = useRef(runOnMount);
  runOnMountRef.current = runOnMount;
  const onRunOnMountDoneRef = useRef(onRunOnMountDone);
  onRunOnMountDoneRef.current = onRunOnMountDone;

  // Gutter glyph bookkeeping (#223): decoration id -> { line, status, result }.
  // Decorations are sticky (NeverGrowsWhenTypingAtEdges), so survivors ride
  // along as text shifts without being re-pinned. The result snapshot is
  // stored per decoration so the throttled prune never reads stale props
  // (two prunes can fire before the parent re-renders with written-back
  // lines — looking the result up by line in current props would miss and
  // wrongly drop the glyph).
  const glyphMetaRef = useRef(new Map<string, { lineNumber: number; status: string; result: StatementResult }>());

  const glyphClassFor = (result: StatementResult): { cls: string; hover: string; tooltip: string } => {
    const { status, rowCount, rowsAffected, error, executionTime } = result;
    if (status === 'success') {
      let tooltip = '';
      if (rowCount !== undefined) {
        tooltip = `${rowCount} row${rowCount !== 1 ? 's' : ''} retrieved`;
      } else if (rowsAffected !== undefined) {
        tooltip = `${rowsAffected} row${rowsAffected !== 1 ? 's' : ''} affected`;
      }
      if (executionTime !== undefined && executionTime > 0) {
        tooltip += tooltip ? ` in ${executionTime}ms` : `${executionTime}ms`;
      }
      return { cls: 'statement-glyph-success', hover: 'Query succeeded', tooltip };
    }
    if (status === 'error') {
      return { cls: 'statement-glyph-error', hover: 'Query failed', tooltip: error || 'Error executing query' };
    }
    return { cls: 'statement-glyph-running', hover: 'Query running...', tooltip: '' };
  };

  // Reconcile Monaco gutter glyphs with statementResults (DataGrip-style).
  // Only creates new / removes gone glyphs — survivors keep their live,
  // Monaco-tracked decorations, so marks follow in-place edits instead of
  // snapping back to frozen lines.
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;

    const editor = editorRef.current;
    const monaco = monacoRef.current;

    const clearAllGlyphs = () => {
      const ids = [...glyphMetaRef.current.keys()];
      if (ids.length > 0) {
        editor.deltaDecorations(ids, []);
        glyphMetaRef.current.clear();
      }
      decorationsRef.current = [];
    };

    // During execution, show no glyph — wait for results
    if (isExecuting) {
      clearAllGlyphs();
      return;
    }

    // Only create gutter glyphs when statementResults has data (after execution completes)
    if (!statementResults || statementResults.length === 0) {
      clearAllGlyphs();
      return;
    }

    const desired = new Map<number, StatementResult>();
    for (const r of statementResults) desired.set(r.lineNumber, r);

    const removals: string[] = [];
    for (const [id, meta] of glyphMetaRef.current) {
      const want = desired.get(meta.lineNumber);
      // Remove glyphs whose block is gone or whose status changed (re-added below).
      if (!want || want.status !== meta.status) removals.push(id);
    }

    const additions: any[] = [];
    const additionLines: number[] = [];
    // TrackedRangeStickiness lives under monaco.editor.* (NOT top-level
    // monaco.* — that path is undefined and crashed the app on mount).
    // Resolve defensively: numeric 1 === NeverGrowsWhenTypingAtEdges and is
    // stable across monaco versions, so decorations still work even if the
    // enum moves again instead of throwing.
    const stickiness: number =
      (monaco.editor?.TrackedRangeStickiness as any)?.NeverGrowsWhenTypingAtEdges ??
      (monaco as any)?.TrackedRangeStickiness?.NeverGrowsWhenTypingAtEdges ??
      1;
    for (const [line, result] of desired) {
      let alive = false;
      for (const [id, meta] of glyphMetaRef.current) {
        if (removals.includes(id)) continue;
        if (meta.lineNumber === line && meta.status === result.status) { alive = true; break; }
      }
      if (alive) continue;
      const { cls, hover, tooltip } = glyphClassFor(result);
      additions.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: cls,
          glyphMarginHoverMessage: { value: tooltip || hover },
          stickiness,
        }
      });
      additionLines.push(line);
    }

    if (removals.length > 0 || additions.length > 0) {
      const newIds: string[] = additions.length > 0 ? editor.deltaDecorations(removals, additions) : editor.deltaDecorations(removals, []);
      for (const id of removals) glyphMetaRef.current.delete(id);
      newIds.forEach((id, idx) => {
        const line = additionLines[idx];
        const result = desired.get(line);
        if (result) glyphMetaRef.current.set(id, { lineNumber: line, status: result.status, result });
      });
      decorationsRef.current = [...glyphMetaRef.current.keys()];
    }

    // Scroll the last statement into view if there are errors
    const hasErrors = statementResults.some(r => r.status === 'error');
    if (hasErrors) {
      const lastError = [...statementResults].reverse().find(r => r.status === 'error');
      if (lastError) {
        editor.revealLineInCenter(lastError.lineNumber);
      }
    }

  }, [statementResultsFingerprint, isExecuting]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco;
    editorRef.current = editor;
    const bindLanguageState = () => {
      const model = editor.getModel();
      if (model) languageStateByModel.set(model, langStateRef.current);
    };
    bindLanguageState();
    const modelChangeDisposable = editor.onDidChangeModel(bindLanguageState);
    
    // Focus after a short delay to ensure UI is ready
    setTimeout(() => editor.focus(), 100);

    const focusHandler = () => editor.focus();
    const formatHandler = () => editor.getAction('editor.action.formatDocument')?.run();
    
    window.addEventListener("focus-editor", focusHandler);
    window.addEventListener("format-sql", formatHandler);

    // ─── Query Variable Highlighting ───────────────────────────────────────────
    // Highlight :varname patterns in the SQL editor with purple styling
    const varDecorationClass = "query-var";
    const varDecorationCollection = editor.createDecorationsCollection([]);

    const updateVarDecorations = () => {
      const model = editor.getModel();
      if (!model) return;

      // Same matcher the substitution dialog uses: `::casts`, slices,
      // strings, comments and dollar bodies are not variables.
      const decorations = variableSpans(model.getValue()).map(({ start, end }) => {
        const startPos = model.getPositionAt(start);
        const endPos = model.getPositionAt(end);
        return {
          range: new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
          options: { inlineClassName: varDecorationClass },
        };
      });

      varDecorationCollection.set(decorations);

    };

    // Throttle: run at most every 150ms so keystrokes on large files stay responsive
    let varDecoThrottle: ReturnType<typeof setTimeout> | null = null;
    const throttledVarDecorations = () => {
      if (varDecoThrottle !== null) return;
      varDecoThrottle = setTimeout(() => {
        varDecoThrottle = null;
        updateVarDecorations();
      }, 150);
    };

    updateVarDecorations();
    const contentChangeDisposable = editor.onDidChangeModelContent(() => throttledVarDecorations());

    // ─── Run-status glyph pruning (#223) ───────────────────────────────────────
    // Sticky decorations follow the text automatically, but nothing removes a
    // glyph whose block was cut away. On content change (throttled), read each
    // glyph's live position: drop glyphs whose decoration is gone or whose
    // anchor line is now blank (block cut/pasted away), and write back fresh
    // line numbers for survivors so tab state survives switches/remounts.
    let glyphPruneTimer: ReturnType<typeof setTimeout> | null = null;
    const pruneGlyphs = () => {
      const model = editor.getModel();
      if (!model || glyphMetaRef.current.size === 0) return;

      let changed = false;
      const next: StatementResult[] = [];
      const deadIds: string[] = [];
      for (const [id, meta] of glyphMetaRef.current) {
        let range: any = null;
        try {
          range = model.getDecorationRange(id);
        } catch {
          range = null;
        }
        if (!range) {
          deadIds.push(id);
          changed = true;
          continue;
        }
        const liveLine = range.startLineNumber;
        let lineText = "";
        try {
          lineText = model.getLineContent(liveLine);
        } catch {
          lineText = "";
        }
        if (lineText.trim().length === 0) {
          // Anchor line blanked — the block was cut or deleted.
          deadIds.push(id);
          changed = true;
          continue;
        }
        if (liveLine !== meta.lineNumber) {
          meta.lineNumber = liveLine;
          meta.result = { ...meta.result, lineNumber: liveLine };
          changed = true;
        }
        next.push(meta.result);
      }
      if (deadIds.length > 0) {
        try {
          editor.deltaDecorations(deadIds, []);
        } catch {
          /* editor tearing down */
        }
        for (const id of deadIds) glyphMetaRef.current.delete(id);
        decorationsRef.current = [...glyphMetaRef.current.keys()];
      }
      if (changed) {
        next.sort((a, b) => a.lineNumber - b.lineNumber);
        try {
          onGlyphChangeRef.current?.(next);
        } catch {
          /* parent unmounted */
        }
      }
    };
    const throttledPruneGlyphs = () => {
      if (glyphPruneTimer) clearTimeout(glyphPruneTimer);
      glyphPruneTimer = setTimeout(pruneGlyphs, 500);
    };
    const glyphPruneDisposable = editor.onDidChangeModelContent(() => throttledPruneGlyphs());

    // ─── "Will run" statement highlight ────────────────────────────────────────
    // DataGrip-style affordance: persistently highlight the statement the caret
    // sits in, so the user can see which block Ctrl+Enter (run-at-cursor) will
    // execute. Uses resolveStatementAtOffset — the same resolver run-at-cursor
    // uses — so the highlight always matches what actually runs.
    const cursorStmtCollection = editor.createDecorationsCollection([]);

    const updateCursorStatementHighlight = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) {
        cursorStmtCollection.set([]);
        return;
      }

      // When there's a real selection, that selection is what runs — Monaco's
      // own selection highlight is the affordance, so don't double-paint.
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) {
        cursorStmtCollection.set([]);
        return;
      }

      const text = model.getValue();
      const target = resolveStatementAtOffset(text, model.getOffsetAt(position), hashOptsRef.current);
      // Don't bother highlighting when the whole buffer is a single statement —
      // there's nothing to disambiguate and a full-editor band is just noise.
      if (!target || text.trim() === target.text) {
        cursorStmtCollection.set([]);
        return;
      }

      const startPos = model.getPositionAt(target.start);
      const endPos = model.getPositionAt(target.start + target.text.length);
      cursorStmtCollection.set([
        {
          range: new monaco.Range(startPos.lineNumber, 1, endPos.lineNumber, model.getLineMaxColumn(endPos.lineNumber)),
          options: {
            isWholeLine: true,
            className: "cursor-statement-highlight",
            linesDecorationsClassName: "cursor-statement-bar",
          },
        },
      ]);
    };

    updateCursorStatementHighlight();
    const cursorMoveDisposable = editor.onDidChangeCursorPosition(() => updateCursorStatementHighlight());
    const cursorContentDisposable = editor.onDidChangeModelContent(() => updateCursorStatementHighlight());

    // Custom context menu handler (defined as named function for cleanup)
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const position = editor.getPosition();
      let hasSelection = !editor.getSelection()?.isEmpty();

      // Remove any existing custom menu
      const existing = document.getElementById("monaco-editor-context-menu");
      if (existing) existing.remove();

      // Position menu near cursor
      const cursorCoords = editor.getScrolledVisiblePosition(position || { lineNumber: 1, column: 1 });
      const editorDom = editor.getDomNode();
      let menuX = e.clientX;
      let menuY = e.clientY;

      if (cursorCoords && editorDom) {
        const editorRect = editorDom.getBoundingClientRect();
        menuX = editorRect.left + cursorCoords.left;
        menuY = editorRect.top + cursorCoords.top + 20;
      }

      const menu = document.createElement("div");
      menu.id = "monaco-editor-context-menu";
      menu.className = "fixed z-[9999] bg-[var(--surface-elevated)] border border-[var(--neutral-6)] rounded-lg shadow-2xl py-1 min-w-[160px]";
      menu.style.left = `${menuX}px`;
      menu.style.top = `${menuY}px`;

      const items: { label: string; action: () => void; disabled?: boolean; separator?: boolean }[] = [
        { label: "Undo", action: () => { editor.focus(); editor.trigger("contextmenu", "undo", undefined); } },
        { label: "Redo", action: () => { editor.focus(); editor.trigger("contextmenu", "redo", undefined); } },
        { separator: true, label: "", action: () => {} },
        { label: "Cut", action: () => { editor.focus(); editor.trigger("contextmenu", "editor.action.clipboardCutAction", undefined); }, disabled: !hasSelection },
        { label: "Copy", action: () => { editor.focus(); editor.trigger("contextmenu", "editor.action.clipboardCopyAction", undefined); }, disabled: !hasSelection },
        { label: "Paste", action: async () => { editor.focus(); try { const text = await navigator.clipboard.readText(); if (text) editor.trigger("contextmenu", "type", { text }); } catch { /* clipboard permission denied */ } }, disabled: false },
        { separator: true, label: "", action: () => {} },
        { label: "Select All", action: () => { editor.focus(); editor.trigger("contextmenu", "editor.action.selectAll", undefined); } },
        { separator: true, label: "", action: () => {} },
        { label: "Format SQL", action: () => { editor.focus(); editor.trigger("contextmenu", "editor.action.formatDocument", undefined); } },
        { label: "Execute Selection as Single Statement", action: () => { if (hasSelection) { const selection = editor.getSelection(); const model = editor.getModel(); if (selection && model) { const selectedText = model.getValueInRange(selection); const startPos = selection.getStartPosition(); onRunRef.current?.(selectedText, { lineNumber: startPos.lineNumber, statementText: selectedText }); } } }, disabled: !hasSelection },
        { separator: true, label: "", action: () => {} },
        { label: "AI Actions...", action: () => { window.dispatchEvent(new CustomEvent("open-ai-assistant")); } },
        { separator: true, label: "", action: () => {} },
        { label: "Local History | Show History", action: () => { window.dispatchEvent(new CustomEvent("show-local-history")); } },
      ];

      items.forEach(item => {
        if (item.separator) {
          const hr = document.createElement("div");
          hr.className = "my-1 border-t border-[var(--neutral-6)]";
          menu.appendChild(hr);
          return;
        }
        const btn = document.createElement("button");
        btn.className = `w-full px-3 py-1.5 text-left text-[11px] flex items-center gap-2 transition-colors ${
          item.disabled
            ? "text-[var(--neutral-11)] opacity-40 cursor-not-allowed"
            : "hover:bg-[var(--accent-9)] hover:text-white"
        }`;
        btn.innerText = item.label;
        if (!item.disabled) {
          btn.onclick = () => { item.action(); menu.remove(); };
        }
        menu.appendChild(btn);
      });

      // Close menu on click outside
      const closeMenu = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node)) {
          menu.remove();
          window.removeEventListener("click", closeMenu);
        }
      };
      window.addEventListener("click", closeMenu);

      document.body.appendChild(menu);

      // Keep menu in viewport
      requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
        if (rect.bottom > window.innerHeight) menu.style.top = `${menuY - rect.height - 10}px`;
      });
    };

    const domNode = editor.getDomNode();
    if (domNode) {
      domNode.addEventListener("contextmenu", handleContextMenu);
    }

    const handleRunSmart = () => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!model) return;
      
      if (selection && !selection.isEmpty()) {
        const selectedText = model.getValueInRange(selection);
        // Get the line number of the selection start
        const startPos = selection.getStartPosition();
        onRunRef.current?.(selectedText, { lineNumber: startPos.lineNumber, statementText: selectedText });
        return;
      }

      const text = model.getValue();
      const position = editor.getPosition();
      if (!text || !position) {
         onRunRef.current?.();
         return;
      }

      const offset = model.getOffsetAt(position);

      // Resolve the target statement with the shared helper so the block we
      // paint under the cursor (updateCursorStatementHighlight, below) is the
      // exact same statement we execute here — the highlight can never lie
      // about what Ctrl+Enter will run.
      const targetStatement = resolveStatementAtOffset(text, offset, hashOptsRef.current);

      if (targetStatement) {
        const startPos = model.getPositionAt(targetStatement.start);
        const endPos = model.getPositionAt(targetStatement.start + targetStatement.text.length);
        
        // Highlight what we are running
        editor.setSelection(new monaco.Selection(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column));
        
        // Pass statement info to parent for inline indicator
        onRunRef.current?.(targetStatement.text, { lineNumber: targetStatement.lineNumber, statementText: targetStatement.text });
      } else {
        // Fallback: run all text as single query - use line 1
        onRunRef.current?.(text.trim(), { lineNumber: 1, statementText: text.trim() });
      }
    };

    const handleRunAll = () => {
      const model = editor.getModel();
      if (!model) return;
      
      const rawText = model.getValue();
      const text = rawText.trim();
      if (!text) {
        onRunRef.current?.();
        return;
      }
      
      // Collect all statements with their line numbers
      // Use the untrimmed text so splitStatements' line number computation
      // matches Monaco's 1-based line numbering (trim loses leading blanks).
      const parsed = splitStatements(rawText, hashOptsRef.current);
      const allStatements = parsed.map(s => ({ text: s.text, lineNumber: s.lineNumber }));
      
      // Run all statements - pass special flag to executeQuery
      if (allStatements.length > 0) {
        onRunRef.current?.({ 
          __runAll: true, 
          statements: allStatements.map(s => s.text),
          statementInfos: allStatements
        });
      } else {
        onRunRef.current?.(text, { lineNumber: 1, statementText: text });
      }
    };

    // Editor shortcuts. NOT `editor.addCommand`: Monaco registers those as
    // global keybindings that are never removed, and the most recently
    // mounted editor wins — after the Multi Query dialog (or any second
    // editor) closed, Ctrl+Enter fired into the disposed editor and did
    // nothing. Actions are disposed with their editor, and the per-editor
    // context key scopes each keybinding to the editor that has focus.
    const editorScopeKey = `queryden.editor.${crypto.randomUUID().replace(/-/g, "")}`;
    editor.createContextKey(editorScopeKey, true);
    const shortcutActions = [
      editor.addAction({
        id: "queryden.runStatement",
        label: "Run Statement at Cursor",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        keybindingContext: editorScopeKey,
        run: () => handleRunSmart(),
      }),
      editor.addAction({
        id: "queryden.runAll",
        label: "Run All Statements",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
        keybindingContext: editorScopeKey,
        run: () => handleRunAll(),
      }),
      editor.addAction({
        id: "queryden.intentions",
        label: "Show Intention Actions",
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Enter],
        keybindingContext: editorScopeKey,
        run: () => showIntentionActions(editor, monaco, onRunRef),
      }),
    ];

    window.addEventListener("run-query-smart", handleRunSmart);
    window.addEventListener("run-query-all", handleRunAll);

    const editorApi: QueryEditorApi = {
      getStatementAtCursor: () => {
        const model = editor.getModel();
        if (!model) return null;
        const selection = editor.getSelection();
        if (selection && !selection.isEmpty()) {
          const text = model.getValueInRange(selection).trim();
          return text ? { text, lineNumber: selection.startLineNumber } : null;
        }
        const position = editor.getPosition();
        const target = resolveStatementAtOffset(
          model.getValue(),
          position ? model.getOffsetAt(position) : 0,
          hashOptsRef.current,
        );
        return target ? { text: target.text, lineNumber: target.lineNumber } : null;
      },
    };
    onEditorApiRef.current?.(editorApi, true);

    if (runOnMountRef.current) {
      // Let the host finish wiring this tab before the run starts.
      setTimeout(() => {
        onRunOnMountDoneRef.current?.();
        handleRunAll();
      }, 0);
    }
    
    editor.onDidDispose(() => {
      onEditorApiRef.current?.(editorApi, false);
      shortcutActions.forEach((a) => a.dispose());
      modelChangeDisposable.dispose();
      contentChangeDisposable?.dispose();
      cursorMoveDisposable?.dispose();
      cursorContentDisposable?.dispose();
      glyphPruneDisposable?.dispose();
      window.removeEventListener("focus-editor", focusHandler);
      window.removeEventListener("format-sql", formatHandler);
      window.removeEventListener("run-query-smart", handleRunSmart);
      window.removeEventListener("run-query-all", handleRunAll);
      if (domNode) domNode.removeEventListener("contextmenu", handleContextMenu);
      if (varDecoThrottle !== null) clearTimeout(varDecoThrottle);
      if (glyphPruneTimer !== null) clearTimeout(glyphPruneTimer);
    });

    // NOTE: Ctrl+Shift+F is intentionally NOT bound to formatDocument here.
    // Ctrl+Shift+L is the canonical formatter shortcut (see #34 / globalShortcuts.ts);
    // Ctrl+Shift+F is owned by the app-level global search in AppLayout.tsx (#12).
    // Binding it here would swallow the keystroke before global search could see it.


    if (!sqlFormatterDisposable) {
      sqlFormatterDisposable = monaco.languages.registerDocumentFormattingEditProvider('sql', {
        provideDocumentFormattingEdits: (model: any) => {
          return [{
            range: model.getFullModelRange(),
            text: format(model.getValue(), { language: 'postgresql' })
          }];
        }
      });
    }

    if (!sqlHoverProviderDisposable) {
      sqlHoverProviderDisposable = monaco.languages.registerHoverProvider('sql', {
        provideHover: async (model: any, position: any) => {
          const lineText: string = model.getLineContent(position.lineNumber);
          const target = qualifiedNameAt(lineText, position.column - 1);
          if (!target) return null;
          const state = languageStateFor(model);
          const schema = completionSchemaFor(state);
          const dialect = state.dialect;

          // Function call → its signatures and description (live catalog or builtins).
          if (target.isCall) {
            const parts = target.name.split(".").map((p) => p.replace(/^"|"$/g, "")).map((p) => (/^[A-Z_]/.test(p) && dialect === "postgres" ? p.toLowerCase() : p));
            const sigs = await lookupSignatures(state.conn, parts);
            if (sigs.length === 0) return null;
            return {
              contents: sigs.slice(0, 6).flatMap((sig) => [
                { value: "```sql\n" + sig.label + "\n```" },
                ...(sig.documentation ? [{ value: sig.documentation }] : []),
              ]),
            };
          }
          if (!schema) return null;

          // Table / view → its columns with types.
          const lowerName = target.name.replace(/"/g, "").toLowerCase();
          const tableName = [...(schema.tables ?? []), ...(schema.views ?? [])].find(
            (t) => t.toLowerCase() === lowerName || t.toLowerCase().endsWith(`.${lowerName}`) || `public.${t.toLowerCase()}` === lowerName,
          );
          if (tableName) {
            const isView = schema.views?.includes(tableName);
            const cols = (schema.columns ?? []).filter((c) => c.table_name === tableName);
            const body = cols.map((c) => `  ${quoteIdentifierIfNeeded(c.column_name, dialect)} ${c.data_type ?? ""}`.trimEnd()).join(",\n");
            return {
              contents: [{ value: "```sql\n" + `${isView ? "VIEW" : "TABLE"} ${tableName} (\n${body}\n)` + "\n```" }],
            };
          }

          // Column (bare or alias.column) → its type and table.
          const word = model.getWordAtPosition(position)?.word;
          if (!word) return null;
          const stmtText = model.getValue();
          const refs = extractTableRefs(stmtText);
          const qualifier = target.name.includes(".") ? target.name.split(".").slice(-2)[0].replace(/"/g, "").toLowerCase() : null;
          const inScope = refs.filter((r) => !qualifier || r.alias?.toLowerCase() === qualifier || r.table.toLowerCase().split(".").pop() === qualifier);
          const matches = (schema.columns ?? []).filter(
            (c) =>
              c.column_name === word &&
              inScope.some((r) => c.table_name.toLowerCase() === r.table.toLowerCase().replace(/^public\./, "") || c.table_name.toLowerCase() === r.table.toLowerCase()),
          );
          if (matches.length === 0) return null;
          return {
            contents: matches.slice(0, 4).map((c) => ({ value: `\`${c.column_name}\` ${c.data_type ? `**${c.data_type}**` : ""} — ${c.table_name}` })),
          };
        }
      });
    }

    // DataGrip-style parameter hints: `my_func(` shows `my_func(a int, b text)`
    // with the active argument highlighted. Registered once globally; the
    // provider reads the calling editor's connection (EditorLanguageState).
    // Isolated from the completion provider below: a signature-help failure
    // must never prevent table/column/keyword suggestions from registering.
    try {
      registerSignatureHelp(monaco, (model) => languageStateFor(model).conn);
      // Inline `p_name:` labels on calls to routines with named parameters.
      registerParameterInlayHints(monaco, (model) => languageStateFor(model).conn);
    } catch (e) {
      console.error("Signature-help provider registration failed (completion unaffected):", e);
    }

    // Ctrl/Cmd+click: open the definition of the table, view or function
    // under the cursor (DataGrip's "Go to declaration").
    editor.onMouseDown((e) => {
      if ((e.event.ctrlKey || e.event.metaKey) && e.target.position) {
        const pos = e.target.position;
        const line = editor.getModel()?.getLineContent(pos.lineNumber) || "";
        const target = qualifiedNameAt(line, pos.column - 1);
        if (target) {
          window.dispatchEvent(new CustomEvent("open-definition", {
            detail: { name: target.name, kind: target.isCall ? "function" : "auto" },
          }));
        }
      }
    });

    // One global completion provider (Monaco providers are per language, not
    // per editor); it reads the mounted tab's schema/dialect from module state.
    // The logic lives in completionProvider.ts.
    if (!sqlProviderDisposable) {
      sqlProviderDisposable = monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: [".", " ", ":", "("],
        provideCompletionItems: (model: any, position: any) => {
          if (!model || !position) return { suggestions: [] };
          const K = monaco.languages.CompletionItemKind;
          const state = languageStateFor(model);
          return provideSqlCompletions(
            model,
            position,
            { schema: completionSchemaFor(state), dialect: state.dialect, hashComments: state.hashComments },
            {
              kinds: {
                keyword: K.Keyword, function: K.Function, column: K.Field, table: K.Class,
                view: K.Interface, schema: K.Module, type: K.TypeParameter, snippet: K.Snippet,
              },
              insertAsSnippet: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            },
          );
        },
      });
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-[var(--surface-elevated)]">
      <div className="h-7 flex items-center justify-between px-3 bg-[var(--surface-elevated)] border-b border-[var(--neutral-6)] shrink-0">
        <div className="flex items-center gap-3">
          {/* Status Indicator - Left side of query area (DataGrip style) */}
          <div className="flex items-center gap-2 shrink-0">
            {isExecuting ? (
              <Loader2 className="w-4 h-4 animate-spin text-[var(--warning-11)]" />
            ) : hasError ? (
              <XCircle className="w-4 h-4 text-[var(--danger-11)]" />
            ) : hasSuccess ? (
              <CheckCircle className="w-4 h-4 text-[var(--success-11)]" />
            ) : (
              <CodeIcon className="w-3 h-3 text-[var(--accent-9)]" />
            )}
          </div>
          
          {/* Connection name in brackets + query preview */}
          <div className="flex items-center gap-2">
            {connectionName && (
              <span className="text-xs font-bold text-[var(--accent-9)] opacity-90">
                [{connectionName}]
              </span>
            )}
            <span className="text-xs font-medium text-[var(--neutral-12)]">SQL Editor</span>
            {databaseName && (
              <span className="text-[9px] text-[var(--neutral-11)] opacity-60">
                / {databaseName}
              </span>
            )}
          </div>
          
          {/* Keyboard shortcuts hint */}
          <span className="text-[9px] text-[var(--neutral-11)] opacity-50 ml-2 hidden sm:inline">Ctrl+Enter: run at cursor • Ctrl+Shift+Enter: run all • Ctrl+Shift+L: format</span>
        </div>
        <div className="flex items-center gap-2">
           <button 
             onClick={() => editorRef.current?.getAction('editor.action.formatDocument')?.run()}
             className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--neutral-6)] hover:bg-[var(--neutral-6)] transition-colors opacity-70 hover:opacity-100"
           >
             Format SQL
           </button>
        </div>
      </div>
      
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language="sql"
          theme={resolveMonacoTheme(theme)}
          value={value}
          onChange={(value) => onChange(value || "")}
          beforeMount={defineMonacoThemes}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: settings.editorMinimap },
            fontSize: settings.editorFontSize,
            fontFamily: settings.editorFontFamily || "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            fontLigatures: true,
            lineNumbers: settings.editorLineNumbers ? "on" : "off",
            renderLineHighlight: "line",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: settings.editorTabSize || 2,
            padding: { top: 8, bottom: 8 },
            scrollbar: {
              vertical: "auto",
              horizontal: "auto",
              useShadows: false,
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
            glyphMargin: true,
            folding: true,
            lineDecorationsWidth: 30,
            lineNumbersMinChars: 3,
            cursorBlinking: "solid",
            cursorStyle: "line",
            wordWrap: settings.editorWordWrap ? "on" : "off",
            quickSuggestions: {
              other: true,
              comments: false,
              strings: false
            },
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: "smart",
            tabCompletion: "on",
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: false,
            renderWhitespace: "none",
            bracketPairColorization: { enabled: true },
            formatOnType: false,  // Disabled: causes typing lag
            formatOnPaste: false, // Disabled: causes lag on paste
            unicodeHighlight: { ambiguousCharacters: false },
            fixedOverflowWidgets: true,
            // Tables / schemas / aliases are coloured by the semantic token
            // provider registered in sqlLanguage.ts.
            "semanticHighlighting.enabled": true,
            contextmenu: false,
            suggest: {
              showKeywords: true,
              showClasses: true,
              showMethods: true,
            },
          }}
        />
      </div>
    </div>
  );
});