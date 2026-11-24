import { describe, expect, it } from "vitest";
import { buildTableDdl } from "./tableDdl";

function stubDb(rows: Record<string, unknown>[]) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    select: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return rows;
    },
  };
}

describe("buildTableDdl", () => {
  it("uses SHOW CREATE TABLE on MySQL / MariaDB with the database qualified", async () => {
    const db = stubDb([{ Table: "orders", "Create Table": "CREATE TABLE `orders` (\n  `id` int NOT NULL\n)" }]);
    expect(await buildTableDdl(db, "mysql", "orders", "shop")).toBe("CREATE TABLE `orders` (\n  `id` int NOT NULL\n);");
    expect(db.calls[0].sql).toBe("SHOW CREATE TABLE shop.orders");
  });

  it("reads views from the Create View column", async () => {
    const db = stubDb([{ View: "v", "Create View": "CREATE VIEW `v` AS select 1" }]);
    expect(await buildTableDdl(db, "mariadb", "v")).toBe("CREATE VIEW `v` AS select 1;");
  });

  it("uses SHOW CREATE TABLE on CockroachDB", async () => {
    const db = stubDb([{ table_name: "t", create_statement: "CREATE TABLE public.t (id INT8 NOT NULL)" }]);
    expect(await buildTableDdl(db, "cockroach", "t", "public")).toBe("CREATE TABLE public.t (id INT8 NOT NULL);");
    expect(db.calls[0].sql).toBe("SHOW CREATE TABLE public.t");
  });

  it("collects the table, its indexes and triggers on SQLite", async () => {
    const db = stubDb([{ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" }, { sql: "CREATE INDEX t_idx ON t (id)" }]);
    expect(await buildTableDdl(db, "sqlite", '"t"', "main")).toBe("CREATE TABLE t (id INTEGER PRIMARY KEY);\n\nCREATE INDEX t_idx ON t (id);");
    expect(db.calls[0].params).toEqual(["t"]);
  });

  it("says so when nothing is found", async () => {
    expect(await buildTableDdl(stubDb([]), "mysql", "missing")).toBe("-- No definition found for missing.");
  });
});
