import { useState, useMemo, useEffect, memo, useRef, useDeferredValue } from "react";
import { 
  AlertCircle, Table2, Hash, Type, Calendar, Binary, Code as CodeIcon, 
  Filter, Shield, Download, FileJson, XCircle, Search, Copy, 
  Trash2, Maximize2, Plus, RefreshCw, Zap, CheckCircle, Clock, ChevronDown, X,
  FileCode, Globe, Database, History as HistoryIcon, Image, File
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
import { FileType, toBlobUrl, revokeBlobUrl, formatFileSize, binaryToUtf8, isImageType, isPdfType, formatHexDump, formatHexCompact, toDataUrl } from "../../utils/binaryUtils";
import { compareGridValues } from "../../utils/columnTypes";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from "../ui/Menu";

// Shared accent-soft treatment for the binary-preview action pills (Save /
// Copy / Open / Download). Reused ~9× across the preview's view modes.
const binaryActionClass = "bg-[var(--accent-3)] text-[var(--accent-11)] hover:bg-[var(--accent-4)]";

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
  /**
   * Optional column name -> SQL type map for the current result set, used by
   * `GridView` to pick the date/time overlay editor by real type instead of
   * name substring (issue #51). Only populated when the result corresponds to
   * a known table; ad-hoc query results pass through as undefined and the
   * grid falls back to the legacy name heuristic.
   */
  columnTypes?: Record<string, string>;
  tableSchema?: {
    columns: { name: string; type: string; nullable: boolean; default: string | null }[];
    foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[];
  };
  loadFKOptions?: (fk: { refTable: string; refColumns: string[] }, search: string) => Promise<{ pk: any; label: string }[]>;
  onFkCellClick?: (fk: { refTable: string; refColumns: string[] }, fkValue: any) => void;
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
  successMessage, forcedColumns, columnTypes, tableSchema, loadFKOptions, onFkCellClick, optimizerData, onApplyFix, onSave, onDiscard,
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
  const [showColumnDropdown, setShowColumnDropdown] = useState(false);
  const [columnDropdownSearch, setColumnDropdownSearch] = useState("");
  const [columnDropdownIndex, setColumnDropdownIndex] = useState(0);
  const [showExportDropdown, setShowExportDropdown] = useState(false);
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
  const [toastMessage, setToastMessage] = useState("Copied to clipboard");
  const [selectedMultiResultIdx, setSelectedMultiResultIdx] = useState<number>(0);
  const [binaryPreview, setBinaryPreview] = useState<{
    col: string; bytes: number[]; fileType: FileType; blobUrl: string;
    viewMode: "preview" | "text" | "hex"; base64?: string;
  } | null>(null);
  
  const gridRef = useRef<GridViewRef>(null);
  const columnDropdownRef = useRef<HTMLDivElement>(null);
  const exportDropdownRef = useRef<HTMLDivElement>(null);
  const confirmDialog = useConfirmDialog();

  // Close dropdowns on outside click or Escape
  useEffect(() => {
    if (!showColumnDropdown && !showExportDropdown) return;
    const mouseHandler = (e: MouseEvent) => {
      if (showColumnDropdown && columnDropdownRef.current && !columnDropdownRef.current.contains(e.target as Node)) {
        setShowColumnDropdown(false);
        setColumnDropdownSearch("");
        setColumnDropdownIndex(0);
      }
      if (showExportDropdown && exportDropdownRef.current && !exportDropdownRef.current.contains(e.target as Node)) {
        setShowExportDropdown(false);
      }
    };
    // The column dropdown's own input also handles Escape so the input
    // doesn't have to refocus, but the Export dropdown has no focusable
    // child — this is the only way to close it via keyboard.
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showExportDropdown) {
        setShowExportDropdown(false);
      }
    };
    document.addEventListener("mousedown", mouseHandler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", mouseHandler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [showColumnDropdown, showExportDropdown]);

  const [debouncedColumnFilters, setDebouncedColumnFilters] = useState<Record<string, string>>({});

  // Multi-result handling (support for queries returning multiple result sets)
  const currentMultiResult = multiResults && multiResults.length > 0 ? multiResults[selectedMultiResultIdx] : null;
  const displayResults = currentMultiResult?.rows || results;
  const displayColumns = currentMultiResult?.columns || forcedColumns;

  // Debounce filter input changes
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedColumnFilters(columnFilters);
    }, 300);
    return () => clearTimeout(handler);
  }, [columnFilters]);

  // Column filters belong to the result set they were typed on. A filter
  // left over from a previous query must not silently hide rows of the next
  // one ("query runs but shows no records"). Reset on every fresh result set
  // — including multi-statement runs and result-tab switches. (Inline
  // row-edit refreshes also produce a new array and clear filters: the new
  // data may not match the old filter text, so clearing is the honest
  // choice — same as DataGrip.)
  const resultIdentityRef = useRef<{ results: unknown; multi: unknown; multiIdx: number } | null>(null);
  useEffect(() => {
    const prev = resultIdentityRef.current;
    resultIdentityRef.current = { results, multi: multiResults, multiIdx: selectedMultiResultIdx };
    if (prev && (prev.results !== results || prev.multi !== multiResults || prev.multiIdx !== selectedMultiResultIdx)) {
      setColumnFilters({});
      setDebouncedColumnFilters({});
    }
  }, [results, multiResults, selectedMultiResultIdx]);

  // Whether any column filter text is currently hiding (or able to hide) rows.
  const hasActiveColumnFilter = Object.values(debouncedColumnFilters).some((t) => !!t);

  // Compute sorted/filtered data — uses displayResults so multi-statement
  // and row-editing overrides are respected.
  const baseRows = displayResults.length > 0 ? displayResults : results;
  const _sortedResults = useMemo(() => {
    let finalData = baseRows;
    if (Object.keys(debouncedColumnFilters).length > 0) {
      finalData = finalData.filter(row => {
        return Object.entries(debouncedColumnFilters).every(([col, filterText]) => {
          if (!filterText) return true;
          const val = row[col];
          if (val === null || val === undefined) return false;
          return String(val).toLowerCase().includes(filterText.toLowerCase());
        });
      });
    }
    if (sortCol && sortDir) {
      finalData = [...finalData].sort((a, b) => {
        const va = a[sortCol];
        const vb = b[sortCol];
        if (va === vb) return 0;
        if (va == null) return sortDir === "asc" ? -1 : 1;
        if (vb == null) return sortDir === "asc" ? 1 : -1;
        // Numeric-aware: exact-digit BIGINT strings (#41) sort by value via
        // BigInt, never lossy Number() coercion; text keeps localeCompare.
        const comparison = compareGridValues(va, vb);
        return sortDir === "asc" ? comparison : -comparison;
      });
    }
    return finalData;
  }, [baseRows, debouncedColumnFilters, sortCol, sortDir]);

  // Defer grid updates so the UI stays responsive on large result sets
  const sortedResults = useDeferredValue(_sortedResults);


  // Tab management
  useEffect(() => {
    // suppressTabSwitch prevents auto-switching when save/delete refreshes results
    if (!suppressTabSwitch) {
      if (error) setActiveTab("messages");
      else if (results.length > 0 || (multiResults && multiResults.length > 0)) setActiveTab("result");
      else if (successMessage) setActiveTab("messages");
    }

    // Reset local sorting when actual data content changes (likely new query)
    setSortCol(null);
    setSortDir(null);
    setSelectedMultiResultIdx(0);
  }, [error, successMessage, results, multiResults, suppressTabSwitch]);

  // If the active tab loses its underlying content (e.g. user clears history,
  // or saved-then-discarded a row set), fall back to Messages so we never sit
  // on a tab whose chrome we just hid. #95
  useEffect(() => {
    if (activeTab === "result" && results.length === 0 && (!multiResults || multiResults.length === 0)) {
      setActiveTab("messages");
    } else if (activeTab === "history" && history.length === 0) {
      setActiveTab("messages");
    }
  }, [activeTab, results, multiResults, history]);

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
    const handleScrollToRow = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (gridRef.current && detail?.index !== undefined) {
        setTimeout(() => {
          gridRef.current?.scrollToRow(detail.index);
          if (detail?.focus) gridRef.current?.focus();
        }, 100);
      }
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("switch-results-tab", handleSwitchTab);
    window.addEventListener("grid-scroll-to-bottom", handleScrollBottom);
    window.addEventListener("grid-scroll-to-row", handleScrollToRow);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("switch-results-tab", handleSwitchTab);
      window.removeEventListener("grid-scroll-to-bottom", handleScrollBottom);
      window.removeEventListener("grid-scroll-to-row", handleScrollToRow);
    };
  }, []);

  // Keyboard shortcut for Save (Ctrl+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
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

  // Keyboard shortcut to close binary preview on Escape
  useEffect(() => {
    if (!binaryPreview) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setBinaryPreview(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [binaryPreview]);

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
      const colsMatch = newCols.length === columnOrder.length
        && newCols.every((c, i) => c === columnOrder[i]);
      if (!colsMatch) {
        setColumnOrder(newCols);
      }
    } else {
      setColumnOrder([]);
    }
  }, [results]);

  // Selection sync & focus
  useEffect(() => {
    if (gridSelection.current?.cell) {
      setSelectedIndex(gridSelection.current.cell[1]);
    } else {
      setSelectedIndex(-1);
    }
  }, [gridSelection.current]);

  useEffect(() => {
    return () => {
      if (binaryPreview) revokeBlobUrl(binaryPreview.blobUrl);
    };
  }, [binaryPreview]);

  // Auto-close binary preview when new query results arrive
  useEffect(() => {
    setBinaryPreview(null);
  }, [results]);

  const handleBinaryCellClick = (_rowIdx: number, col: string, bytes: number[], fileType: FileType, base64?: string) => {
    if (binaryPreview) revokeBlobUrl(binaryPreview.blobUrl);
    const blobUrl = toBlobUrl(bytes, fileType.mime);
    setBinaryPreview({ col, bytes, fileType, blobUrl, viewMode: "preview", base64 });
  };

  const handleBinaryDownload = async () => {
    if (!binaryPreview) return;
    const { col, bytes, fileType } = binaryPreview;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: `${col}.${fileType.extension}`,
        filters: [{ name: fileType.label, extensions: [fileType.extension] }]
      });
      if (!path) return;
      await writeFile(path, new Uint8Array(bytes));
      setToastMessage("Download complete");
      setShowCopyToast(true);
      setTimeout(() => setShowCopyToast(false), 2000);
    } catch (e: any) {
      confirmDialog.dialog({ title: "Download Failed", message: e.message, type: "danger" });
    }
  };

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
      _isModified: !oldRow._isNew, // Only mark as modified if it's not a brand new row
      // Snapshot the pre-edit values so handleSave can build a WHERE clause
      // that matches the original row, preventing 0-row-affect updates.
      _original: oldRow._isNew ? undefined : (oldRow._original || oldRow)
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
    if (typeof val === "number") return <Hash className="w-2.5 h-2.5 text-[var(--accent-11)]" />;
    if (typeof val === "boolean") return <Binary className="w-2.5 h-2.5 text-[var(--success-11)]" />;
    if (typeof val === "string" && (val.includes("-") || val.includes("/")) && !isNaN(Date.parse(val))) return <Calendar className="w-2.5 h-2.5 text-[var(--warning-11)]" />;
    if (typeof val === "object") return <CodeIcon className="w-2.5 h-2.5 text-[var(--accent-11)]" />;
    return <Type className="w-2.5 h-2.5 opacity-40" />;
  };

  const handleContextMenu = (pos: { clientX: number; clientY: number }, row: any, col?: string) => {
    // Viewport coords — the Menu renders `position: fixed`.
    setContextMenu({ x: pos.clientX, y: pos.clientY, row, col });
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

  const hasResults = results.length > 0 || (multiResults && multiResults.length > 0);
  const hasHistory = history.length > 0;

  const TabHeader = () => (
    <div className="h-9 flex items-center gap-2 px-3 bg-[var(--surface-panel)] border-b border-[var(--neutral-6)] text-xs shrink-0 select-none">
      <button onClick={() => setActiveTab("messages")} className={`h-full flex items-center px-1 border-b transition-all cursor-pointer ${activeTab === "messages" ? (error ? "text-[var(--danger-11)] border-[var(--danger-11)]" : "text-[var(--accent-11)] border-[var(--accent-9)]") : "text-[var(--neutral-11)] border-transparent hover:text-[var(--neutral-12)]"}`}>
        <AlertCircle className="w-3.5 h-3.5 mr-1" /> Messages
      </button>
      {hasResults && (
        <button onClick={() => setActiveTab("result")} className={`h-full flex items-center px-1 border-b transition-all cursor-pointer ${activeTab === "result" ? "text-[var(--accent-11)] border-[var(--accent-9)]" : "text-[var(--neutral-11)] border-transparent hover:text-[var(--neutral-12)]"}`}>
          <Table2 className="w-3.5 h-3.5 mr-1" /> Results {results.length > 0 && <span className="ml-1 opacity-60">({results.length})</span>}
        </button>
      )}
      {hasHistory && (
        <button onClick={() => setActiveTab("history")} className={`h-full flex items-center px-1 border-b transition-all cursor-pointer ${activeTab === "history" ? "text-[var(--accent-11)] border-[var(--accent-9)]" : "text-[var(--neutral-11)] border-transparent hover:text-[var(--neutral-12)]"}`}>
          <HistoryIcon className="w-3.5 h-3.5 mr-1" /> History
        </button>
      )}
      {optimizerData && (
        <button onClick={() => setActiveTab("optimizer")} className={`h-full flex items-center px-1 border-b transition-all cursor-pointer ${activeTab === "optimizer" ? "text-[var(--accent-11)] border-[var(--accent-9)]" : "text-[var(--neutral-11)] border-transparent hover:text-[var(--neutral-12)]"}`}>
          <Zap className="w-3.5 h-3.5 mr-1" /> Optimizer
        </button>
      )}
      <div className="flex-1" />
      {activeTab === "result" && results.length > 0 && (
        <div className="flex items-center gap-1">
          <button onClick={() => setIsProductionMode(!isProductionMode)} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-bold border cursor-pointer ${isProductionMode ? "bg-[var(--danger-3)] border-[var(--danger-6)] text-[var(--danger-11)]" : "bg-[var(--accent-3)] border-[var(--accent-6)] text-[var(--accent-11)]"}`}>
            <Shield className="w-3 h-3" /> {isProductionMode ? "MASK ON" : "MASK OFF"}
          </button>
          <button onClick={() => setShowColumnFilters(!showColumnFilters)} className={`flex items-center gap-1 px-1.5 py-0.5 rounded border cursor-pointer ${showColumnFilters ? "bg-[var(--accent-3)] border-[var(--accent-6)] text-[var(--accent-11)]" : "border-transparent text-[var(--neutral-11)] hover:bg-[var(--neutral-4)]"}`}>
             <Filter className="w-3.5 h-3.5" /> <span className="text-[8px] font-bold">FILTER</span>
          </button>
          <div className="relative" ref={columnDropdownRef}>
            <button
              onClick={() => { setShowColumnDropdown(!showColumnDropdown); setColumnDropdownSearch(""); setColumnDropdownIndex(0); }}
              className="flex items-center gap-1 px-2 py-1 rounded border border-[var(--neutral-6)] bg-[var(--surface-base)] text-[10px] hover:border-[var(--accent-8)] transition-colors cursor-pointer"
              title="Jump to column"
            >
              <Search className="w-3 h-3 opacity-50" />
              <span className="max-w-[100px] truncate">Jump to column</span>
              <ChevronDown className="w-3 h-3 opacity-50" />
            </button>
            {showColumnDropdown && (() => {
              // Must use the same active column list the grid renders with —
              // in multi-result mode `displayColumns` and `columns` diverge,
              // and indexing into the wrong array jumps to the wrong column.
              const activeColumns = displayColumns || columns;
              const filteredColumns = activeColumns.filter(c =>
                c.toLowerCase().includes(columnDropdownSearch.toLowerCase())
              );
              const clampedIndex = Math.min(columnDropdownIndex, Math.max(filteredColumns.length - 1, 0));
              const jumpTo = (name: string) => {
                const idx = activeColumns.indexOf(name);
                if (idx < 0) return;
                setGridSelection({
                  columns: CompactSelection.empty(),
                  rows: CompactSelection.empty(),
                  current: { cell: [idx, 0], range: { x: idx, y: 0, width: 1, height: 1 }, rangeStack: [] }
                });
                setTimeout(() => { gridRef.current?.scrollToColumn(idx); gridRef.current?.focus(); }, 10);
                setShowColumnDropdown(false);
                setColumnDropdownSearch("");
                setColumnDropdownIndex(0);
              };
              return (
              <div className="absolute right-0 top-full mt-1 w-56 bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-lg shadow-2xl z-50 overflow-hidden">
                <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--neutral-6)]">
                  <Search className="w-3 h-3 opacity-40 shrink-0" />
                  <input
                    type="text"
                    placeholder="Filter columns..."
                    value={columnDropdownSearch}
                    onChange={(e) => { setColumnDropdownSearch(e.target.value); setColumnDropdownIndex(0); }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setShowColumnDropdown(false);
                        setColumnDropdownSearch("");
                        setColumnDropdownIndex(0);
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setColumnDropdownIndex(i => Math.min(i + 1, filteredColumns.length - 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setColumnDropdownIndex(i => Math.max(i - 1, 0));
                      } else if (e.key === "Enter" && filteredColumns[clampedIndex]) {
                        e.preventDefault();
                        jumpTo(filteredColumns[clampedIndex]);
                      }
                    }}
                    className="flex-1 bg-transparent border-none outline-none text-xs text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)]"
                    autoFocus
                  />
                  {columnDropdownSearch && (
                    <button onClick={() => { setColumnDropdownSearch(""); setColumnDropdownIndex(0); }} className="opacity-50 hover:opacity-100 cursor-pointer">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {filteredColumns.map((c, i) => (
                    <button
                      key={c}
                      ref={el => {
                        if (i === clampedIndex && el) {
                          el.scrollIntoView({ block: "nearest" });
                        }
                      }}
                      onMouseEnter={() => setColumnDropdownIndex(i)}
                      onClick={() => jumpTo(c)}
                      className={clsx(
                        "w-full px-3 py-1.5 text-left text-xs transition-colors truncate cursor-pointer",
                        i === clampedIndex
                          ? "bg-[var(--accent-4)] text-[var(--neutral-12)]"
                          : "hover:bg-[var(--accent-3)]"
                      )}
                    >
                      {c}
                    </button>
                  ))}
                  {filteredColumns.length === 0 && (
                    <div className="px-3 py-2 text-xs opacity-40 text-center">No matching columns</div>
                  )}
                </div>
              </div>
              );
            })()}
          </div>
          {onRefresh && (
            <Button
              size="xs"
              variant="ghost"
              onClick={onRefresh}
              leftIcon={<RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />}
            >
              <span className="text-[8px] font-bold">REFRESH</span>
            </Button>
          )}
          <div className="flex items-center gap-1 ml-1 border-l border-[var(--neutral-6)] pl-1">
            <IconButton
              size="sm"
              onClick={() => onAddRow && onAddRow({}, true)}
              disabled={results.some(r => r._isNew || r._isModified)}
              className="border border-[var(--success-6)] text-[var(--success-11)] hover:bg-[var(--success-3)] disabled:opacity-30"
              label="Add New Local Blank Row (Save later)"
              icon={<Plus />}
            />
            <IconButton
              size="sm"
              disabled={(selectedIndex < 0 && gridSelection.rows.length === 0) || results.some(r => r._isNew || r._isModified)}
              onClick={async () => {
                if (onAddRow) {
                  const rowIdx = selectedIndex >= 0 ? selectedIndex : gridSelection.rows.toArray()[0];
                  if (rowIdx !== undefined) {
                    const { id, _isNew, _isModified, ...newRow } = sortedResults[rowIdx];
                    await onAddRow(newRow, true);
                  }
                }
              }}
              className="border border-[var(--accent-6)] text-[var(--accent-11)] hover:bg-[var(--accent-3)] disabled:opacity-30"
              label="Duplicate Row Locally (Save later)"
              icon={<Copy />}
            />
            <IconButton
              size="sm"
              disabled={selectedIndex < 0 && gridSelection.rows.length === 0}
              onClick={async () => {
                const rowIdx = selectedIndex >= 0 ? selectedIndex : gridSelection.rows.toArray()[0];
                if (onDeleteRow && rowIdx !== undefined) {
                  const confirmed = await confirmDialog.confirm({ title: "Delete Row", message: "Delete this row permanently?", type: "danger" });
                  if (confirmed) await onDeleteRow(sortedResults[rowIdx]);
                }
              }}
              className="border border-[var(--danger-6)] text-[var(--danger-11)] hover:bg-[var(--danger-3)] disabled:opacity-30"
              label="Remove Row"
              icon={<Trash2 />}
            />
            <span className="relative inline-flex">
              <IconButton
                size="sm"
                className={clsx(
                  "border",
                  results.some(r => r._isNew || r._isModified)
                    ? "border-[var(--success-9)] bg-[var(--success-3)] text-[var(--success-11)] hover:bg-[var(--success-6)]/30 shadow-[0_0_8px_rgba(70,167,88,0.3)]"
                    : "border-[var(--accent-6)] text-[var(--accent-11)] hover:bg-[var(--accent-3)]"
                )}
                title={(() => {
                  const n = results.filter(r => r._isNew || r._isModified).length;
                  return n > 0
                    ? `Save ${n} pending change${n === 1 ? "" : "s"} (Ctrl+S)`
                    : "Save All Pending Changes (Ctrl+S)";
                })()}
                label="Save All Pending Changes (Ctrl+S)"
                onClick={async () => {
                  if (onSave) {
                    await onSave(results);
                  } else if (onRefresh) {
                    onRefresh();
                  }
                }}
                icon={<CheckCircle className={clsx(results.some(r => r._isNew || r._isModified) && "animate-pulse")} />}
              />
              {(() => {
                const n = results.filter(r => r._isNew || r._isModified).length;
                if (n === 0) return null;
                return (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-[var(--success-9)] text-[9px] font-bold text-white flex items-center justify-center leading-none pointer-events-none">
                    {n > 99 ? "99+" : n}
                  </span>
                );
              })()}
            </span>
            {results.some(r => r._isNew || r._isModified) && (
              <IconButton
                size="sm"
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  const confirmed = await confirmDialog.confirm({ title: "Discard Changes", message: "Discard all unsaved local changes? This cannot be undone.", type: "warning" });
                  if (confirmed && onDiscard) await onDiscard();
                }}
                className="border border-[var(--danger-6)] text-[var(--danger-11)] hover:bg-[var(--danger-3)]"
                label="Discard all local changes"
                icon={<XCircle />}
              />
            )}
          </div>
          <div className="relative ml-1 border-l border-[var(--neutral-6)] pl-1" ref={exportDropdownRef}>
            <IconButton
              size="sm"
              onClick={() => setShowExportDropdown(!showExportDropdown)}
              label="Export data"
              icon={<Download />}
            />
            {showExportDropdown && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-lg shadow-2xl z-50 overflow-hidden">
                <div className="px-3 py-1.5 text-[9px] uppercase font-bold text-[var(--neutral-11)] tracking-widest border-b border-[var(--neutral-6)]">Export As</div>
                {settings.enabledExportFormats.includes("csv") && (
                  <button onClick={() => { handleExport("csv"); setShowExportDropdown(false); }} className="w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--accent-3)] flex items-center gap-2 transition-colors cursor-pointer">
                    <Download className="w-3.5 h-3.5 text-[var(--neutral-11)]" /> CSV
                  </button>
                )}
                {settings.enabledExportFormats.includes("json") && (
                  <button onClick={() => { handleExport("json"); setShowExportDropdown(false); }} className="w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--accent-3)] flex items-center gap-2 transition-colors cursor-pointer">
                    <FileJson className="w-3.5 h-3.5 text-[var(--neutral-11)]" /> JSON
                  </button>
                )}
                {settings.enabledExportFormats.includes("xml") && (
                  <button onClick={() => { handleExport("xml"); setShowExportDropdown(false); }} className="w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--accent-3)] flex items-center gap-2 transition-colors cursor-pointer">
                    <FileCode className="w-3.5 h-3.5 text-[var(--neutral-11)]" /> XML
                  </button>
                )}
                {settings.enabledExportFormats.includes("html") && (
                  <button onClick={() => { handleExport("html"); setShowExportDropdown(false); }} className="w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--accent-3)] flex items-center gap-2 transition-colors cursor-pointer">
                    <Globe className="w-3.5 h-3.5 text-[var(--neutral-11)]" /> HTML
                  </button>
                )}
                {settings.enabledExportFormats.includes("sql") && (
                  <button onClick={() => { handleExport("sql"); setShowExportDropdown(false); }} className="w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--accent-3)] flex items-center gap-2 transition-colors cursor-pointer">
                    <Database className="w-3.5 h-3.5 text-[var(--neutral-11)]" /> SQL INSERT
                  </button>
                )}
              </div>
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
    <div className="h-full flex flex-col bg-[var(--surface-base)] text-xs relative overflow-hidden">
      <TabHeader />
      {isLoading && <div className="absolute top-9 left-0 right-0 z-[60] h-0.5 bg-[var(--accent-9)]/20 overflow-hidden"><div className="h-full bg-[var(--accent-9)] animate-shimmer" style={{ width: '40%' }} /></div>}

      {/* Context Menu */}
      {contextMenu && (
        <Menu x={contextMenu.x} y={contextMenu.y}>
          <MenuLabel bordered>Selection Actions</MenuLabel>

          {contextMenu.col && (
            <MenuItem icon={<Copy className="w-3.5 h-3.5" />} onClick={() => { copyToClipboard(formatCellValue(contextMenu.row[contextMenu.col!])); setContextMenu(null); }}>
              Copy Cell
            </MenuItem>
          )}

          <MenuItem icon={<FileJson className="w-3.5 h-3.5" />} onClick={() => { copyToClipboard(JSON.stringify(contextMenu.row, null, 2)); setContextMenu(null); }}>
            Copy Row as JSON
          </MenuItem>

          <MenuItem
            icon={<CheckCircle className="w-3.5 h-3.5 opacity-50" />}
            disabled={isReadOnly}
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
          >
            Paste to Cell
          </MenuItem>

          <MenuSeparator />
          <MenuLabel subtle>Record Details</MenuLabel>

          <MenuItem icon={<Maximize2 className="w-3.5 h-3.5" />} onClick={() => { setSelectedRow({row: contextMenu.row, idx: sortedResults.indexOf(contextMenu.row)}); setIsEditingRow(false); setContextMenu(null); }}>
            View Details
          </MenuItem>
          <MenuItem icon={<RefreshCw className="w-3.5 h-3.5" />} disabled={isReadOnly} onClick={() => { setSelectedRow({row: contextMenu.row, idx: sortedResults.indexOf(contextMenu.row)}); setIsEditingRow(true); setSelectedRowEdits({}); setContextMenu(null); }}>
            Edit Record
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

      {/* Detail/Edit Overlay */}
      {selectedRow && (
        <div className="absolute inset-0 z-50 bg-black/40 flex items-center justify-end p-4 backdrop-blur-[1px]" onClick={() => setSelectedRow(null)}>
          <div className="w-96 h-full bg-[var(--surface-overlay)] shadow-2xl border-l border-[var(--neutral-6)] flex flex-col animate-in slide-in-from-right duration-200" onClick={e => e.stopPropagation()}>
            <div className="p-3 border-b border-[var(--neutral-6)] flex items-center justify-between">
              <span className="font-bold flex items-center gap-2">{isEditingRow ? <><RefreshCw className="w-4 h-4 text-[var(--success-11)]" />Edit Record</> : <><Maximize2 className="w-4 h-4" />Row Details</>}</span>
              <div className="flex items-center gap-2">
                {!isEditingRow ? (
                  <Button size="xs" className="bg-[var(--accent-3)] text-[var(--accent-11)] hover:bg-[var(--accent-4)]" onClick={() => setIsEditingRow(true)}>Edit</Button>
                ) : (
                  <Button size="xs" variant="primary" onClick={async () => {
                    if (!onUpdateRow) return;
                    try {
                      const newRow = { ...selectedRow.row, ...selectedRowEdits };
                      await onUpdateRow(selectedRow.row, newRow);
                      setSelectedRow(null);
                      setSelectedRowEdits({});
                    } catch (e: any) {
                      confirmDialog.dialog({ title: "Update Failed", message: e.message || "Failed to update row data", type: "danger" });
                    }
                  }}>Save Changes</Button>
                )}
                <IconButton size="sm" label="Close" onClick={() => setSelectedRow(null)} icon={<XCircle />} />
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {columns.map(col => {
                const val = selectedRow.row[col];
                const editedVal = isEditingRow && selectedRowEdits.hasOwnProperty(col) ? selectedRowEdits[col] : val;
                const isChanged = isEditingRow && String(editedVal) !== String(val);
                
                return (
                <div key={col} className="space-y-1">
                  <div className="text-[10px] uppercase font-bold text-[var(--neutral-11)] flex items-center justify-between">
                    <div className="flex items-center gap-1.5">{getColumnIcon(col)}{col}</div>
                    {isChanged && <span className="text-[9px] text-[var(--success-11)] bg-[var(--success-3)] px-1 rounded">Edited</span>}
                  </div>
                  {!isEditingRow ? (
                    <div className="p-2 bg-[var(--surface-base)] rounded border border-[var(--neutral-6)] font-mono break-all select-text text-[13px]">{formatCellValue(val)}</div>
                  ) : (
                    <Input
                      inputSize="sm"
                      value={editedVal === null ? "" : String(editedVal)}
                      onChange={e => setSelectedRowEdits(prev => ({ ...prev, [col]: e.target.value }))}
                      className={`font-mono text-[13px] ${isChanged ? "bg-[var(--success-3)]" : ""}`}
                      placeholder={val === null ? "NULL" : ""}
                    />
                  )}
                </div>
              )})}
            </div>
          </div>
        </div>
      )}

      {/* Binary Preview Overlay */}
      {binaryPreview && (() => {
        const { col, bytes, fileType, blobUrl, viewMode, base64 } = binaryPreview;
        const utf8 = binaryToUtf8(bytes);
        const isImage = isImageType(fileType);
        const isPdf = isPdfType(fileType);
        const isText = utf8 !== null && utf8.length > 0;
        const hexDump = formatHexDump(bytes, 4096);
        const hexCompact = formatHexCompact(bytes, 16384);
        const dataUrl = isImage ? toDataUrl(bytes, fileType.mime) : "";

        const setView = (v: "preview" | "text" | "hex") => setBinaryPreview(prev => prev ? { ...prev, viewMode: v } : null);

        return (
          <div className="absolute inset-0 z-50 bg-black/40 flex items-center justify-end p-4 backdrop-blur-[1px]" onClick={(e) => { if (e.button === 0) setBinaryPreview(null); }} onContextMenu={(e) => e.stopPropagation()}>
            <div className="w-[560px] h-full bg-[var(--surface-overlay)] shadow-2xl border-l border-[var(--neutral-6)] flex flex-col animate-in slide-in-from-right duration-200" onClick={e => e.stopPropagation()}>
              <div className="p-3 border-b border-[var(--neutral-6)] flex items-center gap-3 shrink-0">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {isImage ? <Image className="w-4 h-4 text-[var(--accent-11)] shrink-0" /> : isPdf ? <File className="w-4 h-4 text-[var(--danger-11)] shrink-0" /> : <Binary className="w-4 h-4 text-[var(--warning-11)] shrink-0" />}
                  <span className="font-bold truncate text-sm">{col}</span>
                  <span className="text-[10px] text-[var(--neutral-11)] bg-[var(--surface-base)] px-1.5 py-0.5 rounded shrink-0">{fileType.label}</span>
                  <span className="text-[10px] opacity-50 shrink-0">{formatFileSize(bytes.length)}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0 bg-[var(--surface-base)] rounded-lg p-0.5">
                  <button onClick={() => setView("preview")} className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${viewMode === "preview" ? "bg-[var(--accent-9)] text-white" : "text-[var(--neutral-11)] hover:text-[var(--neutral-12)]"}`}>Preview</button>
                  <button onClick={() => setView("text")} className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${viewMode === "text" ? "bg-[var(--accent-9)] text-white" : "text-[var(--neutral-11)] hover:text-[var(--neutral-12)]"}`}>Text</button>
                  <button onClick={() => setView("hex")} className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${viewMode === "hex" ? "bg-[var(--accent-9)] text-white" : "text-[var(--neutral-11)] hover:text-[var(--neutral-12)]"}`}>Hex</button>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" className={binaryActionClass} onClick={handleBinaryDownload} leftIcon={<Download className="w-3 h-3" />}>Save</Button>
                  <IconButton size="sm" label="Close" onClick={() => setBinaryPreview(null)} icon={<XCircle />} />
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4">
                {viewMode === "hex" ? (
                  <div className="space-y-4">
                    <div>
                      <div className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-widest flex items-center justify-between mb-1">
                        <span>Hex Dump{bytes.length > 4096 ? ` (first 4096 of ${bytes.length.toLocaleString()} bytes)` : ""}</span>
                        <span className="text-[9px] opacity-50">{bytes.length.toLocaleString()} total bytes</span>
                      </div>
                      <pre className="font-mono text-[10px] leading-relaxed whitespace-pre select-all bg-[var(--surface-base)] p-3 rounded-lg border border-[var(--neutral-6)] text-[var(--neutral-11)] overflow-x-auto">{hexDump}{bytes.length > 4096 ? `\n\u2026 ${(bytes.length - 4096).toLocaleString()} more bytes` : ""}</pre>
                    </div>
                    <div className="flex justify-center">
                      <Button size="sm" className={binaryActionClass} onClick={() => { navigator.clipboard.writeText(hexCompact); setToastMessage("Hex copied"); setShowCopyToast(true); setTimeout(() => setShowCopyToast(false), 2000); }} leftIcon={<Copy className="w-3 h-3" />}>Copy Hex</Button>
                    </div>
                  </div>
                ) : viewMode === "text" ? (
                  <div className="space-y-4">
                    {base64 && (
                      <div>
                        <div className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-widest mb-1">Base64 String</div>
                        <pre className="font-mono text-[10px] whitespace-pre-wrap break-all select-all leading-relaxed bg-[var(--surface-base)] p-3 rounded-lg border border-[var(--neutral-6)] text-[var(--neutral-11)] max-h-48 overflow-y-auto">{base64}</pre>
                      </div>
                    )}
                    {utf8 !== null ? (
                      <div>
                        <div className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-widest mb-1">Decoded Text (UTF-8){utf8.length > 8192 ? ` — first 8192 chars` : ""}</div>
                        <pre className="font-mono text-[11px] whitespace-pre-wrap break-all select-all leading-relaxed bg-[var(--surface-base)] p-4 rounded-lg border border-[var(--neutral-6)]">{utf8.slice(0, 8192)}{utf8.length > 8192 ? `\n\u2026 ${(utf8.length - 8192).toLocaleString()} more chars` : ""}</pre>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <div className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-widest mb-1">Raw Bytes{base64 ? " (decoded from Base64)" : ""}</div>
                          <pre className="font-mono text-[10px] leading-relaxed whitespace-pre select-all bg-[var(--surface-base)] p-3 rounded-lg border border-[var(--neutral-6)] text-[var(--neutral-11)]">{bytes.slice(0, 32).map(b => b.toString(16).padStart(2, "0")).join(" ")}{bytes.length > 32 ? `  \u2026 ${(bytes.length - 32).toLocaleString()} more bytes` : ""}</pre>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-widest mb-1">ASCII Signature</div>
                          <pre className="font-mono text-[10px] whitespace-pre select-all bg-[var(--surface-base)] p-3 rounded-lg border border-[var(--neutral-6)]">{bytes.slice(0, 64).map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : ".").join("")}{bytes.length > 64 ? ` \u2026 ${(bytes.length - 64).toLocaleString()} unused bytes` : ""}</pre>
                        </div>
                        <p className="text-[10px] text-[var(--neutral-11)] opacity-50 text-center">Not valid UTF-8 text. Switch to Preview or Hex tab for full inspection.</p>
                      </div>
                    )}
                    <div className="flex gap-2 justify-center">
                      {base64 && (
                        <Button size="sm" className={binaryActionClass} onClick={() => { navigator.clipboard.writeText(base64); setToastMessage("Base64 copied"); setShowCopyToast(true); setTimeout(() => setShowCopyToast(false), 2000); }} leftIcon={<Copy className="w-3 h-3" />}>Copy Base64</Button>
                      )}
                      {utf8 !== null && (
                        <Button size="sm" className={binaryActionClass} onClick={() => { navigator.clipboard.writeText(utf8); setToastMessage("Text copied"); setShowCopyToast(true); setTimeout(() => setShowCopyToast(false), 2000); }} leftIcon={<Copy className="w-3 h-3" />}>Copy Text</Button>
                      )}
                    </div>
                  </div>
                ) : isImage ? (
                  <div className="flex flex-col h-full">
                    <div className="flex-1 flex items-center justify-center min-h-0">
                      <img src={blobUrl} alt={col} className="max-w-full max-h-full object-contain rounded-lg shadow-lg" />
                    </div>
                    <div className="flex gap-2 justify-center py-3 shrink-0">
                      <Button size="sm" className={binaryActionClass} onClick={handleBinaryDownload} leftIcon={<Download className="w-3 h-3" />}>Save</Button>
                      <Button size="sm" className={binaryActionClass} onClick={() => { navigator.clipboard.writeText(dataUrl); setToastMessage("Image URL copied"); setShowCopyToast(true); setTimeout(() => setShowCopyToast(false), 2000); }} leftIcon={<Copy className="w-3 h-3" />}>Copy</Button>
                      <Button size="sm" className={binaryActionClass} onClick={() => { if (bytes.length > 5 * 1024 * 1024) { setToastMessage("Image too large for inline open — use Save instead"); setShowCopyToast(true); setTimeout(() => setShowCopyToast(false), 2000); } else { window.open(dataUrl, "_blank"); } }} leftIcon={<Maximize2 className="w-3 h-3" />}>Open</Button>
                    </div>
                  </div>
                ) : isPdf ? (
                  <div className="flex flex-col items-center justify-center h-full gap-4">
                    <File className="w-16 h-16 text-[var(--danger-11)] opacity-40" />
                    <p className="text-sm opacity-60">PDF documents cannot be previewed inline.</p>
                    <Button className="bg-[var(--danger-3)] text-[var(--danger-11)] hover:bg-[var(--danger-6)]/40" onClick={handleBinaryDownload} leftIcon={<Download className="w-4 h-4" />}>Download PDF ({formatFileSize(bytes.length)})</Button>
                  </div>
                ) : isText ? (
                  <pre className="font-mono text-[11px] whitespace-pre-wrap break-all select-text leading-relaxed bg-[var(--surface-base)] p-4 rounded-lg border border-[var(--neutral-6)]">{utf8!.length > 32768 ? utf8!.slice(0, 32768) + `\n\n\u2026 ${(utf8!.length - 32768).toLocaleString()} more characters (use Text tab or download for full content)` : utf8}</pre>
                ) : (
                  <div className="space-y-4">
                    <div className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-widest">Hex Preview (first 256 bytes)</div>
                    <pre className="font-mono text-[10px] whitespace-pre-wrap break-all select-all leading-relaxed bg-[var(--surface-base)] p-3 rounded-lg border border-[var(--neutral-6)] text-[var(--neutral-11)]">{bytes.slice(0, 256).map(b => b.toString(16).padStart(2, "0")).join(" ")}</pre>
                    {utf8 && (
                      <>
                        <div className="text-[10px] uppercase font-bold text-[var(--neutral-11)] tracking-widest">Text Preview</div>
                        <pre className="font-mono text-[11px] whitespace-pre-wrap break-all select-text leading-relaxed bg-[var(--surface-base)] p-4 rounded-lg border border-[var(--neutral-6)]">{utf8.slice(0, 4096)}{utf8.length > 4096 ? "\n\u2026" : ""}</pre>
                      </>
                    )}
                    <div className="flex justify-center pt-2">
                      <Button className={binaryActionClass} onClick={handleBinaryDownload} leftIcon={<Download className="w-4 h-4" />}>Download ({formatFileSize(bytes.length)})</Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {activeTab === "messages" && (
        <div className="flex-1 overflow-auto p-4 font-mono select-text">
          {error ? (
            <div className="bg-[var(--danger-3)]/40 border border-[var(--danger-6)] rounded-lg p-4 text-[var(--danger-11)]">
               <div className="font-bold mb-2 flex items-center gap-2 text-sm"><XCircle className="w-4 h-4" /> Execution Error</div>
               <pre className="text-xs whitespace-pre-wrap leading-relaxed">{error}</pre>
            </div>
          ) : results.length > 0 || successMessage ? (
            <div className="bg-[var(--success-3)]/40 border border-[var(--success-6)] rounded-lg p-4 text-[var(--success-11)]">
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
              <div className="border-b border-[var(--neutral-6)] bg-[var(--surface-panel)] overflow-x-auto">
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
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[10px] font-mono transition-all border cursor-pointer ${
                          isSelected
                            ? 'bg-[var(--accent-3)] border-[var(--accent-6)] text-[var(--neutral-12)]'
                            : 'bg-[var(--surface-panel)] border-[var(--neutral-6)] text-[var(--neutral-11)] hover:bg-[var(--neutral-4)]'
                        }`}
                        title={mr.query}
                      >
                        {hasError ? (
                          <XCircle className="w-3.5 h-3.5 text-[var(--danger-11)] shrink-0" />
                        ) : (
                          <CheckCircle className="w-3.5 h-3.5 text-[var(--success-11)] shrink-0" />
                        )}
                        <span className="whitespace-nowrap max-w-[150px] truncate">{queryPreview}</span>
                        {results.some(r => r._isNew || r._isModified) && idx === 0 && (
                           <span className="text-[8px] bg-[var(--warning-3)] text-[var(--warning-11)] px-1 rounded font-bold animate-pulse">MODIFIED</span>
                        )}
                        {hasRows && <span className="text-[9px] opacity-60">({(mr.rows?.length || 0)})</span>}
                        {!hasError && mr.rowsAffected !== undefined && (
                          <span className="text-[9px] opacity-60">{mr.rowsAffected}</span>
                        )}
                        {hasError && <span className="text-[var(--danger-11)] text-[9px] max-w-[100px] truncate">Error</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {showColumnFilters && (
              <div className="flex bg-[var(--surface-panel)] border-b border-[var(--neutral-6)] px-10 py-1 gap-1 overflow-x-auto no-scrollbar shrink-0">
                {(displayColumns || columns).map(col => (
                  <div key={col} style={{ minWidth: 150, width: 150 }} className="px-1">
                    <input type="text" placeholder={`Filter ${col}...`} value={columnFilters[col] || ""} onChange={(e) => setColumnFilters(prev => ({ ...prev, [col]: e.target.value }))} className="w-full bg-[var(--surface-base)] border border-[var(--neutral-6)] rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-[var(--accent-8)]" />
                  </div>
                ))}
              </div>
            )}
            <div className="flex-1 min-h-0 relative select-text outline-none" style={{ fontSize: `${settings.editorFontSize}px` }}>
              <GridView
                ref={gridRef}
                data={sortedResults}
                columns={displayColumns || columns}
                columnTypes={columnTypes}
                tableSchema={tableSchema}
                loadFKOptions={loadFKOptions}
                onFkCellClick={onFkCellClick}
                isProductionMode={isProductionMode}
                isReadOnly={isReadOnly}
                onBinaryCellClick={handleBinaryCellClick}
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
            <div className="h-8 border-t flex items-center px-4 gap-4 text-[10px] text-[var(--neutral-11)] bg-[var(--surface-panel)] shrink-0 select-none">
               <div className="flex items-center gap-1.5" title={hasActiveColumnFilter ? "Column filter active — clear the Filter inputs above the grid to show all rows" : undefined}><Table2 className="w-3 h-3 opacity-50" /> <b>{sortedResults.length}</b>{hasActiveColumnFilter && sortedResults.length !== baseRows.length ? ` of ${baseRows.length}` : ""} rows{hasActiveColumnFilter ? (<span className="flex items-center gap-1 text-[var(--accent-11)]"><Filter className="w-3 h-3" />filtered</span>) : null}</div>
               <div className="h-3 w-px bg-[var(--neutral-6)] opacity-20" />
               <div className="flex items-center gap-1.5"><Clock className="w-3 h-3 opacity-50" /> {executionTime}ms</div>
               <div className="flex-1" />
               {multiResults && multiResults.length > 0 && (
                 <span className="text-[var(--accent-11)] opacity-60">{multiResults.length} statements</span>
               )}
               {isProductionMode && <div className="text-[var(--warning-11)] font-bold flex items-center gap-1.5"><Shield className="w-3 h-3 animate-pulse" /> MASKING ACTIVE</div>}
            </div>
          </div>
        )
      )}

      {activeTab === "history" && (
        <div className="flex-1 flex flex-col overflow-hidden select-none">
          <div className="p-2 border-b border-[var(--neutral-6)] flex gap-2 items-center bg-[var(--surface-panel)] shrink-0">
            <Search className="w-3.5 h-3.5 opacity-40 ml-1" />
            <input type="text" placeholder="Search history..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="flex-1 bg-transparent outline-none text-[10px] text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)]" />
            <Button size="xs" variant="destructive" onClick={() => clearHistory()} className="font-bold">CLEAR ALL</Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
            {filteredHistoryMemo.map(item => (
              <div key={item.id} className="p-2 bg-[var(--surface-panel)]/40 border border-[var(--neutral-6)] rounded text-[10.5px] hover:bg-[var(--surface-panel)] hover:border-[var(--accent-6)] transition-all group">
                <div className="flex items-center gap-2 mb-1">
                  <div className={item.success ? "text-[var(--success-11)]" : "text-[var(--danger-11)]"}>{item.success ? <CheckCircle className="w-3 h-3 shrink-0" /> : <XCircle className="w-3 h-3 shrink-0" />}</div>
                  <span className="font-bold opacity-80 shrink-0">{item.connectionName}</span>
                  <span className="text-[9px] opacity-40 shrink-0">{new Date(item.executedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                  <span className="text-[9px] opacity-40 shrink-0">{new Date(item.executedAt).toLocaleTimeString()}</span>
                  <div className="flex-1" />
                  <div className="opacity-0 group-hover:opacity-100 flex gap-2">
                     <button onClick={() => copyToClipboard(item.query)} className="text-[var(--accent-11)] hover:underline cursor-pointer">Copy</button>
                     <button onClick={() => window.dispatchEvent(new CustomEvent("open-query-with-text", { detail: { query: item.query } }))} className="text-[var(--accent-11)] hover:underline cursor-pointer">Restore</button>
                  </div>
                </div>
                <pre className="font-mono bg-[var(--surface-base)]/50 p-1.5 rounded text-[9.5px] opacity-70 line-clamp-3 overflow-hidden border border-[var(--neutral-6)]/50">{item.query}</pre>
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

      {showCopyToast && <div className="fixed bottom-12 right-12 bg-[var(--accent-9)] text-white px-4 py-2 rounded-xl shadow-2xl text-[11px] font-bold z-[200] animate-in bounce-in duration-300 flex items-center gap-2"><CheckCircle className="w-4 h-4" /> {toastMessage}</div>}

      {tableName && onAddRow && (
        <AddRowModal
          isOpen={showAddRowModal}
          onClose={() => setShowAddRowModal(false)}
          onSave={(row) => onAddRow!(row, false)}
          columns={tableSchema?.columns || columns.map((name: string) => ({ name, type: "text", nullable: true, default: null }))}
          foreignKeys={tableSchema?.foreignKeys}
          loadFKOptions={loadFKOptions}
          tableName={tableName}
        />
      )}
    </div>
  );
});
