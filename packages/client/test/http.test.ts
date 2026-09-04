/**
 * Unit tests for HTTP bridging (raw HTTP/1.1 request building and
 * response parsing) — no network.
 */
import { describe, expect, it } from 'vitest';

import { buildHttpRequest, parseHttpResponse } from '../src/http.js';
import { parseTargetUrl } from '../src/index.js';

describe('buildHttpRequest', () => {
  it('builds a minimal GET', async () => {
    const bytes = await buildHttpRequest('https://example.com/hello', { method: 'GET' });
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe(`GET /hello HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n`);
  });

  it('defaults method to POST when a body is present', async () => {
    const bytes = await buildHttpRequest('http://example.com/', {
      body: 'abc',
      contentType: 'text/plain',
    });
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('POST / HTTP/1.1\r\n')).toBe(true);
    expect(text).toContain('Host: example.com');
    expect(text).toContain('Content-Type: text/plain');
    expect(text).toContain('Content-Length: 3');
    expect(text.endsWith('\r\n\r\nabc')).toBe(true);
  });

  it('includes port in Host when non-default', async () => {
    const bytes = await buildHttpRequest('http://example.com:8080/x', {});
    expect(new TextDecoder().decode(bytes)).toContain('Host: example.com:8080');
  });

  it('strips hop-by-hop headers from the request', async () => {
    const bytes = await buildHttpRequest('http://example.com/', {
      headers: { connection: 'keep-alive', 'content-length': '999', 'x-custom': 'yes' },
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain('connection:');
    expect(text).not.toContain('content-length:');
    expect(text).toContain('x-custom: yes');
  });

  it('handles Blob bodies', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const bytes = await buildHttpRequest('http://example.com/', { method: 'PUT', body: blob });
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('Content-Length: 3');
    expect(bytes.slice(-3)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('parseHttpResponse', () => {
  it('parses status line + headers + body', () => {
    const raw = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello',
    );
    const r = parseHttpResponse(raw);
    expect(r.status).toBe(200);
    expect(r.statusText).toBe('OK');
    expect(r.headers.get('content-type')).toBe('text/plain');
    expect(new TextDecoder().decode(r.body)).toBe('hello');
  });

  it('parses a 404 with empty body', () => {
    const raw = new TextEncoder().encode('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    const r = parseHttpResponse(raw);
    expect(r.status).toBe(404);
    expect(r.statusText).toBe('Not Found');
    expect(r.body.length).toBe(0);
  });

  it('decodes a chunked response', () => {
    const raw = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n',
    );
    const r = parseHttpResponse(raw);
    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(r.body)).toBe('hello world');
  });

  it('returns status 0 for non-HTTP bytes (tunnel to non-HTTP service)', () => {
    const r = parseHttpResponse(new TextEncoder().encode('SSH-2.0-OpenSSH_9.0'));
    expect(r.status).toBe(0);
    expect(new TextDecoder().decode(r.body)).toBe('SSH-2.0-OpenSSH_9.0');
  });

  it('handles multiple header values', () => {
    const raw = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\n\r\n',
    );
    const r = parseHttpResponse(raw);
    expect(r.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });
});

describe('parseTargetUrl', () => {
  it('splits host/port/path', () => {
    const t = parseTargetUrl('https://example.com:8443/api?x=1');
    expect(t.protocol).toBe('https:');
    expect(t.host).toBe('example.com');
    expect(t.port).toBe(8443);
    expect(t.path).toBe('/api?x=1');
  });

  it('defaults ports by scheme', () => {
    expect(parseTargetUrl('http://example.com/').port).toBe(80);
    expect(parseTargetUrl('https://example.com/').port).toBe(443);
  });

  it('rejects non-http(s) targets', () => {
    expect(() => parseTargetUrl('ftp://example.com/')).toThrow(/only http\(s\)/);
  });
});