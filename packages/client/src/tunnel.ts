/**
 * Core tunnel machinery shared by all protocols. A protocol module only has
 * to provide a `ProtocolSession` per target: encode the handshake + initial
 * payload into the first transport message, and strip its response framing
 * from inbound chunks. Everything above that seam (WebSocket transport,
 * HTTP/1.1 over the byte stream, Response construction) lives here and is
 * protocol-agnostic.
 */

import { concatBytes } from "./bytes";
import { encodeHttpRequest, HttpResponseParser, type HttpResult } from "./http";
import { parseIPv6 } from "./address";

/** Address of the target the node should connect to. */
export interface TargetAddress {
  /** Hostname or IP literal (IPv6 literals keep their brackets). */
  host: string;
  port: number;
}

/**
 * One protocol session per request. `firstMessage` folds the handshake and
 * the initial application payload into the first transport message; `inbound`
 * strips the protocol's response framing from transport chunks.
 */
export interface ProtocolSession {
  firstMessage(initialPayload: Uint8Array): Promise<Uint8Array>;
  inbound(chunk: Uint8Array): Promise<Uint8Array>;
}

export interface WsTunnelOptions {
  /** WebSocket host of the node, e.g. "127.0.0.1" or "[::1]". */
  host: string;
  /** WebSocket port; defaults to 443 with TLS, 80 without. */
  port?: number;
  /** WebSocket path, defaults to "/". May include a query string. */
  path?: string;
  /** Use wss:// instead of ws:// (recommended outside localhost). */
  tls?: boolean;
  /** Overall per-request timeout in ms; default 30000. */
  timeoutMs?: number;
}

export interface TunnelRequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array | null;
}

export interface Tunnel {
  /** Perform an HTTP request through the tunnel; resolves with a Response. */
  fetch(input: string | URL, init?: TunnelRequestInit): Promise<Response>;
  /** Abort all in-flight requests and close their sockets. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Normalize the node host for the WebSocket URL: bare IPv6 literals get
 * wrapped in brackets ("::1" → "[::1]"), everything else passes through.
 */
export function normalizeNodeHost(raw: string): string {
  const host = raw.trim();
  if (!host) throw new Error("tunnel host is required");
  if (host.startsWith("[")) {
    if (!host.endsWith("]")) throw new Error(`invalid IPv6 host: ${JSON.stringify(raw)}`);
    return host;
  }
  if (parseIPv6(host)) return `[${host}]`;
  return host;
}

export interface BuiltWsTunnel {
  wsUrl: string;
  timeoutMs: number;
}

/** Build the node WebSocket URL from common options (validates the host). */
export function buildWsUrl(options: WsTunnelOptions): BuiltWsTunnel {
  const host = normalizeNodeHost(options.host);
  const tls = options.tls ?? false;
  const port = options.port ?? (tls ? 443 : 80);
  const path = normalizePath(options.path ?? "/");
  return {
    wsUrl: `${tls ? "wss" : "ws"}://${host}:${port}${path}`,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (!/^\/[^\s]*$/.test(withSlash)) {
    throw new Error(`invalid tunnel path: ${JSON.stringify(path)}`);
  }
  return withSlash;
}

/**
 * Assemble a Tunnel from common options and a protocol-specific
 * `openStream` callback. This is the single extension point for protocols.
 */
export function makeWsTunnel(
  options: WsTunnelOptions,
  openStream: (target: TargetAddress) => ProtocolSession | Promise<ProtocolSession>,
): Tunnel {
  const { wsUrl, timeoutMs } = buildWsUrl(options);
  const sockets = new Set<WebSocket>();
  return {
    async fetch(input, init = {}) {
      const url = input instanceof URL ? input : new URL(input.toString());
      const target = toTarget(url);
      const requestBytes = encodeHttpRequest({
        method: init.method,
        url,
        headers: init.headers,
        body: init.body,
      });
      const session = await openStream(target);
      return runTunnelRequest({
        wsUrl,
        timeoutMs,
        sockets,
        session,
        requestBytes,
        requestMethod: (init.method ?? "GET").toUpperCase(),
      });
    },
    close() {
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          // socket may already be closed; nothing to do
        }
      }
      sockets.clear();
    },
  };
}

function toTarget(url: URL): TargetAddress {
  if (url.protocol !== "http:") {
    throw new Error(
      `only http:// targets are supported (got ${url.protocol}); in-tunnel TLS is on the roadmap`,
    );
  }
  return {
    host: url.hostname,
    port: Number(url.port) || 80,
  };
}

interface RunOptions {
  wsUrl: string;
  timeoutMs: number;
  requestMethod: string;
  sockets: Set<WebSocket>;
  session: ProtocolSession;
  requestBytes: Uint8Array;
}

function toResponse(result: HttpResult): Response {
  if (result.status < 200 || result.status > 599) {
    throw new Error(`unsupported HTTP status from tunnel: ${result.status}`);
  }
  const headers = new Headers();
  for (const [name, value] of result.headers) {
    try {
      headers.append(name, value);
    } catch {
      // skip header pairs the platform rejects (e.g. forbidden names)
    }
  }
  const body: BodyInit | null = result.body.byteLength > 0 ? new Uint8Array(result.body) : null;
  return new Response(body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  });
}

async function runTunnelRequest(opts: RunOptions): Promise<Response> {
  // The handshake may be async (key derivation); prepare it before touching
  // the socket so connection errors surface as WebSocket errors.
  const firstMessage = await opts.session.firstMessage(opts.requestBytes);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.wsUrl);
    ws.binaryType = "arraybuffer";
    opts.sockets.add(ws);

    const http = new HttpResponseParser({ requestMethod: opts.requestMethod });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Inbound chunks must be processed strictly in order; async decoders
    // (AEAD) make out-of-order awaits possible, so serialize on a chain.
    let chain: Promise<void> = Promise.resolve();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.sockets.delete(ws);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore close errors on a failing socket
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore close errors after success
      }
      resolve(response);
    };

    if (opts.timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new Error(`tunnel request timed out after ${opts.timeoutMs} ms`)),
        opts.timeoutMs,
      );
    }

    ws.addEventListener("open", () => {
      try {
        ws.send(firstMessage);
      } catch (error) {
        fail(error);
      }
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      chain = chain
        .then(async () => {
          const data: unknown = event.data;
          const chunk =
            typeof data === "string"
              ? new TextEncoder().encode(data)
              : new Uint8Array(data as ArrayBuffer);
          const payload = await opts.session.inbound(chunk);
          if (payload.byteLength > 0) http.push(payload);
          if (http.done) succeed(toResponse(http.end()));
        })
        .catch(fail);
    });
    ws.addEventListener("error", () => {
      fail(new Error(`tunnel WebSocket error: ${opts.wsUrl}`));
    });
    ws.addEventListener("close", () => {
      if (settled) return;
      chain
        .then(() => {
          if (settled) return;
          succeed(toResponse(http.end()));
        })
        .catch(fail);
    });
  });
}
