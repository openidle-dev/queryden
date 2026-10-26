import { describe, it, expect } from "vitest";
import {
  builtinSignatures,
  clearSignatureHelpCache,
  countActiveParameter,
  fetchFunctionSignatures,
  findCallSites,
  getSignaturePrefix,
  lookupSignatures,
  parameterHints,
  parameterName,
  parameterOffsets,
  parseCallTarget,
  pickActiveSignature,
  splitTopLevelArgs,
} from "./signatureHelp";

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

describe("parameterOffsets", () => {
  it("highlights repeated parameter types in order, not the first match", () => {
    const sig = {
      label: "substr(text, integer, integer) → text",
      parameters: [{ label: "text" }, { label: "integer" }, { label: "integer" }],
    };
    const offsets = parameterOffsets(sig);
    expect(offsets.map(([a, b]) => sig.label.slice(a, b))).toEqual(["text", "integer", "integer"]);
    expect(offsets[2][0]).toBeGreaterThan(offsets[1][0]);
  });
});

describe("pickActiveSignature", () => {
  const two = { label: "f(a, b)", parameters: [{ label: "a" }, { label: "b" }] };
  const three = { label: "f(a, b, c)", parameters: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  const variadic = { label: "g(x, ...)", parameters: [{ label: "x" }, { label: "..." }] };

  it("moves to the first overload that has room for the typed argument", () => {
    expect(pickActiveSignature([two, three], 1)).toBe(0);
    expect(pickActiveSignature([two, three], 2)).toBe(1);
  });

  it("treats variadic overloads as unbounded", () => {
    expect(pickActiveSignature([variadic], 7)).toBe(0);
  });
});

describe("builtin signatures", () => {
  it("offers per-dialect builtins with return types", () => {
    const [sig] = builtinSignatures("mysql", "date_format");
    expect(sig.label).toBe("DATE_FORMAT(date, format) → text");
    expect(sig.parameters.map((p) => p.label)).toEqual(["date", "format"]);
    expect(builtinSignatures("sqlite", "date_format")).toEqual([]);
    expect(builtinSignatures("sqlite", "strftime")[0].parameters[0].label).toBe("format");
  });

  it("falls back to builtins when the catalog has no match (COALESCE is grammar, not pg_proc)", async () => {
    clearSignatureHelpCache();
    const db = { select: async () => [] };
    const sigs = await fetchFunctionSignatures(db, "postgres", { connectionId: "c", database: "d", name: "coalesce" });
    expect(sigs[0].label).toMatch(/^COALESCE\(value, \.\.\.\)/);
  });

  it("falls back to builtins when the catalog query fails", async () => {
    clearSignatureHelpCache();
    const db = { select: async () => { throw new Error("permission denied"); } };
    const sigs = await fetchFunctionSignatures(db, "cockroach", { connectionId: "c", database: "d", name: "date_trunc" });
    expect(sigs[0].parameters.map((p) => p.label)).toEqual(["field", "source", "[time_zone]"]);
  });

  it("uses builtins while disconnected", async () => {
    const sigs = await lookupSignatures({ db: null, connectionId: null, dbType: "sqlite", database: "" }, ["iif"]);
    expect(sigs[0].parameters).toHaveLength(3);
  });

  it("maps catalog rows to labelled signatures with docs", async () => {
    clearSignatureHelpCache();
    const db = {
      select: async () => [
        { schema: "public", name: "add_tax", args: "amount numeric, rate numeric DEFAULT 0.15", result: "numeric", doc: "Apply VAT" },
      ],
    };
    const [sig] = await fetchFunctionSignatures(db, "postgres", { connectionId: "c", database: "d", name: "add_tax" });
    expect(sig.label).toBe("add_tax(amount numeric, rate numeric DEFAULT 0.15) → numeric");
    expect(sig.parameters.map((p) => p.label)).toEqual(["amount numeric", "rate numeric DEFAULT 0.15"]);
    expect(sig.documentation).toBe("Apply VAT");
  });
});

describe("findCallSites", () => {
  it("finds calls with argument offsets, ignoring commas in strings and nested calls", () => {
    const text = "select register_person('Doe, John', lower('X'), 3)";
    const [site] = findCallSites(text);
    expect(site.parts).toEqual(["register_person"]);
    expect(site.args.map((a) => a.text)).toEqual(["'Doe, John'", "lower('X')", "3"]);
    expect(text.slice(site.args[1].offset, site.args[1].offset + 5)).toBe("lower");
  });

  it("skips column lists, IN lists and keywords", () => {
    expect(findCallSites("INSERT INTO t (a, b) VALUES (1, 2)")).toEqual([]);
    expect(findCallSites("SELECT * FROM t WHERE id IN (1, 2) AND EXISTS (SELECT 1)")).toEqual([]);
    expect(findCallSites("SELECT 'f(a, b)' -- g(c, d)")).toEqual([]);
  });

  it("handles schema-qualified and quoted names", () => {
    expect(findCallSites('SELECT reporting."My Fn"(1, 2)')[0].parts).toEqual(["reporting", "My Fn"]);
  });
});

describe("parameterName", () => {
  it.each([
    ["p_name text", "p_name"],
    ["INOUT total numeric DEFAULT 0", "total"],
    ['"Weird Name" integer', '"Weird Name"'],
    ["integer", null],
    ["double precision", null],
    ["timestamp with time zone", null],
    ["character varying(80)", null],
  ])("%s → %s", (label, name) => {
    expect(parameterName(label)).toBe(name);
  });
});

describe("parameterHints", () => {
  const registerPerson = {
    label: "register_person(p_name text, p_surname text, p_age integer DEFAULT 0) → void",
    parameters: [{ label: "p_name text" }, { label: "p_surname text" }, { label: "p_age integer DEFAULT 0" }],
  };
  const resolve = async (parts: string[]) => (parts[parts.length - 1] === "register_person" ? [registerPerson] : []);

  it("labels literal and expression arguments with their parameter names", async () => {
    const text = "SELECT register_person('John', 'Doe', 40 + 2)";
    const hints = await parameterHints(text, resolve);
    expect(hints.map((h) => h.label)).toEqual(["p_name:", "p_surname:", "p_age:"]);
    expect(text.slice(hints[1].offset, hints[1].offset + 5)).toBe("'Doe'");
  });

  it("skips plain column references, single-argument calls and builtins", async () => {
    expect((await parameterHints("SELECT register_person(p.name, 'Doe') FROM p", resolve)).map((h) => h.label)).toEqual(["p_surname:"]);
    expect(await parameterHints("SELECT register_person('John')", resolve)).toEqual([]);
    const builtin = async () => [{ label: "SUBSTR(string, start)", parameters: [{ label: "string" }, { label: "start" }], builtin: true }];
    expect(await parameterHints("SELECT substr('abc', 2)", builtin)).toEqual([]);
  });
});
