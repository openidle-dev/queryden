import { describe, it, expect } from "vitest";
import { isTabDirty, getDirtyTabs } from "./editorDirty";

describe("isTabDirty", () => {
  it("treats an untitled empty tab as clean", () => {
    expect(isTabDirty({ query: "", originalQuery: "" })).toBe(false);
  });

  it("treats an untitled tab with content as dirty", () => {
    expect(isTabDirty({ query: "SELECT 1", originalQuery: "" })).toBe(true);
  });

  it("treats a saved unmodified tab as clean", () => {
    expect(isTabDirty({ query: "SELECT 1", originalQuery: "SELECT 1" })).toBe(false);
  });

  it("treats a saved modified tab as dirty", () => {
    expect(isTabDirty({ query: "SELECT 2", originalQuery: "SELECT 1" })).toBe(true);
  });

  it("treats `originalQuery: undefined` like an empty original (legacy tabs)", () => {
    expect(isTabDirty({ query: "" })).toBe(false);
    expect(isTabDirty({ query: "SELECT 1" })).toBe(true);
  });

  it("treats whitespace-only changes as dirty (exact text comparison)", () => {
    expect(isTabDirty({ query: "SELECT 1 ", originalQuery: "SELECT 1" })).toBe(true);
  });
});

describe("getDirtyTabs", () => {
  it("returns only dirty tabs", () => {
    const tabs = [
      { id: "a", query: "", originalQuery: "" },
      { id: "b", query: "SELECT 1", originalQuery: "" },
      { id: "c", query: "SELECT 1", originalQuery: "SELECT 1" },
      { id: "d", query: "SELECT 2", originalQuery: "SELECT 1" },
    ];
    expect(getDirtyTabs(tabs).map(t => t.id)).toEqual(["b", "d"]);
  });

  it("returns an empty array when nothing is dirty", () => {
    expect(getDirtyTabs([{ query: "", originalQuery: "" }])).toEqual([]);
  });
});
