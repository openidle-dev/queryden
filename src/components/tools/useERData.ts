import { useState, useEffect, useCallback, useRef } from "react";
import dagre from "dagre";
import type { Node, Edge } from "@xyflow/react";

export interface ERColumn {
  name: string;
  type: string;
  isPK: boolean;
  isFK: boolean;
  nullable: boolean;
}

export interface ERTable {
  id: string;
  schema: string;
  tableName: string;
  displayName: string;
  columns: ERColumn[];
}

export interface ERRelationship {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
}

export interface ERData {
  nodes: Node[];
  edges: Edge[];
  tables: ERTable[];
}

const NODE_WIDTH = 240;
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 36;
const COLUMN_GAP = 2;

function buildTableId(schema: string, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

function splitSchemaTable(name: string): { schema: string; table: string } {
  const dot = name.indexOf(".");
  if (dot > 0) {
    return { schema: name.slice(0, dot), table: name.slice(dot + 1) };
  }
  return { schema: "", table: name };
}

function isJunctionTable(columns: ERColumn[]): boolean {
  if (columns.length < 2) return false;
  const pkCount = columns.filter((c) => c.isPK).length;
  const fkCount = columns.filter((c) => c.isFK).length;
  if (pkCount < 2 || fkCount < 2) return false;
  const nonPkNonFk = columns.filter((c) => !c.isPK && !c.isFK);
  return nonPkNonFk.length === 0;
}

function getNodeHeight(columns: ERColumn[]): number {
  const innerHeight = columns.length * (ROW_HEIGHT + COLUMN_GAP) - COLUMN_GAP;
  return HEADER_HEIGHT + Math.max(innerHeight, 40) + 8;
}

function normalizeTableName(
  name: string,
  selectedSet: Set<string>,
): string | null {
  if (selectedSet.has(name)) return name;
  const stripped = name.startsWith("public.") ? name.slice(7) : null;
  if (stripped && selectedSet.has(stripped)) return stripped;
  const prefixed = `public.${name}`;
  if (selectedSet.has(prefixed)) return prefixed;
  return null;
}

async function fetchPostgresColumns(
  db: any,
  schemaFilter?: string[],
): Promise<any[]> {
  const schemaClause =
    schemaFilter && schemaFilter.length > 0
      ? `AND n.nspname IN (${schemaFilter.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")})`
      : "";
  const rows = await db.select(
    `SELECT n.nspname AS schema_name,
            c.relname AS table_name,
            a.attname AS column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
            NOT a.attnotnull AS nullable,
            COALESCE(i.indisprimary, false) AS is_pk
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     LEFT JOIN pg_index i ON a.attrelid = i.indrelid
       AND a.attnum = ANY(i.indkey)
       AND i.indisprimary
     WHERE a.attnum > 0
       AND NOT a.attisdropped
       AND c.relkind = 'r'
       AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'topology')
       ${schemaClause}
     ORDER BY n.nspname, c.relname, a.attnum`,
  );
  return rows.map((r: any) => ({
    schema_name: r.schema_name ?? "",
    table_name: r.table_name ?? "",
    column_name: r.column_name ?? "",
    data_type: r.data_type ?? "unknown",
    nullable: !!r.nullable,
    is_pk: !!r.is_pk,
  }));
}

async function fetchPostgresForeignKeys(
  db: any,
  schemas?: string[],
): Promise<any[]> {
  const schemaClause =
    schemas && schemas.length > 0
      ? `AND c.connamespace::regnamespace::text IN (${schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")})`
      : "";
  try {
    const rows = await db.select(
      `SELECT
        conrelid::regclass::text AS source_table,
        a.attname AS source_column,
        confrelid::regclass::text AS target_table,
        af.attname AS target_column
      FROM pg_constraint AS c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS sk(attnum, ord)
      CROSS JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS tk(attnum, ord)
      JOIN pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = sk.attnum
      JOIN pg_attribute AS af ON af.attrelid = c.confrelid AND af.attnum = tk.attnum
      WHERE c.contype = 'f'
        AND sk.ord = tk.ord
        AND c.connamespace::regnamespace::text NOT IN ('information_schema', 'pg_catalog', 'topology')
        ${schemaClause}`,
    );
    return rows.map((r: any) => ({
      source_table: r.source_table ?? "",
      source_column: r.source_column ?? "",
      target_table: r.target_table ?? "",
      target_column: r.target_column ?? "",
    }));
  } catch {
    return [];
  }
}

async function fetchMySQLColumns(
  db: any,
  databaseName: string,
): Promise<any[]> {
  const rows = await db.select(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [databaseName],
  );
  return rows.map((r: any) => ({
    table_name: r.TABLE_NAME ?? r.table_name ?? "",
    column_name: r.COLUMN_NAME ?? r.column_name ?? "",
    data_type: r.DATA_TYPE ?? r.data_type ?? "unknown",
    nullable: (r.IS_NULLABLE ?? r.is_nullable ?? "YES") === "YES",
    is_pk: (r.COLUMN_KEY ?? r.column_key ?? "") === "PRI",
  }));
}

async function fetchMySQLForeignKeys(
  db: any,
  databaseName: string,
): Promise<any[]> {
  try {
    const rows = await db.select(
      `SELECT
        kcu.TABLE_NAME AS source_table,
        kcu.COLUMN_NAME AS source_column,
        kcu.REFERENCED_TABLE_NAME AS target_table,
        kcu.REFERENCED_COLUMN_NAME AS target_column
      FROM information_schema.KEY_COLUMN_USAGE AS kcu
      JOIN information_schema.TABLE_CONSTRAINTS AS tc
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
      WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND kcu.TABLE_SCHEMA = ?`,
      [databaseName],
    );
    return rows.map((r: any) => ({
      source_table: r.source_table ?? r.SOURCE_TABLE ?? "",
      source_column: r.source_column ?? r.SOURCE_COLUMN ?? "",
      target_table: r.target_table ?? r.TARGET_TABLE ?? "",
      target_column: r.target_column ?? r.TARGET_COLUMN ?? "",
    }));
  } catch {
    return [];
  }
}

async function fetchSQLiteColumns(
  db: any,
  tableName: string,
): Promise<any[]> {
  const rows = await db.select(
    `PRAGMA table_info("${tableName.replace(/"/g, '""')}")`,
  );
  return rows.map((r: any) => ({
    table_name: tableName,
    column_name: r.name ?? "",
    data_type: r.type ?? "unknown",
    nullable: !r.notnull,
    is_pk: !!r.pk,
  }));
}

async function fetchSQLiteForeignKeys(
  db: any,
  tableName: string,
): Promise<any[]> {
  const rows = await db.select(
    `PRAGMA foreign_key_list("${tableName.replace(/"/g, '""')}")`,
  );
  return rows.map((r: any) => ({
    source_table: tableName,
    source_column: r.from ?? "",
    target_table: r.table ?? "",
    target_column: r.to ?? "",
  }));
}

function runDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: 80,
    ranksep: 150,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => {
    const h = ((n.data as any)?.nodeHeight as number) ?? 120;
    g.setNode(n.id, { width: NODE_WIDTH, height: h });
  });

  edges.forEach((e) => {
    g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - ((pos.height as number) || 120) / 2,
      },
    };
  });
}

