/**
 * Minimal HTTP/1.1 client logic for sending a single request through the
 * tunnel and parsing the response. Supports Content-Length, chunked and
 * read-until-close bodies; interim 1xx responses are skipped.
 */

import { concatBytes, EMPTY_BYTES } from "./bytes";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MAX_HEAD_BYTES = 64 * 1024;

export interface HttpRequestOptions {
  method?: string;
  /** Absolute target URL as seen from the tunnel node (http:// only). */
  url: string | URL;
  headers?: HeadersInit;
  body?: string | Uint8Array | null;
}

function hostHeader(url: URL): string {
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return url.port && url.port !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname;
}

/**
 * Encode a full HTTP/1.1 request as bytes. Sets Host, Connection: close and
 * Accept-Encoding: identity unless the caller overrides them.
 */
export function encodeHttpRequest(options: HttpRequestOptions): Uint8Array {
  const url = new URL(options.url);
  if (url.protocol !== "http:") {
    throw new Error(
      `only http:// targets are supported (got ${url.protocol}); in-tunnel TLS is on the roadmap`,
    );
  }
  const method = (options.method ?? "GET").toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error(`invalid HTTP method: ${JSON.stringify(options.method)}`);
  }
  const body =
    typeof options.body === "string" ? textEncoder.encode(options.body) : (options.body ?? null);

  const headers = new Headers(options.headers);
  if (!headers.has("host")) headers.set("host", hostHeader(url));
  if (!headers.has("connection")) headers.set("connection", "close");
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  if (body && body.byteLength > 0 && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }

  const requestTarget = `${url.pathname}${url.search}`;
  const lines = [`${method} ${requestTarget} HTTP/1.1`];
  headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  const head = textEncoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
  return body && body.byteLength > 0 ? concatBytes(head, body) : head;
}

export interface HttpHead {
  status: number;
  statusText: string;
  /** Lowercased header names in order of appearance. */
  headers: [string, string][];
}

export interface HttpResult extends HttpHead {
  body: Uint8Array;
}

type BodyPlan =
  | { kind: "length"; remaining: number }
  | { kind: "chunked" }
  | { kind: "until-close" }
  | { kind: "none" };

function getHeader(headers: [string, string][], name: string): string | undefined {
  return headers.find(([key]) => key === name)?.[1];
}

