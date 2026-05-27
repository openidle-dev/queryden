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
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

export function matchGlobalShortcut(
  e: ShortcutKeyEvent
): GlobalShortcutAction | null {
  const isMod = e.ctrlKey || e.metaKey;
  const keyLower = e.key.toLowerCase();

  // Ctrl+H or Cmd+H — Help
  // Note: On Mac, Cmd+H hides the window, but Ctrl+H is still matched.
  if (isMod && !e.altKey && !e.shiftKey && keyLower === "h") {
    return { type: "open-help" };
  }

  // Ctrl+Alt+S or Cmd+Option+S — Settings
  if (isMod && e.altKey && !e.shiftKey && keyLower === "s") {
    return { type: "open-settings" };
  }

  // Ctrl+Shift+E or Cmd+Shift+E — Toggle Database Explorer
  if (isMod && e.shiftKey && !e.altKey && keyLower === "e") {
    return { type: "dispatch-event", name: "toggle-explorer" };
  }

  // Ctrl+Shift+F or Cmd+Shift+F — Toggle Search
  if (isMod && e.shiftKey && !e.altKey && keyLower === "f") {
    return { type: "dispatch-event", name: "toggle-search" };
  }

  // Ctrl+Shift+L or Cmd+Shift+L — Format SQL
  if (isMod && e.shiftKey && !e.altKey && keyLower === "l") {
    return { type: "dispatch-event", name: "format-sql" };
  }

  // Ctrl+PageUp or Cmd+PageUp — Previous Tab
  if (isMod && !e.altKey && !e.shiftKey && keyLower === "pageup") {
    return { type: "dispatch-event", name: "switch-to-previous-tab" };
  }

  // Ctrl+PageDown or Cmd+PageDown — Next Tab
  if (isMod && !e.altKey && !e.shiftKey && keyLower === "pagedown") {
    return { type: "dispatch-event", name: "switch-to-next-tab" };
  }

  return null;
}
