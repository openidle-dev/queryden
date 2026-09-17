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
