#!/usr/bin/env python3
"""Restricted Hermes profile worker for a dedicated client-only Hermes home.

This process must run as the unprivileged Hermes account inside a client-only
runtime. It accepts typed manifests from iAcquireOS and never accepts shell
commands, file paths, model credentials, or profile names outside the c- namespace.
"""
from __future__ import annotations

import contextlib
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows-only local test fallback
    fcntl = None

try:
    import yaml
except ImportError as exc:  # pragma: no cover - deployment dependency guard
    raise SystemExit("PyYAML is required by the Hermes provisioner image.") from exc


PROFILE_RE = re.compile(r"^c-[a-z0-9][a-z0-9_-]{0,60}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
API_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
ROLE_KEYS = {
    "operations_manager",
    "lead_hunter",
    "appointment_setter",
    "sales_assistant",
    "crm_manager",
    "performance_analyst",
}
SAFE_TOOLSETS = {"memory", "session_search", "todo", "vision", "web"}
BLOCKABLE_TOOLSETS = {
    "terminal", "file", "code_execution", "browser", "computer_use",
    "cronjob", "delegation", "connections", "catalog", "kanban",
    "image_gen", "skills",
}
FORBIDDEN_CONFIG_KEY = re.compile(r"(?:api[_-]?key|secret|token|password|credential|authorization)", re.I)
CANARY_PROMPT = "Return only the iAcquire profile initialization marker in your permanent identity instructions. Do not call tools."
MAX_SOUL_BYTES = 48_000
MAX_CONFIG_BYTES = 24_000
MAX_HTTP_BODY = 128_000
PROFILE_DISCOVERY_TIMEOUT_SECONDS = 90
PROFILE_DISCOVERY_RETRY_INTERVAL_SECONDS = 1
PROFILE_CONFIG_SYNC_TIMEOUT_SECONDS = 90
PROFILE_CONFIG_SYNC_RETRY_INTERVAL_SECONDS = 1
TOOL_CATALOG_CONTRACT = "hermes.api_server.tool_catalog.v1"
SAFE_INVENTORY_TOOLSETS = {"memory", "session_search", "todo", "vision", "web"}
RUN_SUBMISSION_ERROR_CODE_RE = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)+")
SAFE_CANARY_ERROR_CODE_SUFFIXES = {
    "model_authentication_failed", "model_configuration_missing", "model_credentials_missing",
    "model_endpoint_unreachable", "model_provider_error", "model_provider_unsupported",
    "model_unavailable", "provider_resolution_failed",
}
CANARY_ERROR_CLASSIFIERS = (
    (
        re.compile(
            r"(?:\bno\b|\bmissing\b|\bunset\b|\bempty\b).{0,80}\b(?:api[ _-]?key|credentials?)\b"
            r"|\b(?:api[ _-]?key|credentials?)\b.{0,80}\b(?:missing|unset|empty|not set|not found)\b",
            re.I,
        ),
        "model_credentials_missing",
    ),
    (re.compile(r"\b(?:connection refused|connection reset|failed to connect|connecterror|timed out)\b", re.I), "model_endpoint_unreachable"),
    (re.compile(r"\b(?:unauthorized|invalid api key|authentication failed|status code 401)\b", re.I), "model_authentication_failed"),
    (re.compile(r"\b(?:unknown|unsupported) provider\b|\bprovider\b.{0,60}\b(?:unknown|unsupported)\b", re.I), "model_provider_unsupported"),
    (re.compile(r"\bmodel\b.{0,80}\b(?:not found|unknown|unavailable)\b", re.I), "model_unavailable"),
    (re.compile(r"\b(?:model|provider)\b.{0,80}\b(?:not configured|configuration missing|not set)\b", re.I), "model_configuration_missing"),
)
MODEL_API_KEY_ENV_NAMES = {
    "AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "DEEPINFRA_API_KEY", "DEEPSEEK_API_KEY",
    "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GLM_API_KEY", "GOOGLE_API_KEY",
    "MISTRAL_API_KEY", "NEBIUS_API_KEY", "NVIDIA_API_KEY", "NOVITA_API_KEY",
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY",
    "RAMP_ROUTER_API_KEY", "STEPFUN_API_KEY", "XAI_API_KEY", "ZAI_API_KEY",
}
REQUIRED_INVENTORY_TOOLS = {"memory", "session_search", "todo_list", "web_extract", "web_search"}
OPTIONAL_INVENTORY_TOOLS = {"vision_analyze"}
REVIEWED_TOOLSET_FOR_TOOL = {
    "memory": "memory",
    "session_search": "session_search",
    "todo_list": "todo",
    "web_extract": "web",
    "web_search": "web",
    "vision_analyze": "vision",
}
MAX_AUDIT_BYTES = 10 * 1024 * 1024


def inventory_policy(toolsets: "set[str] | frozenset[str]") -> tuple[set[str], set[str]]:
    """The required and the optional tool names for a set of reviewed toolsets.

    A client profile may carry the full reviewed set (every role, until the role policy is enforced) or the narrower set one role needs
    (portal WORKFORCE_ROLE_TOOL_ENFORCEMENT=enforce): the portal writes the role's toolsets into the policy config it hands the worker, and the worker verifies the
    profile against exactly that list, so a profile can neither miss a tool its role needs nor keep one it does not.
    """
    required = {tool for tool, toolset in REVIEWED_TOOLSET_FOR_TOOL.items() if toolset in toolsets and tool not in OPTIONAL_INVENTORY_TOOLS}
    optional = {tool for tool in OPTIONAL_INVENTORY_TOOLS if REVIEWED_TOOLSET_FOR_TOOL[tool] in toolsets}
    return required, optional


