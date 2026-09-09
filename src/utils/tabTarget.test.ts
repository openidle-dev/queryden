import { describe, it, expect } from "vitest";
import { resolveNewTabTarget } from "./tabTarget";

const KNOWN = [
  { id: "conn-a", name: "Prod PG", database: "shop" },
  { id: "conn-b", name: "Dev MySQL", database: "dev" },
];

describe("resolveNewTabTarget", () => {
  it("prefers explicit context-menu params", () => {
    expect(resolveNewTabTarget({
      explicitConnectionId: "conn-b",
      explicitConnectionName: "Dev MySQL",
      explicitDatabase: "dev",
      activeConnId: "conn-a",
      activeConnName: "Prod PG",
      selectedDb: "shop",
      knownConnections: KNOWN,
    })).toEqual({ connectionId: "conn-b", connectionName: "Dev MySQL", database: "dev" });
  });

  it("falls back to the sidebar-active connection", () => {
    expect(resolveNewTabTarget({
      activeConnId: "conn-a",
      activeConnName: "Prod PG",
      selectedDb: "shop",
      knownConnections: KNOWN,
    })).toEqual({ connectionId: "conn-a", connectionName: "Prod PG", database: "shop" });
  });

  it("inherits the previous session connection (metadata only)", () => {
    expect(resolveNewTabTarget({
      lastSessionConnectionId: "conn-b",
      lastSessionDatabase: "dev",
      knownConnections: KNOWN,
    })).toEqual({ connectionId: "conn-b", connectionName: "Dev MySQL", database: "dev" });
  });

  it("returns undefined for a deleted (unknown) connection id", () => {
    expect(resolveNewTabTarget({
      lastSessionConnectionId: "conn-gone",
      lastSessionDatabase: "dev",
      knownConnections: KNOWN,
    })).toBeUndefined();
    expect(resolveNewTabTarget({
      explicitConnectionId: "conn-gone",
      explicitDatabase: "dev",
      knownConnections: KNOWN,
    })).toBeUndefined();
  });

  it("returns undefined when no database is resolved", () => {
    expect(resolveNewTabTarget({
      activeConnId: "conn-a",
      activeConnName: "Prod PG",
      selectedDb: null,
      knownConnections: KNOWN,
    })).toBeUndefined();
    expect(resolveNewTabTarget({ knownConnections: KNOWN })).toBeUndefined();
  });

  it("resolves the display name from the known connection when omitted", () => {
    expect(resolveNewTabTarget({
      explicitConnectionId: "conn-a",
      explicitDatabase: "shop",
      knownConnections: KNOWN,
    })).toEqual({ connectionId: "conn-a", connectionName: "Prod PG", database: "shop" });
  });
});
