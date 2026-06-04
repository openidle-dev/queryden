import React, { useMemo, useCallback, useState } from "react";
import DataEditor, { 
  GridCell, 
  GridCellKind, 
  GridColumn, 
  Theme,
  EditableGridCell,
  Item,
  BooleanCell,
  CustomCell,
  CustomRenderer,
  DrawArgs,
  measureTextCached,
  getMiddleCenterBias,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useSettings } from "../../store/settingsStore";
import { toNormalizedBytes, detectFileType, formatFileSize, detectBinaryColumns, FileType } from "../../utils/binaryUtils";
import { isDateTimeType } from "../../utils/columnTypes";

interface FkCellData {
  __fk__: true;
  value: string;
  fkCol: string;
  fk: { refTable: string; refColumns: string[] };
  fkValue: any;
  onNavigate: () => void;
}

const ICON_W = 12;
const ICON_PAD = 6;

const fkCellRenderer: CustomRenderer<CustomCell<FkCellData>> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is CustomCell<FkCellData> =>
    cell.kind === GridCellKind.Custom &&
    typeof cell.data === "object" &&
    cell.data !== null &&
    "__fk__" in cell.data,
  needsHover: false,
  needsHoverPosition: true,
  draw: (args: DrawArgs<CustomCell<FkCellData>>, cell: CustomCell<FkCellData>) => {
    const { ctx, theme, rect, hoverX, hoverY, overrideCursor } = args;
    const txt = cell.data.value;
    const s = ICON_W;

    ctx.font = theme.baseFontFull;
    const bias = getMiddleCenterBias(ctx, theme);
    const padding = theme.cellHorizontalPadding;

    // Draw FK text in link color
    ctx.fillStyle = theme.linkColor;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(txt, rect.x + padding, rect.y + rect.height / 2 + bias);

    // Blue external link icon on the right
    const iconX = rect.x + rect.width - s - ICON_PAD;
    const iconY = rect.y + (rect.height - s) / 2;

    const localIconX = rect.width - s - ICON_PAD;
    const localIconY = (rect.height - s) / 2;

    const isHoveringIcon =
      hoverX !== undefined && hoverY !== undefined &&
      hoverX >= localIconX && hoverX <= localIconX + s &&
      hoverY >= localIconY && hoverY <= localIconY + s;

    if (isHoveringIcon && overrideCursor) {
      overrideCursor("pointer");
    }

    const iconColor = isHoveringIcon ? theme.accentColor : theme.linkColor;
    ctx.strokeStyle = iconColor;
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Draw the box (open at top-right)
    ctx.beginPath();
    ctx.moveTo(iconX + s * 0.6, iconY + s * 0.15);
    ctx.lineTo(iconX + s * 0.15, iconY + s * 0.15);
    ctx.lineTo(iconX + s * 0.15, iconY + s * 0.85);
    ctx.lineTo(iconX + s * 0.85, iconY + s * 0.85);
    ctx.lineTo(iconX + s * 0.85, iconY + s * 0.4);
    ctx.stroke();

    // Draw diagonal arrow pointing up-right
    ctx.beginPath();
    ctx.moveTo(iconX + s * 0.4, iconY + s * 0.6);
    ctx.lineTo(iconX + s * 0.85, iconY + s * 0.15);
    ctx.stroke();

    // Arrow tip
    ctx.beginPath();
    ctx.moveTo(iconX + s * 0.65, iconY + s * 0.15);
    ctx.lineTo(iconX + s * 0.85, iconY + s * 0.15);
    ctx.lineTo(iconX + s * 0.85, iconY + s * 0.35);
    ctx.stroke();
  },
  onClick: (args) => {
    const { bounds, posX, posY, preventDefault } = args;
    // posX/posY are cell-relative (localEventX = ev.clientX - bounds.x);
    // bounds.width/height are the cell dimensions.
    const s = ICON_W;
    const iconX = bounds.width - s - ICON_PAD;
    const iconY = (bounds.height - s) / 2;
    if (posX >= iconX && posX <= iconX + s && posY >= iconY && posY <= iconY + s) {
      args.cell.data.onNavigate();
      preventDefault?.();
    }
    return undefined;
  },
  measure: (ctx, cell, theme) =>
    measureTextCached(cell.data.value, ctx, theme.baseFontFull).width +
    theme.cellHorizontalPadding * 2 + ICON_W + ICON_PAD,
  provideEditor: () => undefined,
};

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
  columnTypes?: Record<string, string>;
  /**
   * Full table schema for FK-aware inline editing. When present, FK columns
   * render a searchable dropdown of referenced PK values.
   */
  tableSchema?: {
    columns: { name: string; type: string; nullable: boolean; default: string | null }[];
    foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[];
  };
  loadFKOptions?: (fk: { refTable: string; refColumns: string[] }, search: string) => Promise<{ pk: any; label: string }[]>;
  onFkCellClick?: (fk: { refTable: string; refColumns: string[] }, fkValue: any) => void;
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
  linkColor: p.accentText,
});


