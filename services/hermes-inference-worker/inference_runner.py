#!/opt/hermes/.venv/bin/python
"""One bounded AIAgent turn from the pinned Hermes runtime."""
from __future__ import annotations

import contextlib
import hmac
import http.server
import io
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit


UPSTREAM = "https://api.deepseek.com/v1/chat/completions"
MAX_REQUEST_BYTES = 64 * 1024
MAX_PROMPT_BYTES = 6_144
MAX_OUTPUT_TOKENS = 128
MAX_RESPONSE_BYTES = 256 * 1024
ALLOWED_MODELS = {"deepseek-flash", "deepseek-v4-pro"}
ALLOWED_PROFILE_IDS = {
    "operations_manager": "iacquire-operations-manager",
    "lead_hunter": "iacquire-lead-hunter",
    "appointment_setter": "iacquire-appointment-setter",
    "sales_assistant": "iacquire-sales-assistant",
    "crm_manager": "iacquire-crm-manager",
    "performance_analyst": "iacquire-analyst",
}


class RuntimeErrorSafe(Exception):
    pass


def _response_usage(body: bytes, content_type: str) -> tuple[dict[str, int] | None, str | None]:
    rows: list[dict[str, Any]] = []
    if "text/event-stream" in content_type.lower():
        for line in body.splitlines():
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if not data or data == b"[DONE]":
                continue
            try:
                value = json.loads(data)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return None, None
            if not isinstance(value, dict):
                return None, None
            rows.append(value)
    else:
        try:
            value = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, None
        if not isinstance(value, dict):
            return None, None
        rows.append(value)

    usage: dict[str, int] | None = None
    actual_model: str | None = None
    for value in rows:
        model = value.get("model")
        if isinstance(model, str):
            actual_model = model
        choices = value.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if not isinstance(choice, dict):
                    return None, None
                message = choice.get("message")
                delta = choice.get("delta")
                for part in (message, delta):
                    if isinstance(part, dict) and part.get("tool_calls"):
                        raise RuntimeErrorSafe("runtime_policy_violation")
                if choice.get("finish_reason") == "tool_calls":
                    raise RuntimeErrorSafe("runtime_policy_violation")
        raw = value.get("usage")
        if raw is not None:
            if not isinstance(raw, dict):
                return None, None
            prompt = raw.get("prompt_tokens")
            completion = raw.get("completion_tokens")
            total = raw.get("total_tokens")
            if any(type(n) is not int or n < 0 for n in (prompt, completion, total)):
                return None, None
            if total != prompt + completion or prompt > MAX_PROMPT_BYTES or completion > MAX_OUTPUT_TOKENS:
                raise RuntimeErrorSafe("runtime_token_limit_exceeded")
            usage = {"inputTokens": prompt, "outputTokens": completion, "totalTokens": total}
    return usage, actual_model


def _text_content_bytes(messages: Any) -> int:
    if not isinstance(messages, list) or not messages or len(messages) > 10:
        raise RuntimeErrorSafe("runtime_request_invalid")
    total = 0
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant"}:
            raise RuntimeErrorSafe("runtime_request_invalid")
        content = message.get("content")
        if not isinstance(content, str):
            raise RuntimeErrorSafe("runtime_request_invalid")
        total += len(content.encode("utf-8"))
    return total


