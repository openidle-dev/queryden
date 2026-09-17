import { describe, it, expect } from "vitest";
import { fetchSchemaItems, type SchemaFetchDb } from "./schemaFetch";

/** In-memory stand-in for the tauri-plugin-sql handle (`db.select`). */
function mockDb(handler: (sql: string) => any[]): SchemaFetchDb {
  return {
    select: async (sql: string) => handler(sql),
  };
}

const PG_TABLES = [
  { table_schema: "public", table_name: "users" },
  { table_schema: "public", table_name: "projects" },
  { table_schema: "devops", table_name: "deployments" },
  { table_schema: "devops", table_name: "servers" },
];

/**
 * The object lists all arrive from one consolidated query now, as
 * `(kind, sch, nm)` triples. Built from the same fixtures the per-view
 * branches below return, so both paths are asserted against identical data.
 */
const PG_OBJECT_ROWS = [
  ...PG_TABLES.map((t) => ({ kind: "tables", sch: t.table_schema, nm: t.table_name })),
  { kind: "views", sch: "public", nm: "active_users" },
  { kind: "functions", sch: "public", nm: "current_user_id" },
  { kind: "functions", sch: "devops", nm: "deploy_status" },
  { kind: "procedures", sch: "devops", nm: "rotate_keys" },
];

function pgDb(issued: string[], opts: { failUnion?: boolean } = {}): SchemaFetchDb {
  return mockDb((sql) => {
    issued.push(sql);
    if (sql.includes("AS kind")) {
      if (opts.failUnion) {
        throw new Error('relation "pg_event_trigger" does not exist');
      }
      return PG_OBJECT_ROWS;
    }
    if (sql.includes("information_schema.tables")) return PG_TABLES;
    if (sql.includes("information_schema.views"))
      return [{ table_schema: "public", table_name: "active_users" }];
    if (sql.includes("information_schema.routines")) {
      if (sql.includes("'PROCEDURE'")) return [{ routine_schema: "devops", routine_name: "rotate_keys" }];
      return [
        { routine_schema: "public", routine_name: "current_user_id" },
        { routine_schema: "devops", routine_name: "deploy_status" },
      ];
    }
    if (sql.includes("information_schema.triggers")) return [];
    if (sql.includes("FROM pg_indexes")) return [];
    if (sql.includes("information_schema.sequences")) return [];
    if (sql.includes("FROM pg_type")) return [];
    if (sql.includes("FROM pg_operator")) return [];
    if (sql.includes("information_schema.foreign_tables")) return [];
    if (sql.includes("FROM pg_attribute")) {
      return [
        { table_schema: "devops", table_name: "deployments", column_name: "id" },
        { table_schema: "devops", table_name: "deployments", column_name: "project_id" },
        { table_schema: "public", table_name: "projects", column_name: "id" },
      ];
    }
    if (sql.includes("FROM pg_constraint")) {
      return [
        {
          source_table: "devops.deployments",
          source_column: "project_id",
          target_table: "public.projects",
          target_column: "id",
        },
      ];
    }
    if (sql.includes("FROM pg_extension")) return [{ extname: "pgcrypto" }];
    if (sql.includes("FROM pg_event_trigger")) return [];
    if (sql.includes("FROM pg_language")) return [{ lanname: "plpgsql" }];
    throw new Error(`unexpected PG query: ${sql.slice(0, 80)}`);
  });
}

