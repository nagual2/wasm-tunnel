/**
 * VLESS request/response header framing (RFC-style byte layout).
 *
 * Reference: https://xtls.github.io/en/development/protocols/vless.html
 *
 * Request header layout (all fields byte-exact):
 * ```
 * 0  version       1 byte   0x00
 * 1  UUID         16 bytes  binary UUID (big-endian order)
 * 17 addonsLen     1 byte   length of addons data
 * 18 addons        N bytes   (e.g. 1 byte for the early-data token)
 *    command       1 byte   0x01 = TCP
 *    port          2 bytes  big-endian
 *    addrType      1 byte   0x01 IPv4 | 0x02 domain | 0x03 IPv6
 *    addr          variable
 *    payload       request body follows immediately
 * ```
 *
 * Response header layout:
 * ```
 * 0 version        1 byte   0x00 (echoes request version)
 * 1 addonsLen      1 byte
 * 2 addons         N bytes
 *    payload       response body follows immediately
 * ```
 *
 * This module is pure byte manipulation — no WebSocket, no HTTP, no
 * crypto. The VLESS headers themselves are plaintext framing;
 * confidentiality comes from the WebSocket transport (TLS).
 */
import { ADDRESS_TYPE, VLESS_COMMAND, type UUIDString } from './types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown when a VLESS header cannot be built or parsed. */
export class VlessProtocolError extends Error {
  constructor(message: string) {
    super(`vless: ${message}`);
    this.name = 'VlessProtocolError';
  }
}

// ---------------------------------------------------------------------------
// UUID
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a canonical hyphenated UUID v4 string into its 16 raw bytes.
 * Strict: rejects any non-hex character, wrong length, or missing
 * hyphen placement. Input must be canonical (lowercase, hyphenated).
 * Returns a fresh Uint8Array.
 */
