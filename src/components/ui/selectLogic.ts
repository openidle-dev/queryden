/**
 * Pure helpers behind the Select listbox: keyboard movement over options
 * (skipping disabled ones), type-to-select, and where the open list goes so
 * it stays inside the window.
 */

export interface SelectableOption {
  label: string;
  value: string;
  disabled?: boolean;
}

/** The next enabled option from `from` in direction `step` (±1), wrapping; -1 when none is enabled. */
export function nextEnabledIndex(options: readonly SelectableOption[], from: number, step: 1 | -1): number {
  const n = options.length;
  if (n === 0) return -1;
  let i = from;
  for (let tries = 0; tries < n; tries++) {
    i = (((i + step) % n) + n) % n;
    if (!options[i].disabled) return i;
  }
  return -1;
}

/** First (`edge` = "first") or last enabled option; -1 when none is enabled. */
export function edgeEnabledIndex(options: readonly SelectableOption[], edge: "first" | "last"): number {
  return edge === "first" ? nextEnabledIndex(options, -1, 1) : nextEnabledIndex(options, options.length, -1);
}

/**
 * The option a typed prefix selects, searching after `from` and wrapping, so
 * typing the same letter again cycles through options starting with it.
 */
export function typeaheadIndex(options: readonly SelectableOption[], typed: string, from: number): number {
  const needle = typed.toLowerCase();
  if (!needle) return -1;
  const n = options.length;
  // A repeated single letter ("ppp") cycles like a single "p".
  const cycling = needle.length > 1 && [...needle].every((c) => c === needle[0]);
  const prefix = cycling ? needle[0] : needle;
  const start = cycling || needle.length === 1 ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const option = options[i];
    if (!option.disabled && option.label.toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

const MARGIN = 4;
const GAP = 4;
/** Lists never grow past this; longer ones scroll. */
export const MAX_LIST_HEIGHT = 320;

export interface ListboxPlacement {
  top: number;
  left: number;
  minWidth: number;
  maxHeight: number;
}

/**
 * Below the trigger when the list fits there (or there is more room below),
 * otherwise above it; shifted left to stay inside the window, and capped to
 * the room on the chosen side.
 */
export function placeListbox(
  trigger: { top: number; bottom: number; left: number; width: number },
  list: { width: number; height: number },
  viewport: { width: number; height: number },
): ListboxPlacement {
  const roomBelow = viewport.height - trigger.bottom - GAP - MARGIN;
  const roomAbove = trigger.top - GAP - MARGIN;
  const wanted = Math.min(list.height, MAX_LIST_HEIGHT);
  const below = wanted <= roomBelow || roomBelow >= roomAbove;
  const maxHeight = Math.max(0, Math.min(MAX_LIST_HEIGHT, below ? roomBelow : roomAbove));
  const height = Math.min(wanted, maxHeight);
  const width = Math.max(list.width, trigger.width);
  const left = Math.max(MARGIN, Math.min(trigger.left, viewport.width - width - MARGIN));
  const top = below ? trigger.bottom + GAP : trigger.top - GAP - height;
  return { top, left, minWidth: trigger.width, maxHeight };
}
