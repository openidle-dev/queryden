/**
 * SQL Security Utilities
 * 
 * Provides safe identifier quoting for different database providers to prevent SQL injection
 * when handling table names, schema names, and database names.
 */

export type DatabaseType = "postgres" | "supabase" | "mysql" | "mariadb" | "sqlite" | "cockroach" | string;

/**
 * Quotes a database identifier (table, column, schema, etc.) based on the database type.
 * 
 * @param identifier The name to quote
 * @param type The database provider type
 * @returns A safely quoted identifier
 */
export function quoteIdentifier(identifier: string, type: DatabaseType): string {
  if (!identifier) return identifier;

  // Handle already quoted identifiers or complex names with dots
  if (identifier.includes('.')) {
    return identifier
      .split('.')
      .map(part => quoteIdentifier(part, type))
      .join('.');
  }

  const cleanId = identifier.replace(/["`[\]]/g, "");

  if (["postgres", "supabase", "cockroach", "sqlite"].includes(type.toLowerCase())) {
    return `"${cleanId}"`;
  }
  
  if (["mysql", "mariadb"].includes(type.toLowerCase())) {
    return `\`${cleanId}\``;
  }

  // Default to standard SQL double quotes
  return `"${cleanId}"`;
}
