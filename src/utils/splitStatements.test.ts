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

describe("splitStatements — engines and corner cases", () => {
  it("keeps normal multi-statement scripts split", () => {
    const out = splitStatements("SELECT 1; SELECT 2; SELECT 3;");
    expect(out.map(s => s.text)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("keeps CTEs as one statement", () => {
    const sql = "WITH x AS (SELECT 1) SELECT * FROM x; SELECT 2";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("WITH x AS (SELECT 1) SELECT * FROM x");
  });

  it("keeps anonymous DO blocks whole, all variants", () => {
    const variants = [
      "DO $$ BEGIN PERFORM 1; PERFORM 2; END; $$;",
      "DO $body$ BEGIN PERFORM 1; END; $body$;",
      "DO LANGUAGE plpgsql $$ BEGIN PERFORM 1; END; $$;",
      "DO 'BEGIN PERFORM 1; END;'",
    ];
    for (const v of variants) {
      const separator = v.trimEnd().endsWith(";") ? " " : "; ";
      const out = splitStatements(`${v}${separator}SELECT 1`);
      expect(out).toHaveLength(2);
      expect(out[1].text).toBe("SELECT 1");
    }
  });

  it("does NOT split inside MySQL backtick identifiers", () => {
    const out = splitStatements("CREATE TABLE `a;b` (id int); SELECT 1");
    expect(out.map(s => s.text)).toEqual(["CREATE TABLE `a;b` (id int)", "SELECT 1"]);
  });

  it("honours backslash escapes only in MySQL strings and PostgreSQL E-strings", () => {
    // MySQL: \' is an escaped quote inside the string.
    expect(splitStatements("SELECT 'a\\';b'; SELECT 2", { hashComments: true }).map(s => s.text))
      .toEqual(["SELECT 'a\\';b'", "SELECT 2"]);
    // PostgreSQL E-string: same.
    expect(splitStatements("SELECT E'a\\';b'; SELECT 2").map(s => s.text))
      .toEqual(["SELECT E'a\\';b'", "SELECT 2"]);
    // PostgreSQL standard string: the backslash is literal, the quote closes it.
    expect(splitStatements("SELECT replace(p, '\\', '/') FROM t; SELECT 2").map(s => s.text))
      .toEqual(["SELECT replace(p, '\\', '/') FROM t", "SELECT 2"]);
    expect(splitStatements("SELECT 'C:\\'; SELECT 2").map(s => s.text)).toEqual(["SELECT 'C:\\'", "SELECT 2"]);
  });

  it("nests PostgreSQL block comments (MySQL's don't nest)", () => {
    expect(splitStatements("SELECT 1 /* a /* b */ ; still comment */; SELECT 2").map(s => s.text))
      .toEqual(["SELECT 1 /* a /* b */ ; still comment */", "SELECT 2"]);
  });

  it("keeps BEGIN ATOMIC function bodies whole, including CASE … END inside", () => {
    const fn = `CREATE FUNCTION f(x int) RETURNS int LANGUAGE sql
BEGIN ATOMIC
  SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END;
  SELECT x;
END`;
    const out = splitStatements(`${fn};
SELECT f(1)`);
    expect(out.map(s => s.text)).toEqual([fn, "SELECT f(1)"]);
  });

  it("does not treat a transaction BEGIN as an ATOMIC body", () => {
    expect(splitStatements("BEGIN; UPDATE t SET a = 1; COMMIT").map(s => s.text)).toEqual(["BEGIN", "UPDATE t SET a = 1", "COMMIT"]);
  });

  it("skips COPY … FROM STDIN data rows", () => {
    const sql = "COPY t (a, b) FROM STDIN;\n1\tone; two\n2\tthree\n\\.\nSELECT count(*) FROM t";
    expect(splitStatements(sql).map(s => s.text)).toEqual(["COPY t (a, b) FROM STDIN", "SELECT count(*) FROM t"]);
  });

  it("splits psql meta-commands per line", () => {
    expect(splitStatements("\\x on\nSELECT 1;\n\\dt public.*\nSELECT 2").map(s => s.text))
      .toEqual(["\\x on", "SELECT 1", "\\dt public.*", "SELECT 2"]);
  });

  it("handles MySQL DELIMITER blocks as one statement", () => {
    const sql = `DELIMITER $$
CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$
DELIMITER ;
SELECT 1`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain("CREATE PROCEDURE");
    expect(out[0].text).toContain("SELECT 1; SELECT 2;");
    expect(out[1].text).toBe("SELECT 1");
  });

  it("normal statements still split after a DELIMITER reset", () => {
    const out = splitStatements("DELIMITER $$ SELECT 1$$ DELIMITER ; SELECT 2; SELECT 3");
    expect(out.map(s => s.text)).toContain("SELECT 2");
    expect(out.map(s => s.text)).toContain("SELECT 3");
  });

  it("treats # as a comment even when glued to code (MySQL)", () => {
    const out = splitStatements("SELECT * FROM logs# LIMIT 1\n; SELECT 2", { hashComments: true });
    expect(out.map(s => s.text)).toEqual(["SELECT * FROM logs# LIMIT 1", "SELECT 2"]);
  });

  it("preserves PostgreSQL # operators by default (no hashComments)", () => {
    // `#>` / `#>>` are JSON operators, not comments: the `;` inside the
    // second statement must still split, and nothing may be swallowed.
    const out = splitStatements("SELECT doc#>'{a}' FROM t; SELECT 2");
    expect(out.map(s => s.text)).toEqual(["SELECT doc#>'{a}' FROM t", "SELECT 2"]);
    const explicit = splitStatements("SELECT doc#>>'{a}' FROM t; SELECT 2", { hashComments: false });
    expect(explicit).toHaveLength(2);
  });

  it("still splits large scripts without quadratic slowdown", () => {
    const big = `SELECT '${"x".repeat(20000)}'; SELECT 2`;
    const out = splitStatements(big);
    expect(out).toHaveLength(2);
    expect(out[1].text).toBe("SELECT 2");
  });

  it("splits mixed-dialect text per target (MultiQueryDialog contract)", () => {
    // Regression: the multi-target runner split once with a shared `#`
    // flag, so on mixed runs the PostgreSQL target received one statement
    // (the `;` swallowed as a MySQL comment) instead of two. Each target
    // must split under its own dialect instead.
    const mixed = "SELECT doc#>'{a}' FROM t; SELECT 2;";
    // PostgreSQL target: `#>` is an operator — two intact statements.
    const pg = splitStatements(mixed, { hashComments: false }).map(s => s.text);
    expect(pg).toEqual(["SELECT doc#>'{a}' FROM t", "SELECT 2"]);
    // MySQL target: `#...` runs to end of line, swallowing the `;`.
    expect(splitStatements(mixed, { hashComments: true })).toHaveLength(1);
  });
});
