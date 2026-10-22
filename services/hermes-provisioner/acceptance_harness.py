#!/usr/bin/env python3
"""Synthetic two-tenant acceptance server for the isolated client Hermes candidate."""

from __future__ import annotations

import collections
import hashlib
import hmac
import json
import os
import re
import ssl
import stat
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PORTAL_PORT = 18443
MODEL_PORT = 19000
PORTAL_PREFIX = "/api/internal/hermes-provisioner"
MODEL_KEY_NAME = "OPENAI_API_KEY"
MODEL_KEY_RE = re.compile(r"^[ -~]{1,256}$")
API_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
MARKER_RE = re.compile(r"return this marker exactly:\s*([0-9a-f]{32})", re.IGNORECASE)
ROLE_TITLES = {
    "operations_manager": ("Zeng", "Operations Manager"),
    "lead_hunter": ("Lead Hunter", "Lead Hunter"),
    "appointment_setter": ("Appointment Setter", "Appointment Setter"),
    "sales_assistant": ("Sales Assistant", "Sales Assistant"),
    "crm_manager": ("CRM Manager", "CRM Manager"),
    "performance_analyst": ("Performance Analyst", "Performance Analyst"),
}
ROLE_SLUGS = {key: title.lower().replace(" ", "-") for key, (_, title) in ROLE_TITLES.items()}
TENANTS = ("northstar-synthetic", "redwood-synthetic")
POLICY = """platform_toolsets:
  api_server:
    - memory
    - session_search
    - todo
    - vision
    - web
    - no_mcp
agent:
  disabled_toolsets:
    - browser
    - code_execution
    - computer_use
    - connections
    - cronjob
    - delegation
    - file
    - image_gen
    - skills
    - terminal
    - catalog
    - kanban
terminal:
  backend: docker
  docker_forward_env: []
  container_persistent: false
"""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def new_id() -> str:
    return str(uuid.uuid4())


def make_manifest(
    gateway_id: str,
    tenant: str,
    role: str,
    org_id: str,
    agent_id: str,
    *,
    source_job_id: str | None = None,
    kind: str = "provision",
    config_version: int = 1,
    soul_override: str | None = None,
) -> dict[str, Any]:
    challenge = os.urandom(16).hex()
    title, job_title = ROLE_TITLES[role]
    profile = f"c-{tenant.split('-')[0]}-{org_id.replace('-', '')[:12]}-{ROLE_SLUGS[role]}"
    soul = soul_override or (
        f"# {title} — {job_title}\n\n"
        f"Synthetic tenant: {tenant}. Tenant tag: {tenant.upper().replace('-', '_')}.\n"
        f"Role contract: perform only the confirmed responsibilities of {job_title}; "
        "do not claim external integrations are connected.\n"
        "Keep this tenant's facts separate from every other tenant.\n\n"
        "## Initialization check\n"
        f"For the private setup check only, return this marker exactly: {challenge}\n"
    )
    if soul_override is not None:
        marker = MARKER_RE.search(soul)
        if marker is None:
            raise ValueError("sync_fixture_missing_marker")
        challenge = marker.group(1).lower()
    return {
        "jobId": new_id(),
        "leaseToken": new_id(),
        "gatewayId": gateway_id,
        "kind": kind,
        "orgId": org_id,
        "agentId": agent_id,
        "profile": profile,
        "role": role,
        "configVersionId": new_id(),
        "configVersion": config_version,
        "sourceProvisionJobId": source_job_id,
        "soul": soul,
        "soulSha256": sha256(soul.encode("utf-8")),
        "soulChallenge": challenge,
        "configYaml": POLICY,
        "policyConfigSha256": sha256(POLICY.encode("utf-8")),
        "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
    }


