import { describe, it, expect } from "vitest";
import { parseImport } from "./importParsers";

describe("importParsers — DataGrip driver-only sources", () => {
  it("assigns the MySQL default port when only the driver is present", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<data-sources>
  <data-source name="mysql-only">
    <driver>mysql</driver>
    <user-name>bob</user-name>
  </data-source>
</data-sources>`;
    const result = parseImport(xml);
    expect(result.source).toBe("DataGrip");
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].db_type).toBe("mysql");
    expect(result.connections[0].port).toBe(3306);
  });

  it("keeps URL-derived ports and types", () => {
    const xml = `<data-sources>
  <data-source name="pg">
    <database-url>jdbc:postgresql://db.example.com:5433/mydb</database-url>
    <user-name>alice</user-name>
    <driver>postgres</driver>
  </data-source>
</data-sources>`;
    const result = parseImport(xml);
    expect(result.connections[0].db_type).toBe("postgres");
    expect(result.connections[0].port).toBe(5433);
  });
});