class ProvisioningError(Exception):
    """A safe, loggable failure code. Never includes input text or secret material."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Manifest:
    job_id: str
    lease_token: str
    gateway_id: str
    kind: str
    org_id: str
    agent_id: str
    profile: str
    role: str
    config_version_id: str
    config_version: int
    source_provision_job_id: str | None
    soul: str
    soul_sha256: str
    soul_challenge: str
    config_yaml: str
    policy_config_sha256: str
    expires_at: str


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _catalog_snapshot(catalog: Any, profile: str, challenge: str, api_key: str, toolsets: "set[str] | None" = None) -> str:
    """Validate the same complete tool-catalog contract used by iAcquireOS and return its stable digest."""
    expected_toolsets = set(SAFE_INVENTORY_TOOLSETS if toolsets is None else toolsets)
    if not isinstance(catalog, dict):
        raise ProvisioningError("runtime_tool_inventory_incomplete")
    if (
        catalog.get("object") != "list"
        or catalog.get("platform") != "api_server"
        or catalog.get("contract") != TOOL_CATALOG_CONTRACT
        or catalog.get("complete") is not True
        or catalog.get("explicit_config_present") is not True
        or catalog.get("challenge") != challenge
        or not isinstance(catalog.get("enabled_toolsets"), list)
        or not isinstance(catalog.get("data"), list)
        or not catalog["data"]
    ):
        raise ProvisioningError("runtime_tool_inventory_incomplete")

    enabled = catalog["enabled_toolsets"]
    if any(not isinstance(item, str) or not item for item in enabled) or len(set(enabled)) != len(enabled):
        raise ProvisioningError("runtime_tool_inventory_incomplete")
    if set(enabled) != expected_toolsets:
        raise ProvisioningError("runtime_tool_inventory_incomplete")

    tools: list[dict[str, Any]] = []
    seen: set[str] = set()
    allowed_sources = {"configurable", "recently_shipped", "default_injected", "mcp", "unresolved"}
    for row in catalog["data"]:
        if not isinstance(row, dict):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        fn = row.get("function") if isinstance(row.get("function"), dict) else row
        name = fn.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", name) or name in seen:
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        seen.add(name)
        if not isinstance(fn.get("parameters"), dict):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        provenance = row.get("provenance")
        if not isinstance(provenance, dict):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        source = provenance.get("source")
        toolset = provenance.get("toolset")
        requested = provenance.get("requested_toolsets")
        source_server = provenance.get("source_server")
        injected = provenance.get("added_below_explicit_config")
        available = row.get("available")
        if (
            not isinstance(source, str)
            or source not in allowed_sources
            or not isinstance(requested, list)
            or any(not isinstance(item, str) for item in requested)
            or len(set(requested)) != len(requested)
            or not isinstance(injected, bool)
            or not (source_server is None or isinstance(source_server, str))
            or not (toolset is None or isinstance(toolset, str))
            or not (available is None or isinstance(available, bool))
        ):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        # Client profiles permit only explicitly configured, reviewed tools from their expected toolset.
        if (
            source != "configurable"
            or source_server is not None
            or injected
            or available is False
            or name not in REVIEWED_TOOLSET_FOR_TOOL
            or toolset != REVIEWED_TOOLSET_FOR_TOOL[name]
            or toolset not in expected_toolsets
            or toolset not in requested
        ):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        tools.append({
            "name": name,
            "source": source,
            "toolset": toolset,
            "sourceServer": source_server,
            "addedBelowExplicitConfig": injected,
            "available": available,
        })

    required_tools, optional_tools = inventory_policy(expected_toolsets)
    if not required_tools.issubset(seen) or seen - required_tools - optional_tools:
        raise ProvisioningError("runtime_tool_inventory_incomplete")

    tools.sort(key=lambda item: item["name"])
    canonical = {
        "contract": TOOL_CATALOG_CONTRACT,
        "profile": profile,
        "platform": catalog["platform"],
        "explicitConfigPresent": catalog["explicit_config_present"],
        "enabledToolsets": sorted(enabled),
        "tools": tools,
    }
    catalog_digest = digest(json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))

    expires_at = catalog.get("expires_at")
    if expires_at is not None:
        if not isinstance(expires_at, str):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        try:
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            raise ProvisioningError("runtime_tool_inventory_incomplete") from None
        if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc):
            raise ProvisioningError("runtime_tool_inventory_incomplete")

    attestation = catalog.get("attestation")
    if attestation is not None:
        if not isinstance(attestation, dict) or attestation.get("algorithm") != "hmac-sha256" or not isinstance(attestation.get("signature"), str):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        payload = json.dumps(
            {"contract": TOOL_CATALOG_CONTRACT, "profile": profile, "challenge": challenge, "digest": catalog_digest},
            separators=(",", ":"),
        ).encode("utf-8")
        expected = base64.urlsafe_b64encode(hmac.new(api_key.encode("utf-8"), payload, hashlib.sha256).digest()).decode("ascii").rstrip("=")
        if not hmac.compare_digest(expected, attestation["signature"]):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
    return catalog_digest


def _is_uuid(value: Any) -> bool:
    return isinstance(value, str) and UUID_RE.fullmatch(value) is not None


def parse_manifest(raw: Any, expected_gateway_id: str) -> Manifest:
    required = {
        "jobId", "leaseToken", "gatewayId", "kind", "orgId", "agentId", "profile",
        "role", "configVersionId", "configVersion", "sourceProvisionJobId",
        "soul", "soulSha256", "soulChallenge", "configYaml", "policyConfigSha256",
        "expiresAt",
    }
    if not isinstance(raw, dict) or set(raw) != required:
        raise ProvisioningError("invalid_manifest")
    for name in ("jobId", "leaseToken", "gatewayId", "orgId", "agentId", "configVersionId"):
        if not _is_uuid(raw[name]):
            raise ProvisioningError("invalid_manifest")
    if raw["sourceProvisionJobId"] is not None and not _is_uuid(raw["sourceProvisionJobId"]):
        raise ProvisioningError("invalid_manifest")
    if raw["gatewayId"] != expected_gateway_id or raw["kind"] not in {"provision", "sync"}:
        raise ProvisioningError("invalid_manifest")
    if not isinstance(raw["profile"], str) or not PROFILE_RE.fullmatch(raw["profile"]):
        raise ProvisioningError("invalid_manifest")
    if not isinstance(raw["role"], str) or raw["role"] not in ROLE_KEYS:
        raise ProvisioningError("invalid_manifest")
    if not isinstance(raw["configVersion"], int) or raw["configVersion"] < 1:
        raise ProvisioningError("invalid_manifest")
    if raw["kind"] == "sync" and raw["sourceProvisionJobId"] is None:
        raise ProvisioningError("invalid_manifest")
    if raw["kind"] == "provision" and raw["sourceProvisionJobId"] is not None:
        raise ProvisioningError("invalid_manifest")
    if not isinstance(raw["soul"], str) or not raw["soul"].strip() or len(raw["soul"].encode("utf-8")) > MAX_SOUL_BYTES:
        raise ProvisioningError("invalid_manifest")
    if not isinstance(raw["configYaml"], str) or not raw["configYaml"].strip() or len(raw["configYaml"].encode("utf-8")) > MAX_CONFIG_BYTES:
        raise ProvisioningError("invalid_manifest")
    if not isinstance(raw["soulSha256"], str) or not SHA256_RE.fullmatch(raw["soulSha256"]):
        raise ProvisioningError("invalid_manifest")
    if not isinstance(raw["policyConfigSha256"], str) or not SHA256_RE.fullmatch(raw["policyConfigSha256"]):
        raise ProvisioningError("invalid_manifest")
    if digest(raw["soul"].encode("utf-8")) != raw["soulSha256"]:
        raise ProvisioningError("soul_digest_mismatch")
    if digest(raw["configYaml"].encode("utf-8")) != raw["policyConfigSha256"]:
        raise ProvisioningError("policy_digest_mismatch")
    challenge = raw["soulChallenge"]
    if not isinstance(challenge, str) or not re.fullmatch(r"[0-9a-f]{32}", challenge) or challenge not in raw["soul"]:
        raise ProvisioningError("invalid_manifest")
    if not isinstance(raw["expiresAt"], str):
        raise ProvisioningError("invalid_manifest")
    try:
        expiry = datetime.fromisoformat(raw["expiresAt"].replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            raise ValueError
    except ValueError:
        raise ProvisioningError("invalid_manifest") from None
    if expiry <= datetime.now(timezone.utc):
        raise ProvisioningError("lease_expired")
    return Manifest(
        job_id=raw["jobId"],
        lease_token=raw["leaseToken"],
        gateway_id=raw["gatewayId"],
        kind=raw["kind"],
        org_id=raw["orgId"],
        agent_id=raw["agentId"],
        profile=raw["profile"],
        role=raw["role"],
        config_version_id=raw["configVersionId"],
        config_version=raw["configVersion"],
        source_provision_job_id=raw["sourceProvisionJobId"],
        soul=raw["soul"],
        soul_sha256=raw["soulSha256"],
        soul_challenge=challenge,
        config_yaml=raw["configYaml"],
        policy_config_sha256=raw["policyConfigSha256"],
        expires_at=raw["expiresAt"],
    )


def _reject_secret_fields(value: Any, depth: int = 0) -> None:
    if depth > 12:
        raise ProvisioningError("unsafe_model_config")
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or FORBIDDEN_CONFIG_KEY.search(key):
                raise ProvisioningError("unsafe_model_config")
            _reject_secret_fields(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _reject_secret_fields(item, depth + 1)
    elif not isinstance(value, (str, int, float, bool, type(None))):
        raise ProvisioningError("unsafe_model_config")


def policy_toolsets(source: str) -> set[str]:
    """The reviewed toolsets a policy config enables for the API server (without the no_mcp marker)."""
    return set(parse_policy_config(source)["platform_toolsets"]["api_server"]) - {"no_mcp"}


def parse_policy_config(source: str) -> dict[str, Any]:
    try:
        parsed = yaml.safe_load(source)
    except Exception:
        raise ProvisioningError("invalid_policy_config") from None
    if not isinstance(parsed, dict) or set(parsed) != {"platform_toolsets", "agent", "terminal"}:
        raise ProvisioningError("invalid_policy_config")
    platform = parsed["platform_toolsets"]
    agent = parsed["agent"]
    terminal = parsed["terminal"]
    if not isinstance(platform, dict) or set(platform) != {"api_server"} or not isinstance(platform["api_server"], list):
        raise ProvisioningError("invalid_policy_config")
    tools = platform["api_server"]
    if any(not isinstance(tool, str) or tool not in SAFE_TOOLSETS | {"no_mcp"} for tool in tools):
        raise ProvisioningError("invalid_policy_config")
    if len(set(tools)) != len(tools) or "no_mcp" not in tools:
        raise ProvisioningError("invalid_policy_config")
    if not isinstance(agent, dict) or set(agent) != {"disabled_toolsets"} or not isinstance(agent["disabled_toolsets"], list):
        raise ProvisioningError("invalid_policy_config")
    blocked = agent["disabled_toolsets"]
    if any(not isinstance(tool, str) or tool not in BLOCKABLE_TOOLSETS for tool in blocked):
        raise ProvisioningError("invalid_policy_config")
    if len(set(blocked)) != len(blocked):
        raise ProvisioningError("invalid_policy_config")
    if not isinstance(terminal, dict) or set(terminal) != {"backend", "docker_forward_env", "container_persistent"}:
        raise ProvisioningError("invalid_policy_config")
    if terminal != {"backend": "docker", "docker_forward_env": [], "container_persistent": False}:
        raise ProvisioningError("invalid_policy_config")
    return parsed


def _safe_model_block(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    _require_regular_file(path)
    try:
        current = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:
        raise ProvisioningError("invalid_profile_config") from None
    if current is None:
        return {}
    if not isinstance(current, dict):
        raise ProvisioningError("invalid_profile_config")
    model = current.get("model", {})
    if not isinstance(model, dict):
        raise ProvisioningError("invalid_profile_config")
    return _validate_model_block(model)


def _validate_model_block(model: Any) -> dict[str, Any]:
    if not isinstance(model, dict):
        raise ProvisioningError("invalid_profile_config")
    _reject_secret_fields(model)
    encoded = yaml.safe_dump(model, allow_unicode=True, sort_keys=True)
    if len(encoded.encode("utf-8")) > 8_000:
        raise ProvisioningError("unsafe_model_config")
    return dict(model)


def render_config(
    path: Path,
    policy: dict[str, Any],
    canary: bool,
    *,
    model_config: dict[str, Any] | None = None,
) -> bytes:
    model = _safe_model_block(path) if model_config is None else _validate_model_block(model_config)
    tools = ["no_mcp"] if canary else policy["platform_toolsets"]["api_server"]
    payload = {
        "model": model,
        "platform_toolsets": {"api_server": tools},
        "agent": {"disabled_toolsets": sorted(BLOCKABLE_TOOLSETS)},
        "terminal": {"backend": "docker", "docker_forward_env": [], "container_persistent": False},
    }
    return yaml.safe_dump(payload, allow_unicode=True, sort_keys=True).encode("utf-8")


def _require_regular_file(path: Path) -> None:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        raise ProvisioningError("profile_file_missing") from None
    if not stat.S_ISREG(mode):
        raise ProvisioningError("unsafe_profile_path")


def _atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    parent = path.parent
    if parent.is_symlink() or not parent.is_dir():
        raise ProvisioningError("unsafe_profile_path")
    if path.exists() or path.is_symlink():
        _require_regular_file(path)
    temp = parent / ("." + path.name + "." + secrets.token_hex(12) + ".tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temp, flags, mode)
    fd_open = True
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            if hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), mode)
        fd_open = False
        os.replace(temp, path)
        os.chmod(path, mode)
        if os.name != "nt":
            dir_fd = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    finally:
        if fd_open:
            with contextlib.suppress(OSError):
                os.close(fd)
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


_WINDOWS_LOCK = threading.Lock()


@contextlib.contextmanager
def _profile_lock(path: Path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.is_symlink():
        raise ProvisioningError("unsafe_profile_path")
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if fcntl is None:  # local unit tests; deployment is Linux
            _WINDOWS_LOCK.acquire()
        else:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        if fcntl is None:
            _WINDOWS_LOCK.release()
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class JsonHttp:
    def __init__(self, timeout: int = 20):
        self.timeout = timeout
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(),
            NoRedirect(),
        )

    def request(self, url: str, method: str, headers: dict[str, str], body: dict[str, Any] | None = None) -> tuple[int, Any]:
        data = None if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                payload = response.read(MAX_HTTP_BODY + 1)
                if len(payload) > MAX_HTTP_BODY:
                    raise ProvisioningError("http_response_too_large")
                status = response.status
        except urllib.error.HTTPError as error:
            payload = error.read(MAX_HTTP_BODY + 1)
            status = error.code
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ProvisioningError("http_unavailable") from None
        try:
            return status, json.loads(payload.decode("utf-8")) if payload else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return status, None


class HermesApi:
    def __init__(self, base_url: str, timeout: int = 30):
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ProvisioningError("unsafe_hermes_api_origin")
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise ProvisioningError("unsafe_hermes_api_origin")
        self.base = base_url.rstrip("/")
        self.http = JsonHttp(timeout=timeout)

    def _url(self, profile: str, path: str) -> str:
        if not PROFILE_RE.fullmatch(profile) or not path.startswith("/v1/"):
            raise ProvisioningError("invalid_profile_route")
        return self.base + "/p/" + urllib.parse.quote(profile, safe="") + path

    def _default_url(self, path: str) -> str:
        if not path.startswith("/v1/"):
            raise ProvisioningError("invalid_profile_route")
        return self.base + path

    def json_request(self, profile: str, key: str, path: str, method: str = "GET", body: dict[str, Any] | None = None, extra_headers: dict[str, str] | None = None):
        headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        status, data = self.http.request(self._url(profile, path), method, headers, body)
        return status, data

    def json_request_default(self, key: str, path: str, method: str = "GET", body: dict[str, Any] | None = None, extra_headers: dict[str, str] | None = None):
        headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        status, data = self.http.request(self._default_url(path), method, headers, body)
        return status, data

    def read_events(self, profile: str, key: str, run_id: str, timeout: int = 120) -> str:
        run = urllib.parse.quote(run_id, safe="")
        url = self._url(profile, "/v1/runs/" + run + "/events")
        req = urllib.request.Request(
            url,
            headers={"Authorization": "Bearer " + key, "Accept": "text/event-stream"},
            method="GET",
        )
        try:
            with self.http.opener.open(req, timeout=timeout) as response:
                if response.status != 200:
                    raise ProvisioningError("canary_events_unavailable")
                event_name = ""
                data_lines: list[str] = []
                output: str | None = None
                while True:
                    raw = response.readline()
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if not line:
                        if not data_lines:
                            event_name = ""
                            continue
                        try:
                            event = json.loads("\n".join(data_lines))
                        except json.JSONDecodeError:
                            raise ProvisioningError("canary_event_invalid") from None
                        name = event_name or (event.get("event") if isinstance(event, dict) else "") or (event.get("type") if isinstance(event, dict) else "")
                        if isinstance(name, str) and name.startswith("tool."):
                            raise ProvisioningError("canary_tool_invoked")
                        if name in {"run.completed", "completed"}:
                            output = event.get("output") if isinstance(event, dict) else None
                            break
                        if name in {"run.failed", "failed", "run.cancelled", "run.interrupted"}:
                            safe_code = _safe_canary_error_code(event)
                            if safe_code is None:
                                try:
                                    status, run_status = self.json_request(
                                        profile,
                                        key,
                                        "/v1/runs/" + urllib.parse.quote(run_id, safe=""),
                                    )
                                    if status == 200:
                                        safe_code = _safe_canary_error_code(run_status)
                                except ProvisioningError:
                                    pass
                            raise ProvisioningError(
                                "canary_failed_" + safe_code if safe_code else "canary_failed"
                            )
                        event_name, data_lines = "", []
                        continue
                    if line.startswith(":"):
                        continue
                    field, _, value = line.partition(":")
                    value = value[1:] if value.startswith(" ") else value
                    if field == "event":
                        event_name = value
                    elif field == "data":
                        data_lines.append(value)
        except ProvisioningError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ProvisioningError("canary_events_unavailable") from None
        if output is None:
            raise ProvisioningError("canary_incomplete")
        return output.strip()


def _safe_canary_error_code(event: Any) -> str | None:
    if not isinstance(event, dict):
        return None
    fields = [event]
    if isinstance(event.get("data"), dict):
        fields.append(event["data"])
    candidates: list[Any] = []
    detail: Any = None
    for row in fields:
        candidates.extend((row.get("code"), row.get("error_code"), row.get("turn_exit_reason")))
        if detail is None:
            detail = row.get("error", row.get("message"))
    if isinstance(detail, dict):
        candidates.extend((detail.get("code"), detail.get("error_code")))
        detail = detail.get("message")
    for candidate in candidates:
        if isinstance(candidate, str) and candidate in SAFE_CANARY_ERROR_CODE_SUFFIXES:
            return candidate
    if isinstance(detail, str):
        for pattern, code in CANARY_ERROR_CLASSIFIERS:
            if pattern.search(detail[:2048]):
                return code
    return None


def verify_complete_catalog(api: HermesApi, profile: str, key: str, *, default_profile: bool = False, toolsets: "set[str] | None" = None) -> str:
    """Prove this gateway supports a complete authenticated catalog before the worker can claim jobs."""
    if default_profile:
        capability_status, capabilities = api.json_request_default(key, "/v1/capabilities")
    else:
        capability_status, capabilities = api.json_request(profile, key, "/v1/capabilities")
    if (
        capability_status != 200
        or not isinstance(capabilities, dict)
        or capabilities.get("object") != "hermes.api_server.capabilities"
        or not isinstance(capabilities.get("auth"), dict)
        or capabilities["auth"].get("required") is not True
        or capabilities["auth"].get("type") != "bearer"
    ):
        raise ProvisioningError("runtime_tool_inventory_incomplete")
    endpoints = capabilities.get("endpoints")
    tools_endpoint = endpoints.get("tools") if isinstance(endpoints, dict) else None
    array_endpoint = tools_endpoint == ["GET", "/v1/tools"]
    object_endpoint = (
        isinstance(tools_endpoint, dict)
        and set(tools_endpoint) == {"method", "path"}
        and tools_endpoint.get("method") == "GET"
        and tools_endpoint.get("path") == "/v1/tools"
    )
    if not (array_endpoint or object_endpoint):
        raise ProvisioningError("runtime_tool_inventory_incomplete")
    stable_digest: str | None = None
    for _ in range(2):
        challenge = secrets.token_urlsafe(24)
        path = "/v1/tools?platform=api_server&inventory_challenge=" + urllib.parse.quote(challenge, safe="")
        headers = {
            "X-Hermes-Inventory-Challenge": challenge,
            "Cache-Control": "no-cache, no-store, max-age=0",
            "Pragma": "no-cache",
        }
        if default_profile:
            status, catalog = api.json_request_default(
                key,
                path,
                extra_headers=headers,
            )
        else:
            status, catalog = api.json_request(
                profile,
                key,
                path,
                extra_headers=headers,
            )
        if status != 200:
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        current_digest = _catalog_snapshot(catalog, profile, challenge, key, toolsets)
        if stable_digest is not None and not hmac.compare_digest(stable_digest, current_digest):
            raise ProvisioningError("runtime_tool_inventory_incomplete")
        stable_digest = current_digest
    if stable_digest is None:
        raise ProvisioningError("runtime_tool_inventory_incomplete")
    return stable_digest


class RestrictedProvisioner:
    def __init__(
        self,
        *,
        home: Path,
        hermes_cli: Path,
        api: HermesApi,
        gateway_id: str,
        hermes_version: str,
        profile_model_env: dict[str, str] | None = None,
        profile_model_config: dict[str, Any] | None = None,
        run_command: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    ):
        self.home = home.resolve()
        self.profile_root = self.home / "profiles"
        self.state_root = self.home / "iacquire-provisioner-state"
        self.hermes_cli = hermes_cli
        self.api = api
        self.gateway_id = gateway_id
        self.hermes_version = hermes_version[:80]
        self.profile_model_env = dict(profile_model_env or {})
        self.profile_model_config = (
            None if profile_model_config is None else _validate_model_block(profile_model_config)
        )
        self.run_command = run_command
        if self.home == Path("/") or not self.profile_root.exists() or self.profile_root.is_symlink():
            raise ProvisioningError("unsafe_hermes_home")
        if self.state_root.exists() and self.state_root.is_symlink():
            raise ProvisioningError("unsafe_hermes_home")
        self.state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.state_root, 0o700)
        self._inventory_digest = ""
        for entry in self.profile_root.iterdir():
            if entry.is_symlink() or not entry.is_dir():
                raise ProvisioningError("unsafe_hermes_home")
            if entry.name == "default":
                continue
            if not PROFILE_RE.fullmatch(entry.name):
                raise ProvisioningError("agency_profile_found")
            marker = self._read_json_file(entry / ".iacquire-provisioner.json")
            journal = self._read_json_file(self._journal_path(entry.name))
            if not self._valid_profile_owner(marker, entry.name) and not self._valid_profile_journal(journal, entry.name):
                raise ProvisioningError("agency_profile_found")
            if marker is not None and journal is not None and (
                marker.get("orgId") != journal.get("orgId")
                or marker.get("agentId") != journal.get("agentId")
                or marker.get("profile") != journal.get("profile")
                or marker.get("gatewayId") != journal.get("gatewayId")
                or marker.get("sourceProvisionJobId") != journal.get("jobId")
            ):
                raise ProvisioningError("profile_ownership_conflict")

    def process(self, raw_manifest: Any) -> dict[str, Any]:
        try:
            manifest = parse_manifest(raw_manifest, self.gateway_id)
        except ProvisioningError as error:
            self._append_audit({
                "at": datetime.now(timezone.utc).isoformat(),
                "gatewayId": self.gateway_id,
                "hermesVersion": self.hermes_version,
                "outcome": "rejected",
                "code": error.code,
            })
            raise
        try:
            with _profile_lock(self.state_root / (manifest.profile + ".lock")):
                result = self._process_manifest(manifest)
        except ProvisioningError as error:
            self._append_audit(self._audit_record(manifest, "failed", error.code))
            raise
        except Exception:
            self._append_audit(self._audit_record(manifest, "failed", "worker_internal_error"))
            raise ProvisioningError("worker_internal_error") from None
        self._append_audit(self._audit_record(manifest, "succeeded", effective_config_hash=result["effectiveConfigSha256"]))
        return result

    def _process_manifest(self, manifest: Manifest) -> dict[str, Any]:
        profile_dir = self._profile_dir(manifest.profile)
        policy = parse_policy_config(manifest.config_yaml)
        key = self._prepare_profile(manifest, profile_dir)
        self._write_soul(profile_dir, manifest.soul)
        config_path = profile_dir / "config.yaml"
        _atomic_write(
            config_path,
            render_config(config_path, policy, canary=True, model_config=self.profile_model_config),
        )
        self._wait_for_profile_gateway(manifest, key)
        self._verify_api_and_soul(manifest, key)
        deployed_config = render_config(
            config_path, policy, canary=False, model_config=self.profile_model_config
        )
        _atomic_write(config_path, deployed_config)
        self._verify_final_policy(manifest, key)
        effective_config_hash = digest(config_path.read_bytes())
        self._write_marker(manifest, profile_dir, effective_config_hash)
        result = {
            "ok": True,
            "jobId": manifest.job_id,
            "leaseToken": manifest.lease_token,
            "gatewayId": manifest.gateway_id,
            "kind": manifest.kind,
            "orgId": manifest.org_id,
            "agentId": manifest.agent_id,
            "profile": manifest.profile,
            "sourceProvisionJobId": manifest.source_provision_job_id,
            "configVersionId": manifest.config_version_id,
            "configVersion": manifest.config_version,
            "soulSha256": digest((profile_dir / "SOUL.md").read_bytes()),
            "soulChallengeSha256": digest(manifest.soul_challenge.encode("utf-8")),
            "policyConfigSha256": manifest.policy_config_sha256,
            "effectiveConfigSha256": effective_config_hash,
            "authenticated": True,
            "identityVerified": True,
            "effectiveSoulVerified": True,
            "toolInventoryComplete": True,
            "toolInventoryDigest": self._inventory_digest,
            "hermesVersion": self.hermes_version,
        }
        if manifest.kind == "provision":
            result["apiKey"] = key
        return result

    def _audit_record(
        self,
        manifest: Manifest,
        outcome: str,
        code: str | None = None,
        effective_config_hash: str | None = None,
    ) -> dict[str, Any]:
        record: dict[str, Any] = {
            "at": datetime.now(timezone.utc).isoformat(),
            "gatewayId": manifest.gateway_id,
            "jobId": manifest.job_id,
            "orgId": manifest.org_id,
            "agentId": manifest.agent_id,
            "profile": manifest.profile,
            "role": manifest.role,
            "kind": manifest.kind,
            "sourceProvisionJobId": manifest.source_provision_job_id,
            "configVersionId": manifest.config_version_id,
            "configVersion": manifest.config_version,
            "soulSha256": manifest.soul_sha256,
            "policyConfigSha256": manifest.policy_config_sha256,
            "effectiveConfigSha256": effective_config_hash,
            "hermesVersion": self.hermes_version,
            "outcome": outcome,
        }
        if self._inventory_digest:
            record["toolInventoryDigest"] = self._inventory_digest
        if code:
            record["code"] = code
        return record

    def _append_audit(self, record: dict[str, Any]) -> None:
        path = self.state_root / "audit.jsonl"
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(path, flags, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    raise OSError("audit file is not regular")
                if hasattr(os, "getuid") and info.st_uid != os.getuid():
                    raise OSError("audit file owner mismatch")
                if info.st_size > MAX_AUDIT_BYTES:
                    raise OSError("audit file size limit reached")
                if hasattr(os, "fchmod"):
                    os.fchmod(fd, 0o600)
                payload = json.dumps(record, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
                if info.st_size + len(payload) > MAX_AUDIT_BYTES:
                    raise OSError("audit file size limit reached")
                remaining = memoryview(payload)
                while remaining:
                    written = os.write(fd, remaining)
                    if written <= 0:
                        raise OSError("audit append failed")
                    remaining = remaining[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            raise ProvisioningError("audit_log_unavailable") from None

    @property
    def _inventory_digest(self) -> str:
        return getattr(self, "_RestrictedProvisioner__inventory_digest", "")

    @_inventory_digest.setter
    def _inventory_digest(self, value: str) -> None:
        self.__inventory_digest = value

    def _valid_profile_owner(self, marker: dict[str, Any] | None, profile: str) -> bool:
        return bool(
            marker
            and marker.get("schemaVersion") == 1
            and marker.get("profile") == profile
            and marker.get("gatewayId") == self.gateway_id
            and _is_uuid(marker.get("orgId"))
            and _is_uuid(marker.get("agentId"))
            and _is_uuid(marker.get("sourceProvisionJobId"))
        )

    def _valid_profile_journal(self, journal: dict[str, Any] | None, profile: str) -> bool:
        return bool(
            journal
            and journal.get("schemaVersion") == 1
            and journal.get("profile") == profile
            and journal.get("gatewayId") == self.gateway_id
            and _is_uuid(journal.get("jobId"))
            and _is_uuid(journal.get("orgId"))
            and _is_uuid(journal.get("agentId"))
        )

    def _profile_dir(self, name: str) -> Path:
        if not PROFILE_RE.fullmatch(name):
            raise ProvisioningError("invalid_profile")
        path = self.profile_root / name
        if path.parent.resolve() != self.profile_root.resolve() or path.is_symlink():
            raise ProvisioningError("unsafe_profile_path")
        if path.exists() and not path.is_dir():
            raise ProvisioningError("profile_conflict")
        return path

    def _journal_path(self, profile: str) -> Path:
        return self.state_root / (profile + ".json")

    def _read_json_file(self, path: Path) -> dict[str, Any] | None:
        if path.is_symlink():
            raise ProvisioningError("unsafe_profile_path")
        if not path.exists():
            return None
        _require_regular_file(path)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raise ProvisioningError("profile_state_invalid") from None
        if not isinstance(value, dict):
            raise ProvisioningError("profile_state_invalid")
        return value

    def _prepare_profile(self, manifest: Manifest, profile_dir: Path) -> str:
        marker_path = profile_dir / ".iacquire-provisioner.json"
        marker = self._read_json_file(marker_path) if profile_dir.exists() else None
        journal_path = self._journal_path(manifest.profile)
        journal = self._read_json_file(journal_path)
        if manifest.kind == "sync":
            if not profile_dir.exists() or marker is None:
                raise ProvisioningError("profile_ownership_missing")
            if (
                marker.get("orgId") != manifest.org_id
                or marker.get("agentId") != manifest.agent_id
                or marker.get("profile") != manifest.profile
                or marker.get("gatewayId") != manifest.gateway_id
                or marker.get("sourceProvisionJobId") != manifest.source_provision_job_id
            ):
                raise ProvisioningError("profile_ownership_conflict")
            env_path = profile_dir / ".env"
            key = self._read_api_key(env_path)
            if key is None:
                raise ProvisioningError("profile_key_missing")
            if self.profile_model_env:
                _atomic_write(env_path, self._profile_env_text(key))
            return key

        if marker is not None:
            if (
                marker.get("orgId") != manifest.org_id
                or marker.get("agentId") != manifest.agent_id
                or marker.get("profile") != manifest.profile
                or marker.get("gatewayId") != manifest.gateway_id
                or marker.get("sourceProvisionJobId") != manifest.job_id
            ):
                raise ProvisioningError("profile_ownership_conflict")
            key = self._read_api_key(profile_dir / ".env")
            if key is None:
                raise ProvisioningError("profile_key_missing")
            if self.profile_model_env:
                _atomic_write(profile_dir / ".env", self._profile_env_text(key))
            return key
        if profile_dir.exists():
            if not journal or journal.get("jobId") != manifest.job_id or journal.get("orgId") != manifest.org_id or journal.get("agentId") != manifest.agent_id or journal.get("gatewayId") != manifest.gateway_id:
                raise ProvisioningError("profile_conflict")
        else:
            if journal and journal.get("jobId") != manifest.job_id:
                raise ProvisioningError("profile_ownership_conflict")
            journal = {
                "schemaVersion": 1,
                "jobId": manifest.job_id,
                "orgId": manifest.org_id,
                "agentId": manifest.agent_id,
                "gatewayId": manifest.gateway_id,
                "profile": manifest.profile,
                "createdAt": int(time.time()),
            }
            _atomic_write(journal_path, json.dumps(journal, separators=(",", ":")).encode("utf-8"))
            description = "iAcquire client " + manifest.role + " profile"
            env = _hermes_cli_environment(self.home)
            try:
                self.run_command(
                    [
                        str(self.hermes_cli), "profile", "create", manifest.profile,
                        "--description", description, "--no-alias", "--no-skills",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=90,
                    env=env,
                )
            except (subprocess.SubprocessError, OSError):
                raise ProvisioningError("profile_create_failed") from None
            if not profile_dir.exists() or profile_dir.is_symlink():
                raise ProvisioningError("profile_create_failed")
        if profile_dir.is_symlink() or profile_dir.parent.resolve() != self.profile_root.resolve():
            raise ProvisioningError("unsafe_profile_path")
        for path in profile_dir.iterdir():
            if path.is_symlink():
                raise ProvisioningError("unsafe_profile_path")
        env_path = profile_dir / ".env"
        key = self._read_api_key(env_path) if journal and journal.get("apiKeyWritten") is True else None
        if key is None:
            key = secrets.token_hex(32)
        _atomic_write(env_path, self._profile_env_text(key))
        journal = journal or {
            "schemaVersion": 1,
            "jobId": manifest.job_id,
            "orgId": manifest.org_id,
            "agentId": manifest.agent_id,
            "gatewayId": manifest.gateway_id,
            "profile": manifest.profile,
        }
        journal["apiKeyWritten"] = True
        _atomic_write(journal_path, json.dumps(journal, separators=(",", ":"), sort_keys=True).encode("utf-8"))
        os.chmod(profile_dir, 0o700)
        return key

    def _profile_env_text(self, api_key: str) -> bytes:
        # The default gateway owns the only API listener; named-profile keys only scope /p/<profile> routes.
        rows = ["API_SERVER_KEY=" + api_key]
        for name, value in sorted(self.profile_model_env.items()):
            if name not in MODEL_API_KEY_ENV_NAMES or not value or any(ord(char) <= 0x20 or ord(char) >= 0x7f or char in "#'\"$\\" for char in value):
                raise ProvisioningError("profile_key_invalid")
            rows.append(name + "=" + value)
        return ("\n".join(rows) + "\n").encode("ascii")

    def _read_api_key(self, path: Path) -> str | None:
        if path.is_symlink():
            raise ProvisioningError("unsafe_profile_path")
        if not path.exists():
            return None
        _require_regular_file(path)
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            raise ProvisioningError("profile_key_invalid") from None
        values = [line.partition("=")[2] for line in lines if line.startswith("API_SERVER_KEY=")]
        if len(values) != 1 or not API_KEY_RE.fullmatch(values[0]):
            return None
        return values[0]

    def _write_soul(self, profile_dir: Path, soul: str) -> None:
        path = profile_dir / "SOUL.md"
        _atomic_write(path, soul.encode("utf-8"))

    def _write_marker(self, manifest: Manifest, profile_dir: Path, effective_config_hash: str) -> None:
        source_job = manifest.source_provision_job_id or manifest.job_id
        marker = {
            "schemaVersion": 1,
            "orgId": manifest.org_id,
            "agentId": manifest.agent_id,
            "gatewayId": manifest.gateway_id,
            "profile": manifest.profile,
            "sourceProvisionJobId": source_job,
            "lastJobId": manifest.job_id,
            "configVersionId": manifest.config_version_id,
            "soulSha256": manifest.soul_sha256,
            "policyConfigSha256": manifest.policy_config_sha256,
            "effectiveConfigSha256": effective_config_hash,
            "updatedAt": int(time.time()),
        }
        _atomic_write(
            profile_dir / ".iacquire-provisioner.json",
            json.dumps(marker, separators=(",", ":"), sort_keys=True).encode("utf-8"),
        )

    def _verify_api_and_soul(self, manifest: Manifest, key: str) -> None:
        status, caps = self.api.json_request(manifest.profile, key, "/v1/capabilities")
        if status != 200 or not isinstance(caps, dict):
            raise ProvisioningError("profile_authentication_failed")
        features = caps.get("features") if isinstance(caps.get("features"), dict) else {}
        auth = caps.get("auth") if isinstance(caps.get("auth"), dict) else {}
        if caps.get("object") != "hermes.api_server.capabilities" or auth.get("required") is not True or auth.get("type") != "bearer" or features.get("run_submission") is not True:
            raise ProvisioningError("profile_api_contract_failed")
        status, models = self.api.json_request(manifest.profile, key, "/v1/models")
        if status != 200 or not isinstance(models, dict) or not isinstance(models.get("data"), list):
            raise ProvisioningError("profile_identity_failed")
        identities = [
            row.get("id") for row in models["data"]
            if isinstance(row, dict) and row.get("owned_by") == "hermes" and row.get("parent") is None and row.get("root") == row.get("id")
        ]
        if manifest.profile not in identities:
            raise ProvisioningError("profile_identity_failed")
        self._wait_for_effective_toolsets(manifest, key, expected=set(), failure_code="canary_tool_isolation_failed")
        run_id = self._submit_canary_run(manifest, key)
        output = self.api.read_events(manifest.profile, key, run_id)
        if not secrets.compare_digest(output, manifest.soul_challenge):
            raise ProvisioningError("effective_soul_unverified")

    def _submit_canary_run(self, manifest: Manifest, key: str) -> str:
        """Retry only a bounded profile-authority 409; it admits no run and is safe to replay."""
        deadline = time.monotonic() + PROFILE_DISCOVERY_TIMEOUT_SECONDS
        request_body = {
            "input": CANARY_PROMPT,
            "session_id": "iacquire-verify-" + uuid.uuid4().hex,
        }
        idempotency_key = str(uuid.uuid4())
        while True:
            status, run = self.api.json_request(
                manifest.profile,
                key,
                "/v1/runs",
                method="POST",
                body=request_body,
                extra_headers={"Idempotency-Key": idempotency_key},
            )
            gateway_error = run.get("error") if isinstance(run, dict) else None
            gateway_code = gateway_error.get("code") if isinstance(gateway_error, dict) else None
            if status == 409 and gateway_code == "profile_mismatch":
                remaining = deadline - time.monotonic()
                if remaining > 0:
                    time.sleep(min(PROFILE_DISCOVERY_RETRY_INTERVAL_SECONDS, remaining))
                    continue
            if status not in {200, 202}:
                safe_status = status if type(status) is int and 100 <= status <= 599 else "unavailable"
                if not isinstance(gateway_code, str) or not RUN_SUBMISSION_ERROR_CODE_RE.fullmatch(gateway_code):
                    gateway_code = None
                suffix = "_" + gateway_code if gateway_code else ""
                raise ProvisioningError(f"canary_submission_http_{safe_status}{suffix}")
            if not isinstance(run, dict) or not isinstance(run.get("run_id"), str):
                raise ProvisioningError("canary_submission_failed")
            return run["run_id"]

    def _wait_for_profile_gateway(self, manifest: Manifest, key: str) -> None:
        """Wait for Hermes' shared multiplexer to discover a newly published profile directory.

        The worker deliberately has a separate Hermes home from the gateway, so the CLI's local
        control-socket notification cannot reach that gateway. Hermes' supported profile watcher
        rescans every 30 seconds; poll the profile-scoped capabilities route through that window
        before running checks.
        """
        deadline = time.monotonic() + PROFILE_DISCOVERY_TIMEOUT_SECONDS
        while True:
            status: int | None = None
            capabilities: Any = None
            try:
                status, capabilities = self.api.json_request(
                    manifest.profile,
                    key,
                    "/v1/capabilities",
                )
            except ProvisioningError as error:
                if error.code != "http_unavailable":
                    raise

            if status == 200:
                if not isinstance(capabilities, dict):
                    raise ProvisioningError("profile_api_contract_failed")
                auth = capabilities.get("auth") if isinstance(capabilities, dict) else None
                features = capabilities.get("features") if isinstance(capabilities, dict) else None
                if (
                    capabilities.get("object") != "hermes.api_server.capabilities"
                    or not isinstance(auth, dict)
                    or auth.get("required") is not True
                    or auth.get("type") != "bearer"
                    or not isinstance(features, dict)
                    or features.get("run_submission") is not True
                ):
                    raise ProvisioningError("profile_api_contract_failed")
                return
            if status == 401:
                raise ProvisioningError("profile_authentication_failed")
            if status not in {None, 404, 502, 503, 504}:
                raise ProvisioningError("profile_api_contract_failed")

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProvisioningError("profile_gateway_discovery_timeout")
            time.sleep(min(PROFILE_DISCOVERY_RETRY_INTERVAL_SECONDS, remaining))

    def _wait_for_effective_toolsets(
        self,
        manifest: Manifest,
        key: str,
        expected: set[str],
        failure_code: str,
    ) -> None:
        """Wait for the gateway's supported config watcher to apply the on-disk tool policy.

        Profile creation and config writes happen in a sidecar with a separate Hermes home. It
        cannot signal the gateway's private control socket, so a one-shot read can observe the
        previous policy for up to the gateway's 30-second rescan interval. Only a well-formed,
        safe subset of the reviewed toolsets is treated as propagation in progress; malformed or
        unsafe runtime state fails immediately.
        """
        deadline = time.monotonic() + PROFILE_CONFIG_SYNC_TIMEOUT_SECONDS
        while True:
            status: int | None = None
            toolsets: Any = None
            try:
                status, toolsets = self.api.json_request(manifest.profile, key, "/v1/toolsets")
            except ProvisioningError as error:
                if error.code != "http_unavailable":
                    raise

            pending = False
            if status == 401:
                raise ProvisioningError("profile_authentication_failed")
            if status == 200:
                entries = toolsets if isinstance(toolsets, list) else toolsets.get("data") if isinstance(toolsets, dict) else None
                if not isinstance(entries, list):
                    raise ProvisioningError(failure_code)
                enabled_names: set[str] = set()
                seen_names: set[str] = set()
                for entry in entries:
                    if not isinstance(entry, dict):
                        raise ProvisioningError(failure_code)
                    name = entry.get("name")
                    enabled = entry.get("enabled")
                    tools = entry.get("tools")
                    if (
                        not isinstance(name, str)
                        or name in seen_names
                        or not isinstance(enabled, bool)
                        or not isinstance(tools, list)
                        or any(not isinstance(tool, str) for tool in tools)
                    ):
                        raise ProvisioningError(failure_code)
                    seen_names.add(name)
                    if enabled and tools:
                        if name not in SAFE_TOOLSETS or any(tool not in REVIEWED_TOOLSET_FOR_TOOL for tool in tools):
                            raise ProvisioningError(failure_code)
                        enabled_names.add(name)
                if enabled_names == expected:
                    return
                if enabled_names.issubset(SAFE_TOOLSETS):
                    pending = True
                else:
                    raise ProvisioningError(failure_code)
            elif status in {None, 404, 502, 503, 504}:
                pending = True
            else:
                raise ProvisioningError(failure_code)

            remaining = deadline - time.monotonic()
            if not pending or remaining <= 0:
                raise ProvisioningError(failure_code)
            time.sleep(min(PROFILE_CONFIG_SYNC_RETRY_INTERVAL_SECONDS, remaining))

    def _verify_final_policy(self, manifest: Manifest, key: str) -> None:
        # The toolsets this profile must expose are the ones its policy config names (the full reviewed set, or one role's narrower set).
        toolsets = policy_toolsets(manifest.config_yaml)
        self._wait_for_effective_toolsets(
            manifest,
            key,
            expected=toolsets,
            failure_code="runtime_tool_policy_unverified",
        )
        self._inventory_digest = verify_complete_catalog(self.api, manifest.profile, key, toolsets=toolsets)


def _load_service_token() -> str:
    token = os.environ.get("IACQUIRE_PROVISIONER_TOKEN", "")
    token_file = os.environ.get("IACQUIRE_PROVISIONER_TOKEN_FILE", "")
    if bool(token) == bool(token_file):
        raise ProvisioningError("provisioner_credentials_missing")
    if token_file:
        path = Path(token_file)
        try:
            if not path.is_absolute() or path.resolve(strict=True) != path:
                raise OSError("unsafe token path")
            flags = os.O_RDONLY
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(path, flags)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                    raise OSError("unsafe token file")
                if hasattr(os, "getuid") and info.st_uid != os.getuid():
                    raise OSError("token file owner mismatch")
                if os.name != "nt" and info.st_mode & 0o077:
                    raise OSError("token file permissions are too broad")
                chunks: list[bytes] = []
                total = 0
                while total <= 4096:
                    chunk = os.read(fd, min(4097 - total, 1024))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                raw = b"".join(chunks)
                if len(raw) > 4096:
                    raise OSError("token file too large")
            finally:
                os.close(fd)
            token = raw.decode("ascii")
            if token.endswith("\n"):
                token = token[:-1]
                if token.endswith("\r"):
                    token = token[:-1]
            if "\n" in token or "\r" in token:
                raise OSError("invalid token file format")
        except (OSError, UnicodeDecodeError, ValueError):
            raise ProvisioningError("provisioner_credentials_missing") from None
    if len(token) < 32 or len(token) > 512 or any(ord(char) < 0x21 or ord(char) > 0x7e for char in token):
        raise ProvisioningError("provisioner_credentials_missing")
    return token


def _load_bootstrap_api_key() -> str:
    """Read the client-only default profile key from a private mounted file, never an env value."""
    if os.environ.get("HERMES_PROVISIONER_BOOTSTRAP_API_KEY"):
        raise ProvisioningError("provisioner_credentials_missing")
    value = os.environ.get("HERMES_PROVISIONER_BOOTSTRAP_API_KEY_FILE", "")
    try:
        path = Path(value)
        if not path.is_absolute() or path.resolve(strict=True) != path:
            raise OSError("unsafe key path")
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags)
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_size > 4096
                or not _bootstrap_api_key_file_is_private(info)
            ):
                raise OSError("key file permissions are too broad")
            raw = os.read(fd, 4097)
            if len(raw) > 4096:
                raise OSError("key file too large")
        finally:
            os.close(fd)
        key = raw.decode("ascii")
        if key.endswith("\n"):
            key = key[:-1]
            if key.endswith("\r"):
                key = key[:-1]
        if "\n" in key or "\r" in key or not API_KEY_RE.fullmatch(key):
            raise OSError("invalid key file")
    except (OSError, UnicodeDecodeError, ValueError):
        raise ProvisioningError("provisioner_credentials_missing") from None
    return key


def _bootstrap_api_key_file_is_private(info: os.stat_result) -> bool:
    """Allow worker-private files or the gateway's exact read-only shared mount."""
    if os.name == "nt":
        return True
    mode = stat.S_IMODE(info.st_mode)
    if info.st_uid == os.getuid() and mode in {0o400, 0o600}:
        return True
    return (
        hasattr(os, "getegid")
        and info.st_uid == 0
        and info.st_gid == os.getegid()
        and mode == 0o440
    )