function bodyPlanFor(head: HttpHead, requestMethod: string): BodyPlan {
  if (head.status === 204 || head.status === 304) return { kind: "none" };
  if (requestMethod === "HEAD") return { kind: "none" };
  const transferEncoding = getHeader(head.headers, "transfer-encoding");
  if (transferEncoding && transferEncoding.toLowerCase().includes("chunked")) {
    return { kind: "chunked" };
  }
  const contentLength = getHeader(head.headers, "content-length");
  if (contentLength !== undefined) {
    const value = Number(contentLength);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid Content-Length: ${JSON.stringify(contentLength)}`);
    }
    return { kind: "length", remaining: value };
  }
  return { kind: "until-close" };
}

function parseHeadBytes(headBytes: Uint8Array): HttpHead {
  const text = textDecoder.decode(headBytes);
  const lines = text.split("\r\n");
  const statusLine = lines[0] ?? "";
  const match = /^HTTP\/(\d(?:\.\d)?)\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!match) {
    throw new Error(`malformed HTTP status line: ${JSON.stringify(statusLine)}`);
  }
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error(`malformed HTTP header line: ${JSON.stringify(line)}`);
    }
    headers.push([
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    ]);
  }
  return {
    status: Number(match[2]),
    statusText: match[3] ?? "",
    headers,
  };
}

/** Find the index of "\r\n\r\n" in the buffer, or -1. */
function findDoubleCRLF(buffer: Uint8Array): number {
  for (let i = 0; i + 3 < buffer.byteLength; i++) {
    if (
      buffer[i] === 13 &&
      buffer[i + 1] === 10 &&
      buffer[i + 2] === 13 &&
      buffer[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

/** Find the index of "\r\n" starting at the buffer beginning, or -1. */
function findCRLF(buffer: Uint8Array): number {
  for (let i = 0; i + 1 < buffer.byteLength; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10) return i;
  }
  return -1;
}

/** Incremental decoder for Transfer-Encoding: chunked bodies. */
class ChunkedBodyDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private mode: "size" | "data" | "trailer" = "size";
  private remaining = 0;
  private out: Uint8Array[] = [];
  private finishedFlag = false;

  get finished(): boolean {
    return this.finishedFlag;
  }

  push(chunk: Uint8Array): void {
    this.buffer = this.buffer.byteLength ? concatBytes(this.buffer, chunk) : chunk;
    for (;;) {
      if (this.finishedFlag || this.buffer.byteLength === 0) return;
      if (this.mode === "size") {
        const eol = findCRLF(this.buffer);
        if (eol < 0) {
          if (this.buffer.byteLength > 1024) throw new Error("chunk size line too long");
          return;
        }
        const line = textDecoder.decode(this.buffer.subarray(0, eol));
        this.buffer = this.buffer.subarray(eol + 2);
        const sizeToken = (line.split(";")[0] ?? "").trim();
        if (!/^[0-9a-fA-F]+$/.test(sizeToken)) {
          throw new Error(`invalid chunk size: ${JSON.stringify(sizeToken)}`);
        }
        const size = Number.parseInt(sizeToken, 16);
        if (size === 0) {
          this.mode = "trailer";
        } else {
          this.remaining = size;
          this.mode = "data";
        }
      } else if (this.mode === "data") {
        if (this.buffer.byteLength < this.remaining + 2) return;
        if (
          (this.buffer[this.remaining] ?? 0) !== 13 ||
          (this.buffer[this.remaining + 1] ?? 0) !== 10
        ) {
          throw new Error("missing CRLF after chunk data");
        }
        this.out.push(this.buffer.subarray(0, this.remaining));
        this.buffer = this.buffer.subarray(this.remaining + 2);
        this.remaining = 0;
        this.mode = "size";
      } else {
        // trailer section: skip header lines until the blank line
        const eol = findCRLF(this.buffer);
        if (eol < 0) return;
        const line = textDecoder.decode(this.buffer.subarray(0, eol));
        this.buffer = this.buffer.subarray(eol + 2);
        if (line.trim() === "") this.finishedFlag = true;
      }
    }
  }

  take(): Uint8Array[] {
    return this.out.splice(0, this.out.length);
  }
}

/**
 * Streaming HTTP response parser: push transport chunks in, poll `done`,
 * then call `end()` to get the final result.
 */
export class HttpResponseParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private head: HttpHead | null = null;
  private plan: BodyPlan | null = null;
  private collected: Uint8Array[] = [];
  private chunked = new ChunkedBodyDecoder();
  private finishedResult: HttpResult | null = null;
  private readonly requestMethod: string;

  constructor(options: { requestMethod?: string } = {}) {
    this.requestMethod = (options.requestMethod ?? "GET").toUpperCase();
  }

  get done(): boolean {
    return this.finishedResult !== null;
  }

  /** Feed one payload chunk from the tunnel stream. */
  push(chunk: Uint8Array): void {
    if (this.finishedResult) throw new Error("HTTP parser already finished");
    this.buffer = this.buffer.byteLength ? concatBytes(this.buffer, chunk) : chunk;
    if (!this.head) this.consumeHead();
    if (this.head && !this.finishedResult) this.consumeBody();
  }

  /**
   * Signal that the underlying stream closed. Returns the final result for
   * read-until-close bodies; throws if the body is incomplete.
   */
  end(): HttpResult {
    if (this.finishedResult) return this.finishedResult;
    if (!this.head || !this.plan) {
      throw new Error("connection closed before a complete HTTP response head");
    }
    if (this.plan.kind === "until-close") {
      const body = this.collected.length
        ? concatBytes(...this.collected, this.buffer)
        : this.buffer;
      return this.finish(body);
    }
    throw new Error(`connection closed with incomplete body (${this.plan.kind})`);
  }

  private consumeHead(): void {
    for (;;) {
      const headEnd = findDoubleCRLF(this.buffer);
      if (headEnd < 0) {
        if (this.buffer.byteLength > MAX_HEAD_BYTES) {
          throw new Error("HTTP response head exceeds 64 KiB");
        }
        return;
      }
      const headBytes = this.buffer.subarray(0, headEnd);
      this.buffer = this.buffer.subarray(headEnd + 4);
      const parsed = parseHeadBytes(headBytes);
      if (parsed.status >= 100 && parsed.status < 200) continue; // interim, keep looking
      this.head = parsed;
      this.plan = bodyPlanFor(parsed, this.requestMethod);
      if (this.plan.kind === "none") this.finish(EMPTY_BYTES);
      return;
    }
  }

  private consumeBody(): void {
    const plan = this.plan;
    if (!plan) return;
    if (plan.kind === "length") {
      while (this.buffer.byteLength > 0 && plan.remaining > 0) {
        const take = Math.min(plan.remaining, this.buffer.byteLength);
        this.collected.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        plan.remaining -= take;
      }
      if (plan.remaining === 0) {
        this.finish(this.collected.length ? concatBytes(...this.collected) : EMPTY_BYTES);
      }
    } else if (plan.kind === "chunked") {
      this.chunked.push(this.buffer);
      this.buffer = EMPTY_BYTES;
      this.collected.push(...this.chunked.take());
      if (this.chunked.finished) {
        this.finish(this.collected.length ? concatBytes(...this.collected) : EMPTY_BYTES);
      }
    }
    // "until-close": data stays in this.buffer, finalized by end().
  }

  private finish(body: Uint8Array): HttpResult {
    const head = this.head;
    if (!head) throw new Error("finish() without a parsed head");
    this.finishedResult = {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
      body,
    };
    return this.finishedResult;
  }
}
