from __future__ import annotations

from contextlib import closing, contextmanager
import http.client
import io
import json
import sqlite3
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import urllib.error

import acceptance_proxy as proxy


SECRET = b"synthetic-acceptance-broker-secret-0123456789"
CAMPAIGN = "e5023ced-1690-4ef0-8106-910182315446"
INPUT = {"model": proxy.MODEL, "messages": [{"role": "user", "content": "Fictional workspace"}], "max_tokens": 900}
TOOL = {"type": "function", "function": {"name": "read_crm", "parameters": {"type": "object"}}}
CALL = {"id": "fixture_call", "type": "function", "function": {"name": "read_crm", "arguments": "{}"}}


def completion(**changes):
    reply = {"id": "fixture", "model": proxy.MODEL, "created": 41,
             "usage": {"prompt_tokens": 25, "completion_tokens": 4, "total_tokens": 29},
             "choices": [{"index": 0, "finish_reason": "stop",
                          "message": {"role": "assistant", "content": "Fictional response"}}]}
    reply.update(changes)
    return 200, json.dumps(reply).encode()


@contextmanager
def loopback(ledger, transport):
    with proxy.make_server(ledger, SECRET, transport, 0) as server:
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        worker.start()
        try:
            yield server.server_port
        finally:
            server.shutdown()
            worker.join(timeout=3)


