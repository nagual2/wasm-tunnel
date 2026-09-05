/**
 * Shared address parsing for protocol modules: how a target host string maps
 * to wire-level address types. Wire layout differs per protocol (VLESS puts
 * the port before the address, Shadowsocks after) — only the parsers and the
 * address-type constants are shared here.
 */

/** Address-type constants shared by SOCKS-family wire formats. */
export const ADDRESS_TYPE = {
  IPV4: 0x01,
  DOMAIN: 0x02,
  IPV6: 0x03,
} as const;

import { concatBytes } from "./bytes";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse a dotted-quad IPv4 address into 4 bytes, or return null. */
export function parseIPv4(value: string): Uint8Array | null {
  const match = IPV4_RE.exec(value);
  if (!match) return null;
  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return new Uint8Array(octets);
}

/**
 * Parse an IPv6 address (with optional brackets) into 16 bytes, or return
 * null. Supports `::` compression and IPv4-mapped tails.
 */
export function parseIPv6(value: string): Uint8Array | null {
  let raw = value;
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) return null;
    raw = raw.slice(1, -1);
  }
  if (!raw.includes(":")) return null;
  const compressed = raw.includes("::");
  if (raw.includes(":::")) return null;

  // Split off an IPv4-mapped tail, e.g. "::ffff:192.168.0.1".
  let v4Tail: Uint8Array | null = null;
  let body = raw;
  const lastColon = raw.lastIndexOf(":");
  if (raw.slice(lastColon + 1).includes(".")) {
    v4Tail = parseIPv4(raw.slice(lastColon + 1));
    if (!v4Tail) return null;
    body = raw.slice(0, lastColon);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const leftHalf = halves[0];
  const rightHalf = halves.length === 2 ? halves[1] : undefined;
  const left = !leftHalf ? [] : leftHalf.split(":");
  const right = !rightHalf ? [] : rightHalf.split(":");
  for (const group of [...left, ...right]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  }
  const fill = 8 - (left.length + right.length + (v4Tail ? 2 : 0));
  if (fill < 0 || (!compressed && fill !== 0)) return null;

  const groups: number[] = [];
  for (const group of left) groups.push(Number.parseInt(group, 16));
  for (let i = 0; i < fill; i++) groups.push(0);
  for (const group of right) groups.push(Number.parseInt(group, 16));
  if (v4Tail) {
    const a = v4Tail[0] ?? 0;
    const b = v4Tail[1] ?? 0;
    const c = v4Tail[2] ?? 0;
    const d = v4Tail[3] ?? 0;
    groups.push(((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff);
  }
  const out = new Uint8Array(16);
  groups.forEach((group, index) => {
    out[index * 2] = (group >> 8) & 0xff;
    out[index * 2 + 1] = group & 0xff;
  });
  return out;
}

/** Resolved wire form of a target host: type + address bytes (no port).
 *  Domain addresses carry their one-byte length prefix, as in SOCKS-family
 *  wire formats (both VLESS and Shadowsocks). */
export interface WireAddress {
  atype: number;
  bytes: Uint8Array;
}

const textEncoder = new TextEncoder();

/** Classify a target host into a wire address; throws on unusable input. */
export function toWireAddress(host: string): WireAddress {
  const ipv4 = parseIPv4(host);
  if (ipv4) return { atype: ADDRESS_TYPE.IPV4, bytes: ipv4 };
  const ipv6 = parseIPv6(host);
  if (ipv6) return { atype: ADDRESS_TYPE.IPV6, bytes: ipv6 };
  if (host.length === 0 || host.length > 255) {
    throw new Error(`invalid domain length: ${host.length}`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
    throw new Error(`unsupported characters in domain: ${JSON.stringify(host)}`);
  }
  return {
    atype: ADDRESS_TYPE.DOMAIN,
    bytes: concatBytes(new Uint8Array([host.length]), textEncoder.encode(host)),
  };
}
