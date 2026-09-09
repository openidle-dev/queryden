import { describe, it, expect } from "vitest";
import {
  buildCopyInsertSql,
  buildCopyPreviewSql,
  buildCountSql,
  buildCreateDatabaseSql,
  buildDropDatabaseSql,
  buildRoleDDL,
  splitDisplayName,
} from "./ddlBuilders";

// Adversarial catalog/user input: must become ONE inert identifier, never
// break out of the statement. sqlx prepared statements already reject
// stacked queries — these tests pin the single-statement breakout class
// (e.g. `"a" WITH (FORCE) --`) plus legitimate quoted names.
const EVIL = `evil"; DROP TABLE users; --`;
const EVIL_TICK = "evil`; DROP TABLE users; --";

describe("buildDropDatabaseSql", () => {
  it("quotes PG names so quotes cannot break out", () => {
    expect(buildDropDatabaseSql("postgres", EVIL)).toBe(`DROP DATABASE "evil""; DROP TABLE users; --"`);
  });

  it("uses backticks for MySQL", () => {
    expect(buildDropDatabaseSql("mysql", EVIL_TICK)).toBe("DROP DATABASE `evil``; DROP TABLE users; --`");
    expect(buildDropDatabaseSql("mariadb", "shop")).toBe("DROP DATABASE `shop`");
  });

  it("throws for unsupported engines", () => {
    expect(() => buildDropDatabaseSql("sqlite", "x")).toThrow(/not supported/);
  });
});

describe("buildCreateDatabaseSql", () => {
  it("quotes PG identifiers and escapes literals", () => {
    const sql = buildCreateDatabaseSql("postgres", {
      name: EVIL,
      owner: `o"wner`,
      template: "template0",
      encoding: "UTF8",
      lcCollate: "en_US.UTF-8",
      connectionLimit: 10,
      isTemplate: false,
    });
    expect(sql).toContain(`CREATE DATABASE "evil""; DROP TABLE users; --"`);
    expect(sql).toContain(`OWNER = "o""wner"`);
    expect(sql).toContain(`TEMPLATE = "template0"`);
    expect(sql).toContain(`ENCODING = 'UTF8'`);
    expect(sql).toContain(`CONNECTION_LIMIT = 10`);
    expect(sql).toContain(`IS_TEMPLATE = FALSE`);
  });

  it("escapes single quotes in PG literals", () => {
    const sql = buildCreateDatabaseSql("postgres", { name: "x", encoding: `UT'F8` });
    expect(sql).toContain(`ENCODING = 'UT''F8'`);
  });

  it("omits non-numeric connection limits instead of emitting LIMIT NaN", () => {
    const sql = buildCreateDatabaseSql("postgres", { name: "x", connectionLimit: NaN });
    expect(sql).not.toContain("CONNECTION_LIMIT");
  });

  it("builds MySQL with backtick identifiers", () => {
    const sql = buildCreateDatabaseSql("mysql", { name: "shop", encoding: "utf8mb4", lcCollate: "utf8mb4_bin" });
    expect(sql).toBe("CREATE DATABASE `shop` CHARACTER SET `utf8mb4` COLLATE `utf8mb4_bin`");
  });
});

describe("buildRoleDDL", () => {
  it("quotes role names and escapes literals", () => {
    const ddl = buildRoleDDL(
      {
        rolname: `we"; DROP ROLE postgres; --`,
        rolsuper: false,
        rolpassword: `p'a"ss`,
        rolconnlimit: 5,
        rolvaliduntil: "2030-01-01",
      },
      true,
    );
    expect(ddl).toContain(`CREATE ROLE "we""; DROP ROLE postgres; --" WITH`);
    expect(ddl).toContain(`ENCRYPTED PASSWORD 'p''a"ss'`);
    expect(ddl).toContain("LOGIN");
    expect(ddl).toContain("CONNECTION LIMIT 5");
  });

  it("falls back to -1/infinity for missing values", () => {
    const ddl = buildRoleDDL({ rolname: "r" }, false);
    expect(ddl).toContain("NOLOGIN");
    expect(ddl).toContain("CONNECTION LIMIT -1");
    expect(ddl).toContain("VALID UNTIL 'infinity'");
  });
});

describe("buildCopyInsertSql", () => {
  it("quotes three-part targets and sources", () => {
    expect(buildCopyInsertSql({
      dbType: "postgres",
      targetDb: "targetdb",
      targetSchema: "devops",
      targetTable: "deployments",
      srcSchema: "devops",
      srcTable: "deployments",
    })).toBe(
      'INSERT INTO "targetdb"."devops"."deployments"\nSELECT * FROM "devops"."deployments"',
    );
  });

  it("neutralizes hostile names and clamps limits", () => {
    const sql = buildCopyInsertSql({
      dbType: "postgres",
      targetDb: EVIL,
      targetSchema: "public",
      targetTable: "t",
      srcSchema: "public",
      srcTable: "t",
      limit: 500,
    });
    expect(sql).toContain(`"evil""; DROP TABLE users; --"."public"."t"`);
    expect(sql).toContain("LIMIT 500");
  });

  it("omits non-positive/non-numeric limits", () => {
    const base = {
      dbType: "postgres",
      targetDb: "d",
      targetSchema: "public",
      targetTable: "t",
      srcSchema: "public",
      srcTable: "t",
    } as const;
    for (const limit of [0, -5, NaN]) {
      expect(buildCopyInsertSql({ ...base, limit })).not.toContain("LIMIT");
    }
  });
});

describe("buildCountSql", () => {
  it("quotes schema-qualified tables", () => {
    expect(buildCountSql("postgres", "devops", "deployments")).toBe(
      'SELECT COUNT(*) as count FROM "devops"."deployments"',
    );
    expect(buildCountSql("postgres", "public", EVIL)).toContain(`"public"."evil""; DROP TABLE users; --"`);
  });

  it("supports three-part cross-database names", () => {
    expect(buildCountSql("postgres", "public", "t", "targetdb")).toBe(
      'SELECT COUNT(*) as count FROM "targetdb"."public"."t"',
    );
  });
});

describe("buildCopyPreviewSql", () => {
  it("quotes identifiers and formats sample values safely", () => {
    const sql = buildCopyPreviewSql({
      dbType: "postgres",
      tableDisplay: "devops.deployments",
      targetDb: "targetdb",
      srcSchema: "devops",
      srcTable: "deployments",
      colNames: ["id", "name", "meta"],
      sampleRow: { id: 1, name: `o'brien`, meta: { a: 1 } },
      currentDbDisplay: "shop",
    });
    expect(sql).toContain(`FROM "devops"."deployments"`);
    expect(sql).toContain(`"id", "name", "meta"`);
    expect(sql).toContain(`1, 'o''brien', '{"a":1}'`);
    expect(sql).not.toContain("[object Object]");
  });

  it("notes empty tables", () => {
    const sql = buildCopyPreviewSql({
      dbType: "postgres",
      tableDisplay: "t",
      targetDb: "d",
      srcSchema: "public",
      srcTable: "t",
      colNames: ["id"],
      sampleRow: null,
      currentDbDisplay: "shop",
    });
    expect(sql).toContain("appears to be empty");
  });
});

describe("splitDisplayName", () => {
  it("splits bare and qualified names", () => {
    expect(splitDisplayName("deployments")).toEqual({ schema: null, table: "deployments" });
    expect(splitDisplayName("devops.deployments")).toEqual({ schema: "devops", table: "deployments" });
  });

  it("respects quoted dots", () => {
    expect(splitDisplayName(`"my.schema"."my.table"`)).toEqual({ schema: "my.schema", table: "my.table" });
  });
});
