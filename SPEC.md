# Wasm Tunnel — VLESS-WS Client Architecture (SPEC)

Status: working draft, MVP1 (part 1 of 3). Team hypothesis, not an
owner-ratified direction. All revisions tracked in the business plan.

## 1. What we build

A browser-first TypeScript library for **encrypted application transport
to self-hosted nodes**. The MVP is **VLESS over WebSocket**: an HTTP
request made through a `tunnel.fetch(url, init)` call is wrapped in a
VLESS request packet and shipped over a WebSocket connection to a server
that runs official Xray-core or sing-box with a VLESS inbound + WebSocket
stream settings. The server forwards the embedded HTTP request to its
target and ships the HTTP response back over the same WebSocket.

This is **not a system VPN** and not a proxy that intercepts all browser
traffic. It is a library: application code (a web app, a browser
extension later) chooses which requests go through the tunnel.

```
┌──────────────────┐   VLESS packet    ┌─────────────────────┐
│  browser page     │  over WebSocket  │  self-hosted node   │
│  tunnel.fetch()   │ ───────────────► │  Xray / sing-box    │
│  (this library)   │                  │  VLESS-WS inbound   │
└──────────────────┘                   └──────────┬──────────┘
         ▲                                        │ forwards raw
         └────────────────────────────────────────┘ HTTP request
                              HTTP response over the same socket
```

## 2. Protocol layout (VLESS, byte-exact)

Reference: https://xtls.github.io/en/development/protocols/vless.html
Validated against the Xray-core source (`proxy/vless/encoding`).

**Request header** (all lengths in bytes):

| Offset | Field | Size | Notes |
|--------|-------|------|-------|
| 0 | version | 1 | `0x00` |
| 1 | UUID | 16 | binary form of the canonical UUID string |
| 17 | addonsLen | 1 | `0x00` for the plain flow (no addons) |
| 18 | command | 1 | `0x01` = TCP (UDP `0x02` out of scope for MVP1) |
| 19 | port | 2 | big-endian |
| 21 | addrType | 1 | `0x01` IPv4, `0x02` domain, `0x03` IPv6 |
| 22 | addr | var | 4 bytes IPv4 / domain bytes / 16 bytes IPv6 |

Then the payload: the raw HTTP/1.1 request text.

**Response header** (in the first binary frame of the response):

| Offset | Field | Size | Notes |
|--------|-------|------|-------|
| 0 | version | 1 | echoes `0x00` |
| 1 | addonsLen | 1 | |
| 2 | addons | var | skipped by the client |

Then the payload: the raw HTTP/1.1 response text (status line, headers,
body).

**Framing rules:**
- WebSocket **binary frames only** (`ws.binaryType = 'arraybuffer'`).
- One request = one WebSocket connection = one response. The client
  sends `Connection: close` in the HTTP request; the server closes the
  socket when done.
- No TLS record, no length prefix beyond the VLESS header: the socket
  stream is the VLESS byte stream.

**Security note:** the VLESS request/response headers are **plaintext
framing** — there is no encryption inside the VLESS protocol itself.
Confidentiality comes entirely from the WebSocket transport: `wss://`
(TLS). Neither Wasm crypto nor SubtleCrypto is required to build or
parse a VLESS header. Wasm (and its CSP implications) is a later-phase
concern for Shadowsocks AEAD, not VLESS; see §7 Risks.

## 3. Early data (the `ed` option)

VLESS-over-WebSocket supports early data: the client sends the VLESS
request header as part of the *opening WebSocket handshake* instead of
as the first data frame, trimming one round trip. Xray and sing-box
implement this as:

- The WebSocket URL gets `?ed=<buffer-size>` (browsers: `?ed=8192`).
- The VLESS request header is base64url-encoded (RFC 4648 §5, padding
  stripped — Xray uses `base64.RawURLEncoding`) into the
  `Sec-WebSocket-Protocol` header of the handshake.
