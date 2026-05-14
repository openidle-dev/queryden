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
});
