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
  detectSchemaDotContext,
  detectAliasDotContext,
  matchesQualifiedOrBareName,
  matchesStaticLabel,
  pickCompletionSchema,
  generateTableAlias,
  extractExistingAliases,
  type CompletionSchemaLike,
} from "./completionContext";
import { resolveStatementAtOffset } from "../../utils/statementAtCursor";
import { splitStatements } from "../../utils/splitStatements";
import { isMySqlLike } from "../../utils/sqlDialect";
import {
  clearSignatureHelpCache,
  registerSignatureHelp,
  type SignatureConnCtx,
} from "./signatureHelp";

// Global tracking to prevent duplicate provider registration across component mounts
let sqlProviderDisposable: any = null;
let sqlFormatterDisposable: any = null;
let sqlHoverProviderDisposable: any = null;
let globalSchemaItems: any = null;
// Connection id that owns `globalSchemaItems` (null when disconnected).
let globalSchemaConnId: string | null = null;
// Background-fetched schema for the active tab's own target connection (see
// `ensureSchemaFor`). Lets tabs complete against their own connection when it
// was never sidebar-connected. Only one editor is mounted at a time (the
// active tab, keyed by tab id), so a module singleton is safe here.
let tabSchemaItems: CompletionSchemaLike | null = null;
let tabSchemaConnId: string | null = null;
// Explicit target of the mounted editor tab (`undefined` = no target).
let tabTargetConnId: string | null | undefined = undefined;
let cachedSuggestions: any[] = [];
let lastSchemaHash: string = "";
// Which schema source the cache was built from — a new source forces a
// rebuild even if the array lengths + timestamp hash happens to collide.
let lastSchemaSourceKey: string = "";
// Latest live-connection snapshot for the signature-help provider (which is
// registered once globally and therefore can't close over component state).
let globalConnCtx: SignatureConnCtx = { db: null, connectionId: null, dbType: "", database: "" };

/**
 * Drop the module-level schema cache. Call when disconnecting from a database
 * so the previous connection's schema (which can be tens of MB on wide DBs)
 * is no longer pinned by these module globals.
 */
export function resetEditorSchemaCache(): void {
  globalSchemaItems = null;
  globalSchemaConnId = null;
  tabSchemaItems = null;
  tabSchemaConnId = null;
  tabTargetConnId = undefined;
  cachedSuggestions = [];
  lastSchemaHash = "";
  lastSchemaSourceKey = "";
  globalConnCtx = { db: null, connectionId: null, dbType: "", database: "" };
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

/**
 * Static completion entries: SQL keywords + builtin functions. These need no
 * database schema, so they are suggested even when disconnected (a previous
 * version only built them inside the schema gate, leaving disconnected users
 * with zero suggestions of any kind). The schema-backed path reuses the same
 * lists so both stay in lockstep.
 */
const STATIC_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "CROSS JOIN",
  "ON", "ORDER BY", "GROUP BY", "HAVING", "INSERT INTO", "VALUES", "UPDATE",
  "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE",
  "CREATE INDEX", "DROP INDEX", "AS", "DISTINCT", "LIMIT", "OFFSET",
  "IN", "NOT IN", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL", "AND", "OR", "NOT", "EXISTS", "BETWEEN",
  "WITH", "RECURSIVE", "UNION", "ALL", "EXCEPT", "INTERSECT"
];

const STATIC_FUNCTIONS = [
  "COUNT", "SUM", "AVG", "MAX", "MIN", "NOW", "COALESCE", "NULLIF", "CASE", "RANK", "ROW_NUMBER", "TO_CHAR", "EXTRACT"
];

