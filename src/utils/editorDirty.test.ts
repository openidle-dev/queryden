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

  // Regression test for issue #138: when the same saved query is open in
  // multiple tabs and one tab saves, the other tab's originalQuery must
  // be refreshed to the new persisted text. Before the fix, Tab B would
  // incorrectly appear dirty even though its content matched the on-disk
  // text — the exit warning would fire for a tab that was actually clean.
  it("cross-tab sync: other tabs sharing a saved query appear clean after originalQuery refresh (#138)", () => {
    // Simulate two tabs opened from the same saved query "Foo" (text: "SELECT 1")
    const tabA = { id: "a", query: "SELECT 1", originalQuery: "SELECT 1" };
    const tabB = { id: "b", query: "SELECT 1", originalQuery: "SELECT 1" };

    // User edits Tab A to "SELECT 2" and saves
    // → Tab A: originalQuery refreshed to "SELECT 2"
    // → Tab B: originalQuery refreshed to "SELECT 2" (cross-tab sync)

    // After save + sync, Tab A is clean
    const tabASynced = { ...tabA, query: "SELECT 2", originalQuery: "SELECT 2" };
    expect(isTabDirty(tabASynced)).toBe(false);

    // Tab B: user independently edits to "SELECT 2" (same as saved text)
    // Without cross-tab sync, originalQuery would still be "SELECT 1" → dirty
    // With cross-tab sync, originalQuery is "SELECT 2" → clean
    const tabBSynced = { ...tabB, query: "SELECT 2", originalQuery: "SELECT 2" };
    expect(isTabDirty(tabBSynced)).toBe(false);

    // Verify: without the sync (stale originalQuery), Tab B would be dirty
    const tabBStale = { ...tabB, query: "SELECT 2", originalQuery: "SELECT 1" };
    expect(isTabDirty(tabBStale)).toBe(true);

    // Verify: getDirtyTabs with all three states
    const tabs = [tabASynced, tabBSynced, tabBStale];
    expect(getDirtyTabs(tabs).map(t => t.id)).toEqual(["b"]);
  });
});
