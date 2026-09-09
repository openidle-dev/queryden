import { describe, it, expect } from "vitest";
import {
  compareGridValues,
  getTypeHeaderPrefix,
  inferColumnType,
  isBoolType,
  isDateTimeType,
  isJsonType,
  isNumericType,
} from "./columnTypes";

describe("isDateTimeType (issue #51)", () => {
  describe("with a known SQL type — authoritative path", () => {
    it("matches DATE / TIMESTAMP / TIMESTAMPTZ / TIME (case insensitive)", () => {
      expect(isDateTimeType("DATE", "anything")).toBe(true);
      expect(isDateTimeType("date", "anything")).toBe(true);
      expect(isDateTimeType("TIMESTAMP", "anything")).toBe(true);
      expect(isDateTimeType("timestamp", "anything")).toBe(true);
      expect(isDateTimeType("TIMESTAMPTZ", "anything")).toBe(true);
      expect(isDateTimeType("timestamptz", "anything")).toBe(true);
      expect(isDateTimeType("TIME", "anything")).toBe(true);
      expect(isDateTimeType("TIMETZ", "anything")).toBe(true);
    });

    it("matches MySQL DATETIME", () => {
      expect(isDateTimeType("DATETIME", "anything")).toBe(true);
      expect(isDateTimeType("datetime", "anything")).toBe(true);
    });

    it("matches PostgreSQL verbose forms with precision and timezone clause", () => {
      expect(isDateTimeType("timestamp without time zone", "x")).toBe(true);
      expect(isDateTimeType("timestamp with time zone", "x")).toBe(true);
      expect(isDateTimeType("timestamp(6) without time zone", "x")).toBe(true);
      expect(isDateTimeType("time without time zone", "x")).toBe(true);
    });

    it("issue #51: effective_from TIMESTAMP gets the datepicker", () => {
      expect(isDateTimeType("TIMESTAMP", "effective_from")).toBe(true);
    });

    it("issue #51: update_time_label TEXT does NOT get the datepicker", () => {
      expect(isDateTimeType("TEXT", "update_time_label")).toBe(false);
    });

    it("issue #51: date_format_preference VARCHAR does NOT get the datepicker", () => {
      expect(isDateTimeType("VARCHAR", "date_format_preference")).toBe(false);
    });

    it("issue #51: birth DATE gets the datepicker", () => {
      expect(isDateTimeType("DATE", "birth")).toBe(true);
    });

    it("issue #51: scheduled_at TIMESTAMPTZ gets the datepicker", () => {
      expect(isDateTimeType("TIMESTAMPTZ", "scheduled_at")).toBe(true);
    });

    it("returns false for unrelated SQL types regardless of column name", () => {
      expect(isDateTimeType("INTEGER", "created_date")).toBe(false);
      expect(isDateTimeType("BOOLEAN", "is_active_at_time")).toBe(false);
      expect(isDateTimeType("JSONB", "meta_datetime")).toBe(false);
    });
  });

  describe("without a SQL type — falls back to name heuristic (ad-hoc query results)", () => {
    it("matches when name contains 'date'", () => {
      expect(isDateTimeType(undefined, "created_date")).toBe(true);
      expect(isDateTimeType(undefined, "Date")).toBe(true);
      expect(isDateTimeType("", "scheduled_date")).toBe(true);
    });

    it("matches when name contains 'time'", () => {
      expect(isDateTimeType(undefined, "created_time")).toBe(true);
      expect(isDateTimeType(undefined, "Time")).toBe(true);
    });

    it("does not match unrelated names", () => {
      expect(isDateTimeType(undefined, "user_id")).toBe(false);
      expect(isDateTimeType(undefined, "name")).toBe(false);
      expect(isDateTimeType(undefined, "amount")).toBe(false);
    });

    it("whitespace-only SQL type is treated as unknown and falls back to the name", () => {
      expect(isDateTimeType("   ", "updated_at_date")).toBe(true);
      expect(isDateTimeType("   ", "user_id")).toBe(false);
    });

    it("ad-hoc fallback still captures the original heuristic's false positives — by design", () => {
      // The fallback is intentionally permissive: when the type is unknown we
      // preserve pre-#51 behavior rather than silently dropping the editor.
      expect(isDateTimeType(undefined, "update_time_label")).toBe(true);
    });
  });

  describe("unknown SQL type strings", () => {
    it("falls through to the name heuristic when the type is unrecognized", () => {
      // An unknown type (e.g. a custom domain) shouldn't lock us out of the
      // existing name-based fallback — but the SQL-type branch returns false
      // on its own. We treat truly unknown types as 'not a date type'.
      expect(isDateTimeType("MY_CUSTOM_TYPE", "effective_from")).toBe(false);
    });
  });
});

describe("isBoolType", () => {
  it("matches boolean SQL types case-insensitively", () => {
    expect(isBoolType("BOOLEAN", "anything")).toBe(true);
    expect(isBoolType("boolean", "anything")).toBe(true);
    expect(isBoolType("bool", "anything")).toBe(true);
  });

  it("does NOT map BIT columns to the boolean editor", () => {
    // BIT(8) and wider bit fields hold bit values, not booleans — a
    // checkbox would lose the value on save.
    expect(isBoolType("BIT", "anything")).toBe(false);
    expect(isBoolType("BIT(8)", "flags")).toBe(false);
    expect(isBoolType("BIT(1)", "flags")).toBe(false);
    expect(isBoolType("bit", "anything")).toBe(false);
  });

  it("rejects non-boolean types even with suggestive names", () => {
    expect(isBoolType("INTEGER", "is_active")).toBe(false);
    expect(isBoolType("TEXT", "active")).toBe(false);
    expect(isBoolType("tinyint", "active")).toBe(false);
  });

  it("falls back to the name heuristic without a type", () => {
    expect(isBoolType(undefined, "active")).toBe(true);
    expect(isBoolType(undefined, "is_deleted")).toBe(true);
    expect(isBoolType("", "has_access")).toBe(true);
    expect(isBoolType(undefined, "name")).toBe(false);
    expect(isBoolType(undefined, "amount")).toBe(false);
  });
});

