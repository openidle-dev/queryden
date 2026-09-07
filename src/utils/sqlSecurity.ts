/**
 * SQL Security Utilities
 *
 * Provides safe identifier quoting for different database providers to prevent SQL injection
 * when handling table names, schema names, and database names.
 */
import { quoteIdentifierPart, splitDottedIdentifier } from "./sqlDialect";

export type DatabaseType = "postgres" | "supabase" | "mysql" | "mariadb" | "sqlite" | "cockroach" | string;

/**
 * Quotes a database identifier (table, column, schema, etc.) based on the database type.
 *
 * Handles dotted names (`schema.table`) by quoting each segment, respects
 * already-quoted segments (`"my.schema"."my.table"` stays two parts, not
 * four), and escapes embedded quote characters by doubling them
 * (`a"b` → `"a""b"`, `` a`b `` → `` `a``b` ``) instead of deleting them.
 *
 * @param identifier The name to quote
 * @param type The database provider type
 * @returns A safely quoted identifier
 */
export function quoteIdentifier(identifier: string, type: DatabaseType): string {
  if (!identifier) return identifier;

  if (identifier.includes('.')) {
    return splitDottedIdentifier(identifier)
      .map(part => quoteIdentifierPart(part, type))
      .join('.');
  }

  return quoteIdentifierPart(identifier, type);
}
