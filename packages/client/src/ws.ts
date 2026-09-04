/**
 * WebSocket transport for VLESS.
 *
 * One VLESS request/response exchange runs over one WebSocket connection:
 * the client sends the request packet as a binary frame (or, with early
 * data enabled, the header goes out in the opening handshake
 * `Sec-WebSocket-Protocol` header and the payload as the first frame),
 * the server replies with a binary frame whose payload is the response
 * content (for an HTTP tunnel: an HTTP response). The connection is
 * closed once the response is fully received.
 *
 * This module knows nothing about VLESS byte layout — it deals in
 * opaque `Uint8Array` packets and delegates all framing to
 * `framing.ts`.
 *
 * Browser compatibility:
 *  - `WebSocket` is used directly (no polyfill).
 *  - Binary frames are `ArrayBuffer` (or `Blob` with
 *    `binaryType: "arraybuffer"`, which we set).
 *  - Early data rides in `Sec-WebSocket-Protocol`, the browser-native
 *    mechanism for sending bytes in the opening handshake.
 */

/** Standard VLESS early-data buffer size; matches Xray's `?ed=8192` default. */
export const EARLY_DATA_BUFFER = 8192;

/** Parse a ws:// or wss:// URL into its parts. */
export interface ParsedWsUrl {
  /** true when the scheme is wss */
  secure: boolean;
  host: string;
  port: number;
  /** query string, without leading "?" */
  query: string;
  /**
   * The URL passed to the WebSocket constructor: original path with
   * `?ed=NNNN` appended when early data is enabled.
   */
  socketUrl: string;
}

export function parseWsUrl(raw: string, earlyData: boolean): ParsedWsUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid WebSocket URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported WebSocket scheme "${url.protocol}"; use ws: or wss:`);
  }
  const secure = url.protocol === 'wss:';
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const ed = earlyData ? `${query === '' ? '?' : '&'}ed=${EARLY_DATA_BUFFER}` : '';
  return {
    secure,
    host: url.hostname,
    port,
    query,
    socketUrl: `${url.protocol}//${url.host}${url.pathname}${query === '' ? '' : '?' + query}${ed}`,
  };
}

/** Encode binary data as base64url (RFC 4648 §5) — used for early data in Sec-WebSocket-Protocol. */
export function toBase64Url(data: Uint8Array): string {
  let bin = '';
  for (const b of data) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** True when the promise can be aborted via an AbortSignal. */
export interface SendOptions {
  /** Byte packet to send immediately after the WebSocket opens. */
  firstPacket?: Uint8Array;
  /** Optional handshake protocol (early-data header token). */
  subprotocol?: string;
}

export interface VlessWsClient {
  /** Open the connection (idempotent) and resolve caches. */
  open(): Promise<void>;
  /** Send one binary frame. */
  send(data: Uint8Array): void;
  /**
   * Wait for the next complete binary message from the server.
   * Messages may arrive as one binary frame or be split across many
   * frames; this resolves with the full concatenation.
   */
  awaitMessage(): Promise<Uint8Array>;
  close(): void;
  /** Underlying WebSocket (for callers that need readyState checks). */
  readonly socket: WebSocket | undefined;
}

/**
 * A minimal promise-wrapping WebSocket client. Not a general-purpose
 * WS library: it exists to give the VLESS tunnel a small, testable
 * surface over the browser WebSocket API.
 */
export class WsClient implements VlessWsClient {
  private ws: WebSocket | undefined;
  private openPromise: Promise<void> | undefined;
  private messageQueue: Uint8Array[] = [];
  private messageWaiter: { resolve: (m: Uint8Array) => void; reject: (e: Error) => void } | undefined;
  private closed = false;
  private error: Error | undefined;

  constructor(
    private readonly url: string,
    private readonly opts: SendOptions = {},
  ) {}

  get socket(): WebSocket | undefined {
    return this.ws;
  }

  open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url, this.opts.subprotocol);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        resolve();
        if (this.opts.firstPacket && this.opts.firstPacket.length > 0) {
          this.send(this.opts.firstPacket);
        }
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        this.error = new Error('WebSocket connection error');
        reject(this.error);
      };
      ws.onmessage = (ev) => {
        const data = ev.data;
        const bytes =
          typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : data instanceof Blob
                ? undefined // handled by onmessage via reader below
                : undefined;
        if (bytes) {
          this.pushMessage(bytes);
        } else if (data instanceof Blob) {
          // defensive: Blob shouldn't occur with binaryType=arraybuffer
          void data.arrayBuffer().then((ab) => this.pushMessage(new Uint8Array(ab)));
        }
      };
      ws.onclose = () => {
        this.closed = true;
        if (!settled) {
          settled = true;
          reject(new Error(this.error ? this.error.message : 'WebSocket closed before open'));
        }
        this.rejectWaiters();
      };
    });
    return this.openPromise;
  }

  private pushMessage(bytes: Uint8Array): void {
    if (this.messageWaiter) {
      const waiter = this.messageWaiter;
      this.messageWaiter = undefined;
      waiter.resolve(bytes.slice());
    } else {
      this.messageQueue.push(bytes.slice());
    }
  }

  private rejectWaiters(): void {
    if (this.messageWaiter) {
      const waiter = this.messageWaiter;
      this.messageWaiter = undefined;
      waiter.reject(new Error('WebSocket closed'));
    }
  }

  send(data: Uint8Array): void {
    if (!this.ws || this.closed) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(data);
  }

  awaitMessage(): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('WebSocket closed'));
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      this.messageWaiter = { resolve, reject };
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.closed = true;
    this.rejectWaiters();
  }
}