const maskValue = (val: string) => {
  if (!val) return val;
  if (val.includes("@")) return "******@***.***";
  if (val.length > 10) return val.substring(0, 3) + "********";
  return "********";
};

function inferFromColumnName(col: string): string {
  const colLower = col.toLowerCase();
  if (colLower === "id" || colLower.endsWith("_id")) return "int";
  if (colLower.includes("date") || colLower.includes("time") || colLower === "created_at" || colLower === "updated_at" || colLower.includes("timestamp")) return "timestamp";
  if (colLower.includes("name") || colLower.includes("title") || colLower.includes("email") || colLower.includes("phone") || colLower.includes("address") || colLower.includes("username")) return "varchar";
  if (colLower.includes("description") || colLower.includes("comment") || colLower.includes("note") || colLower.includes("content") || colLower.includes("message") || colLower.includes("body")) return "text";
  if (colLower.includes("price") || colLower.includes("amount") || colLower.includes("cost") || colLower.includes("total") || colLower.includes("salary") || colLower.includes("balance")) return "float";
  if (colLower.includes("age") || colLower.includes("count") || colLower.includes("quantity") || colLower.includes("score") || colLower.includes("year")) return "int";
  if (colLower.includes("active") || colLower.includes("enabled") || colLower.includes("is_") || colLower.includes("has_") || colLower === "deleted") return "bool";
  if (colLower.includes("json") || colLower.includes("data") || colLower.includes("metadata") || colLower.includes("properties") || colLower.includes("attributes")) return "jsonb";
  if (colLower.includes("image") || colLower.includes("photo") || colLower.includes("avatar") || colLower.includes("file") || colLower.includes("binary") || colLower.includes("blob")) return "bytea";
  if (colLower.includes("uuid") || colLower.includes("guid")) return "uuid";
  return "varchar";
}

function inferColumnType(data: any[], col: string): string | undefined {
  if (!col) return undefined;
  let samples = 0;
  const MAX_SAMPLES = 100;
  let hasNumber = false;
  let allNumbers = true;
  let allInt = true;
  let seenBoolString = false;
  let seenNonBoolString = false;
  let hasDateString = false;

  for (const row of data) {
    if (!row) continue;
    const val = row[col];
    if (val === null || val === undefined) continue;

    samples++;
    const isNumber = typeof val === "number";
    const isBool = typeof val === "boolean";
    const isDateObj = val instanceof Date;
    const isJson = typeof val === "object" && !isDateObj;

    if (isNumber) {
      hasNumber = true;
      if (!Number.isInteger(val)) allInt = false;
    } else if (isBool) {
      seenBoolString = true;
      allNumbers = false;
    } else if (isJson) {
      return "json";
    } else {
      const str = String(val).trim();
      if (!str) continue;

      if (isDateObj || (str.length >= 8 && !isNaN(Date.parse(str)) && /[\-T\/:\s]/.test(str))) {
        hasDateString = true;
        allNumbers = false;
      } else if (/^-?\d+(\.\d+)?$/.test(str)) {
        if (str.includes(".")) allInt = false;
      } else if (["true", "false", "t", "f", "yes", "no", "y", "n"].includes(str.toLowerCase())) {
        seenBoolString = true;
        allNumbers = false;
      } else {
        seenNonBoolString = true;
        allNumbers = false;
        allInt = false;
      }
    }

    if (samples >= MAX_SAMPLES) break;
  }

  if (samples === 0) return inferFromColumnName(col);

  if (hasNumber && allNumbers) return allInt ? "int" : "float";
  if (hasDateString) return "timestamp";
  if (seenBoolString && !seenNonBoolString && !hasNumber) return "bool";
  if (allNumbers) return allInt ? "int" : "float";
  return "varchar";
}

