from __future__ import annotations

import http.client
import json
import os
import subprocess
import sys
import tempfile
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

    def test_signed_prompt_audit_returns_only_role_and_byte_counts(self) -> None:
        value = {
            **payload("19a541c7-8a9c-42dd-8975-0d1411543b19"),
            "mode": "prompt_audit",
            "chatInput": "Synthetic chat canary.",
        }
        body = json.dumps(value, separators=(",", ":")).encode()
        audit_result = {
            "ok": True,
            "mode": "prompt_audit",
            "role": "lead_hunter",
            "profile": "iacquire-lead-hunter",
            "hermesVersion": "0.22.5",
            "soulBytes": 44,
            "providerOnlyMessageBytes": 950,
            "chatMessageBytes": 962,
            "syntheticProviderRequests": 2,
            "toolSchemas": 0,
            "toolCalls": 0,
            "promptText": "Synthetic role instructions must not escape.",
        }
        server = worker.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            worker.make_handler(SECRET, "lead_hunter", lambda _payload: audit_result),
        )
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
            response = connection.getresponse()
            response_text = response.read().decode()
            self.assertEqual(response.status, 200)
            self.assertNotIn("Synthetic role instructions", response_text)
            parsed = json.loads(response_text)
            self.assertEqual(parsed["providerOnlyMessageBytes"], 950)
            self.assertEqual(parsed["toolSchemas"], 0)
            self.assertNotIn("promptText", parsed)
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

    def test_egress_proxy_never_connects_to_non_public_dns_answers(self) -> None:
        private_answer = [(deepseek_egress_proxy.socket.AF_INET, deepseek_egress_proxy.socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch.object(deepseek_egress_proxy.socket, "getaddrinfo", return_value=private_answer), patch.object(deepseek_egress_proxy.socket, "socket") as create_socket:
            with self.assertRaises(OSError):
                deepseek_egress_proxy._connect_deepseek()
            create_socket.assert_not_called()

    def test_worker_timeout_and_child_errors_are_bounded_and_sanitized(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = os.path.join(temp, "profiles")
            profile = os.path.join(root, worker.ROLE_PROFILES["lead_hunter"])
            os.makedirs(profile)
            with open(os.path.join(profile, "SOUL.md"), "w", encoding="utf-8") as soul:
                soul.write("Synthetic SOUL fixture.")
            runner_path = os.path.join(temp, "runner.py")
            with open(runner_path, "w", encoding="utf-8") as runner:
                runner.write("# synthetic runner path")
            environment = {
                "IACQUIRE_HERMES_INFERENCE_RUNNER": runner_path,
                "IACQUIRE_HERMES_PYTHON": sys.executable,
                "IACQUIRE_INTERNAL_PROFILE_ROOT": root,
                "IACQUIRE_DEEPSEEK_EGRESS_PROXY": "http://iacquire-deepseek-egress-proxy:3128",
            }
            with patch.dict(os.environ, environment):
                with patch("worker.subprocess.run", side_effect=subprocess.TimeoutExpired("synthetic", worker.REQUEST_TIMEOUT_SECONDS, output="private output", stderr="private error")) as run:
                    with self.assertRaises(worker.RequestError) as timeout:
                        worker.run_pinned_hermes(payload("2f73e38a-7009-4a31-81a9-6608a458e6aa"))
                    self.assertEqual(timeout.exception.code, "inference_timeout")
                    self.assertNotIn("private", str(timeout.exception))
                    self.assertEqual(run.call_args.kwargs["timeout"], 32)
                with patch("worker.subprocess.run", return_value=subprocess.CompletedProcess("synthetic", 2, stdout="", stderr="private provider response")):
                    with self.assertRaises(worker.RequestError) as failed:
                        worker.run_pinned_hermes(payload("bdd87ad8-7cfb-4e41-b474-d1a326207d9a"))
                    self.assertEqual(failed.exception.code, "inference_failed")
                    self.assertNotIn("private", str(failed.exception))

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
                request = {"model": "deepseek-v4-pro", "messages": [{"role": "user", "content": "Say hello."}], "stream": True, "max_tokens": 256}
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

    def test_provider_gate_rejects_oversized_prompt_before_any_upstream_call(self) -> None:
        class FakeOpener:
            def open(self, *_args: object, **_kwargs: object) -> object:
                raise AssertionError("oversized prompt must be rejected before network access")

        with patch("urllib.request.build_opener", return_value=FakeOpener()):
            gate = inference_runner.SingleRequestDeepSeekProxy(
                api_key="synthetic-key",
                model="deepseek-v4-pro",
                egress_proxy="http://iacquire-deepseek-egress-proxy:3128",
            )
            try:
                host, port = gate.server.server_address
                connection = http.client.HTTPConnection(host, port, timeout=3)
                request = {"model": "deepseek-v4-pro", "messages": [{"role": "user", "content": "x" * (inference_runner.MAX_PROMPT_BYTES + 1)}], "stream": False, "max_tokens": 128}
                connection.request("POST", "/v1/chat/completions", body=json.dumps(request), headers={"Authorization": "Bearer synthetic-key", "Content-Type": "application/json"})
                response = connection.getresponse()
                body = json.loads(response.read())
                self.assertEqual(response.status, 400)
                self.assertEqual(body["error"], "runtime_prompt_limit_exceeded")
                self.assertEqual(gate.upstream_requests, 0)
                connection.close()
            finally:
                gate.close()

    def test_prompt_audit_accepts_over_limit_instructions_for_measurement_only(self) -> None:
        value = payload("6baec2ef-02bf-44b9-8afb-c20fb6087e42")
        audit = {
            **value,
            "mode": "prompt_audit",
            "chatInput": "Synthetic Chat canary.",
            "instructions": "x" * 7_000,
        }
        accepted = worker.validate_payload(json.dumps(audit).encode())
        self.assertEqual(accepted["mode"], "prompt_audit")
        self.assertEqual(len(accepted["instructions"]), 7_000)
        with self.assertRaises(worker.RequestError) as oversized_inference:
            worker.validate_payload(json.dumps({**value, "instructions": "x" * 7_000}).encode())
        self.assertEqual(oversized_inference.exception.code, "prompt_too_large")

    def test_prompt_audit_response_is_identity_checked_and_contains_only_counts(self) -> None:
        measured = {
            "ok": True,
            "mode": "prompt_audit",
            "role": "lead_hunter",
            "profile": "iacquire-lead-hunter",
            "hermesVersion": "0.22.5",
            "soulBytes": 321,
            "providerOnlyMessageBytes": 5_900,
            "chatMessageBytes": 5_910,
            "syntheticProviderRequests": 2,
            "toolSchemas": 0,
            "toolCalls": 0,
            "discardedPrompt": "must never escape",
        }
        result = worker.validate_prompt_audit_result(measured, "lead_hunter")
        self.assertEqual(result["providerOnlyMessageBytes"], 5_900)
        self.assertNotIn("discardedPrompt", result)
        self.assertNotIn("instructions", result)
        with self.assertRaises(worker.RequestError):
            worker.validate_prompt_audit_result({**measured, "profile": "iacquire-crm-manager"}, "lead_hunter")
        with self.assertRaises(worker.RequestError):
            worker.validate_prompt_audit_result({**measured, "toolSchemas": 1}, "lead_hunter")

    def test_prompt_audit_uses_no_deepseek_key_or_egress_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = os.path.join(temp, "profiles")
            profile = os.path.join(root, worker.ROLE_PROFILES["lead_hunter"])
            os.makedirs(profile)
            runner_path = os.path.join(temp, "runner.py")
            with open(runner_path, "w", encoding="utf-8") as runner:
                runner.write("# synthetic runner path")
            env = {
                "IACQUIRE_HERMES_INFERENCE_RUNNER": runner_path,
                "IACQUIRE_HERMES_PYTHON": sys.executable,
                "IACQUIRE_INTERNAL_PROFILE_ROOT": root,
                "IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED": "true",
            }
            output = {
                "ok": True,
                "mode": "prompt_audit",
                "role": "lead_hunter",
                "profile": worker.ROLE_PROFILES["lead_hunter"],
                "hermesVersion": "0.22.5",
                "soulBytes": 20,
                "providerOnlyMessageBytes": 400,
                "chatMessageBytes": 420,
                "toolSchemas": 0,
                "toolCalls": 0,
            }
            payload_value = {
                **payload("51906fb7-b673-4b63-8516-1765153634ed"),
                "mode": "prompt_audit",
                "chatInput": "Synthetic Chat canary.",
            }
            with patch.dict(os.environ, env):
                with patch("worker.subprocess.run", return_value=subprocess.CompletedProcess("synthetic", 0, stdout=json.dumps(output), stderr="")) as run:
                    result = worker.run_pinned_hermes(payload_value)
            command_env = run.call_args.kwargs["env"]
            child_payload = json.loads(run.call_args.kwargs["input"])
            self.assertNotIn("IACQUIRE_DEEPSEEK_EGRESS_PROXY", command_env)
            self.assertNotIn("DEEPSEEK_API_KEY", command_env)
            self.assertEqual(child_payload["mode"], "prompt_audit")
            self.assertNotIn("discardedPrompt", result)
            with patch.dict(os.environ, {**env, "IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED": "false"}):
                with self.assertRaises(worker.RequestError) as disabled:
                    worker.run_pinned_hermes(payload_value)
                self.assertEqual(disabled.exception.code, "prompt_audit_disabled")


if __name__ == "__main__":
    unittest.main()
