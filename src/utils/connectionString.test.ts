import { describe, it, expect } from "vitest";
import { buildConnectionString } from "./connectionString";

describe("buildConnectionString (multi-connection lazy connect)", () => {
  it("builds a postgres string with defaults", () => {
    expect(
      buildConnectionString({ type: "postgres", host: "db.local", port: 5432, database: "app", username: "bob", password: "secret" }),
    ).toBe("postgres://bob:secret@db.local:5432/app");
  });

  it("URL-encodes credentials with special characters", () => {
    expect(
      buildConnectionString({ type: "postgres", host: "h", port: 5432, database: "d", username: "u@x", password: "p@ss/w:rd x" }),
    ).toBe("postgres://u%40x:p%40ss%2Fw%3Ard%20x@h:5432/d");
  });

  it("falls back to localhost + engine default ports", () => {
    expect(buildConnectionString({ type: "mysql", database: "d", username: "u", password: "p" }))
      .toBe("mysql://u:p@localhost:3306/d");
    expect(buildConnectionString({ type: "mariadb", database: "d", username: "u", password: "p" }))
      .toBe("mysql://u:p@localhost:3306/d");
    expect(buildConnectionString({ type: "cockroach", database: "d", username: "u", password: "p" }))
      .toBe("postgres://u:p@localhost:26257/d");
  });

  it("uses an SSH-tunnel endpoint verbatim (127.0.0.1 + local port)", () => {
    expect(
      buildConnectionString({ type: "postgres", host: "127.0.0.1", port: 54321, database: "app", username: "bob", password: "x" }),
    ).toBe("postgres://bob:x@127.0.0.1:54321/app");
  });

  it("maps supabase/cockroach/psql to the postgres scheme", () => {
    for (const t of ["supabase", "cockroach", "psql"]) {
      expect(buildConnectionString({ type: t, host: "h", port: 1, database: "d", username: "u", password: "p" }).startsWith("postgres://")).toBe(true);
    }
  });

  it("builds sqlite strings with filepath fallback", () => {
    expect(buildConnectionString({ type: "sqlite", filepath: "/data/app.db" })).toBe("sqlite:/data/app.db");
    expect(buildConnectionString({ type: "sqlite" })).toBe("sqlite:queryden.db");
  });

  it("throws for unknown engine ids instead of guessing a scheme", () => {
    expect(() => buildConnectionString({ type: "mongodb", host: "h" })).toThrow(/unsupported/i);
    expect(() => buildConnectionString({ type: "" })).toThrow(/unsupported/i);
  });
});
