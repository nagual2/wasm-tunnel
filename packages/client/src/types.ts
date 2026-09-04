/**
 * Public types for the wasm-tunnel VLESS-over-WebSocket client.
 *
 * The VLESS request and response headers are plaintext framing (no
 * encryption of their own): confidentiality is provided by the WebSocket
 * transport (TLS when `tls: true`) and, on a real deployment, by the
 * underlying HTTPS. Neither Wasm crypto nor SubtleCrypto is needed to
 * build or parse a VLESS header. See `SPEC.md` for the full architecture.
 */

/**
 * The command byte of a VLESS request. MVP1 only implements TCP proxying.
 * Value must be 0x01 (TCP); UDP (0x02) is out of scope for MVP1.
 */
export const VLESS_COMMAND = {
  TCP: 0x01,
  UDP: 0x02,
} as const;

/** VLESS address type byte. */
export const ADDRESS_TYPE = {
  IPv4: 0x01,
  DOMAIN: 0x02,
  IPv6: 0x03,
} as const;

/** Canonical UUID string (lowercase, hyphenated) -> raw 16 bytes. */
export type UUIDString = string;

/** Options accepted by {@link createVlessWsTunnel}. */
export interface VlessWsTunnelOptions {
  /**
   * User UUID used for the connection handshake (VLESS request header
   * bytes 2..18). Passed as a canonical 36-char UUID v4 string, e.g.
   * `"3f6e8b2a-...-..."`. Parsed and validated strictly.
   */
  uuid: UUIDString;

  /**
   * WebSocket endpoint of the VLESS server, e.g.
   * `"wss://example.com/vless"` or `"ws://127.0.0.1:8080/ws"`.
   * Only `ws:` and `wss:` schemes are accepted. When `tls` is not
   * given, the scheme decides.
   */
  wsUrl: string;

  /**
   * Whether the underlying connection uses TLS. Defaults to
   * `wsUrl` scheme === `"wss:"`, which is the normal way. Explicitly
   * setting `tls: false` with a `wss:` URL is not allowed (and
   * vice-versa) — pass a `ws:`/`wss:` URL and leave this unset unless
   * you know better.
   */
  tls?: boolean;

  /**
   * Enable VLESS early-data ("?ed=NNN" in Xray/sing-box parlance).
   * When enabled, the first packet of every request is sent inside the
   * `Sec-WebSocket-Protocol` header of the opening WebSocket handshake
   * (base64url encoded), and `?ed=8192` is appended to the endpoints'
   * WebSocket path. This is the browser-feasible early data strategy
   * (the alternative — emitting the packet during the WebSocket
   * upgrade over a raw TCP socket — is impossible in a browser).
   * The server must be configured with `"earlyDataHeaderName":
   * "Sec-WebSocket-Protocol"`. See `SPEC.md` §Early data.
   */
  earlyData?: boolean;

  /**
   * Optional Well-known binary x25519 public key for XTLS-splice
   * (Reality-style). Reserved — not used by MVP1.
   */
  publicKey?: Uint8Array;
}

/** Result of {@link VlessTunnel.fetch}. Mimics the fetch Response API closely enough for application code. */
export interface TunnelResponse {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly statusText: string;
  readonly redirected: boolean;
  /** Full response payload (may be empty). */
  readonly body: Uint8Array;
  arrayBuffer(): Promise<ArrayBuffer>;
  clone(): TunnelResponse;
}

/**
 * A VLESS-over-WebSocket tunnel. Each `fetch` performs one full
 * request/response exchange over its own WebSocket connection.
 * Any number of `fetch` calls may be made on the same tunnel.
 */
export interface VlessTunnel {
  /** Perform an HTTP request through the tunnel and return the tunnel response (not a real `Response` — no streaming yet). */
  fetch(input: string, init?: TunnelRequestInit): Promise<TunnelResponse>;
  /** Close the underlying socket if one is open and free the tunnel. Idempotent. */
  close(): Promise<void>;
}

/** Minic of `RequestInit` for the subset of HTTP requests the tunnel forwards. */
export interface TunnelRequestInit {
  /** HTTP method. Defaults to `"GET"` (or `"POST"` when a body is present). */
  method?: string;
  /** Request headers (used verbatim on the request line). */
  headers?: HeadersInit;
  /** MIME type in the `Content-Type` header. */
  contentType?: string;
  /** Request body. */
  body?: BodyInit;
  /** Follow redirects? Defaults to `true`. */
  redirect?: RequestRedirect;
  /** Abort signal (WebSocket-based). */
  signal?: AbortSignal;
}