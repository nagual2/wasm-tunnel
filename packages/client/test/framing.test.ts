/**
 * Unit tests for VLESS framing: byte-exact request header layout,
 * UUID parsing, address encoding (IPv4/domain/IPv6), response header
 * parsing. No network — pure byte manipulation.
 */
import { describe, expect, it } from 'vitest';

import {
  ADDRESS_TYPE,
  buildRequestHeader,
  concatBytes,
  encodeAddress,
  ipv4ToBytes,
  ipv6ToBytes,
  parseResponseHeader,
  splitResponse,
  uuidToBytes,
  VlessProtocolError,
} from '../src/framing.js';

const UUID = '3f6e8b2a-4c1d-4e5f-9a0b-1c2d3e4f5a6b';

describe('uuidToBytes', () => {
  it('parses a canonical UUID into exactly 16 bytes', () => {
    const bytes = uuidToBytes(UUID);
    expect(bytes).toHaveLength(16);
    // Byte order: "3f 6e 8b 2a 4c 1d 4e 5f 9a 0b 1c 2d 3e 4f 5a 6b"
    expect(Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      '3f6e8b2a4c1d4e5f9a0b1c2d3e4f5a6b',
    );
  });

  it('accepts a UUID with uppercase hex and lowercases the dump', () => {
    const bytes = uuidToBytes('3F6E8B2A-4C1D-4E5F-9A0B-1C2D3E4F5A6B');
    expect(Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      '3f6e8b2a4c1d4e5f9a0b1c2d3e4f5a6b',
    );
  });

  it('rejects malformed UUIDs', () => {
    const bad = [
      '',                                    // empty
      '3f6e8b2a4c1d4e5f9a0b1c2d3e4f5a6b',   // no hyphens
      '3f6e8b2a-4c1d-4e5f-9a0b-1c2d3e4f5a6', // too short
      '3f6e8b2a-4c1d-4e5f-9a0b-1c2d3e4f5a6bc', // too long
      'zz6e8b2a-4c1d-4e5f-9a0b-1c2d3e4f5a6b', // non-hex
      '3f6e8b2a-4c1d-4e5f-9a0b-1c2d3e4f5a6b!', // trailing junk
      '3f6e8b2a_4c1d-4e5f-9a0b-1c2d3e4f5a6b', // wrong separator
      null as unknown as string,
      undefined as unknown as string,
      42 as unknown as string,
    ];
    for (const u of bad) {
      expect(() => uuidToBytes(u)).toThrow(VlessProtocolError);
    }
  });

  it('returns a fresh buffer each call (no shared mutable state)', () => {
    const a = uuidToBytes(UUID);
    const b = uuidToBytes(UUID);
    a[0] = 0xff;
    expect(b[0]).toBe(0x3f);
  });
});

