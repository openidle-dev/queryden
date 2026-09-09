/**
 * Shared schema-introspection fetcher (completion + explorer tree).
 *
 * Why this exists: `ConnectionContext.loadSchema` used to own ~400 lines of
 * per-engine introspection inline, bound to the *globally active* connection
 * (`activeConnection`/`currentDb`). Tabs can target connections that were
 * never sidebar-connected (lazy `ensureConnectionDb`), so completion keyed
 * only off the global schema stayed dead on those tabs (`SELECT devops.`
 * showed nothing even though the tables exist). This module holds the exact
 * same introspection keyed off explicit parameters (`db`, `connType`,
 * `selectedSchemas`) so both the global tree path and the per-tab background
 * path (`ensureSchemaFor`) fetch identical data. Row shaping goes through
 * the tested `schemaMappings` mappers.
 *
 * Pure JS + SQL — identical behavior on Linux, macOS and Windows. All
 * statements are read-only catalog reads (`information_schema`, `pg_catalog`,
 * `SHOW`, `PRAGMA`); table names interpolated into `PRAGMA`s are quoted via
 * `quoteSqliteIdentifier`, schema filters via `escapeSqlStringLiteral`.
 */
import type { SchemaItems } from "../contexts/ConnectionContext";
import { escapeSqlStringLiteral } from "./sqlDialect";
import {
  mapMysqlColumns,
  mapMysqlRoutineNames,
  mapSqliteForeignKeys,
  mapSqliteMasterNames,
  mapSqlitePragmaColumns,
  quoteSqliteIdentifier,
} from "./schemaMappings";

export interface SchemaFetchProgress {
  phase: string;
  current: number;
  total: number;
}

export interface SchemaFetchDb {
  select: (sql: string, params?: unknown[]) => Promise<any[]>;
}

export interface SchemaFetchRequest {
  db: SchemaFetchDb;
  connType: string;
  selectedSchemas: string[];
  onProgress?: (p: SchemaFetchProgress) => void;
}