describe("fetchSchemaItems — postgres", () => {
  it("qualifies non-public tables and keeps public ones bare (devops. completion)", async () => {
    const schema = await fetchSchemaItems({ db: pgDb([]), connType: "postgres", selectedSchemas: [] });
    expect(schema.tables).toEqual(["users", "projects", "devops.deployments", "devops.servers"]);
    expect(schema.views).toEqual(["active_users"]);
  });

  it("maps columns to qualified table names and foreign keys to quads", async () => {
    const schema = await fetchSchemaItems({ db: pgDb([]), connType: "postgres", selectedSchemas: [] });
    expect(schema.columns).toContainEqual({ table_name: "devops.deployments", column_name: "project_id" });
    expect(schema.columns).toContainEqual({ table_name: "projects", column_name: "id" });
    expect(schema.foreignKeys).toEqual([
      {
        source_table: "devops.deployments",
        source_column: "project_id",
        target_table: "public.projects",
        target_column: "id",
      },
    ]);
  });

  it("qualifies functions and procedures outside public", async () => {
    const schema = await fetchSchemaItems({ db: pgDb([]), connType: "postgres", selectedSchemas: [] });
    expect(schema.functions).toEqual(["current_user_id", "devops.deploy_status"]);
    expect(schema.procedures).toEqual(["devops.rotate_keys"]);
  });

  it("applies the selected-schema filter to the catalog queries", async () => {
    const issued: string[] = [];
    await fetchSchemaItems({ db: pgDb(issued), connType: "postgres", selectedSchemas: ["public"] });
    const tablesSql = issued.find((s) => s.includes("information_schema.tables"));
    expect(tablesSql).toContain("IN ('public')");
  });

  it("stamps _ts", async () => {
    const schema = await fetchSchemaItems({ db: pgDb([]), connType: "postgres", selectedSchemas: [] });
    expect(typeof schema._ts).toBe("number");
  });
});

function mysqlDb(): SchemaFetchDb {
  return mockDb((sql) => {
    if (sql === "SHOW TABLES") return [{ Tables_in_shop: "orders" }, { Tables_in_shop: "users" }];
    if (sql.includes("SHOW FULL TABLES")) return [{ Tables_in_shop: "big_orders", Table_type: "VIEW" }];
    if (sql.includes("information_schema.COLUMNS")) {
      return [
        { TABLE_NAME: "orders", COLUMN_NAME: "id" },
        { TABLE_NAME: "orders", COLUMN_NAME: "user_id" },
      ];
    }
    if (sql.includes("ROUTINE_TYPE = 'FUNCTION'")) return [{ ROUTINE_NAME: "calc_total" }];
    if (sql.includes("ROUTINE_TYPE = 'PROCEDURE'")) return [{ routine_name: "nightly_cleanup" }];
    if (sql.includes("KEY_COLUMN_USAGE")) {
      return [
        { source_table: "orders", source_column: "user_id", target_table: "users", target_column: "id" },
      ];
    }
    throw new Error(`unexpected MySQL query: ${sql.slice(0, 80)}`);
  });
}

describe("fetchSchemaItems — mysql", () => {
  it("loads tables, views, columns, scalar functions, procedures and FKs", async () => {
    const schema = await fetchSchemaItems({ db: mysqlDb(), connType: "mysql", selectedSchemas: [] });
    expect(schema.tables).toEqual(["orders", "users"]);
    expect(schema.views).toEqual(["big_orders"]);
    expect(schema.columns).toEqual([
      { table_name: "orders", column_name: "id" },
      { table_name: "orders", column_name: "user_id" },
    ]);
    expect(schema.functions).toEqual(["calc_total"]);
    expect(schema.procedures).toEqual(["nightly_cleanup"]);
    expect(schema.foreignKeys).toEqual([
      { source_table: "orders", source_column: "user_id", target_table: "users", target_column: "id" },
    ]);
  });
});

function sqliteDb(): SchemaFetchDb {
  return mockDb((sql) => {
    if (sql.includes("sqlite_master") && sql.includes("type = 'table'"))
      return [{ name: "orders" }, { name: "sqlite_sequence" }, { name: "users" }];
    if (sql.includes("sqlite_master") && sql.includes("type = 'view'")) return [{ name: "user_view" }];
    const tableInfo = sql.match(/PRAGMA table_info\("?(.*?)"?\)/);
    if (tableInfo) {
      const cols: Record<string, string[]> = {
        orders: ["id", "user_id"],
        users: ["id", "email"],
        user_view: ["id"],
      };
      return (cols[tableInfo[1]] ?? []).map((name) => ({ name }));
    }
    const fkList = sql.match(/PRAGMA foreign_key_list\("?(.*?)"?\)/);
    if (fkList) {
      if (fkList[1] === "orders") return [{ table: "users", from: "user_id", to: "id" }];
      return [];
    }
    throw new Error(`unexpected SQLite query: ${sql.slice(0, 80)}`);
  });
}

