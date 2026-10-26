import { describe, it, expect } from "vitest";
import {
  classifyDestructive,
  cleanSqlForKeywords,
  escapeSqlStringLiteral,
  formatSqlLiteral,
  getDefaultPort,
  isDoBlock,
  isMySqlLike,
  isPgLike,
  isSelectLike,
  quoteIdentifierPart,
  resolveTabHashComments,
  splitDottedIdentifier,
  stripSqlToCode,
  stripTrailingSemicolonAndComments,
} from "./sqlDialect";

describe("sqlDialect — ports", () => {
  it("returns MySQL-family ports", () => {
    expect(getDefaultPort("mysql")).toBe(3306);
    expect(getDefaultPort("mariadb")).toBe(3306);
  });

  it("returns CockroachDB port, not PG default", () => {
    expect(getDefaultPort("cockroach")).toBe(26257);
  });

  it("falls back to 5432", () => {
    expect(getDefaultPort("postgres")).toBe(5432);
    expect(getDefaultPort("supabase")).toBe(5432);
    expect(getDefaultPort(undefined)).toBe(5432);
    expect(getDefaultPort("weird")).toBe(5432);
  });

  it("classifies engine families", () => {
    expect(isPgLike("postgres")).toBe(true);
    expect(isPgLike("cockroach")).toBe(true);
    expect(isPgLike("mysql")).toBe(false);
    expect(isMySqlLike("mariadb")).toBe(true);
    expect(isMySqlLike("postgres")).toBe(false);
  });
});

describe("sqlDialect — isDoBlock (anonymous blocks)", () => {
  it("detects plain DO dollar blocks", () => {
    expect(isDoBlock("DO $$ BEGIN PERFORM 1; END; $$;")).toBe(true);
    expect(isDoBlock("do $body$ BEGIN PERFORM 1; END; $body$")).toBe(true);
  });

  it("detects DO LANGUAGE variants", () => {
    expect(isDoBlock("DO LANGUAGE plpgsql $$ BEGIN PERFORM 1; END; $$;")).toBe(true);
    expect(isDoBlock("do language plpgsql $b$ BEGIN END; $b$")).toBe(true);
  });

  it("detects single-quoted bodies", () => {
    expect(isDoBlock("DO 'BEGIN PERFORM 1; END;'")).toBe(true);
  });

  it("ignores leading comments", () => {
    expect(isDoBlock("/* c */ -- x\nDO $$ BEGIN END; $$")).toBe(true);
  });

  it("rejects non-DO statements, even with DO inside strings", () => {
    expect(isDoBlock("SELECT 1")).toBe(false);
    expect(isDoBlock("SELECT 'DO $$'")).toBe(false);
    expect(isDoBlock("SELECT 1; SELECT 2")).toBe(false);
  });
});