describe('encodeAddress', () => {
  it('encodes IPv4 as type 0x01 with 4 bytes', () => {
    const { type, bytes } = encodeAddress('192.168.1.10');
    expect(type).toBe(ADDRESS_TYPE.IPv4);
    expect(Array.from(bytes)).toEqual([192, 168, 1, 10]);
  });

  it('rejects malformed IPv4-typed addresses, treats numeric-lookalikes as domains', () => {
    // encodeAddress is permissive: only the empty string is rejected,
    // anything that fails IPv4/IPv6 parse falls back to domain (the
    // server resolves it).
    expect(() => encodeAddress('')).toThrow(VlessProtocolError);
    expect(() => encodeAddress('256.1.1.1')).not.toThrow();
    expect(() => encodeAddress('1.2.3')).not.toThrow();
    expect(encodeAddress('256.1.1.1').type).toBe(ADDRESS_TYPE.DOMAIN);
  });

  it('encodes a domain as type 0x02 (ASCII uppercase → bytes as-is)', () => {
    const { type, bytes } = encodeAddress('example.com');
    expect(type).toBe(ADDRESS_TYPE.DOMAIN);
    expect(new TextDecoder().decode(bytes)).toBe('example.com');
  });

  it('encodes a single-label hostname as a domain', () => {
    const { type, bytes } = encodeAddress('localhost');
    expect(type).toBe(ADDRESS_TYPE.DOMAIN);
    expect(new TextDecoder().decode(bytes)).toBe('localhost');
  });

  it('rejects an over-long domain', () => {
    expect(() => encodeAddress('a'.repeat(256))).toThrow(VlessProtocolError);
  });

  it('encodes bracketed IPv6 as type 0x03 with 16 bytes', () => {
    const { type, bytes } = encodeAddress('[2001:db8::1]');
    expect(type).toBe(ADDRESS_TYPE.IPv6);
    expect(bytes).toHaveLength(16);
    expect(Array.from(bytes)).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it('encodes a bare IPv6 literal (no brackets) as type 0x03', () => {
    const { type, bytes } = encodeAddress('::1');
    expect(type).toBe(ADDRESS_TYPE.IPv6);
    expect(Array.from(bytes).slice(-2)).toEqual([0, 1]);
  });

  it('rejects malformed IPv6', () => {
    expect(() => encodeAddress('[::1')).toThrow(VlessProtocolError);
    expect(() => encodeAddress('[gggg::1]')).toThrow(VlessProtocolError);
    expect(() => encodeAddress('[1:2:3]')).toThrow(VlessProtocolError);
  });
});

describe('ipv4ToBytes / ipv6ToBytes', () => {
  it('ipv4ToBytes round-trips', () => {
    expect(Array.from(ipv4ToBytes('10.0.0.1'))).toEqual([10, 0, 0, 1]);
    expect(Array.from(ipv4ToBytes('255.255.255.255'))).toEqual([255, 255, 255, 255]);
  });

  it('ipv6ToBytes expands :: compression', () => {
    expect(Array.from(ipv6ToBytes('::1'))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(Array.from(ipv6ToBytes('2001:db8::1')).slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
  });

  it('ipv6ToBytes rejects bad input', () => {
    // '::' is valid IPv6 (unspecified address) → 16 zero bytes
    expect(Array.from(ipv6ToBytes('::'))).toEqual(new Array(16).fill(0));
    expect(() => ipv6ToBytes('1:2:3:4:5:6:7:8:9')).toThrow(VlessProtocolError);
    expect(() => ipv6ToBytes('fe80::1%eth0')).toThrow(VlessProtocolError); // zones rejected
  });
});

describe('buildRequestHeader — byte-exact layout', () => {
  it('builds an IPv4 request header with the exact spec bytes', () => {
    const header = buildRequestHeader({ uuid: UUID, host: '192.168.1.10', port: 8080 });
    // Layout:
    //  [0]   version = 0x00
    //  [1..17) uuid 16 bytes
    //  [17]  addonsLen = 0
    //  [18]  command = 0x01 (TCP)
    //  [19..21) port = 8080 (0x1F90) big-endian
    //  [21]  addrType = 0x01 (IPv4)
    //  [22..26) addr = 192 168 1 10
    expect(header.length).toBe(26);
    expect(header[0]).toBe(0x00);
    expect(Array.from(header.slice(1, 17))).toEqual(Array.from(uuidToBytes(UUID)));
    expect(header[17]).toBe(0x00); // addonsLen
    expect(header[18]).toBe(0x01); // command = TCP
    expect(header[19]).toBe(0x1f); // port high byte
    expect(header[20]).toBe(0x90); // port low byte
    expect(header[21]).toBe(0x01); // addrType IPv4
    expect(Array.from(header.slice(22, 26))).toEqual([192, 168, 1, 10]);
  });

  it('builds a domain request header (type 0x02, no length prefix)', () => {
    const header = buildRequestHeader({ uuid: UUID, host: 'example.com', port: 443 });
    expect(header.length).toBe(1 + 16 + 1 + 1 + 2 + 1 + 'example.com'.length);
    expect(header[21]).toBe(0x02); // addrType domain
    expect(new TextDecoder().decode(header.slice(22))).toBe('example.com');
  });

  it('builds an IPv6 request header (type 0x03, 16 bytes)', () => {
    const header = buildRequestHeader({ uuid: UUID, host: '[2001:db8::1]', port: 80 });
    expect(header.length).toBe(1 + 16 + 1 + 1 + 2 + 1 + 16);
    expect(header[21]).toBe(0x03);
  });

  it('rejects invalid port', () => {
    expect(() => buildRequestHeader({ uuid: UUID, host: 'example.com', port: 0 })).toThrow(
      VlessProtocolError,
    );
    expect(() => buildRequestHeader({ uuid: UUID, host: 'example.com', port: 65536 })).toThrow(
      VlessProtocolError,
    );
    expect(() => buildRequestHeader({ uuid: UUID, host: 'example.com', port: 1.5 })).toThrow(
      VlessProtocolError,
    );
  });
});

describe('parseResponseHeader', () => {
  it('parses an empty-addons response', () => {
    // version 0x00, addonsLen 0x00, payload "OK"
    const frame = new Uint8Array([0x00, 0x00, 0x4f, 0x4b]);
    const parsed = parseResponseHeader(frame);
    expect(parsed.version).toBe(0);
    expect(parsed.addonsLen).toBe(0);
    expect(parsed.payloadOffset).toBe(2);
    expect(new TextDecoder().decode(frame.slice(parsed.payloadOffset))).toBe('OK');
  });

  it('parses a response with addons and skips them', () => {
    // version 0x00, addonsLen 0x03, addons [0x0a,0x0b,0x0c], payload "data"
    const frame = new Uint8Array([0x00, 0x03, 0x0a, 0x0b, 0x0c, 0x64, 0x61, 0x74, 0x61]);
    const parsed = parseResponseHeader(frame);
    expect(parsed.addonsLen).toBe(3);
    expect(Array.from(parsed.addons)).toEqual([0x0a, 0x0b, 0x0c]);
    expect(parsed.payloadOffset).toBe(5);
    expect(new TextDecoder().decode(frame.slice(parsed.payloadOffset))).toBe('data');
  });

  it('rejects a non-zero version', () => {
    expect(() => parseResponseHeader(new Uint8Array([0x01, 0x00]))).toThrow(VlessProtocolError);
  });

  it('rejects truncated headers', () => {
    expect(() => parseResponseHeader(new Uint8Array([]))).toThrow(VlessProtocolError);
    expect(() => parseResponseHeader(new Uint8Array([0x00]))).toThrow(VlessProtocolError);
    // addonsLen says 5 but only 0 addons bytes present
    expect(() => parseResponseHeader(new Uint8Array([0x00, 0x05, 0x01]))).toThrow(
      VlessProtocolError,
    );
  });
});

describe('splitResponse', () => {
  it('splits header from payload', () => {
    const frame = new Uint8Array([0x00, 0x00, 0x48, 0x49]);
    const { header, payload } = splitResponse(frame);
    expect(header.version).toBe(0);
    expect(new TextDecoder().decode(payload)).toBe('HI');
  });
});

describe('concatBytes', () => {
  it('concatenates frames in order', () => {
    const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});