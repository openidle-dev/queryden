import { describe, expect, it } from "vitest";
import { edgeEnabledIndex, nextEnabledIndex, placeListbox, typeaheadIndex } from "./selectLogic";

const opts = [
  { label: "Loading…", value: "__loading__", disabled: true },
  { label: "odoo", value: "odoo" },
  { label: "odoo_test", value: "odoo_test" },
  { label: "postgres", value: "postgres" },
  { label: "template1", value: "template1", disabled: true },
];

describe("nextEnabledIndex", () => {
  it("skips disabled options and wraps", () => {
    expect(nextEnabledIndex(opts, 3, 1)).toBe(1);
    expect(nextEnabledIndex(opts, 1, -1)).toBe(3);
    expect(nextEnabledIndex(opts, -1, 1)).toBe(1);
  });

  it("returns -1 when nothing is enabled", () => {
    expect(nextEnabledIndex([{ label: "x", value: "x", disabled: true }], 0, 1)).toBe(-1);
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
  });
});

describe("edgeEnabledIndex", () => {
  it("finds the first and last enabled option", () => {
    expect(edgeEnabledIndex(opts, "first")).toBe(1);
    expect(edgeEnabledIndex(opts, "last")).toBe(3);
  });
});

describe("typeaheadIndex", () => {
  it("matches a typed prefix, ignoring case and disabled options", () => {
    expect(typeaheadIndex(opts, "P", 0)).toBe(3);
    expect(typeaheadIndex(opts, "t", 0)).toBe(-1);
    expect(typeaheadIndex(opts, "odoo_", 1)).toBe(2);
  });

  it("cycles through options on a repeated letter", () => {
    expect(typeaheadIndex(opts, "o", 1)).toBe(2);
    expect(typeaheadIndex(opts, "oo", 2)).toBe(1);
  });
});

describe("placeListbox", () => {
  const viewport = { width: 1000, height: 600 };

  it("opens below the trigger when it fits", () => {
    expect(placeListbox({ top: 100, bottom: 128, left: 50, width: 160 }, { width: 120, height: 200 }, viewport)).toEqual({
      top: 132, left: 50, minWidth: 160, maxHeight: 320,
    });
  });

  it("opens above when there is no room below", () => {
    const p = placeListbox({ top: 520, bottom: 548, left: 50, width: 160 }, { width: 160, height: 300 }, viewport);
    expect(p.top).toBe(520 - 4 - 300);
    expect(p.maxHeight).toBe(320);
  });

  it("caps the height to the room available and keeps it inside the window", () => {
    const p = placeListbox({ top: 250, bottom: 278, left: 950, width: 160 }, { width: 200, height: 900 }, viewport);
    expect(p.maxHeight).toBe(600 - 278 - 4 - 4);
    expect(p.left).toBe(1000 - 200 - 4);
  });
});
