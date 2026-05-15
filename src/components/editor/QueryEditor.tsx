import { useRef, useEffect, memo, useCallback, useMemo } from "react";
import "./monacoSetup";
import Editor, { OnMount } from "@monaco-editor/react";
import { Code as CodeIcon, Loader2, CheckCircle, XCircle } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { useConnections } from "../../contexts/useConnections";
import { useSettings } from "../../store/settingsStore";
import { useLocalHistory } from "../../store/localHistoryStore";
import { format } from "sql-formatter";
import { detectSchemaDotContext, detectAliasDotContext } from "./completionContext";

// Global tracking to prevent duplicate provider registration across component mounts
let sqlProviderDisposable: any = null;
let sqlFormatterDisposable: any = null;
let sqlHoverProviderDisposable: any = null;
let globalSchemaItems: any = null;
let cachedSuggestions: any[] = [];
let lastSchemaHash: string = "";

/**
 * Drop the module-level schema cache. Call when disconnecting from a database
 * so the previous connection's schema (which can be tens of MB on wide DBs)
 * is no longer pinned by these module globals.
 */
export function resetEditorSchemaCache(): void {
  globalSchemaItems = null;
  cachedSuggestions = [];
  lastSchemaHash = "";
}

// Listen for connection-disconnected at module scope so the cache is released
// even when no <QueryEditor> is currently mounted. This module is only loaded
// once the editor is first used, so registering once is sufficient.
if (typeof window !== "undefined") {
  window.addEventListener("connection-disconnected", resetEditorSchemaCache);
}

// Smart alias generation - like DataGrip/DBeaver
// Generates alias from table name: "users" -> "u", "user_roles" -> "ur", "project_issue" -> "pi"
const generateTableAlias = (tableName: string, existingAliases: Set<string>): string => {
  // Remove schema prefix if present (e.g., "public.users" -> "users")
  const cleanName = tableName.includes('.') ? tableName.split('.').pop() || tableName : tableName;
  
  // Split by underscore or use first letters
  const words = cleanName.split(/[_-]/);
  
  let alias: string;
  if (words.length >= 2) {
    // Multi-word: take first letter of first two words (e.g., "project_issue" -> "pi")
    alias = (words[0][0] + words[1][0]).toLowerCase();
  } else if (cleanName.length >= 2) {
    // Single word: first 2 characters
    alias = cleanName.substring(0, 2).toLowerCase();
  } else {
    alias = cleanName.toLowerCase();
  }
  
  // If alias already exists, append number (like DBeaver: u, u2, u3)
  if (existingAliases.has(alias)) {
    let counter = 2;
    while (existingAliases.has(alias + counter)) {
      counter++;
    }
    alias = alias + counter;
  }
  
  return alias;
};

