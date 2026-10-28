from __future__ import annotations

import http.client
import json
import threading
import time
import unittest
from email.message import Message
from unittest.mock import patch

import deepseek_egress_proxy
import inference_runner
import worker


SECRET = b"synthetic-inference-worker-test-secret-0123456789"
ACTOR = "ce4fdac8-e537-47b4-8077-4c70d8914ad9"


def payload(request_id: str) -> dict[str, object]:
    return {
        "requestId": request_id,
        "actorId": ACTOR,
        "role": "lead_hunter",
        "instructions": "Synthetic role instructions.",
        "input": "Say hello.",
        "history": [],
    }


class InferenceWorkerTests(unittest.TestCase):
    def test_payload_is_strict_and_bounded(self) -> None:
        request_id = "dfa3afaa-5b4a-455d-b58b-35cb94159a85"
        valid = json.dumps(payload(request_id)).encode()
        self.assertEqual(worker.validate_payload(valid)["role"], "lead_hunter")

        with self.assertRaises(worker.RequestError):
            worker.validate_payload(json.dumps({**payload(request_id), "toolset": ["browser"]}).encode())
        with self.assertRaises(worker.RequestError):
            worker.validate_payload(json.dumps({**payload(request_id), "role": "client_admin"}).encode())
        with self.assertRaises(worker.RequestError):
            worker.validate_payload(json.dumps({**payload(request_id), "instructions": "x" * 8_000}).encode())

    def test_signed_request_is_authenticated_once_and_returns_auditable_metadata(self) -> None:
        value = payload("713c8a88-0684-447b-af15-61c1841cb6b4")
        body = json.dumps(value, separators=(",", ":")).encode()
        response_value = {
            "ok": True,
            "provider": "deepseek",
            "model": "deepseek-v4-pro",
            "content": "Synthetic model response.",
            "usage": {"inputTokens": 31, "outputTokens": 6, "totalTokens": 37},
            "toolSchemas": 0,
            "toolCalls": 0,
        }
        calls: list[dict[str, object]] = []

        def run(row: dict[str, object]) -> dict[str, object]:
            calls.append(row)
            return response_value

        server = worker.ThreadingHTTPServer(("127.0.0.1", 0), worker.make_handler(SECRET, "lead_hunter", run))
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            timestamp = str(int(time.time()))
            headers = {
                "Content-Type": "application/json",
                "X-Iacquire-Timestamp": timestamp,
                "X-Iacquire-Signature": worker.request_signature(SECRET, timestamp, body),
            }
            host, port = server.server_address
            connection = http.client.HTTPConnection(host, port, timeout=3)
            connection.request("POST", worker.inference_path("lead_hunter"), body=body, headers=headers)
            first = connection.getresponse()
            first_payload = json.loads(first.read())
            self.assertEqual(first.status, 200)
            self.assertEqual(first_payload["usage"]["outputTokens"], 6)
            self.assertEqual(first_payload["toolSchemas"], 0)
            self.assertEqual(len(calls), 1)

            connection.request("POST", worker.inference_path("lead_hunter"), body=body, headers=headers)
            replay = connection.getresponse()
            self.assertEqual(replay.status, 409)
            self.assertEqual(len(calls), 1)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_profile_worker_rejects_other_internal_roles(self) -> None:
        calls: list[dict[str, object]] = []

        def run(row: dict[str, object]) -> dict[str, object]:
            calls.append(row)
            return {}

        server = worker.ThreadingHTTPServer(("127.0.0.1", 0), worker.make_handler(SECRET, "lead_hunter", run))
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            value = {**payload("23a7caf6-997f-45ef-acee-7d186b10d9f5"), "role": "operations_manager"}
            body = json.dumps(value, separators=(",", ":")).encode()
            timestamp = str(int(time.time()))
            headers = {
                "Content-Type": "application/json",
                "X-Iacquire-Timestamp": timestamp,
                "X-Iacquire-Signature": worker.request_signature(SECRET, timestamp, body),
            }
            host, port = server.server_address
            connection = http.client.HTTPConnection(host, port, timeout=3)
            connection.request("POST", worker.inference_path("lead_hunter"), body=body, headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            self.assertEqual(json.loads(response.read())["error"], "profile_not_allowed")
            self.assertEqual(calls, [])
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)

    def test_installed_runner_path_matches_worker_default(self) -> None:
        from pathlib import Path

        dockerfile = Path(__file__).with_name("Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            f"COPY --chown=0:0 services/hermes-inference-worker/inference_runner.py {worker.DEFAULT_RUNNER_PATH}",
            dockerfile,
        )

    def test_worker_rejects_tool_or_oversized_usage_results(self) -> None:
        base = {
            "ok": True,
            "provider": "deepseek",
            "model": "deepseek-v4-pro",
            "content": "Synthetic.",
            "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
            "toolSchemas": 0,
            "toolCalls": 0,
        }
        self.assertEqual(worker.validate_runtime_result(base)["provider"], "deepseek")
        for invalid in (
            {**base, "toolCalls": 1},
            {**base, "usage": {"inputTokens": 8_193, "outputTokens": 1, "totalTokens": 8_194}},
            {**base, "usage": {"inputTokens": 1, "outputTokens": 129, "totalTokens": 130}},
        ):
            with self.assertRaises(worker.RequestError):
                worker.validate_runtime_result(invalid)

    def test_egress_policy_accepts_only_the_exact_deepseek_connect_authority(self) -> None:
        self.assertEqual(deepseek_egress_proxy.parse_connect_target(b"CONNECT api.deepseek.com:443 HTTP/1.1\r\n"), ("api.deepseek.com", 443))
        self.assertEqual(deepseek_egress_proxy.parse_connect_target(b"CONNECT API.DEEPSEEK.COM:443 HTTP/1.1\r\n"), ("api.deepseek.com", 443))
        for target in (b"api.deepseek.com:444", b"example.com:443", b"api.deepseek.com:443@evil.test"):
            self.assertIsNone(deepseek_egress_proxy.parse_connect_target(b"CONNECT " + target + b" HTTP/1.1\r\n"))

    def test_loopback_gate_forwards_one_bounded_tool_free_request_and_captures_usage(self) -> None:
        response_body = (
            b'data: {"model":"deepseek-v4-pro","choices":[{"delta":{"content":"Synthetic."}}]}\n\n'
            b'data: {"model":"deepseek-v4-pro","choices":[],"usage":{"prompt_tokens":24,"completion_tokens":3,"total_tokens":27}}\n\n'
            b"data: [DONE]\n\n"
        )
        observed: list[object] = []

        class FakeResponse:
            status = 200

            def __init__(self) -> None:
                self.headers = Message()
                self.headers["Content-Type"] = "text/event-stream"

            def read(self, _size: int = -1) -> bytes:
                return response_body

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        class FakeOpener:
            def open(self, request: object, timeout: int) -> FakeResponse:
                observed.append(request)
                self_outer.assertEqual(timeout, 25)
                self_outer.assertEqual(request.full_url, inference_runner.UPSTREAM)
                outbound = json.loads(request.data)
                self_outer.assertEqual(outbound["model"], "deepseek-v4-pro")
                self_outer.assertEqual(outbound["max_tokens"], 128)
                self_outer.assertEqual(outbound["thinking"], {"type": "disabled"})
                self_outer.assertEqual(outbound["reasoning_effort"], "none")
                self_outer.assertNotIn("tools", outbound)
                self_outer.assertEqual(request.get_header("Authorization"), "Bearer synthetic-key")
                return FakeResponse()

        self_outer = self
        with patch("urllib.request.build_opener", return_value=FakeOpener()):
            gate = inference_runner.SingleRequestDeepSeekProxy(
                api_key="synthetic-key",
                model="deepseek-v4-pro",
                egress_proxy="http://iacquire-deepseek-egress-proxy:3128",
            )
            try:
                host, port = gate.server.server_address
                connection = http.client.HTTPConnection(host, port, timeout=3)
                request = {"model": "deepseek-v4-pro", "messages": [{"role": "user", "content": "Say hello."}], "stream": True, "max_tokens": 128}
                connection.request("POST", "/v1/chat/completions", body=json.dumps(request), headers={"Authorization": "Bearer synthetic-key", "Content-Type": "application/json"})
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 200)
                self.assertEqual(len(observed), 1)
                self.assertEqual(gate.upstream_requests, 1)
                self.assertEqual(gate.actual_model, "deepseek-v4-pro")
                self.assertEqual(gate.usage, {"inputTokens": 24, "outputTokens": 3, "totalTokens": 27})
                connection.close()
            finally:
                gate.close()


if __name__ == "__main__":
    unittest.main()
