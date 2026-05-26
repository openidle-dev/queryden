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
import { isDateTimeType } from "../../utils/columnTypes";

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
  /**
   * Optional map of column name -> SQL type (e.g. "TIMESTAMP", "TEXT").
   * Used to decide which cells render the date/time overlay editor. When a
   * column is missing from this map (e.g. ad-hoc query results without a
   * table-level schema), we fall back to the column-name heuristic — see
   * `isDateTimeType` and issue #51.
   */
  columnTypes?: Record<string, string>;
}

export interface GridViewRef {
  scrollToColumn: (colIdx: number) => void;
  scrollToRow: (rowIdx: number) => void;
  focus: () => void;
}

// Glide Data Grid renders to a <canvas>, so it can't read CSS `var()` — the
// theme needs literal color strings. These mirror the design-system tokens in
// src/styles/globals.css (Radix Slate/Cyan). Keep them in sync if that scale
// changes; the grid otherwise drifts away from the rest of the app's chrome
// (which is what happened with the pre-design-system slate/#06b6d4 palette).
type GridMode = "dark" | "light" | "blue";
type GridPalette = (typeof GRID_PALETTES)[GridMode];

// The Glide grid renders to <canvas> and can't read CSS var()s, so each theme's
// palette is literal hex mirrored from the globals.css tokens (per-line comments
// map each back to its variable). Keep these in sync with globals.css.
const GRID_PALETTES = {
  dark: {
    cellBg: "#111113",        // --neutral-1
    headerBg: "#18191b",      // --neutral-2
    headerHoverBg: "#212225", // --neutral-3
    headerFocusBg: "#272a2d", // --neutral-4
    border: "#363a3f",        // --neutral-6
    text: "#edeef0",          // --neutral-12
    textMuted: "#b0b4ba",     // --neutral-11
    textFaint: "#696e77",     // --neutral-9
    accent: "#00a2c7",        // --accent-9
    accentText: "#4ccce6",    // --accent-11
    accentTint: "rgba(0, 162, 199, 0.2)",
    numPos: "#63c174",        // --success-11
    numNeg: "#ff6369",        // --danger-11
    newTint: "rgba(70, 167, 88, 0.15)",   // --success-9
    modTint: "rgba(255, 178, 36, 0.15)",  // --warning-9
  },
  light: {
    cellBg: "#fcfcfd",        // --neutral-1
    headerBg: "#f9f9fb",      // --neutral-2
    headerHoverBg: "#eff0f3", // --neutral-3
    headerFocusBg: "#e7e8ec", // --neutral-4
    border: "#d8d9e0",        // --neutral-6
    text: "#1c2024",          // --neutral-12
    textMuted: "#60646c",     // --neutral-11
    textFaint: "#8b8d98",     // --neutral-9
    accent: "#00a2c7",        // --accent-9
    accentText: "#107d98",    // --accent-11
    accentTint: "rgba(0, 162, 199, 0.12)",
    numPos: "#2a7e3b",        // --success-11
    numNeg: "#c62a2f",        // --danger-11
    newTint: "rgba(70, 167, 88, 0.1)",    // --success-9
    modTint: "rgba(255, 178, 36, 0.12)",  // --warning-9
  },
  blue: {
    cellBg: "#0b1020",        // --neutral-1
    headerBg: "#0f1526",      // --neutral-2
    headerHoverBg: "#161d2e", // --neutral-3
    headerFocusBg: "#1b2336", // --neutral-4
    border: "#232c40",        // --neutral-6
    text: "#e6e9f2",          // --neutral-12
    textMuted: "#9aa3bd",     // --neutral-11
    textFaint: "#5b6580",     // --neutral-9
    accent: "#3b82f6",        // --accent-9
    accentText: "#93b8fc",    // --accent-11
    accentTint: "rgba(59, 130, 246, 0.2)",
    numPos: "#63c174",        // --success-11
    numNeg: "#ff6369",        // --danger-11
    newTint: "rgba(70, 167, 88, 0.15)",   // --success-9
    modTint: "rgba(255, 178, 36, 0.15)",  // --warning-9
  },
} as const;

const getPalette = (mode: GridMode): GridPalette => GRID_PALETTES[mode];

const getTheme = (p: GridPalette): Partial<Theme> => ({
  accentColor: p.accent,
  accentLight: p.accentTint,
  textDark: p.text,
  textMedium: p.textMuted,
  textLight: p.textFaint,
  bgCell: p.cellBg,
  bgHeader: p.headerBg,
  bgHeaderHasFocus: p.headerFocusBg,
  bgHeaderHovered: p.headerHoverBg,
  headerFontStyle: "bold 12px var(--font-sans)",
  baseFontStyle: "13px 'JetBrains Mono', 'Fira Code', monospace",
  textHeader: p.text,
  lineHeight: 1.4,
  fontFamily: "var(--font-sans)",
  // Added for overlay editor consistency
  bgSearchResult: p.accentTint,
  drilldownBorder: p.border,
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
  isReadOnly = false,
  columnTypes
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
  const gridMode: GridMode =
    theme === "blue"
      ? "blue"
      : theme === "light" || (theme === "system" && !window.matchMedia("(prefers-color-scheme: dark)").matches)
        ? "light"
        : "dark";
  const palette = useMemo(() => getPalette(gridMode), [gridMode]);
  const gridTheme = useMemo(() => getTheme(palette), [palette]);

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

  // Issue #51: prefer the SQL type from schema introspection (when available);
  // fall back to the legacy name heuristic when no type is known (ad-hoc query
  // results). See `isDateTimeType`.
  const dateColumns = useMemo(() => new Set(
    columns.filter(col => isDateTimeType(columnTypes?.[col], col))
  ), [columns, columnTypes]);

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
      themeOverride.bgCell = palette.newTint;
    } else if (isModified) {
      themeOverride.bgCell = palette.modTint;
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
          textDark: palette.textFaint, // Greyed out NULL
        }
      };
    }

    // Common text color for data rows
    themeOverride.textDark = palette.text;

    if (dateColumns.has(col)) {
      return {
        kind: GridCellKind.Text,
        data: String(val),
        displayData: String(val),
        allowOverlay: canEdit,
        readonly: !canEdit,
        themeOverride: {
          ...themeOverride,
          textDark: palette.accentText,
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
          textDark: val > 0 ? palette.numPos : (val < 0 ? palette.numNeg : palette.textMuted)
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
            textDark: palette.accentText,
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
  }, [data, columns, isProductionMode, palette, isReadOnly, sensitiveColumns, dateColumns, binaryColumns]);

  return (
    <div className="w-full h-full relative overflow-hidden bg-[var(--surface-base)]">
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
                 <div className="w-full h-full bg-[var(--surface-base)] p-1 flex items-center">
                   <input 
                     type="datetime-local" 
                     value={dateVal}
                     onChange={e => onChange({ ...value, kind: GridCellKind.Text, data: e.target.value.replace("T", " "), displayData: e.target.value.replace("T", " ") })}
                     onKeyDown={e => { if (e.key === "Enter") onFinishedEditing(); }}
                     onBlur={() => onFinishedEditing()}
                     autoFocus
                     className="w-full bg-transparent text-[var(--neutral-12)] outline-none border-none text-[13px] font-mono"
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
