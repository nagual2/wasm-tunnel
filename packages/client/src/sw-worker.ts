/**
 * Service Worker entry for wasm-tunnel: holds the tunnel inside the worker
 * and serves page requests (see `./sw` for the protocol).
 *
 * This is a classic (non-module) worker script. It is bundled dependency-free
 * into a single file served as `sw.js` next to the page:
 *
 *   npx esbuild src/sw-worker.ts --bundle --format=iife --minify \
 *     --outfile=../../apps/demo/public/sw.js
 *
 * Install + activate fast so the page gets a controller without a reload;
 * tunnel config lives in worker memory and must be (re-)registered from the
 * page via `installTunnelServiceWorker()` after every worker update.
 *
 * NOTE: this file declares its own minimal worker-global types (below) so it
 * typechecks under the client tsconfig, which ships no @types packages.
 */

import { createTunnel } from "./create-tunnel";
import { SwTunnelController, type SwFetchInput } from "./sw";

interface SwExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwMessagePortLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

interface SwExtendableMessageEvent {
  data: unknown;
  ports: MessagePort[];
}

interface SwFetchEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

interface SwWorkerGlobal {
  location: { origin: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: SwExtendableEvent) => void): void;
  addEventListener(type: "message", listener: (event: SwExtendableMessageEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: SwFetchEvent) => void): void;
  fetch(input: RequestInfo | URL): Promise<Response>;
}

declare const self: SwWorkerGlobal;

const controller = new SwTunnelController((options) => createTunnel(options));

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const port: SwMessagePortLike | undefined = event.ports[0];
  if (!port) return;
  void controller.handleMessage(event.data, self.location.origin, (reply, transfer) => {
    port.postMessage(reply, transfer ?? []);
  });
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  event.respondWith(
    (async (): Promise<Response> => {
      let body: ArrayBuffer | null = null;
      if (request.method !== "GET" && request.method !== "HEAD") {
        try {
          const buffer = await request.arrayBuffer();
          body = buffer.byteLength > 0 ? buffer : null;
        } catch {
          body = null;
        }
      }
      const headers: [string, string][] = [];
      request.headers.forEach((value: string, key: string) => {
        headers.push([key, value]);
      });
      const input: SwFetchInput = { url: request.url, method: request.method, headers, body };
      const outcome = await controller.handleFetch(input, self.location.origin);
      if (outcome.action === "passthrough") return self.fetch(request);
      return outcome.response;
    })(),
  );
});
