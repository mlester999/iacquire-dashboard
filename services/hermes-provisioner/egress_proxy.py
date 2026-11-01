#!/usr/bin/env python3
"""Allowlist egress for the client-only Hermes runtime.

Two listeners, both TCP-only and both refusing every destination that is not named in EGRESS_ALLOWED_HOSTS:

* a CONNECT proxy (EGRESS_PROXY_PORT, default 3128) for HTTPS clients that honour HTTPS_PROXY (the Hermes gateway: model provider, web search);
* an optional passthrough (EGRESS_PORTAL_HOST, EGRESS_PORTAL_PORT default 443) that forwards raw TCP to one allowlisted host. The compose overlay gives the proxy that host's
  name as a network alias on the internal client network, so a client that never reads a proxy setting (the provisioner worker, which talks to the portal) still reaches the
  portal, and still validates the portal's own certificate, because TLS runs end to end.

Every upstream address is resolved here, at connect time, and only globally routable addresses are used: the proxy can never be pointed at the VPS network, a host-published port or
a metadata address, whatever name an allowlisted DNS record is changed to. Nothing is logged except a one-word outcome (no host names, no addresses, no payloads).

The portal's name is the one exception to "resolved by the container's own resolver". The overlay publishes that name as a network alias of THIS container, and Docker's embedded DNS
answers a container's own alias with the container's own (private) address, which the global-address rule would then skip. So the portal's name is looked up with a direct DNS query to
the configured resolvers (EGRESS_DNS_SERVERS), which never sees the alias. Every other name still goes through getaddrinfo.
Pattern reused from services/hermes-inference-worker/deepseek_egress_proxy.py (a single fixed authority); this one takes a list.
"""
from __future__ import annotations

import ipaddress
import os
import re
import secrets
import select
import socket
import socketserver
import struct
import sys
import threading
from typing import Callable, Iterable

CONNECT_PORT = 443
MAX_HEADER_BYTES = 8 * 1024
CONNECT_TIMEOUT_SECONDS = 10
# A model call can stay silent for minutes (a long non-streamed completion, a slow first token): the tunnel is only cut after this long with no bytes in either direction.
# EGRESS_IDLE_TIMEOUT_SECONDS overrides it, within IDLE_TIMEOUT_LIMITS.
IDLE_TIMEOUT_SECONDS = 600
IDLE_TIMEOUT_LIMITS = (30, 3600)
# How long one chunk may wait for a slow peer to take it (backpressure), not a limit on the whole call.
SEND_TIMEOUT_SECONDS = 120
MAX_ALLOWED_HOSTS = 32
MAX_DNS_SERVERS = 4
DNS_PORT = 53
DNS_TIMEOUT_SECONDS = 3

# A fully qualified lower-case DNS name with at least one dot, or "*." plus such a name (any depth below it, never the bare name itself). An IP literal never matches.
HOST_PATTERN = re.compile(r"^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$")

Resolver = Callable[..., list]
RESOLVER: Resolver = socket.getaddrinfo
# Names looked up with a direct DNS query instead of RESOLVER (set by main from EGRESS_PORTAL_HOST), and the resolvers to ask.
DIRECT_DNS_HOSTS: frozenset[str] = frozenset()
DNS_SERVERS: tuple[str, ...] = ()


def parse_allowlist(raw: str) -> tuple[str, ...]:
    """Comma-separated host names (an optional ":443" is accepted and dropped); raises ValueError for anything else so a typo stops the proxy instead of widening it."""
    entries: list[str] = []
    for part in raw.split(","):
        item = part.strip().lower().rstrip(".")
        if not item:
            continue
        if item.endswith(f":{CONNECT_PORT}"):
            item = item[: -len(f":{CONNECT_PORT}")]
        if not HOST_PATTERN.fullmatch(item):
            raise ValueError("EGRESS_ALLOWED_HOSTS holds an entry that is not a host name")
        if item not in entries:
            entries.append(item)
    if not entries:
        raise ValueError("EGRESS_ALLOWED_HOSTS is empty")
    if len(entries) > MAX_ALLOWED_HOSTS:
        raise ValueError("EGRESS_ALLOWED_HOSTS has too many entries")
    return tuple(entries)


def host_allowed(host: str, allowlist: Iterable[str]) -> bool:
    name = host.lower().rstrip(".")
    for entry in allowlist:
        if entry.startswith("*."):
            if name.endswith(entry[1:]) and len(name) > len(entry) - 1:
                return True
        elif name == entry:
            return True
    return False


def parse_connect_target(request_line: bytes, allowlist: Iterable[str]) -> tuple[str, int] | None:
    """The (host, port) of a well-formed CONNECT request to an allowlisted host on port 443, otherwise None."""
    try:
        method, authority, protocol = request_line.decode("ascii").strip().split(" ")
    except (UnicodeDecodeError, ValueError):
        return None
    if method != "CONNECT" or protocol not in {"HTTP/1.0", "HTTP/1.1"}:
        return None
    host, separator, port = authority.rpartition(":")
    if not separator or port != str(CONNECT_PORT) or not host:
        return None
    host = host.lower().rstrip(".")
    if not HOST_PATTERN.fullmatch(host) or not host_allowed(host, allowlist):
        return None
    return host, CONNECT_PORT