def send(port, *, fixture="grounding-01-r1", packet=INPUT, token=None, path=proxy.ROUTE):
    body = packet if isinstance(packet, bytes) else json.dumps(packet).encode()
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
    try:
        conn.request("POST", path, body, {"Content-Type": "application/json", "Authorization": "Bearer " + (
            token if token is not None else proxy.fixture_token(SECRET, fixture))})
        response = conn.getresponse()
        return response.status, response.read(), response.getheader("Content-Type")
    finally:
        conn.close()


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="iacquire-acceptance-proxy-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "fixture budget.sqlite"
        self.ledger = proxy.Ledger.initialize(self.path, CAMPAIGN)

    def test_reservation_committed_before_dispatch_and_billed_at_peak(self):
        received = []

        def stub(body):
            snapshot = proxy.read_report(self.path, CAMPAIGN)
            self.assertEqual(snapshot["attempts"][0]["state"], "reserved")
            self.assertEqual(snapshot["usedNanodollars"], 1_048_576 * 300 + 900 * 1200)
            received.append(json.loads(body))
            return completion()

        with loopback(self.ledger, stub) as port:
            self.assertEqual(send(port, packet={**INPUT, "max_tokens": 2000})[0], 200)
        self.assertEqual(received, [{**INPUT, "max_tokens": 900, "stream": False, "thinking": {"type": "disabled"}}])
        snapshot = proxy.read_report(self.path, CAMPAIGN)
        self.assertEqual(snapshot["usedNanodollars"], 25 * 300 + 4 * 1200)
        self.assertEqual(snapshot["attempts"][0]["state"], "settled")
        self.assertNotIn("Fictional", json.dumps(snapshot))

    def test_denied_input_never_reserves_or_calls(self):
        stub = Mock(side_effect=lambda body: completion())
        with loopback(self.ledger, stub) as port:
            valid_token = proxy.fixture_token(SECRET, "grounding-01-r1")
            self.assertEqual(send(port, token=valid_token.replace("01", "02", 1))[0], 401)
            self.assertEqual(send(port, path="/chat/completions")[0], 404)
            bad_packets = [
                {**INPUT, "model": "deepseek-v4-pro"},
                {**INPUT, "max_tokens": True},
                {**INPUT, "max_completion_tokens": 900},
                {**INPUT, "messages": [{"role": "user", "content": "文" * 3000}]},
                {**INPUT, "messages": [{"role": "user", "content": [{"type": "image_url"}]}]},
                {**INPUT, "messages": [{"role": {}, "content": "invalid"}]},
                {**INPUT, "thinking": {"type": "enabled"}},
                {**INPUT, "tools": [TOOL]},
                {**INPUT, "tools": [{"type": "web_search"}]},
                {**INPUT, "temperature": float("nan")},
                b'{"model":"deepseek-flash","model":"deepseek-flash"}',
            ]
            for packet in bad_packets:
                with self.subTest(packet=repr(packet)[:90]):
                    self.assertEqual(send(port, packet=packet)[0], 400)
            tool_packet = {**INPUT, "tools": [{"type": "function", "function": {
                "name": "read_crm", "parameters": {"description": "x" * 12000}}}]}
            self.assertEqual(send(port, fixture="tools-01-r1", packet=tool_packet)[0], 400)
        stub.assert_not_called()
        self.assertEqual(proxy.read_report(self.path, CAMPAIGN)["attempts"], [])

    def test_tool_round_trip_can_stream_and_then_use_tool_history(self):
        first = completion(choices=[{"index": 0, "finish_reason": "tool_calls",
                                     "message": {"role": "assistant", "content": None, "tool_calls": [CALL]}}])
        stub = Mock(side_effect=[first, completion()])
        with loopback(self.ledger, stub) as port:
            packet = {**INPUT, "tools": [TOOL], "stream": True, "stream_options": {"include_usage": True}}
            status, raw, content_type = send(port, fixture="tools-01-r1", packet=packet)
            self.assertEqual((status, content_type), (200, "text/event-stream"))
            events = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith(b"data: ") and not line.endswith(b"[DONE]")]
            self.assertEqual(events[0]["choices"][0]["delta"]["tool_calls"], [{**CALL, "index": 0}])
            self.assertEqual(events[1]["choices"][0]["finish_reason"], "tool_calls")
            self.assertEqual(events[2]["usage"]["total_tokens"], 29)
            self.assertTrue(raw.endswith(b"data: [DONE]\n\n"))
            self.assertFalse(json.loads(stub.call_args.args[0])["stream"])

            history = INPUT["messages"] + [
                {"role": "assistant", "content": None, "tool_calls": [CALL]},
                {"role": "tool", "tool_call_id": CALL["id"], "content": "Synthetic CRM evidence"},
            ]
            self.assertEqual(send(port, fixture="tools-01-r1", packet={**INPUT, "messages": history, "tools": [TOOL]})[0], 200)
            self.assertEqual(json.loads(stub.call_args.args[0])["messages"], history)
        self.assertEqual(len(proxy.read_report(self.path, CAMPAIGN)["attempts"]), 2)

    def test_two_servers_share_the_in_flight_reservation(self):
        entered = threading.Event()
        release = threading.Event()
        first_status = []

        def stub(body):
            entered.set()
            if not release.wait(3):
                raise TimeoutError()
            return completion()

        other = Mock(side_effect=lambda body: completion())
        with loopback(self.ledger, stub) as first, loopback(proxy.Ledger(self.path, CAMPAIGN), other) as second:
            caller = threading.Thread(target=lambda: first_status.append(send(first)[0]))
            caller.start()
            try:
                self.assertTrue(entered.wait(3))
                status, raw, _ = send(second, fixture="grounding-01-r2")
                self.assertEqual(status, 409)
                self.assertIn(b"charge_already_reserved", raw)
                other.assert_not_called()
            finally:
                release.set()
                caller.join(3)
            self.assertEqual(first_status, [200])
            self.assertEqual(send(second, fixture="grounding-01-r2")[0], 200)

    def test_unknown_usage_timeout_redirect_and_quota_stop_and_retain_reservation(self):
        cases = [
            (TimeoutError("internal details"), "provider_transport_or_accounting_failed"),
            ((302, b"private redirect"), "provider_redirect"),
            ((429, b"private quota response"), "provider_quota"),
            ((200, b"wrong-format"), "provider_response_invalid"),
            (completion(usage=None), "provider_usage_missing"),
            (completion(model="alien-model"), "provider_response_invalid"),
            (completion(usage={"prompt_tokens": 8200, "completion_tokens": 3, "total_tokens": 8203}),
             "provider_usage_out_of_bounds"),
            (completion(choices=[{"index": 0, "finish_reason": "tool_calls",
                                  "message": {"role": "assistant", "content": None, "tool_calls": [CALL]}}]),
             "provider_response_invalid"),
        ]
        for index, (outcome, code) in enumerate(cases):
            with self.subTest(code=code):
                file = Path(self.temp.name) / f"case-{index}.sqlite"
                ledger = proxy.Ledger.initialize(file, CAMPAIGN)
                stub = Mock(side_effect=[outcome])
                with loopback(ledger, stub) as port:
                    status, body, _ = send(port)
                    self.assertEqual(status, 502)
                    self.assertEqual(json.loads(body)["error"]["code"], code)
                    self.assertNotIn(b"private", body)
                report = proxy.read_report(file, CAMPAIGN)
                self.assertEqual(report["halted"], code)
                self.assertEqual(report["attempts"][0]["state"], "retained")
                self.assertEqual(report["usedNanodollars"], proxy.PROVIDER_CONTEXT * proxy.INPUT_PRICE + 900 * proxy.OUTPUT_PRICE)
                with loopback(proxy.Ledger(file, CAMPAIGN), stub) as port:
                    self.assertEqual(send(port, fixture="grounding-01-r2")[0], 409)
                self.assertEqual(stub.call_count, 1)

    def test_unsettled_restart_refuses_and_spend_budget_is_persistent(self):
        self.ledger.reserve("grounding-01-r1", 900)
        stub = Mock(side_effect=lambda body: completion())
        with loopback(proxy.Ledger(self.path, CAMPAIGN), stub) as port:
            self.assertEqual(send(port, fixture="grounding-01-r2")[0], 409)
        stub.assert_not_called()

        file = Path(self.temp.name) / "limited.sqlite"
        budget = proxy.PROVIDER_CONTEXT * proxy.INPUT_PRICE + 900 * proxy.OUTPUT_PRICE
        with loopback(proxy.Ledger.initialize(file, CAMPAIGN, spend_limit=budget), stub) as port:
            self.assertEqual(send(port)[0], 200)
            self.assertEqual(send(port, fixture="grounding-01-r2")[0], 429)
        self.assertEqual(stub.call_count, 1)
        self.assertEqual(proxy.read_report(file, CAMPAIGN)["halted"], "campaign_budget")
        with self.assertRaisesRegex(sqlite3.Error, "policy mismatch"):
            proxy.Ledger(file, CAMPAIGN, spend_limit=budget + 1)


    def test_explicit_ledger_creation_credential_binding_and_safe_report(self):
        missing = Path(self.temp.name) / "missing.sqlite"
        with self.assertRaises(sqlite3.Error):
            proxy.Ledger(missing, CAMPAIGN)
        self.assertFalse(missing.exists())
        with self.assertRaises(FileExistsError):
            proxy.Ledger.initialize(self.path, CAMPAIGN)
        other = "8bd652c4-85a9-451b-9c0d-12ef28fbd330"
        with self.assertRaises(sqlite3.Error):
            proxy.Ledger(self.path, other)
        with self.assertRaises(sqlite3.Error):
            proxy.Ledger(self.path, CAMPAIGN, binding="a-different-credential-binding")
        with self.assertRaises(sqlite3.Error):
            proxy.read_report(self.path, other)

        self.ledger.reserve("grounding-01-r1", 900)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("alter table attempts add column never_report text default 'private extra column'")
        report = proxy.read_report(self.path, CAMPAIGN)
        self.assertTrue(report["dispatchBlocked"])
        self.assertEqual(report["accountingNanodollars"], {
            "settled": 0, "retained": 0, "reserved": proxy.PROVIDER_CONTEXT * proxy.INPUT_PRICE + 900 * proxy.OUTPUT_PRICE,
        })
        self.assertNotIn("never_report", json.dumps(report))
        self.assertNotIn("private extra column", json.dumps(report))

    def test_tool_choice_none_refuses_unexpected_tool_reply(self):
        stub = Mock(return_value=completion(choices=[{"index": 0, "finish_reason": "tool_calls",
            "message": {"role": "assistant", "content": None, "tool_calls": [CALL]}}]))
        with loopback(self.ledger, stub) as port:
            packet = {**INPUT, "tools": [TOOL], "tool_choice": "none"}
            status, response, _ = send(port, fixture="tools-01-r1", packet=packet)
        self.assertEqual(status, 502)
        self.assertNotIn(b"read_crm", response)
        self.assertEqual(proxy.read_report(self.path, CAMPAIGN)["halted"], "provider_response_invalid")

    def test_per_fixture_budgets_and_exact_provider_transport(self):
        stub = Mock(side_effect=lambda body: completion())
        with loopback(self.ledger, stub) as port:
            self.assertEqual(send(port)[0], 200)
            self.assertEqual(send(port)[0], 429)
            for _ in range(6):
                self.assertEqual(send(port, fixture="tools-01-r1")[0], 200)
            self.assertEqual(send(port, fixture="tools-01-r1")[0], 429)
        self.assertEqual(stub.call_count, 7)
        self.assertEqual(sum(count * 3 * calls for count, calls, _ in proxy.SCENARIOS.values()), proxy.MAX_CALLS)

        fake_opener = Mock()
        fake_opener.open.side_effect = urllib.error.HTTPError(
            proxy.PROVIDER_URL, 301, "wrong host", {"Location": "https://must-not-be-called.test"}, io.BytesIO()
        )
        with patch("urllib.request.build_opener", return_value=fake_opener) as build:
            self.assertEqual(proxy.deepseek_transport("synthetic-key")(b"{}"), (301, b""))
        request = fake_opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-key")
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsNone(build.call_args.args[1].redirect_request(None))
        fake_opener.open.assert_called_once()


if __name__ == "__main__":
    unittest.main()
