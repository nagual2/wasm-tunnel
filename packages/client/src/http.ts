/**
 * Raw HTTP request/response bridging for the VLESS tunnel.
 *
 * The VLESS WebSocket transport is a plain TCP pipe: it carries exactly
 * what a browser would have sent over a real TCP connection. That means
 * an HTTP request through the tunnel is raw HTTP/1.1 text — status line,
 * headers, body — and the response comes back as raw HTTP/1.1 text over
 * the VLESS payload. This module turns a high-level fetch-like call into
 * that raw text and parses the raw response text back into
 * `{status, headers, body}`.
 *
 * It deliberately does NOT implement chunked transfer-encoding decoding,
 * keep-alive pipelining, or proxy auth — MVP1 is single request/response
 * per WebSocket, server closes the socket after each exchange.
 */
import type { TunnelRequestInit } from './types.js';

/** Convert a BodyInit to bytes. */
export async function bodyToBytes(body: BodyInit | undefined): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    if (body instanceof DataView) {
      const out = new Uint8Array(body.byteLength);
      out.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
      return out;
    }
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
  throw new TypeError(`unsupported body type: ${typeof body}`);
}

/** Serialize HeadersInit into a flat CRLF list. */
export function headersEntries(headers: HeadersInit | undefined): Array<[string, string]> {
  if (headers === undefined) return [];
  if (headers instanceof Headers) {
    return Array.from(headers.entries());
  }
  if (Array.isArray(headers)) {
    return headers.map(([k, v]) => [String(k), String(v)]);
  }
  return Object.entries(headers).map(([k, v]) => [k, String(v)]);
}

const PROHIBITED_HEADERS = new Set([
  'connection',
  'host',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'keep-alive',
]);

/**
 * Build the raw HTTP/1.1 request text for `fetch(input, init)`.
 * Returns the wire bytes to send as the VLESS payload.
 */
export async function buildHttpRequest(
  url: string,
  init: TunnelRequestInit | undefined,
): Promise<Uint8Array> {
  const parsed = new URL(url);
  const method = (init?.method ?? (init?.body ? 'POST' : 'GET')).toUpperCase();
  const host = parsed.host; // includes :port when non-default
  const path = `${parsed.pathname}${parsed.search}`;

  const lines: string[] = [`${method} ${path} HTTP/1.1`, `Host: ${host}`];
  for (const [k, v] of headersEntries(init?.headers)) {
    if (PROHIBITED_HEADERS.has(k.toLowerCase())) continue;
    lines.push(`${k}: ${v}`);
  }
  if (init?.contentType) lines.push(`Content-Type: ${init.contentType}`);

  const body = await bodyToBytes(init?.body);
  if (body.length > 0) {
    lines.push(`Content-Length: ${body.length}`);
  }
  lines.push('Connection: close');
  lines.push('');

  const head = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
  if (body.length === 0) return head;
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** Result of parsing a raw HTTP/1.1 response message. */
export interface ParsedHttpResponse {
  status: number;
  statusText: string;
  version: string;
  headers: Headers;
  body: Uint8Array;
}

/**
 * Parse a raw HTTP response message (as carried inside a VLESS payload).
 * Handles Content-Length-delimited bodies and (for robustness) the
 * hop-by-hop framing of a single response; chunked transfer-encoding is
 * NOT decoded (it should not appear on a `Connection: close` response).
 */
export function parseHttpResponse(raw: Uint8Array): ParsedHttpResponse {
  const text = new TextDecoder().decode(raw);
  const crlf = text.indexOf('\r\n\r\n');
  if (crlf === -1) {
    // Not an HTTP response — surfaced as status 0 with the raw body.
    return {
      status: 0,
      statusText: '',
      version: '',
      headers: new Headers(),
      body: raw.slice(),
    };
  }
  const headText = text.slice(0, crlf);
  const bodyText = text.slice(crlf + 4);
  const lines = headText.split('\r\n');
  const statusLine = lines[0] ?? '';
  const m = /^HTTP\/(\d)\.(\d) (\d{3})(?: ([^\r\n]*))?$/.exec(statusLine);
  const headers = new Headers();
  let contentLength = -1;
  let chunked = false;
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    headers.append(name, value);
    if (name.toLowerCase() === 'content-length') {
      contentLength = Number(value);
    }
    if (name.toLowerCase() === 'transfer-encoding') {
      if (value.toLowerCase().includes('chunked')) chunked = true;
    }
  }
  let body: Uint8Array;
  if (chunked) {
    // Minimal chunked decoder for single responses: 1CRLF<chunk>CRLF...0CRLFCRLF
    body = decodeChunked(bodyText);
  } else if (contentLength >= 0) {
    body = new TextEncoder().encode(bodyText.slice(0, contentLength));
  } else {
    // No framing header: take everything after the header block.
    body = new TextEncoder().encode(bodyText);
  }
  return {
    status: m ? Number(m[3]) : 0,
    statusText: m?.[4]?.trim() ?? '',
    version: m ? `HTTP/${m[1]}.${m[2]}` : '',
    headers,
    body,
  };
}

/** Minimal chunked transfer-encoding decoder (response bodies only). */
export function decodeChunked(text: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let pos = 0;
  for (;;) {
    const lineEnd = text.indexOf('\r\n', pos);
    if (lineEnd === -1) break;
    const sizeHex = (text.slice(pos, lineEnd).split(';')[0] ?? '').trim();
    if (sizeHex === '') break;
    const size = parseInt(sizeHex, 16);
    if (Number.isNaN(size)) break;
    pos = lineEnd + 2;
    if (size === 0) break;
    if (pos + size > text.length) break;
    chunks.push(encoder.encode(text.slice(pos, pos + size)));
    pos += size + 2; // skip trailing CRLF
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}