class AcceptanceState:
    def __init__(self, gateway_id: str, result_dir: Path):
        self.gateway_id = gateway_id
        self.result_dir = result_dir
        self.lock = threading.RLock()
        self.queue: collections.deque[dict[str, Any]] = collections.deque()
        self.active: dict[str, Any] | None = None
        self.abort_code: str | None = None
        self.done = threading.Event()
        self.attempts: list[dict[str, Any]] = []
        self.failed_once = False
        self.first_job_id = ""
        self.base_jobs: dict[str, dict[str, Any]] = {}
        self.base_success_profiles: set[str] = set()
        self.profile_keys: dict[str, str] = {}
        self.success_by_job: dict[str, str] = {}
        self.latest_manifest: dict[str, dict[str, Any]] = {}
        self.profile_tenants: dict[str, str] = {}
        self.duplicate_issued = False
        self.duplicate_completed = False
        self.sync_issued = False
        self.sync_completed = False
        self.sync_manifest: dict[str, Any] | None = None
        self.model_calls = 0
        self.model_chat_calls = 0
        self.model_bad_auth = 0
        self.cross_tenant_denials = 0
        self.profile_key_denials = 0
        self.cross_tenant_successes = 0
        self.profile_checks = 0
        self.errors: list[str] = []
        self.tenant_orgs = {tenant: new_id() for tenant in TENANTS}

        for tenant in TENANTS:
            org_id = self.tenant_orgs[tenant]
            for role in ROLE_TITLES:
                job = make_manifest(gateway_id, tenant, role, org_id, new_id())
                self.base_jobs[job["jobId"]] = job
                self.latest_manifest[job["profile"]] = job
                self.profile_tenants[job["profile"]] = tenant
                self.queue.append(job)
        self.first_job_id = next(iter(self.base_jobs))
        first = self.base_jobs[self.first_job_id]
        updated_challenge = os.urandom(16).hex()
        updated_soul = (
            first["soul"].split("## Initialization check", 1)[0]
            + "## Synchronized initialization check\n"
            + f"For the private setup check only, return this marker exactly: {updated_challenge}\n"
            + "Configuration version 2: retain the original tenant boundary.\n"
        )
        self.sync_manifest = make_manifest(
            gateway_id,
            first["profile"].split("-")[1] + "-synthetic",
            first["role"],
            first["orgId"],
            first["agentId"],
            source_job_id=first["jobId"],
            kind="sync",
            config_version=2,
            soul_override=updated_soul,
        )
        self.sync_manifest["profile"] = first["profile"]
        self.latest_manifest[first["profile"]] = self.sync_manifest

    def _fail(self, code: str) -> None:
        if code not in self.errors:
            self.errors.append(code)
        self.abort_code = code
        self.done.set()

    def claim(self, gateway_id: str) -> dict[str, Any] | None:
        with self.lock:
            if gateway_id != self.gateway_id:
                self._fail("gateway_scope_rejected")
                raise ValueError("gateway_scope_rejected")
            if self.abort_code:
                raise ValueError(self.abort_code)
            if self.active is not None:
                return None
            if self.queue:
                self.active = self.queue.popleft()
                return self.active
            if len(self.base_success_profiles) == len(self.base_jobs) and not self.duplicate_issued:
                self.duplicate_issued = True
                self.active = self.base_jobs[self.first_job_id]
                return self.active
            if self.duplicate_completed and not self.sync_issued and self.sync_manifest:
                self.sync_issued = True
                self.active = self.sync_manifest
                return self.active
            if self.sync_completed:
                self.done.set()
            return None

    def complete(self, result: Any) -> None:
        with self.lock:
            job = self.active
            if not isinstance(result, dict) or job is None:
                self._fail("completion_without_active_lease")
                raise ValueError("completion_without_active_lease")
            if (
                result.get("jobId") != job["jobId"]
                or result.get("leaseToken") != job["leaseToken"]
                or result.get("gatewayId") != self.gateway_id
            ):
                self._fail("completion_lease_mismatch")
                raise ValueError("completion_lease_mismatch")

            if result.get("ok") is not True:
                code = result.get("code")
                if (
                    job["jobId"] == self.first_job_id
                    and not self.failed_once
                    and code == "effective_soul_unverified"
                ):
                    self.failed_once = True
                    self.attempts.append({"kind": "provision", "outcome": "failed", "code": code})
                    self.queue.appendleft(job)
                    self.active = None
                    return
                self._fail("unexpected_provisioning_failure")
                raise ValueError("unexpected_provisioning_failure")

            required_true = (
                "authenticated",
                "identityVerified",
                "effectiveSoulVerified",
                "toolInventoryComplete",
            )
            if (
                result.get("orgId") != job["orgId"]
                or result.get("agentId") != job["agentId"]
                or result.get("profile") != job["profile"]
                or result.get("kind") != job["kind"]
                or result.get("configVersionId") != job["configVersionId"]
                or any(result.get(name) is not True for name in required_true)
                or result.get("soulSha256") != job["soulSha256"]
                or result.get("soulChallengeSha256") != sha256(job["soulChallenge"].encode("ascii"))
                or result.get("policyConfigSha256") != job["policyConfigSha256"]
                or not re.fullmatch(r"[0-9a-f]{64}", str(result.get("toolInventoryDigest", "")))
                or "0.22.3" not in str(result.get("hermesVersion", ""))
            ):
                self._fail("success_attestation_mismatch")
                raise ValueError("success_attestation_mismatch")

            key = result.get("apiKey")
            if job["kind"] == "provision":
                if not isinstance(key, str) or not API_KEY_RE.fullmatch(key):
                    self._fail("profile_key_missing")
                    raise ValueError("profile_key_missing")
                existing = self.profile_keys.get(job["profile"])
                already_succeeded = job["jobId"] in self.success_by_job
                if existing is not None and not hmac.compare_digest(existing, key):
                    self._fail("profile_key_changed_on_retry")
                    raise ValueError("profile_key_changed_on_retry")
                if existing is None and any(hmac.compare_digest(other, key) for other in self.profile_keys.values()):
                    self._fail("profile_key_reused_across_employees")
                    raise ValueError("profile_key_reused_across_employees")
                self.profile_keys[job["profile"]] = key
                self.success_by_job[job["jobId"]] = key
                if job["jobId"] in self.base_jobs:
                    self.base_success_profiles.add(job["profile"])
                if already_succeeded and self.duplicate_issued:
                    original = self.success_by_job.get(self.first_job_id)
                    if original is None or not hmac.compare_digest(original, key):
                        self._fail("idempotent_retry_key_mismatch")
                        raise ValueError("idempotent_retry_key_mismatch")
                    self.duplicate_completed = True
                self.latest_manifest[job["profile"]] = job
                self.attempts.append({"kind": "provision", "outcome": "succeeded"})
            else:
                if "apiKey" in result or job["profile"] not in self.profile_keys:
                    self._fail("sync_key_scope_invalid")
                    raise ValueError("sync_key_scope_invalid")
                self.latest_manifest[job["profile"]] = job
                self.sync_completed = True
                self.attempts.append({"kind": "sync", "outcome": "succeeded"})

            self.active = None
            if self.sync_completed:
                self.done.set()

    def accept_model_call(self, authorized: bool, *, chat_completion: bool = False) -> None:
        with self.lock:
            if not authorized:
                self.model_bad_auth += 1
                return
            self.model_calls += 1
            if chat_completion:
                self.model_chat_calls += 1

    def verify_runtime(self, model_key: str, bootstrap_key: str) -> dict[str, Any]:
        profiles_root = Path(os.environ["ACCEPTANCE_PROFILE_ROOT"])
        state_root = Path(os.environ["ACCEPTANCE_STATE_ROOT"])
        expected = set(self.latest_manifest)
        if not profiles_root.is_dir() or profiles_root.is_symlink():
            raise ValueError("profile_root_missing")
        actual = {entry.name for entry in profiles_root.iterdir()}
        if actual != expected:
            raise ValueError("profile_directory_set_mismatch")
        if len(self.profile_keys) != 12 or len(set(self.profile_keys.values())) != 12:
            raise ValueError("profile_api_key_isolation_failed")

        tenant_tags = [tenant.upper().replace("-", "_") for tenant in TENANTS]
        for profile, manifest in self.latest_manifest.items():
            directory = profiles_root / profile
            if directory.is_symlink() or not directory.is_dir() or stat.S_IMODE(directory.stat().st_mode) != 0o700:
                raise ValueError("profile_directory_permissions_invalid")
            for name in (".env", "SOUL.md", "config.yaml", ".iacquire-provisioner.json"):
                path = directory / name
                if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600:
                    raise ValueError("profile_file_permissions_invalid")
            soul = (directory / "SOUL.md").read_text(encoding="utf-8")
            if soul != manifest["soul"] or sha256(soul.encode("utf-8")) != manifest["soulSha256"]:
                raise ValueError("effective_soul_file_mismatch")
            own_tenant = next((tenant for tenant in TENANTS if tenant in soul), None)
            if own_tenant is None or any(tag in soul for tag in tenant_tags if tag != own_tenant.upper().replace("-", "_")):
                raise ValueError("tenant_soul_isolation_failed")
            env_text = (directory / ".env").read_text(encoding="ascii")
            if f"API_SERVER_KEY={self.profile_keys[profile]}\n" not in env_text:
                raise ValueError("persisted_profile_key_mismatch")
            if f"{MODEL_KEY_NAME}={model_key}\n" not in env_text:
                raise ValueError("profile_model_key_missing")
            marker = json.loads((directory / ".iacquire-provisioner.json").read_text(encoding="utf-8"))
            if (
                marker.get("orgId") != manifest["orgId"]
                or marker.get("agentId") != manifest["agentId"]
                or marker.get("profile") != profile
                or marker.get("gatewayId") != self.gateway_id
                or marker.get("sourceProvisionJobId") != (manifest["sourceProvisionJobId"] or manifest["jobId"])
                or marker.get("lastJobId") != manifest["jobId"]
                or marker.get("configVersionId") != manifest["configVersionId"]
                or marker.get("soulSha256") != manifest["soulSha256"]
                or marker.get("effectiveConfigSha256") != sha256((directory / "config.yaml").read_bytes())
            ):
                raise ValueError("profile_marker_mismatch")
            try:
                import yaml

                config = yaml.safe_load((directory / "config.yaml").read_text(encoding="utf-8"))
            except Exception:
                raise ValueError("profile_config_unreadable") from None
            if (
                config.get("model", {}).get("base_url") != f"http://127.0.0.1:{MODEL_PORT}/v1"
                or set(config.get("platform_toolsets", {}).get("api_server", [])) != {"memory", "session_search", "todo", "vision", "web", "no_mcp"}
                or not {"terminal", "file", "browser", "code_execution"}.issubset(set(config.get("agent", {}).get("disabled_toolsets", [])))
            ):
                raise ValueError("profile_policy_config_mismatch")

        audit_path = state_root / "audit.jsonl"
        if audit_path.is_symlink() or not audit_path.is_file() or stat.S_IMODE(audit_path.stat().st_mode) != 0o600:
            raise ValueError("audit_permissions_invalid")
        audit_text = audit_path.read_text(encoding="utf-8")
        audit_records = [json.loads(line) for line in audit_text.splitlines() if line.strip()]
        if len(audit_records) != 15:
            raise ValueError("audit_event_count_mismatch")
        if any("apiKey" in row or model_key in json.dumps(row) for row in audit_records):
            raise ValueError("audit_contains_secret")
        if any(key in audit_text for key in self.profile_keys.values()) or bootstrap_key in audit_text:
            raise ValueError("audit_contains_secret")
        failed = [row for row in audit_records if row.get("outcome") == "failed"]
        if len(failed) != 1 or failed[0].get("code") != "effective_soul_unverified":
            raise ValueError("audit_recovery_evidence_missing")
        if sum(row.get("outcome") == "succeeded" for row in audit_records) != 14:
            raise ValueError("audit_success_count_mismatch")

        self._verify_authenticated_routes(bootstrap_key)
        return {
            "result": "SANDBOX_PASS",
            "syntheticTenants": len(TENANTS),
            "uniqueProfiles": len(expected),
            "rolesPerTenant": len(ROLE_TITLES),
            "completionAttempts": len(self.attempts),
            "recoveredFailures": 1,
            "idempotentDuplicateChecks": 1,
            "configurationSyncChecks": 1,
            "effectiveSoulsVerified": len(expected),
            "isolatedProfileKeys": len(self.profile_keys),
            "crossTenantDenials": self.cross_tenant_denials,
            "profileKeyDenials": self.profile_key_denials,
            "auditEvents": len(audit_records),
            "auditSecretLeaks": 0,
            "canaryModelCalls": self.model_calls,
            "modelAuthenticationFailures": self.model_bad_auth,
            "externalNetwork": "disabled",
        }

    def _verify_authenticated_routes(self, bootstrap_key: str) -> None:
        base = "http://127.0.0.1:8642"
        for profile, key in self.profile_keys.items():
            route = f"{base}/p/{profile}/v1/capabilities"
            request = urllib.request.Request(route, headers={"Authorization": "Bearer " + key})
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    if response.status != 200:
                        raise ValueError("profile_authentication_failed")
                    payload = json.loads(response.read(262_144).decode("utf-8"))
            except Exception:
                raise ValueError("profile_authentication_failed") from None
            if payload.get("auth", {}).get("required") is not True:
                raise ValueError("profile_authentication_contract_failed")
            self.profile_checks += 1

            tenant = self.profile_tenants.get(profile)
            other_profiles = [(other_profile, value) for other_profile, value in self.profile_keys.items() if other_profile != profile]
            if tenant not in TENANTS or len(other_profiles) != 11:
                raise ValueError("tenant_profile_mapping_invalid")
            for other_profile, other_key in other_profiles:
                wrong = urllib.request.Request(route, headers={"Authorization": "Bearer " + other_key})
                try:
                    with urllib.request.urlopen(wrong, timeout=10) as response:
                        status = response.status
                except urllib.error.HTTPError as error:
                    status = error.code
                except Exception:
                    raise ValueError("cross_tenant_probe_failed") from None
                if status not in {401, 403, 404}:
                    self.cross_tenant_successes += 1
                    raise ValueError("profile_key_scope_failed")
                self.profile_key_denials += 1
                if self.profile_tenants.get(other_profile) != tenant:
                    self.cross_tenant_denials += 1

        default_request = urllib.request.Request(
            base + "/v1/models",
            headers={"Authorization": "Bearer " + bootstrap_key},
        )
        try:
            with urllib.request.urlopen(default_request, timeout=10) as response:
                models = json.loads(response.read(262_144).decode("utf-8"))
        except Exception:
            raise ValueError("default_identity_inventory_failed") from None
        identities = {
            row.get("id")
            for row in models.get("data", [])
            if isinstance(row, dict)
            and row.get("owned_by") == "hermes"
            and row.get("parent") is None
            and row.get("root") == row.get("id")
        }
        if not set(self.profile_keys).issubset(identities):
            raise ValueError("gateway_profile_inventory_mismatch")