def parse_dns_servers(raw: str) -> tuple[str, ...]:
    """Comma-separated resolver addresses (IP literals only); raises ValueError for anything else."""
    servers: list[str] = []
    for part in raw.split(","):
        item = part.strip()
        if not item:
            continue
        try:
            ipaddress.ip_address(item)
        except ValueError:
            raise ValueError("EGRESS_DNS_SERVERS holds an entry that is not an IP address") from None
        if item not in servers:
            servers.append(item)
    if not servers:
        raise ValueError("EGRESS_DNS_SERVERS is empty")
    if len(servers) > MAX_DNS_SERVERS:
        raise ValueError("EGRESS_DNS_SERVERS has too many entries")
    return tuple(servers)


def _dns_name_end(packet: bytes, offset: int) -> int:
    """The offset just past a (possibly compressed) name that starts at `offset`."""
    while True:
        if offset >= len(packet):
            raise OSError("malformed DNS answer")
        length = packet[offset]
        if length & 0xC0 == 0xC0:
            return offset + 2
        if length & 0xC0:
            raise OSError("malformed DNS answer")
        offset += 1 + length
        if length == 0:
            return offset


def _dns_exchange(server: str, query: bytes, transaction: bytes) -> bytes:
    family = socket.AF_INET6 if ":" in server else socket.AF_INET
    with socket.socket(family, socket.SOCK_DGRAM) as udp:
        udp.settimeout(DNS_TIMEOUT_SECONDS)
        udp.connect((server, DNS_PORT))  # connected: datagrams from any other peer are dropped by the kernel
        udp.send(query)
        answer = udp.recv(4096)
    if len(answer) < 12 or answer[:2] != transaction:
        raise OSError("unexpected DNS answer")
    if answer[2] & 0x02:  # truncated: ask again over TCP, which has no size limit
        with socket.socket(family, socket.SOCK_STREAM) as tcp:
            tcp.settimeout(DNS_TIMEOUT_SECONDS)
            tcp.connect((server, DNS_PORT))
            tcp.sendall(struct.pack("!H", len(query)) + query)
            head = b""
            while len(head) < 2:
                piece = tcp.recv(2 - len(head))
                if not piece:
                    raise OSError("short DNS answer")
                head += piece
            wanted = struct.unpack("!H", head)[0]
            answer = b""
            while len(answer) < wanted:
                piece = tcp.recv(wanted - len(answer))
                if not piece:
                    raise OSError("short DNS answer")
                answer += piece
        if len(answer) < 12 or answer[:2] != transaction:
            raise OSError("unexpected DNS answer")
    return answer


def dns_lookup(host: str, record_type: int, server: str) -> list[str]:
    """The addresses in the answer section of one A (1) or AAAA (28) query to one resolver; raises OSError on a failure or a malformed answer."""
    transaction = secrets.token_bytes(2)
    labels = b"".join(bytes([len(label)]) + label.encode("ascii") for label in host.rstrip(".").split("."))
    question = labels + b"\x00" + struct.pack("!HH", record_type, 1)
    answer = _dns_exchange(server, transaction + struct.pack("!HHHHH", 0x0100, 1, 0, 0, 0) + question, transaction)
    if answer[3] & 0x0F:
        raise OSError("the resolver refused the lookup")
    questions, answers = struct.unpack("!HH", answer[4:8])
    offset = 12
    for _ in range(questions):
        offset = _dns_name_end(answer, offset) + 4
    found: list[str] = []
    for _ in range(answers):
        offset = _dns_name_end(answer, offset)
        if offset + 10 > len(answer):
            raise OSError("malformed DNS answer")
        kind, _klass, _ttl, length = struct.unpack("!HHIH", answer[offset:offset + 10])
        offset += 10
        data = answer[offset:offset + length]
        if len(data) != length:
            raise OSError("malformed DNS answer")
        offset += length
        if kind == 1 and length == 4 and record_type == 1:
            found.append(socket.inet_ntop(socket.AF_INET, data))
        elif kind == 28 and length == 16 and record_type == 28:
            found.append(socket.inet_ntop(socket.AF_INET6, data))
    return found


def resolve_direct(host: str, port: int) -> list:
    """getaddrinfo-shaped results from the configured resolvers (IPv4 first, IPv6 when the resolver has any); raises OSError when none answers."""
    if not DNS_SERVERS:
        raise OSError("no resolver is configured for this host")
    last_error: OSError | None = None
    for server in DNS_SERVERS:
        try:
            addresses = [(socket.AF_INET, ip) for ip in dns_lookup(host, 1, server)]
        except OSError as error:
            last_error = error
            continue
        try:
            addresses += [(socket.AF_INET6, ip) for ip in dns_lookup(host, 28, server)]
        except OSError:
            pass  # An IPv6 miss never hides the IPv4 answer.
        if addresses:
            return [(family, socket.SOCK_STREAM, 6, "", (ip, port) if family == socket.AF_INET else (ip, port, 0, 0)) for family, ip in addresses]
    raise last_error or OSError("no address found for the allowed host")


