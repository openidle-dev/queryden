/**
 * Pure helpers for the consolidated catalogue scan.
 *
 * Loading a database's schema used to issue one query per object class --
 * fifteen sequential network round trips, which on an intercontinental link is
 * most of the wait between connecting and being able to work. Thirteen of those
 * classes share a shape (a kind, a schema and a name), so they are fetched in a
 * single `UNION ALL` and bucketed here.
 *
 * The bucketing and the schema-filter construction live in this file so they can
 * be tested without a live database.
 */

/** One row of the consolidated catalogue query. */
export interface CatalogRow {
  /** Which object list this row belongs to, e.g. `"tables"`. */
  kind: string;
  /** Owning schema, or null for cluster-wide objects (extensions, languages). */
  sch: string | null;
  /** Object name, unqualified. */
  nm: string;
}

/**
 * Render an object's display name.
 *
 * Objects in `public` are shown unqualified, matching how a user would write
 * them; everything else carries its schema. Callers rely on this exact form,
 * because the tree splits the name back apart on the first dot.
 */
export function qualifyObjectName(schema: string | null | undefined, name: string): string {
  return schema && schema !== "public" ? `${schema}.${name}` : name;
}

/**
 * Group consolidated catalogue rows into one list per object kind.
 *
 * Order within a kind is preserved, so the `ORDER BY` from the query survives.
 * Unknown kinds are kept rather than dropped: a newer query shape should not
 * silently lose rows.
 */
export function bucketCatalogRows(rows: readonly CatalogRow[]): Record<string, string[]> {
  const byKind: Record<string, string[]> = {};
  for (const row of rows) {
    if (!row || typeof row.kind !== "string") continue;
    (byKind[row.kind] ||= []).push(qualifyObjectName(row.sch, row.nm));
  }
  return byKind;
}

/** A foreign-data wrapper with its servers and each server's user mappings. */
export interface ForeignDataWrapperInfo {
  name: string;
  servers: { name: string; userMappings: string[] }[];
}

/** One row per wrapper × server × user mapping; server and mapping are NULL when absent. */
export interface ForeignServerRow {
  wrapper: string;
  server: string | null;
  mapping: string | null;
}

/** Nest flat wrapper/server/mapping rows, keeping their order. */
export function groupForeignDataWrappers(rows: readonly ForeignServerRow[]): ForeignDataWrapperInfo[] {
  const wrappers = new Map<string, ForeignDataWrapperInfo>();
  for (const row of rows) {
    if (!row || typeof row.wrapper !== "string") continue;
    let wrapper = wrappers.get(row.wrapper);
    if (!wrapper) {
      wrapper = { name: row.wrapper, servers: [] };
      wrappers.set(row.wrapper, wrapper);
    }
    if (row.server == null) continue;
    let server = wrapper.servers.find((s) => s.name === row.server);
    if (!server) {
      server = { name: row.server, userMappings: [] };
      wrapper.servers.push(server);
    }
    if (row.mapping != null && !server.userMappings.includes(row.mapping)) server.userMappings.push(row.mapping);
  }
  return [...wrappers.values()];
}

/**
 * Wrappers, servers and user mappings from consolidated catalogue rows:
 * `fdwWrapper` (name), `fdwServer` (sch = wrapper, name), `fdwMapping`
 * (sch = server, name = user). Server names are unique within a database.
 */
export function foreignDataWrappersFromCatalog(rows: readonly CatalogRow[]): ForeignDataWrapperInfo[] {
  const flat: ForeignServerRow[] = [];
  const mappingsByServer = new Map<string, string[]>();
  for (const row of rows) {
    if (row?.kind === "fdwMapping" && row.sch != null) {
      const list = mappingsByServer.get(row.sch) ?? [];
      list.push(row.nm);
      mappingsByServer.set(row.sch, list);
    }
  }
  // Wrappers first, so their order doesn't depend on which kind sorts first.
  for (const row of rows) {
    if (row?.kind === "fdwWrapper") flat.push({ wrapper: row.nm, server: null, mapping: null });
  }
  for (const row of rows) {
    if (row?.kind === "fdwServer" && row.sch != null) {
      const mappings = mappingsByServer.get(row.nm) ?? [];
      if (mappings.length === 0) flat.push({ wrapper: row.sch, server: row.nm, mapping: null });
      for (const mapping of mappings) flat.push({ wrapper: row.sch, server: row.nm, mapping });
    }
  }
  return groupForeignDataWrappers(flat);
}

/**
 * Whether connecting should (re)read the server's database list: always for a
 * plain server connect, and also when a specific database is opened but the
 * list was never read (startup restore and editor tabs open a named database,
 * which left the server's tree with nothing to expand).
 */
export function needsDatabaseList(requestedDatabase: string | undefined, knownDatabases: readonly string[] | undefined): boolean {
  return !requestedDatabase || !knownDatabases || knownDatabases.length === 0;
}