function staticFunctionInsertText(fn: string): string {
  return fn === "CASE" ? "CASE WHEN $1 THEN $2 ELSE $3 END" : fn + "($1)";
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
}: QueryEditorProps) {
  const { theme } = useTheme();
  const settings = useSettings();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<any[]>([]);
  const onRunRef = useRef<any>(null);
  const lastSnapshotRef = useRef<string>("");
  const snapshotTimerRef = useRef<any>(null);
  const { schemaItems, currentDb, activeConnection, selectedDatabase, ensureSchemaFor, connections, vaultCredentials } = useConnections();
  // `#` comment handling follows the active connection's dialect (a ref
  // because handleEditorMount's handlers outlive renders — reading the prop
  // directly would pin the dialect from mount time across connection switches).
  const hashOptsRef = useRef<{ hashComments: boolean }>({ hashComments: false });
  hashOptsRef.current = { hashComments: isMySqlLike(activeConnection?.type) };
  
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

  useEffect(() => {
    globalSchemaItems = schemaItems;
    globalSchemaConnId = activeConnection?.id ?? null;
    cachedSuggestions = [];  // Clear cached suggestions
    lastSchemaHash = "";      // Force cache miss
    lastSchemaSourceKey = "";
  }, [schemaItems, activeConnection?.id]);

  // Tab-targeted schema: when this tab targets a connection that is NOT the
  // globally-active one (fresh tabs inheriting the previous connection,
  // restored sessions, multi-connection work), background-fetch its schema
  // so completion, hover and JOIN suggestions work without a sidebar click.
  // Results land in the module `tabSchemaItems` the provider reads; the
  // explorer tree (global schema) is never touched. Suggestions simply
  // appear once the fetch resolves. The fetch establishes a connection, so
  // it honors the "Reconnect previous connection on startup" setting: users
  // who disabled all automatic connections keep them off. `vaultCredentials`
  // in deps retries after a vault-profile pick (background fetches can't
  // prompt, so the first attempt with a locked vault fails by design).
  useEffect(() => {
    tabTargetConnId = targetConnectionId ?? undefined;
    if (!targetConnectionId || settings.autoReconnect === false) {
      if (tabSchemaItems !== null || tabSchemaConnId !== null) {
        tabSchemaItems = null;
        tabSchemaConnId = null;
        lastSchemaHash = "";
        lastSchemaSourceKey = "";
      }
      return;
    }
    // Tab targets the globally-active connection: the global schema covers
    // it — no background fetch, and any stale tab cache is dropped.
    if (activeConnection?.id === targetConnectionId && schemaItems) {
      if (tabSchemaItems !== null || tabSchemaConnId !== null) {
        tabSchemaItems = null;
        tabSchemaConnId = null;
        lastSchemaHash = "";
        lastSchemaSourceKey = "";
      }
      return;
    }
    let cancelled = false;
    tabSchemaConnId = targetConnectionId;
    // Always resolve through the context cache (hit = same ref, no work):
    // it was possibly evicted by a disconnect since our last run, and only
    // a fresh resolve observes that instead of serving stale module state.
    ensureSchemaFor(targetConnectionId, targetDatabase)
      .then((items) => {
        if (cancelled) return;
        if (tabSchemaItems !== items) {
          tabSchemaItems = items;
          lastSchemaHash = ""; // Force the provider to rebuild from the new source
          lastSchemaSourceKey = "";
        }
      })
      .catch(() => {
        if (!cancelled && tabSchemaConnId === targetConnectionId) tabSchemaItems = null;
      });
    return () => {
      cancelled = true;
    };
    // ensureSchemaFor identity changes per render (plain context closure);
    // depending on it would refire every render, so depend on the stable
    // inputs instead — cache hits make refires cheap and idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetConnectionId, targetDatabase, activeConnection?.id, schemaItems, connections, vaultCredentials, settings.autoReconnect]);

  // Keep the signature-help provider's connection snapshot current.
  useEffect(() => {
    globalConnCtx = {
      db: currentDb || null,
      connectionId: activeConnection?.id || null,
      dbType: activeConnection?.type || "",
      database: selectedDatabase || activeConnection?.database || "",
    };
  }, [currentDb, activeConnection, selectedDatabase]);

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

      const text = model.getValue();
      const decorations: any[] = [];
      const regex = /:[a-zA-Z_][a-zA-Z0-9_]*(?::[^:?]+)?(\?)?/g;
      let match;

      while ((match = regex.exec(text)) !== null) {
        const startPos = model.getPositionAt(match.index);
        const endPos = model.getPositionAt(match.index + match[0].length);
        decorations.push({
          range: new monaco.Range(
            startPos.lineNumber,
            startPos.column,
            endPos.lineNumber,
            endPos.column
          ),
          options: {
            inlineClassName: varDecorationClass,
          },
        });
      }

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

    // Custom Commands
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, handleRunSmart);

    // Run ALL statements - Ctrl+Shift+Enter
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, handleRunAll);

    window.addEventListener("run-query-smart", handleRunSmart);
    window.addEventListener("run-query-all", handleRunAll);
    
    editor.onDidDispose(() => {
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

    // Alt+Enter - Intention Actions
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => {
      showIntentionActions(editor, monaco, onRunRef);
    });

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
        provideHover: (model: any, position: any) => {
          const word = model.getWordAtPosition(position);
          if (!word) return null;
          
          let contents = [];

          // Hover follows the same tab-aware schema source as completion.
          const hoverItems = pickCompletionSchema({
            globalItems: globalSchemaItems,
            globalConnId: globalSchemaConnId,
            tabItems: tabSchemaItems,
            tabConnId: tabSchemaConnId,
            targetConnId: tabTargetConnId,
          });
          if (hoverItems && word.word) {
            const token = word.word.toLowerCase();
            const isTable = hoverItems.tables?.includes(token) || hoverItems.tables?.some((t: string) => t.endsWith(`.${token}`));
            const isView = hoverItems.views?.includes(token) || hoverItems.views?.some((v: string) => v.endsWith(`.${token}`));

            if (isTable || isView) {
              const tableCols = hoverItems.columns?.filter((c: any) =>
                c.table_name === token || c.table_name.endsWith(`.${token}`)
              ) || [];

              if (tableCols.length > 0) {
                let schemaDef = `\`\`\`sql\nCREATE ${isTable ? 'TABLE' : 'VIEW'} ${token} (\n`;
                schemaDef += tableCols.map((c: any) => `  ${c.column_name}`).join(',\n');
                schemaDef += `\n);\n\`\`\``;
                contents.push({ value: schemaDef });
              } else {
                 contents.push({ value: `**${isTable ? 'Table' : 'View'}**: \`${token}\`` });
              }
            } else if (hoverItems.functions?.includes(token) || hoverItems.functions?.some((f: string) => f.endsWith(`.${token}`))) {
               contents.push({ value: `**Function**: \`${token}()\`` });
            }
          }
          return { contents };
        }
      });
    }

    // DataGrip-style parameter hints: `my_func(` shows `my_func(a int, b text)`
    // with the active argument highlighted. Registered once globally; the
    // provider reads the live connection from `globalConnCtx`.
    // Isolated from the completion provider below: a signature-help failure
    // must never prevent table/column/keyword suggestions from registering.
    try {
      registerSignatureHelp(monaco, () => globalConnCtx);
    } catch (e) {
      console.error("Signature-help provider registration failed (completion unaffected):", e);
    }

    editor.onMouseDown((e) => {
      if ((e.event.ctrlKey || e.event.metaKey) && e.target.position) {
        const word = editor.getModel()?.getWordAtPosition(e.target.position);
        if (word && globalSchemaItems) {
          const line = editor.getModel()?.getLineContent(e.target.position.lineNumber) || "";
          const wordContextStart = line.lastIndexOf(" ", word.startColumn - 1);
          const wordContextEnd = line.indexOf(" ", word.endColumn - 1);
          const candidateToken = line.substring(wordContextStart === -1 ? 0 : wordContextStart + 1, wordContextEnd === -1 ? line.length : wordContextEnd).trim().replace(/;|,/g, '');
          
          window.dispatchEvent(new CustomEvent("open-definition", { detail: { name: candidateToken } }));
        }
      }
    });

    // SINGLE GLOBAL PROVIDER REGISTRATION
    // This is the "Boss" way to handle Monaco providers in React
    if (!sqlProviderDisposable) {
      sqlProviderDisposable = monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: ['.', ' '],
        provideCompletionItems: (model: any, position: any) => {
          if (!model || !position) return { suggestions: [] };
          
          const word = model.getWordUntilPosition(position);
          let startColumn = word.startColumn;
          
          const lineContent = model.getLineContent(position.lineNumber);
          if (startColumn > 1 && lineContent[startColumn - 2] === '.') {
             const pWord = model.getWordUntilPosition({ lineNumber: position.lineNumber, column: startColumn - 1 });
             if (pWord && pWord.word) {
                 startColumn = pWord.startColumn;
             }
          }

          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: startColumn,
            endColumn: word.endColumn,
          };

          // Tab-aware schema source: the tab's own connection wins over the
          // globally-active one (see pickCompletionSchema). Tabs on lazy
          // connections get their background-fetched schema here.
          const items = pickCompletionSchema({
            globalItems: globalSchemaItems,
            globalConnId: globalSchemaConnId,
            tabItems: tabSchemaItems,
            tabConnId: tabSchemaConnId,
            targetConnId: tabTargetConnId,
          });

// Re-compute suggestions only if schema has changed
            // Use a hash of key arrays for more reliable cache invalidation
            const schemaHash = items ? `${items.tables?.length || 0}-${items.views?.length || 0}-${items.columns?.length || 0}-${items.foreignKeys?.length || 0}-${items._ts || 0}` : "";
            const sourceKey = tabTargetConnId ?? `global:${globalSchemaConnId ?? ""}`;

            if (items && (schemaHash !== lastSchemaHash || sourceKey !== lastSchemaSourceKey)) {
              const rawSuggestions: any[] = [];
              const rawSeen = new Set();

              const addRaw = (label: string, kind: any, insertText: string, detail?: string, documentation?: any, snippet?: boolean) => {
                 if (label == null) return;
                 if (!rawSeen.has(label + kind)) {
                   rawSuggestions.push({
                     label,
                     kind,
                     insertText,
                     detail,
                     documentation,
                     // `$1` tab-stop placeholders only expand when flagged.
                     ...(snippet ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
                     range
                   });
                   rawSeen.add(label + kind);
                 }
              };

              // Keywords (shared static list — also used for the no-schema fallback below)
              STATIC_KEYWORDS.forEach(k => addRaw(k, monaco.languages.CompletionItemKind.Keyword, k + " "));

              // Functions (shared static list — also used for the no-schema fallback below)
              STATIC_FUNCTIONS.forEach(f => addRaw(f, monaco.languages.CompletionItemKind.Function, staticFunctionInsertText(f), undefined, undefined, true));

              // Schema-backed entries. Guarded: a malformed catalog row must
              // never throw out of the provider and kill ALL suggestions.
              try {
              // Tables & Views with smart aliases in JOIN context
              const existingAliases = extractExistingAliases(model.getValue());
              if (items.tables) items.tables.forEach((t: string) => {
                const alias = generateTableAlias(t, existingAliases);
                addRaw(t, monaco.languages.CompletionItemKind.Class, `${t} ${alias}`, `${t} → ${alias}`);
              });
              if (items.views) items.views.forEach((v: string) => {
                const alias = generateTableAlias(v, existingAliases);
                addRaw(v, monaco.languages.CompletionItemKind.Interface, `${v} ${alias}`, `${v} → ${alias}`);
              });
              
// Smart JOIN suggestions based on Foreign Keys - with aliases
              const fkSuggestions: any[] = [];
              if (items.foreignKeys && items.tables) {
                items.foreignKeys.forEach((fk: any) => {
                   const targetAlias = generateTableAlias(fk.target_table, existingAliases);
                   const label = `JOIN ${fk.target_table} ON ${fk.source_column} = ${fk.target_column}`;
                   const insertText = `${fk.target_table} ${targetAlias} ON \${1:${fk.source_table}.${fk.source_column}} = \${2:${fk.target_table}.${fk.target_column}}`;
                    const suggestion = { 
                      label, 
                      kind: monaco.languages.CompletionItemKind.Snippet, 
                      insertText, 
                      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                      detail: "Join via Foreign Key",
                      documentation: { value: `Smart Join between **${fk.source_table}** and **${fk.target_table}**` },
                      range,
                      isForeignKey: true
                    };
                   fkSuggestions.push(suggestion);
                  });
                // Add FK suggestions to main list
                fkSuggestions.forEach(fk => {
                  rawSuggestions.push(fk);
                  rawSeen.add(fk.label + fk.kind);
                });
              }

              // Global Columns - LAZY LOAD: only top 1000 to prevent freezing
              if (items.columns) {
                const topColumns = items.columns.slice(0, 1000);
                topColumns.forEach((c: any) => {
                  addRaw(c.column_name, monaco.languages.CompletionItemKind.Field, c.column_name, `${c.table_name} column`);
                });
              }

              if (items.functions) items.functions.forEach((f: string) => addRaw(f, monaco.languages.CompletionItemKind.Method, f.includes('.') ? f + "($1)" : f + "($1)", undefined, undefined, true));
              } catch (rebuildErr) {
                // Keywords + builtin functions above are already queued and the
                // schema-dot / alias-dot paths below read `items` directly, so
                // completion degrades instead of dying on malformed catalog data.
                console.error("Schema suggestion rebuild failed (static suggestions kept):", rebuildErr);
              }

              cachedSuggestions = rawSuggestions;
              lastSchemaHash = schemaHash;
              lastSchemaSourceKey = sourceKey;
            }

            // FILTER logic for specific context (JOIN, ON, etc.)
            const textUntilCursor = model.getValueInRange({
              startLineNumber: position.lineNumber, startColumn: 1,
              endLineNumber: position.lineNumber, endColumn: position.column
            }).toUpperCase();
            
            // Also get multi-line text up to cursor for cross-line context detection
            const fullTextUntilCursor = model.getValueInRange({
              startLineNumber: 1, startColumn: 1,
              endLineNumber: position.lineNumber, endColumn: position.column
            });

// Detect JOIN context - match all JOIN types (LEFT, RIGHT, INNER, CROSS, FULL, NATURAL, USING, etc.)
const isInJoinContext = /(\b|^)(JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|FULL\s+JOIN|OUTER\s+JOIN|NATURAL\s+JOIN|NATURAL\s+LEFT\s+JOIN|NATURAL\s+RIGHT\s+JOIN|NATURAL\s+INNER\s+JOIN|USING)\s*$/i.test(textUntilCursor);
            // Detect ON context: ON at end of current line OR ON at end of full text (multi-line)
            const isInOnContext = /\bON\s*$/i.test(textUntilCursor) || /\bON\s*$/i.test(fullTextUntilCursor.toUpperCase());
            
            // Get current word being typed for filtering
            const currentWord = word.word.toLowerCase();
            const currentWordLength = currentWord.length;
            
            // Issue #28: schema-qualified autocomplete. When the cursor sits in `<schema>.<typed>`
            // context, Monaco's default fuzzy matcher treats `.` as a member-access trigger and
            // filters out `schema.table`-style labels. Build a dedicated suggestion list with bare
            // labels and a replacement range that covers only the post-dot text, matching how
            // DataGrip and DBeaver handle this.
            if (items) {
              const tableMatch = detectSchemaDotContext(lineContent, position.column, items.tables || []);
              const viewMatch = detectSchemaDotContext(lineContent, position.column, items.views || []);
              const fnMatch = detectSchemaDotContext(lineContent, position.column, items.functions || []);
              const anyMatch = tableMatch || viewMatch || fnMatch;
              if (anyMatch) {
                const schemaRange = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: anyMatch.rangeStartColumn,
                  endColumn: word.endColumn,
                };
                const schemaSuggestions = [
                  ...(tableMatch?.bareNames || []).map((bare, idx) => ({
                    label: bare,
                    kind: monaco.languages.CompletionItemKind.Class,
                    insertText: bare,
                    detail: `${anyMatch.schema}.${bare}`,
                    range: schemaRange,
                    sortText: `0${String(idx).padStart(4, "0")}`,
                  })),
                  ...(viewMatch?.bareNames || []).map((bare, idx) => ({
                    label: bare,
                    kind: monaco.languages.CompletionItemKind.Interface,
                    insertText: bare,
                    detail: `${anyMatch.schema}.${bare}`,
                    range: schemaRange,
                    sortText: `1${String(idx).padStart(4, "0")}`,
                  })),
                  ...(fnMatch?.bareNames || []).map((bare, idx) => ({
                    label: bare,
                    kind: monaco.languages.CompletionItemKind.Method,
                    insertText: `${bare}($1)`,
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                    detail: `${anyMatch.schema}.${bare}()`,
                    range: schemaRange,
                    sortText: `2${String(idx).padStart(4, "0")}`,
                  })),
                ];
                return { suggestions: schemaSuggestions };
              }

              // Issue #28 (extended): alias.column and table.column completion. Same Monaco dot-trigger
              // pitfall as the schema-dot case — bare column labels get filtered out when the range
              // covers `<alias>.`. Resolve the alias against FROM/JOIN clauses in the visible query
              // and surface that table's columns with a post-dot range.
              const aliasMatch = detectAliasDotContext(
                lineContent,
                position.column,
                model.getValue(),
                items.columns || [],
              );
              if (aliasMatch) {
                const aliasRange = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: aliasMatch.rangeStartColumn,
                  endColumn: word.endColumn,
                };
                const aliasSuggestions = aliasMatch.columnNames.map((col, idx) => ({
                  label: col,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col,
                  detail: `${aliasMatch.tableName}.${col}`,
                  range: aliasRange,
                  sortText: String(idx).padStart(4, "0"),
                }));
                return { suggestions: aliasSuggestions };
              }
            }

            // No-schema fallback: with no connection there is no catalog, but
            // SQL keywords and builtin functions are static — suggest those
            // instead of an empty list so completion never goes fully dead.
            if (!items) {
              const wordLower = word.word.toLowerCase();
              return {
                suggestions: [
                  ...STATIC_KEYWORDS.filter((k) => matchesStaticLabel(k, wordLower)).map((k) => ({
                    label: k,
                    kind: monaco.languages.CompletionItemKind.Keyword,
                    insertText: k + " ",
                    range,
                  })),
                  ...STATIC_FUNCTIONS.filter((f) => matchesStaticLabel(f, wordLower)).map((f) => ({
                    label: f,
                    kind: monaco.languages.CompletionItemKind.Function,
                    insertText: staticFunctionInsertText(f),
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                    range,
                  })),
                ],
              };
            }

            // Dynamic filtering based on context
            let contextSuggestions = [...cachedSuggestions];

            // Filter suggestions based on current word prefix for performance
            // This significantly reduces the number of suggestions shown when typing.
            // Issue #97: tables/views carry schema-qualified labels (e.g. `app.users`), so a
            // strict `startsWith` on the qualified label hides them when the user types the bare
            // table name. `matchesQualifiedOrBareName` accepts either prefix.
            if (currentWordLength > 0) {
              contextSuggestions = contextSuggestions.filter(s => {
                const label = s.label.toLowerCase();
                // Always include keywords and functions (they're important)
                if (s.kind === monaco.languages.CompletionItemKind.Keyword ||
                    s.kind === monaco.languages.CompletionItemKind.Function) {
                  return matchesStaticLabel(label, currentWord);
                }
                return matchesQualifiedOrBareName(label, currentWord);
              });
            }

            // Separate FK suggestions for priority handling
            const fkSnippets = contextSuggestions.filter((s: any) => s.isForeignKey);
            const nonFkSuggestions = contextSuggestions.filter((s: any) => !s.isForeignKey);

            // In JOIN context, prioritize FK snippets at the TOP always
            let sortedSuggestions: any[] = [];
            if (isInJoinContext) {
              // First: FK snippets (most important - they help user join tables)
              // Filter FK snippets by current word
              const matchingFks = fkSnippets.filter((s: any) => 
                s.label.toLowerCase().includes(currentWord) || currentWordLength === 0
              );
              sortedSuggestions = [...matchingFks];
              
              // Then: tables/views
              const tablesViews = nonFkSuggestions.filter(s => 
                s.kind === monaco.languages.CompletionItemKind.Class ||
                s.kind === monaco.languages.CompletionItemKind.Interface
              );
              sortedSuggestions = [...sortedSuggestions, ...tablesViews.slice(0, 20)];
              
              // Then: keywords
              const keywords = nonFkSuggestions.filter(s => 
                s.kind === monaco.languages.CompletionItemKind.Keyword
              );
              sortedSuggestions = [...sortedSuggestions, ...keywords.slice(0, 10)];
              
              // Fill remaining slots with other suggestions
              const remaining = nonFkSuggestions.filter(s => 
                !sortedSuggestions.includes(s)
              );
              sortedSuggestions = [...sortedSuggestions, ...remaining.slice(0, 50)];
            } else if (isInOnContext) {
              // In ON context - dynamically generate FK ON-clause suggestions
              // using tables and aliases already declared in the query.
              
              // Parse the full query text for table→alias mappings
              const fullText = model.getValue();
              const tableAliasMap = new Map<string, string>(); // alias→tableName
              const tableNameToAlias = new Map<string, string>(); // tableName→alias
              
              // Match: FROM/JOIN table_name [AS] alias
              const tablePattern = /(?:FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|FULL\s+JOIN|NATURAL\s+JOIN)\s+(?:["']?(\w+(?:\.\w+)?)["']?)\s+(?:AS\s+)?(\w+)/gi;
              let tableMatch;
              while ((tableMatch = tablePattern.exec(fullText)) !== null) {
                const tblName = tableMatch[1].toLowerCase();
                const aliasName = tableMatch[2].toLowerCase();
                // Skip SQL keywords that might false-match as aliases
                const reserved = new Set(['on','where','left','right','inner','cross','full','natural','join','and','or','set','select','from','group','order','having','limit','offset','using','as']);
                if (!reserved.has(aliasName)) {
                  tableAliasMap.set(aliasName, tblName);
                  tableNameToAlias.set(tblName, aliasName);
                }
              }
              
              // Also match tables without aliases: FROM table_name (no alias follows)
              const tableNoAliasPattern = /(?:FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|FULL\s+JOIN)\s+["']?(\w+(?:\.\w+)?)["']?(?:\s*$|\s+(?:ON|WHERE|LEFT|RIGHT|INNER|CROSS|FULL|NATURAL|JOIN|GROUP|ORDER|HAVING|LIMIT|OFFSET|;))/gi;
              let noAliasMatch;
              while ((noAliasMatch = tableNoAliasPattern.exec(fullText)) !== null) {
                const tblName = noAliasMatch[1].toLowerCase();
                if (!tableNameToAlias.has(tblName)) {
                  tableAliasMap.set(tblName, tblName);
                  tableNameToAlias.set(tblName, tblName);
                }
              }
              
              // Generate dynamic FK ON-clause suggestions
              const dynamicOnSuggestions: any[] = [];
              
              if (items && items.foreignKeys && tableAliasMap.size >= 2) {
                const declaredTables = new Set(tableAliasMap.values());
                
                items.foreignKeys.forEach((fk: any) => {
                  const srcTable = fk.source_table.toLowerCase();
                  const tgtTable = fk.target_table.toLowerCase();
                  
                  // Both tables must be in the query
                  if (!declaredTables.has(srcTable) && !declaredTables.has(tgtTable)) return;
                  if (!declaredTables.has(srcTable) || !declaredTables.has(tgtTable)) return;
                  
                  // Resolve to aliases
                  const srcAlias = tableNameToAlias.get(srcTable) || srcTable;
                  const tgtAlias = tableNameToAlias.get(tgtTable) || tgtTable;
                  
                  const label = `${srcAlias}.${fk.source_column} = ${tgtAlias}.${fk.target_column}`;
                  const insertText = `${srcAlias}.${fk.source_column} = ${tgtAlias}.${fk.target_column}`;
                  
                  dynamicOnSuggestions.push({
                    label,
                    kind: monaco.languages.CompletionItemKind.Snippet,
                    insertText,
                    insertTextRules: 0, // plain text, no snippet syntax
                    detail: `FK: ${fk.source_table}.${fk.source_column} → ${fk.target_table}.${fk.target_column}`,
                    documentation: { value: `**Foreign Key Join**\n\n\`${fk.source_table}.${fk.source_column}\` → \`${fk.target_table}.${fk.target_column}\`` },
                    sortText: '0000' + label, // top priority
                    range
                  });
                  
                  // Also suggest the reverse direction
                  const reverseLabel = `${tgtAlias}.${fk.target_column} = ${srcAlias}.${fk.source_column}`;
                  dynamicOnSuggestions.push({
                    label: reverseLabel,
                    kind: monaco.languages.CompletionItemKind.Snippet,
                    insertText: `${tgtAlias}.${fk.target_column} = ${srcAlias}.${fk.source_column}`,
                    insertTextRules: 0,
                    detail: `FK: ${fk.target_table}.${fk.target_column} ← ${fk.source_table}.${fk.source_column}`,
                    documentation: { value: `**Foreign Key Join (reverse)**\n\n\`${fk.target_table}.${fk.target_column}\` ← \`${fk.source_table}.${fk.source_column}\`` },
                    sortText: '0001' + reverseLabel,
                    range
                  });
                });
              }
              
              // Columns from the declared tables (for manual ON clause writing)
              const declaredTableNames = new Set(tableAliasMap.values());
              const queryTableColumns = nonFkSuggestions.filter(s => 
                s.kind === monaco.languages.CompletionItemKind.Field &&
                s.detail && declaredTableNames.has(s.detail.replace(' column', '').toLowerCase())
              );
              
              const others = nonFkSuggestions.filter(s => 
                !queryTableColumns.includes(s)
              );
              sortedSuggestions = [...dynamicOnSuggestions, ...queryTableColumns.slice(0, 50), ...others.slice(0, 30)];
            } else {
              // Normal context - standard priority
              // Limit total suggestions to prevent UI lag
              const MAX_SUGGESTIONS = 80;
              if (contextSuggestions.length > MAX_SUGGESTIONS) {
                const keywordAndSnippets = contextSuggestions.filter(s => 
                  s.kind === monaco.languages.CompletionItemKind.Keyword || 
                  s.kind === monaco.languages.CompletionItemKind.Snippet
                );
                const tablesAndViews = contextSuggestions.filter(s => 
                  s.kind === monaco.languages.CompletionItemKind.Class || 
                  s.kind === monaco.languages.CompletionItemKind.Interface
                );
                const others = contextSuggestions.filter(s => 
                  !keywordAndSnippets.includes(s) && !tablesAndViews.includes(s)
                );
                
                sortedSuggestions = [
                  ...keywordAndSnippets.slice(0, 20),
                  ...tablesAndViews.slice(0, 20),
                  ...others.slice(0, 40)
                ];
              } else {
                sortedSuggestions = contextSuggestions;
              }
            }

            return {
              suggestions: sortedSuggestions.map(s => ({
                ...s,
                range
              }))
            };
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