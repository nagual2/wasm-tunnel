/**
 * The VLESS-over-WebSocket tunnel: wires the VLESS framing, the
 * WebSocket transport, and the raw HTTP bridging together behind a
 * fetch-like API.
 *
 * Flow of one `tunnel.fetch(url, init)`:
 *  1. build the raw HTTP/1.1 request bytes (http.ts)
 *  2. build the VLESS request header: version+uuid+addons+command+port+addr (framing.ts)
 *  3. open ONE WebSocket to wsUrl.
 *     - Without early data: send [header + payload] as one binary frame.
 *     - With early data: send the *header* in the opening handshake
 *       (Sec-WebSocket-Protocol, base64url), then the payload as the
 *       first binary frame. (Xray source-verified.)
 *  4. receive the response binary frame(s), parse the VLESS response
 *     header, parse the remaining bytes as HTTP (http.ts)
 *  5. return a TunnelResponse; close the socket.
 *
 * One request = one WebSocket = one response. No connection pooling, no
 * streaming (MVP1).
 */
import { buildHttpRequest, parseHttpResponse } from './http.js';
import {
  buildRequestHeader,
  concatBytes,
  parseResponseHeader,
  VlessProtocolError,
} from './framing.js';
import { EARLY_DATA_BUFFER, parseWsUrl, toBase64Url, WsClient } from './ws.js';
import {
  ADDRESS_TYPE,
  VLESS_COMMAND,
  type TunnelRequestInit,
  type TunnelResponse,
  type UUIDString,
  type VlessTunnel,
  type VlessWsTunnelOptions,
} from './types.js';

/** Response body/streaming limit (bytes). MVP1 reads the whole body. */
export const DEFAULT_MAX_BODY = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/** Split a target URL into host + port + path. */
export function parseTargetUrl(
  url: string,
): { protocol: string; host: string; port: number; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VlessProtocolError(`invalid target URL ${JSON.stringify(url)}`);
  }
  const protocol = parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new VlessProtocolError(`unsupported target protocol "${protocol}"; only http(s)://`);
  }
  const host = parsed.hostname;
  const port = parsed.port === '' ? (protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new VlessProtocolError(`invalid target port ${port}`);
  }
  return { protocol, host, port, path: `${parsed.pathname}${parsed.search}` };
}

// ---------------------------------------------------------------------------
// Tunnel implementation
// ---------------------------------------------------------------------------

class VlessWsTunnelImpl implements VlessTunnel {
  private readonly options: VlessWsTunnelOptions;
  private readonly parsedWs: ReturnType<typeof parseWsUrl>;
  private socket: WsClient | undefined;

  constructor(options: VlessWsTunnelOptions) {
    const { uuid, wsUrl } = options;
    if (typeof uuid !== 'string' || uuid.length === 0) {
      throw new VlessProtocolError('uuid is required');
    }
    this.options = options;
    // Validate the wsUrl now (throws on bad scheme/URL) and bake in the
    // early-data query param if enabled.
    this.parsedWs = parseWsUrl(wsUrl, Boolean(options.earlyData));
  }

