/**
 * Service Worker fetch interceptor for wasm-tunnel.
 *
 * A small dependency-free module so a page can route `fetch()` calls through
 * the tunnel via a Service Worker. The tunnel lives inside the worker: the
 * page registers its tunnel config once, then either lets the worker's `fetch`
 * handler forward matching requests automatically, or calls `tunnelFetch()`
 * for an explicit per-call opt-in. There is no global `fetch`
 * monkey-patching. Application transport inside the page only — not a VPN.
 *
 * Page ⇄ worker message protocol (all messages are plain structured-cloneable
 * objects; request/response correlation for `tunnelFetch` goes over a
 * per-call `MessageChannel`):
 *
 *   page → worker   { type: "wt/register", config: SwTunnelConfig }
 *   worker → page   { type: "wt/registered" }
 *                   { type: "wt/error", message }
 *   page → worker   { type: "wt/fetch", id, url, method?, headers?, body? }
 *   worker → page   { type: "wt/fetch-result", id, status, statusText,
 *                     headers, body }              (body transferred)
 *                   { type: "wt/error", id, message }
 *
 * Messages with an unknown shape or type are ignored so the worker can share
 * its message channel with unrelated code.
 *
 * Routing: the `fetch` handler only intercepts same-origin requests whose
 * path starts with one of the configured route prefixes (default
 * `DEFAULT_SW_ROUTES`). The remainder of the path (+ query string) is parsed
 * as the absolute in-tunnel target URL, e.g. with the default route a page
 * `fetch("/tunnel/http://echo:8081/items?page=2")` becomes
 * `tunnel.fetch("http://echo:8081/items?page=2")`. Only `http://` targets are
 * accepted (same limit as `tunnel.fetch` itself).
 *
 * Error behavior (consistent everywhere in this module):
 *   - `fetch` handler, URL not matched ........... passthrough (untouched)
 *   - `fetch` handler, matched but no tunnel ..... 503 synthetic Response
 *   - `fetch` handler, matched and tunnel fails .. 502 synthetic Response
 *     (plain-text body `wasm-tunnel: <reason>`; the original failure is never
 *     thrown into the page from a fetch event)
 *   - `tunnelFetch()` / `installTunnelServiceWorker()` ... reject with Error
 *     (no controller, ack timeout, worker-side error message preserved)
 *
 * Limits: same-origin worker scope (a SW cannot intercept other origins);
 * request/response bodies are buffered in memory (no streaming uploads);
 * the tunnel config lives in worker memory — a worker restart drops it, so
 * the page must re-register (e.g. on `controllerchange`); `http://` targets
 * only, one request per WebSocket connection (inherited from the tunnel).
 */

import type { CreateTunnelOptions } from "./create-tunnel";
import type { Tunnel, TunnelRequestInit } from "./tunnel";

/** Default same-origin path prefixes intercepted by the SW fetch handler. */
export const DEFAULT_SW_ROUTES: readonly string[] = ["/tunnel/"];

/**
 * Tunnel configuration the page registers inside the Service Worker. This is
 * the regular `createTunnel` options object (protocol discriminator `vless`
 * with `uuid`, or `shadowsocks` with `password`/`method`) plus the optional
 * route list for the automatic `fetch`-event path. `tunnelFetch()` ignores
 * routes and always goes through the tunnel explicitly.
 */
export type SwTunnelConfig = CreateTunnelOptions & {
  /** Same-origin path prefixes to intercept; defaults to DEFAULT_SW_ROUTES. */
  routes?: string[];
};

/** Page → worker: register (or replace) the tunnel held by the worker. */
export interface SwRegisterMessage {
  type: "wt/register";
  config: SwTunnelConfig;
}

/** Page → worker: run one request through the tunnel explicitly. */
export interface SwFetchMessage {
  type: "wt/fetch";
  id: number;
  url: string;
  method?: string;
  headers?: [string, string][];
  body?: ArrayBuffer | null;
}

export type SwPageMessage = SwRegisterMessage | SwFetchMessage;

/** Worker → page: registration accepted. */
export interface SwRegisteredMessage {
  type: "wt/registered";
}

/** Worker → page: explicit-fetch result (body is transferred, not copied). */
export interface SwFetchResultMessage {
  type: "wt/fetch-result";
  id: number;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
}

/** Worker → page: registration or explicit-fetch failure. */
export interface SwErrorMessage {
  type: "wt/error";
  /** Present for `wt/fetch` failures so the page can match the request. */
  id?: number;
  message: string;
}

export type SwReplyMessage = SwRegisteredMessage | SwFetchResultMessage | SwErrorMessage;

/** Serialized response parts crossing the page ⇄ worker boundary. */
export interface SwResponseParts {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
}

