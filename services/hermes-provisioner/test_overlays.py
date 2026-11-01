"""Tests for the optional compose overlays (compose.tunnel.yaml, compose.egress.yaml), the allowlist egress proxy and the repository .dockerignore.

Pure YAML and Python: no Docker, no network. The overlays are merged over compose.client.yaml the way Compose merges them (maps merge key by key, a list in the overlay replaces the base list),
so what is asserted is the shape the daemon would receive.
"""
from __future__ import annotations

import re
import socket
import struct
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import yaml

import egress_proxy

ROOT = Path(__file__).parent
REPO = ROOT.parent.parent

SECRET_NAME = re.compile(r"(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)", re.I)


def load(name: str) -> dict:
    return yaml.safe_load((ROOT / name).read_text(encoding="utf-8"))


def merge(base: dict, overlay: dict) -> dict:
    result = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = value
    return result


def network_names(service: dict) -> list[str]:
    networks = service.get("networks", [])
    return list(networks) if isinstance(networks, (list, dict)) else []


def mounts(service: dict) -> list[dict]:
    return [mount for mount in service.get("volumes", []) if isinstance(mount, dict)]


class TunnelOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / "compose.tunnel.yaml").read_text(encoding="utf-8")
        cls.overlay = yaml.safe_load(cls.text)
        cls.base = load("compose.client.yaml")
        cls.merged = merge(cls.base, cls.overlay)
        cls.tunnel = cls.overlay["services"]["cloudflared"]

    def test_the_connector_publishes_no_port_and_mounts_exactly_its_token_file_read_only(self):
        self.assertNotIn("ports", self.tunnel)
        self.assertNotIn("expose", self.tunnel)
        self.assertEqual(len(mounts(self.tunnel)), 1)
        self.assertEqual(len(self.tunnel["volumes"]), 1, "no short-syntax mount sneaks in beside the token file")
        token = mounts(self.tunnel)[0]
        self.assertEqual((token["type"], token["target"], token["read_only"]), ("bind", "/run/secrets/tunnel_token", True))
        self.assertTrue(token["source"].startswith("${CLOUDFLARED_TOKEN_FILE:?"), "the source is a variable naming one private file, never a host directory")

    def test_it_joins_exactly_the_private_network_and_its_own_egress_bridge(self):
        self.assertEqual(self.tunnel["networks"], ["hermes_private", "tunnel_egress"])
        self.assertEqual(set(self.overlay["networks"]), {"hermes_private", "tunnel_egress"})
        self.assertIs(self.merged["networks"]["hermes_private"]["internal"], True)
        self.assertNotIn("internal", self.overlay["networks"]["tunnel_egress"])
        self.assertEqual(self.overlay["networks"]["tunnel_egress"]["driver"], "bridge")
        self.assertEqual(self.overlay["networks"]["hermes_private"]["name"], self.base["networks"]["hermes_private"]["name"])
        self.assertNotIn("network_mode", self.tunnel)

    def test_no_secret_is_in_the_environment_the_command_line_or_the_file(self):
        env = self.tunnel.get("environment", {})
        self.assertEqual({name for name in env if SECRET_NAME.search(name)}, set())
        command = " ".join(self.tunnel["command"])
        self.assertIn("--token-file /run/secrets/tunnel_token", command)
        self.assertNotRegex(command, r"--token(?!-file)")
        self.assertNotIn("TUNNEL_TOKEN", self.text.replace("tunnel_token", ""))
        self.assertNotRegex(self.text, r"eyJ[A-Za-z0-9_-]{10,}")

    def test_it_is_unprivileged_read_only_limited_and_pinned(self):
        self.assertTrue(self.tunnel["read_only"])
        self.assertEqual(self.tunnel["cap_drop"], ["ALL"])
        self.assertNotIn("cap_add", self.tunnel)
        self.assertIn("no-new-privileges:true", self.tunnel["security_opt"])
        self.assertEqual(self.tunnel["user"], "65532:65532")
        self.assertNotIn("privileged", self.tunnel)
        self.assertNotIn("devices", self.tunnel)
        self.assertNotIn("docker.sock", self.text)
        self.assertEqual(self.tunnel["restart"], "unless-stopped")
        for key in ("mem_limit", "cpus", "pids_limit", "logging", "healthcheck", "stop_grace_period"):
            self.assertIn(key, self.tunnel)
        self.assertGreater(self.tunnel["pids_limit"], 0)
        # A tag is refused at interpolation time: the image variable has no default.
        self.assertRegex(self.tunnel["image"], r"^\$\{IACQUIRE_CLOUDFLARED_IMAGE:\?")
        self.assertNotIn(":-", self.tunnel["image"])

    def test_the_connector_waits_for_a_healthy_gateway_and_the_merged_stack_still_publishes_nothing(self):
        self.assertEqual(self.tunnel["depends_on"]["hermes-client"]["condition"], "service_healthy")
        self.assertEqual(set(self.merged["services"]), set(self.base["services"]) | {"cloudflared"})
        for name, service in self.merged["services"].items():
            self.assertNotIn("ports", service, name)
            self.assertNotIn("privileged", service, name)
        # The gateway's own definition is untouched by the overlay.
        self.assertEqual(self.merged["services"]["hermes-client"], self.base["services"]["hermes-client"])
        self.assertEqual(self.merged["services"]["hermes-provisioner"], self.base["services"]["hermes-provisioner"])


class EgressOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / "compose.egress.yaml").read_text(encoding="utf-8")
        cls.overlay = yaml.safe_load(cls.text)
        cls.base = load("compose.client.yaml")
        cls.merged = merge(cls.base, cls.overlay)
        cls.proxy = cls.overlay["services"]["egress-proxy"]

    def networks(self) -> dict:
        return self.merged["networks"]

    def test_the_client_network_is_internal_and_only_the_proxy_touches_a_non_internal_network(self):
        self.assertIs(self.networks()["client_egress"]["internal"], True)
        self.assertIs(self.networks()["hermes_private"]["internal"], True)
        external = {name for name, network in self.networks().items() if not network.get("internal")}
        self.assertEqual(external, {"proxy_upstream"})
        reaching_outside = {
            name for name, service in self.merged["services"].items()
            if any(net in external for net in network_names(service))
        }
        self.assertEqual(reaching_outside, {"egress-proxy"})
        # Services that share another's network (the worker) or have none cannot add a route of their own.
        self.assertEqual(self.merged["services"]["hermes-provisioner"]["network_mode"], "service:hermes-client")
        for name in ("init-hermes-home", "init-worker-home"):
            self.assertEqual(self.merged["services"][name]["network_mode"], "none")
        self.assertEqual(network_names(self.merged["services"]["hermes-client"]), ["client_egress", "hermes_private"])

    def test_the_proxy_is_the_only_new_service_publishes_nothing_and_mounts_only_its_script(self):
        self.assertEqual(set(self.overlay["services"]), {"egress-proxy", "hermes-client"})
        self.assertNotIn("ports", self.proxy)
        for name, service in self.merged["services"].items():
            self.assertNotIn("ports", service, name)
        files = mounts(self.proxy)
        self.assertEqual(len(self.proxy["volumes"]), 1)
        self.assertEqual((files[0]["type"], files[0]["target"], files[0]["read_only"]), ("bind", "/opt/iacquire-egress/egress_proxy.py", True))
        self.assertEqual(files[0]["source"], "./egress_proxy.py")
        self.assertTrue((ROOT / "egress_proxy.py").is_file())
        self.assertEqual(self.proxy["entrypoint"], ["/opt/hermes/.venv/bin/python", "/opt/iacquire-egress/egress_proxy.py"])

    def test_the_proxy_is_unprivileged_and_the_overlay_carries_no_secret(self):
        self.assertTrue(self.proxy["read_only"])
        self.assertEqual(self.proxy["user"], "10000:10000")
        self.assertEqual(self.proxy["cap_drop"], ["ALL"])
        self.assertNotIn("cap_add", self.proxy)
        self.assertIn("no-new-privileges:true", self.proxy["security_opt"])
        self.assertEqual(self.proxy["sysctls"], {"net.ipv4.ip_unprivileged_port_start": "0"})
        self.assertEqual({name for name in self.proxy["environment"] if SECRET_NAME.search(name)}, set())
        self.assertEqual({name for name in self.overlay["services"]["hermes-client"]["environment"] if SECRET_NAME.search(name)}, set())
        for key in ("mem_limit", "cpus", "pids_limit", "logging", "healthcheck"):
            self.assertIn(key, self.proxy)
        self.assertNotIn("docker.sock", self.text)
        # The allowlist has no default: an operator must name the hosts, or Compose refuses to start the stack.
        self.assertRegex(self.proxy["environment"]["EGRESS_ALLOWED_HOSTS"], r"^\$\{IACQUIRE_EGRESS_ALLOWED_HOSTS:\?")

    def test_the_portal_answers_to_its_own_name_on_the_internal_network_and_the_gateway_uses_the_proxy(self):
        aliases = self.proxy["networks"]["client_egress"]["aliases"]
        self.assertEqual(len(aliases), 1)
        self.assertRegex(aliases[0], r"^\$\{IACQUIRE_EGRESS_PORTAL_HOST:\?")
        self.assertEqual(set(self.proxy["networks"]), {"client_egress", "proxy_upstream"})
        gateway = self.merged["services"]["hermes-client"]
        self.assertEqual(gateway["environment"]["HTTPS_PROXY"], "http://egress-proxy:3128")
        self.assertIn("127.0.0.1", gateway["environment"]["NO_PROXY"])
        # The merge keeps everything the base gateway already had, including its initialiser dependency.
        self.assertEqual(gateway["environment"]["GATEWAY_MULTIPLEX_PROFILES"], "true")
        self.assertEqual(gateway["depends_on"]["init-hermes-home"]["condition"], "service_completed_successfully")
        self.assertEqual(gateway["depends_on"]["egress-proxy"]["condition"], "service_healthy")

    def test_the_two_overlays_together_do_not_open_a_second_path_out(self):
        both = merge(self.merged, yaml.safe_load((ROOT / "compose.tunnel.yaml").read_text(encoding="utf-8")))
        external = {name for name, network in both["networks"].items() if not network.get("internal")}
        self.assertEqual(external, {"proxy_upstream", "tunnel_egress"})
        reaching_outside = {name for name, service in both["services"].items() if any(net in external for net in network_names(service))}
        self.assertEqual(reaching_outside, {"egress-proxy", "cloudflared"})