export function uuidToBytes(uuid: UUIDString): Uint8Array {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    throw new VlessProtocolError(
      `invalid UUID ${JSON.stringify(uuid)}; expected canonical form xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
    );
  }
  const out = new Uint8Array(16);
  const hex = uuid.replaceAll('-', '');
  // Each byte is a pair of hex digits, in textual order: the canonical
  // string "3f6e..." maps to bytes [0x3f, 0x6e, ...] exactly as Xray's
  // uuid.ParseString does (RFC 4122 big-endian field order).
  for (let i = 0; i < 16; i++) {
    const hi = hex.charCodeAt(i * 2);
    const lo = hex.charCodeAt(i * 2 + 1);
    out[i] = ((hi <= 57 ? hi - 48 : (hi | 0x20) - 87) << 4) | (lo <= 57 ? lo - 48 : (lo | 0x20) - 87);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Address encoding
// ---------------------------------------------------------------------------

/**
 * Parse a target host into its wire form: the address-type byte plus the
 * address bytes, ready to append to the request header after the port.
 *
 * - dotted IPv4          -> type 0x01, 4 bytes
 * - bracketed or bare
 *   IPv6 literal        -> type 0x03, 16 bytes
 * - anything else       -> type 0x02, length-prefixed at the byte level
 *                          by the caller reading the header (VLESS has no
 *                          explicit domain length byte; the reader knows
 *                          because IPv4/IPv6 are fixed-size).
 */
export function encodeAddress(host: string): { type: number; bytes: Uint8Array } {
  if (host.length === 0) {
    throw new VlessProtocolError('empty target address');
  }
  // IPv6 literal (bracketed or bare, e.g. "[::1]" or "::1")
  if (host.includes(':')) {
    const inner = /^\[([0-9a-fA-F:]+)\]$/.exec(host)?.[1] ?? host;
    const bytes = ipv6ToBytes(inner);
    return { type: ADDRESS_TYPE.IPv6, bytes };
  }
  // IPv4 dotted quad
  try {
    const bytes = ipv4ToBytes(host);
    return { type: ADDRESS_TYPE.IPv4, bytes };
  } catch {
    // fall through to domain
  }
  // Domain name — VLESS accepts any bytes; we sanity-check the length.
  const bytes = new TextEncoder().encode(host);
  if (bytes.length > 255) {
    throw new VlessProtocolError(`domain name too long: ${bytes.length} bytes`);
  }
  return { type: ADDRESS_TYPE.DOMAIN, bytes };
}

/** Strict IPv4 dotted-quad parser (exactly 4 octets, each 0-255). */
export function ipv4ToBytes(host: string): Uint8Array {
  const parts = host.split('.');
  if (parts.length !== 4) throw new VlessProtocolError(`invalid IPv4 "${host}"`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    // parts.length === 4 was validated above, so the index is in range.
    const p = parts[i]!;
    if (!/^\d{1,3}$/.test(p)) throw new VlessProtocolError(`invalid IPv4 "${host}"`);
    const n = Number(p);
    if (n > 255) throw new VlessProtocolError(`invalid IPv4 "${host}"`);
    out[i] = n;
  }
  return out;
}

/**
 * Expand a full IPv6 literal (with or without `::` compression) to its
 * 16 bytes. Zone indices are rejected.
 */
export function ipv6ToBytes(addr: string): Uint8Array {
  let input = addr;
  const doubleColon = input.indexOf('::');
  if (doubleColon !== -1) {
    if (input.indexOf('::', doubleColon + 2) !== -1) {
      throw new VlessProtocolError(`invalid IPv6 "${addr}" (multiple ::)`);
    }
    const [head = '', tail = ''] = input.split('::');
    const headGroups = head === '' ? [] : head.split(':');
    const tailGroups = tail === '' ? [] : tail.split(':');
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) throw new VlessProtocolError(`invalid IPv6 "${addr}"`);
    input = [...headGroups, ...Array(missing).fill('0'), ...tailGroups].join(':');
  }
  const groups = input.split(':');
  if (groups.length !== 8) throw new VlessProtocolError(`invalid IPv6 "${addr}"`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    // groups.length === 8 was validated above, so the index is in range.
    const g = groups[i]!;
    if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]{1,4}$/.test(g)) {
      throw new VlessProtocolError(`invalid IPv6 "${addr}"`);
    }
    const val = parseInt(g, 16);
    out[i * 2] = (val >> 8) & 0xff;
    out[i * 2 + 1] = val & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building the request header
// ---------------------------------------------------------------------------

/**
 * Build the VLESS request header bytes:
 *
 * ```
 * version(1) | uuid(16) | addonsLen(1) | addons | command(1) |
 * port(2, BE) | addrType(1) | addr
 * ```
 *
 * The HTTP request payload is NOT included — callers append it (or, with
 * early data, ship it separately). addonsLen is 0 for the plain VLESS
 * flow (Xray only populates addons for the `xrv` flow, which is out of
 * scope for MVP1).
 */
export function buildRequestHeader(opts: {
  uuid: UUIDString;
  /** target host: IPv4, IPv6, or domain */
  host: string;
  /** target port */
  port: number;
}): Uint8Array {
  const { uuid, host, port } = opts;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new VlessProtocolError(`invalid port ${port}`);
  }
  const uuidBytes = uuidToBytes(uuid);
  const addr = encodeAddress(host);

  const headerLen = 1 + 16 + 1 + 1 + 2 + 1 + addr.bytes.length;
  const out = new Uint8Array(headerLen);
  let o = 0;
  out[o++] = 0x00; // version
  out.set(uuidBytes, o); o += 16;
  out[o++] = 0x00; // addonsLen
  out[o++] = VLESS_COMMAND.TCP; // command
  out[o++] = (port >> 8) & 0xff;
  out[o++] = port & 0xff;
  out[o++] = addr.type;
  out.set(addr.bytes, o); o += addr.bytes.length;
  return out;
}

/** Concatenate a list of Uint8Arrays into one. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing the response header
// ---------------------------------------------------------------------------

/** Parsed VLESS response header plus the payload offset within the frame. */
export interface ParsedResponse {
  version: number;
  addonsLen: number;
  addons: Uint8Array;
  /** byte offset of the payload within the frame */
  payloadOffset: number;
}

/**
 * Parse a VLESS response header from the first WebSocket binary frame of
 * a response. Returns the header fields plus the byte offset at which the
 * payload begins. Throws {@link VlessProtocolError} on any structural
 * violation (unknown version, truncated header, oversized addons).
 *
 * The payload is the raw bytes the remote server sent — for an HTTP
 * tunnel that is an HTTP response (status line + headers + body), which
 * higher layers parse.
 */
export function parseResponseHeader(frame: Uint8Array): ParsedResponse {
  if (frame.length < 2) {
    throw new VlessProtocolError(`response too short (${frame.length} bytes)`);
  }
  // frame.length >= 2 was validated above, so these indices are in range.
  const version = frame[0]!;
  if (version !== 0x00) {
    throw new VlessProtocolError(`unsupported response version ${version}`);
  }
  const addonsLen = frame[1]!;
  const headerLen = 2 + addonsLen;
  if (headerLen > frame.length) {
    throw new VlessProtocolError(
      `response header truncated (need ${headerLen} bytes, have ${frame.length})`,
    );
  }
  return {
    version,
    addonsLen,
    addons: frame.slice(2, headerLen),
    payloadOffset: headerLen,
  };
}

/**
 * Split a VLESS response frame into its parsed header and detached payload
 * bytes. Convenience wrapper over {@link parseResponseHeader}.
 */
export function splitResponse(frame: Uint8Array): {
  header: ParsedResponse;
  payload: Uint8Array;
} {
  const header = parseResponseHeader(frame);
  return { header, payload: frame.slice(header.payloadOffset) };
}

export { ADDRESS_TYPE, VLESS_COMMAND };