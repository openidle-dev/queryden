import { describe, it, expect } from "vitest";
import { countActiveParameter, parseCallTarget, splitTopLevelArgs } from "./signatureHelp";

describe("parseCallTarget", () => {
  it("finds a bare function call", () => {
    expect(parseCallTarget("SELECT my_func(")).toEqual({ parts: ["my_func"], parenIndex: 14 });
  });

  it("finds schema-qualified calls", () => {
    const t = parseCallTarget("SELECT public.my_func(1, ");
    expect(t?.parts).toEqual(["public", "my_func"]);
  });

  it("finds quoted identifiers", () => {
    const t = parseCallTarget('SELECT "My Schema"."My Func"(');
    expect(t?.parts).toEqual(["My Schema", "My Func"]);
  });

  it("tracks the active parameter past commas and nested calls", () => {
    expect(countActiveParameter("1, ")).toBe(1);
    expect(countActiveParameter("max(a, b), ")).toBe(1);
    expect(countActiveParameter("")).toBe(0);
  });

  it("ignores commas inside strings and nested parens", () => {
    expect(splitTopLevelArgs("'a,b', c")).toEqual(["'a,b'", " c"]);
    expect(splitTopLevelArgs("f(a, b), c")).toEqual(["f(a, b)", " c"]);
    expect(splitTopLevelArgs("$$a,b$$, c")).toEqual(["$$a,b$$", " c"]);
  });

  it("returns null outside a call", () => {
    expect(parseCallTarget("SELECT 1")).toBeNull();
    expect(parseCallTarget("SELECT (1 + 2")).toBeNull();
  });

  it("returns null when a semicolon intervenes", () => {
    expect(parseCallTarget("SELECT 1; SELECT (")).toBeNull();
  });

  it("skips balanced inner parens to the outer call", () => {
    const t = parseCallTarget("SELECT outer(inner(1), ");
    expect(t?.parts).toEqual(["outer"]);
  });
});