describe("fetchSchemaItems — sqlite", () => {
  it("loads tables/views (skipping sqlite_ internals), columns and FKs", async () => {
    const schema = await fetchSchemaItems({ db: sqliteDb(), connType: "sqlite", selectedSchemas: [] });
    expect(schema.tables).toEqual(["orders", "users"]);
    expect(schema.views).toEqual(["user_view"]);
    expect(schema.columns).toContainEqual({ table_name: "orders", column_name: "user_id" });
    expect(schema.columns).toContainEqual({ table_name: "users", column_name: "email" });
    expect(schema.foreignKeys).toEqual([
      { source_table: "orders", source_column: "user_id", target_table: "users", target_column: "id" },
    ]);
  });
});

describe("fetchSchemaItems — no duplicate suggestions", () => {
  it("excludes MySQL views from the tables list (SHOW TABLES lists views too)", async () => {
    const db: SchemaFetchDb = {
      select: async (sql: string) => {
        if (sql === "SHOW TABLES")
          return [{ Tables_in_shop: "orders" }, { Tables_in_shop: "big_orders" }, { Tables_in_shop: "orders" }];
        if (sql.includes("SHOW FULL TABLES")) return [{ Tables_in_shop: "big_orders", Table_type: "VIEW" }];
        if (sql.includes("information_schema.COLUMNS")) {
          return [
            { TABLE_NAME: "orders", COLUMN_NAME: "id" },
            { TABLE_NAME: "orders", COLUMN_NAME: "id" },
          ];
        }
        if (sql.includes("ROUTINE_TYPE = 'FUNCTION'")) return [{ ROUTINE_NAME: "f" }, { ROUTINE_NAME: "f" }];
        if (sql.includes("ROUTINE_TYPE = 'PROCEDURE'")) return [];
        if (sql.includes("KEY_COLUMN_USAGE")) return [];
        throw new Error(`unexpected: ${sql.slice(0, 60)}`);
      },
    };
    const schema = await fetchSchemaItems({ db, connType: "mysql", selectedSchemas: [] });
    expect(schema.tables).toEqual(["orders"]);
    expect(schema.views).toEqual(["big_orders"]);
    expect(schema.columns).toEqual([{ table_name: "orders", column_name: "id" }]);
    expect(schema.functions).toEqual(["f"]);
  });

  it("collapses duplicate PG rows across overlapping reads", async () => {
    const db: SchemaFetchDb = {
      select: async (sql: string) => {
        // The consolidated object query can itself return a name twice --
        // catalogue quirks, case variants, overlapping reads -- so the
        // defensive dedupe has to sit downstream of it, not inside the
        // per-view branches it replaced.
        if (sql.includes("AS kind"))
          return [
            { kind: "tables", sch: "public", nm: "users" },
            { kind: "tables", sch: "public", nm: "users" },
          ];
        if (sql.includes("information_schema.tables"))
          return [
            { table_schema: "public", table_name: "users" },
            { table_schema: "public", table_name: "users" },
          ];
        if (sql.includes("FROM pg_attribute")) {
          return [
            { table_schema: "public", table_name: "users", column_name: "id" },
            { table_schema: "public", table_name: "users", column_name: "id" },
          ];
        }
        if (sql.includes("FROM pg_constraint")) {
          const fk = {
            source_table: "orders",
            source_column: "user_id",
            target_table: "users",
            target_column: "id",
          };
          return [fk, { ...fk }];
        }
        return [];
      },
    };
    const schema = await fetchSchemaItems({ db, connType: "postgres", selectedSchemas: [] });
    expect(schema.tables).toEqual(["users"]);
    expect(schema.columns).toEqual([{ table_name: "users", column_name: "id" }]);
    expect(schema.foreignKeys).toEqual([
      { source_table: "orders", source_column: "user_id", target_table: "users", target_column: "id" },
    ]);
  });
});

