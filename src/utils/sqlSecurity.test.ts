import { describe, it, expect } from "vitest";
import { quoteIdentifier } from "./sqlSecurity";

describe("quoteIdentifier", () => {
  it("returns the input untouched when empty", () => {
    expect(quoteIdentifier("", "postgres")).toBe("");
  });

  it("wraps PostgreSQL identifiers in double quotes", () => {
    expect(quoteIdentifier("users", "postgres")).toBe('"users"');
    expect(quoteIdentifier("users", "supabase")).toBe('"users"');
    expect(quoteIdentifier("users", "cockroach")).toBe('"users"');
    expect(quoteIdentifier("users", "sqlite")).toBe('"users"');
  });

  it("wraps MySQL/MariaDB identifiers in backticks", () => {
    expect(quoteIdentifier("users", "mysql")).toBe("`users`");
    expect(quoteIdentifier("users", "mariadb")).toBe("`users`");
  });

  it("strips pre-existing quote characters before re-quoting", () => {
    expect(quoteIdentifier('"users"', "postgres")).toBe('"users"');
    expect(quoteIdentifier("`users`", "mysql")).toBe("`users`");
    expect(quoteIdentifier("[users]", "postgres")).toBe('"users"');
  });

  it("quotes each segment of a dotted identifier independently", () => {
    expect(quoteIdentifier("public.users", "postgres")).toBe('"public"."users"');
    expect(quoteIdentifier("mydb.public.users", "postgres")).toBe('"mydb"."public"."users"');
  });

  it("treats unknown DB types as standard SQL (double quotes)", () => {
    expect(quoteIdentifier("users", "oracle")).toBe('"users"');
  });

  it("is case-insensitive for the DB type", () => {
    expect(quoteIdentifier("users", "PostgreSQL")).toBe('"users"');
    expect(quoteIdentifier("users", "MYSQL")).toBe("`users`");
  });
});
