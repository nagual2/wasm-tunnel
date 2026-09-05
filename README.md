# wasm-tunnel

Browser-first **tunnel client** for application HTTP traffic: a web page (or
extension) opens a WebSocket to **your own self-hosted node** and sends HTTP
requests through it. No TUN/TAP, no OS routing, no system VPN — the tunnel
lives entirely inside the page.

```
┌─────────────┐  wss/ws   ┌────────────────────┐  plain TCP  ┌──────────────┐
│ Browser     │──────────▶│ Node (Docker)      │────────────▶│ Target (http)│
│ TS client   │  VLESS /  │ Xray-core inbound  │             │ e.g. echo    │
│             │  SS AEAD  │                    │             │              │
└─────────────┘           └────────────────────┘             └──────────────┘
```

- **Thin client**: protocol framing in pure TypeScript; crypto comes from the
  platform (SubtleCrypto). The demo bundle is a few kB gzipped, protocols load
  lazily and independently.
- **Multi-protocol**: VLESS and Shadowsocks (AEAD) today, behind one API —
  `createTunnel({ protocol })` — with per-protocol subpath exports so unused
  protocols never reach your bundle.
- **Dual-stack IPv6** for the node connection and for targets, verified by e2e.
- **Self-hosted node for tests**: official Xray-core in Docker, one command up.

## Quickstart (5 minutes)

Prerequisites: Docker, Node.js ≥ 22.

```bash
# 1. Configure the test node
cp .env.example .env        # generate secrets:
                            #   node -e "console.log(crypto.randomUUID())"
                            #   node -e "console.log(crypto.randomBytes(16).toString('base64url'))"

# 2. Start the node + echo server
docker compose up -d

# 3. Install and run the demo
npm ci
npm run dev                 # http://localhost:5173
```

Open http://localhost:5173, pick a protocol, press **Request via tunnel**.
Defaults point the demo at `ws://127.0.0.1:8080/tunnel` (VLESS) or
`ws://127.0.0.1:8082/ss` (Shadowsocks) and the target `http://echo:8081/…` —
the `echo` name is resolved by the node inside the Docker network, so the
browser cannot reach it directly: every byte really goes through the tunnel.

## Library API

```ts
import { createVlessWsTunnel } from "wasm-tunnel-client";

const tunnel = createVlessWsTunnel({
  host: "127.0.0.1",     // node WebSocket host
  port: 8080,            // default: 443 with tls, 80 without
  uuid: "<VLESS-UUID>",
  path: "/tunnel",       // WebSocket path (may include ?ed=…)
  tls: false,            // true → wss://
  timeoutMs: 30_000,
});

const response = await tunnel.fetch("http://echo:8081/hello", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ hello: "tunnel" }),
});
console.log(response.status, await response.text());
tunnel.close();
```

`tunnel.fetch()` returns a standard `Response`, so `.json()`, `.text()` and
friends work as usual. Limitations: `http://` targets only (in-tunnel TLS for
`https://` targets is on the roadmap), one request per WebSocket connection.

### Protocols

The default entry contains the core + VLESS only. Other protocols live behind
subpath exports and load lazily — consumers never ship a protocol they did
not import:

```ts
// direct (tree-shakable):
import { createSsWsTunnel } from "wasm-tunnel-client/shadowsocks";
const ss = createSsWsTunnel({ host: "127.0.0.1", port: 8082, path: "/ss",
                              password: "…", method: "aes-256-gcm" });

// or the generic lazy factory:
import { createTunnel } from "wasm-tunnel-client/create-tunnel";
const tunnel = await createTunnel({ protocol: "shadowsocks", /* … */ });
```

Adding a protocol means implementing one seam — a `ProtocolSession` that
encodes the handshake + initial payload and decodes the reply framing. The
WebSocket transport and the HTTP-over-stream layer are protocol-agnostic and
shared.

Shadowsocks notes: `aes-128-gcm` / `aes-256-gcm` via native SubtleCrypto
(ChaCha20 variants would need a JS cipher — not planned); the node must
expose SS over a WebSocket transport (the bundled Xray does), since raw-TCP
sockets are unreachable from a browser page.

