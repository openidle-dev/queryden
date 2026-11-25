import { describe, expect, it } from "vitest";
import {
  binaryCellLabel,
  binaryHead,
  binaryToHexLiteral,
  detectBinaryColumns,
  detectFileType,
  formatAsciiBytes,
  formatHexBytes,
  formatHexDump,
  isBinaryValue,
  isByteArray,
  toNormalizedBytes,
} from "./binaryUtils";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("isBinaryValue", () => {
  it("recognises the plugin's base64 form only", () => {
    expect(isBinaryValue({ $binary: "SGk=", size: 2 })).toBe(true);
    expect(isBinaryValue({ $binary: "SGk=" })).toBe(false);
    expect(isBinaryValue({ a: 1 })).toBe(false);
    expect(isBinaryValue([72, 105])).toBe(false);
    expect(isBinaryValue("SGk=")).toBe(false);
    expect(isBinaryValue(null)).toBe(false);
  });
});

describe("binaryCellLabel", () => {
  it("labels from the leading bytes and reported size", () => {
    const value = { $binary: b64([...PNG_HEADER, 0, 0]), size: 3 * 1024 * 1024 };
    expect(binaryCellLabel(value)).toBe("[PNG Image · 3.0 MB]");
  });

  it("labels UTF-8 text even when the 4 KB sniff cuts a character in half", () => {
    const text = "a".repeat(4095) + "é";
    const bytes = Array.from(new TextEncoder().encode(text));
    expect(binaryCellLabel({ $binary: b64(bytes), size: bytes.length })).toBe("[Text File · 4.0 KB]");
  });

  it("returns the cached label for the same value object", () => {
    const value = { $binary: b64(PNG_HEADER), size: 8 };
    const first = binaryCellLabel(value);
    value.$binary = b64([0x25, 0x50, 0x44, 0x46]);
    expect(binaryCellLabel(value)).toBe(first);
  });

  it("is null for non-binary values", () => {
    expect(binaryCellLabel("hello")).toBeNull();
    expect(binaryCellLabel(42)).toBeNull();
    expect(binaryCellLabel(null)).toBeNull();
  });

  it("does not scan a whole legacy byte array", () => {
    const big = new Array<number>(5_000_000).fill(65);
    big[4_999_999] = 999;
    expect(isByteArray(big)).toBe(true);
    expect(binaryHead(big)?.size).toBe(5_000_000);
  });
});

describe("toNormalizedBytes", () => {
  it("decodes every supported form to the same bytes", () => {
    const expected = Uint8Array.from([72, 105]);
    expect(toNormalizedBytes({ $binary: "SGk=", size: 2 })).toEqual(expected);
    expect(toNormalizedBytes([72, 105])).toEqual(expected);
    expect(toNormalizedBytes({ type: "Buffer", data: [72, 105] })).toEqual(expected);
    expect(toNormalizedBytes("\\x4869")).toEqual(expected);
  });

  it("is null for plain text", () => {
    expect(toNormalizedBytes("just some text")).toBeNull();
  });
});

describe("binaryToHexLiteral", () => {
  it("writes PostgreSQL bytea hex", () => {
    expect(binaryToHexLiteral({ $binary: "SGk=", size: 2 })).toBe("\\x4869");
    expect(binaryToHexLiteral("SGk=")).toBeNull();
  });
});

describe("hex formatting on Uint8Array", () => {
  const bytes = Uint8Array.from([0x48, 0x69, 0x00, 0xff]);

  it("formats hex and ASCII as strings, not coerced numbers", () => {
    expect(formatHexBytes(bytes, 3)).toBe("48 69 00");
    expect(formatAsciiBytes(bytes, 4)).toBe("Hi..");
    expect(formatHexDump(bytes)).toBe(`00000000  ${"48 69 00 ff".padEnd(47)} |Hi..|`);
  });

  it("sniffs file types from a Uint8Array", () => {
    expect(detectFileType(Uint8Array.from(PNG_HEADER)).label).toBe("PNG Image");
  });
});

describe("detectBinaryColumns", () => {
  it("finds base64 binary values regardless of the column name", () => {
    const rows = [{ payload: { $binary: "SGk=", size: 2 }, note: "x" }];
    expect([...detectBinaryColumns(rows, ["payload", "note"])]).toEqual(["payload"]);
  });
});
