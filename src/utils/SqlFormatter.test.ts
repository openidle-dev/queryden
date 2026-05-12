import { describe, it, expect } from "vitest";
import { formatSql } from "./SqlFormatter";

describe("formatSql", () => {
  it("returns an empty string for empty input", () => {
    expect(formatSql("")).toBe("");
  });

  it("uppercases known keywords and puts them on new lines", () => {
    const result = formatSql("select * from users where id = 1");
    expect(result).toContain("SELECT");
    expect(result).toContain("FROM");
    expect(result).toContain("WHERE");
    // SELECT should be on a line, FROM on the next.
    expect(result.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("normalizes runs of whitespace before formatting", () => {
    const result = formatSql("select   *   from    users");
    expect(result).not.toContain("   ");
  });

  it("does not insert keywords inside identifier-like words", () => {
    // 'fromage' should not get split because 'from' appears inside it.
    const result = formatSql("SELECT fromage FROM cheeses");
    expect(result).toContain("fromage");
    expect(result.match(/fromage/g)?.length).toBe(1);
  });

  it("indents nested parentheses", () => {
    const result = formatSql("SELECT * FROM (\nSELECT id FROM users\n)");
    // At least one of the inner lines should be indented.
    const lines = result.split("\n");
    expect(lines.some((l) => l.startsWith("  "))).toBe(true);
  });
});
