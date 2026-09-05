/**
 * VLESS wire protocol, client side. Compatible with Xray-core and sing-box
 * VLESS inbounds. Reference: https://github.com/XTLS/Xray-core
 * (proxy/vless/encoding).
 *
 * Request header layout:
 *   [ver(1)][uuid(16)][alen(1)][addons(alen)]
 *   [cmd(1)][port(2 BE)][atype(1)][address][payload...]
 *
 * Response header layout:
 *   [ver(1)][alen(1)][addons(alen)][payload...]
 *
 * VLESS itself performs no encryption; confidentiality comes from the
 * transport layer (wss:// in the browser, or ws:// on trusted networks).
 */

import { concatBytes, EMPTY_BYTES } from "./bytes";

export const VLESS_VERSION = 0x00;

export const VLESS_COMMAND = {
  TCP: 0x01,
  UDP: 0x02,
  MUX: 0x03,
} as const;

export const VLESS_ADDRESS_TYPE = {
  IPV4: 0x01,
  DOMAIN: 0x02,
  IPV6: 0x03,
} as const;

const textEncoder = new TextEncoder();

export interface VlessRequestOptions {
  /** 16 raw bytes of the VLESS user UUID. */
  uuid: Uint8Array;
  /** Command byte; defaults to TCP. */
  command?: number;
  /** Target TCP port (1-65535). */
  port: number;
  /** Target address: IPv4, IPv6 (brackets optional) or domain name. */
  address: string;
  /** Optional payload appended right after the header. */
  payload?: Uint8Array;
}

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

/**
 * Encode the VLESS request header (optionally followed by an initial
 * payload chunk) to send as the first WebSocket message.
 */
export function encodeVlessRequestHeader(options: VlessRequestOptions): Uint8Array {
  const { uuid, command = VLESS_COMMAND.TCP, port, address, payload } = options;
  if (uuid.length !== 16) {
    throw new Error(`VLESS UUID must be exactly 16 bytes, got ${uuid.length}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid target port: ${port}`);
  }
  const parts: number[] = [VLESS_VERSION];
  // UUID is always exactly 16 bytes in VLESS (no length prefix).
  for (const byte of uuid) parts.push(byte);
  // addons length = 0 (no flow / seed / mux addons over WebSocket transport)
  parts.push(0, command, (port >> 8) & 0xff, port & 0xff);
  const ipv4 = parseIPv4(address);
  if (ipv4) {
    parts.push(VLESS_ADDRESS_TYPE.IPV4);
    for (const byte of ipv4) parts.push(byte);
  } else {
    const ipv6 = parseIPv6(address);
    if (ipv6) {
      parts.push(VLESS_ADDRESS_TYPE.IPV6);
      for (const byte of ipv6) parts.push(byte);
    } else {
      if (address.length === 0 || address.length > 255) {
        throw new Error(`invalid domain length: ${address.length}`);
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(address)) {
        throw new Error(`unsupported characters in domain: ${JSON.stringify(address)}`);
      }
      parts.push(VLESS_ADDRESS_TYPE.DOMAIN, address.length);
      for (const byte of textEncoder.encode(address)) parts.push(byte);
    }
  }
  const header = Uint8Array.from(parts);
  return payload && payload.byteLength > 0 ? concatBytes(header, payload) : header;
}

export interface VlessResponseHeader {
  version: number;
  addonsLength: number;
}

/**
 * Streaming decoder for the VLESS response header. Feeds inbound WebSocket
 * chunks in, passes payload bytes out; tolerates the header being split
 * across multiple chunks.
 */
export class VlessResponseDecoder {
  private pending: Uint8Array | null = null;
  private headerDone = false;
  private decodedHeader: VlessResponseHeader | null = null;

  /** Feed one inbound chunk; returns payload bytes to forward (may be empty). */
  push(chunk: Uint8Array): Uint8Array {
    if (this.headerDone) return chunk;
    const buffer = this.pending ? concatBytes(this.pending, chunk) : chunk;
    if (buffer.byteLength < 2) {
      this.pending = buffer;
      return EMPTY_BYTES;
    }
    const version = buffer[0] ?? 0xff;
    if (version !== VLESS_VERSION) {
      throw new Error(`unexpected VLESS response version: ${version}`);
    }
    const addonsLength = buffer[1] ?? 0;
    const headerLength = 2 + addonsLength;
    if (buffer.byteLength < headerLength) {
      this.pending = buffer;
      return EMPTY_BYTES;
    }
    this.headerDone = true;
    this.decodedHeader = { version, addonsLength };
    this.pending = null;
    return buffer.subarray(headerLength);
  }

  get responseHeader(): VlessResponseHeader | null {
    return this.decodedHeader;
  }
}