// Extract all aliases currently used in the query
const extractExistingAliases = (query: string): Set<string> => {
  const aliases = new Set<string>();
  // Match patterns like "table_name AS alias" or "table_name alias" after FROM/JOIN
  const aliasPattern = /(?:FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN)\s+[\w"]+\.?\w+\s+(?:AS\s+)?(\w+)/gi;
  let match;
  while ((match = aliasPattern.exec(query)) !== null) {
    if (match[1] && match[1].length <= 3) {  // Short aliases only
      aliases.add(match[1].toLowerCase());
    }
  }
  return aliases;
};

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
  menu.className = "fixed z-[9999] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-2xl py-1 min-w-[200px]";
  menu.style.left = `${menuX}px`;
  menu.style.top = `${menuY}px`;

  // Add header with lightbulb icon
  const header = document.createElement("div");
  header.className = "px-3 py-1.5 text-[10px] uppercase font-bold text-[var(--text-secondary)] tracking-widest border-b border-[var(--border)] mb-1";
  header.innerHTML = "💡 Intention Actions";
  menu.appendChild(header);

  actions.forEach(item => {
    const btn = document.createElement("button");
    btn.className = `w-full px-3 py-2 text-left text-xs flex items-center gap-2 transition-colors ${
      item.disabled
        ? "text-[var(--text-secondary)] opacity-40 cursor-not-allowed"
        : "hover:bg-[var(--color-accent)] hover:text-white"
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
  tabId,
  tabName,
  isExecuting,
  hasError,
  hasSuccess,
  lastExecutedStatement: _lastExecutedStatement,
  statementResults
}: QueryEditorProps) {
  const { theme } = useTheme();
  const settings = useSettings();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<any[]>([]);
  const onRunRef = useRef<any>(null);
  const lastSnapshotRef = useRef<string>("");
  const snapshotTimerRef = useRef<any>(null);
  const { schemaItems } = useConnections();
  
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
    cachedSuggestions = [];  // Clear cached suggestions
    lastSchemaHash = "";      // Force cache miss
  }, [schemaItems]);

  // Create a stable fingerprint of statementResults so the effect fires reliably
  // even when React batches state updates and the array reference doesn't change.
  const statementResultsFingerprint = useMemo(() => {
    if (!statementResults || statementResults.length === 0) return '';
    return statementResults.map(r => `${r.lineNumber}:${r.status}:${r.executionTime || 0}`).join(',');
  }, [statementResults]);

  // Effect to update Monaco decorations when statementResults changes (DataGrip-style gutter glyphs)
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    
    // Always clear existing decorations first
    if (decorationsRef.current.length > 0) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }
    
    // During execution, show no glyph — wait for results
    if (isExecuting) return;
    
    // Only create gutter glyphs when statementResults has data (after execution completes)
    if (!statementResults || statementResults.length === 0) {
      return;
    }
    
    // Create decorations for all statement results (DataGrip-style)
    const decorations: any[] = [];
    
    statementResults.forEach((result) => {
      const { lineNumber, status, rowCount, rowsAffected, error, executionTime } = result;
      
      let glyphClassName = 'statement-glyph-running';
      let hoverMessage = 'Query running...';
      let tooltip = '';
      
      if (status === 'success') {
        glyphClassName = 'statement-glyph-success';
        hoverMessage = 'Query succeeded';
        if (rowCount !== undefined) {
          tooltip = `${rowCount} row${rowCount !== 1 ? 's' : ''} retrieved`;
        } else if (rowsAffected !== undefined) {
          tooltip = `${rowsAffected} row${rowsAffected !== 1 ? 's' : ''} affected`;
        }
        if (executionTime !== undefined && executionTime > 0) {
          tooltip += tooltip ? ` in ${executionTime}ms` : `${executionTime}ms`;
        }
      } else if (status === 'error') {
        glyphClassName = 'statement-glyph-error';
        hoverMessage = 'Query failed';
        tooltip = error || 'Error executing query';
      }
      
      // Add gutter glyph decoration
      decorations.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: glyphClassName,
          glyphMarginHoverMessage: { value: tooltip || hoverMessage },
        }
      });
    });
    
    // Apply all decorations
    if (decorations.length > 0) {
      decorationsRef.current = editor.deltaDecorations([], decorations);
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
      // Match :varname (with optional :default and ?)
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

    updateVarDecorations();
    const contentChangeDisposable = editor.onDidChangeModelContent(() => updateVarDecorations());

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
      menu.className = "fixed z-[9999] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-2xl py-1 min-w-[160px]";
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
          hr.className = "my-1 border-t border-[var(--border)]";
          menu.appendChild(hr);
          return;
        }
        const btn = document.createElement("button");
        btn.className = `w-full px-3 py-1.5 text-left text-[11px] flex items-center gap-2 transition-colors ${
          item.disabled
            ? "text-[var(--text-secondary)] opacity-40 cursor-not-allowed"
            : "hover:bg-[var(--color-accent)] hover:text-white"
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
      
      // Strategy: Find all semicolons and find which statement contains the cursor
      const statements: { start: number; end: number; text: string; lineNumber: number }[] = [];
      let searchFrom = 0;
      
      // Split text into individual statements by semicolons
      while (searchFrom < text.length) {
        const semiPos = text.indexOf(';', searchFrom);
        let endPos = semiPos === -1 ? text.length : semiPos;
        
        // Skip leading whitespace for this statement
        let startPos = searchFrom;
        while (startPos < endPos && /\s/.test(text[startPos])) {
          startPos++;
        }
        
        // Extract statement (skip empty)
        const statement = text.substring(startPos, endPos).trim();
        if (statement) {
          // Get line number for this statement
          const statementStartPos = model.getPositionAt(startPos);
          statements.push({ start: startPos, end: endPos, text: statement, lineNumber: statementStartPos.lineNumber });
        }
        
        if (semiPos === -1) break;
        searchFrom = semiPos + 1;
      }
      
      // Find which statement contains the cursor or is closest before it
      let targetStatement: { start: number; end: number; text: string; lineNumber: number } | null = null;
      
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        const nextStmt = statements[i + 1];
        
        // Case 1: Cursor is inside the statement bounds
        if (offset >= stmt.start && offset <= stmt.end) {
          targetStatement = stmt;
          break;
        }
        
        // Case 2: Cursor is between this statement and the next (whitespace/newlines)
        // We prefer the statement just before the cursor (SQL typically runs what was just typed)
        if (nextStmt && offset > stmt.end && offset < nextStmt.start) {
          targetStatement = stmt;
          break;
        }
      }
      
      // Case 3: Cursor is after everything - run the last one
      if (!targetStatement && statements.length > 0 && offset > statements[statements.length - 1].end) {
        targetStatement = statements[statements.length - 1];
      }
      
      // Fallback: Default to first statement instead of failing
      if (!targetStatement && statements.length > 0) {
        targetStatement = statements[0];
      }
      
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
      
      const text = model.getValue().trim();
      if (!text) {
        onRunRef.current?.();
        return;
      }
      
      // Collect all statements with their line numbers
      const allStatements: { text: string; lineNumber: number }[] = [];
      let searchFrom = 0;
      
      while (searchFrom < text.length) {
        const semiPos = text.indexOf(';', searchFrom);
        let endPos = semiPos === -1 ? text.length : semiPos;
        
        // Skip leading whitespace for this statement
        let startPos = searchFrom;
        while (startPos < endPos && /\s/.test(text[startPos])) {
          startPos++;
        }
        
        // Extract statement
        const statement = text.substring(startPos, endPos).trim();
        if (statement) {
          const statementStartPos = model.getPositionAt(startPos);
          allStatements.push({ text: statement, lineNumber: statementStartPos.lineNumber });
        }
        
        if (semiPos === -1) break;
        searchFrom = semiPos + 1;
      }
      
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
      window.removeEventListener("focus-editor", focusHandler);
      window.removeEventListener("format-sql", formatHandler);
      window.removeEventListener("run-query-smart", handleRunSmart);
      window.removeEventListener("run-query-all", handleRunAll);
      if (domNode) domNode.removeEventListener("contextmenu", handleContextMenu);
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
          
          if (globalSchemaItems && word.word) {
            const token = word.word.toLowerCase();
            const isTable = globalSchemaItems.tables?.includes(token) || globalSchemaItems.tables?.some((t: string) => t.endsWith(`.${token}`));
            const isView = globalSchemaItems.views?.includes(token) || globalSchemaItems.views?.some((v: string) => v.endsWith(`.${token}`));

            if (isTable || isView) {
              const tableCols = globalSchemaItems.columns?.filter((c: any) => 
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
            } else if (globalSchemaItems.functions?.includes(token) || globalSchemaItems.functions?.some((f: string) => f.endsWith(`.${token}`))) {
               contents.push({ value: `**Function**: \`${token}()\`` });
            }
          }
          return { contents };
        }
      });
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

          const items = globalSchemaItems;
          
// Re-compute suggestions only if schema has changed
            // Use a hash of key arrays for more reliable cache invalidation
            const schemaHash = items ? `${items.tables?.length || 0}-${items.views?.length || 0}-${items.columns?.length || 0}-${items.foreignKeys?.length || 0}-${items._ts || 0}` : "";
            
            if (items && schemaHash !== lastSchemaHash) {
              const rawSuggestions: any[] = [];
              const rawSeen = new Set();
              
              const addRaw = (label: string, kind: any, insertText: string, detail?: string, documentation?: any) => {
                 if (!rawSeen.has(label + kind)) {
                   rawSuggestions.push({ 
                     label, 
                     kind, 
                     insertText, 
                     detail,
                     documentation,
                     range 
                   });
                   rawSeen.add(label + kind);
                 }
              };

              // Keywords
              const keywords = [
                "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "CROSS JOIN",
                "ON", "ORDER BY", "GROUP BY", "HAVING", "INSERT INTO", "VALUES", "UPDATE", 
                "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", 
                "CREATE INDEX", "DROP INDEX", "AS", "DISTINCT", "LIMIT", "OFFSET", 
                "IN", "NOT IN", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL", "AND", "OR", "NOT", "EXISTS", "BETWEEN",
                "WITH", "RECURSIVE", "UNION", "ALL", "EXCEPT", "INTERSECT"
              ];
              keywords.forEach(k => addRaw(k, monaco.languages.CompletionItemKind.Keyword, k + " "));

              // Functions
              const functions = ["COUNT", "SUM", "AVG", "MAX", "MIN", "NOW", "COALESCE", "NULLIF", "CASE", "RANK", "ROW_NUMBER", "TO_CHAR", "EXTRACT"];
              functions.forEach(f => addRaw(f, monaco.languages.CompletionItemKind.Function, f === "CASE" ? "CASE WHEN $1 THEN $2 ELSE $3 END" : f + "($1)"));

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

              if (items.functions) items.functions.forEach((f: string) => addRaw(f, monaco.languages.CompletionItemKind.Method, f.includes('.') ? f + "($1)" : f + "($1)"));
              
              cachedSuggestions = rawSuggestions;
              lastSchemaHash = schemaHash;
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

            // Dynamic filtering based on context
            let contextSuggestions = [...cachedSuggestions];

            // Filter suggestions based on current word prefix for performance
            // This significantly reduces the number of suggestions shown when typing
            if (currentWordLength > 0) {
              contextSuggestions = contextSuggestions.filter(s => {
                const label = s.label.toLowerCase();
                // Always include keywords and functions (they're important)
                if (s.kind === monaco.languages.CompletionItemKind.Keyword || 
                    s.kind === monaco.languages.CompletionItemKind.Function) {
                  return label.startsWith(currentWord) || label.includes(currentWord);
                }
                // For tables, views, columns - prefix match is faster
                return label.startsWith(currentWord);
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
    <div className="h-full w-full flex flex-col bg-[var(--surface)]">
      <div className="h-7 flex items-center justify-between px-3 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-3">
          {/* Status Indicator - Left side of query area (DataGrip style) */}
          <div className="flex items-center gap-2 shrink-0">
            {isExecuting ? (
              <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
            ) : hasError ? (
              <XCircle className="w-4 h-4 text-red-400" />
            ) : hasSuccess ? (
              <CheckCircle className="w-4 h-4 text-emerald-400" />
            ) : (
              <CodeIcon className="w-3 h-3 text-[var(--color-accent)]" />
            )}
          </div>
          
          {/* Connection name in brackets + query preview */}
          <div className="flex items-center gap-2">
            {connectionName && (
              <span className="text-xs font-bold text-[var(--color-accent)] opacity-90">
                [{connectionName}]
              </span>
            )}
            <span className="text-xs font-medium text-[var(--text-primary)]">SQL Editor</span>
            {databaseName && (
              <span className="text-[9px] text-[var(--text-secondary)] opacity-60">
                / {databaseName}
              </span>
            )}
          </div>
          
          {/* Keyboard shortcuts hint */}
          <span className="text-[9px] text-[var(--text-secondary)] opacity-50 ml-2 hidden sm:inline">Ctrl+Enter: run at cursor • Ctrl+Shift+Enter: run all • Ctrl+Shift+L: format</span>
        </div>
        <div className="flex items-center gap-2">
           <button 
             onClick={() => editorRef.current?.getAction('editor.action.formatDocument')?.run()}
             className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] hover:bg-[var(--border)] transition-colors opacity-70 hover:opacity-100"
           >
             Format SQL
           </button>
        </div>
      </div>
      
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language="sql"
          theme={theme === "dark" ? "vs-dark" : "vs"}
          value={value}
          onChange={(value) => onChange(value || "")}
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