import { describe, it, expect } from "vitest";
import { splitStatements } from "./splitStatements";

describe("splitStatements — basic", () => {
  it("returns empty array for empty input", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   \n  ")).toEqual([]);
  });

  it("returns a single statement when there's no semicolon", () => {
    const out = splitStatements("SELECT 1");
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("SELECT 1");
    expect(out[0].lineNumber).toBe(1);
  });

  it("splits on a single top-level semicolon", () => {
    const out = splitStatements("SELECT 1; SELECT 2");
    expect(out.map(s => s.text)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores a trailing semicolon", () => {
    const out = splitStatements("SELECT 1;");
    expect(out.map(s => s.text)).toEqual(["SELECT 1"]);
  });

  it("ignores empty statements between semicolons", () => {
    const out = splitStatements("SELECT 1;;;SELECT 2;");
    expect(out.map(s => s.text)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("reports line numbers (1-based) for each statement", () => {
    const out = splitStatements("SELECT 1;\nSELECT 2;\n\nSELECT 3");
    expect(out.map(s => s.lineNumber)).toEqual([1, 2, 4]);
  });
});

// Issue #20: top-level split must respect SQL lexer state.
// https://github.com/openidle-dev/queryden/issues/20
describe("splitStatements — issue #20 context-aware", () => {
  it("does NOT split on ; inside single-quoted strings", () => {
    const out = splitStatements("SELECT ';;;' AS literal; SELECT 2");
    expect(out.map(s => s.text)).toEqual([
      "SELECT ';;;' AS literal",
      "SELECT 2",
    ]);
  });

  it("treats '' as an escape inside a string literal", () => {
    const out = splitStatements("SELECT 'it''s ;' AS x; SELECT 2");
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("SELECT 'it''s ;' AS x");
  });

  it("does NOT split on ; inside double-quoted identifiers", () => {
    const out = splitStatements('CREATE TABLE "weird;name" (id int); SELECT 1');
    expect(out.map(s => s.text)).toEqual([
      'CREATE TABLE "weird;name" (id int)',
      "SELECT 1",
    ]);
  });

  it("does NOT split on ; inside $$ dollar-quoted function bodies", () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$
BEGIN
  INSERT INTO log VALUES ('a');
  INSERT INTO log VALUES ('b');
END;
$$ LANGUAGE plpgsql;
SELECT 1`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text.startsWith("CREATE FUNCTION")).toBe(true);
    expect(out[0].text.includes("INSERT INTO log VALUES ('a');")).toBe(true);
    expect(out[1].text).toBe("SELECT 1");
  });

  it("does NOT split on ; inside $tag$ dollar-quoted bodies", () => {
    const sql = `CREATE FUNCTION f() AS $body$ SELECT 1; SELECT 2; $body$ LANGUAGE sql; SELECT 3`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[1].text).toBe("SELECT 3");
  });

  it("does NOT split on ; inside -- line comments", () => {
    const out = splitStatements("SELECT 1 -- end ; here\n; SELECT 2");
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("SELECT 1 -- end ; here");
    expect(out[1].text).toBe("SELECT 2");
  });

  it("does NOT split on ; inside /* */ block comments", () => {
    const out = splitStatements("SELECT 1 /* a;b;c */ ; SELECT 2");
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("SELECT 1 /* a;b;c */");
    expect(out[1].text).toBe("SELECT 2");
  });

  it("does NOT mistake a positional parameter $1 for a dollar-quote", () => {
    const out = splitStatements("SELECT $1; SELECT $2");
    expect(out.map(s => s.text)).toEqual(["SELECT $1", "SELECT $2"]);
  });

  it("handles two CREATE FUNCTION statements run as one selection — the reported bug", () => {
    // This is the exact shape that prompted issue #20: two function
    // definitions selected and run together used to send both to a single
    // prepared statement, which Postgres rejects.
    const sql = `CREATE OR REPLACE FUNCTION a() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION b() RETURNS void AS $$ BEGIN PERFORM 2; END; $$ LANGUAGE plpgsql;`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text.includes("FUNCTION a()")).toBe(true);
    expect(out[1].text.includes("FUNCTION b()")).toBe(true);
  });
});
