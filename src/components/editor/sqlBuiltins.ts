/**
 * Builtin SQL functions per dialect: completion items, offline parameter
 * hints, and the highlighter's function list all read from this table.
 *
 * When connected to PostgreSQL the live catalog (`pg_proc`) is the source
 * of truth for signature help; this table covers MySQL/MariaDB and SQLite
 * (whose builtins have no queryable catalog) and disconnected editors.
 *
 * Parameter conventions: `[name]` is optional, a trailing `...` is variadic.
 */

export type SqlDialect = "postgres" | "mysql" | "sqlite";

export interface BuiltinFunction {
  name: string;
  params: string[];
  returns?: string;
  doc: string;
  dialects: readonly SqlDialect[];
}

const ALL: readonly SqlDialect[] = ["postgres", "mysql", "sqlite"];
const PG: readonly SqlDialect[] = ["postgres"];
const MY: readonly SqlDialect[] = ["mysql"];
const LITE: readonly SqlDialect[] = ["sqlite"];
const PG_MY: readonly SqlDialect[] = ["postgres", "mysql"];
const MY_LITE: readonly SqlDialect[] = ["mysql", "sqlite"];

const fn = (
  name: string,
  params: string[],
  doc: string,
  dialects: readonly SqlDialect[],
  returns?: string,
): BuiltinFunction => ({ name, params, doc, dialects, returns });