describe("sqlDialect — isSelectLike", () => {
  it("accepts normal SELECTs and CTEs", () => {
    expect(isSelectLike("SELECT 1")).toBe(true);
    expect(isSelectLike("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
    expect(isSelectLike("SHOW TABLES")).toBe(true);
    expect(isSelectLike("EXPLAIN SELECT 1")).toBe(true);
    expect(isSelectLike("VALUES (1), (2)")).toBe(true);
  });

  it("treats DML with RETURNING as row-returning", () => {
    expect(isSelectLike("INSERT INTO t (a) VALUES (1) RETURNING id")).toBe(true);
    expect(isSelectLike("UPDATE t SET a = 1 RETURNING id")).toBe(true);
    expect(isSelectLike("DELETE FROM t WHERE id = 1 RETURNING id")).toBe(true);
  });

  it("never treats DO blocks as selects, even with SELECT/RETURNING inside", () => {
    const doBlock = "DO $$ BEGIN PERFORM 1; UPDATE t SET a=1 RETURNING id INTO x; END; $$;";
    expect(isDoBlock(doBlock)).toBe(true);
    expect(isSelectLike(doBlock)).toBe(false);
  });

  it("ignores keywords inside literals and comments", () => {
    expect(isSelectLike("SELECT 'RETURNING'")).toBe(true); // real select, literal ignored
    expect(isSelectLike("UPDATE t SET x = 'RETURNING'")).toBe(false);
    expect(isSelectLike("UPDATE t SET x = 1 -- RETURNING")).toBe(false);
    expect(isSelectLike("DELETE FROM t")).toBe(false);
  });

  it("does NOT treat DML with a subquery (no RETURNING) as a select", () => {
    expect(isSelectLike("DELETE FROM t WHERE id IN (SELECT id FROM archived)")).toBe(false);
    expect(isSelectLike("UPDATE t SET a = 1 WHERE id IN (SELECT id FROM s)")).toBe(false);
    expect(isSelectLike("INSERT INTO t (a) SELECT a FROM s")).toBe(false);
  });

  it("treats every top-level # as a MySQL comment (opt-in)", () => {
    // `# LIMIT 1` glued to an identifier must still hide the limit, or the
    // safety-limit check sees a limit MySQL ignores.
    const mysql = { hashComments: true };
    expect(stripSqlToCode("SELECT * FROM logs# LIMIT 1", mysql)).not.toContain("LIMIT");
    expect(cleanSqlForKeywords("SELECT * FROM logs# LIMIT 1", mysql)).not.toContain("LIMIT");
  });

  it("preserves PostgreSQL # JSON operators by default", () => {
    // `UPDATE t SET doc = doc #> '{a}' RETURNING doc` must keep RETURNING
    // visible so it routes via db.select() and the row is displayed.
    expect(stripSqlToCode("SELECT doc#>'{a}' FROM t")).toContain("#>");
    expect(isSelectLike("UPDATE t SET doc = doc #> '{a}' RETURNING doc")).toBe(true);
    // ...while the same text under the MySQL rule hides everything past `#`.
    expect(isSelectLike("UPDATE t SET doc = doc #> '{a}' RETURNING doc", { hashComments: true })).toBe(false);
  });
});

describe("sqlDialect — classifyDestructive", () => {
  it("flags real destructive statements", () => {
    expect(classifyDestructive("DROP TABLE t").isDestructive).toBe(true);
    expect(classifyDestructive("TRUNCATE t").isDestructive).toBe(true);
    expect(classifyDestructive("DELETE FROM t").isDestructive).toBe(true);
    expect(classifyDestructive("DELETE FROM t WHERE id = 1").isDestructive).toBe(false);
  });

  it("does not flag identifiers containing keywords", () => {
    expect(classifyDestructive("SELECT * FROM deleted_items").isDestructive).toBe(false);
    expect(classifyDestructive("SELECT * FROM drops").isDestructive).toBe(false);
    expect(classifyDestructive("SELECT * FROM truncated").isDestructive).toBe(false);
  });

  it("does not flag keywords inside strings or comments", () => {
    expect(classifyDestructive("SELECT 'DROP TABLE x'").isDestructive).toBe(false);
    expect(classifyDestructive("SELECT 1 -- DROP TABLE x").isDestructive).toBe(false);
    expect(classifyDestructive("SELECT 1 /* DELETE */ FROM t WHERE id = 1").isDestructive).toBe(false);
  });
});

describe("sqlDialect — escaping", () => {
  it("escapes string literals by doubling quotes", () => {
    expect(escapeSqlStringLiteral("O'Brien")).toBe("'O''Brien'");
    expect(escapeSqlStringLiteral("a'b'c")).toBe("'a''b''c'");
  });

  it("formats grid values as SQL literals across engines", () => {
    expect(formatSqlLiteral(null)).toBe("NULL");
    expect(formatSqlLiteral(undefined)).toBe("NULL");
    expect(formatSqlLiteral(123)).toBe("123");
    expect(formatSqlLiteral(4.5)).toBe("4.5");
    expect(formatSqlLiteral(true)).toBe("TRUE");
    expect(formatSqlLiteral(false)).toBe("FALSE");
    expect(formatSqlLiteral("value123435")).toBe("'value123435'");
    expect(formatSqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("serializes objects instead of writing [object Object]", () => {
    expect(formatSqlLiteral({ a: 1 })).toBe('\'{"a":1}\'');
    expect(formatSqlLiteral([1, 2])).toBe("'[1,2]'");
    expect(formatSqlLiteral({ q: "o'x" })).toBe('\'{"q":"o\'\'x"}\'');
  });

  it("escapes identifier quotes by doubling, not deleting", () => {
    expect(quoteIdentifierPart('a"b', "postgres")).toBe('"a""b"');
    expect(quoteIdentifierPart("a`b", "mysql")).toBe("`a``b`");
  });

  it("splits dotted identifiers respecting quotes", () => {
    expect(splitDottedIdentifier('"my.schema"."my.table"')).toEqual(['"my.schema"', '"my.table"']);
    expect(splitDottedIdentifier("public.users")).toEqual(["public", "users"]);
  });
});

describe("sqlDialect — strip helpers", () => {
  it("blanks strings so keyword scans are safe", () => {
    const clean = cleanSqlForKeywords("SELECT 'DROP -- x' /* DELETE */ FROM t");
    expect(clean).not.toContain("DROP");
    expect(clean).not.toContain("DELETE");
    expect(clean).toContain("SELECT");
  });

  it("strips trailing semicolons/comments without touching literals", () => {
    expect(stripTrailingSemicolonAndComments("SELECT 1;")).toBe("SELECT 1");
    expect(stripTrailingSemicolonAndComments("SELECT 1; -- hi")).toBe("SELECT 1");
    expect(stripTrailingSemicolonAndComments("SELECT 1 /* hi */")).toBe("SELECT 1");
    // Literal tail must survive intact.
    expect(stripTrailingSemicolonAndComments("SELECT 'a -- b'")).toBe("SELECT 'a -- b'");
    expect(stripSqlToCode("SELECT 'a -- b'")).not.toContain("-- b");
  });
});

describe("sqlDialect — resolveTabHashComments", () => {
  // Regression: the editor derived `#` handling from the globally-active
  // connection, so a PostgreSQL tab corrupted `#>` operators (or a MySQL tab
  // missed `#` comments) whenever the sidebar sat on the other dialect.
  const conns = [
    { id: "pg", type: "postgres" },
    { id: "my", type: "mysql" },
  ];

  it("uses the tab target's dialect over the active connection", () => {
    expect(resolveTabHashComments("pg", conns, "mysql")).toEqual({ hashComments: false });
    expect(resolveTabHashComments("my", conns, "postgres")).toEqual({ hashComments: true });
  });

  it("falls back to the active connection for untargeted tabs", () => {
    expect(resolveTabHashComments(undefined, conns, "mysql")).toEqual({ hashComments: true });
    expect(resolveTabHashComments(undefined, conns, "postgres")).toEqual({ hashComments: false });
  });

  it("falls back safely for unknown targets and no connection", () => {
    expect(resolveTabHashComments("gone", conns, "mysql")).toEqual({ hashComments: true });
    expect(resolveTabHashComments(undefined, [], null)).toEqual({ hashComments: false });
  });
});

describe("stripSqlToCode — dialect-correct lexing", () => {
  it("ends a standard PostgreSQL string at the quote after a backslash", () => {
    // The DELETE must stay visible to the safety check.
    expect(cleanSqlForKeywords("SELECT 'C:\\'; DELETE FROM t")).toContain("DELETE FROM T");
    expect(cleanSqlForKeywords("SELECT 'C:\\'; DELETE FROM t", { hashComments: true })).not.toContain("DELETE");
    expect(cleanSqlForKeywords("SELECT E'it\\'s delete'")).not.toContain("DELETE");
  });

  it("blanks nested PostgreSQL comments entirely", () => {
    expect(cleanSqlForKeywords("SELECT 1 /* a /* b */ DELETE */")).toBe("SELECT 1");
  });
});

describe("classifyDestructive — statement-level", () => {
  const flags = (sql: string) => classifyDestructive(sql);

  it("flags DELETE and UPDATE without their own WHERE", () => {
    expect(flags("DELETE FROM t").isDestructive).toBe(true);
    expect(flags("UPDATE t SET a = 1").isDestructive).toBe(true);
    expect(flags("UPDATE t SET a = (SELECT max(b) FROM s WHERE s.id = 1)").isDestructive).toBe(true);
    expect(flags("WITH x AS (SELECT id FROM s WHERE ok) DELETE FROM t").isDestructive).toBe(true);
  });

  it("accepts DELETE/UPDATE with a WHERE of their own", () => {
    expect(flags("DELETE FROM t WHERE id = 1").isDestructive).toBe(false);
    expect(flags("UPDATE t SET a = 1 FROM s WHERE s.id = t.id").isDestructive).toBe(false);
    expect(flags("WITH x AS (SELECT 1) UPDATE t SET a = 1 WHERE id IN (SELECT * FROM x)").isDestructive).toBe(false);
  });

  it("doesn't mistake other statements for UPDATE/DELETE", () => {
    expect(flags("INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 2").isDestructive).toBe(false);
    expect(flags("INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2").isDestructive).toBe(false);
    expect(flags("SELECT * FROM t FOR UPDATE").isDestructive).toBe(false);
    expect(flags("SELECT 'delete from t'").isDestructive).toBe(false);
    expect(flags("DO $$ BEGIN DELETE FROM t; END $$").isDestructive).toBe(false);
  });

  it("flags TRUNCATE and DROP", () => {
    expect(flags("TRUNCATE t").isTruncate).toBe(true);
    expect(flags("DROP TABLE t").isDrop).toBe(true);
  });
});
