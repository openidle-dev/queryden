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
        shiftKey: false,
        altKey: true,
        key: "S",
      })
    ).toEqual({ type: "open-settings" });
  });

  // Regression test for issue #12:
  // Ctrl+Shift+F used to be double-bound — Monaco's editor swallowed it for
  // format-document while AppLayout also wanted it for global search. We
  // dropped the Monaco binding so the keystroke bubbles to AppLayout. This
  // test pins down that `matchGlobalShortcut` does NOT claim Ctrl+Shift+F
  // as a format-sql action — Ctrl+Shift+L is the canonical formatter, and
  // Ctrl+Shift+F is reserved for AppLayout's global search handler.
  it("does not claim Ctrl+Shift+F (reserved for global search; regression: #12)", () => {
    const action = matchGlobalShortcut({
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      key: "F",
    });
    expect(action).toBeNull();
  });

  it("returns null for unrelated keys", () => {
    expect(
      matchGlobalShortcut({
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        key: "a",
      })
    ).toBeNull();
    expect(
      matchGlobalShortcut({
        ctrlKey: true,
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
  // toggle now lives on Ctrl+\ (handled in AppLayout). This test pins down
  // the contract that no global shortcut handler reclaims Ctrl+D — if a
  // future change wires it back into the global table, this test should
  // flip red so the regression is caught before merge.
  it("does NOT map Ctrl+D to any global action (regression: #13)", () => {
    expect(
      matchGlobalShortcut({
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        key: "d",
      })
    ).toBeNull();
    expect(
      matchGlobalShortcut({
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        key: "D",
      })
    ).toBeNull();
  });
});
