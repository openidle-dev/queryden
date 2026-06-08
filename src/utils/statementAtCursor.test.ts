import { describe, it, expect } from "vitest";
import { resolveStatementAtOffset } from "./statementAtCursor";

/** Convenience: offset of the first occurrence of `needle` in `sql`. */
const at = (sql: string, needle: string) => sql.indexOf(needle);

describe("resolveStatementAtOffset", () => {
  it("returns null for empty or whitespace-only text", () => {
    expect(resolveStatementAtOffset("", 0)).toBeNull();
    expect(resolveStatementAtOffset("   \n  \t ", 3)).toBeNull();
  });

  it("returns the only statement regardless of caret position", () => {
    const sql = "SELECT 1";
    expect(resolveStatementAtOffset(sql, 0)?.text).toBe("SELECT 1");
    expect(resolveStatementAtOffset(sql, 4)?.text).toBe("SELECT 1");
    expect(resolveStatementAtOffset(sql, sql.length)?.text).toBe("SELECT 1");
  });

  it("picks the statement the caret is inside", () => {
    const sql = "SELECT 1; SELECT 2; SELECT 3";
    expect(resolveStatementAtOffset(sql, at(sql, "1"))?.text).toBe("SELECT 1");
    expect(resolveStatementAtOffset(sql, at(sql, "2"))?.text).toBe("SELECT 2");
    expect(resolveStatementAtOffset(sql, at(sql, "3"))?.text).toBe("SELECT 3");
  });

  it("prefers the preceding statement when the caret is in the gap between two", () => {
    const sql = "SELECT 1;   SELECT 2";
    // caret in the whitespace right after the first semicolon
    const gapOffset = sql.indexOf(";") + 2;
    expect(resolveStatementAtOffset(sql, gapOffset)?.text).toBe("SELECT 1");
  });

  it("targets the last statement when the caret is past the end", () => {
    const sql = "SELECT 1; SELECT 2;";
    expect(resolveStatementAtOffset(sql, sql.length)?.text).toBe("SELECT 2");
  });

  it("falls back to the first statement when the caret is in leading whitespace", () => {
    const sql = "   \n\nSELECT 1; SELECT 2";
    expect(resolveStatementAtOffset(sql, 1)?.text).toBe("SELECT 1");
  });

  it("drops empty statements created by a trailing semicolon", () => {
    const sql = "SELECT 1;;;";
    expect(resolveStatementAtOffset(sql, sql.length)?.text).toBe("SELECT 1");
  });

  it("reports the 1-based start line of the targeted statement", () => {
    const sql = "SELECT 1;\nSELECT 2;\n\nSELECT 3";
    expect(resolveStatementAtOffset(sql, at(sql, "1"))?.lineNumber).toBe(1);
    expect(resolveStatementAtOffset(sql, at(sql, "2"))?.lineNumber).toBe(2);
    expect(resolveStatementAtOffset(sql, at(sql, "3"))?.lineNumber).toBe(4);
  });

  it("anchors start/end to the trimmed statement, excluding the semicolon", () => {
    const sql = "SELECT 1;\n  SELECT 22";
    const stmt = resolveStatementAtOffset(sql, at(sql, "22"));
    expect(stmt).not.toBeNull();
    expect(sql.slice(stmt!.start, stmt!.end)).toBe("SELECT 22");
    // start skips the leading whitespace/newline before the second statement
    expect(sql[stmt!.start]).toBe("S");
  });
});
