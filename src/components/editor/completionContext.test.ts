import { describe, it, expect } from "vitest";
import {
  detectSchemaDotContext,
  pickCompletionSchema,
  generateTableAlias,
  extractExistingAliases,
  extractTableRefs,
  classifySqlSpans,
  qualifiedNameAt,
  detectCompletionClause,
  quoteIdentifierIfNeeded,
  tableKey,
} from "./completionContext";

// Issue #28: autocomplete suggestions vanish after typing `.` on schema-qualified tables.
// https://github.com/openidle-dev/queryden/issues/28
//
// `cursorColumn` in these tests is the 1-indexed Monaco column right where the cursor sits — for
// "cursor at the end of the line" that's `line.length + 1`.

describe("detectSchemaDotContext — schema dot detection", () => {
  it("detects schema-dot context at the end of a line", () => {
    const line = "SELECT * FROM app.";
    const m = detectSchemaDotContext(line, line.length + 1, [
      "app.users",
      "app.products",
      "users",
    ]);
    expect(m).not.toBeNull();
    expect(m!.schema).toBe("app");
    expect(m!.qualifiedNames).toEqual(["app.users", "app.products"]);
    expect(m!.bareNames).toEqual(["users", "products"]);
  });

  it("places rangeStartColumn at the column immediately after the dot", () => {
    // `SELECT * FROM app.` — dot is at 0-indexed 17, so column 18; rangeStartColumn = 19.
    const line = "SELECT * FROM app.";
    const m = detectSchemaDotContext(line, line.length + 1, ["app.users"]);
    expect(m!.rangeStartColumn).toBe(19);
  });

  it("still matches when the user has typed letters after the dot", () => {
    // `SELECT * FROM app.us` — Monaco refines via its own prefix matcher; we just keep the range
    // anchored at the character right after the dot so the replacement stays correct.
    const line = "SELECT * FROM app.us";
    const m = detectSchemaDotContext(line, line.length + 1, [
      "app.users",
      "app.products",
    ]);
    expect(m!.bareNames).toEqual(["users", "products"]);
    expect(m!.rangeStartColumn).toBe(19);
  });

  it("matches schema names case-insensitively but preserves stored bare-name casing", () => {
    const m = detectSchemaDotContext("SELECT * FROM APP.", 19, [
      "app.Users",
      "app.Products",
    ]);
    expect(m!.schema).toBe("APP");
    expect(m!.bareNames).toEqual(["Users", "Products"]);
  });

  it("ignores entries that don't belong to the matched schema", () => {
    const m = detectSchemaDotContext("SELECT * FROM app.", 19, [
      "app.users",
      "other.orders",
      "users",
      "billing.invoices",
    ]);
    expect(m!.bareNames).toEqual(["users"]);
  });

  it("handles schemas with underscores and digits", () => {
    const line = "SELECT * FROM my_schema_42.";
    const m = detectSchemaDotContext(line, line.length + 1, [
      "my_schema_42.events",
    ]);
    expect(m!.schema).toBe("my_schema_42");
    expect(m!.bareNames).toEqual(["events"]);
  });

  it("keeps trailing dot segments intact when names contain multiple dots", () => {
    // Defensive: a name with more than one dot keeps everything after the first dot as the
    // bare name. Unusual in real Postgres, but the helper shouldn't lose data.
    const m = detectSchemaDotContext("SELECT * FROM app.", 19, [
      "app.weird.name",
    ]);
    expect(m!.bareNames).toEqual(["weird.name"]);
  });
});

describe("detectSchemaDotContext — returns null when no schema-dot context applies", () => {
  it("returns null when the cursor is not after a dot", () => {
    expect(
      detectSchemaDotContext("SELECT * FROM users", 20, ["app.users"]),
    ).toBeNull();
  });

  it("returns null when the prefix isn't a real schema (likely a table alias)", () => {
    // `u.` where `u` is a table alias, not a schema. Falls through to the alias.column branch.
    const line = "SELECT u. FROM users u";
    expect(
      detectSchemaDotContext(line, 10, ["app.users", "users"]),
    ).toBeNull();
  });

  it("returns null when the prefix before the dot is empty", () => {
    expect(detectSchemaDotContext(".", 2, ["app.users"])).toBeNull();
  });

  it("returns null when pool is empty", () => {
    expect(detectSchemaDotContext("SELECT * FROM app.", 19, [])).toBeNull();
  });
});

