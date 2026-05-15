import { describe, it, expect } from "vitest";
import { applyQueryLimit } from "./applyQueryLimit";

describe("applyQueryLimit", () => {
  // Regression tests for issue #38:
  // The auto-LIMIT helper previously appended ` LIMIT N` verbatim, so a
  // query ending in `;` produced `SELECT 1; LIMIT 1000` — two statements,
  // the second a syntax error. The helper must strip a trailing semicolon
  // (and any whitespace after it) before appending.
  describe("trailing semicolon stripping (regression: #38)", () => {
    it("strips a trailing semicolon before appending LIMIT", () => {
      expect(applyQueryLimit("SELECT 1;", 1000)).toBe("SELECT 1 LIMIT 1000");
    });

    it("leaves queries without a trailing semicolon alone (other than appending LIMIT)", () => {
      expect(applyQueryLimit("SELECT 1", 1000)).toBe("SELECT 1 LIMIT 1000");
    });

    it("strips a trailing semicolon followed by whitespace", () => {
      expect(applyQueryLimit("SELECT 1;  ", 1000)).toBe("SELECT 1 LIMIT 1000");
    });

    it("strips trailing semicolons from queries with WHERE clauses", () => {
      expect(applyQueryLimit("SELECT 1 WHERE x = 1;", 1000)).toBe(
        "SELECT 1 WHERE x = 1 LIMIT 1000"
      );
    });

    // Without this, `SELECT 1; -- foo` would become `SELECT 1; -- foo LIMIT 1000`,
    // and the `--` comment would extend through `LIMIT 1000`, silently bypassing
    // the safety limit — a worse outcome than the original syntax error.
    // Flagged by CodeRabbit's review on PR #58.
    it("strips a trailing line comment after the semicolon", () => {
      expect(applyQueryLimit("SELECT 1; -- comment", 1000)).toBe(
        "SELECT 1 LIMIT 1000"
      );
    });

    it("strips a trailing block comment after the semicolon", () => {
      expect(applyQueryLimit("SELECT 1; /* comment */", 1000)).toBe(
        "SELECT 1 LIMIT 1000"
      );
    });

    it("strips a trailing line comment when there's no semicolon", () => {
      expect(applyQueryLimit("SELECT 1 -- comment", 1000)).toBe(
        "SELECT 1 LIMIT 1000"
      );
    });

    it("strips a multi-line trailing block comment", () => {
      expect(
        applyQueryLimit("SELECT 1; /* line1\nline2 */", 1000)
      ).toBe("SELECT 1 LIMIT 1000");
    });

    it("preserves inline comments mid-query", () => {
      expect(
        applyQueryLimit("SELECT col1, -- pk\n       col2 FROM t;", 1000)
      ).toBe("SELECT col1, -- pk\n       col2 FROM t LIMIT 1000");
    });
  });

  describe("skip cases", () => {
    it("returns non-SELECT queries unchanged", () => {
      expect(applyQueryLimit("UPDATE t SET x = 1;", 1000)).toBe(
        "UPDATE t SET x = 1;"
      );
    });

    it("does not double-append LIMIT", () => {
      expect(applyQueryLimit("SELECT 1 LIMIT 5", 1000)).toBe(
        "SELECT 1 LIMIT 5"
      );
    });

    it("leaves CTEs alone", () => {
      const cte = "WITH x AS (SELECT 1) SELECT * FROM x";
      expect(applyQueryLimit(cte, 1000)).toBe(cte);
    });

    it("leaves UNION queries alone", () => {
      const union = "SELECT 1 UNION SELECT 2";
      expect(applyQueryLimit(union, 1000)).toBe(union);
    });
  });
});
