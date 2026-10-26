import { cleanSqlForKeywords, isMySqlLike } from "./sqlDialect";

export type ExplainPlan = { sql: string; analyze: boolean } | { error: string };

const EXPLAINABLE = /^(\(|SELECT|WITH|VALUES|TABLE|INSERT|UPDATE|DELETE|MERGE)\b|^\(/;
// ANALYZE really runs the statement, so anything that writes (DML anywhere,
// including inside a CTE, `SELECT … INTO`, row locks) is only planned.
const WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|INTO)\b|\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b/;

/**
 * The EXPLAIN statement for `statement` on `dbType`. Read-only queries get
 * the measured plan (PostgreSQL `ANALYZE, BUFFERS`); data-changing ones get
 * the estimated plan only, so the Optimizer never modifies data.
 */
export function explainPlanFor(statement: string, dbType: string | undefined): ExplainPlan {
  const type = (dbType || "").toLowerCase();
  const clean = cleanSqlForKeywords(statement, { hashComments: isMySqlLike(type) });
  if (!clean) return { error: "Put the caret in a statement (or select one) to explain it." };
  if (/^EXPLAIN\b/.test(clean)) return { error: "This statement is already an EXPLAIN — run it with Ctrl+Enter." };
  if (!EXPLAINABLE.test(clean)) {
    return { error: "Only SELECT, WITH, VALUES, TABLE, INSERT, UPDATE, DELETE and MERGE statements have query plans." };
  }
  const analyze = !WRITES.test(clean);

  if (type === "postgres" || type === "supabase") {
    return { sql: `EXPLAIN (${analyze ? "ANALYZE, BUFFERS, " : ""}FORMAT JSON) ${statement}`, analyze };
  }
  if (type === "cockroach") {
    // CockroachDB has no FORMAT JSON / BUFFERS; it returns text plan rows.
    return { sql: `EXPLAIN ${analyze ? "ANALYZE " : ""}${statement}`, analyze };
  }
  if (type === "mysql" || type === "mariadb") return { sql: `EXPLAIN FORMAT=JSON ${statement}`, analyze: false };
  if (type === "sqlite") return { sql: `EXPLAIN QUERY PLAN ${statement}`, analyze: false };
  return { sql: `EXPLAIN ${statement}`, analyze: false };
}