class SingleRequestDeepSeekProxy:
    """Loopback OpenAI-compatible endpoint with one upstream call and a token ceiling."""

    def __init__(self, *, api_key: str, model: str, egress_proxy: str):
        self.api_key = api_key
        self.model = model
        self.egress_proxy = egress_proxy
        self.upstream_requests = 0
        self.usage: dict[str, int] | None = None
        self.actual_model: str | None = None
        self._lock = threading.Lock()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            server_version = "iAcquireHermesInferenceLoopback/1"
            sys_version = ""

            def log_message(self, _format: str, *args: Any) -> None:
                return

            def _reply(self, status: int, value: bytes, content_type: str = "application/json") -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(value)))
                self.end_headers()
                self.wfile.write(value)

            def do_POST(self) -> None:  # noqa: N802
                if self.path != "/v1/chat/completions":
                    self._reply(404, b'{"error":"not_found"}')
                    return
                try:
                    size = int(self.headers.get("Content-Length", "-1"))
                    if size < 1 or size > MAX_REQUEST_BYTES:
                        raise RuntimeErrorSafe("runtime_request_invalid")
                    raw = self.rfile.read(size)
                    if len(raw) != size:
                        raise RuntimeErrorSafe("runtime_request_invalid")
                    supplied = self.headers.get("Authorization", "")
                    if not supplied.startswith("Bearer ") or not hmac.compare_digest(supplied[7:], owner.api_key):
                        raise RuntimeErrorSafe("runtime_auth_invalid")
                    request = json.loads(raw.decode("utf-8"))
                    if not isinstance(request, dict) or request.get("model") != owner.model:
                        raise RuntimeErrorSafe("runtime_model_mismatch")
                    if request.get("tools") not in (None, []):
                        raise RuntimeErrorSafe("runtime_tool_schema_blocked")
                    if request.get("tool_choice") not in (None, "none") or "functions" in request or "function_call" in request:
                        raise RuntimeErrorSafe("runtime_tool_schema_blocked")
                    token_keys = [key for key in ("max_tokens", "max_completion_tokens") if key in request]
                    if len(token_keys) != 1 or type(request[token_keys[0]]) is not int or request[token_keys[0]] < 1:
                        raise RuntimeErrorSafe("runtime_token_limit_unset")
                    if _text_content_bytes(request.get("messages")) > MAX_PROMPT_BYTES:
                        raise RuntimeErrorSafe("runtime_prompt_limit_exceeded")
                    if type(request.get("stream", False)) is not bool:
                        raise RuntimeErrorSafe("runtime_request_invalid")
                    with owner._lock:
                        if owner.upstream_requests:
                            self._reply(429, b'{"error":"single_request_budget_exhausted"}')
                            return
                        owner.upstream_requests += 1
                    request["max_tokens"] = min(request[token_keys[0]], MAX_OUTPUT_TOKENS)
                    request.pop("max_completion_tokens", None)
                    request.pop("stream_options", None)
                    request["thinking"] = {"type": "disabled"}
                    request["reasoning_effort"] = "none"
                    if request.get("stream"):
                        request["stream_options"] = {"include_usage": True}
                    body = json.dumps(request, separators=(",", ":")).encode("utf-8")
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": owner.egress_proxy}))
                    outbound = urllib.request.Request(
                        UPSTREAM,
                        data=body,
                        headers={
                            "Authorization": supplied,
                            "Content-Type": "application/json",
                            "Accept": "text/event-stream" if request.get("stream") else "application/json",
                            "User-Agent": "iAcquireHermesInference/1",
                        },
                        method="POST",
                    )
                    try:
                        upstream = opener.open(outbound, timeout=25)
                    except urllib.error.HTTPError as error:
                        response_body = error.read(MAX_RESPONSE_BYTES + 1)
                        if len(response_body) > MAX_RESPONSE_BYTES:
                            self._reply(502, b'{"error":"provider_response_too_large"}')
                        else:
                            self._reply(error.code, response_body, error.headers.get("Content-Type", "application/json"))
                        return
                    with upstream:
                        response_body = upstream.read(MAX_RESPONSE_BYTES + 1)
                        content_type = upstream.headers.get("Content-Type", "application/json")
                        status = upstream.status
                    if len(response_body) > MAX_RESPONSE_BYTES:
                        self._reply(502, b'{"error":"provider_response_too_large"}')
                        return
                    owner.usage, owner.actual_model = _response_usage(response_body, content_type)
                    if status == 200 and owner.usage is None:
                        self._reply(502, b'{"error":"provider_usage_missing_or_invalid"}')
                        return
                    self._reply(status, response_body, content_type)
                except RuntimeErrorSafe as error:
                    status = 429 if error.args[0] == "single_request_budget_exhausted" else 400
                    self._reply(status, json.dumps({"error": error.args[0]}).encode("utf-8"))
                except Exception:
                    self._reply(502, b'{"error":"provider_request_failed"}')

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)