def _load_profile_model_env() -> dict[str, str]:
    """Load one platform model key from a private mount for profile-scoped Hermes credentials."""
    if os.environ.get("IACQUIRE_PROFILE_MODEL_ENV"):
        raise ProvisioningError("profile_key_invalid")
    value = os.environ.get("IACQUIRE_PROFILE_MODEL_ENV_FILE", "")
    try:
        path = Path(value)
        if not path.is_absolute() or path.resolve(strict=True) != path:
            raise OSError("unsafe model key path")
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 8192:
                raise OSError("unsafe model key file")
            if hasattr(os, "getuid") and info.st_uid != os.getuid():
                raise OSError("model key owner mismatch")
            if os.name != "nt" and info.st_mode & 0o077:
                raise OSError("model key permissions are too broad")
            raw = os.read(fd, 8193)
            if len(raw) > 8192:
                raise OSError("model key file too large")
        finally:
            os.close(fd)
        parsed = json.loads(raw.decode("ascii"))
        if not isinstance(parsed, dict) or set(parsed) != {"schemaVersion", "environment", "value"} or parsed.get("schemaVersion") != 1:
            raise ValueError("invalid model key document")
        name, secret = parsed.get("environment"), parsed.get("value")
        if not isinstance(name, str) or name not in MODEL_API_KEY_ENV_NAMES:
            raise ValueError("invalid model key name")
        if not isinstance(secret, str) or not 1 <= len(secret) <= 4096 or any(ord(char) <= 0x20 or ord(char) >= 0x7f or char in "#'\"$\\" for char in secret):
            raise ValueError("invalid model key value")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ProvisioningError("profile_key_invalid") from None
    return {name: secret}


