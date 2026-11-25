import { describe, expect, it } from "vitest";
import { placeFlyout } from "./Menu";

const viewport = { width: 1000, height: 600 };
const panel = { width: 192, height: 150 };

describe("placeFlyout", () => {
  it("opens right and down when there is room", () => {
    expect(placeFlyout({ top: 100, left: 200, right: 424 }, panel, viewport)).toEqual({ side: "right", top: 0 });
  });

  it("shifts up so the panel ends inside the window (drop-up)", () => {
    // Trigger near the bottom: 560 + 150 would end 110px past the 596px limit.
    expect(placeFlyout({ top: 560, left: 200, right: 424 }, panel, viewport)).toEqual({ side: "right", top: -114 });
  });

  it("flips left when the right side has no room", () => {
    expect(placeFlyout({ top: 100, left: 700, right: 924 }, panel, viewport).side).toBe("left");
  });

  it("stays right when neither side fits", () => {
    expect(placeFlyout({ top: 100, left: 50, right: 990 }, panel, viewport).side).toBe("right");
  });

  it("never shifts above the top of the window", () => {
    const tall = { width: 192, height: 900 };
    expect(placeFlyout({ top: 40, left: 200, right: 424 }, tall, viewport).top).toBe(-36);
  });
});
