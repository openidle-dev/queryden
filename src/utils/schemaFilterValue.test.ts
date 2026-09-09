import { describe, it, expect } from "vitest";
import {
  ALL_SCHEMAS_VALUE,
  decodeSchemaFilterValue,
  encodeSchemaFilterValue,
} from "./schemaFilterValue";

describe("schemaFilterValue (sentinel collision)", () => {
  it("round-trips undefined through the all-schemas value", () => {
    expect(encodeSchemaFilterValue(undefined)).toBe(ALL_SCHEMAS_VALUE);
    expect(decodeSchemaFilterValue(ALL_SCHEMAS_VALUE)).toBeUndefined();
  });

  it("round-trips ordinary schema names", () => {
    for (const s of ["public", "app", "my-schema_2"]) {
      expect(decodeSchemaFilterValue(encodeSchemaFilterValue(s))).toBe(s);
    }
  });

  it("a schema literally named like the old sentinel still filters", () => {
    // Regression: `__all_schemas__` used to decode as "All Schemas".
    expect(encodeSchemaFilterValue("__all_schemas__")).not.toBe(ALL_SCHEMAS_VALUE);
    expect(decodeSchemaFilterValue(encodeSchemaFilterValue("__all_schemas__"))).toBe("__all_schemas__");
  });

  it("names containing colons round-trip (single-prefix strip)", () => {
    expect(decodeSchemaFilterValue(encodeSchemaFilterValue("s:all"))).toBe("s:all");
    expect(decodeSchemaFilterValue(encodeSchemaFilterValue("a:b:c"))).toBe("a:b:c");
  });
});
