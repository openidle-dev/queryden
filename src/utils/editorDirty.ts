/**
 * Pure dirty-state helpers for query editor tabs.
 *
 * A tab is "dirty" when closing it (or the app) would discard user edits.
 *
 * Rules (issue #121):
 *  - An untitled tab (one not opened from a saved query) is dirty iff it
 *    has non-empty content. `originalQuery` is `""` for these tabs.
 *  - A tab opened from a saved query is dirty iff the current `query`
 *    differs from the `originalQuery` it was opened with.
 *
 * `originalQuery` is a snapshot of "what the tab looked like the last time
 * it was in sync with persisted state" — either empty (new untitled tab)
 * or the saved query body at open / save time.
 *
 * The shape is deliberately structural so we don't force callers to pull
 * in the full `QueryTab` interface from `MainContent.tsx`.
 */
export interface DirtyCheckTab {
  /** Current editor text. */
  query: string;
  /**
   * Snapshot of the persisted text the tab was opened/saved with.
   * `undefined` is treated as `""` for legacy/in-flight tabs that
   * predate this field.
   */
  originalQuery?: string;
}

/** Returns true if the tab has unsaved changes. */
export function isTabDirty(tab: DirtyCheckTab): boolean {
  const original = tab.originalQuery ?? "";
  const current = tab.query ?? "";
  // Untitled empty tab — not dirty.
  if (original === "" && current === "") return false;
  return current !== original;
}

/** Returns all tabs that have unsaved changes. */
export function getDirtyTabs<T extends DirtyCheckTab>(tabs: T[]): T[] {
  return tabs.filter(isTabDirty);
}