function getTypeHeaderPrefix(type: string, isFk: boolean, colName: string): string {
  const t = type.toLowerCase().trim();
  let base = "";
  
  if (t === "jsonb" || t === "json") {
    base = "{}";
  } else if (t.includes("char") || t.includes("text") || t.includes("uuid") || t.includes("string") || t.includes("clob")) {
    base = "A·Z";
  } else if (t.includes("time") || t.includes("date") || t.includes("timestamp") || t.includes("interval")) {
    base = "🕑";
  } else if (t.includes("int") || t.includes("num") || t.includes("dec") || t.includes("float") || t.includes("double") || t.includes("real") || t === "serial" || t === "bigserial") {
    base = "123";
  } else if (t.includes("bool")) {
    base = "bool";
  } else if (t.includes("blob") || t.includes("bytea") || t.includes("bin")) {
    base = "01";
  } else {
    base = "A·Z"; // Default fallback
  }

  // Key/FK indicators
  if (isFk) {
    return `${base}🔗 `;
  } else if (colName === "id" || colName.endsWith("_id")) {
    return `${base}🔑 `;
  }
  
  return `${base} `;
}

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
  columnTypes,
  tableSchema,
  onFkCellClick
}, ref) => {
  const editorRef = React.useRef<any>(null);
  const [hoveredHeader, setHoveredHeader] = useState<{ colIdx: number; bounds: { x: number; y: number; width: number; height: number } } | null>(null);

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

  const fkCols = useMemo(() => {
    const map = new Map<string, { refTable: string; refColumns: string[] }>();
    if (tableSchema?.foreignKeys) {
      for (const fk of tableSchema.foreignKeys) {
        for (const col of fk.columns) {
          map.set(col, { refTable: fk.refTable, refColumns: fk.refColumns });
        }
      }
    }
    return map;
  }, [tableSchema]);

  const gridColumns = useMemo<GridColumn[]>(() => 
    columns.map(col => {
      let type = columnTypes?.[col];
      if (!type) {
        type = inferColumnType(data, col);
      }
      
      const isFk = fkCols.has(col);
      const prefix = type ? getTypeHeaderPrefix(type, isFk, col) : "";
      const title = `${prefix}${col}`;
      
      return { 
        title, 
        id: col, 
        width: columnWidths?.[col] || 150, 
        hasMenu: false 
      };
    }), 
  [columns, columnWidths, columnTypes, fkCols, data]);

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
      // FK columns: custom cell so provideEditor opens the FK dropdown even for null cells
      const isFkNull = fkCols.has(col) && canEdit;
      if (isFkNull) {
        const fk = fkCols.get(col)!;
        return {
          kind: GridCellKind.Custom,
          data: {
            __fk__: true,
            value: "",
            fkCol: col,
            fk,
            fkValue: null,
            onNavigate: () => { onFkCellClick?.(fk, null); },
          } as FkCellData,
          copyData: "",
          allowOverlay: canEdit,
          readonly: false,
          themeOverride: {
            ...themeOverride,
            textDark: palette.textFaint,
          }
        } as CustomCell<FkCellData>;
      }
      return {
        kind: GridCellKind.Text,
        data: "",
        displayData: "NULL",
        allowOverlay: canEdit,
        readonly: !canEdit,
        themeOverride: {
          ...themeOverride,
          textDark: palette.textFaint,
        }
      };
    }

    // FK columns: custom cell with icon (DBeaver-style)
    if (fkCols.has(col) && canEdit) {
      const fk = fkCols.get(col)!;
      return {
        kind: GridCellKind.Custom,
          data: {
            __fk__: true,
            value: String(val),
            fkCol: col,
            fk,
            fkValue: val,
            onNavigate: () => { onFkCellClick?.(fk, val); },
          } as FkCellData,
        copyData: String(val),
        allowOverlay: canEdit,
        readonly: false,
        themeOverride: {
          ...themeOverride,
        }
      } as CustomCell<FkCellData>;
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
        maxSize: 14,
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
  }, [data, columns, isProductionMode, palette, isReadOnly, sensitiveColumns, dateColumns, binaryColumns, fkCols, onFkCellClick]);

  return (
    <div className="w-full h-full relative overflow-hidden bg-[var(--surface-base)]">
      <DataEditor
        width="100%"
        height="100%"
        columns={gridColumns}
        rows={data.length}
        getCellContent={getCellContent}
        drawHeader={(args) => {
          const { ctx, column, theme, rect } = args;
          
          // Draw background
          ctx.fillStyle = theme.bgHeader;
          ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

          // Draw bottom border
          ctx.strokeStyle = theme.borderColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(rect.x, rect.y + rect.height - 0.5);
          ctx.lineTo(rect.x + rect.width, rect.y + rect.height - 0.5);
          ctx.stroke();

          // Draw right border (column separator)
          ctx.beginPath();
          ctx.moveTo(rect.x + rect.width - 0.5, rect.y);
          ctx.lineTo(rect.x + rect.width - 0.5, rect.y + rect.height);
          ctx.stroke();

          // Draw text with clipping to avoid overflow
          ctx.save();
          ctx.beginPath();
          ctx.rect(rect.x, rect.y, rect.width - 8, rect.height);
          ctx.clip();

          const padding = theme.cellHorizontalPadding;
          const textY = rect.y + rect.height / 2;
          ctx.textBaseline = "middle";
          ctx.font = theme.headerFontStyle;

          const title = column.title;
          const HEADER_PREFIX_REGEX = /^(123|A·Z|🕑|\{\}|bool|01)[🔑🔗∞]*\s+/;
          const match = title.match(HEADER_PREFIX_REGEX);

          if (match) {
            const prefix = match[0];
            const rest = title.substring(prefix.length);

            // Draw blue prefix
            ctx.fillStyle = theme.linkColor;
            ctx.textAlign = "left";
            ctx.fillText(prefix, rect.x + padding, textY);

            // Draw default color rest of title
            const prefixWidth = ctx.measureText(prefix).width;
            ctx.fillStyle = theme.textHeader;
            ctx.fillText(rest, rect.x + padding + prefixWidth, textY);
          } else {
            ctx.fillStyle = theme.textHeader;
            ctx.textAlign = "left";
            ctx.fillText(title, rect.x + padding, textY);
          }

          ctx.restore();
          return true;
        }}
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
          const [colIdx, rowIdx] = cell;
          const col = columns[colIdx];
          const val = data[rowIdx]?.[col];

          // Binary cell click → preview
          if (onBinaryCellClick && val != null && binaryColumns.has(col)) {
            const bytes = toNormalizedBytes(val);
            if (bytes !== null) {
              onBinaryCellClick(rowIdx, col, bytes, detectFileType(bytes), typeof val === "string" ? val : undefined);
            }
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
        onItemHovered={(args) => {
          const colIdx = args.location[0];
          if (args.kind === "header") {
            if (hoveredHeader?.colIdx !== colIdx || hoveredHeader?.bounds !== args.bounds) {
              setHoveredHeader({ colIdx, bounds: args.bounds });
            }
          } else if (hoveredHeader !== null) {
            setHoveredHeader(null);
          }
        }}
        onColumnMoved={(from, to) => {
          if (onColumnMoved) onColumnMoved(from, to);
        }}
        customRenderers={[fkCellRenderer]}
        provideEditor={(cell) => {
          // FK column (CustomCell): edit as plain text input
          if (cell.kind === GridCellKind.Custom && typeof cell.data === "object" && cell.data !== null && "__fk__" in cell.data) {
            if (!isReadOnly) {
              return (props) => {
                const { value, onChange, onFinishedEditing } = props;
                const initialVal = value.kind === GridCellKind.Custom
                  ? (value.data as FkCellData).value
                  : ("displayData" in value ? String(value.displayData ?? "") : "");

                return (
                  <div className="w-full h-full bg-[var(--surface-base)] p-1 flex items-center">
                    <input 
                      type="text" 
                      defaultValue={initialVal === "NULL" ? "" : initialVal}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          const newCell = {
                            ...value,
                            kind: GridCellKind.Text,
                            data: e.currentTarget.value === "" ? null : e.currentTarget.value,
                            displayData: e.currentTarget.value
                          } as any;
                          onChange(newCell);
                          onFinishedEditing(newCell);
                        } else if (e.key === "Escape") {
                          onFinishedEditing();
                        }
                      }}
                      onBlur={e => {
                        const newCell = {
                          ...value,
                          kind: GridCellKind.Text,
                          data: e.target.value === "" ? null : e.target.value,
                          displayData: e.target.value
                        } as any;
                        onChange(newCell);
                        onFinishedEditing(newCell);
                      }}
                      autoFocus
                      className="w-full bg-transparent text-[var(--neutral-12)] outline-none border-none text-[13px] font-mono"
                    />
                  </div>
                );
              };
            }
          }
          // Date/time cells by italic styling in getCellContent
          if (cell.kind === GridCellKind.Text && cell.themeOverride?.baseFontStyle?.includes("italic")) {
             return (props) => {
                const { value, onChange, onFinishedEditing } = props;
                if (value.kind !== GridCellKind.Text) return null;

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

      {hoveredHeader !== null && (() => {
        const col = columns[hoveredHeader.colIdx];
        const type = columnTypes?.[col] ?? inferColumnType(data, col) ?? "varchar";
        const b = hoveredHeader.bounds;
        const fk = fkCols.get(col);
        const schemaCol = tableSchema?.columns?.find(c => c.name === col);
        return (
          <div
            className="fixed z-50 px-2.5 py-1.5 text-xs rounded shadow-lg pointer-events-none"
            style={{
              left: `${b.x}px`,
              top: `${b.y + b.height + 2}px`,
              background: "var(--surface-raised, #1e1e2e)",
              color: "var(--neutral-12, #e6e9f2)",
              border: "1px solid var(--neutral-6, #363a3f)",
              maxWidth: "320px",
              whiteSpace: "nowrap",
            }}
          >
            <div className="font-semibold text-[13px]">{col}</div>
            <div className="flex items-center gap-1" style={{ color: "var(--accent-11, #93b8fc)" }}>
              {type}
              {schemaCol?.nullable === false && (
                <span style={{ color: "var(--danger-11, #ff6369)" }}> NOT NULL</span>
              )}
            </div>
            {schemaCol?.default !== null && schemaCol?.default !== undefined && (
              <div style={{ color: "var(--neutral-11, #9aa3bd)" }}>
                default: {schemaCol.default}
              </div>
            )}
            {fk !== undefined && (
              <div style={{ color: "var(--neutral-11, #9aa3bd)" }}>
                FK → {fk.refTable}({fk.refColumns.join(", ")})
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
});
