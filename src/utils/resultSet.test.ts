import { describe, expect, it } from "vitest";
import { hasRowSet, isGridInternalKey } from "./resultSet";

describe("hasRowSet", () => {
  it("is true for an empty result that still has columns", () => {
    expect(hasRowSet([], ["id", "started", "status"])).toBe(true);
  });

  it("is true when rows are present", () => {
    expect(hasRowSet([{ id: 1 }], undefined)).toBe(true);
  });

  it("is false when nothing came back", () => {
    expect(hasRowSet([], [])).toBe(false);
    expect(hasRowSet([], undefined)).toBe(false);
  });
});

describe("isGridInternalKey", () => {
  it("matches only the grid's own bookkeeping keys", () => {
    expect(isGridInternalKey("_isNew")).toBe(true);
    expect(isGridInternalKey("_original")).toBe(true);
    expect(isGridInternalKey("_source_database")).toBe(true);
    expect(isGridInternalKey("_id")).toBe(false);
    expect(isGridInternalKey("_created")).toBe(false);
  });
});
