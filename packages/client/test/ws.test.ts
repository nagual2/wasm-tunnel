/**
 * Unit tests for the WebSocket layer: URL parsing, early-data mechanics
 * (base64url, ?ed= query param), and the TunnelResponse envelope.
 * No network: WsClient itself is only exercised via its URL helpers and
 * parsing — the actual socket behavior is covered by integration tests
 * against a real Xray instance (see SPEC.md).
 */
import { describe, expect, it } from 'vitest';

import { EARLY_DATA_BUFFER, parseWsUrl, toBase64Url } from '../src/ws.js';
import { parseHttpEnvelope } from '../src/index.js';

describe('parseWsUrl', () => {
  it('parses a plain ws URL with default port 80', () => {
    const u = parseWsUrl('ws://127.0.0.1:8080/vless', false);
    expect(u.secure).toBe(false);
    expect(u.host).toBe('127.0.0.1');
    expect(u.port).toBe(8080);
    expect(u.socketUrl).toBe('ws://127.0.0.1:8080/vless');
  });

  it('parses a wss URL with default port 443', () => {
    const u = parseWsUrl('wss://example.com/vless', false);
    expect(u.secure).toBe(true);
    expect(u.port).toBe(443);
    expect(u.socketUrl).toBe('wss://example.com/vless');
  });

  it('appends ?ed=8192 when earlyData is on', () => {
    const u = parseWsUrl('ws://127.0.0.1:8080/vless', true);
    expect(u.socketUrl).toBe(`ws://127.0.0.1:8080/vless?ed=${EARLY_DATA_BUFFER}`);
  });

  it('merges ed into an existing query string', () => {
    const u = parseWsUrl('ws://x.test/vless?token=a%20b', true);
    expect(u.socketUrl).toBe(`ws://x.test/vless?token=a%20b&ed=${EARLY_DATA_BUFFER}`);
  });

  it('rejects unsupported schemes', () => {
    expect(() => parseWsUrl('http://example.com/vless', false)).toThrow(/unsupported WebSocket scheme/);
    expect(() => parseWsUrl('not-a-url', false)).toThrow(/invalid WebSocket URL/);
  });
});

describe('toBase64Url', () => {
  it('encodes bytes as RFC 4648 base64url without padding', () => {
    // "hello" -> aGVsbG8= -> strip "="
    expect(toBase64Url(new TextEncoder().encode('hello'))).toBe('aGVsbG8');
  });

  it('uses url-safe alphabet', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]); // 6-bit groups 62,63,62,63
    // std base64: "+/+/" → url-safe, no padding: "-_-_"
    expect(toBase64Url(bytes)).toBe('-_-_');
  });

  it('handles empty input', () => {
    expect(toBase64Url(new Uint8Array(0))).toBe('');
  });
});

describe('parseHttpEnvelope', () => {
  it('wraps an HTTP response as a TunnelResponse', () => {
    const payload = new TextEncoder().encode('HTTP/1.1 201 Created\r\nX-Test: 1\r\nContent-Length: 2\r\n\r\nok');
    const res = parseHttpEnvelope(payload, 'https://example.com/');
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.statusText).toBe('Created');
    expect(res.headers.get('x-test')).toBe('1');
    expect(new TextDecoder().decode(res.body)).toBe('ok');
  });

  it('reports non-2xx as ok=false', () => {
    const payload = new TextEncoder().encode('HTTP/1.1 500 Server Error\r\nContent-Length: 0\r\n\r\n');
    const res = parseHttpEnvelope(payload, 'https://example.com/');
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
  });

  it('arrayBuffer() returns a copy of the body', async () => {
    const payload = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc');
    const res = parseHttpEnvelope(payload, 'https://u/');
    const buf = await res.arrayBuffer();
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe('abc');
  });
});