### Adding your own protocol

1. Create `src/protocols/<name>.ts` exporting a `create<Name>Tunnel(options)`
   factory built on `makeWsTunnel(options, openStream)`.
2. `openStream(target)` returns a `ProtocolSession`: `firstMessage(initial)`
   folds the handshake and the initial HTTP request bytes into the first
   transport message; `inbound(chunk)` strips the reply framing.
3. Register it in `src/create-tunnel.ts` and add a subpath export in the
   package manifest if it should be lazy-loadable.

## IPv6

IPv6 works on equal footing with IPv4 in both planes:

- **Targets inside the tunnel** — IPv6 literals (`http://[2001:db8::1]:8080/`)
  and domains with AAAA records; the node resolves and dials them itself.
- **Node host outside** — IPv6 literals are accepted with or without brackets
  (`"::1"` is normalized to `"[::1]"` by `normalizeNodeHost`).
- **Bundled docker stack** is dual-stack: the node inbounds listen on `::`,
  the echo server binds `::` (accepts v4-mapped too), and the compose network
  has IPv6 enabled with a static ULA for the echo service, which the e2e
  suite targets explicitly.

## Testing

```bash
npm test                 # unit tests (framing, crypto, HTTP parser)

docker compose up -d
npm run test:e2e         # integration tests against the real node:
                         # VLESS GET/POST, IPv6 target, IPv6 node, Shadowsocks
```

CI (`.github/workflows/ci.yml`) runs the unit suite and the Docker e2e job on
every push.

## Environment

| № | Variable     | Default    | Meaning                                |
|---|--------------|------------|----------------------------------------|
| 1 | `XRAY_UUID`  | —          | VLESS user UUID (required)             |
| 2 | `XRAY_PORT`  | `8080`     | Host port for the VLESS-WS inbound     |
| 3 | `WS_PATH`    | `/tunnel`  | VLESS WebSocket path                   |
| 4 | `SS_PASSWORD`| —          | Shadowsocks password (required)        |
| 5 | `SS_METHOD`  | `aes-256-gcm` | Shadowsocks AEAD method             |
| 6 | `SS_PORT`    | `8082`     | Host port for the Shadowsocks-WS inbound |
| 7 | `SS_PATH`    | `/ss`      | Shadowsocks WebSocket path             |
| 8 | `ECHO_PORT`  | `8081`     | Host port for the echo server          |

## Roadmap

### Core & transports

- [x] VLESS + Shadowsocks client, demo, Docker node, unit + e2e tests
- [x] Dual-stack IPv6 (node and targets), verified by e2e
- [x] Protocol module seam: transport-as-stream, `createTunnel({protocol})`,
      per-protocol subpath exports (anti-bloat module split)
- [ ] npm packaging of the client package
- [ ] Service Worker helper for same-origin `fetch` interception
- [ ] QUIC transport: WebTransport module (Chromium/Firefox, ws fallback for
      Safari) + sing-box `webtransport` node profile; hand-rolled QUIC in
      Wasm is explicitly out of scope
- [ ] MV3 browser extension skeleton (`wasm-unsafe-eval` CSP), optional
      `chrome.proxy` bridge
- [ ] In-tunnel TLS to `https://` targets, Reality-style server hardening

### Protocols

Protocol inventory source: our tg-vpn-search checker DB (2026-07). Frozen
items stay documented and dependency-free — they enter only if unfrozen here.

| № | Protocol | Status | Notes |
|---|----------|--------|-------|
| 1 | VLESS (WS) | **implemented** | framing + UUID auth, e2e-verified |
| 2 | Shadowsocks (AEAD) | **implemented** | aes-128/256-gcm via SubtleCrypto; ss+ws e2e-verified |
| 3 | Trojan | 🧊 frozen | Feasible (sha224 password, same stream contract) |
| 4 | VMess | 🧊 frozen | Feasible (JS AES-CFB ~1–2 kB) |
| 5 | WireGuard / AmneziaWG | 🧊 frozen (permanent) | No UDP sockets in browsers; a Wasm VPN stack would repeat the megabytes-in-a-page problem |

## License

[MIT](./LICENSE)