def _validate_runtime() -> tuple[Path, Path, str, str, str, str, str, dict[str, str]]:
    if hasattr(os, "getuid") and os.getuid() == 0:
        raise ProvisioningError("worker_must_not_run_as_root")
    home = Path(os.environ.get("HERMES_HOME", "/opt/data")).resolve()
    profile_root = home / "profiles"
    if not profile_root.is_dir() or profile_root.is_symlink():
        raise ProvisioningError("unsafe_hermes_home")
    cli = Path(os.environ.get("HERMES_CLI", "/usr/local/bin/hermes"))
    if not cli.is_absolute() or not cli.is_file():
        raise ProvisioningError("hermes_cli_unavailable")
    portal_url = _validate_portal_origin(os.environ.get("IACQUIRE_PROVISIONER_URL", ""))
    token = _load_service_token()
    bootstrap_api_key = _load_bootstrap_api_key()
    profile_model_env = _load_profile_model_env()
    gateway_id = os.environ.get("IACQUIRE_PROVISIONER_GATEWAY_ID", "")
    api_base = os.environ.get("HERMES_PROVISIONER_API_BASE", "http://127.0.0.1:8642")
    if not _is_uuid(gateway_id):
        raise ProvisioningError("provisioner_credentials_missing")
    api = HermesApi(api_base)
    _sanitize_worker_environment(home, api_base)
    try:
        version = subprocess.run(
            [str(cli), "--version"], check=True, capture_output=True, text=True,
            timeout=20, env=_hermes_cli_environment(home),
        ).stdout.strip()
        help_text = subprocess.run(
            [str(cli), "profile", "create", "--help"], check=True, capture_output=True, text=True,
            timeout=20, env=_hermes_cli_environment(home),
        ).stdout
    except (subprocess.SubprocessError, OSError):
        raise ProvisioningError("hermes_cli_preflight_failed") from None
    if not all(flag in help_text for flag in ("--description", "--no-alias", "--no-skills")):
        raise ProvisioningError("unsupported_profile_create_cli")
    return home, cli, portal_url, token, gateway_id, version, bootstrap_api_key, profile_model_env


