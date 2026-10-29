#!/usr/bin/env python3
"""Authenticated, inference-only bridge for the six internal Hermes employees.

This service is deliberately separate from the normal Hermes run API. It accepts only
signed, bounded chat turns, resolves an existing internal profile's DeepSeek settings,
and starts one isolated Hermes AIAgent turn with an explicitly empty toolset.
"""
from __future__ import annotations

import collections
import hashlib
import hmac
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable


ROLE_PROFILES = {
    "operations_manager": "iacquire-operations-manager",
    "lead_hunter": "iacquire-lead-hunter",
    "appointment_setter": "iacquire-appointment-setter",
    "sales_assistant": "iacquire-sales-assistant",
    "crm_manager": "iacquire-crm-manager",
    "performance_analyst": "iacquire-analyst",
}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
MAX_BODY_BYTES = 48 * 1024
MAX_RESPONSE_BYTES = 16 * 1024
MAX_INSTRUCTIONS_CHARS = 16_000
MAX_INPUT_CHARS = 2_000
MAX_HISTORY_MESSAGES = 8
MAX_HISTORY_CHARS = 5_000
MAX_PROMPT_BYTES = 6_144
MAX_INPUT_TOKENS = 8_192
MAX_OUTPUT_CHARS = 4_096
MAX_OUTPUT_TOKENS = 128
REQUEST_TIMEOUT_SECONDS = 32
SIGNATURE_WINDOW_SECONDS = 30
RATE_WINDOW_SECONDS = 60
RATE_PER_ACTOR = 6
RATE_PER_PROFILE = 2
GLOBAL_RATE = 30
DEFAULT_RUNNER_PATH = "/opt/iacquire-hermes/inference/inference_runner.py"
INFERENCE_PATH_PREFIX = "/internal/inference/v1"

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("iacquire.hermes.inference")


