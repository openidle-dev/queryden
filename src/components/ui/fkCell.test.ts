import { describe, expect, it } from "vitest";
import { editedCellValue, isFkCellData } from "./fkCell";

const payload = { __fk__: true as const, value: "1", fkCol: "company_id", fk: { refTable: "res_company", refColumns: ["id"] }, fkValue: 1, onNavigate: () => {} };

describe("FK cell edits", () => {
  it("recognises the grid's FK payload", () => {
    expect(isFkCellData(payload)).toBe(true);
    expect(isFkCellData({ a: 1 })).toBe(false);
    expect(isFkCellData("1")).toBe(false);
    expect(isFkCellData(null)).toBe(false);
  });

  it("never saves the payload itself (was shown as [object Object])", () => {
    expect(editedCellValue(payload)).toBeUndefined();
  });

  it("saves typed text and NULL as they are", () => {
    expect(editedCellValue("1")).toBe("1");
    expect(editedCellValue(null)).toBeNull();
  });
});