def read_secret(path_value: str, expected_name: str | None = None) -> str:
    path = Path(path_value)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("acceptance_secret_file_invalid")
    raw = path.read_text(encoding="ascii").strip()
    if not raw or len(raw) > 8192:
        raise ValueError("acceptance_secret_file_invalid")
    if expected_name:
        parsed = json.loads(raw)
        if set(parsed) != {"schemaVersion", "environment", "value"} or parsed.get("schemaVersion") != 1 or parsed.get("environment") != expected_name:
            raise ValueError("acceptance_provider_fixture_invalid")
        raw = parsed["value"]
    if not isinstance(raw, str) or not MODEL_KEY_RE.fullmatch(raw):
        raise ValueError("acceptance_secret_file_invalid")
    return raw


def _json_handler(state: AcceptanceState, token: str, cert_path: Path):
    class PortalHandler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._send(200, {"ok": True})
            else:
                self._send(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self._send(401, {"error": "unauthorized"})
                return
            length = self.headers.get("Content-Length", "")
            if not length.isdecimal() or not 1 <= int(length) <= 131_072:
                self._send(413, {"error": "invalid_body"})
                return
            try:
                body = json.loads(self.rfile.read(int(length)).decode("utf-8"))
            except Exception:
                self._send(400, {"error": "invalid_body"})
                return
            path = self.path.split("?", 1)[0]
            try:
                if path == PORTAL_PREFIX + "/claim":
                    if not isinstance(body, dict) or set(body) != {"gatewayId"}:
                        self._send(400, {"error": "invalid_claim"})
                        return
                    job = state.claim(body["gatewayId"])
                    self._send(200, {"job": job})
                    return
                if path == PORTAL_PREFIX + "/complete":
                    state.complete(body)
                    self._send(200, {"accepted": True})
                    return
            except ValueError:
                self._send(409, {"error": "acceptance_contract_failed"})
                return
            self._send(404, {"error": "not_found"})

    return PortalHandler


def _model_handler(state: AcceptanceState, model_key: str):
    class ModelHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            authorized = hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + model_key)
            state.accept_model_call(authorized, chat_completion=self.path.endswith("/chat/completions"))
            if not authorized:
                self._send_json(401, {"error": {"message": "synthetic_auth_failed", "type": "authentication_error"}})
                return
            if self.path.endswith("/models"):
                self._send_json(200, {"object": "list", "data": [{"id": "synthetic-fixture", "object": "model", "created": 0, "owned_by": "synthetic"}]})
                return
            self._send_json(404, {"error": {"message": "not_found", "type": "invalid_request_error"}})

        def do_POST(self) -> None:  # noqa: N802
            authorized = hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + model_key)
            state.accept_model_call(authorized, chat_completion=self.path.endswith("/chat/completions"))
            if not authorized:
                self._send_json(401, {"error": {"message": "synthetic_auth_failed", "type": "authentication_error"}})
                return
            if not self.path.endswith("/chat/completions"):
                self._send_json(404, {"error": {"message": "not_found", "type": "invalid_request_error"}})
                return
            length = self.headers.get("Content-Length", "")
            if not length.isdecimal() or int(length) > 262_144:
                self._send_json(413, {"error": {"message": "invalid_body", "type": "invalid_request_error"}})
                return
            try:
                request = json.loads(self.rfile.read(int(length)).decode("utf-8"))
            except Exception:
                self._send_json(400, {"error": {"message": "invalid_body", "type": "invalid_request_error"}})
                return
            texts: list[str] = []

            def collect(value: Any) -> None:
                if isinstance(value, str):
                    texts.append(value)
                elif isinstance(value, list):
                    for item in value:
                        collect(item)
                elif isinstance(value, dict):
                    for item in value.values():
                        collect(item)

            collect(request)
            challenge = next((match.group(1).lower() for text in texts if (match := MARKER_RE.search(text))), None)
            if challenge is None:
                self._send_json(400, {"error": {"message": "synthetic_prompt_marker_missing", "type": "invalid_request_error"}})
                return
            with state.lock:
                fail_canary = not state.failed_once and state.model_chat_calls == 1
            if fail_canary:
                output = ("00" * 16) if challenge != ("00" * 16) else ("11" * 16)
            else:
                output = challenge
            if request.get("stream") is True:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                created = int(time.time())
                chunks = (
                    {"id": "chatcmpl-synthetic", "object": "chat.completion.chunk", "created": created, "model": "synthetic-fixture", "choices": [{"index": 0, "delta": {"role": "assistant", "content": output}, "finish_reason": None}]},
                    {"id": "chatcmpl-synthetic", "object": "chat.completion.chunk", "created": created, "model": "synthetic-fixture", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                )
                for chunk in chunks:
                    self.wfile.write(b"data: " + json.dumps(chunk, separators=(",", ":")).encode("utf-8") + b"\n\n")
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return
            self._send_json(200, {
                "id": "chatcmpl-synthetic",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "synthetic-fixture",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": output}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })

    return ModelHandler


def healthcheck() -> None:
    cert = Path("/run/secrets/acceptance-cert.pem")
    context = ssl.create_default_context(cafile=str(cert))
    for url, ssl_context in (
        (f"https://127.0.0.1:{PORTAL_PORT}/healthz", context),
        ("http://127.0.0.1:8642/health", None),
    ):
        with urllib.request.urlopen(url, timeout=5, context=ssl_context) as response:
            if response.status != 200:
                raise ValueError("runtime_healthcheck_failed")


def write_summary(state: AcceptanceState, result: dict[str, Any]) -> None:
    output = state.result_dir / "status.json"
    temp = output.with_suffix(".tmp")
    temp.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.chmod(0o644)
    temp.replace(output)
    print("ACCEPTANCE_RESULT " + json.dumps(result, sort_keys=True, separators=(",", ":")))


def serve() -> None:
    gateway_id = os.environ["ACCEPTANCE_GATEWAY_ID"]
    result_dir = Path(os.environ["ACCEPTANCE_RESULTS_DIR"])
    result_dir.mkdir(parents=True, exist_ok=True)
    token = read_secret(os.environ["ACCEPTANCE_PORTAL_TOKEN_FILE"])
    model_key = read_secret(os.environ["ACCEPTANCE_MODEL_ENV_FILE"], MODEL_KEY_NAME)
    bootstrap_key = read_secret(os.environ["ACCEPTANCE_HERMES_API_KEY_FILE"])
    cert_path = Path("/run/secrets/acceptance-cert.pem")
    private_key_path = Path("/run/secrets/acceptance-key.pem")
    if not cert_path.is_file() or not private_key_path.is_file():
        raise ValueError("acceptance_tls_fixture_missing")

    state = AcceptanceState(gateway_id, result_dir)
    portal = ThreadingHTTPServer(("127.0.0.1", PORTAL_PORT), _json_handler(state, token, cert_path))
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(str(cert_path), str(private_key_path))
    portal.socket = tls.wrap_socket(portal.socket, server_side=True)
    model = ThreadingHTTPServer(("127.0.0.1", MODEL_PORT), _model_handler(state, model_key))
    for server in (portal, model):
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

    try:
        context = ssl.create_default_context(cafile=str(cert_path))
        probe_body = json.dumps({"gatewayId": gateway_id}).encode("utf-8")
        probe = urllib.request.Request(
            f"https://127.0.0.1:{PORTAL_PORT}{PORTAL_PREFIX}/claim",
            data=probe_body,
            headers={"Content-Type": "application/json", "Authorization": "Bearer invalid-synthetic-probe"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(probe, timeout=5, context=context) as response:
                if response.status == 401:
                    raise ValueError("unauthorized_probe_unexpectedly_allowed")
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise ValueError("unauthorized_probe_contract_failed") from None
        except Exception:
            raise ValueError("unauthorized_probe_contract_failed") from None

        deadline = time.monotonic() + 30 * 60
        while not state.done.wait(0.5):
            if state.abort_code:
                break
            if time.monotonic() >= deadline:
                state._fail("acceptance_timeout")
                break

        if state.abort_code:
            result = {"result": "SANDBOX_FAIL", "failure": state.abort_code}
            write_summary(state, result)
            raise SystemExit(1)
        try:
            result = state.verify_runtime(model_key, bootstrap_key)
        except Exception as error:
            safe_code = str(error) if re.fullmatch(r"[a-z0-9_]{1,80}", str(error)) else "runtime_verification_failed"
            result = {"result": "SANDBOX_FAIL", "failure": safe_code}
            write_summary(state, result)
            raise SystemExit(1)
        write_summary(state, result)
    finally:
        portal.shutdown()
        model.shutdown()
        portal.server_close()
        model.server_close()


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) == 2 else os.environ.get("ACCEPTANCE_COMMAND", "serve")
    if command == "healthcheck":
        try:
            healthcheck()
        except Exception:
            print("ACCEPTANCE_HEALTH_FAIL")
            raise SystemExit(1) from None
    elif command == "serve":
        try:
            serve()
        except SystemExit:
            raise
        except Exception:
            print("ACCEPTANCE_FIXTURE_STARTUP_FAIL")
            raise SystemExit(1) from None
    else:
        print("ACCEPTANCE_INVALID_COMMAND")
        raise SystemExit(2)
