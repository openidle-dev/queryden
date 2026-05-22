import { describe, it, expect } from "vitest";
import { isDateTimeType } from "./columnTypes";

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
