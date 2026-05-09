import React, { useState, useMemo, useEffect, memo, useRef } from "react";
import { 
  AlertCircle, Table2, Hash, Type, Calendar, Binary, Code as CodeIcon, 
  Filter, Shield, Download, FileJson, XCircle, Search, Copy, 
  Trash2, Maximize2, Plus, RefreshCw, Zap, CheckCircle, Clock, ChevronRight,
  FileCode, Globe, Database, History as HistoryIcon
} from "lucide-react";
import { useQueryHistory } from "../../store/queryHistoryStore";
import { useSettings } from "../../store/settingsStore";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { AddRowModal } from "../tools/AddRowModal";
import { VisualOptimizer } from "./VisualOptimizer";
import { GridView, GridViewRef } from "../ui/GridView";
import { CompactSelection } from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import clsx from "clsx";

interface ResultsPanelProps {
  results: any[];
  error: string | null;
  isLoading: boolean;
  executionTime?: number;
  tableName?: string;
  onUpdateRow?: (oldRow: any, newRow: any) => Promise<void>;
  onDeleteRow?: (row: any) => Promise<void>;
  onAddRow?: (newRow: any, localOnly?: boolean) => Promise<void>;
  onResultsChange?: (newResults: any[]) => void;
  onRefresh?: () => void;
  onSave?: (results: any[]) => Promise<void>;
  onDiscard?: () => void;
  successMessage?: string | null;
  forcedColumns?: string[];
  optimizerData?: any;
  onApplyFix?: (sql: string) => void;
  isReadOnly?: boolean;
  /** When true, success/error messages won't auto-switch the active tab. */
  suppressTabSwitch?: boolean;
  multiResults?: {
    query: string;
    rows?: any[];
    columns?: string[];
    rowsAffected?: number;
    error?: string | null;
    executionTime?: number;
  }[];
}

