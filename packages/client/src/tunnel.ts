/**
 * Browser-first VLESS-over-WebSocket tunnel: `createVlessWsTunnel(options)`
 * returns a tunnel whose `fetch()` performs an HTTP request through the
 * node. Each request uses its own WebSocket connection (one request per
 * connection keeps the MVP simple and fully deterministic).
 */

import { parseUUID } from "./uuid";
import {
  encodeVlessRequestHeader,
  parseIPv6,
  VLESS_COMMAND,
  VlessResponseDecoder,
} from "./protocol";
import { encodeHttpRequest, HttpResponseParser, type HttpResult } from "./http";
import { concatBytes } from "./bytes";

export interface VlessWsTunnelOptions {
  /** WebSocket host of the VLESS node, e.g. "127.0.0.1". */
  host: string;
  /** WebSocket port; defaults to 443 with TLS, 80 without. */
  port?: number;
  /** VLESS user UUID (dashed or plain hex form). */
  uuid: string;
  /** WebSocket path, defaults to "/". May include a query string. */
  path?: string;
  /** Use wss:// instead of ws:// (recommended outside localhost). */
  tls?: boolean;
  /** Overall per-request timeout in ms; default 30000. */
  timeoutMs?: number;
  /** Override the WebSocket constructor (tests / custom transports). */
  webSocketFactory?: (url: string) => WebSocket;
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

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (!/^\/[^\s]*$/.test(withSlash)) {
    throw new Error(`invalid tunnel path: ${JSON.stringify(path)}`);
  }
  return withSlash;
}

export function createVlessWsTunnel(options: VlessWsTunnelOptions): Tunnel {
  const host = normalizeNodeHost(options.host);
  const tls = options.tls ?? false;
  const port = options.port ?? (tls ? 443 : 80);
  const path = normalizePath(options.path ?? "/");
  const wsUrl = `${tls ? "wss" : "ws"}://${host}:${port}${path}`;
  const uuidBytes = parseUUID(options.uuid);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sockets = new Set<WebSocket>();

  return {
    async fetch(input, init = {}) {
      const target = input instanceof URL ? input : new URL(input.toString());
      const requestBytes = encodeHttpRequest({
        method: init.method,
        url: target,
        headers: init.headers,
        body: init.body,
      });
      const targetPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
      const headerBytes = encodeVlessRequestHeader({
        uuid: uuidBytes,
        command: VLESS_COMMAND.TCP,
        port: targetPort,
        address: target.hostname,
      });
      const firstMessage = concatBytes(headerBytes, requestBytes);
      return performRequest({ wsUrl, firstMessage, timeoutMs, sockets, webSocketFactory: options.webSocketFactory, requestMethod: (init.method ?? "GET").toUpperCase() });
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

interface PerformOptions {
  wsUrl: string;
  firstMessage: Uint8Array;
  timeoutMs: number;
  requestMethod: string;
  sockets: Set<WebSocket>;
  webSocketFactory?: (url: string) => WebSocket;
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

function performRequest(opts: PerformOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const ws = opts.webSocketFactory
      ? opts.webSocketFactory(opts.wsUrl)
      : new WebSocket(opts.wsUrl);
    ws.binaryType = "arraybuffer";
    opts.sockets.add(ws);

    const vless = new VlessResponseDecoder();
    const http = new HttpResponseParser({ requestMethod: opts.requestMethod });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

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
        ws.send(opts.firstMessage);
      } catch (error) {
        fail(error);
      }
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data: unknown = event.data;
        const chunk =
          typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
        const payload = vless.push(chunk);
        if (payload.byteLength > 0) http.push(payload);
        if (http.done) succeed(toResponse(http.end()));
      } catch (error) {
        fail(error);
      }
    });
    ws.addEventListener("error", () => {
      fail(new Error(`tunnel WebSocket error: ${opts.wsUrl}`));
    });
    ws.addEventListener("close", () => {
      if (settled) return;
      try {
        succeed(toResponse(http.end()));
      } catch (error) {
        fail(error);
      }
    });
  });
}
