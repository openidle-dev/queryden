import { describe, it, expect } from "vitest";
import { extractVariables, substituteVariables } from "./VariableSubstitutionDialog";

describe("extractVariables — happy paths", () => {
  it("extracts a single :name variable", () => {
    const vars = extractVariables("SELECT * FROM users WHERE id = :id");
    expect(vars).toHaveLength(1);
    expect(vars[0].name).toBe("id");
    expect(vars[0].isOptional).toBe(false);
  });

  it("extracts multiple distinct variables", () => {
    const vars = extractVariables(
      "SELECT * FROM users WHERE id = :id AND name = :name"
    );
    expect(vars.map(v => v.name)).toEqual(["id", "name"]);
  });

  it("deduplicates repeated variables", () => {
    const vars = extractVariables(
      "SELECT * FROM t WHERE a = :x OR b = :x OR c = :x"
    );
    expect(vars).toHaveLength(1);
    expect(vars[0].name).toBe("x");
  });

  it("infers number type from numeric default", () => {
    const vars = extractVariables("SELECT * FROM users LIMIT :n:10");
    expect(vars[0].type).toBe("number");
    expect(vars[0].defaultValue).toBe("10");
  });

  it("infers date type from ISO date default", () => {
    const vars = extractVariables("SELECT * FROM logs WHERE day = :d:2024-01-01");
    expect(vars[0].type).toBe("date");
  });

  it("marks variables with trailing ? as optional", () => {
    const vars = extractVariables("SELECT * FROM t WHERE x = :x?");
    expect(vars[0].isOptional).toBe(true);
  });
});

// Issue #19: extractVariables must NOT match inside non-variable contexts.
// https://github.com/openidle-dev/queryden/issues/19
describe("extractVariables — issue #19 context-aware matching", () => {
  it("does NOT match the :: cast operator", () => {
    expect(extractVariables("SELECT data::jsonb FROM x")).toEqual([]);
  });

  it("still treats a real variable after a cast on its own as a variable", () => {
    // `WHERE data::jsonb = :payload` — the cast is skipped, :payload is real.
    const vars = extractVariables(
      "SELECT * FROM x WHERE data::jsonb = :payload"
    );
    expect(vars.map(v => v.name)).toEqual(["payload"]);
  });

  it("does NOT match :word inside single-quoted string literals", () => {
    expect(extractVariables("SELECT 'time::value' AS x")).toEqual([]);
  });

  it("treats '' as an escaped quote inside a string literal", () => {
    // The string runs from the first `'` to the LAST `'` here; the `''`
    // in the middle is a literal apostrophe, not a string terminator.
    expect(extractVariables("SELECT 'it''s :not_a_var' AS x")).toEqual([]);
  });

  it("does NOT match :word inside dollar-quoted function bodies", () => {
    const trigger = `CREATE OR REPLACE FUNCTION audit_delete() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log(payload) VALUES (OLD.data::jsonb);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;`;
    expect(extractVariables(trigger)).toEqual([]);
  });

  it("does NOT match inside tagged dollar-quote $body$ ... $body$", () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $body$ SELECT :nope; $body$ LANGUAGE sql;`;
    expect(extractVariables(sql)).toEqual([]);
  });

  it("does NOT match :word inside -- line comments", () => {
    expect(extractVariables("SELECT 1 -- :fake_var\nFROM t")).toEqual([]);
  });

  it("does match a real variable on the line AFTER a -- comment", () => {
    expect(
      extractVariables("SELECT 1 -- :fake\nFROM t WHERE x = :real").map(v => v.name)
    ).toEqual(["real"]);
  });

  it("does NOT match :word inside /* */ block comments", () => {
    expect(extractVariables("SELECT 1 /* :fake_var */ FROM t")).toEqual([]);
  });

  it("does NOT mistake a positional parameter $1 for a dollar-quote", () => {
    // `$1` is a Postgres positional param, NOT a dollar-quote opener.
    // The scanner should not swallow everything after it.
    expect(
      extractVariables("SELECT $1, :real_var FROM t").map(v => v.name)
    ).toEqual(["real_var"]);
  });
});

describe("substituteVariables — issue #19 context-aware substitution", () => {
  it("does NOT substitute inside a string literal", () => {
    // If extractVariables doesn't see :user inside the literal, substitution
    // must also leave it alone. A user supplying a value for an UNRELATED
    // variable :user must not corrupt the string.
    const out = substituteVariables(
      "SELECT 'hello :user' AS greeting, :user AS who",
      { user: "alice" }
    );
    expect(out).toBe("SELECT 'hello :user' AS greeting, 'alice' AS who");
  });

  it("does NOT substitute :foo inside a dollar-quoted body", () => {
    const out = substituteVariables(
      "CREATE FUNCTION f() RETURNS void AS $$ SELECT :leave_alone; $$ LANGUAGE sql; SELECT :real",
      { leave_alone: "X", real: "Y" }
    );
    expect(out).toBe(
      "CREATE FUNCTION f() RETURNS void AS $$ SELECT :leave_alone; $$ LANGUAGE sql; SELECT 'Y'"
    );
  });

  it("does NOT substitute :foo across a :: cast", () => {
    const out = substituteVariables(
      "SELECT data::jsonb FROM x WHERE id = :id",
      { id: "42" }
    );
    expect(out).toBe("SELECT data::jsonb FROM x WHERE id = '42'");
  });
});

describe("substituteVariables", () => {
  it("substitutes :name with the provided value, quoted", () => {
    expect(substituteVariables("SELECT * FROM users WHERE id = :id", { id: "42" }))
      .toBe("SELECT * FROM users WHERE id = '42'");
  });

  it("escapes single quotes in the substituted value", () => {
    expect(
      substituteVariables("SELECT * FROM users WHERE name = :name", { name: "O'Brien" })
    ).toBe("SELECT * FROM users WHERE name = 'O''Brien'");
  });

  it("substitutes every occurrence of the same variable", () => {
    expect(
      substituteVariables(
        "SELECT :x AS a, :x AS b, :x AS c",
        { x: "1" }
      )
    ).toBe("SELECT '1' AS a, '1' AS b, '1' AS c");
  });
});