type ResultsTab = "messages" | "result" | "history" | "optimizer";

 export const ResultsPanel = memo(function ResultsPanel({ 
  results, error, isLoading, executionTime = 0, tableName,
  onUpdateRow, onDeleteRow, onAddRow, onResultsChange, onRefresh,
  successMessage, forcedColumns, optimizerData, onApplyFix, onSave, onDiscard,
  multiResults, isReadOnly = false, suppressTabSwitch = false
}: ResultsPanelProps) {
  const settings = useSettings();
  const { history, clearHistory, searchHistory, getRecentQueries } = useQueryHistory();
  const [activeTab, setActiveTab] = useState<ResultsTab>("result");
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; col: string; value: any } | null>(null);
  const [showCopyToast, setShowCopyToast] = useState(false);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [showColumnFilters, setShowColumnFilters] = useState(false);
  const [showAddRowModal, setShowAddRowModal] = useState(false);
  const [isProductionMode, setIsProductionMode] = useState(false);
  const [columnSearch, setColumnSearch] = useState("");
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [gridSelection, setGridSelection] = useState<any>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
    current: undefined
  });
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: any; col?: string } | null>(null);
  const [selectedRow, setSelectedRow] = useState<{row: any; idx: number} | null>(null);
  const [selectedRowEdits, setSelectedRowEdits] = useState<Record<string, any>>({});
  const [isEditingRow, setIsEditingRow] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [selectedJumpCol, setSelectedJumpCol] = useState("");
  const [toastMessage, setToastMessage] = useState("Copied to clipboard");
  const [selectedMultiResultIdx, setSelectedMultiResultIdx] = useState<number>(0);
  
  const gridRef = useRef<GridViewRef>(null);
  const confirmDialog = useConfirmDialog();

  // Debounce column filters
  useEffect(() => {
    const timer = setTimeout(() => {
      // Logic for debounced filtering if needed
    }, 200);
    return () => clearTimeout(timer);
  }, [columnFilters]);

  // Tab management
  useEffect(() => {
    // suppressTabSwitch prevents auto-switching when save/delete refreshes results
    if (!suppressTabSwitch) {
      if (error || successMessage) setActiveTab("messages");
      else if (results.length > 0 || (multiResults && multiResults.length > 0)) setActiveTab("result");
    }
    
    // Reset local sorting when actual data content changes (likely new query)
    setSortCol(null);
    setSortDir(null);
    setSelectedMultiResultIdx(0);
  }, [error, successMessage, results, multiResults, suppressTabSwitch]);

  // Get current multi-result data for display
  const currentMultiResult = multiResults && multiResults.length > 0 ? multiResults[selectedMultiResultIdx] : null;
  const displayResults = currentMultiResult?.rows || results;
  const displayColumns = currentMultiResult?.columns || forcedColumns;

  // Global listeners
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    const handleSwitchTab = (e: Event) => {
      const tab = (e as CustomEvent).detail as ResultsTab;
      setActiveTab(tab);
    };
    const handleScrollBottom = () => {
      if (gridRef.current && results.length > 0) {
        setTimeout(() => {
          gridRef.current?.scrollToRow(results.length - 1);
          gridRef.current?.focus();
        }, 100);
      }
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("switch-results-tab", handleSwitchTab);
    window.addEventListener("grid-scroll-to-bottom", handleScrollBottom);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("switch-results-tab", handleSwitchTab);
      window.removeEventListener("grid-scroll-to-bottom", handleScrollBottom);
    };
  }, []);

  // Keyboard shortcut for Save (Ctrl+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (editingCell) {
          saveEdit(editingCell.value);
        } else if (onSave && results.length > 0) {
          // Global save: flush all pending new rows
          onSave(results);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editingCell, onSave, results]);

  // Sync columns with results
  const columns = useMemo(() => {
    if (columnOrder.length > 0) return columnOrder;
    if (forcedColumns) return forcedColumns;
    if (results.length === 0) return [];
    return Object.keys(results[0]);
  }, [results, forcedColumns, columnOrder]);

  useEffect(() => {
    if (results.length > 0) {
      const newCols = Object.keys(results[0]);
      if (JSON.stringify(newCols) !== JSON.stringify(columnOrder)) {
        setColumnOrder(newCols);
      }
    } else {
      setColumnOrder([]);
    }
  }, [results]);

  // Find column logic
  useEffect(() => {
    if (columnSearch && columns.length > 0) {
      const idx = columns.findIndex(c => c.toLowerCase().includes(columnSearch.toLowerCase()));
      if (idx >= 0) {
        gridRef.current?.scrollToColumn(idx);
      }
    }
  }, [columnSearch, columns]);

  const sortedResults = useMemo(() => {
    let finalData = displayResults.length > 0 ? displayResults : results;
    // Apply column filters
    if (Object.keys(columnFilters).length > 0) {
      finalData = finalData.filter(row => {
        return Object.entries(columnFilters).every(([col, filterText]) => {
          if (!filterText) return true;
          const val = row[col];
          if (val === null || val === undefined) return false;
          return String(val).toLowerCase().includes(filterText.toLowerCase());
        });
      });
    }

    if (!sortCol || !sortDir) return finalData;
    return [...finalData].sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      if (va === vb) return 0;
      if (va == null) return sortDir === "asc" ? -1 : 1;
      if (vb == null) return sortDir === "asc" ? 1 : -1;
      const comparison = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? comparison : -comparison;
    });
  }, [displayResults, results, sortCol, sortDir, columnFilters]);

  // Selection sync & focus
  useEffect(() => {
    if (gridSelection.current?.cell) {
      setSelectedIndex(gridSelection.current.cell[1]);
    } else {
      setSelectedIndex(-1);
    }
  }, [gridSelection.current]);

  const saveEdit = (newValue: any, manualEdit?: { rowIdx: number; col: string; value: any }) => {
    const context = manualEdit || editingCell;
    if (!context || !onResultsChange) return;
    
    const rowToEdit = sortedResults[context.rowIdx];
    // Find the actual index in the source results array
    const sourceIdx = results.findIndex(r => r === rowToEdit);
    
    if (sourceIdx === -1) {
      setEditingCell(null);
      return;
    }

    const oldRow = results[sourceIdx];
    if (String(oldRow[context.col]) === String(newValue)) {
      setEditingCell(null);
      return;
    }

    const newResults = [...results];
    newResults[sourceIdx] = { 
      ...oldRow, 
      [context.col]: newValue,
      _isModified: !oldRow._isNew // Only mark as modified if it's not a brand new row
    };
    
    onResultsChange(newResults);
    setEditingCell(null);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setToastMessage("Copied to clipboard");
    setShowCopyToast(true);
    setTimeout(() => setShowCopyToast(false), 2000);
  };

  const handleExport = async (format: "csv" | "excel" | "json" | "xml" | "html" | "sql" | "tsv") => {
    if (results.length === 0) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const mapping: Record<string, string> = {
        csv: "csv", json: "json", excel: "xls", xml: "xml", html: "html", sql: "sql"
      };
      const extension = mapping[format] || "txt";
      
      const path = await save({
        filters: [{ name: format.toUpperCase(), extensions: [extension] }],
        defaultPath: `export_${new Date().getTime()}.${extension}`
      });
      if (!path) return;
      
      let content = "";
      if (format === "csv") {
        content = [columns.join(","), ...results.map(r => columns.map(c => JSON.stringify(r[c])).join(","))].join("\n");
      } else if (format === "json") {
        content = JSON.stringify(results, null, 2);
      } else if (format === "xml") {
        content = `<?xml version="1.0" encoding="UTF-8"?>\n<results>\n` + 
                  results.map(r => `  <row>\n${columns.map(c => `    <${c}>${formatCellValue(r[c])}</${c}>`).join("\n")}\n  </row>`).join("\n") +
                  `\n</results>`;
      } else if (format === "html") {
        content = `<table border="1">\n  <thead>\n    <tr>${columns.map(c => `<th>${c}</th>`).join("")}</tr>\n  </thead>\n  <tbody>\n` +
                  results.map(r => `    <tr>${columns.map(c => `<td>${formatCellValue(r[c])}</td>`).join("")}</tr>`).join("\n") +
                  `\n  </tbody>\n</table>`;
      } else if (format === "sql") {
        const table = tableName || "exported_data";
        content = results.map(r => `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(c => {
          const v = r[c];
          if (v === null || v === undefined) return "NULL";
          if (typeof v === "number") return v;
          if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
          return `'${String(v).replace(/'/g, "''")}'`;
        }).join(", ")});`).join("\n");
      } else if (format === "tsv") {
        content = [columns.join("\t"), ...results.map(r => columns.map(c => String(r[c]).replace(/\t/g, "    ")).join("\t"))].join("\n");
      } else {
        content = [columns.join("\t"), ...results.map(r => columns.map(c => JSON.stringify(r[c])).join("\t"))].join("\n");
      }
      
      await writeTextFile(path, content);
      setToastMessage(`Exported ${format.toUpperCase()} successfully`);
      setShowCopyToast(true);
    } catch (e: any) {
      confirmDialog.dialog({ title: "Export Failed", message: e.message, type: "danger" });
    }
  };

  const formatCellValue = (value: any, isPreview = false): string => {
    if (value === null || value === undefined) return "NULL";
    let str = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (isPreview && str.length > 250) return str.substring(0, 250) + "…";
    return str;
  };

  const getColumnIcon = (col: string) => {
    if (results.length === 0) return <Type className="w-2.5 h-2.5" />;
    const val = results[0][col];
    if (typeof val === "number") return <Hash className="w-2.5 h-2.5 text-cyan-400" />;
    if (typeof val === "boolean") return <Binary className="w-2.5 h-2.5 text-emerald-400" />;
    if (typeof val === "string" && (val.includes("-") || val.includes("/")) && !isNaN(Date.parse(val))) return <Calendar className="w-2.5 h-2.5 text-amber-400" />;
    if (typeof val === "object") return <CodeIcon className="w-2.5 h-2.5 text-purple-400" />;
    return <Type className="w-2.5 h-2.5 opacity-40" />;
  };

  const handleContextMenu = (e: React.MouseEvent, row: any, col?: string) => {
    e.preventDefault();
    setContextMenu({ x: e.pageX, y: e.pageY, row, col });
  };

  const generateSqlForSelected = (type: "INSERT" | "UPDATE" | "DELETE") => {
    const selectedRows = gridSelection.rows.toArray().map((idx: number) => sortedResults[idx]);
    if (selectedRows.length === 0 && contextMenu?.row) selectedRows.push(contextMenu.row);
    if (selectedRows.length === 0) return;

    const table = tableName || "target_table";
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

  const TabHeader = () => (
    <div className="h-9 flex items-center gap-2 px-3 bg-[var(--surface)] border-b border-[var(--border)] text-xs shrink-0 select-none">
      <button onClick={() => setActiveTab("messages")} className={`h-full flex items-center px-1 border-b transition-all ${activeTab === "messages" ? (error ? "text-red-400 border-red-400" : "text-[var(--color-accent)] border-[var(--color-accent)]") : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"}`}>
        <AlertCircle className="w-3.5 h-3.5 mr-1" /> Messages
      </button>
      <button onClick={() => setActiveTab("result")} className={`h-full flex items-center px-1 border-b transition-all ${activeTab === "result" ? "text-[var(--color-accent)] border-[var(--color-accent)]" : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"}`}>
        <Table2 className="w-3.5 h-3.5 mr-1" /> Results {results.length > 0 && <span className="ml-1 opacity-60">({results.length})</span>}
      </button>
      <button onClick={() => setActiveTab("history")} className={`h-full flex items-center px-1 border-b transition-all ${activeTab === "history" ? "text-[var(--color-accent)] border-[var(--color-accent)]" : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"}`}>
        <HistoryIcon className="w-3.5 h-3.5 mr-1" /> History
      </button>
      {optimizerData && (
        <button onClick={() => setActiveTab("optimizer")} className={`h-full flex items-center px-1 border-b transition-all ${activeTab === "optimizer" ? "text-emerald-400 border-emerald-400" : "text-[var(--text-secondary)] border-transparent hover:text-emerald-400"}`}>
          <Zap className="w-3.5 h-3.5 mr-1" /> Optimizer
        </button>
      )}
      <div className="flex-1" />
      {activeTab === "result" && results.length > 0 && (
        <div className="flex items-center gap-1.5">
          <button onClick={() => setIsProductionMode(!isProductionMode)} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-bold border ${isProductionMode ? "bg-red-500/10 border-red-500/30 text-red-400" : "bg-blue-500/10 border-blue-500/30 text-blue-400"}`}>
            <Shield className="w-3 h-3" /> {isProductionMode ? "MASK ON" : "MASK OFF"}
          </button>
          <button onClick={() => setShowColumnFilters(!showColumnFilters)} className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${showColumnFilters ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--border)]"}`}>
             <Filter className="w-3.5 h-3.5" /> <span className="text-[8px] font-bold">FILTER</span>
          </button>
          <div className="flex items-center bg-[var(--background)] border border-[var(--border)] rounded px-1.5 py-1">
            <Search className="w-3 h-3 text-[var(--text-secondary)] mr-1" />
            <input 
              type="text" 
              placeholder="Jump to col..." 
              list="column-list"
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
              className="bg-transparent border-none outline-none text-xs w-32" 
            />
            <datalist id="column-list">
              {columns.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <select 
            value={selectedJumpCol} 
            onChange={(e) => { 
              const val = e.target.value;
              setSelectedJumpCol(val);
              const idx = parseInt(val); 
              if (!isNaN(idx)) {
                // Update selection for visual feedback
                setGridSelection({
                  columns: CompactSelection.empty(),
                  rows: CompactSelection.empty(),
                  current: {
                    cell: [idx, 0],
                    range: { x: idx, y: 0, width: 1, height: 1 },
                    rangeStack: []
                  }
                });
                // Scroll to it
                setTimeout(() => {
                  gridRef.current?.scrollToColumn(idx);
                  gridRef.current?.focus();
                }, 10);
              }
            }} 
            className="bg-[var(--background)] border border-[var(--border)] rounded text-[8px] px-1 py-0.5 outline-none max-w-[80px] shadow-sm cursor-pointer hover:border-indigo-400"
          >
            <option value="" disabled>Jump To Column...</option>
            {columns.map((c, i) => <option key={c} value={i.toString()}>{c}</option>)}
          </select>
          {onRefresh && <button onClick={onRefresh} className="p-1 px-2 rounded border hover:text-[var(--color-accent)] flex items-center gap-1.5"><RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} /><span className="text-[8px] font-bold">REFRESH</span></button>}
          <div className="flex items-center gap-1.5 ml-1 border-l border-[var(--border)] pl-1.5">
             <button 
              onClick={() => onAddRow && onAddRow({}, true)} 
              disabled={results.some(r => r._isNew || r._isModified)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-30 transition-colors disabled:border-gray-500/30 disabled:text-gray-500" 
              title="Add New Local Blank Row (Save later)"
            >
              <Plus className="w-3.5 h-3.5" /><span className="text-[8px] font-bold">ADD</span>
            </button>
            <button 
              disabled={(selectedIndex < 0 && gridSelection.rows.length === 0) || results.some(r => r._isNew || r._isModified)} 
              onClick={async () => { 
                if (onAddRow) { 
                  const rowIdx = selectedIndex >= 0 ? selectedIndex : gridSelection.rows.toArray()[0];
                  if (rowIdx !== undefined) {
                    const { id, _isNew, ...newRow } = sortedResults[rowIdx]; 
                    await onAddRow(newRow, true); 
                  }
                } 
              }} 
              className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-indigo-500/50 text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-30 transition-colors disabled:border-gray-500/30 disabled:text-gray-500" 
              title="Duplicate Row Locally (Save later)"
            >
              <Copy className="w-3.5 h-3.5" /><span className="text-[8px] font-bold">DUP</span>
            </button>
            <button 
              disabled={selectedIndex < 0 && gridSelection.rows.length === 0} 
              onClick={async () => { 
                const rowIdx = selectedIndex >= 0 ? selectedIndex : gridSelection.rows.toArray()[0];
                if (onDeleteRow && rowIdx !== undefined) { 
                  const confirmed = await confirmDialog.confirm({ title: "Delete Row", message: "Delete this row permanently?", type: "danger" }); 
                  if (confirmed) await onDeleteRow(sortedResults[rowIdx]); 
                } 
              }} 
              className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-rose-500/50 text-rose-400 hover:bg-rose-500/10 disabled:opacity-30 transition-colors" 
              title="Remove Row"
            >
              <Trash2 className="w-3.5 h-3.5" /><span className="text-[8px] font-bold">REMOVE</span>
            </button>
             <button 
              className={clsx(
                "flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors",
                results.some(r => r._isNew || r._isModified)
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                  : "border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
              )}
              title="Save All Pending Changes (Ctrl+S)"
              onClick={async () => {
                 if (onSave) {
                    await onSave(results);
                 } else if (onRefresh) {
                    onRefresh();
                 }
              }}
            >
              <CheckCircle className={clsx("w-3.5 h-3.5", results.some(r => r._isNew || r._isModified) && "animate-pulse")} />
              <span className="text-[8px] font-bold">
                SAVE{results.filter(r => r._isNew || r._isModified).length > 0 ? ` (${results.filter(r => r._isNew || r._isModified).length})` : ""}
              </span>
            </button>
            {results.some(r => r._isNew || r._isModified) && (
              <button 
                onClick={() => onDiscard && onDiscard()}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-rose-500/50 text-rose-400 hover:bg-rose-500/10 transition-colors"
                title="Discard all local changes"
              >
                <XCircle className="w-3.5 h-3.5" /><span className="text-[8px] font-bold">DISCARD</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 ml-1 border-l border-[var(--border)] pl-1 sticky right-0 bg-[var(--surface)]">
            {settings.enabledExportFormats.includes("csv") && (
              <button onClick={() => handleExport("csv")} className="p-1.5 hover:text-emerald-400 opacity-70 hover:opacity-100 transition-opacity" title="Export CSV"><Download className="w-3.5 h-3.5" /></button>
            )}
            {settings.enabledExportFormats.includes("json") && (
              <button onClick={() => handleExport("json")} className="p-1.5 hover:text-amber-400 opacity-70 hover:opacity-100 transition-opacity" title="Export JSON"><FileJson className="w-3.5 h-3.5" /></button>
            )}
            {settings.enabledExportFormats.includes("xml") && (
              <button onClick={() => handleExport("xml")} className="p-1.5 hover:text-blue-400 opacity-70 hover:opacity-100 transition-opacity" title="Export XML"><FileCode className="w-3.5 h-3.5" /></button>
            )}
            {settings.enabledExportFormats.includes("html") && (
              <button onClick={() => handleExport("html")} className="p-1.5 hover:text-orange-400 opacity-70 hover:opacity-100 transition-opacity" title="Export HTML"><Globe className="w-3.5 h-3.5" /></button>
            )}
            {settings.enabledExportFormats.includes("sql") && (
              <button onClick={() => handleExport("sql")} className="p-1.5 hover:text-cyan-400 opacity-70 hover:opacity-100 transition-opacity" title="Export SQL Insert"><Database className="w-3.5 h-3.5" /></button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const filteredHistoryMemo = useMemo(() => {
    if (!searchTerm) return getRecentQueries(30);
    return searchHistory(searchTerm);
  }, [searchTerm, history]);

  return (
    <div className="h-full flex flex-col bg-[var(--background)] text-xs relative overflow-hidden">
      <TabHeader />
      {isLoading && <div className="absolute top-9 left-0 right-0 z-[60] h-0.5 bg-[var(--color-accent)]/20 overflow-hidden"><div className="h-full bg-[var(--color-accent)] animate-shimmer" style={{ width: '40%' }} /></div>}

      {/* Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-[100] w-56 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl py-1.5 animate-in zoom-in-95 duration-100" 
          style={{ top: contextMenu.y, left: contextMenu.x }} 
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[9px] uppercase font-bold text-[var(--text-secondary)] tracking-widest mb-1 border-b border-[var(--border)] pb-1">Selection Actions</div>
          
          {contextMenu.col && (
            <button 
              onClick={() => { copyToClipboard(formatCellValue(contextMenu.row[contextMenu.col!])); setContextMenu(null); }} 
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

          <button 
            onClick={async () => { 
                try {
                    const text = await navigator.clipboard.readText();
                    if (text && contextMenu.col) {
                        const rowIdx = sortedResults.indexOf(contextMenu.row);
                        if (rowIdx >= 0) {
                            saveEdit(text, { rowIdx, col: contextMenu.col, value: text });
                        }
                    }
                } catch { /* clipboard permission */ }
                setContextMenu(null);
            }} 
            className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-indigo-500 hover:text-white flex items-center gap-2 transition-colors disabled:opacity-30"
            disabled={isReadOnly}
          >
            <CheckCircle className="w-3.5 h-3.5 opacity-50" /> Paste to Cell
          </button>

          <div className="my-1 border-t border-[var(--border)] opacity-50" />
          <div className="px-3 py-1 text-[9px] uppercase font-bold text-[var(--text-secondary)] tracking-widest mb-1 opacity-60">Record Details</div>

          <button onClick={() => { setSelectedRow({row: contextMenu.row, idx: sortedResults.indexOf(contextMenu.row)}); setIsEditingRow(false); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-indigo-500 hover:text-white flex items-center gap-2 transition-colors">
            <Maximize2 className="w-3.5 h-3.5" /> View Details
          </button>
          <button onClick={() => { setSelectedRow({row: contextMenu.row, idx: sortedResults.indexOf(contextMenu.row)}); setIsEditingRow(true); setSelectedRowEdits({}); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-indigo-500 hover:text-white flex items-center gap-2 transition-colors disabled:opacity-30" disabled={isReadOnly}>
            <RefreshCw className="w-3.5 h-3.5" /> Edit Record
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

      {/* Detail/Edit Overlay */}
      {selectedRow && (
        <div className="absolute inset-0 z-50 bg-black/40 flex items-center justify-end p-4 backdrop-blur-[1px]" onClick={() => setSelectedRow(null)}>
          <div className="w-96 h-full bg-[var(--surface)] shadow-2xl border-l border-[var(--border)] flex flex-col animate-in slide-in-from-right duration-200" onClick={e => e.stopPropagation()}>
            <div className="p-3 border-b flex items-center justify-between">
              <span className="font-bold flex items-center gap-2">{isEditingRow ? <><RefreshCw className="w-4 h-4 text-emerald-500" />Edit Record</> : <><Maximize2 className="w-4 h-4" />Row Details</>}</span>
              <div className="flex items-center gap-2">
                {!isEditingRow ? (
                  <button onClick={() => setIsEditingRow(true)} className="px-2 py-1 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 rounded text-xs font-medium">Edit</button>
                ) : (
                  <button onClick={async () => {
                    if (!onUpdateRow) return;
                    try {
                      const newRow = { ...selectedRow.row, ...selectedRowEdits };
                      await onUpdateRow(selectedRow.row, newRow);
                      setSelectedRow(null);
                      setSelectedRowEdits({});
                    } catch (e: any) {
                      confirmDialog.dialog({ title: "Update Failed", message: e.message || "Failed to update row data", type: "danger" });
                    }
                  }} className="px-3 py-1 bg-emerald-500 text-white hover:bg-emerald-600 rounded shadow-lg text-xs font-medium">Save Changes</button>
                )}
                <button onClick={() => setSelectedRow(null)} className="p-1 hover:bg-[var(--border)] rounded"><XCircle className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {columns.map(col => {
                const val = selectedRow.row[col];
                const editedVal = isEditingRow && selectedRowEdits.hasOwnProperty(col) ? selectedRowEdits[col] : val;
                const isChanged = isEditingRow && String(editedVal) !== String(val);
                
                return (
                <div key={col} className="space-y-1">
                  <div className="text-[10px] uppercase font-bold text-[var(--text-secondary)] flex items-center justify-between">
                    <div className="flex items-center gap-1.5">{getColumnIcon(col)}{col}</div>
                    {isChanged && <span className="text-[9px] text-emerald-400 bg-emerald-400/10 px-1 rounded">Edited</span>}
                  </div>
                  {!isEditingRow ? (
                    <div className="p-2 bg-[var(--background)] rounded border font-mono break-all select-text text-[13px]">{formatCellValue(val)}</div>
                  ) : (
                    <input 
                      type="text" 
                      value={editedVal === null ? "" : String(editedVal)}
                      onChange={e => setSelectedRowEdits(prev => ({ ...prev, [col]: e.target.value }))}
                      className={`w-full p-2 bg-[var(--background)] rounded border font-mono text-[13px] outline-none transition-colors ${isChanged ? "border-emerald-500/50 bg-emerald-500/5" : "focus:border-[var(--color-accent)]"}`}
                      placeholder={val === null ? "NULL" : ""}
                    />
                  )}
                </div>
              )})}
            </div>
          </div>
        </div>
      )}

      {activeTab === "messages" && (
        <div className="flex-1 overflow-auto p-4 font-mono select-text">
          {error ? (
            <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4 text-red-500">
               <div className="font-bold mb-2 flex items-center gap-2 text-sm"><XCircle className="w-4 h-4" /> Execution Error</div>
               <pre className="text-xs whitespace-pre-wrap leading-relaxed">{error}</pre>
            </div>
          ) : results.length > 0 || successMessage ? (
            <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-4 text-green-500">
               <div className="font-bold mb-1 flex items-center gap-2 text-sm"><CheckCircle className="w-4 h-4" /> Query Successful</div>
               <p className="text-xs">{successMessage || `${results.length} rows were retrieved in ${executionTime}ms.`}</p>
               <div className="mt-4 flex gap-4 text-[10px] opacity-60">
                 <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {executionTime}ms</span>
                 <span className="flex items-center gap-1"><Table2 className="w-3 h-3" /> {results.length} rows</span>
               </div>
            </div>
          ) : <div className="flex flex-col items-center justify-center h-full opacity-30 select-none"><AlertCircle className="w-8 h-8 mb-2" /><p>No messages to display</p></div>}
        </div>
      )}

      {activeTab === "optimizer" && optimizerData && (
        <div className="flex-1 min-h-0"><VisualOptimizer data={optimizerData} onApplyFix={onApplyFix} /></div>
      )}

      {activeTab === "result" && (
        results.length === 0 && displayResults.length === 0 && columns.length === 0 && (!multiResults || multiResults.length === 0) ? (
          <div className="flex-1 flex flex-col items-center justify-center opacity-30 select-none"><Table2 className="w-12 h-12 mb-2" /><p className="font-medium">Ready for your query</p><p className="text-[10px]">Execute SQL to see results here</p></div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Multi-statement results with tick/X indicators */}
            {multiResults && multiResults.length > 0 && (
              <div className="border-b border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
                <div className="flex items-center px-2 py-1.5 gap-2 min-w-max">
                  {multiResults.map((mr, idx) => {
                    const isSelected = idx === selectedMultiResultIdx;
                    const hasError = !!mr.error;
                    const hasRows = mr.rows && mr.rows.length > 0;
                    const queryPreview = mr.query.substring(0, 50).replace(/\s+/g, ' ').trim() + (mr.query.length > 50 ? '...' : '');
                    
                    return (
                      <button
                        key={idx}
                        onClick={() => setSelectedMultiResultIdx(idx)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[10px] font-mono transition-all border ${
                          isSelected 
                            ? 'bg-[var(--color-accent)]/10 border-[var(--color-accent)]/30 text-[var(--text-primary)]' 
                            : 'bg-[var(--surface)] border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
                        }`}
                        title={mr.query}
                      >
                        {hasError ? (
                          <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                        ) : (
                          <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                        )}
                        <span className="whitespace-nowrap max-w-[150px] truncate">{queryPreview}</span>
                        {results.some(r => r._isNew || r._isModified) && idx === 0 && (
                           <span className="text-[8px] bg-amber-500/20 text-amber-500 px-1 rounded font-bold animate-pulse">MODIFIED</span>
                        )}
                        {hasRows && <span className="text-[9px] opacity-60">({(mr.rows?.length || 0)})</span>}
                        {!hasError && mr.rowsAffected !== undefined && (
                          <span className="text-[9px] opacity-60">{mr.rowsAffected}</span>
                        )}
                        {hasError && <span className="text-red-400 text-[9px] max-w-[100px] truncate">Error</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {showColumnFilters && (
              <div className="flex bg-[var(--surface)] border-b border-[var(--border)] px-10 py-1 gap-1 overflow-x-auto no-scrollbar shrink-0">
                {(displayColumns || columns).map(col => (
                  <div key={col} style={{ minWidth: 150, width: 150 }} className="px-1">
                    <input type="text" placeholder={`Filter ${col}...`} value={columnFilters[col] || ""} onChange={(e) => setColumnFilters(prev => ({ ...prev, [col]: e.target.value }))} className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-[var(--color-accent)]" />
                  </div>
                ))}
              </div>
            )}
            <div className="flex-1 min-h-0 relative select-text outline-none" style={{ fontSize: `${settings.editorFontSize}px` }}>
              <GridView
                ref={gridRef}
                data={sortedResults}
                columns={displayColumns || columns}
                isProductionMode={isProductionMode}
                isReadOnly={isReadOnly}
                onCellEdited={(rowIdx, col, newValue) => { 
                  const edit = { rowIdx, col, value: newValue };
                  setEditingCell(edit); 
                  saveEdit(newValue, edit); 
                }}
                onCellContextMenu={(rowIdx, colIdx, event) => handleContextMenu(event, sortedResults[rowIdx], (displayColumns || columns)[colIdx])}
                gridSelection={gridSelection}
                onGridSelectionChange={setGridSelection}
                onHeaderClicked={(colIdx) => { const col = (displayColumns || columns)[colIdx]; if (sortCol === col) setSortDir(sortDir === "asc" ? "desc" : sortDir === "desc" ? null : "asc"); else { setSortCol(col); setSortDir("asc"); }}}
                columnWidths={columnWidths}
                onColumnResized={(col, width) => setColumnWidths(prev => ({ ...prev, [col]: width }))}
                onColumnMoved={(from, to) => { const newOrder = [...(displayColumns || columns)]; const [removed] = newOrder.splice(from, 1); newOrder.splice(to, 0, removed); setColumnOrder(newOrder); }}
              />
            </div>
            <div className="h-8 border-t flex items-center px-4 gap-4 text-[10px] text-[var(--text-secondary)] bg-[var(--surface)] shrink-0 select-none">
               <div className="flex items-center gap-1.5"><Table2 className="w-3 h-3 opacity-50" /> <b>{sortedResults.length}</b> rows</div>
               <div className="h-3 w-px bg-[var(--border)] opacity-20" />
               <div className="flex items-center gap-1.5"><Clock className="w-3 h-3 opacity-50" /> {executionTime}ms</div>
               <div className="flex-1" />
               {multiResults && multiResults.length > 0 && (
                 <span className="text-[var(--color-accent)] opacity-60">{multiResults.length} statements</span>
               )}
               {isProductionMode && <div className="text-amber-500 font-bold flex items-center gap-1.5"><Shield className="w-3 h-3 animate-pulse" /> MASKING ACTIVE</div>}
            </div>
          </div>
        )
      )}

      {activeTab === "history" && (
        <div className="flex-1 flex flex-col overflow-hidden select-none">
          <div className="p-2 border-b flex gap-2 items-center bg-[var(--surface)] shrink-0">
            <Search className="w-3.5 h-3.5 opacity-40 ml-1" />
            <input type="text" placeholder="Search history..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="flex-1 bg-transparent outline-none text-[10px]" />
            <button onClick={() => clearHistory()} className="text-rose-400 hover:bg-rose-400/10 px-2 py-1 rounded text-[9px] font-bold">CLEAR ALL</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
            {filteredHistoryMemo.map(item => (
              <div key={item.id} className="p-2 bg-[var(--surface)]/40 border border-[var(--border)] rounded text-[10.5px] hover:bg-[var(--surface)] hover:border-[var(--color-accent)]/30 transition-all group">
                <div className="flex items-center gap-2 mb-1">
                  <div className={item.success ? "text-green-500" : "text-rose-500"}>{item.success ? <CheckCircle className="w-3 h-3 shrink-0" /> : <XCircle className="w-3 h-3 shrink-0" />}</div>
                  <span className="font-bold opacity-80 shrink-0">{item.connectionName}</span>
                  <span className="text-[9px] opacity-40 shrink-0">{new Date(item.executedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                  <span className="text-[9px] opacity-40 shrink-0">{new Date(item.executedAt).toLocaleTimeString()}</span>
                  <div className="flex-1" />
                  <div className="opacity-0 group-hover:opacity-100 flex gap-2">
                     <button onClick={() => copyToClipboard(item.query)} className="text-indigo-400 hover:underline">Copy</button>
                     <button onClick={() => window.dispatchEvent(new CustomEvent("open-query-with-text", { detail: { query: item.query } }))} className="text-indigo-400 hover:underline">Restore</button>
                  </div>
                </div>
                <pre className="font-mono bg-[var(--background)]/50 p-1.5 rounded text-[9.5px] opacity-70 line-clamp-3 overflow-hidden border border-[var(--border)]/50">{item.query}</pre>
              </div>
            ))}
            {filteredHistoryMemo.length === 0 && (
              <div className="flex flex-col items-center justify-center h-32 opacity-30">
                <HistoryIcon className="w-8 h-8 mb-1" />
                <p className="text-[10px]">No history yet</p>
              </div>
            )}
          </div>
        </div>
      )}

      {showCopyToast && <div className="fixed bottom-12 right-12 bg-indigo-500 text-white px-4 py-2 rounded-xl shadow-2xl text-[11px] font-bold z-[200] animate-in bounce-in duration-300 flex items-center gap-2"><CheckCircle className="w-4 h-4" /> {toastMessage}</div>}

      {tableName && onAddRow && (
        <AddRowModal isOpen={showAddRowModal} onClose={() => setShowAddRowModal(false)} onSave={onAddRow} columns={columns} tableName={tableName} />
      )}
    </div>
  );
});
