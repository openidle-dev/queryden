import React, { useMemo, useCallback } from "react";
import DataEditor, { 
  GridCell, 
  GridCellKind, 
  GridColumn, 
  Theme,
  EditableGridCell,
  Item,
  BooleanCell
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useSettings } from "../../store/settingsStore";
import { toNormalizedBytes, detectFileType, formatFileSize, detectBinaryColumns, FileType } from "../../utils/binaryUtils";

interface GridViewProps {
  data: any[];
  columns: string[];
  onCellEdited?: (rowIdx: number, col: string, newValue: any) => void;
  onRowClicked?: (rowIdx: number) => void;
  onRowDoubleClicked?: (rowIdx: number) => void;
  onHeaderClicked?: (colIdx: number) => void;
  onCellContextMenu?: (rowIdx: number, colIdx: number, event: React.MouseEvent) => void;
  onBinaryCellClick?: (rowIdx: number, col: string, bytes: number[], fileType: FileType, base64?: string) => void;
  isProductionMode?: boolean;
  rowMarkers?: "none" | "number" | "checkbox" | "both";
  gridSelection?: any;
  onGridSelectionChange?: (selection: any) => void;
  onColumnResized?: (col: string, newWidth: number) => void;
  onColumnMoved?: (fromIdx: number, toIdx: number) => void;
  columnWidths?: Record<string, number>;
  isReadOnly?: boolean;
}

export interface GridViewRef {
  scrollToColumn: (colIdx: number) => void;
  scrollToRow: (rowIdx: number) => void;
  focus: () => void;
}

const getTheme = (isDark: boolean): Partial<Theme> => ({
  accentColor: "#06b6d4",
  accentLight: isDark ? "rgba(6, 182, 212, 0.2)" : "rgba(6, 182, 212, 0.1)",
  textDark: isDark ? "#f8fafc" : "#0f172a", // Main text color (white in dark, black in light)
  textMedium: isDark ? "#94a3b8" : "#64748b",
  textLight: isDark ? "#64748b" : "#94a3b8",
  bgCell: isDark ? "#0f172a" : "#ffffff",
  bgHeader: isDark ? "#1e293b" : "#f8fafc",
  bgHeaderHasFocus: isDark ? "#334155" : "#e2e8f0",
  bgHeaderHovered: isDark ? "#2d3748" : "#f1f5f9",
  headerFontStyle: "bold 12px var(--font-sans)",
  baseFontStyle: "13px 'JetBrains Mono', 'Fira Code', monospace",
  textHeader: isDark ? "#f1f5f9" : "#0f172a",
  lineHeight: 1.4,
  fontFamily: "var(--font-sans)",
  // Added for overlay editor consistency
  bgSearchResult: isDark ? "rgba(6, 182, 212, 0.2)" : "rgba(6, 182, 212, 0.1)",
  drilldownBorder: isDark ? "#334155" : "#e2e8f0",
  editorFontSize: "13px",
});


const maskValue = (val: string) => {
  if (!val) return val;
  if (val.includes("@")) return "******@***.***";
  if (val.length > 10) return val.substring(0, 3) + "********";
  return "********";
};

