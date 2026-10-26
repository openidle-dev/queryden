/**
 * Monarch tokenizer for the `sql` language, replacing Monaco's bundled one
 * (a T-SQL grammar). Covers what PostgreSQL, MySQL/MariaDB and SQLite users
 * actually write:
 *
 * - dollar-quoted bodies (`$$ … $$`, `$fn$ … $fn$`) stay one string, so an
 *   apostrophe inside a function body no longer flips the rest of the file;
 * - `E'…\'…'` escape strings, `B'…'`/`X'…'` bit/hex literals;
 * - `ARRAY[1, 2]` / `arr[1]` are brackets, not T-SQL `[identifiers]`;
 * - MySQL backtick identifiers, `@var` / `@@var`, PostgreSQL `$1` params;
 * - nested block comments (PostgreSQL allows them);
 * - the type after a `::` cast is coloured as a type.
 *
 * Token names keep the `.sql` postfix so the stock vs / vs-dark theme rules
 * that target `keyword.sql`, `string.sql`, `predefined.sql`, … still apply.
 */

import type * as Monaco from "monaco-editor";
import { ALL_BUILTIN_NAMES } from "./sqlBuiltins";
import { classifySqlSpans, type SemanticKind } from "./completionContext";

const KEYWORDS = [
  "ABORT", "ACTION", "ADD", "AFTER", "ALL", "ALTER", "ALWAYS", "ANALYZE", "AND", "ANY", "AS", "ASC",
  "ATOMIC", "AUTHORIZATION", "AUTO_INCREMENT", "BEFORE", "BEGIN", "BETWEEN", "BOTH", "BY", "CALL",
  "CASCADE", "CASE", "CAST", "CHECK", "CHECKPOINT", "CLUSTER", "COLLATE", "COLUMN", "COMMENT", "COMMIT",
  "CONCURRENTLY", "CONFLICT", "CONSTRAINT", "COPY", "CREATE", "CROSS", "CUBE", "CURRENT", "CURSOR",
  "DATABASE", "DEALLOCATE", "DECLARE", "DEFAULT", "DEFERRABLE", "DEFERRED", "DEFINER", "DELETE",
  "DELIMITER", "DESC", "DESCRIBE", "DETERMINISTIC", "DISTINCT", "DO", "DOMAIN", "DROP", "DUPLICATE",
  "EACH", "ELSE", "ELSIF", "END", "ENGINE", "ESCAPE", "EXCEPT", "EXCEPTION", "EXCLUDE", "EXECUTE",
  "EXISTS", "EXPLAIN", "EXTENSION", "FETCH", "FILTER", "FIRST", "FOLLOWING", "FOR", "FOREIGN", "FROM",
  "FULL", "FUNCTION", "GENERATED", "GLOB", "GRANT", "GROUP", "GROUPING", "HAVING", "IDENTITY", "IF",
  "IGNORE", "ILIKE", "IMMEDIATE", "IMMUTABLE", "IN", "INCLUDE", "INDEX", "INHERITS", "INITIALLY",
  "INNER", "INOUT", "INSERT", "INSTEAD", "INTERSECT", "INTO", "INVOKER", "IS", "ISNULL", "JOIN", "KEY",
  "LANGUAGE", "LAST", "LATERAL", "LEADING", "LEFT", "LIKE", "LIMIT", "LISTEN", "LOCK", "LOOP",
  "MATERIALIZED", "MATCHED", "MERGE", "MODIFY", "NATURAL", "NO", "NOT", "NOTHING", "NOTIFY", "NOTNULL",
  "NOWAIT", "NULLS", "OF", "OFFSET", "ON", "ONLY", "OR", "ORDER", "OTHERS", "OUT", "OUTER", "OVER",
  "OWNER", "PARTITION", "PERFORM", "POLICY", "PRAGMA", "PRECEDING", "PREPARE", "PRIMARY", "PROCEDURE",
  "PUBLICATION", "RAISE", "RANGE", "RECURSIVE", "REFERENCES", "REFRESH", "REINDEX", "RELEASE", "RENAME",
  "REPLACE", "RESET", "RESTRICT", "RETURN", "RETURNING", "RETURNS", "REVOKE", "RIGHT", "ROLE",
  "ROLLBACK", "ROLLUP", "ROW", "ROWS", "SAVEPOINT", "SCHEMA", "SECURITY", "SELECT", "SEQUENCE",
  "SESSION", "SET", "SETOF", "SETS", "SHOW", "SIMILAR", "SKIP", "SOME", "STABLE", "STATEMENT",
  "STRICT", "SUBSCRIPTION", "TABLE", "TABLESAMPLE", "TABLESPACE", "TEMP", "TEMPORARY", "THEN", "TIES",
  "TO", "TRAILING", "TRANSACTION", "TRIGGER", "TRUNCATE", "TYPE", "UNBOUNDED", "UNION", "UNIQUE",
  "UNLISTEN", "UNLOGGED", "UNSIGNED", "UNTIL", "UPDATE", "USE", "USING", "VACUUM", "VALUES",
  "VARIADIC", "VERBOSE", "VIEW", "VIRTUAL", "VOLATILE", "WHEN", "WHERE", "WHILE", "WINDOW", "WITH",
  "WITHIN", "WITHOUT", "ZEROFILL",
];