export const BUILTIN_FUNCTIONS: readonly BuiltinFunction[] = [
  // Aggregates
  fn("COUNT", ["expression"], "Number of rows where expression is not NULL; COUNT(*) counts every row.", ALL, "bigint"),
  fn("SUM", ["expression"], "Sum of non-NULL input values.", ALL),
  fn("AVG", ["expression"], "Average of non-NULL input values.", ALL),
  fn("MIN", ["expression"], "Minimum of non-NULL input values.", ALL),
  fn("MAX", ["expression"], "Maximum of non-NULL input values.", ALL),
  fn("STRING_AGG", ["expression", "delimiter"], "Concatenate non-NULL values separated by delimiter.", PG, "text"),
  fn("ARRAY_AGG", ["expression"], "Collect input values, including NULLs, into an array.", PG, "anyarray"),
  fn("JSON_AGG", ["expression"], "Aggregate values, including NULLs, as a JSON array.", PG, "json"),
  fn("JSONB_AGG", ["expression"], "Aggregate values, including NULLs, as a JSONB array.", PG, "jsonb"),
  fn("JSONB_OBJECT_AGG", ["key", "value"], "Aggregate key/value pairs as a JSONB object.", PG, "jsonb"),
  fn("BOOL_AND", ["expression"], "True if all non-NULL inputs are true.", PG, "boolean"),
  fn("BOOL_OR", ["expression"], "True if any non-NULL input is true.", PG, "boolean"),
  fn("GROUP_CONCAT", ["expression", "[SEPARATOR str]"], "Concatenate non-NULL values of a group (default separator ',').", MY, "text"),
  fn("GROUP_CONCAT", ["X", "[separator]"], "Concatenate non-NULL values of a group (default separator ',').", LITE, "text"),
  fn("JSON_ARRAYAGG", ["expression"], "Aggregate values as a JSON array.", MY, "json"),
  fn("JSON_OBJECTAGG", ["key", "value"], "Aggregate key/value pairs as a JSON object.", MY, "json"),
  fn("JSON_GROUP_ARRAY", ["X"], "Aggregate values as a JSON array.", LITE, "text"),
  fn("TOTAL", ["X"], "Sum as a floating-point value; 0.0 for an all-NULL group.", LITE, "real"),

  // Window functions
  fn("ROW_NUMBER", [], "Number of the current row within its partition, counting from 1.", ALL, "bigint"),
  fn("RANK", [], "Rank of the current row with gaps.", ALL, "bigint"),
  fn("DENSE_RANK", [], "Rank of the current row without gaps.", ALL, "bigint"),
  fn("NTILE", ["num_buckets"], "Bucket number from 1 to num_buckets, dividing the partition as equally as possible.", ALL, "integer"),
  fn("LAG", ["value", "[offset]", "[default]"], "Value from the row offset rows before the current row (default 1).", ALL),
  fn("LEAD", ["value", "[offset]", "[default]"], "Value from the row offset rows after the current row (default 1).", ALL),
  fn("FIRST_VALUE", ["value"], "Value evaluated at the first row of the window frame.", ALL),
  fn("LAST_VALUE", ["value"], "Value evaluated at the last row of the window frame.", ALL),

  // Conditional / comparison
  fn("COALESCE", ["value", "..."], "First argument that is not NULL.", ALL),
  fn("NULLIF", ["value1", "value2"], "NULL if value1 equals value2, otherwise value1.", ALL),
  fn("GREATEST", ["value", "..."], "Largest value of the list.", PG_MY),
  fn("LEAST", ["value", "..."], "Smallest value of the list.", PG_MY),
  fn("IFNULL", ["expr1", "expr2"], "expr2 if expr1 is NULL, otherwise expr1.", MY_LITE),
  fn("IF", ["condition", "value_if_true", "value_if_false"], "value_if_true when condition holds, otherwise value_if_false.", MY),
  fn("IIF", ["condition", "value_if_true", "value_if_false"], "value_if_true when condition holds, otherwise value_if_false.", LITE),

  // Strings
  fn("LENGTH", ["string"], "Number of characters in string (MySQL: bytes; use CHAR_LENGTH for characters).", ALL, "integer"),
  fn("CHAR_LENGTH", ["string"], "Number of characters in string.", PG_MY, "integer"),
  fn("UPPER", ["string"], "Convert string to upper case.", ALL, "text"),
  fn("LOWER", ["string"], "Convert string to lower case.", ALL, "text"),
  fn("INITCAP", ["string"], "Upper-case the first letter of each word, lower-case the rest.", PG, "text"),
  fn("TRIM", ["string"], "Remove leading and trailing whitespace (PG/MySQL also: TRIM(BOTH chars FROM string)).", ALL, "text"),
  fn("LTRIM", ["string", "[characters]"], "Remove leading characters (default whitespace).", ALL, "text"),
  fn("RTRIM", ["string", "[characters]"], "Remove trailing characters (default whitespace).", ALL, "text"),
  fn("REPLACE", ["string", "from", "to"], "Replace every occurrence of from with to.", ALL, "text"),
  fn("SUBSTR", ["string", "start", "[count]"], "Substring starting at 1-based start, optionally count characters long.", ALL, "text"),
  fn("SUBSTRING", ["string", "start", "[count]"], "Substring starting at 1-based start (PG also: SUBSTRING(string FROM start FOR count)).", PG_MY, "text"),
  fn("CONCAT", ["value", "..."], "Concatenate the text of all arguments (PG ignores NULLs; MySQL returns NULL if any is NULL).", PG_MY, "text"),
  fn("CONCAT_WS", ["separator", "value", "..."], "Concatenate non-NULL arguments separated by separator.", PG_MY, "text"),
  fn("LEFT", ["string", "n"], "First n characters.", PG_MY, "text"),
  fn("RIGHT", ["string", "n"], "Last n characters.", PG_MY, "text"),
  fn("LPAD", ["string", "length", "[fill]"], "Pad string on the left to length with fill (default space).", PG_MY, "text"),
  fn("RPAD", ["string", "length", "[fill]"], "Pad string on the right to length with fill (default space).", PG_MY, "text"),
  fn("REVERSE", ["string"], "Reverse the characters of string.", PG_MY, "text"),
  fn("REPEAT", ["string", "count"], "Repeat string count times.", PG_MY, "text"),
  fn("SPLIT_PART", ["string", "delimiter", "n"], "nth field of string split on delimiter (1-based; negative counts from the end).", PG, "text"),
  fn("STRPOS", ["string", "substring"], "1-based position of substring, or 0.", PG, "integer"),
  fn("POSITION", ["substring IN string"], "1-based position of substring within string, or 0.", PG_MY, "integer"),
  fn("REGEXP_REPLACE", ["source", "pattern", "replacement", "[flags]"], "Replace POSIX regex matches ('g' flag replaces all).", PG_MY, "text"),
  fn("REGEXP_MATCHES", ["string", "pattern", "[flags]"], "Captured substrings of POSIX regex matches.", PG, "setof text[]"),
  fn("REGEXP_SPLIT_TO_ARRAY", ["string", "pattern", "[flags]"], "Split string on a POSIX regex.", PG, "text[]"),
  fn("FORMAT", ["formatstr", "formatarg", "..."], "printf-style formatting: %s string, %I identifier, %L literal.", PG, "text"),
  fn("MD5", ["string"], "MD5 hash as hexadecimal text.", PG_MY, "text"),
  fn("SUBSTRING_INDEX", ["string", "delimiter", "count"], "Substring before the count-th delimiter (negative counts from the right).", MY, "text"),
  fn("LOCATE", ["substring", "string", "[start]"], "1-based position of substring in string, or 0.", MY, "integer"),
  fn("INSTR", ["string", "substring"], "1-based position of the first occurrence of substring, or 0.", MY_LITE, "integer"),
  fn("FIND_IN_SET", ["string", "string_list"], "1-based index of string within a comma-separated list, or 0.", MY, "integer"),
  fn("FORMAT", ["number", "decimals", "[locale]"], "Format number as '#,###,###.##' rounded to decimals.", MY, "text"),
  fn("PRINTF", ["format", "arg", "..."], "printf-style formatting.", LITE, "text"),
  fn("CHAR", ["code", "..."], "String made of the given Unicode code points.", LITE, "text"),
  fn("UNICODE", ["string"], "Code point of the first character.", LITE, "integer"),
  fn("HEX", ["value"], "Upper-case hexadecimal rendering of value.", MY_LITE, "text"),
  fn("QUOTE", ["value"], "Value as an SQL literal.", LITE, "text"),
  fn("TYPEOF", ["value"], "Storage class of value: null, integer, real, text or blob.", LITE, "text"),
  fn("GLOB", ["pattern", "string"], "Case-sensitive Unix glob match.", LITE, "integer"),

  // Numbers
  fn("ABS", ["x"], "Absolute value.", ALL),
  fn("ROUND", ["x", "[digits]"], "Round to digits decimal places (default 0).", ALL),
  fn("CEIL", ["x"], "Smallest integer not less than x.", PG_MY),
  fn("FLOOR", ["x"], "Largest integer not greater than x.", PG_MY),
  fn("TRUNC", ["x", "[digits]"], "Truncate toward zero to digits decimal places.", PG),
  fn("TRUNCATE", ["x", "digits"], "Truncate to digits decimal places.", MY),
  fn("MOD", ["y", "x"], "Remainder of y / x.", PG_MY),
  fn("POWER", ["a", "b"], "a raised to the power b.", PG_MY),
  fn("SQRT", ["x"], "Square root.", PG_MY),
  fn("RANDOM", [], "Random value (PG: 0.0 <= x < 1.0; SQLite: 64-bit integer).", ["postgres", "sqlite"]),
  fn("RAND", ["[seed]"], "Random value 0.0 <= x < 1.0.", MY, "double"),

  // Date / time
  fn("NOW", [], "Current date and time (PG: start of the current transaction).", PG_MY, "timestamptz"),
  fn("CLOCK_TIMESTAMP", [], "Current date and time; changes during statement execution.", PG, "timestamptz"),
  fn("DATE_TRUNC", ["field", "source", "[time_zone]"], "Truncate to precision: 'minute', 'hour', 'day', 'week', 'month', 'year'….", PG, "timestamp"),
  fn("DATE_PART", ["field", "source"], "Subfield of a date/time value, e.g. DATE_PART('year', ts).", PG, "double precision"),
  fn("EXTRACT", ["field FROM source"], "Subfield of a date/time value, e.g. EXTRACT(YEAR FROM ts).", PG_MY, "numeric"),
  fn("AGE", ["timestamp", "[timestamp]"], "Symbolic interval between the arguments (or from current_date).", PG, "interval"),
  fn("TO_CHAR", ["value", "format"], "Format a timestamp/number as text, e.g. TO_CHAR(ts, 'YYYY-MM-DD').", PG, "text"),
  fn("TO_DATE", ["text", "format"], "Parse text to date with a format.", PG, "date"),
  fn("TO_TIMESTAMP", ["text", "format"], "Parse text to timestamptz with a format.", PG, "timestamptz"),
  fn("TO_TIMESTAMP", ["unix_seconds"], "Convert Unix epoch seconds to timestamptz.", PG, "timestamptz"),
  fn("TO_NUMBER", ["text", "format"], "Parse text to numeric with a format.", PG, "numeric"),
  fn("MAKE_DATE", ["year", "month", "day"], "Build a date from fields.", PG, "date"),
  fn("MAKE_INTERVAL", ["[years]", "[months]", "[weeks]", "[days]", "[hours]", "[mins]", "[secs]"], "Build an interval from fields (use named notation: days => 3).", PG, "interval"),
  fn("GENERATE_SERIES", ["start", "stop", "[step]"], "Set of values from start to stop by step.", PG, "setof"),
  fn("CURDATE", [], "Current date.", MY, "date"),
  fn("CURTIME", [], "Current time.", MY, "time"),
  fn("DATE_FORMAT", ["date", "format"], "Format a date, e.g. DATE_FORMAT(d, '%Y-%m-%d').", MY, "text"),
  fn("STR_TO_DATE", ["string", "format"], "Parse string to a date/time with a format.", MY, "datetime"),
  fn("DATE_ADD", ["date", "INTERVAL expr unit"], "Add an interval, e.g. DATE_ADD(d, INTERVAL 1 DAY).", MY, "datetime"),
  fn("DATE_SUB", ["date", "INTERVAL expr unit"], "Subtract an interval.", MY, "datetime"),
  fn("DATEDIFF", ["date1", "date2"], "Days from date2 to date1.", MY, "integer"),
  fn("TIMESTAMPDIFF", ["unit", "datetime1", "datetime2"], "datetime2 − datetime1 in unit (SECOND, MINUTE, DAY, MONTH…).", MY, "bigint"),
  fn("UNIX_TIMESTAMP", ["[date]"], "Seconds since the Unix epoch.", MY, "bigint"),
  fn("FROM_UNIXTIME", ["unix_timestamp", "[format]"], "Unix timestamp as a datetime (or formatted text).", MY, "datetime"),
  fn("YEAR", ["date"], "Year part of date.", MY, "integer"),
  fn("MONTH", ["date"], "Month part of date (1-12).", MY, "integer"),
  fn("DAY", ["date"], "Day of month (1-31).", MY, "integer"),
  fn("LAST_DAY", ["date"], "Last day of the month of date.", MY, "date"),
  fn("DATE", ["time_value", "[modifier]", "..."], "Date as 'YYYY-MM-DD'; modifiers like '+1 day', 'start of month'.", LITE, "text"),
  fn("TIME", ["time_value", "[modifier]", "..."], "Time as 'HH:MM:SS'.", LITE, "text"),
  fn("DATETIME", ["time_value", "[modifier]", "..."], "Date and time as 'YYYY-MM-DD HH:MM:SS'.", LITE, "text"),
  fn("JULIANDAY", ["time_value", "[modifier]", "..."], "Julian day number.", LITE, "real"),
  fn("UNIXEPOCH", ["time_value", "[modifier]", "..."], "Seconds since the Unix epoch.", LITE, "integer"),
  fn("STRFTIME", ["format", "time_value", "[modifier]", "..."], "Format a date/time, e.g. STRFTIME('%Y-%m', ts).", LITE, "text"),

  // JSON
  fn("JSONB_BUILD_OBJECT", ["key", "value", "..."], "JSONB object from alternating keys and values.", PG, "jsonb"),
  fn("JSON_BUILD_OBJECT", ["key", "value", "..."], "JSON object from alternating keys and values.", PG, "json"),
  fn("JSONB_BUILD_ARRAY", ["value", "..."], "JSONB array of the arguments.", PG, "jsonb"),
  fn("JSONB_SET", ["target", "path", "new_value", "[create_if_missing]"], "Replace the item at path (text[]) with new_value.", PG, "jsonb"),
  fn("JSONB_EXTRACT_PATH_TEXT", ["from_json", "path_elem", "..."], "Value at path as text (same as #>>).", PG, "text"),
  fn("JSONB_ARRAY_ELEMENTS", ["array"], "Expand a JSONB array to a set of values.", PG, "setof jsonb"),
  fn("JSONB_ARRAY_LENGTH", ["array"], "Number of elements in a JSONB array.", PG, "integer"),
  fn("JSONB_EACH", ["object"], "Expand a JSONB object to key/value rows.", PG, "setof record"),
  fn("JSONB_OBJECT_KEYS", ["object"], "Set of top-level keys.", PG, "setof text"),
  fn("JSONB_TYPEOF", ["value"], "Type of a JSONB value: object, array, string, number, boolean or null.", PG, "text"),
  fn("JSONB_PRETTY", ["value"], "Indented text rendering of a JSONB value.", PG, "text"),
  fn("TO_JSONB", ["value"], "Convert any value to JSONB.", PG, "jsonb"),
  fn("ROW_TO_JSON", ["record", "[pretty]"], "Row as a JSON object.", PG, "json"),
  fn("JSON_EXTRACT", ["json_doc", "path", "..."], "Value at a JSON path such as '$.a.b'.", MY_LITE),
  fn("JSON_UNQUOTE", ["json_value"], "Unquote a JSON string value.", MY, "text"),
  fn("JSON_OBJECT", ["key", "value", "..."], "JSON object from alternating keys and values.", MY_LITE, "json"),
  fn("JSON_ARRAY", ["value", "..."], "JSON array of the arguments.", MY_LITE, "json"),
  fn("JSON_SET", ["json_doc", "path", "value", "..."], "Insert or replace values at paths.", MY_LITE, "json"),
  fn("JSON_CONTAINS", ["target", "candidate", "[path]"], "1 if candidate is contained in target.", MY, "integer"),

  // Arrays
  fn("UNNEST", ["array", "..."], "Expand arrays to a set of rows.", PG, "setof"),
  fn("ARRAY_LENGTH", ["array", "dimension"], "Length of the given array dimension.", PG, "integer"),
  fn("CARDINALITY", ["array"], "Total number of elements.", PG, "integer"),
  fn("ARRAY_TO_STRING", ["array", "delimiter", "[null_string]"], "Join array elements with delimiter.", PG, "text"),
  fn("STRING_TO_ARRAY", ["string", "delimiter", "[null_string]"], "Split string into a text array.", PG, "text[]"),
  fn("ARRAY_APPEND", ["array", "element"], "Append an element.", PG, "anyarray"),
  fn("ARRAY_POSITION", ["array", "element", "[start]"], "Subscript of the first occurrence of element, or NULL.", PG, "integer"),

  // System / misc
  fn("GEN_RANDOM_UUID", [], "Random version-4 UUID.", PG, "uuid"),
  fn("UUID", [], "Version-1 UUID string.", MY, "text"),
  fn("NEXTVAL", ["sequence"], "Advance the sequence and return its new value.", PG, "bigint"),
  fn("CURRVAL", ["sequence"], "Value most recently obtained by nextval in this session.", PG, "bigint"),
  fn("SETVAL", ["sequence", "value", "[is_called]"], "Set the sequence's current value.", PG, "bigint"),
  fn("CURRENT_SETTING", ["setting_name", "[missing_ok]"], "Current value of a configuration setting.", PG, "text"),
  fn("SET_CONFIG", ["setting_name", "new_value", "is_local"], "Set a configuration setting; is_local limits it to the transaction.", PG, "text"),
  fn("PG_SIZE_PRETTY", ["bytes"], "Human-readable size, e.g. '12 MB'.", PG, "text"),
  fn("PG_TOTAL_RELATION_SIZE", ["relation"], "Disk space of a table including indexes and TOAST.", PG, "bigint"),
  fn("PG_RELATION_SIZE", ["relation", "[fork]"], "Disk space of one fork of a relation.", PG, "bigint"),
  fn("PG_SLEEP", ["seconds"], "Sleep for the given number of seconds.", PG, "void"),
  fn("PG_CANCEL_BACKEND", ["pid"], "Cancel the current query of a backend.", PG, "boolean"),
  fn("PG_TERMINATE_BACKEND", ["pid", "[timeout]"], "Terminate a backend's session.", PG, "boolean"),
  fn("PG_BACKEND_PID", [], "Process ID of the server process for this session.", PG, "integer"),
  fn("LAST_INSERT_ID", ["[expr]"], "Last AUTO_INCREMENT value generated in this session.", MY, "bigint"),
  fn("LAST_INSERT_ROWID", [], "ROWID of the last successful INSERT on this connection.", LITE, "integer"),
  fn("CHANGES", [], "Rows modified by the most recent INSERT/UPDATE/DELETE.", LITE, "integer"),
  fn("DATABASE", [], "Name of the current database.", MY, "text"),
  fn("VERSION", [], "Server version string.", PG_MY, "text"),
];

