/**
 * Pure helpers for the "run-status gutter glyphs" feature (the green/red
 * checkmarks shown next to each SQL block that has been run).
 *
 * The hard parts of that feature — placing a glyph on the right line and
 * accumulating one glyph per block across runs — used to be done with
 * frozen, run-time line numbers and got out of sync the moment the editor
 * text changed or a multi-statement *selection* was run (the substring's
 * line numbers were 1-based from the selection, not the document). These
 * helpers isolate the two bits of logic that are easy to get wrong so they
 * can be unit-tested without a live Monaco editor.
 */
import { splitStatements } from "./splitStatements";

export interface DocumentStatement {
  /** Trimmed statement text, without the terminating semicolon. */
  text: string;
  /** 1-based line number in the *document* where the statement begins. */
  lineNumber: number;
}

/**
 * Split a selection's text into top-level statements and map each one back to
 * its document-absolute 1-based line number.
 *
 * Why this exists: when the user runs a selection (or a multi-statement block),
 * the only text available downstream is the selected substring. Splitting that
 * substring gives line numbers relative to the *selection* (statement 2 might
 * report line 4 even though it sits on document line 14). The glyph then lands
 * on the wrong block. `selectionStartLine` is the document line where char 0 of
 * `selectionText` lives, so the document line is simply
 * `selectionStartLine + (relativeLine - 1)`.
 */
export function mapSelectionStatementsToDocumentLines(
  selectionText: string,
  selectionStartLine: number,
): DocumentStatement[] {
  return splitStatements(selectionText).map((s) => ({
    text: s.text,
    lineNumber: selectionStartLine + (s.lineNumber - 1),
  }));
}

/**
 * Accumulate run-status glyphs across runs.
 *
 * Each new run replaces any existing glyph that sits on the same line (it's a
 * re-run of that block) and appends the rest, so a tab keeps exactly one glyph
 * per distinct block that has been run rather than wiping the others every time
 * a single block is executed.
 */
export function mergeGlyphResults<T extends { lineNumber: number }>(
  existing: T[],
  incoming: T[],
): T[] {
  if (incoming.length === 0) return existing;
  const incomingLines = new Set(incoming.map((r) => r.lineNumber));
  const kept = existing.filter((r) => !incomingLines.has(r.lineNumber));
  return [...kept, ...incoming];
}
