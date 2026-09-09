/**
 * Collision-free encoding for schema-filter dropdown values.
 *
 * Radix Select forbids empty-string option values, so "All Schemas" (no
 * filter) needs a stand-in — but any stand-in string could theoretically be
 * a real schema name (`__all_schemas__` is a legal Postgres schema, and it
 * would silently behave as "show everything" instead of filtering).
 *
 * Prefix-encoding makes collision structurally impossible: real schemas
 * encode as `s:<name>` (decoding strips exactly one prefix, so names
 * containing colons round-trip), while the all-schemas option is the bare
 * `all`, which encoding can never produce.
 */

export const ALL_SCHEMAS_VALUE = "all";

export function encodeSchemaFilterValue(schema: string | undefined): string {
  return schema === undefined ? ALL_SCHEMAS_VALUE : `s:${schema}`;
}

export function decodeSchemaFilterValue(value: string): string | undefined {
  if (value === ALL_SCHEMAS_VALUE) return undefined;
  return value.startsWith("s:") ? value.slice(2) : value;
}
