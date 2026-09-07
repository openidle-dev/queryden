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

    it("leaves DO blocks with RETURNING unchanged", () => {
      const doBlock = `DO $$
    DECLARE
        old_type_id INTEGER;
    BEGIN
        SELECT id INTO old_type_id FROM t;
        UPDATE t SET name = 'foo' WHERE id = old_type_id RETURNING id INTO old_type_id;
    END;
$$;`;
      expect(applyQueryLimit(doBlock, 1000)).toBe(doBlock);
    });

    it("leaves DO blocks with named dollar-quoting unchanged", () => {
      const doBlock = `DO $body$
    BEGIN
        INSERT INTO t (name) VALUES ('x') RETURNING id;
    END;
$body$;`;
      expect(applyQueryLimit(doBlock, 1000)).toBe(doBlock);
    });

    it("leaves DO LANGUAGE plpgsql blocks unchanged", () => {
      const doBlock = `DO LANGUAGE plpgsql $$
    BEGIN
        INSERT INTO t (name) VALUES ('x') RETURNING id;
    END;
$$;`;
      expect(applyQueryLimit(doBlock, 1000)).toBe(doBlock);
    });

    it("does not mistake literals/comments for LIMIT or RETURNING", () => {
      // 'LIMIT 10' inside a string is not a real LIMIT.
      expect(applyQueryLimit("SELECT 'LIMIT 10'", 1000)).toBe("SELECT 'LIMIT 10' LIMIT 1000");
      // RETURNING inside a string must not force a LIMIT path change for non-selects.
      expect(applyQueryLimit("UPDATE t SET x = 'RETURNING'", 1000)).toBe("UPDATE t SET x = 'RETURNING'");
    });

    it("never truncates a literal tail containing comment markers", () => {
      expect(applyQueryLimit("SELECT 'a -- b'", 1000)).toBe("SELECT 'a -- b' LIMIT 1000");
    });

    it("does NOT append LIMIT to SHOW/EXPLAIN (syntax error)", () => {
      expect(applyQueryLimit("SHOW TABLES", 1000)).toBe("SHOW TABLES");
      expect(applyQueryLimit("EXPLAIN SELECT 1", 1000)).toBe("EXPLAIN SELECT 1");
    });

    it("does NOT append LIMIT to DML with RETURNING (syntax error)", () => {
      const q = "INSERT INTO t (a) VALUES (1) RETURNING id";
      expect(applyQueryLimit(q, 1000)).toBe(q);
    });
  });
});