describe("detectSchemaDotContext — public schema special-casing", () => {
  it("treats bare-named entries as implicitly under `public`", () => {
    const line = "SELECT * FROM public.";
    const m = detectSchemaDotContext(line, line.length + 1, [
      "app.users",
      "users",
      "products",
    ]);
    expect(m!.schema).toBe("public");
    expect(m!.bareNames).toEqual(["users", "products"]);
  });

  it("merges explicit public.* entries with implicit bare entries", () => {
    const line = "SELECT * FROM public.";
    const m = detectSchemaDotContext(line, line.length + 1, [
      "public.audit_log",
      "users",
      "products",
    ]);
    // Explicit first, implicit appended.
    expect(m!.bareNames).toEqual(["audit_log", "users", "products"]);
  });

  it("returns null for `public.` when no bare and no public.* entries exist", () => {
    const line = "SELECT * FROM public.";
    expect(
      detectSchemaDotContext(line, line.length + 1, [
        "app.users",
        "app.products",
      ]),
    ).toBeNull();
  });
});

describe("pickCompletionSchema — tab-aware schema source", () => {
  const globalItems = { tables: ["users"], views: [], functions: [], columns: [], foreignKeys: [], _ts: 1 };
  const tabItems = { tables: ["reporting.deployments"], views: [], functions: [], columns: [], foreignKeys: [], _ts: 2 };

  it("prefers the tab schema when the tab targets its connection", () => {
    expect(pickCompletionSchema({
      globalItems, globalConnId: "conn-a",
      tabItems, tabConnId: "conn-b",
      targetConnId: "conn-b",
    })).toBe(tabItems);
  });

  it("prefers the global schema when the tab targets the active connection", () => {
    expect(pickCompletionSchema({
      globalItems, globalConnId: "conn-a",
      tabItems, tabConnId: "conn-b",
      targetConnId: "conn-a",
    })).toBe(globalItems);
  });

  it("falls back to whichever schema exists when the target has none cached", () => {
    expect(pickCompletionSchema({
      globalItems, globalConnId: "conn-a",
      tabItems: null, tabConnId: null,
      targetConnId: "conn-b",
    })).toBe(globalItems);
    expect(pickCompletionSchema({
      globalItems: null, globalConnId: null,
      tabItems, tabConnId: "conn-b",
      targetConnId: "conn-b",
    })).toBe(tabItems);
  });

  it("returns null when nothing is cached", () => {
    expect(pickCompletionSchema({
      globalItems: null, globalConnId: null,
      tabItems: null, tabConnId: null,
      targetConnId: "conn-b",
    })).toBeNull();
  });

  it("uses the global schema for untargeted tabs", () => {
    expect(pickCompletionSchema({
      globalItems, globalConnId: "conn-a",
      tabItems, tabConnId: "conn-b",
      targetConnId: undefined,
    })).toBe(globalItems);
  });
});

describe("generateTableAlias — degenerate names never crash", () => {
  it("handles normal names", () => {
    expect(generateTableAlias("users", new Set())).toBe("us");
    expect(generateTableAlias("project_issue", new Set())).toBe("pi");
    expect(generateTableAlias("reporting.deployments", new Set())).toBe("de");
  });

  it("handles leading-underscore names without producing garbage", () => {
    const alias = generateTableAlias("_migrations", new Set());
    expect(alias).not.toContain("undefined");
    expect(alias.length).toBeGreaterThan(0);
  });

  it("handles separator-only names without throwing", () => {
    expect(() => generateTableAlias("_", new Set())).not.toThrow();
    expect(() => generateTableAlias("__", new Set())).not.toThrow();
    const alias = generateTableAlias("_", new Set());
    expect(alias).not.toContain("undefined");
    expect(alias.length).toBeGreaterThan(0);
  });

  it("handles empty names", () => {
    expect(generateTableAlias("", new Set())).toBe("t");
  });

  it("dedupes against existing aliases", () => {
    expect(generateTableAlias("users", new Set(["us"]))).toBe("us2");
  });
});

describe("extractExistingAliases", () => {
  it("extracts short aliases after FROM/JOIN", () => {
    const found = extractExistingAliases("SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id");
    expect(found.has("u")).toBe(true);
    expect(found.has("o")).toBe(true);
  });

  it("ignores long words that are clause keywords", () => {
    const found = extractExistingAliases("SELECT * FROM users WHERE id = 1");
    expect(found.size).toBe(0);
  });
});

describe("extractTableRefs", () => {
  it("finds FROM/JOIN tables with and without aliases", () => {
    expect(extractTableRefs("SELECT * FROM users u JOIN app.orders AS o ON o.user_id = u.id LEFT JOIN items")).toEqual([
      { table: "users", alias: "u" },
      { table: "app.orders", alias: "o" },
      { table: "items", alias: null },
    ]);
  });

  it("sees tables after the caret position (SELECT | FROM t)", () => {
    expect(extractTableRefs("SELECT  FROM users u WHERE u.id = 1")).toEqual([{ table: "users", alias: "u" }]);
  });

  it("handles comma lists, quoted names, UPDATE and INSERT INTO", () => {
    expect(extractTableRefs('SELECT 1 FROM a x, "My Table" y')).toEqual([
      { table: "a", alias: "x" },
      { table: "My Table", alias: "y" },
    ]);
    expect(extractTableRefs("UPDATE accounts SET x = 1")).toEqual([{ table: "accounts", alias: null }]);
    expect(extractTableRefs("INSERT INTO logs (id) VALUES (1)")).toEqual([{ table: "logs", alias: null }]);
  });

  it("ignores FROM inside strings, comments and dollar bodies", () => {
    expect(extractTableRefs("SELECT 'from nope' -- from nope2\nFROM real_t")).toEqual([{ table: "real_t", alias: null }]);
    expect(extractTableRefs("SELECT $$ from nope $$")).toEqual([]);
  });

  it("skips subqueries but keeps their inner tables", () => {
    expect(extractTableRefs("SELECT * FROM (SELECT * FROM inner_t) s")).toEqual([{ table: "inner_t", alias: null }]);
  });
});

