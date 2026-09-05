import { describe, expect, it } from "vitest";
import { encodeHttpRequest, HttpResponseParser } from "../src/http";
import { concatBytes } from "../src/bytes";
import { normalizeNodeHost } from "../src/tunnel";

describe("normalizeNodeHost", () => {
  it("wraps bare IPv6 literals in brackets", () => {
    expect(normalizeNodeHost("::1")).toBe("[::1]");
    expect(normalizeNodeHost("2001:db8::1")).toBe("[2001:db8::1]");
  });

  it("keeps bracketed hosts, IPv4 and domain names untouched", () => {
    expect(normalizeNodeHost("[2001:db8::1]")).toBe("[2001:db8::1]");
    expect(normalizeNodeHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeNodeHost("example.com")).toBe("example.com");
  });

  it("rejects empty and malformed bracketed hosts", () => {
    expect(() => normalizeNodeHost("   ")).toThrow(/host is required/);
    expect(() => normalizeNodeHost("[2001:db8::1")).toThrow(/invalid IPv6 host/);
  });
});

describe("encodeHttpRequest", () => {
  it("builds a minimal GET with derived Host and forced close/identity", () => {
    const out = new TextDecoder().decode(
      encodeHttpRequest({ url: "http://echo:8081/a?b=1" }),
    );
    const lines = out.split("\r\n");
    expect(lines[0]).toBe("GET /a?b=1 HTTP/1.1");
    expect(lines).toContain("host: echo:8081");
    expect(lines).toContain("connection: close");
    expect(lines).toContain("accept-encoding: identity");
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-1)).toBe("");
  });

  it("encodes POST with body and content-length", () => {
    const bytes = encodeHttpRequest({
      method: "post",
      url: "http://echo:8081/echo",
      headers: { "x-test": "1" },
      body: '{"k":1}',
    });
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("POST /echo HTTP/1.1\r\n")).toBe(true);
    expect(text).toContain("host: echo:8081\r\n");
    expect(text).toContain("x-test: 1\r\n");
    expect(text).toContain("content-length: 7\r\n");
    expect(text.endsWith("\r\n\r\n{\"k\":1}")).toBe(true);
  });

  it("respects caller-provided host and content-length", () => {
    const text = new TextDecoder().decode(
      encodeHttpRequest({
        url: "http://echo:8081/",
        headers: { host: "override.example", "content-length": "3" },
        body: "abc",
      }),
    );
    expect(text).toContain("host: override.example\r\n");
    expect(text).not.toContain("host: echo:8081");
    expect(text).toContain("content-length: 3\r\n");
  });

  it("rejects non-http targets and bad methods", () => {
    expect(() => encodeHttpRequest({ url: "https://example.com/" })).toThrow(/http:\/\//);
    expect(() => encodeHttpRequest({ url: "http://a/", method: "BAD METHOD" })).toThrow(
      /invalid HTTP method/,
    );
  });
});

function parserFromChunks(chunks: Uint8Array[], options: { requestMethod?: string } = {}) {
  const parser = new HttpResponseParser(options);
  for (const chunk of chunks) parser.push(chunk);
  return parser;
}

describe("HttpResponseParser", () => {
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\n";
  const encoder = new TextEncoder();

  it("parses head and content-length body in one chunk", () => {
    const parser = parserFromChunks([encoder.encode(`${head}hello`)]);
    expect(parser.done).toBe(true);
    const result = parser.end();
    expect(result.status).toBe(200);
    expect(result.statusText).toBe("OK");
    expect(result.headers).toContainEqual(["content-length", "5"]);
    expect(new TextDecoder().decode(result.body)).toBe("hello");
  });

  it("reassembles head and body split across arbitrary chunks", () => {
    const full = encoder.encode(`${head}hello`);
    const parser = parserFromChunks([
      full.subarray(0, 7),
      full.subarray(7, 30),
      full.subarray(30),
    ]);
    expect(new TextDecoder().decode(parser.end().body)).toBe("hello");
  });

  it("decodes chunked bodies", () => {
    const raw =
      "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";
    const parser = parserFromChunks([encoder.encode(raw)]);
    expect(parser.done).toBe(true);
    expect(new TextDecoder().decode(parser.end().body)).toBe("abcde");
  });

  it("decodes chunked bodies with trailers", () => {
    const raw =
      "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n4\r\nwiki\r\n0\r\nx-check: 1\r\n\r\n";
    const parser = parserFromChunks([encoder.encode(raw)]);
    expect(new TextDecoder().decode(parser.end().body)).toBe("wiki");
  });

  it("treats missing length as read-until-close", () => {
    const parser = new HttpResponseParser();
    parser.push(encoder.encode("HTTP/1.1 200 OK\r\n\r\nstream"));
    expect(parser.done).toBe(false);
    parser.push(encoder.encode("ing data"));
    const result = parser.end();
    expect(new TextDecoder().decode(result.body)).toBe("streaming data");
  });

  it("completes immediately for 204 and HEAD requests", () => {
    const noContent = parserFromChunks([encoder.encode("HTTP/1.1 204 No Content\r\n\r\n")]);
    expect(noContent.done).toBe(true);
    expect(noContent.end().body.byteLength).toBe(0);

    const headResponse = new HttpResponseParser({ requestMethod: "HEAD" });
    headResponse.push(encoder.encode("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n"));
    expect(headResponse.done).toBe(true);
    expect(headResponse.end().body.byteLength).toBe(0);
  });

  it("skips interim 1xx responses", () => {
    const finalHead = "HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\n";
    const raw = concatBytes(
      encoder.encode("HTTP/1.1 100 Continue\r\n\r\n"),
      encoder.encode(`${finalHead}ok!`),
    );
    const parser = parserFromChunks([raw]);
    expect(parser.end().status).toBe(200);
    expect(new TextDecoder().decode(parser.end().body)).toBe("ok!");
  });

  it("throws on truncated bodies and malformed heads", () => {
    const truncated = parserFromChunks([encoder.encode(`${head}hi`)]);
    expect(() => truncated.end()).toThrow(/incomplete body/);

    expect(() => parserFromChunks([encoder.encode("NOT HTTP\r\n\r\n")])).toThrow(
      /malformed HTTP status line/,
    );
  });
});
