# Wasm Tunnel — packages/client

Browser-first VLESS-over-WebSocket tunnel client (MVP1, part 1).

## What's here

- `src/framing.ts` — VLESS request/response header byte layout, UUID encoding, address encoding (IPv4/IPv6/domain), response header parsing. Pure byte manipulation, no I/O.
- `src/http.ts` — raw HTTP/1.1 request building and response parsing (the tunnel is a TCP pipe; HTTP text crosses it).
- `src/ws.ts` — minimal WebSocket transport (promise-based, browser `WebSocket`).
- `src/index.ts` — `createVlessWsTunnel(options)` + `tunnel.fetch(url, init)` returning a `TunnelResponse`.
- `src/types.ts` — public types.

## Scripts

```sh
pnpm install          # from repo root
pnpm --filter @wasm-tunnel/client typecheck   # tsc --noEmit (strict)
pnpm --filter @wasm-tunnel/client test        # vitest run (unit tests, no network)
pnpm --filter @wasm-tunnel/client build       # tsc -> dist/
```

## API

```ts
const tunnel = createVlessWsTunnel({
  uuid: '0f3a4d94-0d8d-4f5e-9f1c-6e0b0a1a2b3c',
  wsUrl: 'ws://127.0.0.1:8080/vless',   // or wss://...
  earlyData: false,
});

const res = await tunnel.fetch('https://example.com/', { method: 'GET' });
const body = await res.arrayBuffer(); // Uint8Array -> ArrayBuffer
```

`TunnelResponse` mimics `fetch`'s Response closely: `status`, `ok`,
`statusText`, `headers`, `url`, `redirected`, `body` (Uint8Array),
`arrayBuffer()`, `clone()`.

## Early data

`earlyData: true` implements VLESS-over-WebSocket early data the way
Xray/sing-box do it: the VLESS request header is base64url-encoded into
the `Sec-WebSocket-Protocol` header of the opening handshake, and
`?ed=8192` is appended to the endpoints' WebSocket path; the HTTP payload
goes out as the first binary frame. Server must set
`"earlyDataHeaderName": "Sec-WebSocket-Protocol"`.

## No crypto needed

The VLESS request/response headers are plaintext framing — no
SubtleCrypto and no Wasm in this package. Confidentiality comes from the
WebSocket transport (TLS when `wss:`). See `SPEC.md` at the repo root.