describe("fetchSchemaItems — per-view schema columns when filtered", () => {
  // Regression: routines/triggers/foreign-tables queries interpolated the
  // `table_schema` filter, which PostgreSQL rejects (those views expose
  // routine_schema / trigger_schema / foreign_table_schema). The caught
  // errors left functions, procedures, triggers and foreign tables empty.
  it("uses each catalog view's own schema column", async () => {
    const issued: string[] = [];
    await fetchSchemaItems({ db: pgDb(issued), connType: "postgres", selectedSchemas: ["devops"] });

    // The object lists share one statement now, but each branch of it still
    // has to name its own schema column: filtering routines, triggers or
    // foreign tables on `table_schema` is a SQL error, and would take the
    // whole consolidated query down with it.
    const union = issued.find((s) => s.includes("AS kind"));
    expect(union).toBeDefined();
    expect(union).toContain("AND table_schema IN ('devops')");
    expect(union).toContain("AND routine_schema IN ('devops')");
    expect(union).toContain("AND trigger_schema IN ('devops')");
    expect(union).toContain("AND foreign_table_schema IN ('devops')");
    expect(union).toContain("AND schemaname IN ('devops')");
    expect(union).toContain("AND sequence_schema IN ('devops')");

    expect(issued.find((s) => s.includes("FROM pg_attribute"))).toContain(
      "AND n.nspname IN ('devops')",
    );
  });

  it("reads every object list in a single round trip", async () => {
    const issued: string[] = [];
    await fetchSchemaItems({ db: pgDb(issued), connType: "postgres", selectedSchemas: [] });
    // One consolidated object query, plus columns and foreign keys. Every
    // statement is a full network round trip, so against a server on another
    // continent this is the difference between roughly 3 seconds and 15.
    expect(issued).toHaveLength(3);
    expect(issued.filter((s) => s.includes("AS kind"))).toHaveLength(1);
  });

  it("falls back to per-object queries when the consolidated query fails", async () => {
    // An older server, or CockroachDB's partial catalogue, can be missing one
    // of the views the union reads -- which fails the entire statement. The
    // per-object path then costs only the lists that genuinely are missing.
    const issued: string[] = [];
    const schema = await fetchSchemaItems({
      db: pgDb(issued, { failUnion: true }),
      connType: "postgres",
      selectedSchemas: [],
    });
    expect(schema.tables).toEqual(["users", "projects", "devops.deployments", "devops.servers"]);
    expect(schema.views).toEqual(["active_users"]);
    expect(issued.length).toBeGreaterThan(3);
  });

  it("escapes schema names in every filter (apostrophes must not break SQL)", async () => {
    const issued: string[] = [];
    await fetchSchemaItems({ db: pgDb(issued), connType: "postgres", selectedSchemas: ["o'brien"] });
    const filtered = issued.filter((s) =>
      /_schema IN \(|nspname IN \(|schemaname IN \(|regnamespace::text IN \(/.test(s),
    );
    // The consolidated object query, plus columns and foreign keys.
    expect(filtered.length).toBeGreaterThanOrEqual(3);
    for (const sql of filtered) {
      expect(sql).toContain("'o''brien'");
    }
    // Every filter inside the consolidated statement must carry the escaped
    // form: one unescaped apostrophe breaks the whole query, not just a list.
    const union = issued.find((s) => s.includes("AS kind")) ?? "";
    expect(union.split("'o''brien'").length - 1).toBeGreaterThanOrEqual(6);
  });
});

describe("fetchSchemaItems — unknown engine", () => {
  it("returns empty collections with a timestamp", async () => {
    const schema = await fetchSchemaItems({ db: mockDb(() => []), connType: "oracle", selectedSchemas: [] });
    expect(schema.tables).toEqual([]);
    expect(schema.columns ?? []).toEqual([]);
    expect(typeof schema._ts).toBe("number");
  });
});
