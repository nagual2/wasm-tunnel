/**
 * Tests for the Service Worker interceptor protocol (page ⇄ worker messages,
 * route matching, fetch forwarding, synthetic error Responses). The real
 * Service Worker runtime is never touched: the page side (`MessageChannel`)
 * is mocked, and the worker side runs through `SwTunnelController` with a
 * fake tunnel factory.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SW_ROUTES,
  normalizeSwRoutes,
  resolveTunnelTarget,
  swErrorResponse,
  SwTunnelController,
  swPartsToResponse,
  tunnelResponseToParts,
} from "../src/sw";
import type { CreateTunnelOptions } from "../src/create-tunnel";
import type { SwFetchInput, SwReplyMessage, SwTunnelConfig, SwTunnelFactory } from "../src/sw";
import type { Tunnel } from "../src/tunnel";

const ORIGIN = "https://demo.example";

function vlessConfig(overrides: Partial<SwTunnelConfig> = {}): SwTunnelConfig {
  return {
    protocol: "vless",
    host: "127.0.0.1",
    port: 8080,
    path: "/tunnel",
    uuid: "9f6c2b1e-4a7d-4c83-b5e1-2d3f4a5b6c7d",
    ...overrides,
  } as SwTunnelConfig;
}

function fakeTunnel(behavior: Partial<Tunnel> = {}): Tunnel {
  return {
    fetch: async () => new Response("ok", { status: 200 }),
    close: () => undefined,
    ...behavior,
  };
}

function controllerFor(tunnel: Tunnel): {
  controller: SwTunnelController;
  seenOptions: CreateTunnelOptions[];
} {
  const seenOptions: CreateTunnelOptions[] = [];
  const factory: SwTunnelFactory = (options) => {
    seenOptions.push(options);
    return tunnel;
  };
  const controller = new SwTunnelController(factory);
  return { controller, seenOptions };
}

function inputFor(path: string, method = "GET", body: ArrayBuffer | null = null): SwFetchInput {
  return { url: `${ORIGIN}${path}`, method, headers: [], body };
}

async function register(controller: SwTunnelController, config: SwTunnelConfig): Promise<void> {
  await controller.register(config);
}

describe("normalizeSwRoutes", () => {
  it("defaults to the /tunnel/ prefix when no routes are given", () => {
    expect(normalizeSwRoutes(undefined)).toEqual([...DEFAULT_SW_ROUTES]);
    expect(DEFAULT_SW_ROUTES).toEqual(["/tunnel/"]);
  });

  it("rejects non same-origin-path prefixes", () => {
    expect(() => normalizeSwRoutes(["https://other/p/"])).toThrow(/same-origin path prefix/);
    expect(() => normalizeSwRoutes(["no-slash"])).toThrow(/same-origin path prefix/);
  });
});

describe("resolveTunnelTarget", () => {
  const routes = ["/tunnel/"];

  it("maps a matching same-origin path to the in-tunnel target", () => {
    const target = resolveTunnelTarget(
      `${ORIGIN}/tunnel/http://echo:8081/items?page=2`,
      ORIGIN,
      routes,
    );
    expect(target?.href).toBe("http://echo:8081/items?page=2");
  });

  it("passes through cross-origin requests and unmatched paths", () => {
    expect(resolveTunnelTarget("https://other.example/x", ORIGIN, routes)).toBeNull();
    expect(resolveTunnelTarget(`${ORIGIN}/other/x`, ORIGIN, routes)).toBeNull();
  });

  it("rejects non-http remainders", () => {
    expect(resolveTunnelTarget(`${ORIGIN}/tunnel/not-a-url`, ORIGIN, routes)).toBeNull();
    expect(resolveTunnelTarget(`${ORIGIN}/tunnel/https://x/`, ORIGIN, routes)).toBeNull();
  });
});

describe("SwTunnelController.handleFetch", () => {
  it("passes through unmatched requests untouched", async () => {
    const { controller } = controllerFor(fakeTunnel());
    await register(controller, vlessConfig());
    const outcome = await controller.handleFetch(inputFor("/other/x"), ORIGIN);
    expect(outcome).toEqual({ action: "passthrough" });
  });

  it("forwards matched GET requests with headers and status preserved", async () => {
    const seen: { target: unknown; init: unknown }[] = [];
    const tunnel = fakeTunnel({
      fetch: async (target: string | URL, init = {}) => {
        seen.push({ target: target.toString(), init });
        return new Response("hello", {
          status: 201,
          statusText: "Created",
          headers: { "x-echo": "1" },
        });
      },
    });
    const { controller } = controllerFor(tunnel);
    await register(controller, vlessConfig());
    const outcome = await controller.handleFetch(
      { ...inputFor("/tunnel/http://echo:8081/hi"), headers: [["x-req", "a"]] },
      ORIGIN,
    );
    expect(outcome.action).toBe("respond");
    if (outcome.action !== "respond") return;
    expect(outcome.response.status).toBe(201);
    expect(outcome.response.headers.get("x-echo")).toBe("1");
    expect(await outcome.response.text()).toBe("hello");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target).toBe("http://echo:8081/hi");
  });

  it("forwards POST bodies through the tunnel", async () => {
    let receivedBody: unknown;
    const tunnel = fakeTunnel({
      fetch: async (_target: string | URL, init = {}) => {
        receivedBody = init.body;
        return new Response("ok");
      },
    });
    const { controller } = controllerFor(tunnel);
    await register(controller, vlessConfig());
    const body = new TextEncoder().encode('{"k":1}').buffer as ArrayBuffer;
    const outcome = await controller.handleFetch(
      { ...inputFor("/tunnel/http://echo:8081/echo", "POST", body) },
      ORIGIN,
    );
    expect(outcome.action).toBe("respond");
    expect(receivedBody).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(receivedBody as Uint8Array)).toBe('{"k":1}');
  });

  it("answers 503 when no tunnel is registered and 502 on tunnel failure", async () => {
    const { controller } = controllerFor(fakeTunnel());
    const unregistered = await controller.handleFetch(
      inputFor("/tunnel/http://echo:8081/x"),
      ORIGIN,
    );
    expect(unregistered.action).toBe("respond");
    if (unregistered.action !== "respond") return;
    expect(unregistered.response.status).toBe(503);

    const failing = fakeTunnel({
      fetch: async () => {
        throw new Error("boom");
      },
    });
    const bad = controllerFor(failing).controller;
    await register(bad, vlessConfig());
    const outcome = await bad.handleFetch(inputFor("/tunnel/http://echo:8081/x"), ORIGIN);
    expect(outcome.action).toBe("respond");
    if (outcome.action !== "respond") return;
    expect(outcome.response.status).toBe(502);
    expect(await outcome.response.text()).toContain("boom");
  });
});

describe("SwTunnelController.handleMessage", () => {
  it("registers via message and reports wt/registered", async () => {
    const { controller, seenOptions } = controllerFor(fakeTunnel());
    const replies: SwReplyMessage[] = [];
    await controller.handleMessage(
      { type: "wt/register", config: vlessConfig({ routes: ["/t/"] }) },
      ORIGIN,
      (message) => replies.push(message),
    );
    expect(replies).toEqual([{ type: "wt/registered" }]);
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]).not.toHaveProperty("routes");
    expect(controller.isRegistered).toBe(true);
  });

  it("reports wt/error for unsupported protocols and unknown messages", async () => {
    const { controller } = controllerFor(fakeTunnel());
    const replies: SwReplyMessage[] = [];
    await controller.handleMessage(
      { type: "wt/register", config: { protocol: "trojan" } },
      ORIGIN,
      (message) => replies.push(message),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.type).toBe("wt/error");
    expect(controller.isRegistered).toBe(false);

    const foreign: SwReplyMessage[] = [];
    await controller.handleMessage({ type: "other/thing" }, ORIGIN, (message) =>
      foreign.push(message),
    );
    expect(foreign).toEqual([]);
  });

  it("serves explicit wt/fetch with transferred body and matching id", async () => {
    const { controller } = controllerFor(
      fakeTunnel({
        fetch: async () => new Response("payload", { status: 200, headers: { "x-a": "b" } }),
      }),
    );
    await register(controller, vlessConfig());
    const replies: SwReplyMessage[] = [];
    const transfers: Transferable[][] = [];
    await controller.handleMessage(
      { type: "wt/fetch", id: 7, url: "http://echo:8081/x", method: "GET" },
      ORIGIN,
      (message, transfer) => {
        replies.push(message);
        transfers.push(transfer ?? []);
      },
    );
    expect(replies).toHaveLength(1);
    const reply = replies[0];
    expect(reply?.type).toBe("wt/fetch-result");
    if (reply?.type !== "wt/fetch-result") return;
    expect(reply.id).toBe(7);
    expect(reply.status).toBe(200);
    expect(reply.headers).toContainEqual(["x-a", "b"]);
    expect(new TextDecoder().decode(reply.body)).toBe("payload");
    expect(transfers[0]).toHaveLength(1);
  });

  it("reports wt/error with id when the tunnel fails", async () => {
    const { controller } = controllerFor(
      fakeTunnel({
        fetch: async () => {
          throw new Error("node down");
        },
      }),
    );
    await register(controller, vlessConfig());
    const replies: SwReplyMessage[] = [];
    await controller.handleMessage(
      { type: "wt/fetch", id: 3, url: "http://echo:8081/x" },
      ORIGIN,
      (message) => replies.push(message),
    );
    expect(replies).toEqual([{ type: "wt/error", id: 3, message: "node down" }]);
  });
});

describe("response helpers", () => {
  it("round-trips a tunnel Response through transferable parts", async () => {
    const original = new Response("data", { status: 202, headers: { "x-k": "v" } });
    const parts = await tunnelResponseToParts(original);
    const rebuilt = swPartsToResponse(parts);
    expect(rebuilt.status).toBe(202);
    expect(rebuilt.headers.get("x-k")).toBe("v");
    expect(await rebuilt.text()).toBe("data");
  });

  it("builds a plain-text 502 synthetic error", async () => {
    const response = swErrorResponse(502, "node down");
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toContain("wasm-tunnel: node down");
  });
});