/** Request as seen by the worker-side fetch logic (test-friendly shape). */
export interface SwFetchInput {
  url: string;
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

export type SwFetchOutcome =
  | { action: "passthrough" }
  | { action: "respond"; response: Response };

/** Factory used by the worker-side controller (defaults to the real one). */
export type SwTunnelFactory = (options: CreateTunnelOptions) => Promise<Tunnel> | Tunnel;

/** Reply callback abstracting MessagePort / Client delivery (test seam). */
export type SwReplyFn = (message: SwReplyMessage, transfer?: Transferable[]) => void;

/**
 * Validate route prefixes: each must be a same-origin path prefix.
 * Returns a copy; `undefined` selects the default routes.
 */
export function normalizeSwRoutes(routes: readonly string[] | undefined): string[] {
  const list = routes === undefined ? [...DEFAULT_SW_ROUTES] : [...routes];
  for (const route of list) {
    if (typeof route !== "string" || !route.startsWith("/")) {
      throw new Error(
        `invalid SW route (must be a same-origin path prefix): ${JSON.stringify(route)}`,
      );
    }
  }
  return list;
}

/**
 * Map a same-origin request URL to its in-tunnel target: the first matching
 * route prefix is stripped and the remainder (+ query, without the fragment)
 * must parse as an absolute `http://` URL. Returns `null` for cross-origin
 * URLs, unmatched paths, and unparseable / non-http remainders.
 */
export function resolveTunnelTarget(
  requestUrl: string,
  scopeOrigin: string,
  routes: readonly string[],
): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== scopeOrigin) return null;
  for (const route of routes) {
    if (!parsed.pathname.startsWith(route)) continue;
    const remainder = `${parsed.pathname.slice(route.length)}${parsed.search}`;
    if (!remainder) return null;
    let target: URL;
    try {
      target = new URL(remainder);
    } catch {
      return null;
    }
    if (target.protocol !== "http:") return null;
    return target;
  }
  return null;
}

/** Serialize a tunnel Response into transferable parts for the page. */
export async function tunnelResponseToParts(response: Response): Promise<SwResponseParts> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, key) => {
    headers.push([key, value]);
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.arrayBuffer(),
  };
}

/** Rebuild a page-side Response from worker-supplied parts. */
export function swPartsToResponse(parts: SwResponseParts): Response {
  const hasBody =
    parts.body.byteLength > 0 && parts.status !== 204 && parts.status !== 205 && parts.status !== 304;
  return new Response(hasBody ? parts.body : null, {
    status: parts.status,
    statusText: parts.statusText,
    headers: parts.headers,
  });
}

