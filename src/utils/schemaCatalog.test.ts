import { describe, it, expect } from "vitest";
import {
  bucketCatalogRows,
  qualifyObjectName,
  schemaInClause,
  type CatalogRow,
} from "./schemaCatalog";

describe("qualifyObjectName", () => {
  it("leaves public objects unqualified", () => {
    expect(qualifyObjectName("public", "users")).toBe("users");
  });

  it("qualifies objects in any other schema", () => {
    expect(qualifyObjectName("billing", "invoices")).toBe("billing.invoices");
  });

  it("leaves cluster-wide objects unqualified", () => {
    // Extensions, event triggers and languages have no owning schema.
    expect(qualifyObjectName(null, "pg_stat_statements")).toBe("pg_stat_statements");
    expect(qualifyObjectName(undefined, "plpgsql")).toBe("plpgsql");
  });
});

describe("bucketCatalogRows", () => {
  it("groups rows by kind", () => {
    const rows: CatalogRow[] = [
      { kind: "tables", sch: "public", nm: "users" },
      { kind: "views", sch: "public", nm: "active_users" },
      { kind: "tables", sch: "billing", nm: "invoices" },
    ];
    expect(bucketCatalogRows(rows)).toEqual({
      tables: ["users", "billing.invoices"],
      views: ["active_users"],
    });
  });

  it("preserves the order the query returned within each kind", () => {
    const rows: CatalogRow[] = [
      { kind: "tables", sch: "public", nm: "a" },
      { kind: "tables", sch: "public", nm: "b" },
      { kind: "tables", sch: "public", nm: "c" },
    ];
    expect(bucketCatalogRows(rows).tables).toEqual(["a", "b", "c"]);
  });

  it("returns an empty object for no rows", () => {
    expect(bucketCatalogRows([])).toEqual({});
  });

  it("keeps kinds it does not recognise rather than dropping them", () => {
    const rows: CatalogRow[] = [{ kind: "somethingNew", sch: null, nm: "x" }];
    expect(bucketCatalogRows(rows)).toEqual({ somethingNew: ["x"] });
  });

  it("skips malformed rows instead of throwing", () => {
    const rows = [
      { kind: "tables", sch: "public", nm: "users" },
      null,
      { sch: "public", nm: "orphan" },
    ] as unknown as CatalogRow[];
    expect(bucketCatalogRows(rows)).toEqual({ tables: ["users"] });
  });
});

describe("schemaInClause", () => {
  it("is empty when no schemas are selected, meaning no restriction", () => {
    expect(schemaInClause("table_schema", [])).toBe("");
  });

  it("restricts to the selected schemas", () => {
    expect(schemaInClause("table_schema", ["public", "billing"])).toBe(
      "AND table_schema IN ('public','billing')",
    );
  });

  it("names whichever column the caller asks for", () => {
    // The consolidated query filters several catalogue views, and they do not
    // agree on the column name: pg_indexes has schemaname, foreign_tables has
    // foreign_table_schema. Interpolating the wrong one used to make that
    // sub-query error out and silently drop the whole object class.
    expect(schemaInClause("foreign_table_schema", ["public"])).toBe(
      "AND foreign_table_schema IN ('public')",
    );
  });

  it("escapes single quotes in schema names", () => {
    // CREATE SCHEMA "o'brien" is legal, and these names are interpolated
    // rather than bound.
    expect(schemaInClause("table_schema", ["o'brien"])).toBe(
      "AND table_schema IN ('o''brien')",
    );
  });
});