class AllowlistParsingTests(unittest.TestCase):
    def test_accepts_names_wildcards_and_the_default_port_and_drops_duplicates(self):
        self.assertEqual(
            egress_proxy.parse_allowlist(" API.OpenAI.com , portal.example.com:443, *.search.example.com,api.openai.com. ,"),
            ("api.openai.com", "portal.example.com", "*.search.example.com"),
        )

    def test_refuses_anything_that_is_not_a_plain_host_name(self):
        for bad in ("", " , ", "10.0.0.1", "[::1]", "localhost", "example", "*.com.", "*", "*.", "exa mple.com", "example.com:8443", "https://example.com", "user@example.com", "example..com", "-bad.example.com", "a.b.123"):
            with self.assertRaises(ValueError, msg=bad):
                egress_proxy.parse_allowlist(bad)
        with self.assertRaises(ValueError):
            egress_proxy.parse_allowlist(",".join(f"h{i}.example.com" for i in range(egress_proxy.MAX_ALLOWED_HOSTS + 1)))

    def test_matching_is_exact_for_names_and_below_the_dot_for_wildcards(self):
        allow = egress_proxy.parse_allowlist("api.example.com,*.search.example.org")
        for good in ("api.example.com", "API.EXAMPLE.COM", "api.example.com.", "a.search.example.org", "a.b.search.example.org"):
            self.assertTrue(egress_proxy.host_allowed(good, allow), good)
        for bad in ("example.com", "evil-api.example.com", "api.example.com.evil.com", "xapi.example.com", "search.example.org", "evilsearch.example.org", "x.search.example.org.evil.net", "10.0.0.1", ""):
            self.assertFalse(egress_proxy.host_allowed(bad, allow), bad)

    def test_a_connect_request_must_name_an_allowlisted_host_on_443_exactly(self):
        allow = ("api.example.com", "*.search.example.org")
        ok = egress_proxy.parse_connect_target
        self.assertEqual(ok(b"CONNECT api.example.com:443 HTTP/1.1\r\n", allow), ("api.example.com", 443))
        self.assertEqual(ok(b"CONNECT API.example.com.:443 HTTP/1.0\r\n", allow), ("api.example.com", 443))
        self.assertEqual(ok(b"CONNECT x.search.example.org:443 HTTP/1.1\r\n", allow), ("x.search.example.org", 443))
        for bad in (
            b"CONNECT api.example.com:80 HTTP/1.1\r\n", b"CONNECT api.example.com:8443 HTTP/1.1\r\n", b"CONNECT api.example.com HTTP/1.1\r\n",
            b"CONNECT 127.0.0.1:443 HTTP/1.1\r\n", b"CONNECT [::1]:443 HTTP/1.1\r\n", b"CONNECT 169.254.169.254:443 HTTP/1.1\r\n", b"CONNECT other.example.com:443 HTTP/1.1\r\n",
            b"CONNECT user@api.example.com:443 HTTP/1.1\r\n", b"GET http://api.example.com/ HTTP/1.1\r\n", b"CONNECT api.example.com:443 HTTP/2\r\n", b"CONNECT api.example.com:443\r\n",
            b"CONNECT \xff.example.com:443 HTTP/1.1\r\n", b"",
        ):
            self.assertIsNone(ok(bad, allow), bad)