def _configured_provider() -> str:
    from hermes_cli.auth import PROVIDER_REGISTRY, get_env_value_prefer_dotenv, resolve_provider
    from hermes_cli.config import load_config

    config = load_config()
    provider = resolve_provider()
    if provider != "deepseek":
        raise RuntimeErrorSafe("configured_provider_not_deepseek")
    key = get_env_value_prefer_dotenv("DEEPSEEK_API_KEY")
    if not isinstance(key, str) or len(key.strip()) < 12:
        raise RuntimeErrorSafe("deepseek_credential_unavailable")
    configured_base = get_env_value_prefer_dotenv("DEEPSEEK_BASE_URL")
    expected_base = PROVIDER_REGISTRY["deepseek"].inference_base_url.rstrip("/")
    if configured_base and configured_base.rstrip("/") != expected_base:
        raise RuntimeErrorSafe("deepseek_endpoint_not_approved")
    model_cfg = config.get("model") if isinstance(config, dict) else None
    if not isinstance(model_cfg, dict) or model_cfg.get("provider") not in (None, "auto", "deepseek"):
        raise RuntimeErrorSafe("configured_provider_mismatch")
    return key


def _emit(value: dict[str, Any]) -> None:
    # Hermes logs are redirected while the run is active. Write only the validated compact
    # result to the original subprocess pipe, leaving logs and provider errors discarded.
    output = sys.__stdout__
    if output is None:
        raise RuntimeErrorSafe("runtime_output_unavailable")
    output.write(json.dumps(value, separators=(",", ":")))
    output.flush()


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise RuntimeErrorSafe("request_too_large")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeErrorSafe("request_invalid") from None
    if not isinstance(payload, dict) or set(payload) != {"requestId", "role", "instructions", "input", "history"}:
        raise RuntimeErrorSafe("request_invalid")
    role = payload.get("role")
    if role not in ALLOWED_PROFILE_IDS or os.environ.get("IACQUIRE_INTERNAL_PROFILE") != ALLOWED_PROFILE_IDS[role]:
        raise RuntimeErrorSafe("profile_not_allowed")
    soul_path = Path(os.environ.get("HERMES_HOME", "")) / "SOUL.md"
    if soul_path.is_symlink() or not soul_path.is_file() or not 1 <= soul_path.stat().st_size <= 16_384:
        raise RuntimeErrorSafe("profile_soul_unavailable")
    if not isinstance(payload.get("instructions"), str) or not isinstance(payload.get("input"), str) or not isinstance(payload.get("history"), list):
        raise RuntimeErrorSafe("request_invalid")
    egress_proxy = os.environ.get("IACQUIRE_DEEPSEEK_EGRESS_PROXY", "")
    parsed_proxy = urlsplit(egress_proxy)
    if parsed_proxy.scheme != "http" or parsed_proxy.hostname != "iacquire-deepseek-egress-proxy" or parsed_proxy.port != 3128 or parsed_proxy.path not in ("", "/"):
        raise RuntimeErrorSafe("runtime_network_policy_unavailable")
    api_key = _configured_provider()

    from run_agent import AIAgent
    from hermes_cli.auth import resolve_provider

    if resolve_provider() != "deepseek":
        raise RuntimeErrorSafe("configured_provider_changed")

    proxy: SingleRequestDeepSeekProxy | None = None
    agent = None
    try:
        # Hermes remains the model runtime. Its OpenAI-compatible client is directed to a loopback
        # request gate, which forwards exactly one bounded request to the official DeepSeek host.
        # No other API surface or provider fallback can leave this process.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            config = __import__("hermes_cli.config", fromlist=["load_config"]).load_config()
            raw_model = config.get("model") if isinstance(config, dict) else None
            model_hint = ""
            if isinstance(raw_model, dict):
                for key in ("default", "name", "model"):
                    candidate = raw_model.get(key)
                    if isinstance(candidate, str) and candidate.strip():
                        model_hint = candidate.strip()
                        break
            if not model_hint:
                raise RuntimeErrorSafe("configured_model_unavailable")
            # Hermes v0.22.5 runs current model IDs without a provider prefix. Refuse any value
            # that could become an endpoint or carry credentials through the local proxy.
            if model_hint not in ALLOWED_MODELS:
                raise RuntimeErrorSafe("configured_model_invalid")
            proxy = SingleRequestDeepSeekProxy(api_key=api_key, model=model_hint, egress_proxy=egress_proxy)
            agent = AIAgent(
                base_url=proxy.base_url,
                api_key=api_key,
                provider="deepseek",
                model=model_hint,
                max_iterations=1,
                enabled_toolsets=[],
                disabled_toolsets=None,
                save_trajectories=False,
                verbose_logging=False,
                quiet_mode=True,
                max_tokens=MAX_OUTPUT_TOKENS,
                ephemeral_system_prompt=payload["instructions"],
                skip_context_files=True,
                load_soul_identity=True,
                skip_memory=True,
                skip_background_review=True,
                run_budget_seconds=24,
                fallback_model=None,
            )
            if getattr(agent, "provider", None) != "deepseek" or getattr(agent, "model", None) != model_hint:
                raise RuntimeErrorSafe("runtime_provider_or_model_mismatch")
            tools = getattr(agent, "tools", None)
            if tools not in ([], None) or getattr(agent, "valid_tool_names", set()) not in (set(), frozenset()):
                raise RuntimeErrorSafe("runtime_tool_schema_present")
            if getattr(agent, "_fallback_chain", []) not in ([], None):
                raise RuntimeErrorSafe("runtime_fallback_present")

            def block_tool_dispatch(*_args: Any, **_kwargs: Any) -> None:
                raise RuntimeErrorSafe("runtime_tool_dispatch_blocked")

            agent._execute_tool_calls = block_tool_dispatch
            agent._api_max_retries = 1
            agent._auto_recovery_cycles = 0
            history = payload["history"]
            transcript = ""
            if history:
                rows = []
                for row in history:
                    if not isinstance(row, dict) or set(row) != {"role", "content"} or row.get("role") not in {"user", "assistant"} or not isinstance(row.get("content"), str):
                        raise RuntimeErrorSafe("history_invalid")
                    label = "User" if row["role"] == "user" else "Assistant"
                    rows.append(f"{label}: {row['content']}")
                transcript = "Conversation context (for continuity only):\n" + "\n".join(rows) + "\n\n"
            result = agent.run_conversation(transcript + payload["input"])
            if proxy.upstream_requests != 1:
                raise RuntimeErrorSafe("provider_request_count_invalid")
            if proxy.usage is None or proxy.actual_model != model_hint:
                raise RuntimeErrorSafe("provider_usage_missing")
            if not isinstance(result, dict) or result.get("completed") is not True:
                raise RuntimeErrorSafe("inference_failed")
            content = result.get("final_response")
            if not isinstance(content, str) or not content.strip() or len(content) > 4_096:
                raise RuntimeErrorSafe("inference_response_invalid")
            if int(getattr(agent, "session_api_calls", 1)) > 1:
                raise RuntimeErrorSafe("runtime_request_budget_exceeded")
            _emit({
                "ok": True,
                "provider": "deepseek",
                "model": proxy.actual_model,
                "content": content,
                "usage": proxy.usage,
                "toolSchemas": 0,
                "toolCalls": 0,
            })
    finally:
        if agent is not None:
            with contextlib.suppress(Exception):
                agent.close()
        if proxy is not None:
            proxy.close()


if __name__ == "__main__":
    try:
        main()
    except RuntimeErrorSafe:
        _emit({"ok": False})
        raise SystemExit(2)
    except Exception:
        # Error messages and provider bodies may contain private data; the parent discards stderr.
        _emit({"ok": False})
        raise SystemExit(2)
