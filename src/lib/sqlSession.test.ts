import { describe, it, expect } from "vitest";
import { errorPosition, primaryRowSet, toRowObjects, transactionEffect } from "./sqlSession";

describe("toRowObjects", () => {
  it("keeps duplicate column names as distinct keys", () => {
    const out = toRowObjects({
      columns: [{ name: "id", typeName: "INT4" }, { name: "id", typeName: "INT4" }, { name: "v", typeName: "TEXT" }],
      rows: [[1, 2, null]],
      rowsAffected: 1,
      truncated: false,
    });
    expect(out.columns).toEqual(["id", "id (2)", "v"]);
    expect(out.rows).toEqual([{ id: 1, "id (2)": 2, v: null }]);
  });
});

describe("primaryRowSet", () => {
  it("prefers the last set that returned columns", () => {
    const sets = [
      { columns: [{ name: "a", typeName: "INT4" }], rows: [[1]], rowsAffected: 1, truncated: false },
      { columns: [], rows: [], rowsAffected: 3, truncated: false },
    ];
    expect(primaryRowSet({ results: sets, notices: [] })).toBe(sets[0]);
    expect(primaryRowSet({ results: [sets[1]], notices: [] })).toBeUndefined();
  });
});

describe("transactionEffect", () => {
  it.each([
    ["BEGIN", "begin"],
    ["BEGIN ISOLATION LEVEL SERIALIZABLE", "begin"],
    ["START TRANSACTION", "begin"],
    ["COMMIT", "end"],
    ["END", "end"],
    ["ROLLBACK", "end"],
    ["ROLLBACK TO SAVEPOINT a", null],
    ["ROLLBACK TO a", null],
    ["BEGIN ATOMIC", null],
    ["SELECT 1", null],
  ])("%s → %s", (sql, effect) => {
    expect(transactionEffect(sql)).toBe(effect);
  });
});

describe("errorPosition", () => {
  it("reads the 1-based server position as a 0-based offset", () => {
    expect(errorPosition('ERROR:  relation "x" does not exist\nPOSITION: 15\nSQLSTATE: 42P01')).toBe(14);
    expect(errorPosition("ERROR: boom")).toBeNull();
  });
});
