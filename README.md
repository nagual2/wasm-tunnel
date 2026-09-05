# wasm-tunnel

Browser-first **VLESS over WebSocket** tunnel client for application HTTP traffic.
A web page (or extension) opens a WebSocket to **your own self-hosted node**
(official Xray-core in Docker) and sends application HTTP requests through it —
no TUN/TAP, no OS routing, no system VPN.

```
┌─────────────┐  wss/ws   ┌────────────────────┐  plain TCP  ┌──────────────┐
│ Browser     │──────────▶│ Xray node (Docker) │────────────▶│ Target (http)│
│ TS client   │  VLESS    │ VLESS-WS inbound   │             │ e.g. echo    │
└─────────────┘           └────────────────────┘             └──────────────┘
```

This repository started as a fork of [asciimoth/wg-web-demo](https://github.com/asciimoth/wg-web-demo)
and keeps its browser-tunnel architecture spirit (browser + WebSocket + optional
Wasm), but the WireGuard transport is fully replaced by a thin TypeScript
VLESS-over-WebSocket client. VLESS itself performs no encryption — transport
security comes from `wss://` (TLS) or a trusted private network.

## Quickstart (5 minutes)

Prerequisites: Docker, Node.js ≥ 22.

```bash
# 1. Configure the test node
cp .env.example .env        # optionally generate a fresh UUID:
                            # node -e "console.log(crypto.randomUUID())"

# 2. Start the node + echo server
docker compose up -d

# 3. Install and run the demo
npm ci
npm run dev                 # http://localhost:5173
```

Open http://localhost:5173 and press **Request via tunnel**. Defaults point the
demo at `ws://127.0.0.1:8080/tunnel` with the UUID from `.env` and the target
`http://echo:8081/…` (the `echo` name is resolved by the node inside the Docker
network — the browser cannot reach it directly, proving the traffic really goes
through the tunnel).

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
friends work as usual. Limitations (MVP1): `http://` targets only (in-tunnel
TLS for `https://` targets is future work), one request per WebSocket
connection.

## IPv6

IPv6 работает наравне с IPv4 в обеих плоскостях:

- **Цели внутри туннеля** — IPv6-литералы (`http://[2001:db8::1]:8080/`) и домены
  с AAAA-записями; нода резолвит и набирает адрес сама (VLESS `atype: IPv6`,
  поддержка `::`-сжатия и v4-mapped форм).
- **Хост ноды снаружи** — литерал можно давать как в скобках, так и без:
  `"::1"` автоматически нормализуется в `"[::1]"` (`normalizeNodeHost`).
- **Поставляемый docker-стек** dual-stack: inbound Xray слушает `::`, echo
  биндится на `::` (принимает и v4-mapped), сеть compose включает IPv6 со
  статическим ULA `fd2c:4a98:9a2b::10` для echo — по нему e2e проверяет v6-цель.

## Testing

```bash
npm test                 # unit tests (framing, UUID, HTTP parser)

docker compose up -d
npm run test:e2e         # integration test against the real Xray node
```

CI (`.github/workflows/ci.yml`) runs the unit suite and the Docker e2e job on
every push.

## Environment

| № | Variable    | Default    | Meaning                        |
|---|-------------|------------|--------------------------------|
| 1 | `XRAY_UUID` | —          | VLESS user UUID (required)     |
| 2 | `XRAY_PORT` | `8080`     | Host port for the VLESS-WS inbound |
| 3 | `WS_PATH`   | `/tunnel`  | WebSocket path                 |
| 4 | `ECHO_PORT` | `8081`     | Host port for the echo server  |

## Roadmap

### Core & transports

- [x] MVP1: VLESS + WebSocket client, demo, Docker node, tests
- [x] Dual-stack IPv6 (node and targets), verified by e2e
- [ ] Transport seam refactor: transport-as-stream + `createTunnel({protocol})`
      factory with per-protocol subpath exports (anti-bloat module split)
- [ ] npm packaging of the client package
- [ ] Service Worker helper for same-origin `fetch` interception
- [ ] QUIC transport: WebTransport module (Chromium/Firefox, ws fallback for
      Safari) + sing-box `webtransport` node profile; hand-rolled QUIC in
      Wasm is explicitly out of scope
- [ ] MVP3: MV3 browser extension skeleton (`wasm-unsafe-eval` CSP), optional
      `chrome.proxy` bridge
- [ ] Wasm crypto hot paths (measured; JS SubtleCrypto/none is fine for now)
- [ ] In-tunnel TLS to `https://` targets, Reality (future work)

### Protocols

Protocol inventory source: tg-vpn-search checker DB (minisforum, 2026-07).
Frozen items stay documented and dependency-free — they enter only if
unfrozen here.

| № | Protocol | Status | Notes |
|---|----------|--------|-------|
| 1 | Shadowsocks (AEAD) | **unfrozen — next up** | HKDF + AES-GCM via SubtleCrypto, +2–3 kB gzip; largest alive pool (72 nodes) |
| 2 | Trojan | 🧊 frozen | Feasible (sha224 password, same stream contract), but 0 alive in DB |
| 3 | VMess | 🧊 frozen | Feasible (JS AES-CFB ~1–2 kB), only 2 configs in DB |
| 4 | WireGuard / AmneziaWG | 🧊 frozen (permanent) | No UDP sockets in browsers; the Wasm stack path was rejected by the brief |

## License

CC0 1.0 (see [LICENSE](./LICENSE)) — inherited from the upstream project.
