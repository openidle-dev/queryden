/**
 * Column type helpers for grid cell rendering.
 *
 * Issue #51: the data grid previously chose date/time editors based on whether
 * the column NAME contained "date" or "time". That misses real datetime columns
 * like `effective_from TIMESTAMP` and false-positives on `update_time_label TEXT`.
 *
 * When we know the SQL type of a column (e.g. from schema introspection for a
 * table-backed result set) we should match on that. When we don't (ad-hoc query
 * result with no table-level schema available) we fall back to the original
 * name-based heuristic so we don't regress existing behavior.
 */

/**
 * SQL date/time type tokens we recognize across PostgreSQL, MySQL/MariaDB,
 * SQLite, and CockroachDB. Stored normalized to upper case for fast lookup.
 *
 * Includes the bare keywords plus the PostgreSQL `udt_name` short forms
 * (`timestamptz`, `timetz`) that information_schema returns alongside
 * `data_type`.
 */
const DATE_TIME_TYPES = new Set<string>([
  "DATE",
  "TIME",
  "TIMETZ",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "DATETIME",
  "SMALLDATETIME",
  "TIMESTAMP WITHOUT TIME ZONE",
  "TIMESTAMP WITH TIME ZONE",
  "TIME WITHOUT TIME ZONE",
  "TIME WITH TIME ZONE",
]);

/**
 * Returns true if the column should render with the date/time overlay editor.
 *
 * Strategy:
 *  1. If `sqlType` is provided, decide solely on the SQL type — this is the
 *     authoritative path and avoids false positives like `update_time_label TEXT`.
 *  2. If `sqlType` is undefined (ad-hoc query result with no schema), fall back
 *     to the name-based heuristic that was in place before #51.
 */
