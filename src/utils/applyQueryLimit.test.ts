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