- The server echoes the same subprotocol in its response and treats the
  decoded header bytes as the first read of the connection. The WebSocket
  client passes `Sec-WebSocket-Protocol` via the constructor's `protocols`
  argument — this is the browser-native way to send early bytes.
- The payload then goes out as the first binary frame.

Server-side, the inbound must set
`"earlyDataHeaderName": "Sec-WebSocket-Protocol"` (Xray) / equivalent
(sing-box) for this to work. `earlyData: true` in the client options.

## 4. Package layout (MVP1, part 1)

```
packages/client/
  src/framing.ts    VLESS header build/parse, UUID, address encoding — pure bytes
  src/http.ts       raw HTTP/1.1 request build + response parse (hop-by-hop stripping)
  src/ws.ts         minimal promise WebSocket transport (browser API)
  src/index.ts      createVlessWsTunnel + tunnel.fetch wiring
  src/types.ts      public types (TunnelResponse, VlessWsTunnelOptions, ...)
  test/*.test.ts    vitest unit tests (no network in unit tests)
```

Workspace: pnpm (`pnpm-workspace.yaml`, root `package.json`).

The package is **thin client**: no Xray core, no Wasm, no full TCP/IP
stack. It speaks VLESS over WebSocket from a browser.

## 5. What's in scope vs out of scope (MVP1)

| In scope (MVP1) | Out of scope (MVP1) |
|---|---|
| VLESS request/response framing | VMess, Shadowsocks (MVP2) |
| WebSocket binary transport (ws/wss) | Reality / XTLS / xrv flow (the addons field stays empty) |
| Raw HTTP/1.1 bridging + fetch-like `TunnelResponse` | Full Xray-core compiled to Wasm in the page |
| TCP command only (0x01) | UDP command (0x02), TUN, system VPN |
| Strict UUID parsing | Browser extension (MVP3) |
| Single request/response per socket | Connection pooling, HTTP/2, streaming responses, chunked request bodies |
| `earlyData` via `Sec-WebSocket-Protocol` | `redirect` handling, full `Response` streaming (`body`/`bodyUsed` as a stream) |

The seed repo's WireGuard path (wgo, vtun, socksgo) is **architecture
inspiration only** — we keep the browser + WebSocket + Wasm pattern, not
the WireGuard protocol code. Seed files (`main.go`, `main.js`,
`index.html`) are deleted in a later cleanup delegation, not here.

## 6. Testing strategy

- **Unit tests** (this part): byte-exact framing, UUID, address types,
  response parsing, HTTP bridging, base64url early-data encoding.
  No network.
- **Integration test** (later part): `docker-compose.yml` with official
  Xray-core/sing-box VLESS-WS inbound + a Node script that runs `WsClient`
  against it and checks an end-to-end request. This checks real
  interoperability (the "Real-Xray incompatibility" risk countermeasure).
  Note: real Docker may not be available in every dev sandbox; the same
  test can run against `xtls/xray-core` container or the official tarball.

## 7. Risks

- **Agent shipping full Xray in the page** → we are a thin client only;
  the server side runs official Xray/sing-box in Docker, never in the
  browser.
- **Real-Xray incompatibility** → mandatory official-core integration
  test. Framing code is byte-for-byte compared against the Xray source
  (`proxy/vless/encoding/encoding.go`, `transport/internet/websocket`).
- **VMess/VLESS confusion** → MVP1 is VLESS-only; the options type has no
  shadowsocks/vmess fields.
- **Wasm / CSP** (`wasm-unsafe-eval`) — Wasm is optional and measured;
  MVP1 uses zero Wasm, so the library works on any CSP that permits
  WebSockets.

## 8. Later phases

- MVP2: Shadowsocks AEAD (this is where SubtleCrypto/Wasm enters),
  VMess, Service Worker fetch interceptor, npm packaging.
- MVP3: MV3 extension skeleton, `chrome.proxy` bridge.
- Demo app + docker-compose + env-based UUID config land in MVP1 part 2/3.