const TYPE_KEYWORDS = [
  "ANYARRAY", "ANYELEMENT", "BIGINT", "BIGSERIAL", "BINARY", "BIT", "BLOB", "BOOL", "BOOLEAN", "BOX",
  "BPCHAR", "BYTEA", "CHAR", "CHARACTER", "CIDR", "CITEXT", "CIRCLE", "DATE", "DATERANGE", "DATETIME",
  "DECIMAL", "DOUBLE", "ENUM", "FLOAT", "FLOAT4", "FLOAT8", "HSTORE", "INET", "INT", "INT2", "INT4",
  "INT4RANGE", "INT8", "INT8RANGE", "INTEGER", "INTERVAL", "JSON", "JSONB", "LINE", "LONGBLOB",
  "LONGTEXT", "LSEG", "MACADDR", "MEDIUMBLOB", "MEDIUMINT", "MEDIUMTEXT", "MONEY", "NCHAR", "NUMERIC",
  "NUMRANGE", "NVARCHAR", "OID", "PATH", "POINT", "POLYGON", "PRECISION", "REAL", "RECORD", "REGCLASS",
  "REGPROC", "REGTYPE", "SERIAL", "SMALLINT", "SMALLSERIAL", "TEXT", "TIME", "TIMESTAMP",
  "TIMESTAMPTZ", "TIMETZ", "TINYBLOB", "TINYINT", "TINYTEXT", "TSQUERY", "TSRANGE", "TSTZRANGE",
  "TSVECTOR", "UUID", "VARBINARY", "VARCHAR", "VARYING", "VOID", "XML", "YEAR", "ZONE",
];

const CONSTANTS = ["TRUE", "FALSE", "NULL", "UNKNOWN"];

const BUILTIN_VARIABLES = [
  "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "CURRENT_SCHEMA",
  "CURRENT_CATALOG", "CURRENT_ROLE", "SESSION_USER", "LOCALTIME", "LOCALTIMESTAMP", "USER",
];

export const sqlLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "--", blockComment: ["/*", "*/"] },
  brackets: [
    ["(", ")"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: "'", close: "'" },
    { open: '"', close: '"' },
    { open: "`", close: "`" },
  ],
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
};

