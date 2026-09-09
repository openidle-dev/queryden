import { describe, it, expect } from "vitest";
import {
  mapMysqlColumns,
  mapMysqlRoutineNames,
  mapSqliteMasterNames,
  mapSqlitePragmaColumns,
  mapSqliteForeignKeys,
  quoteSqliteIdentifier,
} from "./schemaMappings";

describe("mapMysqlColumns", () => {
  it("returns column pairs from information_schema.COLUMNS rows", () => {
    const rows = [
      { TABLE_NAME: "users", COLUMN_NAME: "id" },
      { TABLE_NAME: "users", COLUMN_NAME: "email" },
      { TABLE_NAME: "posts", COLUMN_NAME: "id" },
    ];
    expect(mapMysqlColumns(rows)).toEqual([
      { table_name: "users", column_name: "id" },
      { table_name: "users", column_name: "email" },
      { table_name: "posts", column_name: "id" },
    ]);
  });

  it("drops rows with non-string TABLE_NAME or COLUMN_NAME", () => {
    const rows = [
      { TABLE_NAME: 123, COLUMN_NAME: "id" },
      { TABLE_NAME: "users", COLUMN_NAME: null },
      { TABLE_NAME: "users", COLUMN_NAME: "name" },
    ];
    expect(mapMysqlColumns(rows)).toEqual([
      { table_name: "users", column_name: "name" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(mapMysqlColumns([])).toEqual([]);
  });

  it("handles undefined/null rows gracefully", () => {
    expect(mapMysqlColumns([undefined as any, null as any])).toEqual([]);
  });
});

describe("mapMysqlRoutineNames", () => {
  it("extracts routine names from ROUTINE_NAME rows", () => {
    expect(mapMysqlRoutineNames([
      { ROUTINE_NAME: "get_user_count" },
      { ROUTINE_NAME: "calc_total" },
    ])).toEqual(["get_user_count", "calc_total"]);
  });

  it("drops rows with non-string or empty ROUTINE_NAME", () => {
    expect(mapMysqlRoutineNames([
      { ROUTINE_NAME: 42 },
      { ROUTINE_NAME: "" },
      { ROUTINE_NAME: "valid_func" },
    ])).toEqual(["valid_func"]);
  });

  it("returns empty for empty input", () => {
    expect(mapMysqlRoutineNames([])).toEqual([]);
  });
});

describe("mapSqliteMasterNames", () => {
  it("returns table/view names and skips sqlite_ internals", () => {
    expect(mapSqliteMasterNames([
      { name: "users" },
      { name: "sqlite_sequence" },
      { name: "posts" },
      { name: "sqlite_stat1" },
    ])).toEqual(["users", "posts"]);
  });

  it("skips empty names", () => {
    expect(mapSqliteMasterNames([{ name: "" }, { name: "ok" }])).toEqual(["ok"]);
  });

  it("returns empty for empty input", () => {
    expect(mapSqliteMasterNames([])).toEqual([]);
  });
});

describe("mapSqlitePragmaColumns", () => {
  it("maps PRAGMA table_info rows to column pairs for the given table", () => {
    expect(mapSqlitePragmaColumns("users", [
      { name: "id" },
      { name: "email" },
    ])).toEqual([
      { table_name: "users", column_name: "id" },
      { table_name: "users", column_name: "email" },
    ]);
  });

  it("drops rows with empty or non-string name", () => {
    expect(mapSqlitePragmaColumns("t", [
      { name: "" },
      { name: 123 },
      { name: "col" },
    ])).toEqual([
      { table_name: "t", column_name: "col" },
    ]);
  });

  it("returns empty for empty input", () => {
    expect(mapSqlitePragmaColumns("t", [])).toEqual([]);
  });
});

describe("mapSqliteForeignKeys", () => {
  it("maps PRAGMA foreign_key_list rows to FK quads", () => {
    expect(mapSqliteForeignKeys("orders", [
      { table: "users", from: "user_id", to: "id" },
      { table: "products", from: "product_id", to: "id" },
    ])).toEqual([
      { source_table: "orders", source_column: "user_id", target_table: "users", target_column: "id" },
      { source_table: "orders", source_column: "product_id", target_table: "products", target_column: "id" },
    ]);
  });

  it("drops incomplete FK rows (missing any leg)", () => {
    expect(mapSqliteForeignKeys("t", [
      { table: "ref", from: "a", to: "id" },       // valid
      { table: "ref", from: "b", to: "" },           // missing to
      { table: "", from: "c", to: "id" },            // missing table
      { table: "ref", from: "", to: "id" },          // missing from
      { table: null, from: "d", to: "id" },          // null table
    ])).toEqual([
      { source_table: "t", source_column: "a", target_table: "ref", target_column: "id" },
    ]);
  });

  it("returns empty for empty input", () => {
    expect(mapSqliteForeignKeys("t", [])).toEqual([]);
  });
});

describe("quoteSqliteIdentifier", () => {
  it("wraps identifier in double quotes", () => {
    expect(quoteSqliteIdentifier("users")).toBe('"users"');
  });

  it("doubles embedded double quotes", () => {
    expect(quoteSqliteIdentifier('my"table')).toBe('"my""table"');
  });

  it("handles empty string", () => {
    expect(quoteSqliteIdentifier("")).toBe('""');
  });
});