class RequestError(Exception):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def _clean_history(raw: Any) -> list[dict[str, str]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_HISTORY_MESSAGES:
        raise RequestError("invalid_history")
    history: list[dict[str, str]] = []
    total = 0
    for row in raw:
        if not isinstance(row, dict) or set(row) != {"role", "content"}:
            raise RequestError("invalid_history")
        role, content = row["role"], row["content"]
        if role not in {"user", "assistant"} or not isinstance(content, str) or not content.strip() or len(content) > 2_000:
            raise RequestError("invalid_history")
        total += len(content)
        history.append({"role": role, "content": content})
    if total > MAX_HISTORY_CHARS:
        raise RequestError("history_too_large")
    return history


def validate_payload(raw: bytes) -> dict[str, Any]:
    if not raw or len(raw) > MAX_BODY_BYTES:
        raise RequestError("body_too_large", 413)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RequestError("invalid_json") from None
    if not isinstance(value, dict) or set(value) != {"requestId", "actorId", "role", "instructions", "input", "history"}:
        raise RequestError("invalid_request")
    request_id, actor_id, role = value["requestId"], value["actorId"], value["role"]
    instructions, user_input = value["instructions"], value["input"]
    if not isinstance(request_id, str) or not UUID_RE.fullmatch(request_id):
        raise RequestError("invalid_request_id")
    if not isinstance(actor_id, str) or not UUID_RE.fullmatch(actor_id):
        raise RequestError("invalid_actor")
    if not isinstance(role, str) or role not in ROLE_PROFILES:
        raise RequestError("profile_not_allowed", 403)
    if not isinstance(instructions, str) or not instructions.strip() or len(instructions) > MAX_INSTRUCTIONS_CHARS:
        raise RequestError("instructions_too_large")
    if not isinstance(user_input, str) or not user_input.strip() or len(user_input) > MAX_INPUT_CHARS:
        raise RequestError("input_too_large")
    history = _clean_history(value["history"])
    if len((instructions + user_input + "".join(row["content"] for row in history)).encode("utf-8")) > MAX_PROMPT_BYTES:
        raise RequestError("prompt_too_large", 413)
    return {
        "requestId": request_id,
        "actorId": actor_id,
        "role": role,
        "instructions": instructions,
        "input": user_input,
        "history": history,
    }


def load_worker_secret(path_value: str) -> bytes:
    path = Path(path_value)
    try:
        if not path.is_absolute() or path.is_symlink():
            raise OSError("unsafe secret file")
        resolved = path.resolve(strict=True)
        if resolved != path:
            raise OSError("unsafe secret path")
        info = path.stat()
        if not path.is_file() or info.st_size < 32 or info.st_size > 512:
            raise OSError("invalid secret file")
        if os.name != "nt" and info.st_mode & 0o077:
            raise OSError("secret permissions too broad")
        secret = path.read_bytes().strip()
        if not 32 <= len(secret) <= 512 or any(byte < 0x21 or byte > 0x7e for byte in secret):
            raise OSError("invalid secret content")
        return secret
    except OSError:
        raise RequestError("worker_auth_unavailable", 503) from None


def request_signature(secret: bytes, timestamp: str, body: bytes) -> str:
    message = timestamp.encode("ascii") + b"." + hashlib.sha256(body).hexdigest().encode("ascii")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def inference_path(role: str) -> str:
    if role not in ROLE_PROFILES:
        raise ValueError("worker role is not supported")
    return f"{INFERENCE_PATH_PREFIX}/{role}/infer"


class RequestGuard:
    def __init__(self, *, clock: Callable[[], float] = time.time):
        self._clock = clock
        self._lock = threading.Lock()
        self._seen: dict[str, float] = {}
        self._actor_hits: dict[str, collections.deque[float]] = {}
        self._profile_hits: dict[str, collections.deque[float]] = {}
        self._global_hits: collections.deque[float] = collections.deque()
        self._active = threading.BoundedSemaphore(1)

    def authorize(self, headers: Any, body: bytes, secret: bytes, payload: dict[str, Any]) -> None:
        timestamp = headers.get("X-Iacquire-Timestamp", "")
        supplied = headers.get("X-Iacquire-Signature", "")
        if not timestamp.isdigit() or len(timestamp) > 12:
            raise RequestError("unauthorized", 401)
        now = self._clock()
        if abs(now - int(timestamp)) > SIGNATURE_WINDOW_SECONDS:
            raise RequestError("expired_signature", 401)
        expected = request_signature(secret, timestamp, body)
        if not hmac.compare_digest(expected, supplied.lower()):
            raise RequestError("unauthorized", 401)
        request_id = payload["requestId"]
        actor = payload["actorId"]
        role = payload["role"]
        with self._lock:
            self._prune(now)
            if request_id in self._seen:
                raise RequestError("duplicate_request", 409)
            actor_hits = self._actor_hits.setdefault(actor, collections.deque())
            profile_key = f"{actor}:{role}"
            profile_hits = self._profile_hits.setdefault(profile_key, collections.deque())
            if len(actor_hits) >= RATE_PER_ACTOR or len(profile_hits) >= RATE_PER_PROFILE or len(self._global_hits) >= GLOBAL_RATE:
                raise RequestError("rate_limited", 429)
            self._seen[request_id] = now
            actor_hits.append(now)
            profile_hits.append(now)
            self._global_hits.append(now)

    def acquire(self) -> bool:
        return self._active.acquire(blocking=False)

    def release(self) -> None:
        self._active.release()

    def _prune(self, now: float) -> None:
        cutoff = now - RATE_WINDOW_SECONDS
        for mapping in (self._actor_hits, self._profile_hits):
            for key in list(mapping):
                hits = mapping[key]
                while hits and hits[0] <= cutoff:
                    hits.popleft()
                if not hits:
                    del mapping[key]
        while self._global_hits and self._global_hits[0] <= cutoff:
            self._global_hits.popleft()
        for key in list(self._seen):
            if self._seen[key] <= cutoff:
                del self._seen[key]


def validate_runtime_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("ok") is not True:
        raise RequestError("inference_failed", 502)
    if value.get("provider") != "deepseek" or value.get("toolSchemas") != 0 or value.get("toolCalls") != 0:
        raise RequestError("runtime_policy_violation", 502)
    model = value.get("model")
    content = value.get("content")
    if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,120}", model):
        raise RequestError("runtime_response_invalid", 502)
    if not isinstance(content, str) or not content.strip() or len(content) > MAX_OUTPUT_CHARS:
        raise RequestError("runtime_response_invalid", 502)
    usage = value.get("usage")
    if not isinstance(usage, dict) or set(usage) != {"inputTokens", "outputTokens", "totalTokens"}:
        raise RequestError("runtime_usage_invalid", 502)
    if any(type(n) is not int or n < 0 for n in usage.values()):
        raise RequestError("runtime_usage_invalid", 502)
    if usage["outputTokens"] > MAX_OUTPUT_TOKENS or usage["inputTokens"] > MAX_INPUT_TOKENS:
        raise RequestError("runtime_token_limit_exceeded", 502)
    if usage["totalTokens"] != usage["inputTokens"] + usage["outputTokens"]:
        raise RequestError("runtime_usage_invalid", 502)
    return {"content": content, "usage": usage, "model": model, "provider": "deepseek", "toolSchemas": 0, "toolCalls": 0}