export const sqlMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".sql",
  ignoreCase: true,
  brackets: [
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  keywords: KEYWORDS,
  typeKeywords: TYPE_KEYWORDS,
  constants: CONSTANTS,
  builtinVariables: BUILTIN_VARIABLES,
  builtinFunctions: [...ALL_BUILTIN_NAMES],
  tokenizer: {
    root: [
      { include: "@comments" },
      [/\s+/, "white"],
      { include: "@numbers" },
      { include: "@strings" },
      [/"/, { token: "identifier.quote", next: "@quotedIdentifier" }],
      [/`/, { token: "identifier.quote", next: "@backtickIdentifier" }],
      [/::/, { token: "operator", next: "@castType" }],
      [/\$\d+/, "variable"],
      // Monarch reads `@name` as a grammar attribute; `@@` is a literal `@`.
      [/@@(?:@@)?[A-Za-z_][\w$]*/, "variable"],
      // Qualified names are never keywords: `u.type`, `user.id`, `public.order`.
      [/(\.)(\s*)([A-Za-z_][\w$]*)/, ["delimiter.dot", "white", "identifier"]],
      [/[A-Za-z_][\w$]*(?=\s*\.)/, "identifier"],
      [/[;,]/, "delimiter"],
      [/\./, "delimiter.dot"],
      [/[()[\]]/, "@brackets"],
      // A word followed by `(` is a call unless it is a keyword or type
      // (`IN (`, `VALUES (`, `numeric(12, 2)`).
      [
        /[A-Za-z_][\w$]*(?=\s*\()/,
        {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@constants": "keyword",
            "@builtinFunctions": "predefined",
            "@default": "function",
          },
        },
      ],
      [
        /[A-Za-z_][\w$]*/,
        {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@constants": "keyword",
            "@builtinVariables": "predefined",
            "@builtinFunctions": "predefined",
            "@default": "identifier",
          },
        },
      ],
      [/[<>=!%&+\-*/|~^#?@@:]+/, "operator"],
    ],

    comments: [
      [/--.*$/, "comment"],
      [/\/\*/, { token: "comment", next: "@blockComment" }],
    ],
    blockComment: [
      [/[^/*]+/, "comment"],
      [/\/\*/, { token: "comment", next: "@push" }],
      [/\*\//, { token: "comment", next: "@pop" }],
      [/[/*]/, "comment"],
    ],

    numbers: [
      [/0[xX][0-9a-fA-F]+/, "number.hex"],
      [/(\d+(_\d+)*(\.\d*)?|\.\d+)([eE][-+]?\d+)?/, "number"],
    ],

    strings: [
      [/[eE]'/, { token: "string", next: "@escapeString" }],
      [/([nNbBxX]|[uU]&)'/, { token: "string", next: "@string" }],
      [/'/, { token: "string", next: "@string" }],
      [/\$([A-Za-z_][\w]*)?\$/, { token: "string.quote", next: "@dollarString.$0" }],
    ],
    string: [
      [/[^']+/, "string"],
      [/''/, "string.escape"],
      [/'/, { token: "string", next: "@pop" }],
    ],
    escapeString: [
      [/[^\\']+/, "string"],
      [/\\./, "string.escape"],
      [/''/, "string.escape"],
      [/'/, { token: "string", next: "@pop" }],
    ],
    // $S2 is the opening tag captured in the state name (`dollarString.$fn$`);
    // only the identical tag closes it.
    dollarString: [
      [
        /\$([A-Za-z_][\w]*)?\$/,
        {
          cases: {
            "$0==$S2": { token: "string.quote", next: "@pop" },
            "@default": "string",
          },
        },
      ],
      [/[^$]+/, "string"],
      [/\$/, "string"],
    ],

    quotedIdentifier: [
      [/[^"]+/, "identifier"],
      [/""/, "identifier"],
      [/"/, { token: "identifier.quote", next: "@pop" }],
    ],
    backtickIdentifier: [
      [/[^`]+/, "identifier"],
      [/``/, "identifier"],
      [/`/, { token: "identifier.quote", next: "@pop" }],
    ],

    castType: [
      [/\s+/, "white"],
      [/"[^"]*"/, { token: "type", next: "@pop" }],
      [/(double\s+precision|character\s+varying|time(stamp)?\s+with(out)?\s+time\s+zone)\b/, { token: "type", next: "@pop" }],
      [/[A-Za-z_][\w$]*/, { token: "type", next: "@pop" }],
      [/./, { token: "@rematch", next: "@pop" }],
    ],
  },
};

/** Semantic token types, in legend order; theme rules style them by name. */
export const SQL_SEMANTIC_TYPES: SemanticKind[] = ["table", "schema", "alias"];

/**
 * Encode semantic spans as Monaco's relative 5-tuples
 * (deltaLine, deltaStartChar, length, typeIndex, modifiers).
 */
export function encodeSemanticTokens(
  text: string,
  spans: Array<{ start: number; end: number; kind: SemanticKind }>,
): number[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const span of spans) {
    const line = lineOf(span.start);
    const char = span.start - lineStarts[line];
    data.push(line - prevLine, line === prevLine ? char - prevChar : char, span.end - span.start, SQL_SEMANTIC_TYPES.indexOf(span.kind), 0);
    prevLine = line;
    prevChar = char;
  }
  return data;
}

let registered = false;

/**
 * Register the `sql` language with QueryDen's tokenizer. Called once from
 * `monacoSetup` before any editor mounts, instead of importing Monaco's
 * lazy `sql.contribution` (whose async loader would later overwrite ours).
 */
export function registerSqlLanguage(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: "sql", extensions: [".sql"], aliases: ["SQL", "sql"] });
  monaco.languages.setLanguageConfiguration("sql", sqlLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider("sql", sqlMonarchLanguage);
  // Tables, schemas and aliases need statement context the grammar lacks.
  monaco.languages.registerDocumentSemanticTokensProvider("sql", {
    getLegend: () => ({ tokenTypes: [...SQL_SEMANTIC_TYPES], tokenModifiers: [] }),
    provideDocumentSemanticTokens: (model) => {
      const text = model.getValue();
      return { data: new Uint32Array(encodeSemanticTokens(text, classifySqlSpans(text))) };
    },
    releaseDocumentSemanticTokens: () => {},
  });
}