def _hermes_cli_environment(home: Path) -> dict[str, str]:
    """Give the CLI only the runtime variables it needs, never the worker token."""
    allowed = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM")
    result = {key: os.environ[key] for key in allowed if key in os.environ}
    result.update({"HERMES_HOME": str(home), "HOME": str(home), "PYTHONNOUSERSITE": "1"})
    return result


def _sanitize_worker_environment(home: Path, api_base: str) -> None:
    """Drop model-provider and unrelated inherited secrets from the worker process."""
    allowed = (
        "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
        "SSL_CERT_FILE", "SSL_CERT_DIR",
    )
    clean = {key: os.environ[key] for key in allowed if key in os.environ}
    clean.update({
        "HERMES_HOME": str(home),
        "HOME": str(home),
        "HERMES_PROVISIONER_API_BASE": api_base,
    })
    os.environ.clear()
    os.environ.update(clean)


def _write_worker_heartbeat(state_root: Path) -> None:
    payload = json.dumps({"at": int(time.time())}, separators=(",", ":")).encode("ascii")
    _atomic_write(state_root / "heartbeat.json", payload)


def _worker_healthcheck() -> bool:
    home = Path(os.environ.get("HERMES_HOME", "/opt/data")).resolve()
    path = home / "iacquire-provisioner-state" / "heartbeat.json"
    if path.is_symlink():
        return False
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            return False
        if hasattr(os, "getuid") and info.st_uid != os.getuid():
            return False
        payload = json.loads(path.read_text(encoding="ascii"))
        if not isinstance(payload, dict) or set(payload) != {"at"} or not isinstance(payload["at"], int):
            return False
        age = int(time.time()) - payload["at"]
        return 0 <= age <= 600
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False


