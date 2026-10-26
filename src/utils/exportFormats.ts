/**
 * Result-set serialisers for Export and "Copy as SQL". Pure functions so the
 * escaping rules are unit-tested: CSV per RFC 4180 (`"` doubled, not JSON's
 * `\"`), XML/HTML entity-escaped, SQL literals and identifiers quoted for the
 * target engine, NULL comparisons written as `IS NULL`.
 */

import { formatSqlLiteral } from "./sqlDialect";
import { quoteIdentifierIfNeeded } from "../components/editor/completionContext";
import type { SqlDialect } from "../components/editor/sqlBuiltins";

type Row = Record<string, unknown>;

/** Excel only detects UTF-8 when the file starts with a byte-order mark. */
export const UTF8_BOM = "﻿";

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvField(value: unknown, separator: string): string {
  const text = cellText(value);
  return /["\r\n]/.test(text) || text.includes(separator) || /^\s|\s$/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

/** RFC 4180 CSV; NULL is an empty field. */
export function toCsv(columns: string[], rows: Row[], opts: { bom?: boolean; separator?: string } = {}): string {
  const sep = opts.separator ?? ",";
  const lines = [columns.map((c) => csvField(c, sep)).join(sep), ...rows.map((r) => columns.map((c) => csvField(r[c], sep)).join(sep))];
  return (opts.bom ? UTF8_BOM : "") + lines.join("\r\n");
}

/** Tab-separated; tabs and line breaks inside values become spaces. */
export function toTsv(columns: string[], rows: Row[]): string {
  const clean = (v: unknown) => cellText(v).replace(/[\t\r\n]+/g, " ");
  return [columns.map(clean).join("\t"), ...rows.map((r) => columns.map((c) => clean(r[c])).join("\t"))].join("\n");
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A valid XML element name for a column (`order date` → `order_date`, `1st` → `_1st`). */
export function xmlName(column: string): string {
  const cleaned = column.replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) && !/^xml/i.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function toXml(columns: string[], rows: Row[]): string {
  const body = rows
    .map((r) => {
      const cells = columns.map((c) => {
        const tag = xmlName(c);
        const v = r[c];
        return v === null || v === undefined ? `    <${tag} null="true"/>` : `    <${tag}>${escapeMarkup(cellText(v))}</${tag}>`;
      });
      return `  <row>\n${cells.join("\n")}\n  </row>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<results>\n${body}\n</results>`;
}

export function toHtml(columns: string[], rows: Row[]): string {
  const head = columns.map((c) => `<th>${escapeMarkup(c)}</th>`).join("");
  const body = rows
    .map((r) => `    <tr>${columns.map((c) => `<td>${r[c] === null || r[c] === undefined ? "<em>NULL</em>" : escapeMarkup(cellText(r[c]))}</td>`).join("")}</tr>`)
    .join("\n");
  return `<!DOCTYPE html>\n<meta charset="utf-8">\n<table border="1">\n  <thead>\n    <tr>${head}</tr>\n  </thead>\n  <tbody>\n${body}\n  </tbody>\n</table>`;
}

const ident = (name: string, dialect: SqlDialect) => name.split(".").map((p) => quoteIdentifierIfNeeded(p, dialect)).join(".");
const literal = (v: unknown) => (typeof v === "number" ? String(v) : formatSqlLiteral(v));

/** `a = 1 AND b IS NULL` — `= NULL` never matches anything. */
export function whereFor(row: Row, keyColumns: string[], dialect: SqlDialect): string {
  return keyColumns
    .map((c) => (row[c] === null || row[c] === undefined ? `${ident(c, dialect)} IS NULL` : `${ident(c, dialect)} = ${literal(row[c])}`))
    .join(" AND ");
}

export function toInsertStatements(table: string, columns: string[], rows: Row[], dialect: SqlDialect): string {
  const cols = columns.map((c) => ident(c, dialect)).join(", ");
  return rows.map((r) => `INSERT INTO ${ident(table, dialect)} (${cols}) VALUES (${columns.map((c) => literal(r[c])).join(", ")});`).join("\n");
}

/**
 * UPDATE templates setting every non-key column to its current value, keyed
 * on the primary key when known (otherwise on every column).
 */
export function toUpdateStatements(table: string, columns: string[], keyColumns: string[], rows: Row[], dialect: SqlDialect): string {
  const keys = keyColumns.length > 0 ? keyColumns : columns;
  const setCols = columns.filter((c) => !keyColumns.includes(c));
  return rows
    .map((r) => `UPDATE ${ident(table, dialect)} SET ${(setCols.length > 0 ? setCols : columns).map((c) => `${ident(c, dialect)} = ${literal(r[c])}`).join(", ")} WHERE ${whereFor(r, keys, dialect)};`)
    .join("\n");
}

export function toDeleteStatements(table: string, columns: string[], keyColumns: string[], rows: Row[], dialect: SqlDialect): string {
  const keys = keyColumns.length > 0 ? keyColumns : columns;
  return rows.map((r) => `DELETE FROM ${ident(table, dialect)} WHERE ${whereFor(r, keys, dialect)};`).join("\n");
}
