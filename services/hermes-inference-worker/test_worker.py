from __future__ import annotations

import http.client
import io
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
import hashlib
import inference_runner
import worker


SECRET = b"synthetic-inference-worker-test-secret-0123456789"
ACTOR = "ce4fdac8-e537-47b4-8077-4c70d8914ad9"
DEEPSEEK_KEY = "sk-synthetic-deepseek-test-key-0123456789"
PROFILE_FILES = {
    "SOUL.md": "Synthetic SOUL fixture.",
    "config.yaml": "model:\n  provider: deepseek\n  model: deepseek-v4-pro\n",
    # Everything except the two DeepSeek lines is a stand-in for the other secrets a live profile holds.
    ".env": (
        "# synthetic profile secrets\n"
        "OTHER_PROVIDER_KEY=synthetic-other-provider-secret-value\n"
        "API_SERVER_KEY=synthetic-api-server-secret-value\n"
        f"DEEPSEEK_API_KEY={DEEPSEEK_KEY}\n"
        "DEEPSEEK_BASE_URL=https://api.deepseek.com\n"
    ),
    "state.db": "synthetic conversation state",
}
AUDIT_OUTPUT = {
    "ok": True,
    "mode": "prompt_audit",
    "role": "lead_hunter",
    "profile": worker.ROLE_PROFILES["lead_hunter"],
    "hermesVersion": "0.22.5",
    "soulBytes": 20,
    "providerOnlyMessageBytes": 400,
    "chatMessageBytes": 420,
    "syntheticProviderRequests": 2,
    "toolSchemas": 0,
    "toolCalls": 0,
}


def payload(request_id: str) -> dict[str, object]:
    return {
        "requestId": request_id,
        "actorId": ACTOR,
        "role": "lead_hunter",
        "instructions": "Synthetic role instructions.",
        "input": "Say hello.",
        "history": [],
    }


def audit_payload(request_id: str) -> dict[str, object]:
    return {**payload(request_id), "mode": "prompt_audit", "chatInput": "Synthetic Chat canary."}


def encode(value: object) -> bytes:
    """The request body as the app sends it: UTF-8 JSON, so multibyte text keeps its real size."""
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def make_profile(temp: str, files: dict[str, str] | None = None) -> dict[str, str]:
    """A synthetic profile root, a private runtime temp root and a stand-in runner file."""
    root = os.path.join(temp, "profiles")
    profile = os.path.join(root, worker.ROLE_PROFILES["lead_hunter"])
    os.makedirs(profile)
    for name, text in (PROFILE_FILES if files is None else files).items():
        with open(os.path.join(profile, name), "w", encoding="utf-8") as handle:
            handle.write(text)
    runtime = os.path.join(temp, "runtime")
    os.makedirs(runtime)
    runner = os.path.join(temp, "runner.py")
    with open(runner, "w", encoding="utf-8") as handle:
        handle.write("# synthetic runner path")
    return {"root": root, "profile": profile, "runtime": runtime, "runner": runner}


def worker_environment(fixture: dict[str, str], *, audit: bool = False) -> dict[str, str]:
    environment = {
        "IACQUIRE_HERMES_INFERENCE_RUNNER": fixture["runner"],
        "IACQUIRE_HERMES_PYTHON": sys.executable,
        "IACQUIRE_INTERNAL_PROFILE_ROOT": fixture["root"],
        "IACQUIRE_HERMES_TEMP_ROOT": fixture["runtime"],
    }
    if audit:
        environment["IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED"] = "true"
    else:
        environment["IACQUIRE_DEEPSEEK_EGRESS_PROXY"] = "http://iacquire-deepseek-egress-proxy:3128"
    return environment