class FakeSocket:
    connected: list[tuple] = []

    def __init__(self, family, socktype, proto):
        self.closed = False

    def settimeout(self, _value):
        pass

    def connect(self, address):
        FakeSocket.connected.append(address)

    def close(self):
        self.closed = True


def addr(ip: str, family=socket.AF_INET):
    return (family, socket.SOCK_STREAM, 6, "", (ip, 443))


class UpstreamSelectionTests(unittest.TestCase):
    def test_private_loopback_link_local_and_metadata_addresses_are_never_connected(self):
        for ip in ("10.0.0.5", "172.16.3.4", "192.168.1.9", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"):
            FakeSocket.connected = []
            with mock.patch.object(egress_proxy, "RESOLVER", lambda *a, **k: [addr(ip)]), mock.patch.object(egress_proxy.socket, "socket", FakeSocket):
                with self.assertRaises(OSError, msg=ip):
                    egress_proxy.connect_upstream("api.example.com")
            self.assertEqual(FakeSocket.connected, [], ip)

    def test_ipv6_private_and_mapped_addresses_are_refused_too(self):
        for ip in ("::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"):
            FakeSocket.connected = []
            with mock.patch.object(egress_proxy, "RESOLVER", lambda *a, **k: [addr(ip, socket.AF_INET6)]), mock.patch.object(egress_proxy.socket, "socket", FakeSocket):
                with self.assertRaises(OSError, msg=ip):
                    egress_proxy.connect_upstream("api.example.com")
            self.assertEqual(FakeSocket.connected, [], ip)

    def test_a_name_that_resolves_to_a_private_and_a_public_address_uses_only_the_public_one(self):
        FakeSocket.connected = []
        with mock.patch.object(egress_proxy, "RESOLVER", lambda *a, **k: [addr("10.0.0.5"), addr("93.184.216.34")]), mock.patch.object(egress_proxy.socket, "socket", FakeSocket):
            upstream = egress_proxy.connect_upstream("api.example.com")
        self.assertEqual(FakeSocket.connected, [("93.184.216.34", 443)])
        self.assertIsInstance(upstream, FakeSocket)


class ProxyRoundTripTests(unittest.TestCase):
    """Real sockets on loopback: the handler's behaviour, with only the upstream connection replaced."""

    def serve(self, server):
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def echo_server(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(4)
        self.addCleanup(listener.close)

        def run():
            while True:
                try:
                    conn, _ = listener.accept()
                except OSError:
                    return
                with conn:
                    data = conn.recv(1024)
                    conn.sendall(b"echo:" + data)

        threading.Thread(target=run, daemon=True).start()
        return listener.getsockname()

    def exchange(self, port: int, payload: bytes, second: bytes = b"") -> bytes:
        with socket.create_connection(("127.0.0.1", port), timeout=5) as client:
            client.sendall(payload)
            first = client.recv(4096)
            if second:
                client.sendall(second)
                first += client.recv(4096)
            return first

    def proxy(self, allowlist=("api.example.com",)):
        server = egress_proxy.Server(("127.0.0.1", 0), egress_proxy.ConnectHandler)
        server.allowlist = tuple(allowlist)
        return self.serve(server)

    def test_a_host_that_is_not_on_the_list_gets_403_and_nothing_is_dialled(self):
        port = self.proxy()
        with mock.patch.object(egress_proxy, "connect_upstream", side_effect=AssertionError("must not be dialled")):
            for target in (b"blocked.example.com:443", b"127.0.0.1:443", b"api.example.com:80", b"169.254.169.254:443"):
                reply = self.exchange(port, b"CONNECT " + target + b" HTTP/1.1\r\nHost: x\r\n\r\n")
                self.assertTrue(reply.startswith(b"HTTP/1.1 403"), target)

    def test_an_allowed_host_that_resolves_to_a_private_address_gets_502(self):
        port = self.proxy()
        with mock.patch.object(egress_proxy, "RESOLVER", lambda *a, **k: [addr("10.1.2.3")]):
            reply = self.exchange(port, b"CONNECT api.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertTrue(reply.startswith(b"HTTP/1.1 502"))

    def test_an_allowed_host_is_tunnelled_and_bytes_flow_both_ways(self):
        upstream_address = self.echo_server()
        port = self.proxy()
        with mock.patch.object(egress_proxy, "connect_upstream", lambda host, port=443: socket.create_connection(upstream_address, timeout=5)):
            reply = self.exchange(port, b"CONNECT api.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n", second=b"hello")
        self.assertTrue(reply.startswith(b"HTTP/1.1 200 Connection Established\r\n\r\n"))
        self.assertTrue(reply.endswith(b"echo:hello"))

    def test_an_oversized_request_line_is_refused(self):
        port = self.proxy()
        reply = self.exchange(port, b"CONNECT " + b"a" * 9000 + b".example.com:443 HTTP/1.1\r\n\r\n")
        self.assertTrue(reply.startswith(b"HTTP/1.1 403"))

    def test_the_portal_passthrough_forwards_only_to_its_one_host(self):
        upstream_address = self.echo_server()
        servers = egress_proxy.build_servers(("portal.example.com", "api.example.com"), "127.0.0.1", 0, "portal.example.com", 0)
        self.assertEqual(len(servers), 2)
        self.addCleanup(servers[0].server_close)
        passthrough = servers[1]
        self.assertEqual(passthrough.forward_host, "portal.example.com")
        dialled: list[str] = []

        def dial(host, port=443):
            dialled.append(host)
            return socket.create_connection(upstream_address, timeout=5)

        listen_port = self.serve(passthrough)
        with mock.patch.object(egress_proxy, "connect_upstream", dial):
            with socket.create_connection(("127.0.0.1", listen_port), timeout=5) as client:
                client.sendall(b"tls-hello")
                self.assertEqual(client.recv(1024), b"echo:tls-hello")
        self.assertEqual(dialled, ["portal.example.com"])

    def test_the_portal_host_must_be_on_the_list_and_cannot_be_a_wildcard(self):
        with self.assertRaises(ValueError):
            egress_proxy.build_servers(("api.example.com",), "127.0.0.1", 0, "portal.example.com", 0)
        with self.assertRaises(ValueError):
            egress_proxy.build_servers(("*.example.com",), "127.0.0.1", 0, "*.example.com", 0)


def dns_answer(query: bytes, addresses: list[str], rcode: int = 0, transaction: bytes | None = None, with_cname: bool = True) -> bytes:
    """A resolver reply to `query` (one question): an optional CNAME first, then one A record per address, all owned by a compressed pointer to the question name."""
    question = query[12:]
    qtype = struct.unpack("!H", question[-4:-2])[0]
    records = b""
    if qtype == 1 and addresses:
        if with_cname:
            target = b"\x04edge\x07example\x03net\x00"
            records += b"\xc0\x0c" + struct.pack("!HHIH", 5, 1, 60, len(target)) + target
        for ip in addresses:
            records += b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + socket.inet_aton(ip)
    count = (len(addresses) + (1 if with_cname else 0)) if records else 0
    return (transaction or query[:2]) + struct.pack("!HHHHH", 0x8180 | rcode, 1, count, 0, 0) + question + records


class DirectResolutionTests(unittest.TestCase):
    """The portal name is an alias of the proxy itself, so Docker's DNS would answer it with a private address: it is looked up directly instead."""

    def dns_server(self, reply) -> int:
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.bind(("127.0.0.1", 0))
        udp.settimeout(5)
        self.addCleanup(udp.close)

        def run():
            while True:
                try:
                    query, peer = udp.recvfrom(512)
                except OSError:
                    return
                answer = reply(query)
                if answer is not None:
                    udp.sendto(answer, peer)

        threading.Thread(target=run, daemon=True).start()
        return udp.getsockname()[1]

    def configure(self, port: int, hosts=("portal.example.com",), servers=("127.0.0.1",)):
        for name, value in (("DNS_PORT", port), ("DIRECT_DNS_HOSTS", frozenset(hosts)), ("DNS_SERVERS", tuple(servers)), ("DNS_TIMEOUT_SECONDS", 1)):
            patcher = mock.patch.object(egress_proxy, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_the_portal_name_is_resolved_by_a_direct_query_even_when_the_container_dns_answers_with_its_own_address(self):
        self.configure(self.dns_server(lambda query: dns_answer(query, ["93.184.216.34"])))
        # What Docker's embedded DNS does inside the proxy: the portal alias answers with the proxy's own private address.
        own_address = mock.Mock(side_effect=lambda *a, **k: [addr("172.20.0.2")])
        FakeSocket.connected = []
        with mock.patch.object(egress_proxy, "RESOLVER", own_address), mock.patch.object(egress_proxy.socket, "socket", FakeSocketWithDatagrams):
            upstream = egress_proxy.connect_upstream("portal.example.com")
        self.assertIsInstance(upstream, FakeSocketWithDatagrams)
        self.assertEqual(FakeSocket.connected, [("93.184.216.34", 443)])
        own_address.assert_not_called()

    def test_every_other_name_still_uses_the_container_resolver_and_the_direct_resolver_is_not_asked(self):
        self.configure(self.dns_server(lambda query: self.fail("the direct resolver must not be asked")))
        FakeSocket.connected = []
        with mock.patch.object(egress_proxy, "RESOLVER", lambda *a, **k: [addr("93.184.216.35")]), mock.patch.object(egress_proxy.socket, "socket", FakeSocket):
            egress_proxy.connect_upstream("api.example.com")
        self.assertEqual(FakeSocket.connected, [("93.184.216.35", 443)])

    def test_a_private_answer_from_the_direct_resolver_is_still_refused(self):
        self.configure(self.dns_server(lambda query: dns_answer(query, ["10.0.0.9"], with_cname=False)))
        FakeSocket.connected = []
        with mock.patch.object(egress_proxy.socket, "socket", FakeSocketWithDatagrams):
            with self.assertRaises(OSError):
                egress_proxy.connect_upstream("portal.example.com")
        self.assertEqual(FakeSocket.connected, [])

    def test_a_refusal_a_wrong_transaction_and_a_missing_name_are_errors_not_addresses(self):
        for label, reply in (
            ("nxdomain", lambda query: dns_answer(query, [], rcode=3)),
            ("wrong transaction", lambda query: dns_answer(query, ["93.184.216.34"], transaction=b"\x00\x00" if query[:2] != b"\x00\x00" else b"\x00\x01")),
            ("truncated garbage", lambda query: query[:2] + b"\x81\x80\x00"),
            ("silence", lambda query: None),
        ):
            self.configure(self.dns_server(reply))
            with self.assertRaises(OSError, msg=label):
                egress_proxy.resolve_direct("portal.example.com", 443)

    def test_it_tries_the_next_resolver_when_the_first_one_fails(self):
        # The same loopback server listens for both entries; it ignores the first A query it sees (a dead resolver) and answers the rest.
        seen: list[int] = []

        def reply(query: bytes):
            qtype = struct.unpack("!H", query[-4:-2])[0]
            seen.append(qtype)
            if seen == [1]:
                return None
            return dns_answer(query, ["93.184.216.36"])

        self.configure(self.dns_server(reply), servers=("127.0.0.1", "127.0.0.1"))
        self.assertEqual([entry[4][0] for entry in egress_proxy.resolve_direct("portal.example.com", 443)], ["93.184.216.36"])
        self.assertEqual(seen[:2], [1, 1])

    def test_resolver_addresses_are_validated(self):
        self.assertEqual(egress_proxy.parse_dns_servers(" 1.1.1.1, 9.9.9.9 ,1.1.1.1,"), ("1.1.1.1", "9.9.9.9"))
        for bad in ("", "dns.example.com", "1.1.1.1;rm", ",".join(f"10.0.0.{i}" for i in range(egress_proxy.MAX_DNS_SERVERS + 1))):
            with self.assertRaises(ValueError, msg=bad):
                egress_proxy.parse_dns_servers(bad)


class FakeSocketWithDatagrams(FakeSocket):
    """FakeSocket for the upstream connection, with real sockets still available for the DNS exchange (a datagram socket is the only other kind the proxy opens)."""

    def __new__(cls, family=socket.AF_INET, socktype=socket.SOCK_STREAM, proto=0):
        if socktype == socket.SOCK_DGRAM:
            return REAL_SOCKET(family, socktype, proto)
        return super().__new__(cls)


REAL_SOCKET = socket.socket


class RelayTests(unittest.TestCase):
    """The tunnel survives a quiet model call and a slow reader; it is only cut after the configured silence."""

    def pair(self):
        a_client, a_proxy = socket.socketpair()
        b_proxy, b_server = socket.socketpair()
        for sock in (a_client, a_proxy, b_proxy, b_server):
            self.addCleanup(sock.close)
        thread = threading.Thread(target=egress_proxy.relay, args=(a_proxy, b_proxy), daemon=True)
        thread.start()
        return a_client, b_server, thread

    def test_a_pause_shorter_than_the_idle_limit_does_not_cut_the_tunnel(self):
        with mock.patch.object(egress_proxy, "IDLE_TIMEOUT_SECONDS", 3):
            client, server, thread = self.pair()
            client.sendall(b"request")
            self.assertEqual(server.recv(100), b"request")
            time.sleep(1.5)  # the provider is silent, longer than the old 30 s limit scaled down
            server.sendall(b"late answer")
            client.settimeout(5)
            self.assertEqual(client.recv(100), b"late answer")
            self.assertTrue(thread.is_alive())

    def test_silence_longer_than_the_idle_limit_ends_the_tunnel(self):
        with mock.patch.object(egress_proxy, "IDLE_TIMEOUT_SECONDS", 1):
            client, server, thread = self.pair()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())

    def test_a_large_upload_to_a_slow_reader_arrives_whole(self):
        total = 12 * 1024 * 1024
        with mock.patch.object(egress_proxy, "IDLE_TIMEOUT_SECONDS", 30):
            client, server, thread = self.pair()
            received = bytearray()

            def slow_reader():
                time.sleep(1.0)  # the reader is not draining while the sender fills every buffer on the way
                server.settimeout(10)
                while len(received) < total:
                    chunk = server.recv(256 * 1024)
                    if not chunk:
                        return
                    received.extend(chunk)

            reader = threading.Thread(target=slow_reader, daemon=True)
            reader.start()
            client.settimeout(30)
            client.sendall(b"x" * total)
            reader.join(timeout=30)
            self.assertEqual(len(received), total)

    def test_the_idle_limit_is_configurable_within_bounds(self):
        base = {"EGRESS_ALLOWED_HOSTS": "api.example.com"}
        with mock.patch.object(egress_proxy, "IDLE_TIMEOUT_SECONDS", egress_proxy.IDLE_TIMEOUT_SECONDS):
            with mock.patch.dict("os.environ", {**base, "EGRESS_IDLE_TIMEOUT_SECONDS": "900"}, clear=True):
                egress_proxy.configure_from_environment("")
                self.assertEqual(egress_proxy.IDLE_TIMEOUT_SECONDS, 900)
            for bad in ("5", "99999", "abc", "-1"):
                with mock.patch.dict("os.environ", {**base, "EGRESS_IDLE_TIMEOUT_SECONDS": bad}, clear=True):
                    with self.assertRaises(ValueError, msg=bad):
                        egress_proxy.configure_from_environment("")
        self.assertGreaterEqual(egress_proxy.IDLE_TIMEOUT_SECONDS, 300)


class ProxyStartupTests(unittest.TestCase):
    def test_a_portal_host_needs_direct_resolvers_or_the_proxy_does_not_start(self):
        env = {"EGRESS_ALLOWED_HOSTS": "api.example.com,portal.example.com", "EGRESS_PORTAL_HOST": "portal.example.com", "EGRESS_BIND": "127.0.0.1", "EGRESS_PROXY_PORT": "0"}
        for value in (None, "", "not-an-ip"):
            values = dict(env) if value is None else {**env, "EGRESS_DNS_SERVERS": value}
            with mock.patch.dict("os.environ", values, clear=True), mock.patch("sys.stderr"):
                self.assertEqual(egress_proxy.main(), 2, value)

    def test_the_overlay_hands_the_proxy_resolvers_and_an_idle_limit_and_room_for_long_tunnels(self):
        overlay = load("compose.egress.yaml")["services"]["egress-proxy"]
        self.assertRegex(overlay["environment"]["EGRESS_DNS_SERVERS"], r"^\$\{IACQUIRE_EGRESS_DNS_SERVERS:-1\.1\.1\.1,9\.9\.9\.9\}$")
        self.assertRegex(overlay["environment"]["EGRESS_IDLE_TIMEOUT_SECONDS"], r"^\$\{IACQUIRE_EGRESS_IDLE_TIMEOUT_SECONDS:-(\d+)\}$")
        self.assertGreaterEqual(overlay["pids_limit"], 128)

    def test_it_does_not_start_without_a_valid_allowlist(self):
        for value in ("", "10.0.0.1", "example.com:8443"):
            with mock.patch.dict("os.environ", {"EGRESS_ALLOWED_HOSTS": value}, clear=True), mock.patch("sys.stderr"):
                self.assertEqual(egress_proxy.main(), 2, value)

    def test_it_does_not_start_with_a_portal_host_outside_the_list(self):
        env = {"EGRESS_ALLOWED_HOSTS": "api.example.com", "EGRESS_PORTAL_HOST": "portal.example.com", "EGRESS_BIND": "127.0.0.1", "EGRESS_PROXY_PORT": "0"}
        with mock.patch.dict("os.environ", env, clear=True), mock.patch("sys.stderr"):
            self.assertEqual(egress_proxy.main(), 2)

    def test_the_script_keeps_no_log_of_destinations_and_runs_on_the_images_python(self):
        body = (ROOT / "egress_proxy.py").read_text(encoding="utf-8")
        self.assertNotRegex(body, r"\blogging\b|print\(.*(host|target|authority)")
        self.assertTrue(body.startswith("#!/usr/bin/env python3\n"))
        self.assertNotIn(b"\r\n", (ROOT / "egress_proxy.py").read_bytes())


def dockerignore_rules() -> list[tuple[bool, re.Pattern[str]]]:
    rules: list[tuple[bool, re.Pattern[str]]] = []
    for raw in (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negate = line.startswith("!")
        pattern = line.lstrip("!").strip("/")
        out, i = "", 0
        while i < len(pattern):
            if pattern.startswith("**/", i):
                out += "(?:.*/)?"
                i += 3
            elif pattern.startswith("**", i):
                out += ".*"
                i += 2
            elif pattern[i] == "*":
                out += "[^/]*"
                i += 1
            elif pattern[i] == "?":
                out += "[^/]"
                i += 1
            else:
                out += re.escape(pattern[i])
                i += 1
        rules.append((negate, re.compile(f"^{out}$")))
    return rules


def ignored(path: str) -> bool:
    """Docker's rule: the last pattern that matches the path or one of its parent directories decides."""
    parts = path.strip("/").split("/")
    prefixes = ["/".join(parts[: i + 1]) for i in range(len(parts))]
    state = False
    for negate, pattern in dockerignore_rules():
        if any(pattern.match(prefix) for prefix in prefixes):
            state = not negate
    return state


class DockerignoreTests(unittest.TestCase):
    def test_local_environment_files_and_the_app_never_reach_the_build_context(self):
        for path in (".env", ".env.local", ".env.development", ".env.staging.example", "src/server/env.ts", "supabase/migrations/0001_x.sql", "node_modules/next/index.js",
                     "docs/x.md", ".git/config", "certs/dev.pem", "package.json", "tests/support/launch.ts", ".claude/settings.json"):
            self.assertTrue(ignored(path), path)

    def test_environment_files_keys_and_caches_are_left_out_even_inside_the_service_folders(self):
        for path in ("services/hermes-provisioner/.env", "services/hermes-provisioner/.env.local", "services/hermes-provisioner/secrets/hermes-api-key",
                     "services/hermes-provisioner/id.pem", "services/hermes-inference-worker/tls.key", "services/hermes-provisioner/__pycache__/worker.cpython-311.pyc",
                     "services/hermes-provisioner/catalog-overlay-v0225/.env"):
            self.assertTrue(ignored(path), path)

    def test_every_file_a_dockerfile_copies_stays_in_the_context(self):
        sources: list[str] = []
        for dockerfile in (ROOT / "Dockerfile", REPO / "services" / "hermes-inference-worker" / "Dockerfile"):
            for line in dockerfile.read_text(encoding="utf-8").splitlines():
                if line.startswith("COPY "):
                    sources.extend(token for token in line.split()[1:-1] if not token.startswith("--"))
        self.assertGreaterEqual(len(sources), 8)
        for source in sources:
            self.assertTrue((REPO / source).exists(), source)
            self.assertFalse(ignored(source), source)
            if (REPO / source).is_dir():
                for child in (REPO / source).rglob("*"):
                    if child.is_file() and "__pycache__" not in child.parts:
                        self.assertFalse(ignored(child.relative_to(REPO).as_posix()), child)

    def test_the_example_env_file_and_the_compose_files_are_not_lost(self):
        for path in ("services/hermes-provisioner/client.env.example", "services/hermes-provisioner/compose.client.yaml", "services/hermes-provisioner/worker.py"):
            self.assertFalse(ignored(path), path)

    def test_the_file_is_an_allowlist_that_starts_by_excluding_everything(self):
        rules = [line.strip() for line in (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
        self.assertEqual(rules[0], "*")
        self.assertEqual({rule for rule in rules if rule.startswith("!")}, {"!services/hermes-provisioner", "!services/hermes-inference-worker"})
        self.assertNotIn(b"\r\n", (REPO / ".dockerignore").read_bytes())


if __name__ == "__main__":
    unittest.main()
