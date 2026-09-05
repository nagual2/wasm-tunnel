import { describe, expect, it } from "vitest";
import {
  createSsWsTunnel,
  encodeSsTargetAddress,
  evpBytesToKey,
  md5,
  SsAeadInbound,
  SsAeadOutbound,
  type SsAeadMethod,
} from "../src/protocols/shadowsocks";
import { concatBytes, EMPTY_BYTES } from "../src/bytes";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function splitRandomly(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  while (offset < bytes.byteLength) {
    const size = Math.min(sizes[i % sizes.length]!, bytes.byteLength - offset);
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
    i++;
  }
  return chunks;
}

describe("md5", () => {
  it("matches known digests", () => {
    expect(hex(md5(new TextEncoder().encode("")))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(md5(new TextEncoder().encode("abc")))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(hex(md5(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });
});

describe("evpBytesToKey", () => {
  it("derives deterministic keys with the 128-bit prefix property", () => {
    const key16 = evpBytesToKey("secret", 16);
    const key32 = evpBytesToKey("secret", 32);
    expect(key16.byteLength).toBe(16);
    expect(key32.byteLength).toBe(32);
    expect(hex(key32.subarray(0, 16))).toBe(hex(key16));
    expect(hex(evpBytesToKey("secret", 32))).toBe(hex(key32));
    expect(hex(evpBytesToKey("other", 32))).not.toBe(hex(key32));
  });
});

describe("encodeSsTargetAddress", () => {
  it("encodes domain as atype=3, addr, port (SOCKS5 numbering, address BEFORE port)", () => {
    const bytes = encodeSsTargetAddress({ host: "echo", port: 8081 });
    expect(bytes[0]).toBe(3);
    expect(bytes[1]).toBe(4);
    expect(Array.from(bytes.subarray(2, 6))).toEqual([101, 99, 104, 111]); // "echo"
    expect(bytes[6]).toBe(0x1f);
    expect(bytes[7]).toBe(0x91);
  });

  it("encodes IPv6 literals with atype=4 (brackets accepted)", () => {
    const bytes = encodeSsTargetAddress({ host: "[2001:db8::1]", port: 443 });
    expect(bytes[0]).toBe(4);
    expect(bytes.byteLength).toBe(1 + 16 + 2);
    expect(bytes[17]).toBe(0x01);
    expect(bytes[18]).toBe(0xbb);
  });
});

describe("SsAead codec roundtrip", () => {
  const master = evpBytesToKey("test-password", 32);
  const replyHeader = new Uint8Array([1, 0, 0, 0, 0, 0, 0]); // ATYP=1 + 4B addr + 2B port

  it("round-trips a single-chunk stream", async () => {
    const server = await SsAeadOutbound.create(master, 32);
    const data = new TextEncoder().encode("hello over shadowsocks");
    const wire = await server.encode(replyHeader, data);

    const client = new SsAeadInbound(master, 32);
    const payload = await client.push(wire);
    expect(new TextDecoder().decode(payload)).toBe("hello over shadowsocks");
  });

  it("accepts replies without the address echo (Xray-style)", async () => {
    const server = await SsAeadOutbound.create(master, 32);
    const data = new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\nbody");
    const wire = await server.encode(EMPTY_BYTES, data);

    const client = new SsAeadInbound(master, 32);
    const payload = await client.push(wire);
    expect(new TextDecoder().decode(payload)).toBe("HTTP/1.1 200 OK\r\n\r\nbody");
  });

  it("round-trips multi-chunk streams fed in odd-sized pieces", async () => {
    const server = await SsAeadOutbound.create(master, 32);
    const data = new Uint8Array(40000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const wire = await server.encode(replyHeader, data);

    const client = new SsAeadInbound(master, 32);
    let payload = EMPTY_BYTES;
    for (const chunk of splitRandomly(wire, [1, 3, 900, 64])) {
      payload = concatBytes(payload, await client.push(chunk));
    }
    expect(payload.byteLength).toBe(data.byteLength);
    expect(hex(payload.subarray(0, 16))).toBe(hex(data.subarray(0, 16)));
    expect(hex(payload.subarray(-16))).toBe(hex(data.subarray(-16)));
  });

  it("derives an independent subkey per server salt", async () => {
    const serverA = await SsAeadOutbound.create(master, 32);
    const serverB = await SsAeadOutbound.create(master, 32);
    expect(hex(serverA.salt)).not.toBe(hex(serverB.salt));
    const data = new TextEncoder().encode("salted");
    const wireA = await serverA.encode(replyHeader, data);
    const wireB = await serverB.encode(replyHeader, data);
    expect(hex(wireA)).not.toBe(hex(wireB));
    for (const wire of [wireA, wireB]) {
      const client = new SsAeadInbound(master, 32);
      expect(new TextDecoder().decode(await client.push(wire))).toBe("salted");
    }
  });
});

describe("createSsWsTunnel", () => {
  it("rejects methods without a SubtleCrypto mapping", () => {
    expect(() =>
      createSsWsTunnel({
        host: "127.0.0.1",
        password: "pw",
        method: "chacha20-ietf-poly1305" as SsAeadMethod,
      }),
    ).toThrow(/unsupported Shadowsocks method/);
  });
});
