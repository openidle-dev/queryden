/** Payload of the grid's FK cells (value plus navigation), never itself a value to save. */
export interface FkCellData {
  __fk__: true;
  value: string;
  fkCol: string;
  fk: { refTable: string; refColumns: string[] };
  fkValue: unknown;
  onNavigate: () => void;
}

export function isFkCellData(data: unknown): data is FkCellData {
  return typeof data === "object" && data !== null && "__fk__" in data;
}

/**
 * The value an FK cell edit should save, or `undefined` when there is nothing
 * to save. The grid hands back the FK cell's own payload when an edit ends
 * untouched (Tab, a click elsewhere); saving that wrote "[object Object]".
 * An emptied cell saves NULL.
 */
export function editedCellValue(data: unknown): unknown {
  if (isFkCellData(data)) return undefined;
  return data;
}
