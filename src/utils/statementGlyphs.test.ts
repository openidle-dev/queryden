import { describe, it, expect } from "vitest";
import {
  mapSelectionStatementsToDocumentLines,
  mergeGlyphResults,
} from "./statementGlyphs";

describe("mapSelectionStatementsToDocumentLines (#223)", () => {
  it("shifts selection-relative lines to document-absolute lines", () => {
    // A selection starting on document line 14 with two statements numbered
    // 1, 2 relative to the selection must map to 14, 16 — not stay at 1, 2.
    const out = mapSelectionStatementsToDocumentLines(
      [
        { text: "SELECT 1", lineNumber: 1 },
        { text: "SELECT 2", lineNumber: 3 },
      ],
      14,
    );
    expect(out).toEqual([
      { text: "SELECT 1", lineNumber: 14 },
      { text: "SELECT 2", lineNumber: 16 },
    ]);
  });

  it("keeps text unchanged and handles base line 1", () => {
    const out = mapSelectionStatementsToDocumentLines(
      [{ text: "SELECT 1", lineNumber: 1 }],
      1,
    );
    expect(out).toEqual([{ text: "SELECT 1", lineNumber: 1 }]);
  });

  it("clamps invalid base lines to 1", () => {
    const out = mapSelectionStatementsToDocumentLines(
      [{ text: "SELECT 1", lineNumber: 2 }],
      0,
    );
    expect(out[0].lineNumber).toBe(2);
  });

  it("returns empty for empty input", () => {
    expect(mapSelectionStatementsToDocumentLines([], 5)).toEqual([]);
  });
});

describe("mergeGlyphResults (#223)", () => {
  it("accumulates marks across runs instead of wiping", () => {
    const merged = mergeGlyphResults(
      [{ lineNumber: 1, status: "success" }],
      [{ lineNumber: 5, status: "success" }],
    );
    expect(merged.map((r) => r.lineNumber)).toEqual([1, 5]);
  });

  it("re-running a block replaces its mark in place", () => {
    const merged = mergeGlyphResults(
      [
        { lineNumber: 1, status: "success" },
        { lineNumber: 5, status: "success" },
      ],
      [{ lineNumber: 1, status: "error", error: "boom" }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ lineNumber: 1, status: "error" });
    expect(merged[1].lineNumber).toBe(5);
  });

  it("sorts by line number", () => {
    const merged = mergeGlyphResults(
      [{ lineNumber: 9, status: "success" }],
      [{ lineNumber: 3, status: "success" }],
    );
    expect(merged.map((r) => r.lineNumber)).toEqual([3, 9]);
  });
});
