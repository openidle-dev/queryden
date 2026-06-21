import { describe, it, expect } from "vitest";
import {
  mapSelectionStatementsToDocumentLines,
  mergeGlyphResults,
} from "./statementGlyphs";

describe("mapSelectionStatementsToDocumentLines", () => {
  it("maps a single-statement selection to its document line", () => {
    // Selection that starts on document line 6.
    const out = mapSelectionStatementsToDocumentLines("SELECT 1", 6);
    expect(out).toEqual([{ text: "SELECT 1", lineNumber: 6 }]);
  });

  it("offsets every statement's line by the selection's start line", () => {
    // Two statements; relative lines 1 and 3 inside the selection.
    const selection = "SELECT 1;\n\nSELECT 2";
    const out = mapSelectionStatementsToDocumentLines(selection, 6);
    // The regression: previously these came back as 1 and 3 (relative to the
    // selection) so the glyphs landed on document lines 1 and 3 instead of 6/8.
    expect(out).toEqual([
      { text: "SELECT 1", lineNumber: 6 },
      { text: "SELECT 2", lineNumber: 8 },
    ]);
  });

  it("treats a selection starting on line 1 as document-absolute already", () => {
    const out = mapSelectionStatementsToDocumentLines("SELECT 1;\nSELECT 2", 1);
    expect(out).toEqual([
      { text: "SELECT 1", lineNumber: 1 },
      { text: "SELECT 2", lineNumber: 2 },
    ]);
  });

  it("returns an empty list for whitespace-only selections", () => {
    expect(mapSelectionStatementsToDocumentLines("   \n  ", 4)).toEqual([]);
  });
});

describe("mergeGlyphResults", () => {
  it("appends a glyph for a newly-run block, keeping the others", () => {
    const existing = [{ lineNumber: 1, status: "success" }];
    const incoming = [{ lineNumber: 6, status: "success" }];
    expect(mergeGlyphResults(existing, incoming)).toEqual([
      { lineNumber: 1, status: "success" },
      { lineNumber: 6, status: "success" },
    ]);
  });

  it("replaces the glyph on a re-run of the same line", () => {
    const existing = [
      { lineNumber: 1, status: "success", executionTime: 5 },
      { lineNumber: 6, status: "error", executionTime: 9 },
    ];
    const incoming = [{ lineNumber: 6, status: "success", executionTime: 2 }];
    expect(mergeGlyphResults(existing, incoming)).toEqual([
      { lineNumber: 1, status: "success", executionTime: 5 },
      { lineNumber: 6, status: "success", executionTime: 2 },
    ]);
  });

  it("returns existing unchanged when there's nothing incoming", () => {
    const existing = [{ lineNumber: 1, status: "success" }];
    expect(mergeGlyphResults(existing, [])).toBe(existing);
  });
});
