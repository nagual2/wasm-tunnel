"""Minimal HTTP echo server for tunnel end-to-end tests (listens on 8081)."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class EchoHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _echo(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        payload = json.dumps(
            {
                "method": self.command,
                "path": self.path,
                "headers": [[k, v] for k, v in self.headers.items()],
                "body": body.decode("utf-8", "replace"),
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _echo
    do_POST = _echo
    do_PUT = _echo
    do_DELETE = _echo
    do_PATCH = _echo

    def log_message(self, fmt: str, *args: object) -> None:
        print("[echo]", fmt % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8081), EchoHandler).serve_forever()
