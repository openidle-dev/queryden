/**
 * A basic SQL formatter for QueryDen.
 * Provides legible indentation for common SQL keywords and nested structures.
 */

export function formatSql(sql: string): string {
  if (!sql) return "";

  // Keywords that should start a new line
  const newLineKeywords = [
    "SELECT", "FROM", "WHERE", "AND", "OR", "GROUP BY", "ORDER BY", 
    "LIMIT", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN",
    "HAVING", "SET", "VALUES", "INSERT INTO", "UPDATE", "DELETE FROM",
    "UNION", "EXCEPT", "INTERSECT", "CREATE TABLE", "DROP TABLE", "ALTER TABLE"
  ];

  let formatted = sql.trim();

  // Normalize whitespace
  formatted = formatted.replace(/\s+/g, " ");

  // Handle new lines for keywords
  for (const keyword of newLineKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, "gi");
    formatted = formatted.replace(regex, (match) => `\n${match.toUpperCase()}`);
  }

  // Indentation logic
  const lines = formatted.split("\n");
  let indentLevel = 0;
  const resultLines = lines.map(line => {
    line = line.trim();
    if (!line) return "";

    // Adjust indent for closing parenthesis
    if (line.startsWith(")")) indentLevel = Math.max(0, indentLevel - 1);

    const space = "  ".repeat(indentLevel);
    
    // Adjust indent for opening parenthesis in the next line
    if (line.endsWith("(")) indentLevel++;

    return space + line;
  });

  return resultLines.filter(l => l.trim() !== "").join("\n");
}