export const GridView = React.forwardRef<GridViewRef, GridViewProps>(({
  data,
  columns,
  onCellEdited,
  onCellContextMenu,
  onBinaryCellClick,
  isProductionMode = false,
  rowMarkers = "both",
  gridSelection,
  onGridSelectionChange,
  onColumnResized,
  onColumnMoved,
  columnWidths,
  onHeaderClicked,
  isReadOnly = false
}, ref) => {
  const editorRef = React.useRef<any>(null);

  React.useImperativeHandle(ref, () => ({
    scrollToColumn: (colIdx: number) => {
      editorRef.current?.scrollTo(colIdx, 0, "start", "nearest");
    },
    scrollToRow: (rowIdx: number) => {
      editorRef.current?.scrollTo(0, rowIdx, "nearest", "start");
    },
    focus: () => {
      editorRef.current?.focus();
    }
  }));

  const { theme } = useSettings();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const gridTheme = useMemo(() => getTheme(isDark), [isDark]);

  const gridColumns = useMemo<GridColumn[]>(() => 
    columns.map(col => ({ 
      title: col, 
      id: col, 
      width: columnWidths?.[col] || 150, 
      hasMenu: false 
    })), 
  [columns, columnWidths]);

  // Pre-compute column metadata so getCellContent avoids per-cell string ops
  const sensitiveColumns = useMemo(() => new Set(
    columns.filter(col => {
      const low = col.toLowerCase();
      return low.includes("email") || low.includes("password") || low.includes("token") ||
        low.includes("secret") || low.includes("key") || low.includes("phone") ||
        low.includes("ssn") || low.includes("credit_card") || low.includes("card_number") ||
        low.includes("cvv") || low.includes("address") || low.includes("dob") ||
        low.includes("date_of_birth") || low.includes("social_security");
    })
  ), [columns]);

  const dateColumns = useMemo(() => new Set(
    columns.filter(col => {
      const low = col.toLowerCase();
      return low.includes("date") || low.includes("time");
    })
  ), [columns]);

  const binaryColumns = useMemo(() => detectBinaryColumns(data, columns), [data, columns]);

  const getCellContent = useCallback((cell: Item): GridCell => {
    const [colIdx, rowIdx] = cell;
    const col = columns[colIdx];
    const row = data[rowIdx];
    let val = row ? row[col] : undefined;

    const isSensitive = isProductionMode && typeof val === "string" && sensitiveColumns.has(col);

    // A cell is editable when the grid is not read-only.
    // With editOnType=true, clicking a cell and typing opens the overlay immediately.
    const canEdit = !isReadOnly;

    if (isSensitive) {
      val = maskValue(val);
    }

    const isNew = data[rowIdx]?._isNew;
    const isModified = data[rowIdx]?._isModified;

    // Build theme override safely to avoid undefined color errors
    const themeOverride: any = {};
    
    if (isNew) {
      themeOverride.bgCell = isDark ? "rgba(16, 185, 129, 0.15)" : "rgba(16, 185, 129, 0.1)";
    } else if (isModified) {
      themeOverride.bgCell = isDark ? "rgba(245, 158, 11, 0.15)" : "rgba(245, 158, 11, 0.1)";
    }

    if (val === null || val === undefined) {
      return {
        kind: GridCellKind.Text,
        data: "",
        displayData: "NULL",
        allowOverlay: canEdit,
        readonly: !canEdit,
        themeOverride: {
          ...themeOverride,
          textDark: isDark ? "#4b5563" : "#94a3b8", // Greyed out NULL
        }
      };
    }

    // Common text color for data rows
    themeOverride.textDark = isDark ? "#f8fafc" : "#0f172a";

    if (dateColumns.has(col)) {
      return {
        kind: GridCellKind.Text,
        data: String(val),
        displayData: String(val),
        allowOverlay: canEdit,
        readonly: !canEdit,
        themeOverride: {
          ...themeOverride,
          textDark: isDark ? "#38bdf8" : "#0284c7",
          baseFontStyle: "italic 13px 'JetBrains Mono', monospace"
        }
      };
    }

    if (typeof val === "number") {
      return {
        kind: GridCellKind.Number,
        data: val,
        displayData: val.toString(),
        allowOverlay: canEdit,
        readonly: !canEdit,
        themeOverride: {
          ...themeOverride,
          textDark: val > 0 ? (isDark ? "#4ade80" : "#16a34a") : (val < 0 ? (isDark ? "#f87171" : "#dc2626") : (isDark ? "#94a3b8" : "#64748b"))
        }
      };
    }

    // Handle common boolean representations (bool, string, number)
    const isBool = typeof val === "boolean" || 
                   (typeof val === "string" && (val.toLowerCase() === "true" || val.toLowerCase() === "false" || val === "t" || val === "f")) ||
                   (typeof val === "number" && (val === 1 || val === 0));

    if (isBool) {
      const boolVal = typeof val === "boolean" ? val : (typeof val === "string" ? (val.toLowerCase() === "true" || val === "t") : val === 1);
      return {
        kind: GridCellKind.Boolean,
        data: boolVal,
        allowOverlay: canEdit,
        readonly: !canEdit,
        themeOverride: themeOverride
      } as BooleanCell;
    }

    // Binary / BLOB / BYTEA — show a readable label instead of raw byte arrays
    if (binaryColumns.has(col)) {
      const bytes = toNormalizedBytes(val);
      if (bytes !== null) {
        const ft = detectFileType(bytes);
        const size = formatFileSize(bytes.length);
        return {
          kind: GridCellKind.Text,
          data: `__binary__${col}`,
          displayData: `[${ft.label} \u00B7 ${size}]`,
          allowOverlay: false,
          readonly: true,
          themeOverride: {
            ...themeOverride,
            textDark: isDark ? "#818cf8" : "#4f46e5",
          }
        };
      }
    }

    if (typeof val === "object" && val !== null) {
      const str = JSON.stringify(val);
      return {
        kind: GridCellKind.Text,
        data: str,
        displayData: str.length > 50 ? str.substring(0, 50) + "..." : str,
        allowOverlay: canEdit,
        readonly: !canEdit,
        themeOverride
      };
    }

    return {
      kind: GridCellKind.Text,
      data: String(val),
      displayData: String(val),
      allowOverlay: canEdit,
      readonly: !canEdit,
      themeOverride
    };
  }, [data, columns, isProductionMode, isDark, isReadOnly, sensitiveColumns, dateColumns, binaryColumns]);

  return (
    <div className="w-full h-full relative overflow-hidden bg-[var(--background)]">
      <DataEditor
        width="100%"
        height="100%"
        columns={gridColumns}
        rows={data.length}
        getCellContent={getCellContent}
        onCellEdited={(cell, newValue) => {
          if (isReadOnly) return;
          if (onCellEdited) {
            const [colIdx, rowIdx] = cell;
            onCellEdited(rowIdx, columns[colIdx], (newValue as EditableGridCell).data);
          }
        }}
        onCellContextMenu={(cell, event) => {
          if (onCellContextMenu) {
            const [colIdx, rowIdx] = cell;
            onCellContextMenu(rowIdx, colIdx, event as unknown as React.MouseEvent);
          }
        }}
        onCellClicked={(cell) => {
          if (!onBinaryCellClick) return;
          const [colIdx, rowIdx] = cell;
          const col = columns[colIdx];
          const val = data[rowIdx]?.[col];
          if (val == null || !binaryColumns.has(col)) return;
          const bytes = toNormalizedBytes(val);
          if (bytes !== null) {
            onBinaryCellClick(rowIdx, col, bytes, detectFileType(bytes), typeof val === "string" ? val : undefined);
          }
        }}
        gridSelection={gridSelection}
        onGridSelectionChange={onGridSelectionChange}
        theme={gridTheme}
        rowMarkers={rowMarkers}
        rowHeight={34}
        smoothScrollX={true}
        smoothScrollY={true}
        getCellsForSelection={true}
        editOnType={true}
        onPaste={true}
        onColumnResize={(col, newWidth) => {
          if (onColumnResized) onColumnResized(col.id as string, newWidth);
        }}
        onHeaderClicked={(colIdx) => {
          if (onHeaderClicked) onHeaderClicked(colIdx);
        }}
        onColumnMoved={(from, to) => {
          if (onColumnMoved) onColumnMoved(from, to);
        }}
        provideEditor={(cell) => {
          // Detect date/time cells by their specific styling applied in getCellContent
          if (cell.kind === GridCellKind.Text && cell.themeOverride?.baseFontStyle?.includes("italic")) {
             return (props) => {
               const { value, onChange, onFinishedEditing } = props;
               if (value.kind !== GridCellKind.Text) return null;

               // Try to normalize date for datetime-local input (YYYY-MM-DDTHH:mm)
               let dateVal = String(value.data || "");
               if (dateVal && !dateVal.includes("T") && dateVal.includes("-")) {
                 dateVal = dateVal.replace(" ", "T").substring(0, 16);
               }
               return (
                 <div className="w-full h-full bg-[var(--background)] p-1 flex items-center">
                   <input 
                     type="datetime-local" 
                     value={dateVal}
                     onChange={e => onChange({ ...value, kind: GridCellKind.Text, data: e.target.value.replace("T", " "), displayData: e.target.value.replace("T", " ") })}
                     onKeyDown={e => { if (e.key === "Enter") onFinishedEditing(); }}
                     onBlur={() => onFinishedEditing()}
                     autoFocus
                     className="w-full bg-transparent text-[var(--text-primary)] outline-none border-none text-[13px] font-mono"
                   />
                 </div>
               );
             };
          }
          return undefined;
        }}
        ref={editorRef}
      />
    </div>
  );
});
