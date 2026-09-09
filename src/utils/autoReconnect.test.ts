import { describe, it, expect } from "vitest";
import { canAutoReconnect } from "./autoReconnect";

describe("canAutoReconnect (startup restore)", () => {
  it("rejects missing connections", () => {
    expect(canAutoReconnect(null)).toBe(false);
    expect(canAutoReconnect(undefined)).toBe(false);
  });

  it("allows direct-credential and legacy connections", () => {
    expect(canAutoReconnect({ id: "a", isVault: false })).toBe(true);
    expect(canAutoReconnect({ id: "a" })).toBe(true);
  });

  it("allows vault connections with a chosen profile", () => {
    expect(canAutoReconnect({ id: "a", isVault: true, vaultCredentialId: "p1" })).toBe(true);
  });

  it("blocks vault connections still waiting for a profile pick (would prompt)", () => {
    expect(canAutoReconnect({ id: "a", isVault: true })).toBe(false);
    expect(canAutoReconnect({ id: "a", isVault: true, vaultCredentialId: "" })).toBe(false);
  });
});
