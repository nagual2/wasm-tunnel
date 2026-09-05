import { describe, expect, it } from "vitest";
import {
  encodeVlessRequestHeader,
  VlessResponseDecoder,
  VLESS_COMMAND,
} from "../src/protocols/vless";
import { parseIPv4, parseIPv6 } from "../src/address";
import { parseUUID } from "../src/uuid";

const UUID = parseUUID("00010203-0405-0607-0809-0a0b0c0d0e0f");

describe("encodeVlessRequestHeader", () => {
  it("encodes a domain request with exact byte layout", () => {
    const out = encodeVlessRequestHeader({ uuid: UUID, port: 8080, address: "example.com" });
    const expected = [
      0x00, // version
      ...UUID,
      0x00, // addons length
      VLESS_COMMAND.TCP,
      0x1f, 0x90, // port 8080
      0x02, 0x0b, // domain, length 11
      ...new TextEncoder().encode("example.com"),
    ];
    expect(out).toEqual(new Uint8Array(expected));
  });

  it("appends payload after the header", () => {
    const out = encodeVlessRequestHeader({
      uuid: UUID,
      port: 80,
      address: "example.com",
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(out.subarray(out.length - 3)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("encodes IPv4 targets with address type 1", () => {
    const out = encodeVlessRequestHeader({ uuid: UUID, port: 80, address: "10.0.0.5" });
    expect(out.at(-5)).toBe(0x01); // atype
    expect(out.subarray(-4)).toEqual(new Uint8Array([10, 0, 0, 5]));
  });

  it("encodes IPv6 targets (brackets optional) with address type 3", () => {
    for (const address of ["2001:db8::1", "[2001:db8::1]"]) {
      const out = encodeVlessRequestHeader({ uuid: UUID, port: 443, address });
      expect(out.at(-17)).toBe(0x03); // atype
      expect(out.subarray(-16)).toEqual(
        new Uint8Array([
          0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
        ]),
      );
    }
  });

  it("validates uuid length, port and domain", () => {
    expect(() => encodeVlessRequestHeader({ uuid: new Uint8Array(15), port: 80, address: "a" })).toThrow(
      /exactly 16 bytes/,
    );
    expect(() => encodeVlessRequestHeader({ uuid: UUID, port: 0, address: "a" })).toThrow(
      /invalid target port/,
    );
    expect(() => encodeVlessRequestHeader({ uuid: UUID, port: 80, address: "a" })).not.toThrow();
    expect(() =>
      encodeVlessRequestHeader({ uuid: UUID, port: 80, address: "bad domain" }),
    ).toThrow(/unsupported characters/);
  });
});

describe("parseIPv4", () => {
  it("accepts valid dotted quads and rejects others", () => {
    expect(parseIPv4("192.168.1.254")).toEqual(new Uint8Array([192, 168, 1, 254]));
    expect(parseIPv4("256.0.0.1")).toBeNull();
    expect(parseIPv4("1.2.3")).toBeNull();
    expect(parseIPv4("example.com")).toBeNull();
  });
});

describe("parseIPv6", () => {
  it("supports full, compressed, bracketed and v4-mapped forms", () => {
    expect(parseIPv6("::")).toEqual(new Uint8Array(16));
    expect(parseIPv6("::1")?.at(-1)).toBe(1);
    expect(parseIPv6("[fe80::1]")).toEqual(parseIPv6("fe80::1"));
    expect(parseIPv6("::ffff:192.168.1.1")).toEqual(
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 1, 1]),
    );
    expect(parseIPv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toEqual(
      parseIPv6("2001:db8::1"),
    );
  });

  it("rejects malformed addresses", () => {
    for (const bad of [":::", "1:2:3:4:5:6:7:8:9", "2001:db8::1::2", "gggg::1", "[::1"]) {
      expect(parseIPv6(bad)).toBeNull();
    }
  });
});

describe("VlessResponseDecoder", () => {
  it("passes payload through after a single-chunk header", () => {
    const decoder = new VlessResponseDecoder();
    const payload = new Uint8Array([0xde, 0xad]);
    expect(decoder.push(new Uint8Array([0, 0, ...payload]))).toEqual(payload);
    expect(decoder.responseHeader).toEqual({ version: 0, addonsLength: 0 });
  });

  it("buffers when the header is split across chunks", () => {
    const decoder = new VlessResponseDecoder();
    expect(decoder.push(new Uint8Array([0]))).toEqual(new Uint8Array(0));
    expect(decoder.push(new Uint8Array([0, 9]))).toEqual(new Uint8Array([9]));
    expect(decoder.push(new Uint8Array([8, 7]))).toEqual(new Uint8Array([8, 7]));
  });

  it("skips addons in the response header", () => {
    const decoder = new VlessResponseDecoder();
    const out = decoder.push(new Uint8Array([0, 2, 0xaa, 0xbb, 1, 2, 3]));
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects unknown protocol versions", () => {
    const decoder = new VlessResponseDecoder();
    expect(() => decoder.push(new Uint8Array([1, 0, 5]))).toThrow(/unexpected VLESS response version/);
  });
});
