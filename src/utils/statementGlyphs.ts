/**
 * Pure helpers for per-statement run-status gutter glyphs (issue #223).
 *
 * Why this exists: the editor paints one gutter glyph (✓/✗) per executed
 * SQL block. Three bugs shared one root cause — glyphs were stored as line
 * numbers frozen at run time:
 *   1. A multi-statement *selection* was re-split and its statements
 *      numbered relative to the selection (1, 2, 3…) instead of the
 *      document, so glyphs landed on the wrong block.
 *   2. `statementResults` was reset to `[]` at the start of every run, so
 *      running block 2 erased block 1's checkmark.
 *   3. Glyphs were re-pinned to frozen lines on every render, fighting
 *      Monaco's sticky tracking, so they didn't follow edits.
 *
 * These helpers are the pure core: mapping selection-relative lines back to
 * document-absolute lines, and accumulating glyphs (one per block).
 * Stickiness itself lives in `QueryEditor.tsx` (id-keyed Monaco
 * decorations + throttled prune on content change).
 */

export interface GlyphStatement {
  /** Trimmed statement text, without the terminating semicolon. */
  text: string;
  /** 1-based document-absolute line number where the statement begins. */
  lineNumber: number;
}

export interface GlyphResult {
  /** 1-based document line number of the block. */
  lineNumber: number;
  status: "running" | "success" | "error";
  rowsAffected?: number;
  rowCount?: number;
  error?: string | null;
  executionTime?: number;
}

/**
 * Map a selection's re-split statements back to document-absolute lines.
 *
 * `splitStatements(selectionText)` numbers lines from 1 relative to the
 * selection. Given the 1-based document line where the selection starts
 * (`baseLine`), shift each statement: `absolute = baseLine + relative - 1`.
 * The statement text is passed through unchanged.
 */
export function mapSelectionStatementsToDocumentLines(
  selectionStatements: GlyphStatement[],
  baseLine: number,
): GlyphStatement[] {
  const base = Math.max(1, Math.floor(baseLine) || 1);
  return selectionStatements.map((s) => ({
    text: s.text,
    lineNumber: base + s.lineNumber - 1,
  }));
}

/**
 * Accumulate glyph results across runs: one mark per block.
 *
 * Re-running a block replaces its mark in place (matched by `lineNumber`);
 * otherwise the new mark is appended. The result is sorted by line so the
 * gutter reads top-to-bottom.
 */
export function mergeGlyphResults(
  prev: GlyphResult[],
  next: GlyphResult[],
): GlyphResult[] {
  const byLine = new Map<number, GlyphResult>();
  for (const r of prev) byLine.set(r.lineNumber, r);
  for (const r of next) byLine.set(r.lineNumber, r);
  return [...byLine.values()].sort((a, b) => a.lineNumber - b.lineNumber);
}
