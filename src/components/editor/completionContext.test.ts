import { describe, it, expect } from "vitest";
import { detectSchemaDotContext, detectAliasDotContext } from "./completionContext";

const COLUMNS = [
  { table_name: "app.users", column_name: "id" },
  { table_name: "app.users", column_name: "email" },
  { table_name: "app.users", column_name: "created_at" },
  { table_name: "app.products", column_name: "id" },
  { table_name: "app.products", column_name: "name" },
  { table_name: "audit_log", column_name: "id" },
  { table_name: "audit_log", column_name: "payload" },
];

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

describe("detectAliasDotContext — alias resolution", () => {
  it("resolves a single-letter alias on a multi-dot line (issue #28 second case)", () => {
    const query = "SELECT u.id FROM app.users u WHERE u.";
    const line = query;
    const m = detectAliasDotContext(line, line.length + 1, query, COLUMNS);
    expect(m).not.toBeNull();
    expect(m!.alias).toBe("u");
    expect(m!.tableName).toBe("app.users");
    expect(m!.columnNames).toEqual(["id", "email", "created_at"]);
  });

  it("resolves an `AS`-style alias", () => {
    const query = "SELECT * FROM app.users AS u WHERE u.";
    const m = detectAliasDotContext(query, query.length + 1, query, COLUMNS);
    expect(m!.tableName).toBe("app.users");
    expect(m!.columnNames).toEqual(["id", "email", "created_at"]);
  });

  it("resolves an alias declared via a JOIN clause", () => {
    const query =
      "SELECT * FROM app.users u JOIN app.products p ON u.id = p.user_id WHERE p.";
    const m = detectAliasDotContext(query, query.length + 1, query, COLUMNS);
    expect(m!.alias).toBe("p");
    expect(m!.tableName).toBe("app.products");
    expect(m!.columnNames).toEqual(["id", "name"]);
  });

  it("places rangeStartColumn at the column immediately after the dot", () => {
    const query = "SELECT * FROM app.users u WHERE u.";
    // dot is at 0-indexed 33 → column 34; rangeStartColumn = 35
    const m = detectAliasDotContext(query, query.length + 1, query, COLUMNS);
    expect(m!.rangeStartColumn).toBe(query.length + 1);
  });

  it("ignores reserved words mistaken for aliases (`FROM users WHERE`)", () => {
    // The alias regex would otherwise capture `WHERE` as the alias of `users`.
    const query = "SELECT * FROM app.users WHERE u.";
    // No real alias `u` is declared, so resolution must fall back to literal-table lookup.
    // `u` is not a table, so this returns null.
    expect(detectAliasDotContext(query, query.length + 1, query, COLUMNS)).toBeNull();
  });

  it("falls back to literal table name when prefix matches a column.table_name", () => {
    const query = "SELECT * FROM audit_log WHERE audit_log.";
    const m = detectAliasDotContext(query, query.length + 1, query, COLUMNS);
    expect(m!.tableName).toBe("audit_log");
    expect(m!.columnNames).toEqual(["id", "payload"]);
  });

  it("resolves bare table name against a schema-qualified entry via endsWith", () => {
    // User typed `users.` referring to `app.users` without an explicit alias.
    const query = "SELECT * FROM app.users WHERE users.";
    const m = detectAliasDotContext(query, query.length + 1, query, COLUMNS);
    expect(m!.tableName).toBe("app.users");
    expect(m!.columnNames).toEqual(["id", "email", "created_at"]);
  });

  it("matches aliases case-insensitively but preserves stored column casing", () => {
    const cols = [
      { table_name: "app.Users", column_name: "Id" },
      { table_name: "app.Users", column_name: "Email" },
    ];
    const query = "SELECT * FROM app.Users U WHERE U.";
    const m = detectAliasDotContext(query, query.length + 1, query, cols);
    expect(m!.tableName).toBe("app.Users");
    expect(m!.columnNames).toEqual(["Id", "Email"]);
  });

  it("returns null when prefix matches nothing (no alias, no table)", () => {
    const query = "SELECT * FROM app.users u WHERE xyz.";
    expect(detectAliasDotContext(query, query.length + 1, query, COLUMNS)).toBeNull();
  });

  it("returns null when the cursor isn't after a dot", () => {
    const query = "SELECT * FROM app.users u WHERE u";
    expect(detectAliasDotContext(query, query.length + 1, query, COLUMNS)).toBeNull();
  });

  it("returns null when the resolved table has no columns in the pool", () => {
    const query = "SELECT * FROM app.orders o WHERE o.";
    // `app.orders` isn't in COLUMNS — no columns to suggest.
    expect(detectAliasDotContext(query, query.length + 1, query, COLUMNS)).toBeNull();
  });

  it("uses the line content for cursor positioning but the full query for alias lookup", () => {
    // Multi-line query: the alias declaration is on a previous line.
    const query = "SELECT *\n  FROM app.users u\n  WHERE u.";
    const cursorLine = "  WHERE u.";
    const m = detectAliasDotContext(cursorLine, cursorLine.length + 1, query, COLUMNS);
    expect(m!.tableName).toBe("app.users");
    expect(m!.columnNames).toEqual(["id", "email", "created_at"]);
  });
});
