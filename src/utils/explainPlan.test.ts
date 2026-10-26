import { describe, it, expect } from "vitest";
import { explainPlanFor } from "./explainPlan";

const sqlOf = (stmt: string, db: string) => {
  const p = explainPlanFor(stmt, db);
  return "sql" in p ? p.sql : p.error;
};

describe("explainPlanFor", () => {
  it("measures read-only PostgreSQL queries, including CTEs and leading comments", () => {
    expect(sqlOf("select * from t", "postgres")).toBe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select * from t");
    expect(sqlOf("-- report\nWITH x AS (SELECT 1) SELECT * FROM x", "supabase")).toMatch(/^EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/);
    expect(sqlOf("select * from reporting.build_release_summary()", "postgres")).toMatch(/ANALYZE/);
  });

  it("never ANALYZEs statements that write", () => {
    for (const stmt of [
      "DELETE FROM t WHERE id = 1",
      "UPDATE t SET a = 1",
      "WITH d AS (DELETE FROM t RETURNING *) SELECT count(*) FROM d",
      "SELECT * INTO backup_t FROM t",
      "SELECT * FROM t FOR UPDATE",
      "INSERT INTO t SELECT * FROM s",
    ]) {
      expect(sqlOf(stmt, "postgres"), stmt).toBe(`EXPLAIN (FORMAT JSON) ${stmt}`);
    }
  });

  it("ignores keywords inside strings and comments", () => {
    expect(sqlOf("SELECT 'delete me' /* update */ FROM t", "postgres")).toMatch(/ANALYZE/);
  });

  it("uses each engine's own syntax", () => {
    expect(sqlOf("select 1", "cockroach")).toBe("EXPLAIN ANALYZE select 1");
    expect(sqlOf("select 1", "mysql")).toBe("EXPLAIN FORMAT=JSON select 1");
    expect(sqlOf("select 1", "sqlite")).toBe("EXPLAIN QUERY PLAN select 1");
  });

  it("explains what it can't plan", () => {
    expect(sqlOf("", "postgres")).toMatch(/caret/);
    expect(sqlOf("CREATE TABLE t (id int)", "postgres")).toMatch(/Only SELECT/);
    expect(sqlOf("EXPLAIN SELECT 1", "postgres")).toMatch(/already an EXPLAIN/);
  });
});
