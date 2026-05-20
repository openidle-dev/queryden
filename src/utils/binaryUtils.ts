export interface FileType {
  mime: string;
  extension: string;
  label: string;
}

export function isByteArray(val: unknown): val is number[] {
  if (!Array.isArray(val)) return false;
  if (val.length === 0) return false;
  return val.every(v => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255);
}

export function isBase64String(val: unknown): val is string {
  if (typeof val !== "string") return false;
  if (val.length < 40) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(val.substring(0, 1000));
}

export interface BufferObject {
  type: "Buffer";
  data: number[];
}

export function isBufferObject(val: unknown): val is BufferObject {
  if (val === null || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return obj.type === "Buffer" && Array.isArray(obj.data) && isByteArray(obj.data);
}

export function isPgHexString(val: unknown): val is string {
  if (typeof val !== "string") return false;
  if (!val.startsWith("\\x")) return false;
  if (val.length < 4) return false;
  const hex = val.substring(2);
  return hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex);
}

export function pgHexToBytes(hexStr: string): number[] {
  const hex = hexStr.substring(2);
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return bytes;
}

export function toNormalizedBytes(val: unknown): number[] | null {
  if (val == null) return null;
  if (isByteArray(val)) return val;
  if (isBufferObject(val)) return val.data;
  if (isPgHexString(val)) {
    try {
      return pgHexToBytes(val);
    } catch {
      return null;
    }
  }
  if (isBase64String(val)) {
    try {
      return base64ToBytes(val);
    } catch {
      return null;
    }
  }
  return null;
}

export function detectFileType(bytes: number[]): FileType {
  if (bytes.length < 2) return { mime: "application/octet-stream", extension: "bin", label: "Binary" };

  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { mime: "application/pdf", extension: "pdf", label: "PDF" };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { mime: "image/png", extension: "png", label: "PNG Image" };
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { mime: "image/jpeg", extension: "jpg", label: "JPEG Image" };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { mime: "image/gif", extension: "gif", label: "GIF Image" };
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes.length > 11 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mime: "image/webp", extension: "webp", label: "WebP Image" };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return { mime: "image/bmp", extension: "bmp", label: "BMP Image" };
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { mime: "application/zip", extension: "zip", label: "ZIP Archive" };
  }
  if (bytes[0] === 0x1F && bytes[1] === 0x8B) {
    return { mime: "application/gzip", extension: "gz", label: "GZIP Archive" };
  }

  // Text detection — try UTF-8 decode on the first 4 KB
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes.slice(0, 4096))
    );
    return { mime: "text/plain", extension: "txt", label: "Text File" };
  } catch { /* not valid UTF-8 */ }

  return { mime: "application/octet-stream", extension: "bin", label: "Binary" };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function toBlobUrl(bytes: number[], mime: string): string {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  return URL.createObjectURL(blob);
}

export function revokeBlobUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/** Convert byte array to a data: URL (base64-encoded). Chunked for large arrays. */
export function toDataUrl(bytes: number[], mime: string): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.slice(i, i + CHUNK)));
  }
  return `data:${mime};base64,${btoa(parts.join(""))}`;
}

export function binaryToUtf8(bytes: number[]): string | null {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export function base64ToBytes(base64: string): number[] {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return Array.from(bytes);
}

export function isImageType(ft: FileType): boolean {
  return ft.mime.startsWith("image/");
}

export function isPdfType(ft: FileType): boolean {
  return ft.mime === "application/pdf";
}

/**
 * Classic hex dump: 16 bytes per row with offset, hex, and ASCII columns.
 * `maxBytes` controls how many bytes are shown (callers truncate the array first).
 */
export function formatHexDump(bytes: number[], maxBytes: number = 4096): string {
  const limit = Math.min(bytes.length, maxBytes);
  const lines: string[] = [];
  for (let offset = 0; offset < limit; offset += 16) {
    const chunk = bytes.slice(offset, offset + 16);
    const hex = chunk.map(b => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = chunk.map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : ".").join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)} |${ascii}|`);
  }
  return lines.join("\n");
}

/** Hex-only dump for copy-to-clipboard (compact, no ASCII column). */
export function formatHexCompact(bytes: number[], maxBytes: number = 4096): string {
  const limit = Math.min(bytes.length, maxBytes);
  return bytes.slice(0, limit).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Heuristic: does the column name suggest binary content? */
export function columnNameSuggestsBinary(col: string): boolean {
  const low = col.toLowerCase();
  return low.includes("bytea") || low.includes("blob") || low.includes("binary") ||
    low.includes("data") || low.includes("file") || low.includes("content") ||
    low.includes("raw") || low.includes("image") || low.includes("pdf") ||
    low.includes("thumb") || low.includes("photo") || low.includes("avatar") ||
    low.includes("attachment") || low.includes("document");
}

/**
 * Scans the first N rows to detect columns that contain byte arrays.
 * Returns a Set of column names.
 */
export function detectBinaryColumns(
  data: Record<string, unknown>[],
  columns: string[],
  maxRows: number = 5
): Set<string> {
  const binary = new Set<string>();
  for (const col of columns) {
    if (columnNameSuggestsBinary(col)) {
      binary.add(col);
      continue;
    }
    for (let i = 0; i < Math.min(data.length, maxRows); i++) {
      const val = data[i]?.[col];
      if (toNormalizedBytes(val) !== null) {
        binary.add(col);
        break;
      }
    }
  }
  return binary;
}
