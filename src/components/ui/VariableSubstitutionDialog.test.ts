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

// Issue #19: extractVariables wrongly matches inside non-variable contexts.
// These tests are pinned with it.fails so CI stays green today; when the
// regex is fixed they flip to red, telling the implementer to drop `.fails`.
// https://github.com/openidle-dev/queryden/issues/19
describe("extractVariables — issue #19 (currently broken)", () => {
  it.fails("does NOT match the :: cast operator", () => {
    // value::jsonb is a PostgreSQL type cast, not a :jsonb variable.
    // Today the regex captures `:jsonb` because the second `:` looks like
    // the start of a variable name.
    expect(extractVariables("SELECT data::jsonb FROM x")).toEqual([]);
  });

  it.fails("does NOT match :word inside single-quoted string literals", () => {
    expect(extractVariables("SELECT 'time::value' AS x")).toEqual([]);
  });

  it.fails("does NOT match :word inside dollar-quoted function bodies", () => {
    const trigger = `CREATE OR REPLACE FUNCTION audit_delete() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log(payload) VALUES (OLD.data::jsonb);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;`;
    expect(extractVariables(trigger)).toEqual([]);
  });

  it.fails("does NOT match :word inside -- line comments", () => {
    expect(extractVariables("SELECT 1 -- :fake_var\nFROM t")).toEqual([]);
  });

  it.fails("does NOT match :word inside /* */ block comments", () => {
    expect(extractVariables("SELECT 1 /* :fake_var */ FROM t")).toEqual([]);
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
