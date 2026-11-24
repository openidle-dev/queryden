import { describe, it, expect } from "vitest";
import { bucketCatalogRows, needsDatabaseList, qualifyObjectName, type CatalogRow } from "./schemaCatalog";

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

describe("needsDatabaseList", () => {
  it("reads the list on a plain server connect", () => {
    expect(needsDatabaseList(undefined, ["a", "b"])).toBe(true);
  });

  it("reads it when a named database opens and the list was never read", () => {
    expect(needsDatabaseList("odoo", undefined)).toBe(true);
    expect(needsDatabaseList("odoo", [])).toBe(true);
  });

  it("skips it when switching databases on a server whose list is known", () => {
    expect(needsDatabaseList("odoo", ["odoo", "postgres"])).toBe(false);
  });
});
