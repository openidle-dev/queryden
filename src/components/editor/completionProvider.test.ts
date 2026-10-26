import { describe, it, expect } from "vitest";
import { buildCompletions, type CompletionRequest } from "./completionProvider";
import type { CompletionSchemaLike } from "./completionContext";

const SCHEMA: CompletionSchemaLike = {
  tables: ["users", "orders", "app.audit_log"],
  views: ["active_users"],
  functions: ["purge_old"],
  types: ["mood"],
  columns: [
    { table_name: "users", column_name: "id", data_type: "integer" },
    { table_name: "users", column_name: "email", data_type: "text" },
    { table_name: "users", column_name: "createdAt", data_type: "timestamp with time zone" },
    { table_name: "orders", column_name: "id", data_type: "integer" },
    { table_name: "orders", column_name: "user_id", data_type: "integer" },
    { table_name: "orders", column_name: "total", data_type: "numeric(12,2)" },
    { table_name: "app.audit_log", column_name: "payload", data_type: "jsonb" },
  ],
  foreignKeys: [{ source_table: "orders", source_column: "user_id", target_table: "users", target_column: "id" }],
};

/** `|` marks the caret; the whole text is one statement unless it has `;`. */
function complete(sqlWithCaret: string, dialect: "postgres" | "mysql" | "sqlite" = "postgres") {
  const offset = sqlWithCaret.indexOf("|");
  const text = sqlWithCaret.replace("|", "");
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset);
  const stmtStart = text.lastIndexOf(";", offset - 1) + 1;
  const nextSemi = text.indexOf(";", offset);
  const req: CompletionRequest = {
    text,
    offset,
    statementStart: stmtStart,
    statementEnd: nextSemi === -1 ? text.length : nextSemi,
    lineText: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd),
    column: offset - lineStart + 1,
    schema: SCHEMA,
    dialect,
  };
  const items = buildCompletions(req);
  // Monaco orders by plain code-point comparison of sortText.
  return [...items].sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0));
}

describe("buildCompletions", () => {
  it("offers the FROM table's columns first in SELECT, even when FROM comes after the caret", () => {
    const items = complete("SELECT | FROM users u");
    expect(items.slice(0, 3).map((i) => i.label)).toEqual(["id", "email", "createdAt"]);
    expect(items[0].detail).toBe("integer · users");
    // createdAt must be quoted or PostgreSQL folds it to createdat
    expect(items.find((i) => i.label === "createdAt")?.insertText).toBe('"createdAt"');
  });

  it("qualifies columns when several tables are in scope", () => {
    const labels = complete("SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE |").map((i) => i.label);
    expect(labels).toContain("u.email");
    expect(labels).toContain("o.total");
    expect(labels.indexOf("o.total")).toBeLessThan(labels.indexOf("SELECT"));
  });

  it("offers tables (with an alias only after FROM/JOIN) and FK join snippets", () => {
    const from = complete("SELECT * FROM |");
    expect(["table", "view"]).toContain(from[0].kind);
    expect(from.find((i) => i.label === "users")?.insertText).toBe("users us");

    const insert = complete("INSERT INTO |");
    expect(insert.find((i) => i.label === "users")?.insertText).toBe("users");

    const join = complete("SELECT * FROM orders o JOIN |");
    expect(join[0].insertText).toBe("users us ON us.id = o.user_id");
  });

  it("suggests FK conditions after ON", () => {
    const items = complete("SELECT * FROM orders o JOIN users u ON |");
    expect(items[0].insertText).toBe("o.user_id = u.id");
  });

  it("resolves alias.| to that table's columns only", () => {
    const items = complete("SELECT o.| FROM orders o");
    expect(items.map((i) => i.label)).toEqual(["id", "user_id", "total"]);
    expect(items.every((i) => i.replaceFromColumn === 10)).toBe(true);
  });

  it("lists a schema's tables after schema.", () => {
    expect(complete("SELECT * FROM app.|").map((i) => i.label)).toEqual(["audit_log"]);
  });

  it("offers clauses after a complete table reference", () => {
    const labels = complete("SELECT * FROM users u |").slice(0, 3).map((i) => i.label);
    expect(labels).toEqual(["JOIN", "LEFT JOIN", "INNER JOIN"]);
  });

  it("offers types after :: and in column definitions", () => {
    expect(complete("SELECT x::|")[0].kind).toBe("type");
    expect(complete("CREATE TABLE t (id |").map((i) => i.label)).toContain("bigint");
    expect(complete("CREATE TABLE t (m |").map((i) => i.label)).toContain("mood");
  });

  it("offers dialect builtins with signatures that open parameter hints", () => {
    const fn = complete("SELECT date_tr| FROM users").find((i) => i.label === "DATE_TRUNC");
    expect(fn?.detail).toBe("DATE_TRUNC(field, source, [time_zone]) → timestamp");
    expect(fn?.triggerParameterHints).toBe(true);
    expect(complete("SELECT | FROM users", "mysql").some((i) => i.label === "DATE_FORMAT")).toBe(true);
    expect(complete("SELECT | FROM users", "sqlite").some((i) => i.label === "DATE_TRUNC")).toBe(false);
  });

  it("only looks at the statement around the caret", () => {
    const items = complete("SELECT * FROM orders;\nSELECT | FROM users");
    expect(items[0].label).toBe("id");
    expect(items.some((i) => i.label === "total")).toBe(false);
  });
});

describe("buildCompletions — alias.column regressions (issue #28)", () => {
  const cols = (sql: string) => complete(sql).map((i) => i.label);

  it("resolves AS-style and JOIN aliases, case-insensitively", () => {
    expect(cols("SELECT * FROM users AS U WHERE u.|")).toEqual(["id", "email", "createdAt"]);
    expect(cols("SELECT * FROM users u JOIN orders o ON o.| ")).toEqual(["id", "user_id", "total"]);
  });

  it("resolves a single-letter alias on a line with several dots", () => {
    expect(cols("SELECT u.id, u.email, o.| FROM users u JOIN orders o ON o.user_id = u.id")).toEqual(["id", "user_id", "total"]);
  });

  it("resolves the bare table name, including schema-qualified tables", () => {
    expect(cols("SELECT users.| FROM users")).toEqual(["id", "email", "createdAt"]);
    expect(cols("SELECT audit_log.| FROM app.audit_log")).toEqual(["payload"]);
  });

  it("uses the cursor line for the range but the whole statement for aliases", () => {
    const items = complete("SELECT\n  o.|\nFROM orders o");
    expect(items.map((i) => i.label)).toEqual(["id", "user_id", "total"]);
    expect(items[0].replaceFromColumn).toBe(5);
  });

  it("offers nothing for an unknown qualifier", () => {
    expect(cols("SELECT nope.| FROM users")).toEqual([]);
  });
});
