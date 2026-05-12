import React, { useMemo, useState, useCallback } from "react";
import {
  Zap, AlertTriangle, TrendingUp, Info,
  ChevronDown, ChevronRight, Database,
  Search, List, Layout, Terminal, Clock, Activity,
  Maximize2, Minimize2, Copy, Check, Play,
  BarChart3, Target, Shield, Layers, ArrowRight, Sparkles, XCircle
} from "lucide-react";
import { useAI } from "../../store/aiStore";
import { logger } from "../../utils/logger";

interface PlanNode {
  "Node Type": string;
  "Strategy"?: string;
  "Alias"?: string;
  "Relation Name"?: string;
  "Actual Startup Time"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Plan Rows"?: number;
  "Plan Width"?: number;
  "Startup Cost"?: number;
  "Total Cost"?: number;
  "Filter"?: string;
  "Index Cond"?: string;
  "Index Name"?: string;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Plans"?: PlanNode[];
  [key: string]: any;
}

interface OptimizerInsight {
  type: "critical" | "warning" | "success" | "info";
  title: string;
  message: string;
  fix?: string;       // The SQL to fix the issue
  fixLabel?: string;  // Human label like "Create Index"
  table?: string;
  columns?: string[];
}

interface VisualOptimizerProps {
  data: any;
  onApplyFix?: (sql: string) => void;
}

// ─── Helper: extract column names from a Postgres filter expression ───
// Postgres filters look like: ((col1 = 'val'::text) AND (col2 > 100))
// Columns appear on the LEFT side of comparison operators.
function extractColumnsFromFilter(filter: string): string[] {
  if (!filter) return [];
  
  // Strategy: find identifiers immediately before comparison operators
  // Pattern: word (possibly with dots like schema.col) followed by operator
  const colMatches = filter.match(/\b([a-z_][a-z0-9_.]*)\s*(?:=|<>|!=|>=|<=|>|<|~~\*?|!~~\*?|\bIS\b|\bLIKE\b|\bILIKE\b|\bIN\b|\bBETWEEN\b|\bANY\b)/gi) || [];
  
  const reserved = new Set([
    // SQL keywords
    "AND", "OR", "NOT", "IS", "NULL", "TRUE", "FALSE", "IN",
    "LIKE", "ILIKE", "BETWEEN", "ANY", "ALL", "EXISTS", "SIMILAR",
    "SELECT", "FROM", "WHERE", "JOIN", "ON", "GROUP", "BY", "ORDER",
    "HAVING", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT",
    "INSERT", "UPDATE", "DELETE", "SET", "VALUES", "INTO", "AS",
    "CASE", "WHEN", "THEN", "ELSE", "END", "COALESCE", "NULLIF",
    // Postgres type casts that appear as trailing ::type
    "text", "integer", "bigint", "numeric", "boolean", "timestamp",
    "timestamptz", "date", "varchar", "char", "uuid", "jsonb", "json",
    "int4", "int8", "int2", "float4", "float8", "bpchar", "interval",
    "serial", "bigserial", "inet", "cidr", "macaddr", "macaddr8",
    // Common table aliases that appear as single chars
    "t1", "t2", "t3", "t4", "t5",
  ]);

  const columns: string[] = [];
  for (const match of colMatches) {
    // Extract only the identifier part (before the operator)
    const identMatch = match.match(/^([a-z_][a-z0-9_.]*)/i);
    if (identMatch) {
      const col = identMatch[1];
      // Skip reserved words, type casts, and pure numbers
      if (!reserved.has(col.toUpperCase()) && !/^\d+$/.test(col)) {
        // Remove schema prefix if present (e.g. "t1.col" -> "col")
        const cleanCol = col.includes('.') ? col.split('.').pop()! : col;
        if (!reserved.has(cleanCol.toUpperCase())) {
          columns.push(cleanCol);
        }
      }
    }
  }
  
  return [...new Set(columns)];
}

// ─── Helper: is a node a CTE / subquery / derived relation (not a real table)? ───
function isCTEOrSubquery(node: PlanNode): boolean {
  // Nodes with Alias but no Relation Name are CTE scans, subquery scans, etc.
  // They don't represent real table storage.
  return !node["Relation Name"] && !!node["Alias"];
}

// ─── Helper: find the REAL table name for a node, skipping CTE wrappers ───
function getNodeTableName(node: PlanNode): string {
  // If this node IS a real table (has Relation Name), use it
  if (node["Relation Name"]) {
    if (node["Schema"]) {
      return `${node["Schema"]}.${node["Relation Name"]}`;
    }
    return node["Relation Name"];
  }
  // This node has no Relation Name — it's a CTE, subquery, or derived relation.
  // Walk INTO children (deeper in the tree) to find the real underlying table.
  // BUT: don't recurse INTO other CTE/subquery nodes (which would find MORE aliases).
  if (node.Plans) {
    for (const child of node.Plans) {
      // Only descend if child IS a real table (has Relation Name)
      if (child["Relation Name"]) {
        const name = getNodeTableName(child);
        if (name !== "unknown") return name;
      }
    }
  }
  return "unknown";
}

// ─── Helper: find the first REAL table name anywhere in the subtree ───
function findRealTableInSubtree(node: PlanNode): string | null {
  if (node["Relation Name"]) {
    if (node["Schema"]) {
      return `${node["Schema"]}.${node["Relation Name"]}`;
    }
    return node["Relation Name"];
  }
  if (node.Plans) {
    for (const child of node.Plans) {
      const found = findRealTableInSubtree(child);
      if (found) return found;
    }
  }
  return null;
}

// ─── Helper: safe index name from table name ───
function safeIndexName(tableName: string, cols: string[]): string {
  // Replace dots and special chars with underscores for the index name
  const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  const safeCols = cols.map(c => c.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase()).join("_");
  return `idx_${safeTable}_${safeCols}`;
}

// ─── Helper: count all nodes ───
function countNodes(node: PlanNode): number {
  let count = 1;
  if (node.Plans) node.Plans.forEach(p => count += countNodes(p));
  return count;
}

// ─── Helper: collect node type counts ───
function collectNodeTypes(node: PlanNode, map: Map<string, number>) {
  const t = node["Node Type"];
  map.set(t, (map.get(t) || 0) + 1);
  if (node.Plans) node.Plans.forEach(p => collectNodeTypes(p, map));
}