def snapshot(directory: str) -> dict[str, tuple[int, str]]:
    """Every file under a directory with its size and digest, to prove nothing was written to it."""
    result: dict[str, tuple[int, str]] = {}
    for current, _folders, names in os.walk(directory):
        for name in names:
            path = os.path.join(current, name)
            with open(path, "rb") as handle:
                data = handle.read()
            result[os.path.relpath(path, directory)] = (len(data), hashlib.sha256(data).hexdigest())
    return result


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
            worker.validate_payload(json.dumps({**payload(request_id), "instructions": "x" * (worker.MAX_INSTRUCTIONS_CHARS + 1)}).encode())

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
            fixture = make_profile(temp)
            environment = worker_environment(fixture)
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
        # Two-byte characters keep the character count under its own cap while the UTF-8 size is over the budget.
        over_budget = "é" * (worker.MAX_PROMPT_BYTES // 2 + 1_000)
        self.assertGreater(len(over_budget.encode("utf-8")), worker.MAX_PROMPT_BYTES)
        audit = {
            **value,
            "mode": "prompt_audit",
            "chatInput": "Synthetic Chat canary.",
            "instructions": over_budget,
        }
        accepted = worker.validate_payload(encode(audit))
        self.assertEqual(accepted["mode"], "prompt_audit")
        self.assertEqual(len(accepted["instructions"]), len(over_budget))
        with self.assertRaises(worker.RequestError) as oversized_inference:
            worker.validate_payload(encode({**value, "instructions": over_budget}))
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
            fixture = make_profile(temp)
            env = worker_environment(fixture, audit=True)
            output = AUDIT_OUTPUT
            payload_value = audit_payload("51906fb7-b673-4b63-8516-1765153634ed")
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


class PromptBudgetTests(unittest.TestCase):
    """The prompt budget (decision D2): 24 KiB of effective message text, 20,000 instruction characters, 8,192 input tokens."""

    def test_the_worker_and_the_runner_hold_the_same_numbers(self) -> None:
        self.assertEqual(worker.MAX_PROMPT_BYTES, 24_576)
        self.assertEqual(inference_runner.MAX_PROMPT_BYTES, worker.MAX_PROMPT_BYTES)
        self.assertEqual(worker.MAX_INSTRUCTIONS_CHARS, 20_000)
        self.assertEqual(worker.MAX_INPUT_TOKENS, 8_192)
        self.assertEqual(inference_runner.MAX_INPUT_TOKENS, worker.MAX_INPUT_TOKENS)
        self.assertEqual(worker.MAX_OUTPUT_TOKENS, 128)
        self.assertEqual(inference_runner.MAX_OUTPUT_TOKENS, worker.MAX_OUTPUT_TOKENS)

    def test_the_largest_measured_live_role_fits_with_room_to_grow(self) -> None:
        # Lead Hunter in the 2026-10-30 no-call audit: 14,091 bytes of instructions, a 17,910-byte chat message.
        self.assertLess(14_091, worker.MAX_INSTRUCTIONS_CHARS)
        self.assertLess(17_910, inference_runner.MAX_PROMPT_BYTES)

    def test_instructions_are_accepted_up_to_their_character_cap(self) -> None:
        value = payload("0f4e1c58-8d0a-4f6e-9a77-3b1f6a5d2c10")
        accepted = worker.validate_payload(encode({**value, "instructions": "x" * worker.MAX_INSTRUCTIONS_CHARS}))
        self.assertEqual(len(accepted["instructions"]), worker.MAX_INSTRUCTIONS_CHARS)
        with self.assertRaises(worker.RequestError) as too_long:
            worker.validate_payload(encode({**value, "instructions": "x" * (worker.MAX_INSTRUCTIONS_CHARS + 1)}))
        self.assertEqual(too_long.exception.code, "instructions_too_large")

    def test_an_inference_prompt_is_cut_off_at_exactly_the_byte_budget(self) -> None:
        value = payload("5d1b8e47-2c93-4a0f-8e61-7a4c9b3d0e22")
        room = worker.MAX_PROMPT_BYTES - len(str(value["input"]).encode("utf-8"))
        at_budget = "é" * (room // 2) + "x" * (room % 2)
        accepted = worker.validate_payload(encode({**value, "instructions": at_budget}))
        self.assertEqual(len(accepted["instructions"].encode("utf-8")) + len(str(value["input"]).encode("utf-8")), worker.MAX_PROMPT_BYTES)
        with self.assertRaises(worker.RequestError) as over:
            worker.validate_payload(encode({**value, "instructions": at_budget + "x"}))
        self.assertEqual((over.exception.code, over.exception.status), ("prompt_too_large", 413))
        with self.assertRaises(worker.RequestError) as with_history:
            worker.validate_payload(encode({**value, "instructions": at_budget, "history": [{"role": "user", "content": "Hi."}]}))
        self.assertEqual(with_history.exception.code, "prompt_too_large")

    def test_the_provider_gate_accepts_a_prompt_at_exactly_the_byte_budget(self) -> None:
        reply = b'{"model":"deepseek-v4-pro","choices":[{"message":{"content":"Synthetic."},"finish_reason":"stop"}],"usage":{"prompt_tokens":6100,"completion_tokens":3,"total_tokens":6103}}'

        class FakeResponse:
            status = 200

            def __init__(self) -> None:
                self.headers = Message()
                self.headers["Content-Type"] = "application/json"

            def read(self, _size: int = -1) -> bytes:
                return reply

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        class FakeOpener:
            def open(self, _request: object, timeout: int) -> FakeResponse:
                return FakeResponse()

        with patch("urllib.request.build_opener", return_value=FakeOpener()):
            gate = inference_runner.SingleRequestDeepSeekProxy(
                api_key="synthetic-key",
                model="deepseek-v4-pro",
                egress_proxy="http://iacquire-deepseek-egress-proxy:3128",
            )
            try:
                host, port = gate.server.server_address
                connection = http.client.HTTPConnection(host, port, timeout=3)
                request = {"model": "deepseek-v4-pro", "messages": [{"role": "user", "content": "x" * inference_runner.MAX_PROMPT_BYTES}], "stream": False, "max_tokens": 128}
                connection.request("POST", "/v1/chat/completions", body=json.dumps(request), headers={"Authorization": "Bearer synthetic-key", "Content-Type": "application/json"})
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 200)
                self.assertEqual(gate.upstream_requests, 1)
                self.assertEqual(gate.usage, {"inputTokens": 6_100, "outputTokens": 3, "totalTokens": 6_103})
                connection.close()
            finally:
                gate.close()

    def test_the_usage_check_compares_tokens_to_a_token_ceiling_not_to_the_byte_budget(self) -> None:
        def reply(prompt: int, completion: int = 3) -> bytes:
            body = {
                "model": "deepseek-v4-pro",
                "choices": [{"message": {"content": "Synthetic."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion},
            }
            return json.dumps(body).encode()

        usage, _model = inference_runner._response_usage(reply(inference_runner.MAX_INPUT_TOKENS), "application/json")
        self.assertEqual(usage, {"inputTokens": 8_192, "outputTokens": 3, "totalTokens": 8_195})
        # Above the old 6,144 limit and under the ceiling: accepted now.
        usage, _model = inference_runner._response_usage(reply(6_145), "application/json")
        self.assertEqual(usage["inputTokens"], 6_145)
        with self.assertRaises(inference_runner.RuntimeErrorSafe) as over:
            inference_runner._response_usage(reply(inference_runner.MAX_INPUT_TOKENS + 1), "application/json")
        self.assertEqual(str(over.exception), "runtime_token_limit_exceeded")
        with self.assertRaises(inference_runner.RuntimeErrorSafe):
            inference_runner._response_usage(reply(10, inference_runner.MAX_OUTPUT_TOKENS + 1), "application/json")


class ThrowawayRuntimeHomeTests(unittest.TestCase):
    """Hermes writes logs and state under its home; the profile is a read-only mount.

    The first A2 audit failed in production with "Read-only file system: .../logs/agent.log" because the
    worker pointed HERMES_HOME at the profile. Each request now gets a throwaway home instead.
    """

    def test_prompt_audit_runs_in_a_throwaway_home_with_only_soul_and_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_profile(temp)
            before = snapshot(fixture["profile"])
            seen: dict[str, object] = {}

            def fake_run(_command: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
                home = kwargs["env"]["HERMES_HOME"]  # type: ignore[index]
                seen["home"] = home
                seen["files"] = sorted(os.listdir(home))
                with open(os.path.join(home, "SOUL.md"), encoding="utf-8") as soul:
                    seen["soul"] = soul.read()
                seen["cwd"] = kwargs["cwd"]
                # Hermes creates its log directory and files under its home.
                os.makedirs(os.path.join(home, "logs"))
                with open(os.path.join(home, "logs", "agent.log"), "w", encoding="utf-8") as log:
                    log.write("synthetic log line")
                return subprocess.CompletedProcess("synthetic", 0, stdout=json.dumps(AUDIT_OUTPUT), stderr="")

            with patch.dict(os.environ, worker_environment(fixture, audit=True)):
                with patch("worker.subprocess.run", side_effect=fake_run) as run:
                    worker.run_pinned_hermes(audit_payload("0b6f7f1c-63d4-4d9e-a2e2-2f0a4b6a7c11"))
            child_env = run.call_args.kwargs["env"]
            self.assertNotEqual(seen["home"], fixture["profile"])
            self.assertEqual(os.path.dirname(str(seen["home"])), fixture["runtime"])
            self.assertEqual(seen["files"], ["SOUL.md", "config.yaml"])
            self.assertEqual(seen["soul"], PROFILE_FILES["SOUL.md"])
            self.assertEqual(seen["cwd"], fixture["runtime"])
            self.assertEqual(child_env["HOME"], fixture["runtime"])
            self.assertEqual(child_env["IACQUIRE_INTERNAL_PROFILE"], worker.ROLE_PROFILES["lead_hunter"])
            self.assertNotIn(fixture["profile"], child_env.values())
            self.assertNotIn("DEEPSEEK_API_KEY", child_env)
            self.assertFalse(os.path.exists(str(seen["home"])))
            self.assertEqual(os.listdir(fixture["runtime"]), [])
            self.assertEqual(snapshot(fixture["profile"]), before)
            self.assertEqual(sorted(os.listdir(fixture["profile"])), sorted(PROFILE_FILES))

    def test_inference_home_carries_only_the_deepseek_settings(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_profile(temp)
            seen: dict[str, object] = {}

            def fake_run(_command: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
                home = kwargs["env"]["HERMES_HOME"]  # type: ignore[index]
                seen["files"] = sorted(os.listdir(home))
                with open(os.path.join(home, ".env"), encoding="ascii") as dotenv:
                    seen["dotenv"] = dotenv.read()
                if os.name == "posix":
                    seen["modes"] = {name: os.stat(os.path.join(home, name)).st_mode & 0o777 for name in os.listdir(home)}
                    seen["home_mode"] = os.stat(home).st_mode & 0o777
                return subprocess.CompletedProcess("synthetic", 0, stdout=json.dumps({"ok": True}), stderr="")

            with patch.dict(os.environ, worker_environment(fixture)):
                with patch("worker.subprocess.run", side_effect=fake_run) as run:
                    worker.run_pinned_hermes(payload("6d1d52cf-3c1d-4f2c-8d0e-5b9a8e0f7a22"))
            self.assertEqual(seen["files"], [".env", "SOUL.md", "config.yaml"])
            self.assertEqual(seen["dotenv"], f"DEEPSEEK_API_KEY={DEEPSEEK_KEY}\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n")
            for secret in ("OTHER_PROVIDER_KEY", "API_SERVER_KEY", "synthetic-other-provider-secret-value", "synthetic-api-server-secret-value"):
                self.assertNotIn(secret, str(seen["dotenv"]))
            self.assertEqual(run.call_args.kwargs["env"]["IACQUIRE_DEEPSEEK_EGRESS_PROXY"], "http://iacquire-deepseek-egress-proxy:3128")
            if os.name == "posix":
                self.assertEqual(seen["home_mode"], 0o700)
                self.assertEqual(set(seen["modes"].values()), {0o600})  # type: ignore[union-attr]
            self.assertEqual(os.listdir(fixture["runtime"]), [])

    def test_throwaway_home_is_removed_whatever_the_child_does(self) -> None:
        outcomes = {
            "success": (subprocess.CompletedProcess("synthetic", 0, stdout=json.dumps({"ok": True}), stderr=""), None),
            "child failure": (subprocess.CompletedProcess("synthetic", 2, stdout="", stderr="private"), "inference_failed"),
            "invalid output": (subprocess.CompletedProcess("synthetic", 0, stdout="not json", stderr=""), "runtime_response_invalid"),
        }
        for label, (completed, expected_code) in outcomes.items():
            with self.subTest(label), tempfile.TemporaryDirectory() as temp:
                fixture = make_profile(temp)
                with patch.dict(os.environ, worker_environment(fixture)), patch("worker.subprocess.run", return_value=completed):
                    if expected_code is None:
                        worker.run_pinned_hermes(payload("2a0f6a4e-8b3c-4e57-9d1b-7c4e5f6a8b33"))
                    else:
                        with self.assertRaises(worker.RequestError) as raised:
                            worker.run_pinned_hermes(payload("2a0f6a4e-8b3c-4e57-9d1b-7c4e5f6a8b33"))
                        self.assertEqual(raised.exception.code, expected_code)
                self.assertEqual(os.listdir(fixture["runtime"]), [])
        for label, error, code in (
            ("timeout", subprocess.TimeoutExpired("synthetic", worker.REQUEST_TIMEOUT_SECONDS), "inference_timeout"),
            ("missing interpreter", FileNotFoundError("synthetic"), "runtime_unavailable"),
        ):
            with self.subTest(label), tempfile.TemporaryDirectory() as temp:
                fixture = make_profile(temp)
                with patch.dict(os.environ, worker_environment(fixture)), patch("worker.subprocess.run", side_effect=error):
                    with self.assertRaises(worker.RequestError) as raised:
                        worker.run_pinned_hermes(payload("2a0f6a4e-8b3c-4e57-9d1b-7c4e5f6a8b33"))
                    self.assertEqual(raised.exception.code, code)
                self.assertEqual(os.listdir(fixture["runtime"]), [])

    def test_missing_empty_oversized_or_linked_profile_files_are_refused_before_any_child_starts(self) -> None:
        cases = {
            "no SOUL.md": {"remove": "SOUL.md"},
            "no config.yaml": {"remove": "config.yaml"},
            "empty SOUL.md": {"replace": ("SOUL.md", "")},
            "oversized SOUL.md": {"replace": ("SOUL.md", "x" * (worker.PROFILE_HOME_FILE_LIMITS["SOUL.md"] + 1))},
            "oversized config.yaml": {"replace": ("config.yaml", "x" * (worker.PROFILE_HOME_FILE_LIMITS["config.yaml"] + 1))},
        }
        for label, change in cases.items():
            with self.subTest(label), tempfile.TemporaryDirectory() as temp:
                files = dict(PROFILE_FILES)
                if "remove" in change:
                    del files[change["remove"]]  # type: ignore[arg-type]
                if "replace" in change:
                    name, text = change["replace"]  # type: ignore[misc]
                    files[name] = text
                fixture = make_profile(temp, files)
                with patch.dict(os.environ, worker_environment(fixture, audit=True)), patch("worker.subprocess.run") as run:
                    with self.assertRaises(worker.RequestError) as raised:
                        worker.run_pinned_hermes(audit_payload("3c1d9b52-7e44-4a10-8f6b-1d2e3f4a5b44"))
                    self.assertEqual((raised.exception.code, raised.exception.status), ("runtime_profile_unavailable", 503))
                    run.assert_not_called()
                self.assertEqual(os.listdir(fixture["runtime"]), [])
        with self.subTest("inference without a profile .env"), tempfile.TemporaryDirectory() as temp:
            files = {name: text for name, text in PROFILE_FILES.items() if name != ".env"}
            fixture = make_profile(temp, files)
            with patch.dict(os.environ, worker_environment(fixture)), patch("worker.subprocess.run") as run:
                with self.assertRaises(worker.RequestError) as raised:
                    worker.run_pinned_hermes(payload("4d2eac63-8f55-4b21-9a7c-2e3f4a5b6c55"))
                self.assertEqual(raised.exception.code, "runtime_profile_unavailable")
                run.assert_not_called()
        with self.subTest("the audit does not need or copy a profile .env"), tempfile.TemporaryDirectory() as temp:
            files = {name: text for name, text in PROFILE_FILES.items() if name != ".env"}
            fixture = make_profile(temp, files)
            with patch.dict(os.environ, worker_environment(fixture, audit=True)):
                with patch("worker.subprocess.run", return_value=subprocess.CompletedProcess("synthetic", 0, stdout=json.dumps(AUDIT_OUTPUT), stderr="")):
                    worker.run_pinned_hermes(audit_payload("5e3fbd74-9066-4c32-8b8d-3f4a5b6c7d66"))

    def test_a_linked_profile_file_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_profile(temp)
            outside = os.path.join(temp, "outside.md")
            with open(outside, "w", encoding="utf-8") as handle:
                handle.write("not part of the profile")
            soul = os.path.join(fixture["profile"], "SOUL.md")
            os.remove(soul)
            try:
                os.symlink(outside, soul)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are not available here")
            with patch.dict(os.environ, worker_environment(fixture, audit=True)), patch("worker.subprocess.run") as run:
                with self.assertRaises(worker.RequestError) as raised:
                    worker.run_pinned_hermes(audit_payload("6f4acd85-a177-4d43-9c9e-4a5b6c7d8e77"))
                self.assertEqual(raised.exception.code, "runtime_profile_unavailable")
                run.assert_not_called()

    def test_provider_dotenv_keeps_only_plain_deepseek_values(self) -> None:
        raw = (
            b"# comment\n"
            b"export DEEPSEEK_API_KEY='sk-synthetic-0123456789'\n"
            b'DEEPSEEK_BASE_URL="https://api.deepseek.com"\n'
            b"OTHER=secret-value-0000\n"
            b"DEEPSEEK_API_KEY_EXTRA=nope-nope-nope\n"
        )
        self.assertEqual(
            worker._provider_dotenv(raw),
            "DEEPSEEK_API_KEY=sk-synthetic-0123456789\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n",
        )
        # A value that is not one plain token is dropped, so a line can never smuggle in a second assignment.
        for unsafe in (b"DEEPSEEK_API_KEY=abc12345 OTHER=1", b"DEEPSEEK_API_KEY=short", b'DEEPSEEK_API_KEY=abc"12345678', b"DEEPSEEK_API_KEY=abc12345$(x)"):
            with self.subTest(unsafe):
                self.assertEqual(worker._provider_dotenv(unsafe), "")
        self.assertEqual(worker._provider_dotenv(b"DEEPSEEK_API_KEY=\xff\xfe-not-utf8"), "")
        self.assertEqual(worker._provider_dotenv(b""), "")

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() != 0, "needs a non-root POSIX user so directory permissions are enforced")
    def test_a_real_child_can_write_its_logs_while_the_profile_directory_is_read_only(self) -> None:
        runner_source = (
            "import json, os, pathlib, sys\n"
            "home = pathlib.Path(os.environ['HERMES_HOME'])\n"
            "(home / 'logs').mkdir()\n"
            "(home / 'logs' / 'agent.log').write_text('synthetic log line')\n"
            f"sys.stdout.write(json.dumps({AUDIT_OUTPUT!r}))\n"
        )
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_profile(temp)
            with open(fixture["runner"], "w", encoding="utf-8") as runner:
                runner.write(runner_source)
            before = snapshot(fixture["profile"])
            for name in PROFILE_FILES:
                os.chmod(os.path.join(fixture["profile"], name), 0o444)
            os.chmod(fixture["profile"], 0o555)
            try:
                # The precondition that made the first A2 audit fail: nothing can be created in the profile.
                with self.assertRaises(OSError):
                    os.makedirs(os.path.join(fixture["profile"], "logs"))
                with patch.dict(os.environ, worker_environment(fixture, audit=True)):
                    result = worker.run_pinned_hermes(audit_payload("7a5bde96-b288-4e54-8dad-5b6c7d8e9f88"))
                self.assertEqual(result["mode"], "prompt_audit")
                self.assertEqual(snapshot(fixture["profile"]), before)
                self.assertEqual(sorted(os.listdir(fixture["profile"])), sorted(PROFILE_FILES))
                self.assertEqual(os.listdir(fixture["runtime"]), [])
            finally:
                os.chmod(fixture["profile"], 0o755)


def undefined_global_names(path: str) -> list[str]:
    """Names a module reads as globals that it never imports, defines or gets from builtins."""
    import builtins
    import symtable

    with open(path, encoding="utf-8") as source:
        top = symtable.symtable(source.read(), path, "exec")
    defined = {
        symbol.get_name() for symbol in top.get_symbols()
        if symbol.is_assigned() or symbol.is_imported() or symbol.is_namespace()
    }
    defined.update({"__file__", "__name__", "__doc__"})
    missing: set[str] = set()

    def visit(table: symtable.SymbolTable) -> None:
        for symbol in table.get_symbols():
            name = symbol.get_name()
            if symbol.is_referenced() and symbol.is_global() and name not in defined and not hasattr(builtins, name):
                missing.add(f"{name} (in {table.get_name()})")
        for child in table.get_children():
            visit(child)

    visit(top)
    return sorted(missing)


class RunnerEntryPointTests(unittest.TestCase):
    """inference_runner.main() ran in no test or smoke until CI exercised it through the worker, and it
    used Path without importing it, so every real request failed with inference_failed."""

    def test_no_module_in_the_image_reads_an_undefined_global(self):
        directory = os.path.dirname(os.path.abspath(__file__))
        for name in sorted(os.listdir(directory)):
            if name.endswith(".py") and not name.startswith("test_"):
                with self.subTest(name):
                    self.assertEqual(undefined_global_names(os.path.join(directory, name)), [])

    def run_main(self, home: str, request: dict) -> str:
        values = {"HERMES_HOME": home, "IACQUIRE_INTERNAL_PROFILE": "iacquire-lead-hunter"}
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(request).encode("utf-8")), encoding="utf-8")
        with patch.dict(os.environ, values), patch.object(sys, "stdin", stdin):
            os.environ.pop("IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED", None)
            with self.assertRaises(inference_runner.RuntimeErrorSafe) as caught:
                inference_runner.main()
        return str(caught.exception)

    def test_main_reads_the_soul_from_the_runtime_home_before_it_loads_hermes(self):
        request = {
            "requestId": "7a5bde96-b288-4e54-8dad-5b6c7d8e9f88", "role": "lead_hunter", "instructions": "x", "input": "y",
            "chatInput": "z", "history": [], "mode": "prompt_audit",
        }
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(self.run_main(home, request), "profile_soul_unavailable")
            with open(os.path.join(home, "SOUL.md"), "w", encoding="utf-8") as soul:
                soul.write("Synthetic SOUL fixture.")
            # With a SOUL present main() gets past the Path check and stops at the audit switch, not at a NameError.
            self.assertEqual(self.run_main(home, request), "prompt_audit_disabled")


if __name__ == "__main__":
    unittest.main()