  async fetch(input: string, init?: TunnelRequestInit): Promise<TunnelResponse> {
    const target = parseTargetUrl(input);
    const httpPayload = await buildHttpRequest(input, init);
    const header = buildRequestHeader({
      uuid: this.options.uuid,
      host: target.host,
      port: target.port,
    });

    const earlyData = Boolean(this.options.earlyData);
    const socket = new WsClient(this.parsedWs.socketUrl, {
      // With early data the header rides in the opening handshake
      // (Sec-WebSocket-Protocol); without it the header is prepended to
      // the payload and sent as the first binary frame.
      subprotocol: earlyData ? toBase64Url(header) : undefined,
    });
    this.socket = socket;

    try {
      await socket.open();
      const packet = earlyData ? httpPayload : concatBytes([header, httpPayload]);
      if (packet.length > 0) socket.send(packet);

      // Read the response: the first frame carries the VLESS response
      // header; subsequent frames are continuation of the payload.
      // Stop early once the HTTP response is complete (Content-Length
      // satisfied), or when the server closes the socket (Connection:
      // close) or the max body size is reached.
      const frames: Uint8Array[] = [];
      let total = 0;
      let early: TunnelResponse | undefined;
      for (;;) {
        let frame: Uint8Array;
        try {
          frame = await socket.awaitMessage();
        } catch {
          break; // socket closed by server — response is complete
        }
        frames.push(frame);
        total += frame.length;

        const combined = concatBytes(frames);
        const candidate = tryParseEnvelope(combined, input);
        if (candidate) {
          early = candidate;
          break;
        }
        if (total >= DEFAULT_MAX_BODY) break;
      }
      if (early) return early;

      if (frames.length === 0) {
        throw new VlessProtocolError('server closed the WebSocket without sending a response');
      }
      const concatenated = concatBytes(frames);
      const parsedHeader = parseResponseHeader(concatenated);
      return parseHttpEnvelope(concatenated.slice(parsedHeader.payloadOffset), input);
    } finally {
      socket.close();
      this.socket = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
  }
}

/** Turn parsed VLESS payload bytes into a fetch-like TunnelResponse. */
export function parseHttpEnvelope(payload: Uint8Array, url: string): TunnelResponse {
  const http = parseHttpResponse(payload);
  return {
    url,
    status: http.status,
    statusText: http.statusText,
    ok: http.status >= 200 && http.status < 300,
    redirected: false,
    headers: http.headers,
    body: http.body,
    arrayBuffer: () => Promise.resolve(http.body.slice().buffer),
    clone: () => parseHttpEnvelope(payload, url),
  };
}

/**
 * Attempt to parse a complete VLESS+HTTP response out of the frames
 * received so far. Returns undefined when more frames are needed
 * (VLESS header split across frames, HTTP headers incomplete, or
 * Content-Length body not fully received).
 */
export function tryParseEnvelope(
  combined: Uint8Array,
  url: string,
): TunnelResponse | undefined {
  let parsedHeader;
  try {
    parsedHeader = parseResponseHeader(combined);
  } catch {
    return undefined; // VLESS header incomplete — wait for more frames
  }
  const payload = combined.slice(parsedHeader.payloadOffset);
  const text = new TextDecoder().decode(payload);
  const crlf = text.indexOf('\r\n\r\n');
  if (crlf === -1) return undefined; // HTTP headers incomplete
  const head = text.slice(0, crlf);
  // Only stop early when we know the full body size and have it all.
  const contentLength = Number(
    head
      .split('\r\n')
      .find((l) => l.toLowerCase().startsWith('content-length:'))
      ?.split(':')[1]
      ?.trim() ?? -1,
  );
  const bodyBytes = text.length - (crlf + 4);
  if (contentLength >= 0 && bodyBytes < contentLength) return undefined;
  return parseHttpEnvelope(payload, url);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Create a VLESS-over-WebSocket tunnel.
 *
 * The returned tunnel's `fetch` speaks HTTP through the tunnel: each call
 * opens a WebSocket, sends one VLESS request (header + raw HTTP request),
 * reads the VLESS response, parses the HTTP response, closes the socket,
 * and resolves with a {@link TunnelResponse}.
 *
 * @example
 * ```ts
 * const tunnel = createVlessWsTunnel({
 *   uuid: '0f3a4d94-0d8d-4f5e-9f1c-6e0b0a1a2b3c',
 *   wsUrl: 'wss://my-node.example.com/vless',
 *   earlyData: true,
 * });
 * const res = await tunnel.fetch('https://example.com/api', {
 *   method: 'POST',
 *   body: JSON.stringify({ hello: 'world' }),
 * });
 * const data = await res.arrayBuffer();
 * ```
 */
export function createVlessWsTunnel(options: VlessWsTunnelOptions): VlessTunnel {
  return new VlessWsTunnelImpl(options);
}

// Re-export the public types and constants for library consumers.
export {
  ADDRESS_TYPE,
  VLESS_COMMAND,
  EARLY_DATA_BUFFER,
  VlessProtocolError,
};
export type {
  TunnelRequestInit,
  TunnelResponse,
  VlessTunnel,
  VlessWsTunnelOptions,
  UUIDString,
};