import { describe, expect, it } from "vitest";
import { buildForeignObjectDdl, formatFdwOptions } from "./fdwDdl";
import { groupForeignDataWrappers } from "./schemaCatalog";

function stubDb(rows: Record<string, unknown>[]) {
  return { select: async () => rows };
}

describe("formatFdwOptions", () => {
  it("quotes values and masks credentials", () => {
    expect(formatFdwOptions(["host=db1", "port=5432", "password=s3cr'et"])).toBe(
      "\n  OPTIONS (host 'db1', port '5432', password '********')",
    );
    expect(formatFdwOptions([])).toBe("");
    expect(formatFdwOptions(null)).toBe("");
  });

  it("keeps an '=' inside the value", () => {
    expect(formatFdwOptions(["sslmode=a=b"])).toBe("\n  OPTIONS (sslmode 'a=b')");
  });
});

describe("buildForeignObjectDdl", () => {
  it("writes a server with type, version, wrapper, options and owner", async () => {
    const db = stubDb([{ name: "remote", wrapper: "postgres_fdw", type: null, version: "16", options: ["host=10.0.0.5", "dbname=odoo"], owner: "postgres" }]);
    expect(await buildForeignObjectDdl(db, "foreign_server", "remote")).toBe(
      "CREATE SERVER remote\n  VERSION '16'\n  FOREIGN DATA WRAPPER postgres_fdw\n  OPTIONS (host '10.0.0.5', dbname 'odoo');\n\nALTER SERVER remote OWNER TO postgres;",
    );
  });

  it("reads psql-style text[] options too", async () => {
    const db = stubDb([{ name: "remote", wrapper: "postgres_fdw", options: '{host=a,"application_name=x,y"}', owner: null }]);
    expect(await buildForeignObjectDdl(db, "foreign_server", "remote")).toBe(
      "CREATE SERVER remote\n  FOREIGN DATA WRAPPER postgres_fdw\n  OPTIONS (host 'a', application_name 'x,y');",
    );
  });

  it("notes the extension a wrapper came from", async () => {
    const db = stubDb([{ name: "postgres_fdw", handler: "postgres_fdw_handler", validator: "postgres_fdw_validator", owner: "postgres", options: null, extension: "postgres_fdw" }]);
    expect(await buildForeignObjectDdl(db, "fdw", "postgres_fdw")).toBe(
      "-- Created by extension postgres_fdw: CREATE EXTENSION postgres_fdw;\nCREATE FOREIGN DATA WRAPPER postgres_fdw\n  HANDLER postgres_fdw_handler\n  VALIDATOR postgres_fdw_validator;\n\nALTER FOREIGN DATA WRAPPER postgres_fdw OWNER TO postgres;",
    );
  });

  it("writes PUBLIC user mappings and says when options are hidden", async () => {
    const db = stubDb([{ usename: "public", options: null }]);
    expect(await buildForeignObjectDdl(db, "user_mapping", "public", "remote")).toBe(
      "CREATE USER MAPPING FOR PUBLIC\n  SERVER remote;\n-- Options are only visible to the server's owner or a superuser.",
    );
  });

  it("masks the password of a user mapping", async () => {
    const db = stubDb([{ usename: "odoo", options: ["user=odoo", "password=hunter2"] }]);
    expect(await buildForeignObjectDdl(db, "user_mapping", "odoo", "remote")).toBe(
      "CREATE USER MAPPING FOR odoo\n  SERVER remote\n  OPTIONS (\"user\" 'odoo', password '********');",
    );
  });
});

describe("groupForeignDataWrappers", () => {
  it("nests servers and mappings and keeps wrappers without servers", () => {
    expect(groupForeignDataWrappers([
      { wrapper: "file_fdw", server: null, mapping: null },
      { wrapper: "postgres_fdw", server: "a", mapping: "odoo" },
      { wrapper: "postgres_fdw", server: "a", mapping: "public" },
      { wrapper: "postgres_fdw", server: "b", mapping: null },
    ])).toEqual([
      { name: "file_fdw", servers: [] },
      { name: "postgres_fdw", servers: [{ name: "a", userMappings: ["odoo", "public"] }, { name: "b", userMappings: [] }] },
    ]);
  });
});