describe("detectCompletionClause", () => {
  it.each([
    ["SELECT ", "column"],
    ["SELECT id, ", "column"],
    ["SELECT id FROM ", "table"],
    ["SELECT id FROM us", "table"],
    ["SELECT id FROM users u ", "keyword"],
    ["SELECT id FROM users u JOIN ", "table"],
    ["SELECT id FROM users u JOIN orders o ON ", "column"],
    ["SELECT id FROM users WHERE a = 1 AND ", "column"],
    ["SELECT id FROM users ORDER BY ", "column"],
    ["UPDATE users SET ", "column"],
    ["INSERT INTO ", "table"],
    ["INSERT INTO logs (", "column"],
    ["INSERT INTO logs (id, ", "column"],
    ["SELECT x::", "type"],
    ["SELECT CAST(x AS ", "type"],
    ["CREATE TABLE t (id ", "type"],
    ["CREATE TABLE t (id int, name ", "type"],
    ["ALTER TABLE t ADD COLUMN c ", "type"],
    ["ALTER TABLE t ALTER COLUMN c TYPE ", "type"],
    ["", "keyword"],
  ])("%j → %s", (sql, expected) => {
    expect(detectCompletionClause(sql)).toBe(expected);
  });
});

describe("quoteIdentifierIfNeeded", () => {
  it("quotes PostgreSQL names that would be case-folded or are not plain", () => {
    expect(quoteIdentifierIfNeeded("created_at", "postgres")).toBe("created_at");
    expect(quoteIdentifierIfNeeded("createdAt", "postgres")).toBe('"createdAt"');
    expect(quoteIdentifierIfNeeded("my col", "postgres")).toBe('"my col"');
  });

  it("uses backticks for MySQL only when needed", () => {
    expect(quoteIdentifierIfNeeded("createdAt", "mysql")).toBe("createdAt");
    expect(quoteIdentifierIfNeeded("my col", "mysql")).toBe("`my col`");
  });
});

describe("tableKey", () => {
  it("drops the public schema and lower-cases", () => {
    expect(tableKey("public.Users")).toBe("users");
    expect(tableKey("App.Orders")).toBe("app.orders");
  });
});

describe("qualifiedNameAt", () => {
  const line = 'select * from reporting.build_release_summary() r join "My Schema"."T" t on t.id = r.id';
  it("returns the full qualified call name from either part", () => {
    const fn = { name: "reporting.build_release_summary", isCall: true };
    expect(qualifiedNameAt(line, line.indexOf("reporting") + 2)).toEqual(fn);
    expect(qualifiedNameAt(line, line.indexOf("build_") + 5)).toEqual(fn);
  });

  it("keeps quotes and reports tables as non-calls", () => {
    expect(qualifiedNameAt(line, line.indexOf('"T"') + 1)).toEqual({ name: '"My Schema"."T"', isCall: false });
  });

  it("returns null off an identifier", () => {
    expect(qualifiedNameAt(line, line.indexOf("*"))).toBeNull();
  });
});

describe("classifySqlSpans", () => {
  const kinds = (sql: string) => classifySqlSpans(sql).map(({ start, end, kind }) => `${sql.slice(start, end)}:${kind}`);

  it("colours schemas, tables and aliases distinctly", () => {
    expect(kinds("select * from allie_matching_payments_lookup ampl\nwhere ampl.id_number = '1'")).toEqual([
      "allie_matching_payments_lookup:table",
      "ampl:alias",
      "ampl:alias",
    ]);
    expect(kinds("SELECT users.id FROM app.users JOIN orders o ON o.user_id = users.id")).toEqual([
      "users:table",
      "app:schema",
      "users:table",
      "orders:table",
      "o:alias",
      "o:alias",
      "users:table",
    ]);
  });

  it("does not treat set-returning functions in FROM as tables", () => {
    expect(kinds("select * from reporting.build_release_summary()")).toEqual([]);
    expect(extractTableRefs("SELECT * FROM generate_series(1, 3) g JOIN t ON true")).toEqual([{ table: "t", alias: null }]);
  });
});
