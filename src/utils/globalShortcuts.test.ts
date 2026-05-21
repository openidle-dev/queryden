import { describe, it, expect } from "vitest";
import { matchGlobalShortcut } from "./globalShortcuts";

// Regression test for issue #9:
// Ctrl+Shift+L is the user-facing "Format SQL" shortcut. Previously the
// global handler dispatched `format-code`, but the listener in
// `QueryEditor.tsx` was registered for `format-sql`, so pressing the
// shortcut did nothing. This test pins down the contract that the
// dispatched event name matches what QueryEditor listens for.
describe("matchGlobalShortcut", () => {
  it("maps Ctrl+Shift+L to a 'format-sql' window event (regression: #9)", () => {
    const action = matchGlobalShortcut({
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      key: "L",
    });
    expect(action).toEqual({ type: "dispatch-event", name: "format-sql" });
  });

  it("maps Ctrl+H to open-help", () => {
    expect(
      matchGlobalShortcut({
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        key: "h",
      })
    ).toEqual({ type: "open-help" });
  });

  it("maps Ctrl+Alt+S to open-settings", () => {
    expect(
      matchGlobalShortcut({
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: true,
        key: "S",
      })
    ).toEqual({ type: "open-settings" });
  });

  it("maps Cmd+Shift+L to format-sql on macOS", () => {
    const action = matchGlobalShortcut({
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      key: "L",
    });
    expect(action).toEqual({ type: "dispatch-event", name: "format-sql" });
  });

  it("maps Cmd+H to open-help on macOS", () => {
    expect(
      matchGlobalShortcut({
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        key: "h",
      })
    ).toEqual({ type: "open-help" });
  });

  it("maps Ctrl+Shift+F to toggle-search", () => {
    const action = matchGlobalShortcut({
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      key: "F",
    });
    expect(action).toEqual({ type: "dispatch-event", name: "toggle-search" });
  });

  it("maps Ctrl+Shift+E to toggle-explorer", () => {
    const action = matchGlobalShortcut({
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      key: "E",
    });
    expect(action).toEqual({ type: "dispatch-event", name: "toggle-explorer" });
  });

  it("maps Cmd+Shift+F to toggle-search on macOS", () => {
    const action = matchGlobalShortcut({
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      key: "F",
    });
    expect(action).toEqual({ type: "dispatch-event", name: "toggle-search" });
  });

  it("maps Cmd+Shift+E to toggle-explorer on macOS", () => {
    const action = matchGlobalShortcut({
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      key: "E",
    });
    expect(action).toEqual({ type: "dispatch-event", name: "toggle-explorer" });
  });

  it("returns null for unrelated keys", () => {
    expect(
      matchGlobalShortcut({
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        key: "a",
      })
    ).toBeNull();
    expect(
      matchGlobalShortcut({
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        key: "L",
      })
    ).toBeNull();
  });

  // Regression test for issue #13:
  // Ctrl+D used to toggle the Database Explorer (wired locally in
  // AppLayout.tsx), but it shadowed Monaco's "add selection to next
  // occurrence" multi-cursor binding inside the SQL editor. The explorer
  // toggle now lives on Ctrl+Shift+E (handled in AppLayout). This test pins down
  // the contract that no global shortcut handler reclaims Ctrl+D — if a
  // future change wires it back into the global table, this test should
  // flip red so the regression is caught before merge.
  it("does NOT map Ctrl+D to any global action (regression: #13)", () => {
    expect(
      matchGlobalShortcut({
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        key: "d",
      })
    ).toBeNull();
    expect(
      matchGlobalShortcut({
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        key: "D",
      })
    ).toBeNull();
  });
});
