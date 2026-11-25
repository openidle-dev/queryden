export interface FileType {
  mime: string;
  extension: string;
  label: string;
}

/**
 * How the SQL plugin sends bytea / BLOB values: base64 plus the byte count.
 * Kept in this form in result rows so a multi-MB file costs one string, not
 * one JS number per byte; bytes are decoded only when a value is opened.
 */
export interface BinaryValue {
  $binary: string;
  size: number;
}

export function isBinaryValue(val: unknown): val is BinaryValue {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.$binary === "string" && typeof obj.size === "number";
}

/** Bytes a file-type sniff needs; also bounds every per-cell decode. */
const SNIFF_BYTES = 4096;
/** Array checks look at a prefix only: a full scan of a 10 MB array per paint froze the grid. */
const ARRAY_SAMPLE = 64;

export function isByteArray(val: unknown): val is number[] {
  if (!Array.isArray(val) || val.length === 0) return false;
  const end = Math.min(val.length, ARRAY_SAMPLE);
  for (let i = 0; i < end; i++) {
    const v = val[i];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) return false;
  }
  return true;
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
  if (val.length < 4 || val.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(val.substring(2, 2 + SNIFF_BYTES * 2));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function pgHexToBytes(hexStr: string): Uint8Array {
  return hexToBytes(hexStr.substring(2));
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
  }
  return btoa(parts.join(""));
}

/** Decoded byte count of a base64 string, without decoding it. */
function base64Size(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The first `count` bytes of a base64 string; decodes only that prefix. */
function base64Head(base64: string, count: number): Uint8Array {
  const chars = Math.min(base64.length, Math.ceil(count / 3) * 4);
  return base64ToBytes(base64.substring(0, chars));
}

/** Every byte of a binary cell value, in any form a driver hands back. */
export function toNormalizedBytes(val: unknown): Uint8Array | null {
  if (val == null) return null;
  try {
    if (isBinaryValue(val)) return base64ToBytes(val.$binary);
    if (isByteArray(val)) return Uint8Array.from(val);
    if (isBufferObject(val)) return Uint8Array.from(val.data);
    if (isPgHexString(val)) return pgHexToBytes(val);
    if (isBase64String(val)) return base64ToBytes(val);
  } catch {
    return null;
  }
  return null;
}

/** Byte count and leading bytes of a binary cell value, without decoding the rest. */
export function binaryHead(val: unknown): { size: number; head: Uint8Array } | null {
  if (val == null) return null;
  try {
    if (isBinaryValue(val)) return { size: val.size, head: base64Head(val.$binary, SNIFF_BYTES) };
    if (isByteArray(val)) return { size: val.length, head: Uint8Array.from(val.slice(0, SNIFF_BYTES)) };
    if (isBufferObject(val)) return { size: val.data.length, head: Uint8Array.from(val.data.slice(0, SNIFF_BYTES)) };
    if (isPgHexString(val)) return { size: (val.length - 2) / 2, head: hexToBytes(val.substring(2, 2 + SNIFF_BYTES * 2)) };
    if (isBase64String(val)) return { size: base64Size(val), head: base64Head(val, SNIFF_BYTES) };
  } catch {
    return null;
  }
  return null;
}

const labelCache = new WeakMap<object, string | null>();

/**
 * Grid label for a binary cell, e.g. `[PNG Image · 1.2 MB]`, or null when the
 * value isn't binary. Cached per value object because the grid asks on every
 * paint; string values only decode a bounded prefix, so they need no cache.
 */
export function binaryCellLabel(val: unknown): string | null {
  const cacheable = val !== null && typeof val === "object";
  if (cacheable) {
    const cached = labelCache.get(val);
    if (cached !== undefined) return cached;
  }
  const info = binaryHead(val);
  const label = info ? `[${detectFileType(info.head).label} · ${formatFileSize(info.size)}]` : null;
  if (cacheable) labelCache.set(val, label);
  return label;
}

/**
 * Text for copy and export: `\x` hex, the form PostgreSQL prints and accepts
 * for bytea. Null when the value isn't a decoded binary value.
 */
export function binaryToHexLiteral(val: unknown): string | null {
  if (!isBinaryValue(val)) return null;
  return `\\x${formatHexCompact(base64ToBytes(val.$binary), Number.POSITIVE_INFINITY)}`;
}

export function detectFileType(bytes: Uint8Array): FileType {
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

  // Text detection — UTF-8 decode of the first 4 KB. `stream` tolerates a
  // multi-byte character cut off at the 4 KB boundary.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, SNIFF_BYTES), { stream: true });
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

export function toBlobUrl(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  return URL.createObjectURL(blob);
}

export function revokeBlobUrl(url: string): void {
  URL.revokeObjectURL(url);
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function binaryToUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function isImageType(ft: FileType): boolean {
  return ft.mime.startsWith("image/");
}

export function isPdfType(ft: FileType): boolean {
  return ft.mime === "application/pdf";
}

const toHexByte = (b: number) => b.toString(16).padStart(2, "0");

/** Space-separated hex of the first `count` bytes. */
export function formatHexBytes(bytes: Uint8Array, count: number): string {
  return Array.from(bytes.subarray(0, count), toHexByte).join(" ");
}

/** Printable-ASCII rendering of the first `count` bytes; other bytes become `.`. */
export function formatAsciiBytes(bytes: Uint8Array, count: number): string {
  return Array.from(bytes.subarray(0, count), b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : ".").join("");
}

/**
 * Classic hex dump: 16 bytes per row with offset, hex, and ASCII columns.
 * `maxBytes` controls how many bytes are shown.
 */
export function formatHexDump(bytes: Uint8Array, maxBytes: number = 4096): string {
  const limit = Math.min(bytes.length, maxBytes);
  const lines: string[] = [];
  for (let offset = 0; offset < limit; offset += 16) {
    const chunk = bytes.subarray(offset, Math.min(offset + 16, limit));
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${formatHexBytes(chunk, 16).padEnd(47)} |${formatAsciiBytes(chunk, 16)}|`);
  }
  return lines.join("\n");
}

/** Hex-only dump for copy-to-clipboard (compact, no ASCII column). */
export function formatHexCompact(bytes: Uint8Array, maxBytes: number = 4096): string {
  const limit = Math.min(bytes.length, maxBytes);
  const parts = new Array<string>(limit);
  for (let i = 0; i < limit; i++) parts[i] = toHexByte(bytes[i]);
  return parts.join("");
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
 * Scans the first N rows to detect columns that contain binary values.
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
      if (binaryCellLabel(data[i]?.[col]) !== null) {
        binary.add(col);
        break;
      }
    }
  }
  return binary;
}