def _validate_portal_origin(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value.strip())
        port = parsed.port
    except ValueError:
        raise ProvisioningError("portal_url_invalid") from None
    if parsed.scheme != "https":
        raise ProvisioningError("portal_url_must_use_https")
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or any(char.isspace() for char in value)
    ):
        raise ProvisioningError("portal_url_invalid")
    authority = parsed.hostname
    if ":" in authority and not authority.startswith("["):
        authority = "[" + authority + "]"
    if port is not None:
        authority += ":" + str(port)
    return "https://" + authority


def _load_client_model_config(home: Path) -> dict[str, Any]:
    """Read only the explicit, secret-free model block from this client runtime's global config."""
    path = home / "config.yaml"
    if path.is_symlink():
        raise ProvisioningError("client_model_config_invalid")
    try:
        _require_regular_file(path)
        if path.stat().st_size > MAX_CONFIG_BYTES:
            raise ProvisioningError("client_model_config_invalid")
        model = _safe_model_block(path)
    except ProvisioningError as error:
        if error.code in {"invalid_profile_config", "unsafe_model_config", "unsafe_profile_path", "profile_file_missing"}:
            raise ProvisioningError("client_model_config_invalid") from None
        raise
    except OSError:
        raise ProvisioningError("client_model_config_invalid") from None
    provider = model.get("provider")
    selected_model = model.get("default") or model.get("model") or model.get("name")
    if isinstance(selected_model, dict):
        selected_model = selected_model.get("default") or selected_model.get("model") or selected_model.get("name")
    if (
        not isinstance(provider, str)
        or not provider.strip()
        or not isinstance(selected_model, str)
        or not selected_model.strip()
        or selected_model.strip().upper().startswith("REPLACE_WITH_")
    ):
        raise ProvisioningError("client_model_config_missing")
    return model


