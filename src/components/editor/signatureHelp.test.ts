import { describe, it, expect } from "vitest";
import { countActiveParameter, getSignaturePrefix, parseCallTarget, splitTopLevelArgs } from "./signatureHelp";

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

  it("semicolon guard blocks the previous statement's call", () => {
    // Without the `;` guard this would return `f` as a false target and
    // fire a catalog lookup for the previous statement.
    expect(parseCallTarget("SELECT f(1; SELECT 2")).toBeNull();
  });

  it("folds unquoted identifiers to lower case, keeps quoted case", () => {
    expect(parseCallTarget("SELECT MY_FUNC(")?.parts).toEqual(["my_func"]);
    expect(parseCallTarget("SELECT Public.My_Func(")?.parts).toEqual(["public", "my_func"]);
    expect(parseCallTarget('SELECT "My Func"(')?.parts).toEqual(["My Func"]);
  });

  it("splits qualified names only outside quoted identifiers", () => {
    const t = parseCallTarget('SELECT "my.schema"."my.func"(');
    expect(t?.parts).toEqual(["my.schema", "my.func"]);
  });

  it("skips balanced inner parens to the outer call", () => {
    const t = parseCallTarget("SELECT outer(inner(1), ");
    expect(t?.parts).toEqual(["outer"]);
  });
});

describe("getSignaturePrefix", () => {
  it("returns only the current statement's prefix", () => {
    const text = "SELECT f(1); SELECT my_func(1, ";
    const caretOffset = text.length;
    let captured: unknown = null;
    const model = {
      getOffsetAt: () => caretOffset,
      getPositionAt: (off: number) => ({ lineNumber: 1, column: off + 1 }),
      getValueInRange: (range: { startColumn: number; endColumn: number }) => {
        captured = range;
        return text.slice(range.startColumn - 1, range.endColumn - 1);
      },
    };
    const prefix = getSignaturePrefix(model, { lineNumber: 1, column: caretOffset + 1 });
    expect(captured).not.toBeNull();
    expect(prefix).toBe(" SELECT my_func(1, ");
    expect(parseCallTarget(prefix)?.parts).toEqual(["my_func"]);
  });
});
