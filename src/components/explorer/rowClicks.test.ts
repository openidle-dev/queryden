import { describe, it, expect } from "vitest";
import { classifyRowClick } from "./rowClicks";

describe("classifyRowClick", () => {
  it("uses the browser's click count when it has one", () => {
    expect(classifyRowClick("conn-a", 2, 1000, null).isDouble).toBe(true);
  });

  it("detects a double-click by timing when the webview reports detail 1 twice", () => {
    const first = classifyRowClick("conn-a", 1, 1000, null);
    expect(first.isDouble).toBe(false);
    expect(classifyRowClick("conn-a", 1, 1300, first.next).isDouble).toBe(true);
  });

  it("opens once per double-click, even when detail and timing both say double", () => {
    const first = classifyRowClick("conn-a", 1, 1000, null);
    const second = classifyRowClick("conn-a", 2, 1200, first.next);
    expect(second.isDouble).toBe(true);
    // A third quick click starts a new sequence instead of re-opening.
    expect(classifyRowClick("conn-a", 3, 1350, second.next).isDouble).toBe(false);
  });

  it("does not combine clicks on different rows or slow clicks", () => {
    const first = classifyRowClick("conn-a", 1, 1000, null);
    expect(classifyRowClick("conn-b", 1, 1100, first.next).isDouble).toBe(false);
    expect(classifyRowClick("conn-a", 1, 2000, first.next).isDouble).toBe(false);
  });
});
