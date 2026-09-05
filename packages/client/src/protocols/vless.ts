/**
 * VLESS over WebSocket protocol module. Compatible with Xray-core and
 * sing-box VLESS inbounds. Reference: https://github.com/XTLS/Xray-core
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

import { concatBytes, EMPTY_BYTES } from "../bytes";
import { toWireAddress, ADDRESS_TYPE } from "../address";
import {
  makeWsTunnel,
  type ProtocolSession,
  type Tunnel,
  type WsTunnelOptions,
} from "../tunnel";
import { parseUUID } from "../uuid";

export const VLESS_VERSION = 0x00;

export const VLESS_COMMAND = {
  TCP: 0x01,
  UDP: 0x02,
  MUX: 0x03,
} as const;

export interface VlessWsTunnelOptions extends WsTunnelOptions {
  /** VLESS user UUID (dashed or plain hex form). */
  uuid: string;
}

/**
 * Encode the VLESS request header (optionally followed by an initial
 * payload chunk) to send as the first WebSocket message.
 */
export function encodeVlessRequestHeader(options: {
  uuid: Uint8Array;
  command?: number;
  port: number;
  address: string;
  payload?: Uint8Array;
}): Uint8Array {
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
  const wire = toWireAddress(address);
  parts.push(wire.atype);
  for (const byte of wire.bytes) parts.push(byte);
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

export function createVlessWsTunnel(options: VlessWsTunnelOptions): Tunnel {
  const uuidBytes = parseUUID(options.uuid);
  return makeWsTunnel(options, (target): ProtocolSession => {
    const header = encodeVlessRequestHeader({
      uuid: uuidBytes,
      command: VLESS_COMMAND.TCP,
      port: target.port,
      address: target.host,
    });
    const decoder = new VlessResponseDecoder();
    return {
      async firstMessage(initialPayload: Uint8Array): Promise<Uint8Array> {
        return concatBytes(header, initialPayload);
      },
      async inbound(chunk: Uint8Array): Promise<Uint8Array> {
        return decoder.push(chunk);
      },
    };
  });
}