/** Map an engine id (connection `type`) to its builtin dialect. */
export function dialectForDbType(dbType: string | null | undefined): SqlDialect {
  const t = (dbType || "").toLowerCase();
  if (t === "mysql" || t === "mariadb") return "mysql";
  if (t === "sqlite") return "sqlite";
  return "postgres";
}

const byDialect = new Map<SqlDialect, BuiltinFunction[]>();

export function builtinFunctionsFor(dialect: SqlDialect): BuiltinFunction[] {
  let list = byDialect.get(dialect);
  if (!list) {
    list = BUILTIN_FUNCTIONS.filter((f) => f.dialects.includes(dialect));
    byDialect.set(dialect, list);
  }
  return list;
}

/** Every overload of `name` (case-insensitive) in `dialect`. */
export function findBuiltin(dialect: SqlDialect, name: string): BuiltinFunction[] {
  const upper = name.toUpperCase();
  return builtinFunctionsFor(dialect).filter((f) => f.name === upper);
}

/** `NAME(a, b) → type` */
export function builtinLabel(f: BuiltinFunction): string {
  return `${f.name}(${f.params.join(", ")})${f.returns ? ` → ${f.returns}` : ""}`;
}

/** Unique builtin names across all dialects, for syntax highlighting. */
export const ALL_BUILTIN_NAMES: readonly string[] = [...new Set(BUILTIN_FUNCTIONS.map((f) => f.name))];