export function isDateTimeType(
  sqlType: string | undefined,
  columnName: string,
): boolean {
  if (sqlType && sqlType.trim() !== "") {
    const normalized = sqlType.trim().toUpperCase();
    if (DATE_TIME_TYPES.has(normalized)) return true;
    // PostgreSQL data_type sometimes arrives with trailing precision, e.g.
    // "timestamp(6) without time zone". Strip a leading type keyword before
    // any "(" or whitespace and try again so we still catch it.
    const head = normalized.split(/[(\s]/, 1)[0];
    return DATE_TIME_TYPES.has(head);
  }
  const low = columnName.toLowerCase();
  return low.includes("date") || low.includes("time");
}

/**
 * Returns true if the column should render with the boolean checkbox editor.
 *
 * Same strategy as {@link isDateTimeType}: authoritative SQL-type match first
 * (`boolean`, `bool`), name heuristic (`active`, `is_*`, …) when the type is
 * unknown. `BIT` is deliberately NOT a boolean: `BIT(8)` and wider bit
 * fields would otherwise render as a checkbox, losing the real bit value on
 * save. Used for NULL cells on new rows, where there is no value to infer
 * the widget from — a new boolean starts unchecked but stays NULL until the
 * user toggles it.
 */
export function isBoolType(
  sqlType: string | undefined,
  columnName: string,
): boolean {
  if (sqlType && sqlType.trim() !== "") {
    const normalized = sqlType.trim().toUpperCase();
    const head = normalized.split(/[(\s]/, 1)[0];
    return head === "BOOL" || head === "BOOLEAN";
  }
  const low = columnName.toLowerCase();
  return (
    low === "active" ||
    low === "enabled" ||
    low === "deleted" ||
    low.includes("is_") ||
    low.includes("has_")
  );
}

/**
 * Numeric type tokens across PostgreSQL, MySQL/MariaDB, SQLite, and
 * CockroachDB (head keyword, upper-cased). Matched on the leading type
 * keyword so `double precision` and `numeric(10,2)` resolve correctly while
 * lookalikes like `point` or `interval` do not.
 */
const NUMERIC_TYPES = new Set<string>([
  "INT",
  "INTEGER",
  "INT2",
  "INT4",
  "INT8",
  "SMALLINT",
  "MEDIUMINT",
  "BIGINT",
  "TINYINT",
  "FLOAT",
  "FLOAT4",
  "FLOAT8",
  "REAL",
  "DOUBLE",
  "NUMERIC",
  "DECIMAL",
  "DEC",
  "SERIAL",
  "SERIAL4",
  "SERIAL8",
  "SMALLSERIAL",
  "BIGSERIAL",
  "MONEY",
]);

/**
 * Returns true if the column holds numbers. Same strategy as
 * {@link isDateTimeType}: authoritative SQL-type match first, name heuristic
 * (matching {@link inferFromColumnName}'s numeric branches) when unknown.
 */
export function isNumericType(
  sqlType: string | undefined,
  columnName: string,
): boolean {
  if (sqlType && sqlType.trim() !== "") {
    const head = sqlType.trim().toUpperCase().split(/[(\s]/, 1)[0];
    return NUMERIC_TYPES.has(head);
  }
  const low = columnName.toLowerCase();
  return (
    low === "id" ||
    low.endsWith("_id") ||
    ["price", "amount", "cost", "total", "salary", "balance"].some((k) => low.includes(k)) ||
    ["age", "count", "quantity", "score", "year"].some((k) => low.includes(k))
  );
}

/**
 * Returns true for `json` / `jsonb` columns. Same strategy as above; the
 * name heuristic mirrors {@link inferFromColumnName}.
 */
export function isJsonType(
  sqlType: string | undefined,
  columnName: string,
): boolean {
  if (sqlType && sqlType.trim() !== "") {
    const head = sqlType.trim().toUpperCase().split(/[(\s]/, 1)[0];
    return head === "JSON" || head === "JSONB";
  }
  const low = columnName.toLowerCase();
  return ["json", "data", "metadata", "properties", "attributes"].some((k) => low.includes(k));
}

const INT_STRING_RE = /^[+-]?\d+$/;

function asBigIntForCompare(val: unknown): bigint | null {
  if (typeof val === "number") {
    return Number.isSafeInteger(val) ? BigInt(val) : null;
  }
  if (typeof val === "string" && INT_STRING_RE.test(val.trim())) {
    try {
      return BigInt(val.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Total order for grid sorting that keeps #41 digit-exact strings exact.
 *
 * - number/number compares numerically (float64, unchanged);
 * - integer-string/integer-string compares via BigInt, so
 *   `9007199254740993` sorts before `10000000000000000` (localeCompare gets
 *   that backwards) without ever coercing through lossy `Number()`;
 * - safe-integer numbers sort against integer strings the same way;
 * - everything else falls back to `localeCompare` on strings (unchanged).
 *
 * Null/undefined rank outside this function — callers handle those first.
 */
export function compareGridValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const bigA = asBigIntForCompare(a);
  const bigB = asBigIntForCompare(b);
  if (bigA !== null && bigB !== null) {
    return bigA < bigB ? -1 : bigA > bigB ? 1 : 0;
  }
  return String(a).localeCompare(String(b));
}

/**
 * Name-based type guess used when neither schema nor values are available.
 * Relocated from GridView (behaviour unchanged).
 */
export function inferFromColumnName(col: string): string {
  const colLower = col.toLowerCase();
  if (colLower === "id" || colLower.endsWith("_id")) return "int";
  if (colLower.includes("date") || colLower.includes("time") || colLower === "created_at" || colLower === "updated_at" || colLower.includes("timestamp")) return "timestamp";
  if (colLower.includes("name") || colLower.includes("title") || colLower.includes("email") || colLower.includes("phone") || colLower.includes("address") || colLower.includes("username")) return "varchar";
  if (colLower.includes("description") || colLower.includes("comment") || colLower.includes("note") || colLower.includes("content") || colLower.includes("message") || colLower.includes("body")) return "text";
  if (colLower.includes("price") || colLower.includes("amount") || colLower.includes("cost") || colLower.includes("total") || colLower.includes("salary") || colLower.includes("balance")) return "float";
  if (colLower.includes("age") || colLower.includes("count") || colLower.includes("quantity") || colLower.includes("score") || colLower.includes("year")) return "int";
  if (colLower.includes("active") || colLower.includes("enabled") || colLower.includes("is_") || colLower.includes("has_") || colLower === "deleted") return "bool";
  if (colLower.includes("json") || colLower.includes("data") || colLower.includes("metadata") || colLower.includes("properties") || colLower.includes("attributes")) return "jsonb";
  if (colLower.includes("image") || colLower.includes("photo") || colLower.includes("avatar") || colLower.includes("file") || colLower.includes("binary") || colLower.includes("blob")) return "bytea";
  if (colLower.includes("uuid") || colLower.includes("guid")) return "uuid";
  return "varchar";
}

/**
 * Infer a display type from sampled row values. Relocated from GridView
 * (behaviour unchanged).
 */
export function inferColumnType(data: any[], col: string): string | undefined {
  if (!col) return undefined;
  let samples = 0;
  const MAX_SAMPLES = 100;
  let hasNumber = false;
  let allNumbers = true;
  let allInt = true;
  let seenBoolString = false;
  let seenNonBoolString = false;
  let hasDateString = false;

  for (const row of data) {
    if (!row) continue;
    const val = row[col];
    if (val === null || val === undefined) continue;

    samples++;
    const isNumber = typeof val === "number";
    const isBool = typeof val === "boolean";
    const isDateObj = val instanceof Date;
    const isJson = typeof val === "object" && !isDateObj;

    if (isNumber) {
      hasNumber = true;
      if (!Number.isInteger(val)) allInt = false;
    } else if (isBool) {
      seenBoolString = true;
      allNumbers = false;
    } else if (isJson) {
      return "json";
    } else {
      const str = String(val).trim();
      if (!str) continue;

      if (isDateObj || (str.length >= 8 && !isNaN(Date.parse(str)) && /[\-T\/:\s]/.test(str))) {
        hasDateString = true;
        allNumbers = false;
      } else if (/^-?\d+(\.\d+)?$/.test(str)) {
        if (str.includes(".")) allInt = false;
      } else if (["true", "false", "t", "f", "yes", "no", "y", "n"].includes(str.toLowerCase())) {
        seenBoolString = true;
        allNumbers = false;
      } else {
        seenNonBoolString = true;
        allNumbers = false;
        allInt = false;
      }
    }

    if (samples >= MAX_SAMPLES) break;
  }

  if (samples === 0) return inferFromColumnName(col);

  if (hasNumber && allNumbers) return allInt ? "int" : "float";
  if (hasDateString) return "timestamp";
  if (seenBoolString && !seenNonBoolString && !hasNumber) return "bool";
  if (allNumbers) return allInt ? "int" : "float";
  return "varchar";
}

/**
 * Header type badge for a column. Relocated from GridView (behaviour
 * unchanged): `123` numeric, `bool`, date/time glyph, `A·Z` text, `{}`
 * JSON, `01` binary — plus key/FK markers.
 */
export function getTypeHeaderPrefix(type: string, isFk: boolean, colName: string): string {
  const t = type.toLowerCase().trim();
  let base = "";

  if (t === "jsonb" || t === "json") {
    base = "{}";
  } else if (t.includes("char") || t.includes("text") || t.includes("uuid") || t.includes("string") || t.includes("clob")) {
    base = "A·Z";
  } else if (t.includes("time") || t.includes("date") || t.includes("timestamp") || t.includes("interval")) {
    base = "🕑";
  } else if (t.includes("int") || t.includes("num") || t.includes("dec") || t.includes("float") || t.includes("double") || t.includes("real") || t === "serial" || t === "bigserial") {
    base = "123";
  } else if (t.includes("bool")) {
    base = "bool";
  } else if (t.includes("blob") || t.includes("bytea") || t.includes("bin")) {
    base = "01";
  } else {
    base = "A·Z"; // Default fallback
  }

  // Key/FK indicators
  if (isFk) {
    return `${base}🔗 `;
  } else if (colName === "id" || colName.endsWith("_id")) {
    return `${base}🔑 `;
  }

  return `${base} `;
}