export function VisualOptimizer({ data, onApplyFix }: VisualOptimizerProps) {
  const ai = useAI();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [appliedFixes, setAppliedFixes] = useState<Set<number>>(new Set());
  const [isAIExplaining, setIsAIExplaining] = useState(false);
  const [aiAnalysis, setAIAnalysis] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"tree" | "explain" | "analyze">("tree");

  const canUseAI = ai.enabled && !!ai.apiKey;

  // Extract data and dbType from payload format
  const rawData = data?.data || data;
  const dbType = data?.dbType || "postgres";

  // Extract database error if present
  const dbError = useMemo(() => {
    if (!rawData || !Array.isArray(rawData) || rawData.length === 0) return null;
    const firstRow = rawData[0];
    // Check for common database error patterns
    if (firstRow?.error) return firstRow.error;
    if (firstRow?.message) return firstRow.message;
    // Check for Postgres-style errors in message field
    const msg = firstRow?.message || firstRow?.Error || firstRow?.error || "";
    if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("table") || msg.includes("ERROR:")) {
      return msg;
    }
    return null;
  }, [rawData]);

  // Parse plan based on database type
  const plan: PlanNode | PlanNode[] | null = useMemo(() => {
    if (!rawData) {
      logger.warn('[VisualOptimizer] No raw data provided');
      return null;
    }
    
    if (!Array.isArray(rawData)) {
      logger.warn('[VisualOptimizer] Raw data is not an array:', typeof rawData);
      return null;
    }
    
    if (rawData.length === 0) {
      logger.warn('[VisualOptimizer] Raw data array is empty');
      return null;
    }

    // Handle different database types
    if (["postgres", "supabase", "cockroach"].includes(dbType)) {
      // PostgreSQL format
      logger.debug('[VisualOptimizer] Parsing PostgreSQL/Supabase plan...');
      
      // Check if it's an error result
      if (rawData[0]?.error || rawData[0]?.message) {
        console.error('[VisualOptimizer] PostgreSQL error:', rawData[0]);
        return null;
      }
      
      // Try different possible response formats
      if (rawData[0].Plan) return rawData[0].Plan;
      
      const rawPlan = rawData[0]['QUERY PLAN'] || rawData[0]['query plan'] || rawData[0]['Plan'];
      if (rawPlan) {
        if (Array.isArray(rawPlan) && rawPlan.length > 0) return rawPlan[0].Plan || rawPlan[0];
        if (typeof rawPlan === 'string') {
          try {
            const parsed = JSON.parse(rawPlan);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].Plan || parsed[0];
            return parsed.Plan || parsed;
          } catch (e) {
            console.error('[VisualOptimizer] JSON parse error:', e);
            return null;
          }
        }
        return rawPlan.Plan || rawPlan;
      }
      
      // Try to find plan in any key
      const firstRow = rawData[0];
      for (const key of Object.keys(firstRow)) {
        if (typeof firstRow[key] === 'object' && firstRow[key]?.Plan) {
          return firstRow[key].Plan;
        }
      }
      
      logger.warn('[VisualOptimizer] Could not find PostgreSQL plan in response:', rawData[0]);
      return null;
    } else if (["mysql", "mariadb"].includes(dbType)) {
      // MySQL FORMAT=JSON format
      logger.debug('[VisualOptimizer] Parsing MySQL/MariaDB plan...');
      
      // Check for error
      if (rawData[0]?.error || rawData[0]?.message) {
        console.error('[VisualOptimizer] MySQL error:', rawData[0]);
        return null;
      }
      
      return rawData[0] || rawData;
    } else if (dbType === "sqlite") {
      // SQLite EXPLAIN QUERY PLAN format - convert to plan nodes
      logger.debug('[VisualOptimizer] Parsing SQLite query plan...');
      return rawData.map((row: any) => ({
        "Node Type": row.opcode || row.detail || "SQLite Query",
        "Relation Name": row.tablename || null,
        "Plan Rows": 0,
        "Actual Rows": 0,
        "Plan Notes": row.detail
      }));
    }
    
    logger.debug('[VisualOptimizer] Using default parse for:', dbType);
    return rawData[0] || rawData;
  }, [rawData, dbType]);

  // Handle array of plans vs single plan
  const mainPlan = Array.isArray(plan) ? plan[0] : plan;

  const executionTime = useMemo(() => {
    if (!rawData || !Array.isArray(rawData) || rawData.length === 0) return 0;
    const firstRow = rawData[0];
    if (dbType === "postgres" || dbType === "supabase" || dbType === "cockroach") {
      const rawPlan = firstRow['QUERY PLAN'] || firstRow['query plan'];
      if (Array.isArray(rawPlan) && rawPlan.length > 0) return rawPlan[0]?.["Execution Time"] || 0;
      return firstRow?.["Execution Time"] || 0;
    }
    // For MySQL/SQLite, try to get execution time from other fields
    return firstRow?.["EXPLAIN time"] || firstRow?.execution_time || 0;
  }, [rawData, dbType]);

  // ─── Statistics ───
  const stats = useMemo(() => {
    if (!mainPlan) return null;
    const totalNodes = countNodes(mainPlan);
    const typeMap = new Map<string, number>();
    collectNodeTypes(mainPlan, typeMap);
    return { totalNodes, typeMap };
  }, [mainPlan]);

  // ─── Heuristic Engine with actionable SQL fixes ───
  const { insights, hotPath } = useMemo(() => {
    if (!mainPlan) return { insights: [], hotPath: new Set<PlanNode>() };
    const list: OptimizerInsight[] = [];
    const hotPathNodes = new Set<PlanNode>();

    const traverse = (node: PlanNode) => {
      const time = node["Actual Total Time"] || 0;
      const rows = node["Actual Rows"] || 0;
      const planRows = node["Plan Rows"] || 0;
      const removedByFilter = node["Rows Removed by Filter"] || 0;
      
      if (executionTime > 0 && (time / executionTime) > 0.15) {
        hotPathNodes.add(node);
      }

      // Rule 1: Seq Scan on large tables → suggest CREATE INDEX
      if (node["Node Type"] === "Seq Scan" && rows > 500) {
        const tableName = getNodeTableName(node);
        // If no table found (CTE wrapper), drill into children to find the real table
        const realTable = tableName === "unknown" ? (findRealTableInSubtree(node) || "unknown") : tableName;
        const filterExpr = node["Filter"] || "";
        const cols = extractColumnsFromFilter(filterExpr);

        if (cols.length > 0 && realTable !== "unknown") {
          // We found real column names — generate a proper CREATE INDEX
          const indexName = safeIndexName(realTable, cols);
          const fixSql = `CREATE INDEX CONCURRENTLY ${indexName} ON ${realTable} (${cols.join(", ")});`;

          list.push({
            type: "critical",
            title: "Sequential Scan – Missing Index",
            message: `Table "${realTable}" scanned ${rows.toLocaleString()} rows without an index.${removedByFilter > 0 ? ` ${removedByFilter.toLocaleString()} rows removed by filter.` : ""} Columns used in filter: ${cols.join(", ")}`,
            fix: fixSql,
            fixLabel: "Create Index",
            table: realTable,
            columns: cols
          });
        } else if (filterExpr && realTable !== "unknown") {
          // Couldn't parse columns, but there IS a filter — show it raw
          list.push({
            type: "critical",
            title: "Sequential Scan – Missing Index",
            message: `Table "${realTable}" scanned ${rows.toLocaleString()} rows sequentially.${removedByFilter > 0 ? ` ${removedByFilter.toLocaleString()} rows removed by filter.` : ""}\n\nFilter: ${filterExpr}\n\nIdentify the column(s) above and create an index.`,
            fix: `-- Identify the column(s) from the filter above, then run:\nCREATE INDEX CONCURRENTLY idx_${realTable.replace(/[^a-zA-Z0-9_]/g, "_")}_<column> ON ${realTable} (<column>);`,
            fixLabel: "Create Index (edit column)",
            table: realTable,
          });
        } else {
          // No table name or filter detected — can't generate actionable SQL
          // Just warn about the full table scan
          list.push({
            type: tableName === "unknown" ? "info" : "warning",
            title: "Full Table Scan",
            message: tableName !== "unknown"
              ? `Table "${tableName}" was fully scanned (${rows.toLocaleString()} rows). If you're filtering in the application layer, push those filters into the WHERE clause so Postgres can use an index.`
              : `A node scanned ${rows.toLocaleString()} rows sequentially without an index. Consider adding appropriate indexes to support the query filters.`,
          });
        }
      }

      // Rule 2: Filter on Scan without Index (including CTE/subquery wrappers like Subquery Scan)
      if (node["Filter"] && node["Node Type"].includes("Scan") && !node["Node Type"].includes("Index")) {
        const cols = extractColumnsFromFilter(node["Filter"]);
        const tableName = getNodeTableName(node);
        // If no table found, try drilling down to the first real table in the subtree
        const realTable = tableName === "unknown" ? (findRealTableInSubtree(node) || "unknown") : tableName;
        if (cols.length > 0 && node["Node Type"] !== "Seq Scan" && realTable !== "unknown") {
          const indexName = safeIndexName(realTable, cols);
          list.push({
            type: "warning",
            title: "Filter Without Index",
            message: `Scan on "${realTable}" uses a filter on columns (${cols.join(", ")}). Adding an index can eliminate unnecessary row reads.`,
            fix: `CREATE INDEX CONCURRENTLY ${indexName} ON ${realTable} (${cols.join(", ")});`,
            fixLabel: "Create Index",
            table: realTable,
            columns: cols
          });
        } else if (cols.length > 0 && realTable === "unknown" && !isCTEOrSubquery(node)) {
          // No table resolved — can't generate SQL, but report the finding
          list.push({
            type: "info",
            title: "Filter Detected",
            message: `A scan uses filter on columns (${cols.join(", ")}), but the table name could not be determined from the plan. Identify the table and add an index manually.`,
          });
        }
      }

      // Rule 3: Row estimate mismatch — only for nodes with a real table
      if (planRows > 0 && rows > 0 && node["Relation Name"]) {
        const ratio = rows / planRows;
        if (ratio > 10 || ratio < 0.1) {
          list.push({
            type: "warning",
            title: "Row Estimate Mismatch",
            message: `Table "${node["Relation Name"]}": planner estimated ${planRows.toLocaleString()} rows but got ${rows.toLocaleString()} (${ratio > 1 ? ratio.toFixed(0) + "x more" : (1/ratio).toFixed(0) + "x fewer"}). Run ANALYZE to update statistics.`,
            fix: `ANALYZE ${node["Relation Name"]};`,
            fixLabel: "Update Stats",
            table: node["Relation Name"]
          });
        }
      }

      // Rule 4: Nested Loop on high row count — inspect children to find join columns
      if (node["Node Type"] === "Nested Loop" && rows > 5000 && node.Plans && node.Plans.length >= 2) {
        const outerNode = node.Plans[0];
        const innerNode = node.Plans[1];

        // Find the inner table name (it's the one being looped over)
        const innerTable = getNodeTableName(innerNode);
        const outerTable = getNodeTableName(outerNode);

        // Try to extract join columns from inner node's Index Cond or Filter
        const joinCond = innerNode["Index Cond"] || innerNode["Filter"] ||
                         (innerNode.Plans?.[0]?.["Filter"]) || (innerNode.Plans?.[0]?.["Index Cond"]) || "";
        const joinCols = extractColumnsFromFilter(joinCond);

        // Build actionable message
        const parts: string[] = [];
        parts.push(`Nested Loop produced ${rows.toLocaleString()} rows — this is slow for large datasets.`);

        if (outerTable !== "unknown" && innerTable !== "unknown") {
          parts.push(`Outer: "${outerTable}" → Inner: "${innerTable}" (looped ${(innerNode["Actual Loops"] || rows).toLocaleString()} times).`);
        }

        if (joinCols.length > 0 && innerTable !== "unknown") {
          parts.push(`Join columns on inner table: ${joinCols.join(", ")}.`);
          parts.push(`Add an index on "${innerTable}" (${joinCols.join(", ")}) so the inner loop uses an index lookup instead of a scan.`);

          const indexName = safeIndexName(innerTable, joinCols);
          list.push({
            type: "critical",
            title: "Expensive Nested Loop",
            message: parts.join(" "),
            fix: `CREATE INDEX CONCURRENTLY ${indexName} ON ${innerTable} (${joinCols.join(", ")});`,
            fixLabel: "Index Inner Table",
            table: innerTable,
            columns: joinCols
          });
        } else {
          // Fallback: give structural advice
          parts.push("The planner chose Nested Loop because one side is small — but the result is large.");
          parts.push("Options: (1) Add indexes on join columns of the inner table. (2) Increase work_mem to encourage Hash Join. (3) Rewrite the query to reduce the outer result set.");

          list.push({
            type: "critical",
            title: "Expensive Nested Loop",
            message: parts.join(" "),
            fix: innerTable !== "unknown"
              ? `-- Option 1: Index the join column on the inner table:\nCREATE INDEX CONCURRENTLY idx_${innerTable.replace(/[^a-zA-Z0-9_]/g, "_")}_<join_col> ON ${innerTable} (<join_col>);\n\n-- Option 2: Encourage Hash Join:\nSET work_mem = '256MB';`
              : `-- Encourage Hash Join by increasing work_mem:\nSET work_mem = '256MB';`,
            fixLabel: "See Options",
            table: innerTable !== "unknown" ? innerTable : (outerTable !== "unknown" ? outerTable : undefined)
          });
        }
      } else if (node["Node Type"] === "Nested Loop" && rows > 5000) {
        // Nested loop without child info
        list.push({
          type: "warning",
          title: "Expensive Nested Loop",
          message: `Nested Loop produced ${rows.toLocaleString()} rows. Increase work_mem to encourage the planner to use Hash Join instead.`,
          fix: `SET work_mem = '256MB'; -- Encourages Hash Join for large datasets`,
          fixLabel: "Increase work_mem"
        });
      }

      // Rule 5: Sort spilling to disk — read Sort Key for actionable index
      if (node["Node Type"] === "Sort") {
        const sortKeys: string[] = node["Sort Key"] || [];
        const sortMethod = node["Sort Method"] || "";
        const sortSpace = node["Sort Space Used"] || 0;

        if (sortMethod.toLowerCase().includes("disk")) {
          const sortColNames = sortKeys.map((k: string) => {
            const m = k.match(/^([a-z_][a-z0-9_.]*)/i);
            return m ? (m[1].includes('.') ? m[1].split('.').pop()! : m[1]) : null;
          }).filter(Boolean) as string[];

          const nearestTable = getNodeTableName(node);

          list.push({
            type: "critical",
            title: "Disk Sort Detected",
            message: `Sort spilled to disk (${sortSpace > 0 ? sortSpace + "kB used" : "exceeds work_mem"}). Sort keys: ${sortKeys.join(", ") || "unknown"}. This causes heavy I/O.`,
            fix: nearestTable !== "unknown" && sortColNames.length > 0
              ? `-- Option 1: Add index to avoid sort entirely:\nCREATE INDEX CONCURRENTLY ${safeIndexName(nearestTable, sortColNames)} ON ${nearestTable} (${sortColNames.join(", ")});\n\n-- Option 2: Increase memory for this session:\nSET work_mem = '256MB';`
              : `SET work_mem = '256MB'; -- Increase sort memory to avoid disk spill`,
            fixLabel: nearestTable !== "unknown" && sortColNames.length > 0 ? "Index Sort Columns" : "Increase work_mem",
            table: nearestTable !== "unknown" ? nearestTable : undefined,
            columns: sortColNames.length > 0 ? sortColNames : undefined
          });
        } else if (sortSpace > 1024) {
          // Large in-memory sort — still worth noting
          list.push({
            type: "info",
            title: "Large In-Memory Sort",
            message: `Sort used ${sortSpace}kB of memory. Sort keys: ${sortKeys.join(", ") || "unknown"}. Consider adding an index on the sort columns to eliminate the sort entirely.`,
          });
        }
      }

      // Rule 6: High shared read blocks (cache miss)
      const readBlocks = node["Shared Read Blocks"] || 0;
      const hitBlocks = node["Shared Hit Blocks"] || 0;
      if (readBlocks > 100 && hitBlocks > 0 && readBlocks / (readBlocks + hitBlocks) > 0.5) {
        list.push({
          type: "info",
          title: "Low Cache Hit Ratio",
          message: `"${node["Relation Name"] || node["Node Type"]}" read ${readBlocks.toLocaleString()} blocks from disk (${((readBlocks / (readBlocks + hitBlocks)) * 100).toFixed(0)}% miss). If this query runs frequently, increase shared_buffers. Otherwise, re-run — data may now be cached.`,
          fix: `-- Check current setting:\nSHOW shared_buffers;\n\n-- Increase in postgresql.conf (requires restart):\n-- shared_buffers = '1GB'`,
          fixLabel: "Check shared_buffers"
        });
      }

      // Rule 7: Hash Join using excessive memory
      if (node["Node Type"] === "Hash" && node["Peak Memory Usage"] && node["Peak Memory Usage"] > 10000) {
        list.push({
          type: "warning",
          title: "Large Hash Table",
          message: `Hash table used ${(node["Peak Memory Usage"] / 1024).toFixed(1)}MB of memory. If multiple queries run concurrently, this can cause memory pressure. Consider adding an index to avoid the hash.`,
        });
      }

      // Rule 8: Materialize node (often indicates suboptimal plan)
      if (node["Node Type"] === "Materialize" && (node["Actual Loops"] || 1) > 10) {
        const matTable = getNodeTableName(node);
        list.push({
          type: "warning",
          title: "Repeated Materialization",
          message: matTable !== "unknown"
            ? `Results from "${matTable}" were materialized and re-scanned ${(node["Actual Loops"] || 0).toLocaleString()} times. This usually means the planner couldn't find a suitable index for a join. Index the join column to eliminate this.`
            : `Results were materialized and re-scanned ${(node["Actual Loops"] || 0).toLocaleString()} times. This usually means the planner couldn't find a suitable index. Consider adding indexes on join columns.`,
        });
      }

      if (node.Plans) node.Plans.forEach(traverse);
    };

    if (mainPlan) traverse(mainPlan);
    
    if (executionTime > 100) {
      list.push({
        type: "info",
        title: "Performance Target",
        message: `Current: ${executionTime.toFixed(2)}ms. Apply the suggested fixes above to aim for sub-${Math.max(10, Math.round(executionTime / 5))}ms latency.`
      });
    }

    if (list.length === 0) {
      list.push({
        type: "success",
        title: "Query Looks Good",
        message: "No significant bottlenecks detected. The query is using indexes efficiently and estimates are accurate."
      });
    }

    return { insights: list, hotPath: hotPathNodes };
  }, [plan, executionTime]);

  const copyToClipboard = useCallback((text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  }, []);

  const callAI = useCallback(async (systemPrompt: string, userPrompt: string): Promise<string> => {
    if (!ai.enabled || !ai.apiKey) {
      throw new Error("AI is not configured");
    }

    let endpoint = "";
    let body: Record<string, any> = {};
    let headers: Record<string, string> = {};

    if (ai.provider === "openai") {
      endpoint = ai.endpoint || "https://api.openai.com/v1/chat/completions";
      headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ai.apiKey}`,
      };
      body = {
        model: ai.model || "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      };
    } else if (ai.provider === "anthropic") {
      endpoint = ai.endpoint || "https://api.anthropic.com/v1/messages";
      headers = {
        "Content-Type": "application/json",
        "x-api-key": ai.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      };
      body = {
        model: ai.model || "claude-3-5-sonnet-20241014",
        messages: [{ role: "user", content: userPrompt }],
        system: systemPrompt,
        max_tokens: 2000,
      };
    } else if (ai.provider === "google") {
      endpoint = ai.endpoint || `https://generativelanguage.googleapis.com/v1beta/models/${ai.model || "gemini-1.5-flash"}:generateContent?key=${ai.apiKey}`;
      headers = { "Content-Type": "application/json" };
      body = {
        contents: [{ parts: [{ text: `System: ${systemPrompt}\n\nUser: ${userPrompt}` }] }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.3 },
      };
    } else if (ai.provider === "local") {
      endpoint = ai.endpoint || "http://localhost:11434/api/chat";
      body = {
        model: ai.model || "llama3",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
      };
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`AI API error (${response.status}): ${err}`);
    }

    const result = await response.json();

    // Extract response text from provider-specific response shapes
    if (ai.provider === "openai") {
      return result.choices?.[0]?.message?.content || "";
    } else if (ai.provider === "anthropic") {
      return result.content?.[0]?.text || "";
    } else if (ai.provider === "google") {
      return result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else if (ai.provider === "local") {
      return result.message?.content || "";
    }
    return "";
  }, [ai]);

  const handleAIExplain = useCallback(async () => {
    if (!canUseAI) return;
    setIsAIExplaining(true);
    setAIAnalysis(null);
    try {
      const planJson = JSON.stringify(rawData, null, 2);
      const systemPrompt = `You are an expert PostgreSQL database performance engineer. Analyze EXPLAIN ANALYZE output and provide clear, actionable advice. Be concise and specific.`;

      const userPrompt = `Analyze this PostgreSQL query execution plan and explain:
1. What the query is doing
2. Key performance bottlenecks
3. Specific, actionable fixes with SQL examples

Execution Plan (JSON):
${planJson}

Provide your analysis in plain English with specific SQL fix suggestions.`;

      const analysis = await callAI(systemPrompt, userPrompt);
      setAIAnalysis(analysis || "AI could not generate an analysis for this plan.");
    } catch (err: any) {
      setAIAnalysis(`AI Error: ${err?.message || "Failed to get AI response. Check your API key and endpoint settings."}`);
    } finally {
      setIsAIExplaining(false);
    }
  }, [canUseAI, rawData, callAI]);

  const handleApplyFix = useCallback((sql: string, idx: number) => {
    if (onApplyFix) {
      onApplyFix(sql);
      setAppliedFixes(prev => new Set(prev).add(idx));
    }
  }, [onApplyFix]);

  if (!plan) {
    // Show a more helpful message based on database type
    const supportedTypes = ["postgres", "supabase", "cockroach", "mysql", "mariadb", "sqlite"];
    const isSupported = supportedTypes.includes(dbType);

    // Issue 1: Show actual database error cleanly if present
    if (dbError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8">
          <AlertTriangle className="w-12 h-12 text-red-400 mb-4" />
          <h3 className="font-bold text-red-400">Database Error</h3>
          <p className="text-xs mt-2 text-[var(--text-secondary)]">The query returned an error:</p>
          <pre className="text-xs font-mono mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-300 max-w-lg whitespace-pre-wrap">
            {dbError}
          </pre>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-[var(--text-secondary)] opacity-50">
        <AlertTriangle className="w-12 h-12 mb-4" />
        <h3 className="font-bold">Invalid Plan Format</h3>
        <p className="text-xs mt-2">
          {!isSupported
            ? `Database type "${dbType}" may not be supported for visualization.`
            : "Could not parse the execution plan output."}
        </p>
        <p className="text-[10px] mt-1 opacity-60">
          {["postgres", "supabase", "cockroach"].includes(dbType)
            ? "Use: EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)"
            : ["mysql", "mariadb"].includes(dbType)
            ? "Use: EXPLAIN FORMAT=JSON"
            : dbType === "sqlite"
            ? "Use: EXPLAIN QUERY PLAN"
            : "Run EXPLAIN on your query and try again."}
        </p>
        {rawData && rawData.length > 0 && (
          <div className="mt-4 p-3 bg-[var(--surface)] rounded-lg border border-[var(--border)] max-w-lg">
            <p className="text-[9px] font-mono opacity-60">Raw output preview:</p>
            <pre className="text-[9px] font-mono mt-2 max-h-24 overflow-auto">
              {JSON.stringify(rawData.slice(0, 2), null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  const containerClass = isFullscreen
    ? "fixed inset-0 z-[200] flex bg-[var(--background)] animate-in fade-in zoom-in-95 duration-200"
    : "flex h-full bg-[var(--background)] animate-in fade-in duration-300";

  return (
    <div className={containerClass}>
      {/* Left Pane: Plan Tree */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-[var(--border)]">
        {/* Header */}
        <div className="p-3 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface)]">
          <div className="flex items-center gap-2">
            <Layout className="w-4 h-4 text-blue-400" />
            <h3 className="font-bold text-xs uppercase tracking-widest">Execution Journey</h3>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              {dbType.toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* View Toggle */}
            <div className="flex items-center bg-[var(--background)] rounded-lg p-0.5 border border-[var(--border)]">
              <button
                onClick={() => setActiveView("tree")}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${activeView === "tree" ? "bg-[var(--color-accent)] text-white" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
              >
                Tree
              </button>
              <button
                onClick={() => setActiveView("explain")}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${activeView === "explain" ? "bg-purple-500 text-white" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
              >
                Explain
              </button>
              <button
                onClick={() => setActiveView("analyze")}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${activeView === "analyze" ? "bg-emerald-500 text-white" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
              >
                Analyze
              </button>
            </div>
            <div className="flex items-center gap-4 text-[10px] font-mono opacity-60">
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {executionTime.toFixed(2)}ms</span>
              <span className="flex items-center gap-1"><Zap className="w-3 h-3 text-amber-400" /> {hotPath.size} Hot</span>
              {stats && <span className="flex items-center gap-1"><Layers className="w-3 h-3" /> {stats.totalNodes} Nodes</span>}
            </div>
            <button
               onClick={handleAIExplain}
               disabled={isAIExplaining || !canUseAI}
               title={!canUseAI ? "Enable AI in Settings to unlock AI Explain" : "Get AI-powered analysis of this query plan"}
               className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-bold transition-all border ${
                 !canUseAI
                   ? "bg-[var(--background)]/50 border-[var(--border)] text-[var(--text-secondary)] cursor-not-allowed opacity-40"
                   : isAIExplaining
                   ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                   : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
               }`}
            >
               <Sparkles className={`w-3 h-3 ${isAIExplaining ? "animate-spin" : ""}`} />
               {isAIExplaining ? "AI Thinking..." : "AI Explain"}
            </button>
            <button
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {aiAnalysis && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/20 text-amber-200">
            <div className="flex items-center gap-2 mb-1.5">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <h4 className="text-[11px] font-black uppercase tracking-widest">Semantic AI Insight</h4>
              <button onClick={() => setAIAnalysis(null)} className="ml-auto opacity-40 hover:opacity-100"><XCircle className="w-3.5 h-3.5" /></button>
            </div>
            <p className="text-[10px] leading-relaxed italic">{aiAnalysis}</p>
          </div>
        )}

        {/* Stats Bar */}
        {stats && (
          <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-3 overflow-x-auto">
            {[...stats.typeMap.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([type, count]) => (
                <span key={type} className={`text-[9px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 whitespace-nowrap ${
                  type.includes("Seq Scan") ? "bg-red-500/10 border-red-500/30 text-red-400" :
                  type.includes("Index") ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" :
                  type.includes("Join") ? "bg-purple-500/10 border-purple-500/30 text-purple-400" :
                  type.includes("Sort") || type.includes("Hash") ? "bg-amber-500/10 border-amber-500/30 text-amber-400" :
                  "bg-blue-500/10 border-blue-500/30 text-blue-400"
                }`}>
                  {type} <span className="opacity-60">×{count}</span>
                </span>
              ))}
          </div>
        )}
        
        {/* Tree / Explain / Analyze Views */}
        <div className="flex-1 overflow-auto p-6 scrollbar-thin">
          {activeView === "tree" && mainPlan && (
            <div className={`${isFullscreen ? "max-w-4xl" : "max-w-2xl"} mx-auto space-y-4 pb-12`}>
              <TreeNode node={mainPlan} depth={0} isHot={hotPath.has(mainPlan)} totalTime={executionTime} />
            </div>
          )}
          {activeView === "explain" && (
            <div className={`${isFullscreen ? "max-w-4xl" : "max-w-2xl"} mx-auto space-y-4 pb-12`}>
              <h4 className="text-xs font-bold text-purple-400 uppercase tracking-widest mb-4">Explain Plan</h4>
              <pre className="text-[10px] font-mono bg-[var(--surface)] p-4 rounded-xl border border-[var(--border)] overflow-auto whitespace-pre-wrap">
                {JSON.stringify(rawData, null, 2)}
              </pre>
            </div>
          )}
          {activeView === "analyze" && (
            <div className={`${isFullscreen ? "max-w-4xl" : "max-w-2xl"} mx-auto space-y-4 pb-12`}>
              <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-widest mb-4">Execution Analysis</h4>
              {executionTime > 0 && (
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="p-3 bg-[var(--surface)] rounded-lg border border-[var(--border)]">
                    <p className="text-[9px] text-[var(--text-secondary)] uppercase">Total Time</p>
                    <p className="text-lg font-bold text-emerald-400">{executionTime.toFixed(2)}ms</p>
                  </div>
                  <div className="p-3 bg-[var(--surface)] rounded-lg border border-[var(--border)]">
                    <p className="text-[9px] text-[var(--text-secondary)] uppercase">Hot Path Nodes</p>
                    <p className="text-lg font-bold text-amber-400">{hotPath.size}</p>
                  </div>
                  {stats && (
                    <>
                      <div className="p-3 bg-[var(--surface)] rounded-lg border border-[var(--border)]">
                        <p className="text-[9px] text-[var(--text-secondary)] uppercase">Total Nodes</p>
                        <p className="text-lg font-bold text-blue-400">{stats.totalNodes}</p>
                      </div>
                      <div className="p-3 bg-[var(--surface)] rounded-lg border border-[var(--border)]">
                        <p className="text-[9px] text-[var(--text-secondary)] uppercase">Insights</p>
                        <p className="text-lg font-bold text-purple-400">{insights.length}</p>
                      </div>
                    </>
                  )}
                </div>
              )}
              {insights.length > 0 && (
                <div className="space-y-2">
                  {insights.filter(i => i.type !== "success").map((insight, i) => (
                    <div key={i} className={`p-3 rounded-lg border ${
                      insight.type === "critical" ? "bg-red-500/10 border-red-500/30" :
                      insight.type === "warning" ? "bg-amber-500/10 border-amber-500/30" :
                      "bg-blue-500/10 border-blue-500/30"
                    }`}>
                      <p className="text-[10px] font-bold">{insight.title}</p>
                      <p className="text-[9px] opacity-70 mt-1">{insight.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Pane: Optimization Advice */}
      <div className={`${isFullscreen ? "w-[420px]" : "w-80"} flex flex-col bg-[var(--surface-raised)] shrink-0`}>
        <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <h3 className="font-bold text-xs uppercase tracking-widest">Optimization Engine</h3>
          </div>
          <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
            insights.some(i => i.type === "critical") ? "bg-red-500/20 text-red-400" :
            insights.some(i => i.type === "warning") ? "bg-amber-500/20 text-amber-400" :
            "bg-emerald-500/20 text-emerald-400"
          }`}>
            {insights.filter(i => i.type === "critical").length} critical · {insights.filter(i => i.type === "warning").length} warnings
          </span>
        </div>
        
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {insights.map((insight, i) => (
            <InsightCard
              key={i}
              insight={insight}
              index={i}
              copiedIdx={copiedIdx}
              isApplied={appliedFixes.has(i)}
              onCopy={copyToClipboard}
              onApply={onApplyFix ? handleApplyFix : undefined}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="p-3 bg-[var(--background)] border-t border-[var(--border)]">
          <div className="text-[9px] font-bold text-[var(--text-secondary)] uppercase mb-2 opacity-40 tracking-widest text-center">Analysis Modules</div>
          <div className="grid grid-cols-3 gap-1.5 text-[8px]">
            <div className="px-1.5 py-1 rounded bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1 justify-center">
              <Database className="w-2.5 h-2.5 text-blue-400" /> Index
            </div>
            <div className="px-1.5 py-1 rounded bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1 justify-center">
              <Search className="w-2.5 h-2.5 text-emerald-400" /> Scans
            </div>
            <div className="px-1.5 py-1 rounded bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1 justify-center">
              <List className="w-2.5 h-2.5 text-amber-400" /> Joins
            </div>
            <div className="px-1.5 py-1 rounded bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1 justify-center">
              <Activity className="w-2.5 h-2.5 text-rose-400" /> Hot Path
            </div>
            <div className="px-1.5 py-1 rounded bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1 justify-center">
              <BarChart3 className="w-2.5 h-2.5 text-purple-400" /> Estimates
            </div>
            <div className="px-1.5 py-1 rounded bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1 justify-center">
              <Shield className="w-2.5 h-2.5 text-cyan-400" /> Cache
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Insight Card with actionable SQL ───
function InsightCard({ insight, index, copiedIdx, isApplied, onCopy, onApply }: {
  insight: OptimizerInsight;
  index: number;
  copiedIdx: number | null;
  isApplied: boolean;
  onCopy: (text: string, idx: number) => void;
  onApply?: (sql: string, idx: number) => void;
}) {
  const [expanded, setExpanded] = useState(insight.type === "critical");
  
  const colors = {
    critical: "bg-red-500/10 border-red-500/30 text-red-300",
    warning: "bg-amber-500/10 border-amber-500/30 text-amber-200",
    success: "bg-emerald-500/10 border-emerald-500/30 text-emerald-200",
    info: "bg-blue-500/10 border-blue-500/30 text-blue-200",
  };

  const icons = {
    critical: <AlertTriangle className="w-4 h-4 text-red-400" />,
    warning: <AlertTriangle className="w-4 h-4 text-amber-400" />,
    success: <Check className="w-4 h-4 text-emerald-400" />,
    info: <Info className="w-4 h-4 text-blue-400" />,
  };

  return (
    <div className={`rounded-xl border transition-all ${colors[insight.type]} ${expanded ? "p-3" : "p-2.5"}`}>
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 text-left">
        {icons[insight.type]}
        <span className="text-[11px] font-bold flex-1 tracking-tight">{insight.title}</span>
        {insight.fix && !isApplied && <Target className="w-3 h-3 opacity-40" />}
        {isApplied && <Check className="w-3 h-3 text-emerald-400" />}
        {expanded ? <ChevronDown className="w-3 h-3 opacity-40" /> : <ChevronRight className="w-3 h-3 opacity-40" />}
      </button>
      
      {expanded && (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] leading-relaxed opacity-80">{insight.message}</p>
          
          {insight.table && (
            <div className="flex items-center gap-1.5 text-[9px] opacity-60">
              <Database className="w-3 h-3" />
              <span className="font-mono">{insight.table}</span>
              {insight.columns && insight.columns.length > 0 && (
                <>
                  <ArrowRight className="w-2.5 h-2.5" />
                  {insight.columns.map((col, i) => (
                    <span key={i} className="font-mono px-1 py-0.5 bg-white/5 rounded">{col}</span>
                  ))}
                </>
              )}
            </div>
          )}

          {insight.fix && (
            <div className="mt-2">
              <div className="p-2.5 bg-black/30 rounded-lg border border-white/5 font-mono text-[10px] leading-relaxed text-emerald-300 select-all">
                {insight.fix}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={(e) => { e.stopPropagation(); onCopy(insight.fix!, index); }}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] font-bold bg-white/5 hover:bg-white/10 border border-white/10 transition-all"
                >
                  {copiedIdx === index ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {copiedIdx === index ? "Copied!" : "Copy SQL"}
                </button>
                {onApply && !isApplied && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onApply(insight.fix!, index); }}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] font-bold bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-emerald-400 transition-all"
                  >
                    <Play className="w-3 h-3" /> Apply Fix
                  </button>
                )}
                {isApplied && (
                  <span className="flex items-center gap-1 px-2 py-1 text-[9px] font-bold text-emerald-400">
                    <Check className="w-3 h-3" /> Applied
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tree Node (compact at deeper depths) ───
function TreeNode({ node, depth, isHot, totalTime }: { node: PlanNode; depth: number; isHot: boolean; totalTime: number }) {
  const [isExpanded, setIsExpanded] = React.useState(depth < 4);
  const percent = totalTime > 0 ? ((node["Actual Total Time"] || 0) / totalTime) * 100 : 0;
  const actualRows = node["Actual Rows"] || 0;
  
  // Compact sizing: reduce padding, icon size, indent, and gaps for deeper nodes
  const isCompact = depth >= 2;
  const isVeryCompact = depth >= 4;
  const iconSize = isVeryCompact ? "w-3 h-3" : isCompact ? "w-3.5 h-3.5" : "w-4 h-4";
  const iconBoxSize = isVeryCompact ? "w-6 h-6 rounded-md" : isCompact ? "w-7 h-7 rounded-lg" : "w-10 h-10 rounded-xl";
  const cardPad = isVeryCompact ? "p-2 gap-2" : isCompact ? "p-2.5 gap-3" : "p-4 gap-4";
  const cardRound = isVeryCompact ? "rounded-lg" : isCompact ? "rounded-xl" : "rounded-2xl";
  const titleSize = isVeryCompact ? "text-[11px]" : isCompact ? "text-xs" : "text-sm";
  const childIndentMl = isVeryCompact ? "ml-4" : isCompact ? "ml-6" : "ml-10";
  const childIndentPl = isVeryCompact ? "pl-3" : isCompact ? "pl-4" : "pl-6";
  const childGap = isVeryCompact ? "space-y-1.5" : isCompact ? "space-y-2" : "space-y-4";
  const childMt = isVeryCompact ? "mt-1.5" : isCompact ? "mt-2" : "mt-4";
  const connW = isVeryCompact ? "w-3" : isCompact ? "w-4" : "w-6";
  const connLeft = isVeryCompact ? "-left-3" : isCompact ? "-left-4" : "-left-6";

  const getIcon = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes("seq scan")) return <Search className={iconSize + " text-red-400"} />;
    if (t.includes("index")) return <Database className={iconSize + " text-emerald-400"} />;
    if (t.includes("join")) return <TrendingUp className={iconSize + " text-purple-400"} />;
    if (t.includes("sort") || t.includes("hash")) return <Activity className={iconSize + " text-amber-400"} />;
    if (t.includes("aggregate") || t.includes("group")) return <BarChart3 className={iconSize + " text-cyan-400"} />;
    return <Layers className={iconSize + " text-blue-400"} />;
  };

  const barWidth = Math.max(3, Math.min(100, percent));

  return (
    <div className="flex flex-col">
      <div 
        className={`group relative flex items-start ${cardPad} ${cardRound} border transition-all ${
          isHot 
            ? "border-amber-500/50 bg-amber-500/5 shadow-lg shadow-amber-500/5" 
            : "border-[var(--border)] bg-[var(--surface-raised)] hover:border-blue-500/30"
        }`}
      >
        {depth > 0 && (
          <div className={`absolute ${connLeft} top-1/2 ${connW} h-px bg-[var(--border)] opacity-50`} />
        )}
        
        <div className={`shrink-0 ${iconBoxSize} flex items-center justify-center border ${
           isHot ? "bg-amber-500/20 border-amber-500/40" : "bg-[var(--background)] border-[var(--border)] opacity-80"
        }`}>
          {getIcon(node["Node Type"])}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-0.5">
            <h4 className={`font-black ${titleSize} tracking-tight flex items-center gap-1.5 truncate`}>
              {node["Node Type"]}
              {node["Strategy"] && !isVeryCompact && <span className="text-[9px] font-normal opacity-50">({node["Strategy"]})</span>}
              {isHot && <Zap className="w-3 h-3 text-amber-400 fill-amber-400 animate-pulse shrink-0" />}
            </h4>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
               <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${
                 percent > 50 ? "bg-red-500/20 text-red-400" : 
                 percent > 15 ? "bg-amber-500/20 text-amber-400" : 
                 "bg-[var(--border)] text-[var(--text-secondary)]"
               }`}>
                 {percent.toFixed(1)}%
               </span>
               <button 
                 onClick={() => setIsExpanded(!isExpanded)}
                 className={`p-0.5 rounded hover:bg-white/5 transition-colors ${node.Plans?.length ? "" : "invisible"}`}
               >
                 {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
               </button>
            </div>
          </div>

          {/* Cost bar */}
          <div className="h-0.5 bg-[var(--border)] rounded-full mb-1.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${
                percent > 50 ? "bg-red-500" : percent > 15 ? "bg-amber-500" : "bg-blue-500"
              }`}
              style={{ width: `${barWidth}%` }}
            />
          </div>

          <div className="flex flex-wrap gap-x-2 gap-y-0.5 items-center text-[9px] text-[var(--text-secondary)] font-medium">
            {node["Relation Name"] && <span className="flex items-center gap-0.5 text-blue-400"><Database className="w-2.5 h-2.5" /> {node["Relation Name"]}</span>}
            <span className="flex items-center gap-0.5">{actualRows.toLocaleString()} rows</span>
            <span className="flex items-center gap-0.5">{(node["Actual Total Time"] || 0).toFixed(2)}ms</span>
            {node["Actual Loops"] && node["Actual Loops"] > 1 && (
              <span className="text-purple-400">×{node["Actual Loops"]}</span>
            )}
          </div>

          {!isVeryCompact && (node["Filter"] || node["Index Cond"]) && (
            <div className="p-1.5 mt-1 bg-[var(--background)] rounded-md border border-[var(--border)] text-[9px] font-mono flex items-start gap-1.5">
               <Terminal className="w-2.5 h-2.5 mt-0.5 flex-shrink-0 opacity-40" />
               <span className="break-all opacity-80 leading-relaxed truncate">
                 {node["Index Cond"] ? <span className="text-emerald-400">IDX: </span> : <span className="text-amber-400">FLT: </span>}
                 {node["Filter"] || node["Index Cond"]}
               </span>
            </div>
          )}
          
          {!isVeryCompact && node["Index Name"] && (
            <div className="mt-0.5 text-[8px] text-emerald-400 opacity-70 flex items-center gap-0.5">
              <Database className="w-2 h-2" /> {node["Index Name"]}
            </div>
          )}
        </div>

        {isHot && (
           <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-amber-500/30 rounded-full" />
        )}
      </div>

      {isExpanded && node.Plans && node.Plans.length > 0 && (
        <div className={`${childIndentMl} ${childMt} ${childIndentPl} border-l-2 border-[var(--border)] ${childGap}`}>
          {node.Plans.map((subPlan, i) => (
            <TreeNode key={i} node={subPlan} depth={depth + 1} isHot={isHot && ((subPlan["Actual Total Time"] || 0) / totalTime) > 0.15} totalTime={totalTime} />
          ))}
        </div>
      )}
    </div>
  );
}