interface CacheEntry {
  data: ERData;
  ts: number;
}

const schemaCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30_000;

export function useERData(
  currentDb: any,
  connectionType: string | undefined,
  schemaItems: any,
  selectedDatabase: string | null | undefined,
  schemas: string[],
  tableNames: string[],
  refreshKey = 0,
): { data: ERData | null; isLoading: boolean; error: string | null } {
  const [data, setData] = useState<ERData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const dbType = connectionType || "";
  const isPostgres = ["postgres", "supabase", "cockroach"].includes(dbType);
  const isMySQL = ["mysql", "mariadb"].includes(dbType);
  const isSQLite = dbType === "sqlite";

  const buildERData = useCallback(async () => {
    if (!currentDb || !schemaItems || tableNames.length === 0) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const sortedNames = [...tableNames].sort();
    const cacheKey = JSON.stringify({
      dbType,
      selectedDatabase,
      schemas,
      tableNames: sortedNames,
      refreshKey,
    });
    const cached = schemaCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL && refreshKey === 0) {
      setData(cached.data);
      setIsLoading(false);
      setError(null);
      return;
    }

    const gen = ++generationRef.current;
    setIsLoading(true);
    setError(null);

    try {
      let allColumns: any[] = [];
      let fkRelationships: ERRelationship[] = [];

      const selectedSet = new Set(tableNames);

      if (isPostgres) {
        const validSchemas = schemas.length > 0 ? schemas : undefined;
        const [rows, fks] = await Promise.all([
          fetchPostgresColumns(currentDb, validSchemas),
          schemaItems.foreignKeys?.length
            ? Promise.resolve(schemaItems.foreignKeys)
            : fetchPostgresForeignKeys(currentDb, validSchemas),
        ]);
        allColumns = rows.filter((r: any) => {
          const key =
            r.schema_name && r.schema_name !== "public"
              ? `${r.schema_name}.${r.table_name}`
              : r.table_name;
          return selectedSet.has(key);
        });
        for (const fk of fks) {
          const src = normalizeTableName(
            fk.source_table ?? fk.SOURCE_TABLE ?? "",
            selectedSet,
          );
          const tgt = normalizeTableName(
            fk.target_table ?? fk.TARGET_TABLE ?? "",
            selectedSet,
          );
          if (src || tgt) {
            fkRelationships.push({
              sourceTable: src ?? fk.source_table ?? fk.SOURCE_TABLE ?? "",
              sourceColumn: fk.source_column ?? fk.SOURCE_COLUMN ?? "",
              targetTable: tgt ?? fk.target_table ?? fk.TARGET_TABLE ?? "",
              targetColumn: fk.target_column ?? fk.TARGET_COLUMN ?? "",
            });
          }
        }
      } else if (isMySQL) {
        const [rows, fks] = await Promise.all([
          fetchMySQLColumns(currentDb, selectedDatabase || ""),
          schemaItems.foreignKeys?.length
            ? Promise.resolve(schemaItems.foreignKeys)
            : fetchMySQLForeignKeys(currentDb, selectedDatabase || ""),
        ]);
        allColumns = rows.filter((r: any) => selectedSet.has(r.table_name));
        for (const fk of fks) {
          if (
            selectedSet.has(fk.source_table ?? fk.SOURCE_TABLE ?? "") ||
            selectedSet.has(fk.target_table ?? fk.TARGET_TABLE ?? "")
          ) {
            fkRelationships.push({
              sourceTable: fk.source_table ?? fk.SOURCE_TABLE ?? "",
              sourceColumn: fk.source_column ?? fk.SOURCE_COLUMN ?? "",
              targetTable: fk.target_table ?? fk.TARGET_TABLE ?? "",
              targetColumn: fk.target_column ?? fk.TARGET_COLUMN ?? "",
            });
          }
        }
      } else if (isSQLite) {
        const colPromises = tableNames.map(async (t) => {
          const { table } = splitSchemaTable(t);
          return fetchSQLiteColumns(currentDb, table);
        });
        const colResults = await Promise.all(colPromises);
        allColumns = colResults.flat();

        const fkPromises = tableNames.map(async (t) => {
          const { table } = splitSchemaTable(t);
          return fetchSQLiteForeignKeys(currentDb, table);
        });
        const fkResults = await Promise.all(fkPromises);
        for (const fk of fkResults.flat()) {
          if (
            selectedSet.has(fk.source_table) ||
            selectedSet.has(fk.target_table)
          ) {
            fkRelationships.push(fk);
          }
        }
      }

      if (gen !== generationRef.current) return;

      const columnMap = new Map<string, ERColumn[]>();
      for (const col of allColumns) {
        const key =
          col.schema_name && col.schema_name !== "public"
            ? `${col.schema_name}.${col.table_name}`
            : col.table_name;
        if (!columnMap.has(key)) columnMap.set(key, []);
        columnMap.get(key)!.push({
          name: col.column_name,
          type: col.data_type,
          isPK: !!col.is_pk,
          isFK: false,
          nullable: !!col.nullable,
        });
      }

      const nodeNameSet = new Set(tableNames);

      const fkColumnSet = new Set<string>();
      for (const fk of fkRelationships) {
        const src = normalizeTableName(fk.sourceTable, nodeNameSet);
        if (src) {
          fkColumnSet.add(`${src}:${fk.sourceColumn}`);
        }
      }

      for (const [key, cols] of columnMap) {
        for (const col of cols) {
          if (fkColumnSet.has(`${key}:${col.name}`)) {
            col.isFK = true;
          }
        }
      }

      const erTables: ERTable[] = [];
      for (const t of tableNames) {
        const { schema, table } = splitSchemaTable(t);
        const id = buildTableId(schema, table);
        const cols = columnMap.get(t) || columnMap.get(id) || [];
        erTables.push({
          id,
          schema,
          tableName: table,
          displayName: table,
          columns: cols,
        });
      }

      if (gen !== generationRef.current) return;

      const nodes: Node[] = [];
      const edges: Edge[] = [];
      const edgeSet = new Set<string>();

      for (const et of erTables) {
        const nodeHeight = getNodeHeight(et.columns);
        nodes.push({
          id: et.id,
          type: "tableNode",
          position: { x: 0, y: 0 },
          data: {
            id: et.id,
            schema: et.schema,
            tableName: et.tableName,
            displayName: et.displayName,
            columns: et.columns,
            nodeHeight,
            isJunction: isJunctionTable(et.columns),
            connectionType: dbType,
          },
        });
      }

      const nodeIdSet = new Set(nodes.map((n) => n.id));

      for (const fk of fkRelationships) {
        const src = normalizeTableName(fk.sourceTable, nodeIdSet);
        const tgt = normalizeTableName(fk.targetTable, nodeIdSet);
        if (!src || !tgt) continue;
        const edgeKey = `${src}.${fk.sourceColumn}->${tgt}.${fk.targetColumn}`;
        if (edgeSet.has(edgeKey)) continue;
        edgeSet.add(edgeKey);

        edges.push({
          id: `${src}.${fk.sourceColumn}->${tgt}.${fk.targetColumn}`,
          source: src,
          target: tgt,
          sourceHandle: `${src}:${fk.sourceColumn}`,
          targetHandle: `${tgt}:${fk.targetColumn}`,
          type: "relationshipEdge",
          data: {
            sourceColumn: fk.sourceColumn,
            targetColumn: fk.targetColumn,
            sourceTable: fk.sourceTable,
            targetTable: fk.targetTable,
          },
        });
      }

      const laidOutNodes = runDagreLayout(nodes, edges);

      const result: ERData = {
        nodes: laidOutNodes,
        edges,
        tables: erTables,
      };

      schemaCache.set(cacheKey, { data: result, ts: Date.now() });
      setData(result);
    } catch (e: any) {
      if (gen === generationRef.current) {
        setError(e?.message || "Failed to load schema data");
      }
    } finally {
      if (gen === generationRef.current) {
        setIsLoading(false);
      }
    }
  }, [
    currentDb,
    schemaItems,
    selectedDatabase,
    schemas,
    tableNames,
    isPostgres,
    isMySQL,
    isSQLite,
    dbType,
    refreshKey,
  ]);

  useEffect(() => {
    buildERData();
    return () => {
      generationRef.current += 1;
    };
  }, [buildERData, refreshKey]);

  return { data, isLoading, error };
}
