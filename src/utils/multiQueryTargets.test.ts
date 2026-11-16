import { describe, expect, it } from "vitest";
import { isSaveShortcut, pruneMissingDatabases, restoreTargets, savedQueryConnectionId } from "./multiQueryTargets";

describe("restoreTargets", () => {
  it("keeps targets on known connections in saved order", () => {
    const saved = [
      { connectionId: "a", database: "db1" },
      { connectionId: "b", database: "db4" },
    ];
    expect(restoreTargets(saved, ["a", "b"])).toEqual(saved);
  });

  it("drops targets for deleted connections, malformed entries and duplicates", () => {
    const saved = [
      { connectionId: "a", database: "db1" },
      { connectionId: "gone", database: "db2" },
      { connectionId: "a", database: "db1" },
      { connectionId: "a", database: "" },
      { connectionId: "a" },
      null,
      "a/db3",
    ];
    expect(restoreTargets(saved, ["a"])).toEqual([{ connectionId: "a", database: "db1" }]);
  });

  it("returns nothing for a missing or non-array setting", () => {
    expect(restoreTargets(undefined, ["a"])).toEqual([]);
    expect(restoreTargets({ connectionId: "a", database: "db1" }, ["a"])).toEqual([]);
  });
});

describe("pruneMissingDatabases", () => {
  const targets = [
    { connectionId: "a", database: "db1" },
    { connectionId: "a", database: "dropped" },
    { connectionId: "b", database: "db4" },
  ];

  it("drops databases absent from a fetched list", () => {
    expect(pruneMissingDatabases(targets, { a: ["db1"], b: ["db4"] })).toEqual([
      { connectionId: "a", database: "db1" },
      { connectionId: "b", database: "db4" },
    ]);
  });

  it("keeps targets on connections whose list was not fetched", () => {
    expect(pruneMissingDatabases(targets, { a: ["db1"] })).toEqual([
      { connectionId: "a", database: "db1" },
      { connectionId: "b", database: "db4" },
    ]);
  });
});

describe("savedQueryConnectionId", () => {
  it("uses the shared connection when every target is on one", () => {
    expect(savedQueryConnectionId([
      { connectionId: "a", database: "db1" },
      { connectionId: "a", database: "db4" },
    ])).toBe("a");
  });

  it("is unscoped when targets span connections or are empty", () => {
    expect(savedQueryConnectionId([
      { connectionId: "a", database: "db1" },
      { connectionId: "b", database: "db1" },
    ])).toBe("");
    expect(savedQueryConnectionId([])).toBe("");
  });
});

describe("isSaveShortcut", () => {
  const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
    key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods,
  });

  it("matches Ctrl+S and Cmd+S in either case", () => {
    expect(isSaveShortcut(key("s", { ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(key("S", { ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(key("s", { metaKey: true }))).toBe(true);
  });

  it("ignores plain S and shifted/alt variants", () => {
    expect(isSaveShortcut(key("s"))).toBe(false);
    expect(isSaveShortcut(key("s", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSaveShortcut(key("s", { ctrlKey: true, altKey: true }))).toBe(false);
  });
});
