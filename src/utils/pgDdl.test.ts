import { describe, it, expect } from "vitest";
import { buildPgDdl, nameCandidates, parseQualifiedName } from "./pgDdl";

describe("parseQualifiedName", () => {
  it("folds unquoted parts, keeps quoted case, drops a call's argument list", () => {
    expect(parseQualifiedName("reporting.build_release_summary()")).toEqual({ schema: "reporting", name: "build_release_summary" });
    expect(parseQualifiedName('Reporting."My Table"')).toEqual({ schema: "reporting", name: "My Table" });
    expect(parseQualifiedName("users")).toEqual({ schema: null, name: "users" });
    expect(parseQualifiedName('"a.b"."c""d"')).toEqual({ schema: "a.b", name: 'c"d' });
  });

  it("tries the exact explorer name before the folded one", () => {
    expect(nameCandidates("reporting.Releases")).toEqual([
      { schema: "reporting", name: "Releases" },
      { schema: "reporting", name: "releases" },
    ]);
  });
});

/** Fake catalog: answers by which deparser the SQL calls. */
function fakeDb(catalog: { relation?: { schema: string; name: string; kind: string }; functions?: string[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    select: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("pg_get_functiondef")) return (catalog.functions ?? []).map((def) => ({ def }));
      if (sql.includes("FROM pg_class c")) return catalog.relation ? [catalog.relation] : [];
      if (sql.includes("pg_get_viewdef")) return [{ def: " SELECT 1;" }];
      if (sql.includes("FROM pg_attribute a"))
        return [
          { name: "id", type: "bigint", notnull: true, def: null, identity: "a", generated: "", comment: null },
          { name: "Name", type: "character varying(80)", notnull: "t", def: null, identity: "", generated: "", comment: "display name" },
        ];
      if (sql.includes("FROM pg_constraint")) return [{ name: "t_pkey", def: "PRIMARY KEY (id)" }];
      if (sql.includes("pg_get_indexdef")) return [];
      if (sql.includes("obj_description")) return [{ comment: null }];
      return [];
    },
  };
}

describe("buildPgDdl", () => {
  it("shows a set-returning function called in FROM as its CREATE FUNCTION, not an empty table", async () => {
    const db = fakeDb({ functions: ["CREATE OR REPLACE FUNCTION reporting.build_release_summary()\n RETURNS TABLE(app text)\n AS $function$ select 'web' $function$"] });
    const ddl = await buildPgDdl(db, "reporting.build_release_summary()");
    expect(ddl).toMatch(/^CREATE OR REPLACE FUNCTION reporting\.build_release_summary\(\)/);
    expect(ddl).not.toMatch(/CREATE TABLE/);
    expect(db.calls[0].params).toEqual(["reporting", "build_release_summary"]);
  });

  it("finds an unqualified function or table outside the search_path", async () => {
    const offPath = {
      select: async (sql: string) => {
        const anySchema = sql.includes("NOT IN ('pg_catalog'");
        if (sql.includes("pg_get_functiondef")) return anySchema ? [{ def: "CREATE FUNCTION reporting.summary()" }] : [];
        if (sql.includes("FROM pg_class c")) return [];
        return [];
      },
    };
    expect(await buildPgDdl(offPath, "summary", "function")).toBe("CREATE FUNCTION reporting.summary();");
    expect(await buildPgDdl(offPath, "summary()")).toBe("CREATE FUNCTION reporting.summary();");

    const tableOffPath = fakeDb({});
    const select = tableOffPath.select;
    tableOffPath.select = async (sql: string, params: unknown[] = []) =>
      sql.includes("FROM pg_class c") && sql.includes("NOT IN ('pg_catalog'")
        ? [{ schema: "reporting", name: "releases", kind: "r" }]
        : select(sql, params);
    expect(await buildPgDdl(tableOffPath, "releases")).toContain("CREATE TABLE reporting.releases (");
  });

  it("joins every overload", async () => {
    const db = fakeDb({ functions: ["CREATE FUNCTION f(a int)", "CREATE FUNCTION f(a int, b int)"] });
    expect(await buildPgDdl(db, "f", "function")).toBe("CREATE FUNCTION f(a int);\n\nCREATE FUNCTION f(a int, b int);");
  });

  it("builds table DDL with exact types, identity, constraints and comments", async () => {
    const db = fakeDb({ relation: { schema: "reporting", name: "Releases", kind: "r" } });
    const ddl = await buildPgDdl(db, "reporting.Releases");
    expect(ddl).toContain('CREATE TABLE reporting."Releases" (');
    expect(ddl).toContain("  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,");
    expect(ddl).toContain('  "Name" character varying(80) NOT NULL,');
    expect(ddl).toContain("  CONSTRAINT t_pkey PRIMARY KEY (id)");
    expect(ddl).toContain(`COMMENT ON COLUMN reporting."Releases"."Name" IS 'display name';`);
  });

  it("deparses views and never binds NULL for a missing schema", async () => {
    const db = fakeDb({ relation: { schema: "public", name: "v", kind: "v" } });
    expect(await buildPgDdl(db, "v")).toBe("CREATE OR REPLACE VIEW public.v AS\n SELECT 1;");
    expect(db.calls.every((c) => c.params.every((p) => p !== null))).toBe(true);
  });

  it("explains when nothing matches", async () => {
    expect(await buildPgDdl(fakeDb({}), "nope")).toMatch(/^-- No table, view or function named nope/);
  });
});
