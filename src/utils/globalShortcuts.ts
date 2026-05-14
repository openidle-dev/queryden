/**
 * Pure mapping from a keyboard event's modifier/key shape to a global shortcut
 * action. Extracted from App.tsx so the binding table is unit-testable
 * (Vitest runs with environment: "node" — no DOM, no React).
 *
 * `dispatchEvent` is the name of the CustomEvent the global handler should fire
 * on `window` when the shortcut matches. It must match a listener registered
 * somewhere in the app (see QueryEditor.tsx for the `format-sql` listener).
 *
 * Adding a new global shortcut: add a row here, then wire the corresponding
 * branch in App.tsx (or, ideally, drive it directly from this table).
 */
export type GlobalShortcutAction =
  | { type: "open-help" }
  | { type: "open-settings" }
  | { type: "dispatch-event"; name: string };

export interface ShortcutKeyEvent {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

export function matchGlobalShortcut(
  e: ShortcutKeyEvent
): GlobalShortcutAction | null {
  // Ctrl+H — Help
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "h") {
    return { type: "open-help" };
  }

  // Ctrl+Alt+S — Settings
  if (e.ctrlKey && e.altKey && e.key === "S") {
    return { type: "open-settings" };
  }

  // Ctrl+Shift+L — Format SQL.
  // NOTE: the event name MUST be "format-sql" — that is what
  // QueryEditor.tsx listens for. Issue #9 was a mismatch where this used to
  // dispatch "format-code", so the shortcut silently did nothing.
  if (e.ctrlKey && e.shiftKey && e.key === "L") {
    return { type: "dispatch-event", name: "format-sql" };
  }

  return null;
}
