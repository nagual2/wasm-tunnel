/**
 * End-to-end test against the local docker node:
 *   1. cp .env.example .env   (or export the vars)
 *   2. docker compose up -d
 *   3. npm run test:e2e
 *
 * Uses the Node.js built-in WebSocket (Node >= 22) with the same client code
 * that runs in the browser.
 */

import { readFileSync } from "node:fs";
import { createVlessWsTunnel } from "../packages/client/src/index";
import { createSsWsTunnel } from "../packages/client/src/protocols/shadowsocks";

function loadDotEnv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env file; rely on process.env
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    const key = match?.[1];
    if (key && !(key in process.env)) {
      process.env[key] = (match?.[2] ?? "").replace(/^["']|["']$/g, "");
    }
  }
}

interface E2eConfig {
  wsHost: string;
  wsPort: number;
  wsPath: string;
  uuid: string;
  tls: boolean;
  target: string;
  targetV6: string;
  ssPassword: string | undefined;
  ssMethod: string;
  ssPort: number;
  ssPath: string;
}

function readConfig(): E2eConfig {
  loadDotEnv();
  const uuid = process.env.VLESS_UUID ?? process.env.XRAY_UUID;
  if (!uuid) {
    console.error("e2e: no UUID — set VLESS_UUID/XRAY_UUID (see .env.example)");
    process.exit(2);
  }
  return {
    wsHost: process.env.TUNNEL_WS_HOST ?? "127.0.0.1",
    wsPort: Number(process.env.TUNNEL_WS_PORT ?? process.env.XRAY_PORT ?? 8080),
    wsPath: process.env.TUNNEL_WS_PATH ?? process.env.WS_PATH ?? "/tunnel",
    uuid,
    tls: (process.env.TUNNEL_TLS ?? "false") === "true",
    target: process.env.TUNNEL_TARGET_URL ?? "http://echo:8081/e2e",
    targetV6: process.env.TUNNEL_TARGET_URL_V6 ?? "http://[fd2c:4a98:9a2b::10]:8081/e2e",
    ssPassword: process.env.SS_PASSWORD,
    ssMethod: process.env.SS_METHOD ?? "aes-256-gcm",
    ssPort: Number(process.env.SS_PORT ?? 8082),
    ssPath: process.env.SS_PATH ?? "/ss",
  };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function fetchWithRetry(
  tunnel: ReturnType<typeof createVlessWsTunnel>,
  attempt: () => Promise<void>,
  tries = 8,
  delayMs = 1500,
): Promise<void> {
  for (let i = 1; i <= tries; i++) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (i === tries) throw error;
      console.log(
        `attempt ${i}/${tries} failed (${error instanceof Error ? error.message : error}); retrying in ${delayMs} ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  console.log(
    `e2e: node ${config.tls ? "wss" : "ws"}://${config.wsHost}:${config.wsPort}${config.wsPath}, target ${config.target}`,
  );
  const tunnel = createVlessWsTunnel({
    host: config.wsHost,
    port: config.wsPort,
    path: config.wsPath,
    uuid: config.uuid,
    tls: config.tls,
    timeoutMs: 15_000,
  });

  try {
    // 1. GET round-trip through the tunnel
    const target = new URL(config.target);
    target.searchParams.set("probe", String(Date.now()));
    const started = Date.now();
    let response: Response | undefined;
    let body: Record<string, unknown> | null = null;
    await fetchWithRetry(tunnel, async () => {
      const current = await tunnel.fetch(target);
      body = (await current.json()) as Record<string, unknown>;
      response = current;
    });
    const first = response;
    if (!first) throw new Error("no response");
    assert(first.status === 200, `expected 200, got ${first.status}`);
    assert(body && body["method"] === "GET", `echo method mismatch: ${JSON.stringify(body)}`);
    assert(
      body && typeof body["path"] === "string" && (body["path"] as string).startsWith(target.pathname),
      `echo path mismatch: ${JSON.stringify(body)}`,
    );
    console.log(`GET  ok  status=200 bytes=${JSON.stringify(body).length} in ${Date.now() - started} ms`);

    // 2. POST round-trip with a JSON body
    const payload = JSON.stringify({ hello: "tunnel", at: new Date().toISOString() });
    const postResponse = await tunnel.fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const postBody = (await postResponse.json()) as Record<string, unknown>;
    assert(postResponse.status === 200, `POST expected 200, got ${postResponse.status}`);
    assert(
      postBody && postBody["body"] === payload,
      `POST body mismatch: ${JSON.stringify(postBody)}`,
    );
    console.log("POST ok  status=200 body round-trip matches");

    // 3. IPv6 target inside the tunnel (static ULA address of the echo container)
    const targetV6 = new URL(config.targetV6);
    targetV6.searchParams.set("probe", String(Date.now()));
    const v6Response = await tunnel.fetch(targetV6);
    const v6Body = (await v6Response.json()) as Record<string, unknown>;
    assert(v6Response.status === 200, `v6 target expected 200, got ${v6Response.status}`);
    assert(
      v6Body && v6Body["method"] === "GET",
      `v6 echo method mismatch: ${JSON.stringify(v6Body)}`,
    );
    console.log(`GET6 ok  status=200 target=${targetV6.hostname}`);

    // 4. Node reachable over IPv6: bare "::1" exercises bracket normalization.
    try {
      const tunnelV6Node = createVlessWsTunnel({
        host: "::1",
        port: config.wsPort,
        path: config.wsPath,
        uuid: config.uuid,
        tls: config.tls,
        timeoutMs: 10_000,
      });
      const v6NodeResponse = await tunnelV6Node.fetch(target);
      assert(v6NodeResponse.status === 200, `v6 node expected 200, got ${v6NodeResponse.status}`);
      await v6NodeResponse.text();
      console.log("WS6  ok  node WebSocket over IPv6 loopback");
      tunnelV6Node.close();
    } catch (error) {
      if (error instanceof Error && /tunnel WebSocket error/.test(error.message)) {
        console.log("WS6  SKIP host cannot reach the node over IPv6 (environment limitation)");
      } else {
        throw error;
      }
    }

    // 4. Shadowsocks (AEAD) over its own WS inbound, same echo target
    if (!config.ssPassword) {
      console.log("SS   SKIP no SS_PASSWORD in environment");
    } else {
      const ssTunnel = createSsWsTunnel({
        host: config.wsHost,
        port: config.ssPort,
        path: config.ssPath,
        password: config.ssPassword,
        method: config.ssMethod as "aes-128-gcm" | "aes-256-gcm",
        timeoutMs: 15_000,
      });
      try {
        const ssTarget = new URL(config.target);
        ssTarget.searchParams.set("probe", String(Date.now()));
        const ssStarted = Date.now();
        await fetchWithRetry(ssTunnel, async () => {
          const r = await ssTunnel.fetch(ssTarget);
          const b = (await r.json()) as Record<string, unknown>;
          assert(r.status === 200, `SS GET expected 200, got ${r.status}`);
          assert(b["method"] === "GET", `SS echo method mismatch: ${JSON.stringify(b)}`);
        });
        const ssPost = await ssTunnel.fetch(ssTarget, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        const ssPostBody = (await ssPost.json()) as Record<string, unknown>;
        assert(ssPost.status === 200, `SS POST expected 200, got ${ssPost.status}`);
        assert(ssPostBody["body"] === payload, `SS POST body mismatch: ${JSON.stringify(ssPostBody)}`);
        console.log(`SS   ok  GET+POST via aes AEAD in ${Date.now() - ssStarted} ms`);
      } finally {
        ssTunnel.close();
      }
    }

    console.log("E2E OK");
  } finally {
    tunnel.close();
  }
}

main().catch((error: unknown) => {
  console.error("E2E FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
