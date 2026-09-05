import { describe, expect, it } from "vitest";
import { parseUUID, stringifyUUID } from "../src/uuid";

describe("parseUUID", () => {
  it("parses a dashed UUID into 16 bytes", () => {
    const bytes = parseUUID("f47ac10b-58cc-4372-a567-0e02b2c3d479");
    expect(bytes).toEqual(
      new Uint8Array([
        0xf4, 0x7a, 0xc1, 0x0b, 0x58, 0xcc, 0x43, 0x72, 0xa5, 0x67, 0x0e, 0x02, 0xb2, 0xc3,
        0xd4, 0x79,
      ]),
    );
  });

  it("round-trips through stringifyUUID with normalization", () => {
    const raw = "F47AC10B-58CC-4372-A567-0E02B2C3D479";
    expect(stringifyUUID(parseUUID(raw))).toBe(raw.toLowerCase());
  });

  it("accepts a plain 32-hex string", () => {
    expect(stringifyUUID(parseUUID("000102030405060708090a0b0c0d0e0f"))).toBe(
      "00010203-0405-0607-0809-0a0b0c0d0e0f",
    );
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "xyz", "f47ac10b-58cc-4372-a567-0e02b2c3d47", "f47ac10b58cc4372a5670e02b2c3d4799"]) {
      expect(() => parseUUID(bad)).toThrow(/invalid UUID/);
    }
  });
});

describe("stringifyUUID", () => {
  it("rejects wrong byte length", () => {
    expect(() => stringifyUUID(new Uint8Array(15))).toThrow(/exactly 16 bytes/);
  });
});