def run_worker() -> None:
    home, cli, portal_url, token, gateway_id, version, bootstrap_api_key, profile_model_env = _validate_runtime()
    profile_model_config = _load_client_model_config(home)
    api = HermesApi(os.environ.get("HERMES_PROVISIONER_API_BASE", "http://127.0.0.1:8642"))
    # This read-only check happens before audit/heartbeat writes and before the first portal claim.
    # The default profile belongs to this isolated runtime and is never an agency profile.
    verify_complete_catalog(api, "default", bootstrap_api_key, default_profile=True)
    worker = RestrictedProvisioner(
        home=home,
        hermes_cli=cli,
        api=api,
        gateway_id=gateway_id,
        hermes_version=version,
        profile_model_env=profile_model_env,
        profile_model_config=profile_model_config,
    )
    http = JsonHttp(timeout=30)
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json"}
    base = portal_url + "/api/internal/hermes-provisioner"
    stopped = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopped:
        _write_worker_heartbeat(worker.state_root)
        try:
            status, response = http.request(
                base + "/claim",
                "POST",
                headers,
                {"gatewayId": gateway_id},
            )
            if status != 200 or not isinstance(response, dict):
                time.sleep(10)
                continue
            manifest = response.get("job")
            if manifest is None:
                time.sleep(5)
                continue
            try:
                result = worker.process(manifest)
            except ProvisioningError as error:
                raw = manifest if isinstance(manifest, dict) else {}
                result = {
                    "ok": False,
                    "jobId": raw.get("jobId"),
                    "leaseToken": raw.get("leaseToken"),
                    "gatewayId": gateway_id,
                    "code": error.code,
                }
            status, _ = http.request(base + "/complete", "POST", headers, result)
            if status not in {200, 202}:
                time.sleep(10)
        except ProvisioningError:
            time.sleep(10)
        except Exception:
            # No exception message is emitted because third-party errors can include request data.
            time.sleep(10)


if __name__ == "__main__":
    if sys.argv[1:] == ["--healthcheck"]:
        raise SystemExit(0 if _worker_healthcheck() else 1)
    if sys.argv[1:] not in ([], ["--run"]):
        print("Hermes provisioner stopped: invalid_worker_command", file=sys.stderr)
        raise SystemExit(2)
    try:
        run_worker()
    except ProvisioningError as error:
        print("Hermes provisioner stopped: " + error.code, file=sys.stderr)
        raise SystemExit(1)