export async function fetchSchemaItems(req: SchemaFetchRequest): Promise<SchemaItems> {
  const { db: currentDb, connType, selectedSchemas, onProgress } = req;
  // Aliases so the per-engine bodies below read exactly as they did when
  // they lived inside `ConnectionContext.loadSchema` (no logic drift).
  const activeConnection = { type: connType };
  const setSchemaProgress = (s: SchemaFetchProgress) => {
    onProgress?.(s);
  };

  const schemaFilter = selectedSchemas.length > 0
    ? `AND table_schema IN (${selectedSchemas.map(s => escapeSqlStringLiteral(s)).join(',')})`
    : '';
  // Each catalog view exposes the schema under its own column name — using
  // `table_schema` against routines/triggers/foreign tables is a SQL error,
  // and the per-section try/catch then left functions, procedures, triggers
  // and foreign tables silently empty whenever a schema filter was active.
  const schemaFilterRoutine = selectedSchemas.length > 0
    ? `AND routine_schema IN (${selectedSchemas.map(s => escapeSqlStringLiteral(s)).join(',')})`
    : '';
  const schemaFilterTrigger = selectedSchemas.length > 0
    ? `AND trigger_schema IN (${selectedSchemas.map(s => escapeSqlStringLiteral(s)).join(',')})`
    : '';
  const schemaFilterForeignTable = selectedSchemas.length > 0
    ? `AND foreign_table_schema IN (${selectedSchemas.map(s => escapeSqlStringLiteral(s)).join(',')})`
    : '';
  const schemaFilterFk = selectedSchemas.length > 0
    ? `AND c.connamespace::regnamespace::text IN (${selectedSchemas.map(s => escapeSqlStringLiteral(s)).join(',')})`
    : '';

  const schema: SchemaItems = {
    tables: [],
    views: [],
    functions: [],
    triggers: [],
    indexes: [],
    sequences: [],
    types: [],
    procedures: [],
    operators: [],
    foreignTables: [],
    eventTriggers: [],
    extensions: [],
    languages: [],
  };

  if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
    setSchemaProgress({ phase: "tables", current: 1, total: 12 });
    try {
      const tables = await currentDb.select(`
        SELECT table_schema as table_schema, table_name as table_name 
        FROM information_schema.tables
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'topology')
          AND table_type = 'BASE TABLE'
          ${schemaFilter}
        ORDER BY table_schema, table_name
      `);
      schema.tables = tables.length > 0 ? tables.map((t: any) =>
        t.table_schema === 'public' ? t.table_name : `${t.table_schema}.${t.table_name}`
      ) : [];
    } catch (e) {
      console.error("Failed to fetch tables:", e);
    }

    setSchemaProgress({ phase: "views", current: 2, total: 12 });
    try {
      const views = await currentDb.select(`
        SELECT table_schema as table_schema, table_name as table_name 
        FROM information_schema.views
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'topology')
          ${schemaFilter}
        ORDER BY table_schema, table_name
      `);
      schema.views = views.length > 0 ? views.map((v: any) =>
        v.table_schema === 'public' ? v.table_name : `${v.table_schema}.${v.table_name}`
      ) : [];
    } catch (e) {
      console.error("Failed to fetch views:", e);
    }

    setSchemaProgress({ phase: "functions", current: 3, total: 12 });
    try {
      const functions = await currentDb.select(`
        SELECT routine_schema as routine_schema, routine_name as routine_name
        FROM information_schema.routines
        WHERE routine_schema NOT IN ('information_schema', 'pg_catalog', 'topology')
          ${schemaFilterRoutine}
        ORDER BY routine_schema, routine_name
      `);
      schema.functions = functions.length > 0 ? functions.map((f: any) =>
        f.routine_schema === 'public' ? f.routine_name : `${f.routine_schema}.${f.routine_name}`
      ) : [];
    } catch (e) {
      console.error("Failed to fetch functions:", e);
    }

    setSchemaProgress({ phase: "triggers", current: 4, total: 12 });
    try {
      const triggers = await currentDb.select(`
        SELECT trigger_schema as trigger_schema, trigger_name as trigger_name
        FROM information_schema.triggers
        WHERE trigger_schema NOT IN ('information_schema', 'pg_catalog', 'topology')
          ${schemaFilterTrigger}
        ORDER BY trigger_schema, trigger_name
      `);
      schema.triggers = triggers.length > 0 ? triggers.map((t: any) =>
        t.trigger_schema === 'public' ? t.trigger_name : `${t.trigger_schema}.${t.trigger_name}`
      ) : [];
    } catch (e) {
      schema.triggers = [];
    }

    setSchemaProgress({ phase: "indexes", current: 5, total: 12 });
    try {
      const indexes = await currentDb.select(`
        SELECT schemaname as schemaname, indexname as indexname 
        FROM pg_indexes
        WHERE schemaname NOT IN ('information_schema', 'pg_catalog', 'topology')
          ${schemaFilter.replace('table_schema', 'schemaname')}
        ORDER BY schemaname, indexname
      `);
      schema.indexes = indexes.length > 0 ? indexes.map((i: any) =>
        i.schemaname === 'public' ? i.indexname : `${i.schemaname}.${i.indexname}`
      ) : [];
    } catch (e) {
      console.error("Failed to fetch indexes:", e);
    }

    // Fetch Sequences
    setSchemaProgress({ phase: "indexes", current: 6, total: 12 });
    try {
      const sequences = await currentDb.select(`
        SELECT sequence_schema as sequence_schema, sequence_name as sequence_name 
        FROM information_schema.sequences 
        WHERE sequence_schema NOT IN ('information_schema', 'pg_catalog', 'topology')
          ${schemaFilter.replace('table_schema', 'sequence_schema')}
        ORDER BY sequence_schema, sequence_name
      `);
      schema.sequences = sequences.length > 0 ? sequences.map((s: any) =>
        s.sequence_schema === 'public' ? s.sequence_name : `${s.sequence_schema}.${s.sequence_name}`
      ) : [];
    } catch (e) {
      schema.sequences = [];
    }

    // Fetch user-defined types (domains, enums, composites, ranges)
    setSchemaProgress({ phase: "types", current: 7, total: 12 });
    try {
      const types = await currentDb.select(`
        SELECT n.nspname AS type_schema, t.typname AS type_name
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'topology')
          AND t.typtype IN ('d', 'e', 'c', 'r', 'm')
          AND t.typrelid = 0
        ORDER BY n.nspname, t.typname
      `);
      schema.types = types.length > 0 ? types.map((t: any) =>
        t.type_schema === 'public' ? t.type_name : `${t.type_schema}.${t.type_name}`
      ) : [];
    } catch (e) {
      console.error("Failed to fetch types:", e);
      schema.types = [];
    }

    // Fetch procedures (stored procedures, distinct from functions)
    setSchemaProgress({ phase: "procedures", current: 8, total: 12 });
    try {
      const procedures = await currentDb.select(`
        SELECT routine_schema as routine_schema, routine_name as routine_name
        FROM information_schema.routines
        WHERE routine_schema NOT IN ('information_schema', 'pg_catalog', 'topology')
          AND routine_type = 'PROCEDURE'
          ${schemaFilterRoutine}
        ORDER BY routine_schema, routine_name
      `);
      schema.procedures = procedures.length > 0 ? procedures.map((p: any) =>
        p.routine_schema === 'public' ? p.routine_name : `${p.routine_schema}.${p.routine_name}`
      ) : [];
    } catch (e) {
      console.error("Failed to fetch procedures:", e);
      schema.procedures = [];
    }

    // Fetch operators
    setSchemaProgress({ phase: "operators", current: 9, total: 12 });
    try {
      const operators = await currentDb.select(`
        SELECT n.nspname AS operator_schema, o.oprname AS operator_name
        FROM pg_operator o
        JOIN pg_namespace n ON o.oprnamespace = n.oid
        WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'topology')
        ORDER BY n.nspname, o.oprname
      `);
      schema.operators = operators.length > 0 ? operators.map((o: any) =>
        o.operator_schema === 'public' ? o.operator_name : `${o.operator_schema}.${o.operator_name}`
      ) : [];
    } catch (e) {
      console.error("Failed to fetch operators:", e);
      schema.operators = [];
    }

    // Fetch foreign tables
    setSchemaProgress({ phase: "foreign_tables", current: 10, total: 12 });
    try {
      const foreignTables = await currentDb.select(`
        SELECT foreign_table_schema, foreign_table_name
        FROM information_schema.foreign_tables
        WHERE foreign_table_schema NOT IN ('information_schema', 'pg_catalog', 'topology')
          ${schemaFilterForeignTable}
        ORDER BY foreign_table_schema, foreign_table_name
      `);
      schema.foreignTables = foreignTables.length > 0 ? foreignTables.map((ft: any) =>
        ft.foreign_table_schema === 'public' ? ft.foreign_table_name : `${ft.foreign_table_schema}.${ft.foreign_table_name}`
      ) : [];
    } catch (e) {
      console.error("Failed to fetch foreign tables:", e);
      schema.foreignTables = [];
    }

    // Fetch columns for IntelliSense
    setSchemaProgress({ phase: "columns", current: 11, total: 12 });
    try {
      const cols = await currentDb.select(`
          SELECT 
            n.nspname as table_schema,
            c.relname as table_name,
            a.attname as column_name
          FROM pg_attribute a
          JOIN pg_class c ON a.attrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE a.attnum > 0 
            AND NOT a.attisdropped
            AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'topology')
            ${selectedSchemas.length > 0 ? `AND n.nspname IN (${selectedSchemas.map(s => escapeSqlStringLiteral(s)).join(',')})` : ''}
            AND c.relkind IN ('r', 'v', 'm', 'f')
          ORDER BY n.nspname, c.relname, a.attnum
          LIMIT 50000
      `);

      schema.columns = cols.map((c: any) => ({
        table_name: c.table_schema === 'public' ? c.table_name : `${c.table_schema}.${c.table_name}`,
        column_name: c.column_name
      }));
    } catch (err) {
      console.error("Failed to fetch columns:", err);
    }

    // Fetch Foreign Keys for smart completion
    setSchemaProgress({ phase: "foreign_keys", current: 12, total: 12 });
    try {
      const fks = await currentDb.select(`
          SELECT
            conrelid::regclass::text AS source_table,
            a.attname AS source_column,
            confrelid::regclass::text AS target_table,
            af.attname AS target_column
          FROM pg_constraint AS c
          JOIN pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
          JOIN pg_attribute AS af ON af.attrelid = c.confrelid AND af.attnum = ANY(c.confkey)
          WHERE c.contype = 'f'
            AND c.connamespace::regnamespace::text NOT IN ('information_schema', 'pg_catalog', 'topology')
            ${schemaFilterFk}
      `);
      schema.foreignKeys = fks;
    } catch (err) {
      console.error("Failed to fetch Foreign Keys:", err);
    }

    // Fetch extensions
    try {
      const extensions = await currentDb.select(`
        SELECT extname FROM pg_extension ORDER BY extname
      `);
      schema.extensions = extensions.map((e: any) => e.extname);
    } catch (e) {
      schema.extensions = [];
    }

    // Fetch event triggers
    try {
      const eventTriggers = await currentDb.select(`
        SELECT evtname FROM pg_event_trigger ORDER BY evtname
      `);
      schema.eventTriggers = eventTriggers.map((t: any) => t.evtname);
    } catch (e) {
      schema.eventTriggers = [];
    }

    // Fetch procedural languages
    try {
      const languages = await currentDb.select(`
        SELECT lanname FROM pg_language WHERE lanispl = true ORDER BY lanname
      `);
      schema.languages = languages.map((l: any) => l.lanname);
    } catch (e) {
      schema.languages = [];
    }

  } else if (["mysql", "mariadb"].includes(activeConnection.type)) {
    const views = await currentDb.select(`SHOW FULL TABLES WHERE Table_type = 'VIEW'`);
    schema.views = views.map((t: any) => Object.values(t)[0] as string);

    // NOTE: `SHOW TABLES` lists views too — subtract them so a view is not
    // suggested twice (once as a table, once as a view).
    const tables = await currentDb.select(`SHOW TABLES`);
    const viewNames = new Set(schema.views);
    schema.tables = tables
      .map((t: any) => Object.values(t)[0] as string)
      .filter((t: string) => !viewNames.has(t));

    // Fetch MySQL columns for IntelliSense (table.column completion).
    // Shaped by the tested mapMysqlColumns mapper (drops malformed rows).
    setSchemaProgress({ phase: "columns", current: 1, total: 4 });
    try {
      const cols = await currentDb.select(`
        SELECT TABLE_NAME, COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, ORDINAL_POSITION
        LIMIT 50000
      `);
      schema.columns = mapMysqlColumns(cols);
    } catch (err) {
      console.error("Failed to fetch MySQL columns:", err);
      schema.columns = [];
    }

    // Fetch MySQL scalar functions for function completion hints.
    // Shaped by the tested mapMysqlRoutineNames mapper.
    setSchemaProgress({ phase: "functions", current: 2, total: 4 });
    try {
      const routines = await currentDb.select(`
        SELECT ROUTINE_NAME
        FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = 'FUNCTION'
        ORDER BY ROUTINE_NAME
      `);
      schema.functions = mapMysqlRoutineNames(routines);
    } catch (err) {
      console.error("Failed to fetch MySQL scalar functions:", err);
      schema.functions = [];
    }

    // Fetch MySQL stored procedures
    setSchemaProgress({ phase: "procedures", current: 3, total: 4 });
    try {
      const procedures = await currentDb.select(`
        SELECT ROUTINE_NAME AS routine_name
        FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = 'PROCEDURE'
        ORDER BY ROUTINE_NAME
      `);
      schema.procedures = procedures.map((p: any) => p.routine_name);
    } catch (err) {
      console.error("Failed to fetch MySQL procedures:", err);
      schema.procedures = [];
    }

    // Fetch Foreign Keys for MySQL completion
    setSchemaProgress({ phase: "foreign_keys", current: 4, total: 4 });
    try {
      const fks = await currentDb.select(`
        SELECT 
          kcu.TABLE_NAME AS source_table,
          kcu.COLUMN_NAME AS source_column,
          kcu.REFERENCED_TABLE_NAME AS target_table,
          kcu.REFERENCED_COLUMN_NAME AS target_column
        FROM information_schema.KEY_COLUMN_USAGE AS kcu
        JOIN information_schema.TABLE_CONSTRAINTS AS tc 
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME 
          AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
          AND kcu.TABLE_SCHEMA = DATABASE()
      `);
      schema.foreignKeys = fks;
    } catch (err) {
      console.error("Failed to fetch MySQL Foreign Keys:", err);
    }
  } else if (activeConnection.type === "sqlite") {
    // SQLite introspection via sqlite_master + PRAGMAs. Row shaping goes
    // through the tested schemaMappings mappers (internal sqlite_%
    // tables skipped, malformed PRAGMA rows dropped).
    setSchemaProgress({ phase: "tables", current: 1, total: 4 });
    try {
      const tableRows = await currentDb.select(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      );
      schema.tables = mapSqliteMasterNames(tableRows);
    } catch (err) {
      console.error("Failed to fetch SQLite tables:", err);
    }
    try {
      const viewRows = await currentDb.select(
        `SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`
      );
      schema.views = mapSqliteMasterNames(viewRows);
    } catch (err) {
      console.error("Failed to fetch SQLite views:", err);
    }

    // Columns for all tables+views via PRAGMA table_info
    setSchemaProgress({ phase: "columns", current: 2, total: 4 });
    try {
      const allObjects = [...schema.tables, ...schema.views];
      const colPairs: { table_name: string; column_name: string }[] = [];
      for (const obj of allObjects) {
        try {
          const pragmaRows = await currentDb.select(`PRAGMA table_info(${quoteSqliteIdentifier(obj)})`);
          colPairs.push(...mapSqlitePragmaColumns(obj, pragmaRows));
        } catch { /* view may not support PRAGMA; skip */ }
      }
      schema.columns = colPairs;
    } catch (err) {
      console.error("Failed to fetch SQLite columns:", err);
      schema.columns = [];
    }

    // Foreign keys via PRAGMA foreign_key_list for each table
    setSchemaProgress({ phase: "foreign_keys", current: 3, total: 4 });
    try {
      const allTables = schema.tables;
      const fkQuads: { source_table: string; source_column: string; target_table: string; target_column: string }[] = [];
      for (const tbl of allTables) {
        try {
          const fkRows = await currentDb.select(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(tbl)})`);
          fkQuads.push(...mapSqliteForeignKeys(tbl, fkRows));
        } catch { /* skip tables with no FKs */ }
      }
      schema.foreignKeys = fkQuads;
    } catch (err) {
      console.error("Failed to fetch SQLite foreign keys:", err);
      schema.foreignKeys = [];
    }

    // SQLite has no user-defined scalar functions or triggers via PRAGMA;
    // leave functions/triggers/indexes empty (correct for SQLite)
    setSchemaProgress({ phase: "complete", current: 4, total: 4 });
  }

  // Defensive dedupe: catalog quirks (case-variant duplicates, overlapping
  // sources) must never surface the same table/column/function twice in
  // completion. First occurrence wins, original order preserved.
  const seenNames = new Set<string>();
  const dedupeNames = (list: string[] | undefined): string[] => {
    const out: string[] = [];
    for (const n of list ?? []) {
      if (typeof n === "string" && !seenNames.has(n)) {
        seenNames.add(n);
        out.push(n);
      }
    }
    return out;
  };
  // NOTE: one shared `seenNames` across tables/views/functions also collapses
  // a name that appears as both a table and a function (procedures show up in
  // the unfiltered `information_schema.routines` read) to a single entry.
  schema.tables = dedupeNames(schema.tables);
  schema.views = dedupeNames(schema.views);
  schema.functions = dedupeNames(schema.functions);
  schema.triggers = dedupeNames(schema.triggers);
  schema.indexes = dedupeNames(schema.indexes);
  schema.sequences = dedupeNames(schema.sequences);
  schema.types = dedupeNames(schema.types);
  schema.procedures = dedupeNames(schema.procedures);
  schema.operators = dedupeNames(schema.operators);
  schema.foreignTables = dedupeNames(schema.foreignTables);
  schema.eventTriggers = dedupeNames(schema.eventTriggers);
  schema.extensions = dedupeNames(schema.extensions);
  schema.languages = dedupeNames(schema.languages);

  const seenCols = new Set<string>();
  schema.columns = (schema.columns ?? []).filter((c) => {
    if (!c || typeof c.table_name !== "string" || typeof c.column_name !== "string") return false;
    const k = JSON.stringify([c.table_name, c.column_name]);
    if (seenCols.has(k)) return false;
    seenCols.add(k);
    return true;
  });

  const seenFks = new Set<string>();
  schema.foreignKeys = (schema.foreignKeys ?? []).filter((f) => {
    if (!f) return false;
    const k = JSON.stringify([f.source_table, f.source_column, f.target_table, f.target_column]);
    if (seenFks.has(k)) return false;
    seenFks.add(k);
    return true;
  });

  return { ...schema, _ts: Date.now() };
}
