import { describe, expect, it } from "vitest";
import { buildDatabaseDdl } from "./databaseDdl";

function stubDb(rows: Record<string, unknown>[]) {
  const calls: string[] = [];
  return { calls, select: async (sql: string) => { calls.push(sql); return rows; } };
}

describe("buildDatabaseDdl", () => {
  it("rebuilds CREATE DATABASE from pg_database on PostgreSQL", async () => {
    const db = stubDb([{ owner: "odoo", encoding: "UTF8", lc_collate: "en_US.UTF-8", lc_ctype: "en_US.UTF-8", tablespace: "pg_default", connlimit: -1, is_template: false, allow_conn: true, comment: "it's prod" }]);
    expect(await buildDatabaseDdl(db, "postgres", "odoo")).toBe(
      'CREATE DATABASE "odoo"\n    WITH\n    OWNER = "odoo"\n    ENCODING = \'UTF8\'\n    LC_COLLATE = \'en_US.UTF-8\'\n    LC_CTYPE = \'en_US.UTF-8\'\n    TABLESPACE = "pg_default"\n    CONNECTION LIMIT = -1\n    IS_TEMPLATE = False\n    ALLOW_CONNECTIONS = True;\n\nCOMMENT ON DATABASE "odoo" IS \'it\'\'s prod\';',
    );
  });

  it("uses SHOW CREATE DATABASE on CockroachDB and MySQL", async () => {
    const crdb = stubDb([{ database_name: "x", create_statement: "CREATE DATABASE x" }]);
    expect(await buildDatabaseDdl(crdb, "cockroach", "x")).toBe("CREATE DATABASE x;");
    expect(crdb.calls[0]).toBe('SHOW CREATE DATABASE "x"');

    const mysql = stubDb([{ Database: "shop", "Create Database": "CREATE DATABASE `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */" }]);
    expect(await buildDatabaseDdl(mysql, "mariadb", "shop")).toBe("CREATE DATABASE `shop` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;");
    expect(mysql.calls[0]).toBe("SHOW CREATE DATABASE `shop`");
  });

  it("explains SQLite", async () => {
    expect(await buildDatabaseDdl(stubDb([]), "sqlite", "main")).toMatch(/single file/);
  });
});