def resolve_upstream(host: str, port: int) -> list:
    if host in DIRECT_DNS_HOSTS:
        return resolve_direct(host, port)
    return RESOLVER(host, port, type=socket.SOCK_STREAM)


def connect_upstream(host: str, port: int = CONNECT_PORT) -> socket.socket:
    """Opens the upstream connection to the first globally routable address of `host`; raises OSError when there is none."""
    last_error: OSError | None = None
    for family, socktype, proto, _canonname, sockaddr in resolve_upstream(host, port):
        try:
            address = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            continue
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
    raise OSError("no public address for the allowed host")


def relay(left: socket.socket, right: socket.socket) -> None:
    # Blocking sockets with a timeout, not non-blocking ones: sendall on a non-blocking socket raises BlockingIOError as soon as the peer's buffer is full, which would drop the
    # tunnel under ordinary backpressure. With a timeout it waits for the peer to take the data.
    peers = {left: right, right: left}
    for peer in peers:
        peer.settimeout(SEND_TIMEOUT_SECONDS)
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
            try:
                peers[source].sendall(chunk)
            except OSError:
                return


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    allowlist: tuple[str, ...] = ()
    forward_host: str = ""


class ConnectHandler(socketserver.StreamRequestHandler):
    server: Server

    def handle(self) -> None:
        request_line = self.rfile.readline(MAX_HEADER_BYTES + 1)
        target = None if len(request_line) > MAX_HEADER_BYTES else parse_connect_target(request_line, self.server.allowlist)
        if target is None:
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
            upstream = connect_upstream(*target)
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            relay(self.connection, upstream)
        except OSError:
            try:
                self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
        finally:
            if upstream is not None:
                upstream.close()


class PassthroughHandler(socketserver.BaseRequestHandler):
    server: Server

    def handle(self) -> None:
        upstream: socket.socket | None = None
        try:
            upstream = connect_upstream(self.server.forward_host, CONNECT_PORT)
            relay(self.request, upstream)
        except OSError:
            pass
        finally:
            if upstream is not None:
                upstream.close()


def build_servers(allowlist: tuple[str, ...], bind: str, proxy_port: int, portal_host: str, portal_port: int) -> list[Server]:
    # Checked before anything is bound, so a refusal leaves no listening socket behind.
    if portal_host and (portal_host.startswith("*.") or not host_allowed(portal_host, allowlist)):
        raise ValueError("EGRESS_PORTAL_HOST must be one of the allowed hosts")
    proxy = Server((bind, proxy_port), ConnectHandler)
    proxy.allowlist = allowlist
    servers = [proxy]
    if portal_host:
        try:
            passthrough = Server((bind, portal_port), PassthroughHandler)
        except OSError:
            proxy.server_close()
            raise
        passthrough.allowlist = allowlist
        passthrough.forward_host = portal_host
        servers.append(passthrough)
    return servers


def configure_from_environment(portal_host: str) -> None:
    """Sets the idle limit and, when a portal host is published as an alias, the direct resolvers that name is looked up with."""
    global IDLE_TIMEOUT_SECONDS, DIRECT_DNS_HOSTS, DNS_SERVERS
    raw_idle = os.environ.get("EGRESS_IDLE_TIMEOUT_SECONDS", "").strip()
    if raw_idle:
        if not raw_idle.isdigit() or not IDLE_TIMEOUT_LIMITS[0] <= int(raw_idle) <= IDLE_TIMEOUT_LIMITS[1]:
            raise ValueError("EGRESS_IDLE_TIMEOUT_SECONDS is outside the allowed range")
        IDLE_TIMEOUT_SECONDS = int(raw_idle)
    if portal_host:
        DNS_SERVERS = parse_dns_servers(os.environ.get("EGRESS_DNS_SERVERS", ""))
        DIRECT_DNS_HOSTS = frozenset({portal_host})


def main() -> int:
    try:
        allowlist = parse_allowlist(os.environ.get("EGRESS_ALLOWED_HOSTS", ""))
        portal_host = os.environ.get("EGRESS_PORTAL_HOST", "").strip().lower().rstrip(".")
        if portal_host and not HOST_PATTERN.fullmatch(portal_host):
            raise ValueError("EGRESS_PORTAL_HOST is not a host name")
        configure_from_environment(portal_host)
        servers = build_servers(
            allowlist,
            os.environ.get("EGRESS_BIND", "0.0.0.0"),
            int(os.environ.get("EGRESS_PROXY_PORT", "3128")),
            portal_host,
            int(os.environ.get("EGRESS_PORTAL_PORT", "443")),
        )
    except (ValueError, OSError) as error:
        print(f"egress proxy not started: {error}", file=sys.stderr)
        return 2
    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, kwargs={"poll_interval": 0.25}, daemon=True).start()
    with servers[0] as primary:
        primary.serve_forever(poll_interval=0.25)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
