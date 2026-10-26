import { describe, it, expect } from "vitest";
import { UTF8_BOM, toCsv, toDeleteStatements, toHtml, toInsertStatements, toTsv, toUpdateStatements, toXml, whereFor, xmlName } from "./exportFormats";

const cols = ["id", "name", "note", "doc"];
const rows = [
  { id: 1, name: 'He said "hi", ok', note: null, doc: { a: [1, 2] } },
  { id: 2, name: "multi\nline", note: "", doc: null },
];

describe("toCsv", () => {
  it("follows RFC 4180: doubled quotes, quoted separators/line breaks, NULL empty", () => {
    expect(toCsv(cols, rows)).toBe(
      'id,name,note,doc\r\n1,"He said ""hi"", ok",,"{""a"":[1,2]}"\r\n2,"multi\nline",,',
    );
  });

  it("can prefix a BOM so Excel reads UTF-8", () => {
    expect(toCsv(["c"], [{ c: "café" }], { bom: true }).startsWith(UTF8_BOM)).toBe(true);
  });
});

describe("markup and TSV", () => {
  it("escapes XML/HTML and sanitises element names", () => {
    const xml = toXml(["order date", "v"], [{ "order date": "a<b & c", v: null }]);
    expect(xml).toContain("<order_date>a&lt;b &amp; c</order_date>");
    expect(xml).toContain('<v null="true"/>');
    expect(xmlName("1st")).toBe("_1st");
    expect(toHtml(["<x>"], [{ "<x>": "<script>" }])).toContain("<th>&lt;x&gt;</th>");
    expect(toHtml(["<x>"], [{ "<x>": "<script>" }])).toContain("<td>&lt;script&gt;</td>");
  });

  it("keeps TSV one row per line", () => {
    expect(toTsv(["a"], [{ a: "x\ty\nz" }])).toBe("a\nx y z");
  });
});

describe("SQL generation", () => {
  it("quotes identifiers per engine and serialises JSON values", () => {
    expect(toInsertStatements("app.Users", ["id", "createdAt", "doc"], [{ id: 1, createdAt: "2024-01-01", doc: { a: 1 } }], "postgres"))
      .toBe(`INSERT INTO app."Users" (id, "createdAt", doc) VALUES (1, '2024-01-01', '{"a":1}');`);
    expect(toInsertStatements("t", ["my col"], [{ "my col": "it's" }], "mysql")).toBe("INSERT INTO t (`my col`) VALUES ('it''s');");
  });

  it("uses IS NULL and the primary key in WHERE clauses", () => {
    expect(whereFor({ a: null, b: 2 }, ["a", "b"], "postgres")).toBe("a IS NULL AND b = 2");
    const row = { id: 7, name: "x", note: null };
    expect(toDeleteStatements("t", ["id", "name", "note"], ["id"], [row], "postgres")).toBe("DELETE FROM t WHERE id = 7;");
    expect(toDeleteStatements("t", ["id", "note"], [], [row], "postgres")).toBe("DELETE FROM t WHERE id = 7 AND note IS NULL;");
    expect(toUpdateStatements("t", ["id", "name", "note"], ["id"], [row], "postgres")).toBe("UPDATE t SET name = 'x', note = NULL WHERE id = 7;");
  });
});
