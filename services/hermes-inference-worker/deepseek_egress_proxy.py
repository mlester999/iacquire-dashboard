#!/usr/bin/env python3
"""TCP CONNECT forwarder that permits only api.deepseek.com:443."""
from __future__ import annotations

import ipaddress
import select
import socket
import socketserver

ALLOWED_AUTHORITY = "api.deepseek.com:443"
MAX_HEADER_BYTES = 8 * 1024
CONNECT_TIMEOUT_SECONDS = 10
IDLE_TIMEOUT_SECONDS = 30


def parse_connect_target(request_line: bytes) -> tuple[str, int] | None:
    try:
        method, authority, protocol = request_line.decode("ascii").strip().split(" ")
    except (UnicodeDecodeError, ValueError):
        return None
    if method != "CONNECT" or protocol not in {"HTTP/1.0", "HTTP/1.1"} or authority.lower() != ALLOWED_AUTHORITY:
        return None
    return "api.deepseek.com", 443


def _connect_deepseek() -> socket.socket:
    last_error: OSError | None = None
    for family, socktype, proto, _canonname, sockaddr in socket.getaddrinfo(
        "api.deepseek.com", 443, type=socket.SOCK_STREAM
    ):
        address = ipaddress.ip_address(sockaddr[0])
        if not address.is_global:
            continue
        upstream = socket.socket(family, socktype, proto)
        upstream.settimeout(CONNECT_TIMEOUT_SECONDS)
        try:
            upstream.connect(sockaddr)
            upstream.settimeout(None)
            return upstream
        except OSError as error:
            last_error = error
            upstream.close()
    if last_error:
        raise last_error
    raise OSError("provider endpoint unavailable")


def _relay(left: socket.socket, right: socket.socket) -> None:
    peers = {left: right, right: left}
    for peer in peers:
        peer.setblocking(False)
    while True:
        readable, _, _ = select.select(list(peers), [], [], IDLE_TIMEOUT_SECONDS)
        if not readable:
            return
        for source in readable:
            try:
                chunk = source.recv(16 * 1024)
            except OSError:
                return
            if not chunk:
                return
            destination = peers[source]
            try:
                destination.sendall(chunk)
            except OSError:
                return


class Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        request_line = self.rfile.readline(MAX_HEADER_BYTES + 1)
        if len(request_line) > MAX_HEADER_BYTES or parse_connect_target(request_line) is None:
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        size = len(request_line)
        while True:
            line = self.rfile.readline(MAX_HEADER_BYTES + 1)
            size += len(line)
            if size > MAX_HEADER_BYTES or not line:
                self.wfile.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                return
            if line in (b"\r\n", b"\n"):
                break
        upstream: socket.socket | None = None
        try:
            upstream = _connect_deepseek()
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            _relay(self.connection, upstream)
        except OSError:
            try:
                self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
        finally:
            if upstream is not None:
                upstream.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    host = "0.0.0.0"
    port = 3128
    with Server((host, port), Handler) as server:
        server.serve_forever(poll_interval=0.25)


if __name__ == "__main__":
    main()
