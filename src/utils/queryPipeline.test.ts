import { describe, it, expect } from "vitest";
import { splitStatements } from "./splitStatements";
import { isSelectLike, stripSqlToCode } from "./sqlDialect";
import { applyQueryLimit } from "./applyQueryLimit";
import { resolveStatementAtOffset } from "./statementAtCursor";

// Regression test for the reported "records not showing" query. Pins the
// exact shape (trailing spaces after the table name, string literal in
// WHERE, multi-line, no terminating semicolon) through every pure stage of
// the run pipeline so a future refactor can't silently mangle it into an
// empty result or a syntax error.
const QUERY = "select * from project_issue  \nwhere name = 'testkix'";

describe("reported query pipeline (select … where name = 'testkix')", () => {
  it("splits to a single whole statement", () => {
    const parts = splitStatements(QUERY);
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe(QUERY.trim());
  });

  it("run-at-cursor resolves the whole statement from any caret position", () => {
    const line2Offset = QUERY.indexOf("where");
    for (const offset of [0, 10, line2Offset, line2Offset + 5, QUERY.length]) {
      expect(resolveStatementAtOffset(QUERY, offset)?.text).toBe(QUERY.trim());
    }
  });

  it("classifies as a row-returning SELECT (db.select path)", () => {
    expect(isSelectLike(QUERY)).toBe(true);
  });

  it("appends LIMIT without touching the WHERE literal", () => {
    expect(applyQueryLimit(QUERY, 1000)).toBe(`${QUERY.trim()} LIMIT 1000`);
    // The literal must survive byte-identical (no lexer bleed into strings).
    expect(applyQueryLimit(QUERY, 1000)).toContain("name = 'testkix'");
  });

  it("still detects project_issue as the target table", () => {
    const stripped = stripSqlToCode(QUERY);
    const m = /(?:FROM|JOIN|UPDATE|INTO)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\b/i.exec(stripped);
    expect(m?.[1]).toBe("project_issue");
  });
});