/** Synthetic plain-text error Response for the fetch-event path. */
export function swErrorResponse(status: 502 | 503, message: string): Response {
  return new Response(`wasm-tunnel: ${message}`, {
    status,
    statusText: status === 502 ? "Bad Gateway" : "Service Unavailable",
    headers: { "content-type": "text/plain;charset=utf-8" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalize `TunnelRequestInit` headers to ordered pairs. */
function headersToPairs(headers: HeadersInit | undefined): [string, string][] {
  const pairs: [string, string][] = [];
  new Headers(headers).forEach((value, key) => {
    pairs.push([key, value]);
  });
  return pairs;
}

/** Normalize a `tunnel.fetch`-style body to a transferable buffer (or null). */
function bodyToBuffer(body: TunnelRequestInit["body"]): ArrayBuffer | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return new TextEncoder().encode(body).buffer as ArrayBuffer;
  const view = body instanceof Uint8Array ? body : new Uint8Array(body);
  return view.byteLength > 0 ? view.slice().buffer as ArrayBuffer : null;
}

/**
 * Worker-side controller: holds the tunnel, matches routes, and serves both
 * the `fetch` event path and the explicit message RPC. Construct one per
 * worker global (see `./sw-worker`); all methods are environment-neutral and
 * unit-testable with a fake factory.
 */
export class SwTunnelController {
  private tunnel: Tunnel | null = null;
  private routes: string[] = [];

  constructor(private readonly factory: SwTunnelFactory) {}

  get isRegistered(): boolean {
    return this.tunnel !== null;
  }

  /**
   * Validate the config, create the tunnel (replacing any previous one), and
   * remember the routes. Resolves with the active route list.
   */
  async register(config: SwTunnelConfig): Promise<string[]> {
    if (!isRecord(config)) {
      throw new Error("SW tunnel config must be an object");
    }
    if (config["protocol"] !== "vless" && config["protocol"] !== "shadowsocks") {
      throw new Error(
        `unsupported SW tunnel protocol: ${JSON.stringify(config["protocol"])} (expected "vless" or "shadowsocks")`,
      );
    }
    const routes = normalizeSwRoutes(config["routes"] as readonly string[] | undefined);
    const { routes: _ignored, ...tunnelOptions } = config as SwTunnelConfig & {
      routes?: unknown;
    };
    const tunnel = await this.factory(tunnelOptions);
    this.closeCurrent();
    this.tunnel = tunnel;
    this.routes = routes;
    return [...routes];
  }

  /** Drop the tunnel (closing its sockets) and forget the routes. */
  unregister(): void {
    this.closeCurrent();
    this.tunnel = null;
    this.routes = [];
  }

  /**
   * Synchronous route check for the worker's `fetch` listener: returns the
   * in-tunnel target when the URL should be intercepted, `null` when the
   * request must pass through untouched.
   */
  match(requestUrl: string, scopeOrigin: string): URL | null {
    return resolveTunnelTarget(requestUrl, scopeOrigin, this.activeRoutes());
  }

  /**
   * Fetch-event logic: unmatched requests pass through; matched requests go
   * via the tunnel (503 when no tunnel is registered, 502 when it fails).
   * Never rejects for matched requests — failures become Responses.
   */
  async handleFetch(input: SwFetchInput, scopeOrigin: string): Promise<SwFetchOutcome> {
    const target = this.match(input.url, scopeOrigin);
    if (!target) return { action: "passthrough" };
    if (!this.tunnel) {
      return {
        action: "respond",
        response: swErrorResponse(
          503,
          "no tunnel registered in the service worker; call installTunnelServiceWorker() from the page first",
        ),
      };
    }
    try {
      const response = await this.fetchDirect(target, input);
      return { action: "respond", response };
    } catch (error) {
      return { action: "respond", response: swErrorResponse(502, errorMessage(error)) };
    }
  }

  /**
   * Message-event logic: serves `wt/register` and `wt/fetch`, replying via
   * `reply` (transfer carries the fetch-result body). Foreign messages are
   * ignored. Never rejects — failures are reported as `wt/error` replies.
   */
  async handleMessage(data: unknown, scopeOrigin: string, reply: SwReplyFn): Promise<void> {
    if (!isRecord(data) || typeof data.type !== "string") return;
    switch (data.type) {
      case "wt/register": {
        try {
          await this.register(data["config"] as SwTunnelConfig);
          reply({ type: "wt/registered" });
        } catch (error) {
          reply({ type: "wt/error", message: errorMessage(error) });
        }
        return;
      }
      case "wt/fetch": {
        const id = typeof data["id"] === "number" ? data["id"] : 0;
        try {
          const parts = await this.fetchParts(data, scopeOrigin);
          reply(
            {
              type: "wt/fetch-result",
              id,
              status: parts.status,
              statusText: parts.statusText,
              headers: parts.headers,
              body: parts.body,
            },
            [parts.body],
          );
        } catch (error) {
          reply({ type: "wt/error", id, message: errorMessage(error) });
        }
        return;
      }
      default:
        return;
    }
  }

  private activeRoutes(): string[] {
    return this.tunnel ? [...this.routes] : [...DEFAULT_SW_ROUTES];
  }

  private closeCurrent(): void {
    try {
      this.tunnel?.close();
    } catch {
      // sockets may already be closed; nothing to do
    }
  }

  private fetchDirect(target: string | URL, input: SwFetchInput): Promise<Response> {
    const tunnel = this.tunnel;
    if (!tunnel) {
      throw new Error(
        "no tunnel registered in the service worker; call installTunnelServiceWorker() from the page first",
      );
    }
    return tunnel.fetch(target, {
      method: input.method,
      headers: input.headers,
      body:
        input.body !== null && input.body.byteLength > 0 ? new Uint8Array(input.body) : null,
    });
  }

  private async fetchParts(data: Record<string, unknown>, scope: string): Promise<SwResponseParts> {
    void scope;
    if (typeof data["url"] !== "string" || !data["url"]) {
      throw new Error("wt/fetch message requires a string url");
    }
    const method = data["method"] === undefined ? "GET" : data["method"];
    if (typeof method !== "string") throw new Error("wt/fetch message requires a string method");
    if (data["headers"] !== undefined && !Array.isArray(data["headers"])) {
      throw new Error("wt/fetch message requires headers as [name, value] pairs");
    }
    if (data["body"] !== undefined && data["body"] !== null && !(data["body"] instanceof ArrayBuffer)) {
      throw new Error("wt/fetch message requires body as ArrayBuffer or null");
    }
    // Explicit opt-in per call: no route matching — the page asked for the
    // tunnel directly. Target validation (http:// only) happens in the tunnel.
    const response = await this.fetchDirect(data["url"], {
      url: data["url"],
      method,
      headers: (data["headers"] as [string, string][] | undefined) ?? [],
      body: (data["body"] as ArrayBuffer | null | undefined) ?? null,
    });
    return tunnelResponseToParts(response);
  }
}

// ---------------------------------------------------------------------------
// Page side
// ---------------------------------------------------------------------------

const SW_ACK_TIMEOUT_MS = 10_000;
const SW_FETCH_TIMEOUT_MS = 60_000;
const SW_CONTROLLER_WAIT_MS = 5_000;

let swRequestId = 0;

interface SwPostTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

function swPageError(message: string): Error {
  return new Error(message);
}

/** Post one message over a fresh MessageChannel and await its single reply. */
function postSwRequest(
  target: SwPostTarget,
  message: SwPageMessage,
  timeoutMs: number,
): Promise<SwReplyMessage> {
  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(swPageError(`service worker request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data as SwReplyMessage);
    };
    try {
      target.postMessage(message, [channel.port2]);
    } catch (error) {
      clearTimeout(timer);
      channel.port1.close();
      reject(swPageError(`could not reach the service worker: ${errorMessage(error)}`));
    }
  });
}

function pageServiceWorker(): ServiceWorkerContainer {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    throw swPageError("service workers are not supported in this browser");
  }
  return navigator.serviceWorker;
}

/** Wait for the worker to take control of the page (after install+claim). */
async function awaitSwController(timeoutMs: number): Promise<ServiceWorker> {
  const container = pageServiceWorker();
  if (container.controller) return container.controller;
  const controller = await new Promise<ServiceWorker | null>((resolve) => {
    const timer = setTimeout(() => {
      container.removeEventListener("controllerchange", onChange);
      resolve(container.controller);
    }, timeoutMs);
    const onChange = (): void => {
      clearTimeout(timer);
      container.removeEventListener("controllerchange", onChange);
      resolve(container.controller);
    };
    container.addEventListener("controllerchange", onChange);
  });
  if (!controller) {
    throw swPageError(
      "no active service worker controller; call installTunnelServiceWorker() first (and reload the page if the worker has not claimed it yet)",
    );
  }
  return controller;
}

export interface InstallTunnelServiceWorkerOptions {
  /** Tunnel + routes to register inside the worker. */
  config: SwTunnelConfig;
  /** Worker scope; defaults to the script's directory. */
  scope?: string;
  /** Registration-ack timeout in ms; default 10000. */
  timeoutMs?: number;
}

/**
 * Register the tunnel Service Worker script and hand it the tunnel config.
 * Resolves with the registration once the worker acknowledges; the worker
 * (shipped as a single classic script — see `./sw-worker`) then holds the
 * tunnel. Re-registering replaces the tunnel. Call again after a worker
 * update, since the config lives in worker memory only.
 */
export async function installTunnelServiceWorker(
  scriptUrl: string,
  options: InstallTunnelServiceWorkerOptions,
): Promise<ServiceWorkerRegistration> {
  const container = pageServiceWorker();
  const registration = await container.register(
    scriptUrl,
    options.scope !== undefined ? { scope: options.scope } : undefined,
  );
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) {
    throw swPageError("service worker registration produced no worker");
  }
  const reply = await postSwRequest(
    worker,
    { type: "wt/register", config: options.config },
    options.timeoutMs ?? SW_ACK_TIMEOUT_MS,
  );
  if (reply.type === "wt/error") {
    throw swPageError(`service worker rejected the tunnel config: ${reply.message}`);
  }
  if (reply.type !== "wt/registered") {
    throw swPageError(`service worker sent an unexpected reply: ${JSON.stringify(reply)}`);
  }
  return registration;
}

export interface TunnelFetchOptions extends TunnelRequestInit {
  /** Reply timeout in ms; default 60000 (the tunnel's own timeout applies). */
  timeoutMs?: number;
}

/**
 * Run one request through the tunnel held by the Service Worker and resolve
 * with a real Response. Explicit opt-in per call — unmatched page fetches
 * are never affected. Rejects when there is no controlling worker, on
 * timeout, or when the worker reports a tunnel failure.
 */
export async function tunnelFetch(
  input: string | URL,
  init: TunnelFetchOptions = {},
): Promise<Response> {
  const controller = await awaitSwController(SW_CONTROLLER_WAIT_MS);
  const id = (swRequestId += 1);
  const reply = await postSwRequest(
    controller,
    {
      type: "wt/fetch",
      id,
      url: input.toString(),
      method: init.method ?? "GET",
      headers: headersToPairs(init.headers),
      body: bodyToBuffer(init.body ?? null),
    },
    init.timeoutMs ?? SW_FETCH_TIMEOUT_MS,
  );
  if (reply.type === "wt/error") {
    throw swPageError(`tunnel request via service worker failed: ${reply.message}`);
  }
  if (reply.type !== "wt/fetch-result" || reply.id !== id) {
    throw swPageError(
      `service worker sent an unexpected reply: ${JSON.stringify({ ...reply, body: "…" })}`,
    );
  }
  return swPartsToResponse(reply);
}