def execute(payload: dict[str, Any], runner: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
    result = validate_runtime_result(runner(payload))
    return {"ok": True, **result}


def _log_result(payload: dict[str, Any], result: dict[str, Any] | None, status: str) -> None:
    usage = result.get("usage") if result else None
    logger.info(json.dumps({
        "event": "inference_only_result",
        "requestId": payload["requestId"],
        "actorId": payload["actorId"],
        "role": payload["role"],
        "provider": "deepseek",
        "model": result.get("model") if result else None,
        "toolSchemas": 0,
        "toolCalls": 0,
        "inputTokens": usage.get("inputTokens") if isinstance(usage, dict) else None,
        "outputTokens": usage.get("outputTokens") if isinstance(usage, dict) else None,
        "status": status,
    }, separators=(",", ":")))


def run_pinned_hermes(payload: dict[str, Any]) -> dict[str, Any]:
    runner_path = Path(os.environ.get("IACQUIRE_HERMES_INFERENCE_RUNNER", DEFAULT_RUNNER_PATH))
    python = os.environ.get("IACQUIRE_HERMES_PYTHON", "/opt/hermes/.venv/bin/python")
    if not runner_path.is_absolute() or not Path(python).is_absolute():
        raise RequestError("runtime_unavailable", 503)
    profile = ROLE_PROFILES[payload["role"]]
    profile_root = Path(os.environ.get("IACQUIRE_INTERNAL_PROFILE_ROOT", "/profiles"))
    profile_path = profile_root / profile
    proxy = os.environ.get("IACQUIRE_DEEPSEEK_EGRESS_PROXY", "")
    if not profile_root.is_absolute() or not profile_path.is_dir() or profile_path.is_symlink():
        raise RequestError("runtime_profile_unavailable", 503)
    if not proxy.startswith("http://iacquire-deepseek-egress-proxy:"):
        raise RequestError("runtime_network_policy_unavailable", 503)
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
        "HERMES_HOME": str(profile_path),
        "HOME": "/tmp",
        "IACQUIRE_INTERNAL_PROFILE": profile,
        "IACQUIRE_HERMES_TEMP_ROOT": "/tmp",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": "/opt/hermes",
        "IACQUIRE_DEEPSEEK_EGRESS_PROXY": proxy,
    }
    request = {key: payload[key] for key in ("requestId", "role", "instructions", "input", "history")}
    try:
        completed = subprocess.run(
            [python, str(runner_path)],
            input=json.dumps(request, separators=(",", ":")),
            text=True,
            capture_output=True,
            timeout=REQUEST_TIMEOUT_SECONDS,
            check=False,
            env=env,
            cwd="/tmp",
        )
    except subprocess.TimeoutExpired:
        raise RequestError("inference_timeout", 504) from None
    except OSError:
        raise RequestError("runtime_unavailable", 503) from None
    if completed.returncode != 0:
        # Child errors may contain provider details, prompt text, or credentials; never surface them.
        raise RequestError("inference_failed", 502)
    try:
        return json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        raise RequestError("runtime_response_invalid", 502) from None


def make_handler(
    secret: bytes,
    allowed_role: str,
    runner: Callable[[dict[str, Any]], dict[str, Any]] = run_pinned_hermes,
    guard: RequestGuard | None = None,
):
    if allowed_role not in ROLE_PROFILES:
        raise ValueError("worker role is not supported")
    request_guard = guard or RequestGuard()

    class Handler(BaseHTTPRequestHandler):
        server_version = "iAcquireHermesInference/1"
        sys_version = ""

        def log_message(self, _format: str, *args: Any) -> None:
            # The standard handler format includes URL paths and is not needed for this private service.
            return

        def _send_json(self, status: int, value: dict[str, Any]) -> None:
            encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
            if len(encoded) > MAX_RESPONSE_BYTES:
                status = 502
                encoded = b'{"error":"runtime_response_too_large"}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz" and self.client_address[0] in {"127.0.0.1", "::1"}:
                self._send_json(200, {"ok": True, "provider": "deepseek", "toolSchemas": 0})
                return
            self._send_json(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != inference_path(allowed_role):
                self._send_json(404, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "-1"))
                if length < 0 or length > MAX_BODY_BYTES:
                    raise RequestError("body_too_large", 413)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise RequestError("invalid_body")
                payload = validate_payload(raw)
                if payload["role"] != allowed_role:
                    raise RequestError("profile_not_allowed", 403)
                request_guard.authorize(self.headers, raw, secret, payload)
                if not request_guard.acquire():
                    raise RequestError("worker_busy", 429)
                try:
                    result = execute(payload, runner)
                finally:
                    request_guard.release()
                _log_result(payload, result, "success")
                self._send_json(200, {"requestId": payload["requestId"], **result})
            except RequestError as error:
                safe = {"error": error.code}
                if "payload" in locals():
                    _log_result(payload, None, error.code)
                self._send_json(error.status, safe)
            except Exception:
                self._send_json(500, {"error": "inference_failed"})

    return Handler


def serve() -> None:
    secret_path = os.environ.get("IACQUIRE_INFERENCE_WORKER_SECRET_FILE", "")
    if not secret_path:
        raise SystemExit("worker stopped: worker_auth_unavailable")
    secret = load_worker_secret(secret_path)
    allowed_role = os.environ.get("IACQUIRE_INFERENCE_WORKER_ALLOWED_ROLE", "")
    if allowed_role not in ROLE_PROFILES:
        raise SystemExit("worker stopped: worker_role_invalid")
    host = os.environ.get("IACQUIRE_INFERENCE_WORKER_HOST", "0.0.0.0")
    port_value = os.environ.get("IACQUIRE_INFERENCE_WORKER_PORT", "8786")
    if host not in {"127.0.0.1", "0.0.0.0"} or not port_value.isdigit() or not 1 <= int(port_value) <= 65535:
        raise SystemExit("worker stopped: worker_config_invalid")
    server = ThreadingHTTPServer((host, int(port_value)), make_handler(secret, allowed_role))
    server.daemon_threads = True
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    if sys.argv[1:] != ["--serve"]:
        raise SystemExit("worker stopped: invalid_worker_command")
    serve()