describe("isNumericType / isJsonType", () => {
  it("matches numeric SQL types across engines", () => {
    for (const t of [
      "integer", "int", "int4", "int8", "bigint", "smallint",
      "float", "float8", "real", "double precision", "numeric",
      "numeric(10,2)", "decimal", "serial", "bigserial",
      "tinyint", "tinyint(1)", "mediumint",
    ]) {
      expect(isNumericType(t, "anything")).toBe(true);
    }
  });

  it("rejects lookalikes and non-numeric types", () => {
    expect(isNumericType("point", "anything")).toBe(false);
    expect(isNumericType("interval", "anything")).toBe(false);
    expect(isNumericType("timestamp", "anything")).toBe(false);
    expect(isNumericType("text", "amount")).toBe(false);
    expect(isNumericType("boolean", "count")).toBe(false);
  });

  it("matches json types and rejects others", () => {
    expect(isJsonType("json", "x")).toBe(true);
    expect(isJsonType("jsonb", "x")).toBe(true);
    expect(isJsonType("text", "payload")).toBe(false);
    expect(isJsonType("varchar", "data")).toBe(false);
  });

  it("falls back to name heuristics without a type", () => {
    expect(isNumericType(undefined, "unit_price")).toBe(true);
    expect(isNumericType(undefined, "user_id")).toBe(true);
    expect(isNumericType(undefined, "name")).toBe(false);
    expect(isJsonType(undefined, "metadata")).toBe(true);
    expect(isJsonType(undefined, "name")).toBe(false);
  });
});

describe("getTypeHeaderPrefix", () => {
  const cases: Array<[string, string]> = [
    ["integer", "123 "],
    ["int", "123 "],
    ["bigint", "123 "],
    ["number", "123 "],
    ["numeric(10,2)", "123 "],
    ["decimal", "123 "],
    ["serial", "123 "],
    ["bigserial", "123 "],
    ["float", "123 "],
    ["double precision", "123 "],
    ["jsonb", "{} "],
    ["json", "{} "],
    ["timestamp", "🕑 "],
    ["timestamptz", "🕑 "],
    ["timestamp with time zone", "🕑 "],
    ["date", "🕑 "],
    ["datetime", "🕑 "],
    ["time", "🕑 "],
    ["char", "A·Z "],
    ["varchar", "A·Z "],
    ["character varying", "A·Z "],
    ["text", "A·Z "],
    ["uuid", "A·Z "],
    ["boolean", "bool "],
    ["bool", "bool "],
    ["bytea", "01 "],
    ["blob", "01 "],
  ];
  for (const [type, expected] of cases) {
    it(`badges ${type} as ${expected.trim()}`, () => {
      expect(getTypeHeaderPrefix(type, false, "col")).toBe(expected);
    });
  }

  it("adds key/FK markers", () => {
    expect(getTypeHeaderPrefix("integer", false, "id")).toBe("123🔑 ");
    expect(getTypeHeaderPrefix("integer", true, "user_id")).toBe("123🔗 ");
  });
});

describe("inferColumnType", () => {
  it("infers from values with all-null fallback to names", () => {
    expect(inferColumnType([{ a: 1 }, { a: 2 }], "a")).toBe("int");
    expect(inferColumnType([{ a: 1.5 }], "a")).toBe("float");
    expect(inferColumnType([{ a: true }], "a")).toBe("bool");
    expect(inferColumnType([{ a: null }], "active")).toBe("bool");
    expect(inferColumnType([], "amount")).toBe("float");
  });

  it("keeps out-of-range BIGINT digit-strings exact and numeric (#41)", () => {
    // The Rust decoder emits integers beyond 2^53-1 as strings so JSON.parse
    // can't round them. The frontend must treat those strings opaquely —
    // never Number() them — while still classifying the column as numeric.
    expect(inferColumnType([{ a: "-9223372036854775808" }], "a")).toBe("int");
    expect(inferColumnType([{ a: "1152921504606846976" }], "a")).toBe("int");
  });
});

describe("compareGridValues (#41 digit-exact sort)", () => {
  it("sorts numbers numerically (unchanged)", () => {
    expect(compareGridValues(2, 10)).toBeLessThan(0);
    expect(compareGridValues(10, 2)).toBeGreaterThan(0);
    expect(compareGridValues(3, 3)).toBe(0);
  });

  it("sorts exact-digit integer strings by value, not lexically", () => {
    // localeCompare puts "9007199254740993" AFTER "10000000000000000".
    expect(compareGridValues("9007199254740993", "10000000000000000")).toBeLessThan(0);
    expect(compareGridValues("-9223372036854775808", "-1")).toBeLessThan(0);
    expect(compareGridValues("10", "9")).toBeGreaterThan(0);
    expect(compareGridValues("007", "7")).toBe(0);
  });

  it("sorts safe-integer numbers against integer strings exactly", () => {
    expect(compareGridValues(9, "10")).toBeLessThan(0);
    expect(compareGridValues("10", 9)).toBeGreaterThan(0);
  });

  it("falls back to localeCompare for text and decimals (unchanged)", () => {
    expect(compareGridValues("b", "a")).toBeGreaterThan(0);
    expect(compareGridValues("1.5", "1.25")).toBeGreaterThan(0);
    expect(compareGridValues(true, false)).not.toBe(0);
  });
});
