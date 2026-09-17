import { describe, it, expect } from "vitest";
import { needsReconnect } from "./connectionTargeting";

describe("needsReconnect", () => {
  it("reconnects when there is no handle at all", () => {
    expect(
      needsReconnect({ hasHandle: false, activeConnectionId: "a", selectedDatabase: "app" }),
    ).toBe(true);
  });

  it("does not reconnect for a tab with no target", () => {
    expect(
      needsReconnect({ hasHandle: true, activeConnectionId: "a", selectedDatabase: "app" }),
    ).toBe(false);
  });

  it("does not reconnect when the target is where we already are", () => {
    // This is the regression that made every press of Run pay a full
    // connection handshake. New tabs inherit their neighbour's connection, so
    // nearly every tab carries a target; treating "has a target" as "needs a
    // new connection" meant reconnecting before every single statement.
    expect(
      needsReconnect({
        hasHandle: true,
        target: { connectionId: "a", database: "app" },
        activeConnectionId: "a",
        selectedDatabase: "app",
      }),
    ).toBe(false);
  });

  it("reconnects when the target names a different connection", () => {
    expect(
      needsReconnect({
        hasHandle: true,
        target: { connectionId: "other", database: "app" },
        activeConnectionId: "a",
        selectedDatabase: "app",
      }),
    ).toBe(true);
  });

  it("reconnects when the target names a different database", () => {
    expect(
      needsReconnect({
        hasHandle: true,
        target: { connectionId: "a", database: "reporting" },
        activeConnectionId: "a",
        selectedDatabase: "app",
      }),
    ).toBe(true);
  });

  it("treats a target with no database as 'whatever is selected'", () => {
    expect(
      needsReconnect({
        hasHandle: true,
        target: { connectionId: "a" },
        activeConnectionId: "a",
        selectedDatabase: "",
      }),
    ).toBe(false);
  });

  it("still reconnects for a database-less target on another connection", () => {
    expect(
      needsReconnect({
        hasHandle: true,
        target: { connectionId: "other" },
        activeConnectionId: "a",
        selectedDatabase: "app",
      }),
    ).toBe(true);
  });
});
