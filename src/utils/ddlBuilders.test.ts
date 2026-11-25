import { describe, it, expect } from "vitest";
import {
  formatDurationShort,
  buildTerminateSessionsSql,
  describeDatabaseSessions,
  buildDatabaseMaintenanceSql,
  buildRenameDatabaseSql,
  isDatabaseInUseError,
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
    // PostgreSQL's keyword is two words; CONNECTION_LIMIT is a syntax error.
    expect(sql).toContain(`CONNECTION LIMIT = 10`);
    expect(sql).toContain(`IS_TEMPLATE = FALSE`);
  });

  it("escapes single quotes in PG literals", () => {
    const sql = buildCreateDatabaseSql("postgres", { name: "x", encoding: `UT'F8` });
    expect(sql).toContain(`ENCODING = 'UT''F8'`);
  });

  it("omits non-numeric connection limits instead of emitting LIMIT NaN", () => {
    const sql = buildCreateDatabaseSql("postgres", { name: "x", connectionLimit: NaN });
    expect(sql).not.toContain("CONNECTION LIMIT");
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
      targetSchema: "reporting",
      targetTable: "deployments",
      srcSchema: "reporting",
      srcTable: "deployments",
    })).toBe(
      'INSERT INTO "targetdb"."reporting"."deployments"\nSELECT * FROM "reporting"."deployments"',
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
    expect(buildCountSql("postgres", "reporting", "deployments")).toBe(
      'SELECT COUNT(*) as count FROM "reporting"."deployments"',
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
      tableDisplay: "reporting.deployments",
      targetDb: "targetdb",
      srcSchema: "reporting",
      srcTable: "deployments",
      colNames: ["id", "name", "meta"],
      sampleRow: { id: 1, name: `o'brien`, meta: { a: 1 } },
      currentDbDisplay: "shop",
    });
    expect(sql).toContain(`FROM "reporting"."deployments"`);
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
    expect(splitDisplayName("reporting.deployments")).toEqual({ schema: "reporting", table: "deployments" });
  });

  it("respects quoted dots", () => {
    expect(splitDisplayName(`"my.schema"."my.table"`)).toEqual({ schema: "my.schema", table: "my.table" });
  });
});

describe("buildRenameDatabaseSql", () => {
  it("quotes both names on PostgreSQL-family engines", () => {
    expect(buildRenameDatabaseSql("postgres", "odoo", "odoo_old")).toBe('ALTER DATABASE "odoo" RENAME TO "odoo_old"');
    expect(buildRenameDatabaseSql("supabase", "a.b", "c")).toBe('ALTER DATABASE "a.b" RENAME TO "c"');
    expect(buildRenameDatabaseSql("cockroach", "My DB", 'x"y')).toBe('ALTER DATABASE "My DB" RENAME TO "x""y"');
  });

  it("explains why MySQL, MariaDB and SQLite cannot", () => {
    expect(() => buildRenameDatabaseSql("mysql", "a", "b")).toThrow(/RENAME TABLE/);
    expect(() => buildRenameDatabaseSql("mariadb", "a", "b")).toThrow(/cannot rename/);
    expect(() => buildRenameDatabaseSql("sqlite", "a", "b")).toThrow(/not supported/);
  });

  it("rejects an empty or unchanged name", () => {
    expect(() => buildRenameDatabaseSql("postgres", "a", "  ")).toThrow(/empty/);
    expect(() => buildRenameDatabaseSql("postgres", "a", "a")).toThrow(/same/);
  });
});

describe("isDatabaseInUseError", () => {
  it("recognises PostgreSQL's in-use error", () => {
    expect(isDatabaseInUseError('database "odoo" is being accessed by other users')).toBe(true);
    expect(isDatabaseInUseError("permission denied")).toBe(false);
  });
});

describe("buildDatabaseMaintenanceSql", () => {
  it("covers each engine family", () => {
    expect(buildDatabaseMaintenanceSql("postgres", "odoo")).toContain("VACUUM (VERBOSE, ANALYZE);");
    expect(buildDatabaseMaintenanceSql("sqlite", "main")).toContain("VACUUM;");
    expect(buildDatabaseMaintenanceSql("mysql", "shop")).toContain("WHERE table_schema = 'shop'");
    expect(buildDatabaseMaintenanceSql("cockroach", "x")).toBeNull();
  });
});

describe("buildTerminateSessionsSql", () => {
  it("ends only the listed sessions on that database", () => {
    expect(buildTerminateSessionsSql([4211, 77])).toBe(
      "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = $1 AND pid IN (4211, 77)",
    );
  });

  it("refuses an empty list or anything but positive integers", () => {
    expect(() => buildTerminateSessionsSql([])).toThrow(/No sessions/);
    expect(() => buildTerminateSessionsSql([1.5])).toThrow(/Invalid/);
    expect(() => buildTerminateSessionsSql([Number("1) OR (1=1")])).toThrow(/Invalid/);
  });
});

describe("describeDatabaseSessions", () => {
  it("lists user, application, client and state, capped", () => {
    const s = (pid: number) => ({ pid, usename: "odoo", application_name: "Odoo", client_addr: "10.0.0.4", state: "idle in transaction" });
    expect(describeDatabaseSessions([s(1)])).toBe("• odoo · Odoo · 10.0.0.4 · idle in transaction (pid 1)");
    expect(describeDatabaseSessions([{ pid: 2, usename: null, application_name: "", client_addr: null, state: null }])).toBe(
      "• unknown user · local socket · unknown state (pid 2)",
    );
    expect(describeDatabaseSessions([s(1), s(2), s(3)], 2).split("\n").pop()).toBe("• …and 1 more");
  });
});

describe("formatDurationShort", () => {
  it("picks the two largest units", () => {
    expect(formatDurationShort(42)).toBe("42s");
    expect(formatDurationShort(303)).toBe("5m 3s");
    expect(formatDurationShort(3 * 3600 + 12 * 60 + 5)).toBe("3h 12m");
    expect(formatDurationShort(2 * 86400 + 4 * 3600)).toBe("2d 4h");
    expect(formatDurationShort(null)).toBe("");
    expect(formatDurationShort(-1)).toBe("");
  });
});

describe("database names with dots", () => {
  it("stay one identifier in CREATE and DROP DATABASE", () => {
    expect(buildCreateDatabaseSql("postgres", { name: "odoo.v19" })).toBe('CREATE DATABASE "odoo.v19"');
    expect(buildDropDatabaseSql("postgres", "odoo.v19")).toBe('DROP DATABASE "odoo.v19"');
    expect(buildDropDatabaseSql("mysql", "shop.v2")).toBe("DROP DATABASE `shop.v2`");
  });
});
