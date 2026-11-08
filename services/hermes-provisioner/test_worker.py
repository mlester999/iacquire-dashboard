from __future__ import annotations

import json
import base64
import contextlib
import hashlib
import hmac
import io
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
import yaml
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import worker as worker_module
from worker import (
    Heartbeat,
    ProvisioningError,
    RestrictedProvisioner,
    WorkerLoop,
    _load_max_profiles,
    _verify_home_command,
    _wait_for_hermes,
    _load_bootstrap_api_key,
    _bootstrap_api_key_file_is_private,
    _load_service_token,
    _sanitize_worker_environment,
    _validate_portal_origin,
    _worker_healthcheck,
    _write_worker_heartbeat,
    _load_client_model_config,
    HermesApi,
    digest,
    parse_manifest,
    parse_policy_config,
    render_config,
    verify_complete_catalog,
    verify_home,
)


BLOCKED = [
    "browser", "code_execution", "computer_use", "connections", "cronjob",
    "delegation", "file", "image_gen", "skills", "terminal", "catalog", "kanban",
]
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


def uid() -> str:
    return str(uuid.uuid4())


ALL_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"]
TOOLS_IN = {
    "memory": [("memory", "memory")], "session_search": [("session_search", "session_search")],
    "todo": [("todo_list", "todo")], "vision": [("vision_analyze", "vision")],
    "web": [("web_extract", "web"), ("web_search", "web")],
}


def role_policy(toolsets: list[str]) -> str:
    """The policy config with one role's narrower API-server toolsets (what the portal sends when WORKFORCE_ROLE_TOOL_ENFORCEMENT=enforce)."""
    listed = "\n".join(f"    - {name}" for name in [*toolsets, "no_mcp"])
    shared = "\n".join(f"    - {name}" for name in [*ALL_TOOLSETS, "no_mcp"])
    return POLICY.replace(shared, listed)


def new_manifest(**updates: Any) -> dict[str, Any]:
    challenge = "ab" * 16
    soul = (
        "# AI Lead Hunter - Fictional Northwind\n\n"
        "You are the tenant's dedicated lead hunter. Never disclose private setup markers.\n\n"
        "## Active approved tenant configuration\n"
        "Research only the fictional Northwind customer profile.\n\n"
        "## Initialization check\n"
        "For the private setup check only, return this marker exactly: " + challenge + "\n"
    )
    manifest = {
        "jobId": uid(),
        "leaseToken": uid(),
        "gatewayId": uid(),
        "kind": "provision",
        "orgId": uid(),
        "agentId": uid(),
        "profile": "c-northwind-0123456789ab-lead-hunter",
        "role": "lead_hunter",
        "configVersionId": uid(),
        "configVersion": 1,
        "sourceProvisionJobId": None,
        "soul": soul,
        "soulSha256": digest(soul.encode()),
        "soulChallenge": challenge,
        "configYaml": POLICY,
        "policyConfigSha256": digest(POLICY.encode()),
        "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
    }
    manifest.update(updates)
    return manifest


class FakeHermesApi:
    def __init__(self, home: Path):
        self.home = home
        self.challenge = ""
        self.paths: list[str] = []
        self.bad_signature = False
        self.change_catalog_between_reads = False
        self.incomplete_catalog = False
        self.legacy_resolver_catalog = False
        self.advertise_tools_endpoint = True
        self.tools_endpoint: Any = ["GET", "/v1/tools"]
        self.omit_tool: str | None = None
        self.catalog_reads = 0
        self.catalog_challenges: list[str] = []
        self.catalog_query_challenges: list[str] = []
        self.catalog_cache_controls: list[str] = []
        self.catalog_digest = ""
        self.profile_discovery_pending = 0
        self.profile_capability_reads = 0
        self.toolset_reads = 0
        self.canary_policy_pending_reads = 0
        self.final_policy_pending_reads = 0
        self.run_submission_status = 202
        self.run_submission_error_code: str | None = None
        self.run_submission_profile_mismatch_rejections = 0
        self.run_submission_calls = 0
        # When set, the gateway exposes these toolsets whatever the profile's config says (a profile that kept tools its policy does not name).
        self.force_toolsets: list[str] | None = None

    def active_toolsets(self, profile: str) -> list[str]:
        if self.force_toolsets is not None:
            return list(self.force_toolsets)
        config = self.home / "profiles" / profile / "config.yaml"
        value = yaml.safe_load(config.read_text(encoding="utf-8")) if config.exists() else {}
        listed = (value or {}).get("platform_toolsets", {}).get("api_server", [])
        names = [name for name in listed if name != "no_mcp"]
        return names if names else (list(ALL_TOOLSETS) if profile == "default" else [])

    def json_request(
        self,
        profile: str,
        key: str,
        path: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ):
        self.paths.append(path)
        if path == "/v1/capabilities":
            if profile != "default":
                self.profile_capability_reads += 1
                if self.profile_discovery_pending > 0:
                    self.profile_discovery_pending -= 1
                    return 404, {"error": "profile_not_discovered_yet"}
            endpoints = {"tools": self.tools_endpoint} if self.advertise_tools_endpoint else {}
            return 200, {
                "object": "hermes.api_server.capabilities",
                "auth": {"required": True, "type": "bearer"},
                "features": {"run_submission": True},
                "endpoints": endpoints,
            }
        if path == "/v1/models":
            return 200, {"data": [{"id": profile, "owned_by": "hermes", "parent": None, "root": profile}]}
        if path == "/v1/toolsets":
            self.toolset_reads += 1
            config = self.home / "profiles" / profile / "config.yaml"
            config_text = config.read_text(encoding="utf-8") if config.exists() else ""
            config_value = yaml.safe_load(config_text) if config_text else {}
            configured_toolsets = (config_value or {}).get("platform_toolsets", {}).get("api_server", [])
            is_canary = configured_toolsets == ["no_mcp"]
            canary_toolsets = [{"name": "no_mcp", "enabled": False, "tools": []}]
            active = self.active_toolsets(profile)
            final_toolsets = [
                {"name": name, "enabled": True, "tools": sorted(tool for tool, _ in TOOLS_IN[name])}
                for name in ALL_TOOLSETS if name in active
            ]
            if is_canary and self.canary_policy_pending_reads:
                self.canary_policy_pending_reads -= 1
                # The gateway has not applied the canary yet: it still serves the previous, full policy.
                return 200, [{"name": name, "enabled": True, "tools": sorted(tool for tool, _ in TOOLS_IN[name])} for name in ALL_TOOLSETS]
            if not is_canary and self.final_policy_pending_reads:
                self.final_policy_pending_reads -= 1
                return 200, canary_toolsets
            if is_canary:
                return 200, canary_toolsets
            if not active:
                return 200, [{"name": "no_mcp", "enabled": False, "tools": []}]
            return 200, final_toolsets
        if path == "/v1/runs" and method == "POST":
            self.run_submission_calls += 1
            self.challenge = body.get("session_id", "").split("-")[-1]
            if self.run_submission_profile_mismatch_rejections:
                self.run_submission_profile_mismatch_rejections -= 1
                return 409, {"error": {"code": "profile_mismatch"}}
            if self.run_submission_error_code:
                return self.run_submission_status, {"error": {"code": self.run_submission_error_code}}
            return self.run_submission_status, {"run_id": "run-test"}
        if path.startswith("/v1/tools?platform=api_server"):
            challenge = (extra_headers or {}).get("X-Hermes-Inventory-Challenge", "")
            self.catalog_reads += 1
            self.catalog_challenges.append(challenge)
            self.catalog_cache_controls.append((extra_headers or {}).get("Cache-Control", ""))
            query = path.partition("?")[2]
            query_fields = dict(field.split("=", 1) for field in query.split("&") if "=" in field)
            self.catalog_query_challenges.append(query_fields.get("inventory_challenge", ""))
            available: bool | None = None if self.change_catalog_between_reads and self.catalog_reads % 2 == 0 else True
            active_for_catalog = self.active_toolsets(profile)
            entries = [entry for name in ALL_TOOLSETS if name in active_for_catalog for entry in TOOLS_IN[name]]
            if self.omit_tool:
                entries = [entry for entry in entries if entry[0] != self.omit_tool]
            rows = [
                {
                    "name": name,
                    "parameters": {},
                    "available": available,
                    "provenance": {
                        "source": "configurable",
                        "toolset": toolset,
                        "requested_toolsets": [toolset],
                        "source_server": None,
                        "added_below_explicit_config": False,
                    },
                }
                for name, toolset in entries
            ]
            canonical_tools = [
                {
                    "name": name,
                    "source": "configurable",
                    "toolset": toolset,
                    "sourceServer": None,
                    "addedBelowExplicitConfig": False,
                    "available": available,
                }
                for name, toolset in entries
            ]
            canonical = {
                "contract": "hermes.api_server.tool_catalog.v1",
                "profile": profile,
                "platform": "api_server",
                "explicitConfigPresent": True,
                "enabledToolsets": sorted(active_for_catalog),
                "tools": sorted(canonical_tools, key=lambda row: row["name"]),
            }
            catalog_digest = digest(json.dumps(canonical, separators=(",", ":")).encode())
            self.catalog_digest = catalog_digest
            signed_payload = json.dumps(
                {"contract": "hermes.api_server.tool_catalog.v1", "profile": profile, "challenge": challenge, "digest": catalog_digest},
                separators=(",", ":"),
            ).encode()
            signature = base64.urlsafe_b64encode(hmac.new(key.encode(), signed_payload, hashlib.sha256).digest()).decode().rstrip("=")
            if self.bad_signature:
                signature = "invalid-signature"
            catalog = {
                "object": "list",
                "platform": "api_server",
                "explicit_config_present": True,
                "enabled_toolsets": ALL_TOOLSETS if active_for_catalog == ALL_TOOLSETS else [name for name in ALL_TOOLSETS if name in active_for_catalog],
                "data": rows,
            }
            if self.legacy_resolver_catalog:
                return 200, catalog
            return 200, {
                **catalog,
                "contract": "hermes.api_server.tool_catalog.v1",
                "complete": not self.incomplete_catalog,
                "challenge": challenge,
                "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
                "attestation": {"algorithm": "hmac-sha256", "signature": signature, "key_id": "profile-key"},
            }
        raise AssertionError("unexpected Hermes request " + path)

    def json_request_default(self, key: str, path: str, method: str = "GET", body: dict[str, Any] | None = None, extra_headers: dict[str, str] | None = None):
        return self.json_request("default", key, path, method, body, extra_headers)

    def read_events(self, profile: str, key: str, run_id: str, timeout: int = 120) -> str:
        return self.expected_challenge


class RestrictedProvisionerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        (self.home / "profiles").mkdir(parents=True)
        self.gateway_id = uid()
        self.manifest = new_manifest(gatewayId=self.gateway_id)
        self.api = FakeHermesApi(self.home)
        self.commands: list[list[str]] = []
        self.command_envs: list[dict[str, str]] = []

        def run_command(args, **kwargs):
            self.commands.append(args)
            self.command_envs.append(kwargs["env"])
            name = args[3]
            profile = self.home / "profiles" / name
            profile.mkdir(mode=0o700)
            (profile / "config.yaml").write_text("model:\n  provider: deepseek\n  name: approved-model\n", encoding="utf-8")
            (profile / ".env").write_text("API_SERVER_KEY=shared-placeholder\n", encoding="utf-8")
            return subprocess.CompletedProcess(args, 0, "", "")

        self.run_command = run_command
        self.provisioner = RestrictedProvisioner(
            home=self.home,
            hermes_cli=Path("/opt/hermes/bin/hermes"),
            api=self.api,
            gateway_id=self.gateway_id,
            hermes_version="hermes v0.21.5-test",
            run_command=run_command,
        )
        self.api.expected_challenge = self.manifest["soulChallenge"]

    def test_provision_uses_only_blank_profile_cli_and_verifies_effective_soul(self):
        with patch.dict(os.environ, {
            "IACQUIRE_PROVISIONER_TOKEN": "worker-token-must-not-enter-cli-env",
            "OPENAI_API_KEY": "model-key-must-not-enter-cli-env",
        }):
            result = self.provisioner.process(self.manifest)
        profile = self.home / "profiles" / self.manifest["profile"]
        env_text = (profile / ".env").read_text(encoding="utf-8")
        marker = json.loads((profile / ".iacquire-provisioner.json").read_text(encoding="utf-8"))
        config = (profile / "config.yaml").read_text(encoding="utf-8")
        audit_path = self.home / "iacquire-provisioner-state" / "audit.jsonl"
        audit_text = audit_path.read_text(encoding="utf-8")
        audit = json.loads(audit_text.splitlines()[0])

        self.assertTrue(result["effectiveSoulVerified"])
        self.assertTrue(result["toolInventoryComplete"])
        self.assertEqual(result["soulSha256"], self.manifest["soulSha256"])
        self.assertEqual(result["apiKey"], env_text.split("API_SERVER_KEY=", 1)[1].strip())
        self.assertNotIn("API_SERVER_ENABLED", env_text)
        self.assertRegex(result["apiKey"], r"^[0-9a-f]{64}$")
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.commands[0][1:3], ["profile", "create"])
        self.assertEqual(self.commands[0][3], self.manifest["profile"])
        self.assertIn("--no-alias", self.commands[0])
        self.assertIn("--no-skills", self.commands[0])
        self.assertNotIn("--clone", self.commands[0])
        self.assertNotIn("API_SERVER_KEY", json.dumps(marker))
        self.assertEqual(marker["gatewayId"], self.gateway_id)
        self.assertNotIn(result["apiKey"], audit_text)
        self.assertNotIn(self.manifest["soul"], audit_text)
        self.assertNotIn(self.manifest["leaseToken"], audit_text)
        self.assertEqual(audit["outcome"], "succeeded")
        self.assertEqual(audit["effectiveConfigSha256"], result["effectiveConfigSha256"])
        self.assertEqual(audit["toolInventoryDigest"], result["toolInventoryDigest"])
        self.assertEqual(result["toolInventoryDigest"], self.api.catalog_digest)
        self.assertEqual(len(self.api.catalog_challenges), 2)
        self.assertNotEqual(self.api.catalog_challenges[0], self.api.catalog_challenges[1])
        self.assertRegex(result["toolInventoryDigest"], r"^[0-9a-f]{64}$")
        self.assertNotIn("IACQUIRE_PROVISIONER_TOKEN", self.command_envs[0])
        self.assertNotIn("OPENAI_API_KEY", self.command_envs[0])
        self.assertEqual(self.command_envs[0]["HERMES_HOME"], str(self.home))
        self.assertIn("provider: deepseek", config)
        self.assertIn("api_server:", config)
        if os.name != "nt":
            self.assertEqual((profile / ".env").stat().st_mode & 0o777, 0o600)
            self.assertEqual(profile.stat().st_mode & 0o777, 0o700)
            self.assertEqual(audit_path.stat().st_mode & 0o777, 0o600)

    def test_blank_profile_uses_only_the_client_global_model_block(self):
        client_config = self.home / "config.yaml"
        client_config.write_text(
            "model:\n  provider: openai-api\n  model: synthetic-fixture\n"
            "  api_mode: chat_completions\n  base_url: http://127.0.0.1:19000/v1\n"
            "SOUL.md: must-not-copy\n",
            encoding="utf-8",
        )
        model_config = _load_client_model_config(self.home)
        blank_profile_config = self.home / "profiles" / "blank-client-profile.yaml"
        blank_profile_config.write_text("model: {}\n", encoding="utf-8")

        effective = yaml.safe_load(
            render_config(
                blank_profile_config,
                parse_policy_config(POLICY),
                canary=True,
                model_config=model_config,
            ).decode("utf-8")
        )

        self.assertEqual(effective["model"], model_config)
        self.assertEqual(effective["model"]["provider"], "openai-api")
        self.assertEqual(effective["model"]["api_mode"], "chat_completions")
        self.assertEqual(effective["model"]["base_url"], "http://127.0.0.1:19000/v1")
        self.assertNotIn("SOUL.md", effective)

    def test_client_model_config_rejects_placeholders_and_secret_fields(self):
        config_path = self.home / "config.yaml"
        config_path.write_text(
            "model:\n  provider: openai-api\n  model: REPLACE_WITH_APPROVED_MODEL_ID\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ProvisioningError, "client_model_config_missing"):
            _load_client_model_config(self.home)

        config_path.write_text(
            "model:\n  provider: openai-api\n  model: synthetic-fixture\n  api_key: must-not-copy\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ProvisioningError, "client_model_config_invalid"):
            _load_client_model_config(self.home)

    def test_new_profile_waits_for_profile_route_before_canary(self):
        self.api.profile_discovery_pending = 2
        with patch("worker.time.sleep") as sleep:
            result = self.provisioner.process(self.manifest)

        self.assertTrue(result["effectiveSoulVerified"])
        self.assertEqual(self.api.profile_capability_reads, 5)
        self.assertEqual(sleep.call_count, 2)

    def test_canary_submission_failure_reports_only_the_http_status(self):
        self.api.run_submission_status = 403
        self.api.run_submission_error_code = "a" * 64
        with self.assertRaises(ProvisioningError) as caught:
            self.provisioner.process(self.manifest)
        self.assertEqual(caught.exception.code, "canary_submission_http_403")
        self.assertNotIn("a" * 64, str(caught.exception))

    def test_canary_submission_reports_only_allowlisted_gateway_error_code(self):
        self.api.run_submission_status = 409
        self.api.run_submission_error_code = "permission_denied"
        with self.assertRaisesRegex(ProvisioningError, "canary_submission_http_409_permission_denied"):
            self.provisioner.process(self.manifest)

    def test_canary_submission_retries_bounded_profile_authority_refusals(self):
        self.api.run_submission_profile_mismatch_rejections = 2
        with patch("worker.time.sleep") as sleep:
            result = self.provisioner.process(self.manifest)
        self.assertTrue(result["effectiveSoulVerified"])
        self.assertEqual(self.api.run_submission_calls, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_canary_submission_fails_closed_when_profile_authority_never_appears(self):
        self.api.run_submission_profile_mismatch_rejections = 1
        with patch("worker.PROFILE_DISCOVERY_TIMEOUT_SECONDS", 0):
            with self.assertRaisesRegex(ProvisioningError, "canary_submission_http_409_profile_mismatch"):
                self.provisioner.process(self.manifest)
        self.assertEqual(self.api.run_submission_calls, 1)

    def test_failed_canary_event_reports_only_a_bounded_error_code(self):
        class EventResponse:
            status = 200

            def __init__(self, payload: dict[str, Any]):
                self._lines = iter(
                    [
                        b"event: run.failed\n",
                        b"data: " + json.dumps(payload).encode("utf-8") + b"\n",
                        b"\n",
                    ]
                )

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def readline(self):
                return next(self._lines, b"")

            def read(self, _size: int = -1):
                return b""

        api = HermesApi("http://127.0.0.1:8642")
        secret_message = "provider rejected request with synthetic-secret-value"
        response = EventResponse({"error": secret_message, "code": "model_provider_error"})
        with patch.object(api.http.opener, "open", return_value=response):
            with self.assertRaises(ProvisioningError) as caught:
                api.read_events("c-northwind-0123456789ab-lead-hunter", "synthetic-key", "run-1")
        self.assertEqual(caught.exception.code, "canary_failed_model_provider_error")
        self.assertNotIn(secret_message, str(caught.exception))
        self.assertNotIn("synthetic-secret-value", str(caught.exception))

        unsafe_response = EventResponse({"error": secret_message, "code": "secret-value"})
        with patch.object(api.http.opener, "open", return_value=unsafe_response):
            with self.assertRaises(ProvisioningError) as unsafe_caught:
                api.read_events("c-northwind-0123456789ab-lead-hunter", "synthetic-key", "run-2")
        self.assertEqual(unsafe_caught.exception.code, "canary_failed")
        self.assertNotIn("secret-value", str(unsafe_caught.exception))

        classified_secret = "No API key found for openai: synthetic-provider-secret"
        classified_response = EventResponse({"error": classified_secret})
        with patch.object(api.http.opener, "open", return_value=classified_response):
            with self.assertRaises(ProvisioningError) as classified_caught:
                api.read_events("c-northwind-0123456789ab-lead-hunter", "synthetic-key", "run-3")
        self.assertEqual(classified_caught.exception.code, "canary_failed_model_credentials_missing")
        self.assertNotIn(classified_secret, str(classified_caught.exception))
        self.assertNotIn("synthetic-provider-secret", str(classified_caught.exception))

        exit_response = EventResponse({"turn_exit_reason": "provider_resolution_failed"})
        with patch.object(api.http.opener, "open", return_value=exit_response):
            with self.assertRaises(ProvisioningError) as exit_caught:
                api.read_events("c-northwind-0123456789ab-lead-hunter", "synthetic-key", "run-4")
        self.assertEqual(exit_caught.exception.code, "canary_failed_provider_resolution_failed")

        status_secret = "No API key found for openai: status-only synthetic secret"
        status_response = EventResponse({})
        with (
            patch.object(api.http.opener, "open", return_value=status_response),
            patch.object(api, "json_request", return_value=(200, {"status": "failed", "error": status_secret})) as status_request,
        ):
            with self.assertRaises(ProvisioningError) as status_caught:
                api.read_events("c-northwind-0123456789ab-lead-hunter", "synthetic-key", "run-5")
        self.assertEqual(status_caught.exception.code, "canary_failed_model_credentials_missing")
        self.assertNotIn(status_secret, str(status_caught.exception))
        self.assertEqual(status_request.call_args.args[2], "/v1/runs/run-5")

    def test_canary_waits_for_gateway_to_apply_disabled_tool_policy(self):
        self.api.canary_policy_pending_reads = 2
        with patch("worker.time.sleep"):
            result = self.provisioner.process(self.manifest)

        self.assertTrue(result["effectiveSoulVerified"])
        self.assertEqual(self.api.canary_policy_pending_reads, 0)
        self.assertGreaterEqual(self.api.toolset_reads, 4)

    def test_final_policy_waits_for_gateway_to_apply_generated_config(self):
        self.api.final_policy_pending_reads = 2
        with patch("worker.time.sleep"):
            result = self.provisioner.process(self.manifest)

        self.assertTrue(result["toolInventoryComplete"])
        self.assertEqual(self.api.final_policy_pending_reads, 0)
        self.assertGreaterEqual(self.api.toolset_reads, 4)

    def test_final_policy_sync_timeout_fails_closed(self):
        self.api.final_policy_pending_reads = 1
        with patch("worker.PROFILE_CONFIG_SYNC_TIMEOUT_SECONDS", 0):
            with self.assertRaisesRegex(ProvisioningError, "runtime_tool_policy_unverified"):
                self.provisioner.process(self.manifest)
        self.assertEqual(self.api.paths.count("/v1/runs"), 1)

    def test_profile_discovery_timeout_keeps_durable_creation_for_retry(self):
        self.api.profile_discovery_pending = 1
        with patch("worker.PROFILE_DISCOVERY_TIMEOUT_SECONDS", 0):
            with self.assertRaisesRegex(ProvisioningError, "profile_gateway_discovery_timeout"):
                self.provisioner.process(self.manifest)

        profile = self.home / "profiles" / self.manifest["profile"]
        journal = json.loads(
            (self.home / "iacquire-provisioner-state" / (self.manifest["profile"] + ".json"))
            .read_text(encoding="utf-8")
        )
        self.assertTrue(journal["apiKeyWritten"])
        key_before_retry = (profile / ".env").read_text(encoding="utf-8")
        self.api.profile_discovery_pending = 0
        with patch("worker.time.sleep"):
            result = self.provisioner.process(self.manifest)

        self.assertTrue(result["effectiveSoulVerified"])
        self.assertEqual((profile / ".env").read_text(encoding="utf-8"), key_before_retry)
        self.assertEqual(len(self.commands), 1)

    def test_retry_is_idempotent_and_does_not_rotate_the_profile_key(self):
        first = self.provisioner.process(self.manifest)
        second = self.provisioner.process(self.manifest)
        self.assertEqual(first["apiKey"], second["apiKey"])
        self.assertEqual(len(self.commands), 1)

    def test_conflicting_existing_directory_is_never_adopted(self):
        (self.home / "profiles" / self.manifest["profile"]).mkdir()
        with self.assertRaisesRegex(ProvisioningError, "profile_conflict"):
            self.provisioner.process(self.manifest)
        self.assertEqual(self.commands, [])

    def test_runtime_home_rejects_unowned_and_internal_profiles(self):
        (self.home / "profiles" / "operations-manager").mkdir()
        with self.assertRaisesRegex(ProvisioningError, "agency_profile_found"):
            RestrictedProvisioner(
                home=self.home,
                hermes_cli=Path("/opt/hermes/bin/hermes"),
                api=self.api,
                gateway_id=self.gateway_id,
                hermes_version="hermes-test",
                run_command=self.run_command,
            )

    def test_invalid_inventory_signature_fails_closed_and_is_audited_for_retry(self):
        self.api.bad_signature = True
        with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
            self.provisioner.process(self.manifest)
        profile = self.home / "profiles" / self.manifest["profile"]
        self.assertTrue(profile.exists())
        self.assertFalse((profile / ".iacquire-provisioner.json").exists())
        failure = json.loads((self.home / "iacquire-provisioner-state" / "audit.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(failure["outcome"], "failed")
        self.assertEqual(failure["code"], "runtime_tool_inventory_incomplete")

        self.api.bad_signature = False
        result = self.provisioner.process(self.manifest)
        self.assertTrue(result["toolInventoryComplete"])
        self.assertEqual(len(self.commands), 1)

    def test_role_policy_provisions_a_profile_with_only_the_toolsets_its_role_needs(self):
        # An Appointment Setter does not research prospects: its policy names no web toolset, and the profile is verified against exactly that list.
        policy = role_policy(["memory", "session_search", "todo", "vision"])
        manifest = new_manifest(gatewayId=self.gateway_id, role="appointment_setter", profile="c-northwind-0123456789ab-appointment-setter", configYaml=policy, policyConfigSha256=digest(policy.encode()))
        self.api.expected_challenge = manifest["soulChallenge"]
        result = self.provisioner.process(manifest)
        self.assertTrue(result["toolInventoryComplete"])
        self.assertEqual(len(self.api.catalog_challenges), 2)

    def test_role_policy_rejects_a_profile_that_still_exposes_a_toolset_its_policy_does_not_name(self):
        policy = role_policy(["memory", "session_search", "todo", "vision"])
        manifest = new_manifest(gatewayId=self.gateway_id, role="sales_assistant", profile="c-northwind-0123456789ab-sales-assistant", configYaml=policy, policyConfigSha256=digest(policy.encode()))
        self.api.expected_challenge = manifest["soulChallenge"]
        self.api.force_toolsets = list(ALL_TOOLSETS)  # the gateway keeps the web tools although the policy no longer names them
        with patch("worker.PROFILE_CONFIG_SYNC_TIMEOUT_SECONDS", 0.3), patch("worker.PROFILE_CONFIG_SYNC_RETRY_INTERVAL_SECONDS", 0.05):
            with self.assertRaisesRegex(ProvisioningError, "runtime_tool_policy_unverified"):
                self.provisioner.process(manifest)
        self.assertFalse((self.home / "profiles" / manifest["profile"] / ".iacquire-provisioner.json").exists())

    def test_role_policy_rejects_a_profile_missing_a_tool_its_role_needs(self):
        policy = role_policy(["memory", "session_search", "todo", "vision", "web"])
        manifest = new_manifest(gatewayId=self.gateway_id, role="lead_hunter", configYaml=policy, policyConfigSha256=digest(policy.encode()))
        self.api.expected_challenge = manifest["soulChallenge"]
        self.api.omit_tool = "web_search"
        with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
            self.provisioner.process(manifest)

    def test_inventory_change_between_challenged_reads_fails_closed(self):
        self.api.change_catalog_between_reads = True
        with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
            self.provisioner.process(self.manifest)
        self.assertEqual(len(self.api.catalog_challenges), 2)
        self.assertFalse((self.home / "profiles" / self.manifest["profile"] / ".iacquire-provisioner.json").exists())
        failure = json.loads((self.home / "iacquire-provisioner-state" / "audit.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(failure["code"], "runtime_tool_inventory_incomplete")

    def test_runtime_preflight_requires_two_challenged_complete_default_catalog_reads(self):
        catalog_digest = verify_complete_catalog(self.api, "default", "a" * 64, default_profile=True)
        self.assertEqual(len(catalog_digest), 64)
        self.assertEqual(self.api.catalog_reads, 2)
        self.assertEqual(len(set(self.api.catalog_challenges)), 2)
        self.assertEqual(self.api.paths[0], "/v1/capabilities")
        self.assertEqual(self.api.paths[1:], [path for path in self.api.paths[1:] if path.startswith("/v1/tools?platform=api_server")])
        self.assertEqual(len(set(self.api.catalog_query_challenges)), 2)
        self.assertTrue(all("no-store" in value for value in self.api.catalog_cache_controls))

    def test_runtime_preflight_accepts_v0225_object_endpoint_descriptor(self):
        self.api.tools_endpoint = {"method": "GET", "path": "/v1/tools"}
        catalog_digest = verify_complete_catalog(self.api, "default", "a" * 64, default_profile=True)
        self.assertEqual(len(catalog_digest), 64)
        self.assertEqual(self.api.catalog_reads, 2)

    def test_runtime_preflight_rejects_malformed_endpoint_descriptors(self):
        malformed = [
            {"method": "POST", "path": "/v1/tools"},
            {"method": "GET", "path": "/v1/tools", "extra": True},
            {"method": "GET", "path": "/v1/toolsets"},
            ["GET", "/v1/tools", "extra"],
        ]
        for endpoint in malformed:
            with self.subTest(endpoint=endpoint):
                self.api.tools_endpoint = endpoint
                with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
                    verify_complete_catalog(self.api, "default", "a" * 64, default_profile=True)
                self.assertEqual(self.api.catalog_reads, 0)

    def test_native_catalog_requires_advertised_route_challenge_contract_and_safe_inventory(self):
        self.api.advertise_tools_endpoint = False
        with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
            verify_complete_catalog(self.api, "default", "a" * 64, default_profile=True)
        self.assertEqual(self.api.catalog_reads, 0)

        self.api.advertise_tools_endpoint = True
        self.api.legacy_resolver_catalog = True
        with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
            verify_complete_catalog(self.api, "default", "a" * 64, default_profile=True)
        self.assertEqual(self.api.catalog_reads, 1)

        self.api.catalog_reads = 0
        self.api.legacy_resolver_catalog = False
        self.api.omit_tool = "web_search"
        with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
            verify_complete_catalog(self.api, "default", "a" * 64, default_profile=True)
        self.assertEqual(self.api.catalog_reads, 1)

    def test_default_profile_preflight_uses_the_root_route_and_bearer_key(self):
        class Recorder:
            request_args = None

            def request(self, *args):
                self.request_args = args
                return 200, {"ok": True}

        api = HermesApi("http://127.0.0.1:8642")
        recorder = Recorder()
        api.http = recorder
        status, body = api.json_request_default("a" * 64, "/v1/tools?platform=api_server")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True})
        self.assertEqual(recorder.request_args[0], "http://127.0.0.1:8642/v1/tools?platform=api_server")
        self.assertEqual(recorder.request_args[2]["Authorization"], "Bearer " + "a" * 64)

    def test_runtime_preflight_fails_closed_before_any_portal_claim_if_contract_is_missing(self):
        self.api.incomplete_catalog = True
        with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
            verify_complete_catalog(self.api, "default", "a" * 64, default_profile=True)
        self.assertEqual(self.api.catalog_reads, 1)

    def test_provider_key_is_written_only_to_client_profile_and_excluded_from_results_and_audit(self):
        provisioner = RestrictedProvisioner(
            home=self.home,
            hermes_cli=Path("/opt/hermes/bin/hermes"),
            api=self.api,
            gateway_id=self.gateway_id,
            hermes_version="hermes test",
            profile_model_env={"DEEPSEEK_API_KEY": "fictional-model-secret-123"},
            run_command=self.run_command,
        )
        result = provisioner.process(self.manifest)
        profile_env = (self.home / "profiles" / self.manifest["profile"] / ".env").read_text(encoding="utf-8")
        audit = (self.home / "iacquire-provisioner-state" / "audit.jsonl").read_text(encoding="utf-8")
        self.assertIn("DEEPSEEK_API_KEY=fictional-model-secret-123", profile_env)
        self.assertNotIn("fictional-model-secret-123", json.dumps(result))
        self.assertNotIn("fictional-model-secret-123", audit)

    def test_interrupted_cli_creation_recovers_only_from_its_durable_intent(self):
        calls = 0

        def create_then_interrupt(args, **kwargs):
            nonlocal calls
            calls += 1
            profile = self.home / "profiles" / args[3]
            profile.mkdir(mode=0o700)
            (profile / "config.yaml").write_text("model:\n  provider: deepseek\n", encoding="utf-8")
            if calls == 1:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, "", "")

        interrupted = RestrictedProvisioner(
            home=self.home,
            hermes_cli=Path("/opt/hermes/bin/hermes"),
            api=self.api,
            gateway_id=self.gateway_id,
            hermes_version="hermes v0.21.5-test",
            run_command=create_then_interrupt,
        )
        with self.assertRaisesRegex(ProvisioningError, "profile_create_failed"):
            interrupted.process(self.manifest)
        restarted = RestrictedProvisioner(
            home=self.home,
            hermes_cli=Path("/opt/hermes/bin/hermes"),
            api=self.api,
            gateway_id=self.gateway_id,
            hermes_version="hermes v0.21.5-test",
            run_command=create_then_interrupt,
        )
        recovered = restarted.process(self.manifest)
        self.assertTrue(recovered["effectiveSoulVerified"])
        self.assertEqual(calls, 1)

    def test_sync_requires_matching_tenant_and_original_provision_job(self):
        self.provisioner.process(self.manifest)
        self.api.expected_challenge = "cd" * 16
        changed = self.manifest["soul"].replace(self.manifest["soulChallenge"], self.api.expected_challenge)
        sync = new_manifest(
            gatewayId=self.gateway_id,
            jobId=uid(),
            leaseToken=uid(),
            kind="sync",
            sourceProvisionJobId=self.manifest["jobId"],
            orgId=self.manifest["orgId"],
            agentId=self.manifest["agentId"],
            profile=self.manifest["profile"],
            configVersionId=uid(),
            configVersion=2,
            soul=changed,
            soulChallenge=self.api.expected_challenge,
            soulSha256=digest(changed.encode()),
        )
        result = self.provisioner.process(sync)
        self.assertTrue(result["effectiveSoulVerified"])
        self.assertNotIn("apiKey", result)
        self.assertEqual(len(self.commands), 1)

        foreign = dict(sync, jobId=uid(), orgId=uid())
        with self.assertRaisesRegex(ProvisioningError, "profile_ownership_conflict"):
            self.provisioner.process(foreign)

    def test_growth_partner_runtime_identity_is_accepted_and_legacy_roles_remain_valid(self):
        legacy_roles = {
            "operations_manager",
            "lead_hunter",
            "appointment_setter",
            "sales_assistant",
            "crm_manager",
            "performance_analyst",
        }
        self.assertTrue(legacy_roles.issubset(worker_module.ROLE_KEYS))

        soul = self.manifest["soul"].replace("AI Lead Hunter", "AI Growth Partner")
        partner = new_manifest(
            gatewayId=self.gateway_id,
            role="growth_partner",
            profile="c-northwind-0123456789ab-growth-partner",
            soul=soul,
            soulSha256=digest(soul.encode()),
        )
        parsed = parse_manifest(partner, self.gateway_id)
        self.assertEqual(parsed.role, "growth_partner")

    def test_manifest_and_policy_reject_paths_unknown_tools_and_clone_requests(self):
        bad_name = dict(self.manifest, profile="../default")
        with self.assertRaisesRegex(ProvisioningError, "invalid_manifest"):
            parse_manifest(bad_name, self.gateway_id)
        bad_policy = dict(self.manifest, configYaml=POLICY.replace("    - web\n", "    - terminal\n"))
        bad_policy["policyConfigSha256"] = digest(bad_policy["configYaml"].encode())
        with self.assertRaisesRegex(ProvisioningError, "invalid_policy_config"):
            self.provisioner.process(bad_policy)

    def test_portal_url_accepts_only_an_https_origin(self):
        self.assertEqual(_validate_portal_origin("https://portal.example.test/"), "https://portal.example.test")
        for value in (
            "http://portal.example.test",
            "https://portal.example.test/path",
            "https://portal.example.test?next=evil",
            "https://user:pass@portal.example.test",
            "https://portal.example.test:invalid",
        ):
            with self.subTest(value=value), self.assertRaises(ProvisioningError):
                _validate_portal_origin(value)

    def test_worker_drops_inherited_credentials_from_its_environment(self):
        with patch.dict(os.environ, {
            "PATH": "worker-path",
            "IACQUIRE_PROVISIONER_TOKEN": "portal-token",
            "IACQUIRE_PROVISIONER_TOKEN_FILE": "C:\\secrets\\provisioner-token",
            "OPENAI_API_KEY": "model-key",
            "DATABASE_URL": "database-secret",
        }, clear=True):
            _sanitize_worker_environment(self.home, "http://127.0.0.1:8642")
            self.assertEqual(os.environ.get("PATH"), "worker-path")
            self.assertEqual(os.environ.get("HERMES_HOME"), str(self.home))
            self.assertEqual(os.environ.get("HERMES_PROVISIONER_API_BASE"), "http://127.0.0.1:8642")
            self.assertNotIn("IACQUIRE_PROVISIONER_TOKEN", os.environ)
            self.assertNotIn("IACQUIRE_PROVISIONER_TOKEN_FILE", os.environ)
            self.assertNotIn("OPENAI_API_KEY", os.environ)
            self.assertNotIn("DATABASE_URL", os.environ)

    def test_mounted_service_token_is_read_from_a_private_regular_file(self):
        token_path = Path(self.temp.name) / "service-token"
        token_path.write_text("mounted-service-token-abcdefghijklmnopqrstuvwxyz\n", encoding="ascii")
        if os.name != "nt":
            token_path.chmod(0o600)
        with patch.dict(os.environ, {
            "IACQUIRE_PROVISIONER_TOKEN_FILE": str(token_path),
        }, clear=True):
            self.assertEqual(_load_service_token(), "mounted-service-token-abcdefghijklmnopqrstuvwxyz")
        with patch.dict(os.environ, {
            "IACQUIRE_PROVISIONER_TOKEN": "environment-service-token-abcdefghijklmnopqrstuvwxyz",
            "IACQUIRE_PROVISIONER_TOKEN_FILE": str(token_path),
        }, clear=True), self.assertRaisesRegex(ProvisioningError, "provisioner_credentials_missing"):
            _load_service_token()

    def test_bootstrap_api_key_requires_a_private_mounted_file(self):
        key_path = Path(self.temp.name) / "hermes-api-key"
        key_path.write_text("f" * 64 + "\n", encoding="ascii")
        if os.name != "nt":
            key_path.chmod(0o600)
        with patch.dict(os.environ, {
            "HERMES_PROVISIONER_BOOTSTRAP_API_KEY_FILE": str(key_path),
        }, clear=True):
            self.assertEqual(_load_bootstrap_api_key(), "f" * 64)
        with patch.dict(os.environ, {
            "HERMES_PROVISIONER_BOOTSTRAP_API_KEY": "f" * 64,
            "HERMES_PROVISIONER_BOOTSTRAP_API_KEY_FILE": str(key_path),
        }, clear=True), self.assertRaisesRegex(ProvisioningError, "provisioner_credentials_missing"):
            _load_bootstrap_api_key()

    def test_bootstrap_api_key_accepts_only_exact_readonly_gateway_group_mount(self):
        with (
            patch("worker.os.name", "posix"),
            patch("worker.os.getuid", return_value=10000, create=True),
            patch("worker.os.getegid", return_value=10000, create=True),
        ):
            shared_mode = stat.S_IFREG | 0o440
            shared_key = SimpleNamespace(st_mode=shared_mode, st_uid=0, st_gid=10000)
            self.assertTrue(_bootstrap_api_key_file_is_private(shared_key))

            wrong_group = SimpleNamespace(st_mode=shared_mode, st_uid=0, st_gid=10001)
            self.assertFalse(_bootstrap_api_key_file_is_private(wrong_group))

            writable_shared = SimpleNamespace(st_mode=stat.S_IFREG | 0o460, st_uid=0, st_gid=10000)
            self.assertFalse(_bootstrap_api_key_file_is_private(writable_shared))

            world_readable = SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=0, st_gid=10000)
            self.assertFalse(_bootstrap_api_key_file_is_private(world_readable))

            worker_private = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=10000, st_gid=10000)
            self.assertTrue(_bootstrap_api_key_file_is_private(worker_private))

    def test_profile_model_env_file_accepts_only_one_api_key_name_and_no_extra_fields(self):
        from worker import _load_profile_model_env

        secret_path = Path(self.temp.name) / "profile-model-env.json"
        secret_path.write_text(
            json.dumps({"schemaVersion": 1, "environment": "OPENAI_API_KEY", "value": "fictional-key-123"}),
            encoding="ascii",
        )
        if os.name != "nt":
            secret_path.chmod(0o600)
        with patch.dict(os.environ, {"IACQUIRE_PROFILE_MODEL_ENV_FILE": str(secret_path)}, clear=True):
            self.assertEqual(_load_profile_model_env(), {"OPENAI_API_KEY": "fictional-key-123"})
        for forbidden_name in ("TELEGRAM_BOT_TOKEN", "API_SERVER_KEY", "SLACK_API_KEY"):
            secret_path.write_text(
                json.dumps({"schemaVersion": 1, "environment": forbidden_name, "value": "not-a-model-key"}),
                encoding="ascii",
            )
            with patch.dict(os.environ, {"IACQUIRE_PROFILE_MODEL_ENV_FILE": str(secret_path)}, clear=True), self.assertRaisesRegex(ProvisioningError, "profile_key_invalid"):
                _load_profile_model_env()

    def test_worker_healthcheck_requires_a_fresh_private_heartbeat(self):
        state_root = self.home / "iacquire-provisioner-state"
        state_root.mkdir(mode=0o700, exist_ok=True)
        with patch.dict(os.environ, {"HERMES_HOME": str(self.home)}, clear=True):
            self.assertFalse(_worker_healthcheck())
            _write_worker_heartbeat(state_root)
            self.assertTrue(_worker_healthcheck())
            (state_root / "heartbeat.json").write_text('{"at":0}', encoding="ascii")
            self.assertFalse(_worker_healthcheck())


    # --- audit log rotation -------------------------------------------------------------------------------------------------------------------------

    def second_manifest(self, **updates: Any) -> dict[str, Any]:
        return new_manifest(gatewayId=self.gateway_id, profile="c-northwind-0123456789ab-sales-assistant", role="sales_assistant", **updates)

    def test_audit_log_rotates_at_its_cap_and_the_next_job_succeeds(self):
        self.provisioner.process(self.manifest)
        audit = self.provisioner.state_root / "audit.jsonl"
        first_job_line = audit.read_text(encoding="utf-8")
        with patch.object(worker_module, "MAX_AUDIT_BYTES", audit.stat().st_size + 10):
            result = self.provisioner.process(self.second_manifest())
        self.assertTrue(result["ok"])
        rotated = self.provisioner.state_root / "audit.1.jsonl"
        self.assertEqual(rotated.read_text(encoding="utf-8"), first_job_line)
        live = audit.read_text(encoding="utf-8")
        self.assertIn('"outcome":"succeeded"', live)
        self.assertNotEqual(live, first_job_line)
        if os.name != "nt":
            for path in (audit, rotated):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(path.stat().st_uid, os.getuid())

    def test_audit_log_keeps_five_rotated_files_and_drops_the_oldest(self):
        root = self.provisioner.state_root
        with patch.object(worker_module, "MAX_AUDIT_BYTES", 300):
            for index in range(9):
                self.provisioner._append_audit({"at": "t", "outcome": "rejected", "code": "invalid_manifest", "n": index, "pad": "x" * 150})
        names = sorted(path.name for path in root.glob("audit*.jsonl"))
        self.assertEqual(names, ["audit.1.jsonl", "audit.2.jsonl", "audit.3.jsonl", "audit.4.jsonl", "audit.5.jsonl", "audit.jsonl"])
        # Newest first: audit.1 holds the record just before the live one, and nothing older than the fifth rotation survives.
        newest_rotated = json.loads((root / "audit.1.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(newest_rotated["n"], 7)
        live = json.loads((root / "audit.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(live["n"], 8)
        oldest = json.loads((root / "audit.5.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(oldest["n"], 3)

    def test_audit_rotation_refuses_a_symlinked_target_and_changes_nothing(self):
        root = self.provisioner.state_root
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_text("untouched", encoding="utf-8")
        try:
            os.symlink(outside, root / "audit.1.jsonl")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available here")
        with patch.object(worker_module, "MAX_AUDIT_BYTES", 200):
            self.provisioner._append_audit({"at": "t", "outcome": "rejected", "code": "invalid_manifest", "pad": "x" * 150})
            before = (root / "audit.jsonl").read_text(encoding="utf-8")
            with self.assertRaisesRegex(ProvisioningError, "audit_log_unavailable"):
                self.provisioner._append_audit({"at": "t", "outcome": "rejected", "code": "invalid_manifest", "pad": "y" * 150})
        self.assertEqual((root / "audit.jsonl").read_text(encoding="utf-8"), before)
        self.assertTrue((root / "audit.1.jsonl").is_symlink())
        self.assertEqual(outside.read_text(encoding="utf-8"), "untouched")

    def test_audit_rotation_refuses_a_target_that_is_not_a_regular_file(self):
        # The same lstat check that refuses a symlink, exercised with a directory so it also runs where symlinks cannot be created.
        root = self.provisioner.state_root
        (root / "audit.3.jsonl").mkdir()
        with patch.object(worker_module, "MAX_AUDIT_BYTES", 200):
            self.provisioner._append_audit({"at": "t", "outcome": "rejected", "code": "invalid_manifest", "pad": "x" * 150})
            before = (root / "audit.jsonl").read_text(encoding="utf-8")
            with self.assertRaisesRegex(ProvisioningError, "audit_log_unavailable"):
                self.provisioner._append_audit({"at": "t", "outcome": "rejected", "code": "invalid_manifest", "pad": "y" * 150})
        self.assertEqual((root / "audit.jsonl").read_text(encoding="utf-8"), before)
        self.assertFalse((root / "audit.1.jsonl").exists())

    def test_audit_file_that_is_a_symlink_is_still_refused(self):
        outside = Path(self.temp.name) / "outside-audit.txt"
        outside.write_text("untouched", encoding="utf-8")
        try:
            os.symlink(outside, self.provisioner.state_root / "audit.jsonl")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available here")
        if not hasattr(os, "O_NOFOLLOW"):
            self.skipTest("O_NOFOLLOW is not available here")
        with self.assertRaisesRegex(ProvisioningError, "audit_log_unavailable"):
            self.provisioner._append_audit({"at": "t", "outcome": "rejected", "code": "invalid_manifest"})
        self.assertEqual(outside.read_text(encoding="utf-8"), "untouched")

    def test_the_provisioner_exposes_the_hermes_failure_streak_to_the_loop(self):
        self.assertEqual(self.provisioner.hermes_unreachable_streak(), 0)
        self.api.consecutive_unavailable = 7
        self.assertEqual(self.provisioner.hermes_unreachable_streak(), 7)

    # --- capacity backstop --------------------------------------------------------------------------------------------------------------------------

    def provisioner_with_ceiling(self, ceiling: int | None) -> RestrictedProvisioner:
        return RestrictedProvisioner(
            home=self.home,
            hermes_cli=Path("/opt/hermes/bin/hermes"),
            api=self.api,
            gateway_id=self.gateway_id,
            hermes_version="hermes v0.21.5-test",
            run_command=self.run_command,
            max_profiles=ceiling,
        )

    def test_provision_at_the_ceiling_raises_capacity_exceeded_and_runs_no_cli(self):
        provisioner = self.provisioner_with_ceiling(1)
        provisioner.process(self.manifest)
        self.assertEqual(len(self.commands), 1)
        second = self.second_manifest()
        with self.assertRaisesRegex(ProvisioningError, "capacity_exceeded"):
            provisioner.process(second)
        self.assertEqual(len(self.commands), 1)
        self.assertFalse((self.home / "profiles" / second["profile"]).exists())
        # Nothing was written for the refused profile: no recovery journal that a later startup would have to explain.
        self.assertFalse((provisioner.state_root / (second["profile"] + ".json")).exists())
        self.assertIn('"code":"capacity_exceeded"', (provisioner.state_root / "audit.jsonl").read_text(encoding="utf-8"))

    def test_sync_and_a_resumed_provision_are_unaffected_by_the_ceiling(self):
        provisioner = self.provisioner_with_ceiling(1)
        provisioner.process(self.manifest)
        # The same provision job again (a retry) resumes its own profile.
        again = provisioner.process(self.manifest)
        self.assertEqual(again["profile"], self.manifest["profile"])
        self.assertEqual(len(self.commands), 1)
        sync = new_manifest(
            gatewayId=self.gateway_id,
            jobId=uid(),
            leaseToken=uid(),
            kind="sync",
            sourceProvisionJobId=self.manifest["jobId"],
            orgId=self.manifest["orgId"],
            agentId=self.manifest["agentId"],
            profile=self.manifest["profile"],
            configVersionId=uid(),
            configVersion=2,
        )
        result = provisioner.process(sync)
        self.assertTrue(result["ok"])
        self.assertNotIn("apiKey", result)
        self.assertEqual(len(self.commands), 1)

    def test_ceiling_counts_only_client_profiles_and_none_means_no_ceiling(self):
        (self.home / "profiles" / "default").mkdir()
        provisioner = self.provisioner_with_ceiling(1)
        self.assertEqual(provisioner.count_client_profiles(), 0)
        provisioner.process(self.manifest)
        self.assertEqual(provisioner.count_client_profiles(), 1)
        unlimited = self.provisioner_with_ceiling(None)
        unlimited.process(self.second_manifest())
        self.assertEqual(unlimited.count_client_profiles(), 2)

    def test_max_profiles_setting_accepts_only_a_positive_integer(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(_load_max_profiles())
        with patch.dict(os.environ, {"IACQUIRE_PROVISIONER_MAX_PROFILES": " "}, clear=True):
            self.assertIsNone(_load_max_profiles())
        with patch.dict(os.environ, {"IACQUIRE_PROVISIONER_MAX_PROFILES": "12"}, clear=True):
            self.assertEqual(_load_max_profiles(), 12)
        for bad in ("0", "-1", "abc", "1.5", "012", "1000000"):
            with patch.dict(os.environ, {"IACQUIRE_PROVISIONER_MAX_PROFILES": bad}, clear=True), self.assertRaisesRegex(ProvisioningError, "max_profiles_invalid"):
                _load_max_profiles()

    # --- --verify-home ------------------------------------------------------------------------------------------------------------------------------

    def clean_home_copy(self) -> Path:
        """A copy of a home that really went through a provision, so the checks run against what the worker writes."""
        self.provisioner.process(self.manifest)
        copy = Path(self.temp.name) / ("copy-" + uid())
        shutil.copytree(self.home, copy)
        return copy

    def test_verify_home_passes_a_clean_home(self):
        copy = self.clean_home_copy()
        report = verify_home(copy, self.gateway_id)
        self.assertEqual(report, {"ok": True, "profiles": 1, "orphanJournals": 0, "problems": {}})
        # An empty home is clean too.
        empty = Path(self.temp.name) / "empty"
        (empty / "profiles").mkdir(parents=True)
        self.assertEqual(verify_home(empty, self.gateway_id), {"ok": True, "profiles": 0, "orphanJournals": 0, "problems": {}})

    def test_verify_home_fails_for_an_agency_profile(self):
        copy = self.clean_home_copy()
        (copy / "profiles" / "operations-manager").mkdir()
        report = verify_home(copy, self.gateway_id)
        self.assertFalse(report["ok"])
        self.assertEqual(report["problems"], {"agency_profile_found": 1})
        # A c- name with no marker and no journal is not a client profile either.
        stray = self.clean_home_copy()
        (stray / "profiles" / "c-stray").mkdir()
        self.assertEqual(verify_home(stray, self.gateway_id)["problems"], {"agency_profile_found": 1})

    def test_verify_home_fails_for_a_missing_marker_or_another_gateways_marker(self):
        copy = self.clean_home_copy()
        marker = copy / "profiles" / self.manifest["profile"] / ".iacquire-provisioner.json"
        original = marker.read_text(encoding="utf-8")
        marker.unlink()
        report = verify_home(copy, self.gateway_id)
        self.assertFalse(report["ok"])
        self.assertEqual(report["problems"], {"profile_marker_missing": 1})
        marker.write_text(original, encoding="utf-8")
        self.assertTrue(verify_home(copy, self.gateway_id)["ok"])
        # The marker belongs to this gateway only.
        wrong = verify_home(copy, uid())
        self.assertFalse(wrong["ok"])
        self.assertIn("agency_profile_found", wrong["problems"])

    def test_verify_home_fails_for_a_bad_mode(self):
        copy = self.clean_home_copy()
        env_path = copy / "profiles" / self.manifest["profile"] / ".env"
        env_path.chmod(0o644)
        # Windows has no mode bits, so the check is switched on explicitly; on Linux it is always on.
        with patch.object(worker_module, "_ENFORCE_FILE_MODES", True):
            report = verify_home(copy, self.gateway_id)
        self.assertFalse(report["ok"])
        self.assertIn("profile_env_mode_invalid", report["problems"])

    def test_verify_home_fails_for_a_malformed_or_missing_key(self):
        copy = self.clean_home_copy()
        env_path = copy / "profiles" / self.manifest["profile"] / ".env"
        good = env_path.read_text(encoding="utf-8")
        for broken in ("API_SERVER_KEY=short\n", "API_SERVER_KEY=" + "G" * 64 + "\n", "NOTHING=here\n", good + good):
            env_path.write_text(broken, encoding="utf-8")
            if os.name != "nt":
                env_path.chmod(0o600)
            report = verify_home(copy, self.gateway_id)
            self.assertEqual(report["problems"], {"profile_key_invalid": 1}, broken)
        env_path.unlink()
        self.assertEqual(verify_home(copy, self.gateway_id)["problems"], {"profile_key_missing": 1})

    def test_verify_home_reports_orphan_journals_without_failing(self):
        copy = self.clean_home_copy()
        journal = json.loads((copy / "iacquire-provisioner-state" / (self.manifest["profile"] + ".json")).read_text(encoding="utf-8"))
        journal["profile"] = "c-gone-0123456789ab-lead-hunter"
        (copy / "iacquire-provisioner-state" / "c-gone-0123456789ab-lead-hunter.json").write_text(json.dumps(journal), encoding="utf-8")
        report = verify_home(copy, self.gateway_id)
        self.assertTrue(report["ok"])
        self.assertEqual(report["orphanJournals"], 1)

    def test_verify_home_command_prints_counts_and_codes_only_and_exits_zero_or_one(self):
        copy = self.clean_home_copy()
        api_key = (copy / "profiles" / self.manifest["profile"] / ".env").read_text(encoding="utf-8").split("=", 1)[1].strip()

        def run() -> tuple[int, str]:
            buffer = io.StringIO()
            with patch.dict(os.environ, {"HERMES_HOME": str(copy), "IACQUIRE_PROVISIONER_GATEWAY_ID": self.gateway_id}, clear=True), contextlib.redirect_stdout(buffer):
                code = _verify_home_command()
            return code, buffer.getvalue()

        code, output = run()
        self.assertEqual(code, 0)
        self.assertEqual(output.splitlines(), ["verify-home profiles=1 orphan_journals=0 problems=0", "verify-home result=ok"])
        (copy / "profiles" / "operations-manager").mkdir()
        (copy / "profiles" / self.manifest["profile"] / ".env").write_text("API_SERVER_KEY=short\n", encoding="utf-8")
        code, output = run()
        self.assertEqual(code, 1)
        self.assertEqual(
            output.splitlines(),
            [
                "verify-home profiles=1 orphan_journals=0 problems=2",
                "problem code=agency_profile_found count=1",
                "problem code=profile_key_invalid count=1",
                "verify-home result=failed",
            ],
        )
        for secret in (api_key, self.manifest["profile"], self.manifest["orgId"], self.manifest["soul"][:20], "operations-manager"):
            self.assertNotIn(secret, output)

    def test_verify_home_runs_from_the_command_line_and_does_not_modify_the_home(self):
        copy = self.clean_home_copy()

        def snapshot() -> dict[str, tuple[int, float]]:
            return {str(path.relative_to(copy)): (path.stat().st_size, path.stat().st_mtime) for path in sorted(copy.rglob("*"))}

        before = snapshot()
        env = {key: value for key, value in os.environ.items() if key in {"PATH", "SYSTEMROOT", "TEMP", "TMP"}}
        env.update({"HERMES_HOME": str(copy), "IACQUIRE_PROVISIONER_GATEWAY_ID": self.gateway_id, "PYTHONDONTWRITEBYTECODE": "1"})
        done = subprocess.run([sys.executable, "-B", str(Path(worker_module.__file__)), "--verify-home"], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("verify-home result=ok", done.stdout)
        self.assertEqual(snapshot(), before)
        (copy / "profiles" / "operations-manager").mkdir()
        done = subprocess.run([sys.executable, "-B", str(Path(worker_module.__file__)), "--verify-home"], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 1)
        self.assertIn("problem code=agency_profile_found count=1", done.stdout)



class KeyAwareHermesApi(FakeHermesApi):
    """A gateway that authenticates each profile the way the real one does: it holds the key it last read from the profile's .env and answers any other key with a 401.

    `reread_after` is how many requests pass, after the file changed, before the gateway reads it again: 0 reads at once, None never reads it again (a gateway that never picks up a
    rotated key, so the old one stays valid for ever).
    """

    def __init__(self, home: Path, reread_after: int | None = 0):
        super().__init__(home)
        self.reread_after = reread_after
        self.held: dict[str, str] = {}
        self.stale_requests: dict[str, int] = {}

    def _file_key(self, profile: str) -> str:
        env = self.home / "profiles" / profile / ".env"
        if not env.exists():
            return ""
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("API_SERVER_KEY="):
                return line.partition("=")[2]
        return ""

    def json_request(self, profile, key, path, method="GET", body=None, extra_headers=None):
        if profile != "default":
            on_disk = self._file_key(profile)
            if profile not in self.held:
                self.held[profile] = on_disk
            elif on_disk != self.held[profile] and self.reread_after is not None:
                stale = self.stale_requests.get(profile, 0)
                if stale >= self.reread_after:
                    self.held[profile] = on_disk
                    self.stale_requests[profile] = 0
                else:
                    self.stale_requests[profile] = stale + 1
            if key != self.held[profile]:
                self.paths.append(path)
                return 401, {"error": "unauthorized"}
        return super().json_request(profile, key, path, method, body, extra_headers)


class RevokeTests(unittest.TestCase):
    """Containment of a client profile: the key is replaced and the tools are switched off, and the worker proves both through the gateway. Nothing is deleted."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        (self.home / "profiles").mkdir(parents=True)
        self.gateway_id = uid()
        self.manifest = new_manifest(gatewayId=self.gateway_id)
        self.api = KeyAwareHermesApi(self.home)
        self.api.expected_challenge = self.manifest["soulChallenge"]

        def run_command(args, **kwargs):
            profile = self.home / "profiles" / args[3]
            profile.mkdir(mode=0o700)
            (profile / "config.yaml").write_text("model:\n  provider: deepseek\n  name: approved-model\n", encoding="utf-8")
            (profile / ".env").write_text("API_SERVER_KEY=shared-placeholder\n", encoding="utf-8")
            return subprocess.CompletedProcess(args, 0, "", "")

        self.provisioner = RestrictedProvisioner(
            home=self.home,
            hermes_cli=Path("/opt/hermes/bin/hermes"),
            api=self.api,
            gateway_id=self.gateway_id,
            hermes_version="hermes v0.21.5-test",
            run_command=run_command,
        )
        self.profile_dir = self.home / "profiles" / self.manifest["profile"]
        self.state_dir = self.home / "iacquire-provisioner-state"
        self.state_file = self.state_dir / (self.manifest["profile"] + ".revoke.json")
        self.old_key = self.provisioner.process(self.manifest)["apiKey"]

    def revoke_manifest(self, **updates: Any) -> dict[str, Any]:
        manifest = {
            "jobId": uid(),
            "leaseToken": uid(),
            "gatewayId": self.gateway_id,
            "kind": "deprovision",
            "orgId": self.manifest["orgId"],
            "agentId": self.manifest["agentId"],
            "profile": self.manifest["profile"],
            "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        }
        manifest.update(updates)
        return manifest

    def env_key(self) -> str:
        return (self.profile_dir / ".env").read_text(encoding="utf-8").split("API_SERVER_KEY=", 1)[1].strip()

    def marker(self) -> dict[str, Any]:
        return json.loads((self.profile_dir / ".iacquire-provisioner.json").read_text(encoding="utf-8"))

    def audit_text(self) -> str:
        return (self.state_dir / "audit.jsonl").read_text(encoding="utf-8")

    def quick_waits(self, timeout: float = 90):
        """No real sleeping: the retry interval is zero, and a test of a gateway that never applies the change shortens the whole wait to a blink."""
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(worker_module, "PROFILE_CONFIG_SYNC_RETRY_INTERVAL_SECONDS", 0))
        stack.enter_context(patch.object(worker_module, "PROFILE_CONFIG_SYNC_TIMEOUT_SECONDS", timeout))
        self.addCleanup(stack.close)

    def test_a_containment_request_replaces_the_key_switches_the_tools_off_and_proves_both(self):
        self.quick_waits()
        request = self.revoke_manifest()
        result = self.provisioner.process(request)
        new_key = self.env_key()

        self.assertEqual(set(result), {"ok", "jobId", "leaseToken", "gatewayId", "kind", "orgId", "agentId", "profile", "revoked", "oldKeyRejected", "toolsetsEmpty", "retiredAt", "hermesVersion"})
        self.assertEqual((result["ok"], result["kind"], result["revoked"], result["oldKeyRejected"], result["toolsetsEmpty"]), (True, "deprovision", True, True, True))
        self.assertEqual((result["jobId"], result["orgId"], result["agentId"], result["profile"]), (request["jobId"], request["orgId"], request["agentId"], request["profile"]))
        # The old key is gone from the profile, the new one is random and well formed, and neither is ever returned or logged.
        self.assertNotEqual(new_key, self.old_key)
        self.assertRegex(new_key, r"^[0-9a-f]{64}$")
        self.assertEqual((self.profile_dir / ".env").read_text(encoding="utf-8"), "API_SERVER_KEY=" + new_key + "\n")
        for secret in (self.old_key, new_key):
            self.assertNotIn(secret, json.dumps(result))
            self.assertNotIn(secret, self.audit_text())
            self.assertNotIn(secret, json.dumps(self.marker()))
        # The gateway now refuses the old key and shows no tool.
        self.assertEqual(self.api.json_request(self.manifest["profile"], self.old_key, "/v1/capabilities")[0], 401)
        status, toolsets = self.api.json_request(self.manifest["profile"], new_key, "/v1/toolsets")
        self.assertEqual((status, [row for row in toolsets if row["enabled"] and row["tools"]]), (200, []))
        self.assertEqual(yaml.safe_load((self.profile_dir / "config.yaml").read_text(encoding="utf-8"))["platform_toolsets"]["api_server"], ["no_mcp"])
        # Containment, not deletion: the profile, its SOUL and its ownership marker stay, and the retired key's private copy is removed.
        self.assertTrue((self.profile_dir / "SOUL.md").is_file())
        marker = self.marker()
        self.assertEqual((marker["orgId"], marker["agentId"], marker["profile"], marker["gatewayId"]), (self.manifest["orgId"], self.manifest["agentId"], self.manifest["profile"], self.gateway_id))
        self.assertEqual((type(marker["retiredAt"]), marker["oldKeyRejected"], marker["lastJobId"]), (int, True, request["jobId"]))
        self.assertFalse(self.state_file.exists())
        record = json.loads(self.audit_text().splitlines()[-1])
        self.assertEqual((record["kind"], record["outcome"], record["jobId"], record["profile"]), ("deprovision", "succeeded", request["jobId"], request["profile"]))
        self.assertNotIn("soul", json.dumps(record))
        self.assertTrue(verify_home(self.home, self.gateway_id)["ok"])

    def test_containing_a_contained_profile_reports_the_same_success_without_rotating_again(self):
        self.quick_waits()
        first = self.provisioner.process(self.revoke_manifest())
        key_after_first = self.env_key()
        second = self.provisioner.process(self.revoke_manifest())
        self.assertEqual(self.env_key(), key_after_first)
        self.assertEqual(second["retiredAt"], first["retiredAt"])
        self.assertEqual((second["revoked"], second["oldKeyRejected"], second["toolsetsEmpty"]), (True, True, True))
        self.assertFalse(self.state_file.exists())

    def test_a_slow_gateway_is_waited_for(self):
        self.quick_waits()
        self.api.reread_after = 4
        result = self.provisioner.process(self.revoke_manifest())
        self.assertTrue(result["oldKeyRejected"])
        self.assertEqual(self.api.json_request(self.manifest["profile"], self.old_key, "/v1/capabilities")[0], 401)

    def test_a_gateway_that_never_picks_up_the_new_key_never_gets_a_success_and_a_retry_finishes_the_job(self):
        self.quick_waits(timeout=0.05)
        self.api.reread_after = None
        request = self.revoke_manifest()
        with self.assertRaises(ProvisioningError) as caught:
            self.provisioner.process(request)
        self.assertEqual(caught.exception.code, "revoke_not_applied")
        # The old key still works at the gateway, so nothing was retired: no marker flag, and the old key's private copy is kept so the retry can prove it is dead.
        self.assertNotIn("retiredAt", self.marker())
        self.assertEqual(json.loads(self.state_file.read_text(encoding="utf-8"))["oldKey"], self.old_key)
        self.assertEqual(json.loads(self.audit_text().splitlines()[-1])["code"], "revoke_not_applied")
        self.assertNotIn(self.old_key, self.audit_text())
        rotated = self.env_key()
        self.assertNotEqual(rotated, self.old_key)
        # The gateway recovers; the same job is retried and completes using the kept key, without rotating a second time.
        self.api.reread_after = 0
        self.api.stale_requests.clear()
        with patch.object(worker_module, "PROFILE_CONFIG_SYNC_TIMEOUT_SECONDS", 90):
            result = self.provisioner.process(request)
        self.assertTrue(result["oldKeyRejected"])
        self.assertEqual(self.env_key(), rotated)
        self.assertFalse(self.state_file.exists())
        self.assertEqual(self.marker()["oldKeyRejected"], True)

    def test_tools_that_stay_enabled_are_never_reported_as_contained(self):
        self.quick_waits(timeout=0.05)
        # The gateway keeps serving the previous, full policy however long it is asked: the tools are never seen to be off.
        self.api.canary_policy_pending_reads = 10**9
        with self.assertRaises(ProvisioningError) as caught:
            self.provisioner.process(self.revoke_manifest())
        self.assertEqual(caught.exception.code, "revoke_not_applied")
        self.assertNotIn("retiredAt", self.marker())

    def test_a_profile_the_worker_does_not_own_is_refused_and_nothing_is_written(self):
        self.quick_waits()
        marker_path = self.profile_dir / ".iacquire-provisioner.json"
        original = marker_path.read_text(encoding="utf-8")
        before = self.env_key()

        def refused(request: dict[str, Any], code: str) -> None:
            with self.assertRaises(ProvisioningError) as caught:
                self.provisioner.process(request)
            self.assertEqual(caught.exception.code, code)
            self.assertEqual(self.env_key(), before)
            self.assertFalse(self.state_file.exists())

        # Another client's employee, another employee of the same client, another gateway in the marker.
        refused(self.revoke_manifest(orgId=uid()), "profile_ownership_conflict")
        refused(self.revoke_manifest(agentId=uid()), "profile_ownership_conflict")
        changed = json.loads(original)
        changed["gatewayId"] = uid()
        marker_path.write_text(json.dumps(changed), encoding="utf-8")
        refused(self.revoke_manifest(), "profile_ownership_conflict")
        changed = json.loads(original)
        changed["sourceProvisionJobId"] = "not-a-uuid"
        marker_path.write_text(json.dumps(changed), encoding="utf-8")
        refused(self.revoke_manifest(), "profile_ownership_conflict")
        # No marker at all, and a profile that does not exist.
        marker_path.unlink()
        refused(self.revoke_manifest(), "profile_ownership_missing")
        marker_path.write_text(original, encoding="utf-8")
        refused(self.revoke_manifest(profile="c-other-tenant-0123456789ab-crm-manager"), "profile_ownership_missing")

    def test_a_containment_request_is_exactly_the_eight_keys(self):
        for bad in (
            self.revoke_manifest(soul="a SOUL has no place in a containment request"),
            self.revoke_manifest(configYaml="platform_toolsets: {}"),
            {key: value for key, value in self.revoke_manifest().items() if key != "orgId"},
            self.revoke_manifest(gatewayId=uid()),
            self.revoke_manifest(profile="iacquire-lead-hunter"),
            self.revoke_manifest(jobId="not-a-uuid"),
            new_manifest(kind="deprovision", gatewayId=self.gateway_id),
        ):
            with self.assertRaises(ProvisioningError) as caught:
                self.provisioner.process(bad)
            self.assertEqual(caught.exception.code, "invalid_manifest")
        with self.assertRaises(ProvisioningError) as caught:
            self.provisioner.process(self.revoke_manifest(expiresAt=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()))
        self.assertEqual(caught.exception.code, "lease_expired")
        self.assertEqual(self.env_key(), self.old_key)
        self.assertIsInstance(parse_manifest(self.revoke_manifest(), self.gateway_id), worker_module.RevokeManifest)

    def test_a_profile_with_no_usable_key_cannot_be_proven_contained(self):
        self.quick_waits()
        (self.profile_dir / ".env").write_text("API_SERVER_KEY=not-a-real-key\n", encoding="utf-8")
        with self.assertRaises(ProvisioningError) as caught:
            self.provisioner.process(self.revoke_manifest())
        self.assertEqual(caught.exception.code, "profile_key_missing")
        self.assertFalse(self.state_file.exists())


BUSINESS_URL = "https://portal.example.test/api/internal/hermes-business/client/mcp"
BUSINESS_TOOLSET = "mcp-iacquire_business"
BUSINESS_TOOLS = ["mcp_iacquire_business_find_contacts", "mcp_iacquire_business_get_contact", "mcp_iacquire_business_get_role_workspace_context"]


def business_policy(url: str = BUSINESS_URL, toolsets: list[str] | None = None) -> str:
    """The configuration the portal sends for a workspace in the client business tool tier: the role's toolsets and the business toolset instead of no_mcp, and the one reviewed server."""
    listed = "\n".join(f"    - {name}" for name in [*(toolsets if toolsets is not None else ALL_TOOLSETS), BUSINESS_TOOLSET])
    shared = "\n".join(f"    - {name}" for name in [*ALL_TOOLSETS, "no_mcp"])
    base = POLICY.replace(shared, listed)
    return base + f"mcp_servers:\n  iacquire_business:\n    url: {url}\n    headers:\n      Authorization: \"Bearer ${{IACQUIRE_BUSINESS_MCP_TOKEN}}\"\n    tool_timeout: 12\n"


class McpHermesApi(KeyAwareHermesApi):
    """A gateway that also serves the business MCP server, for a profile whose configuration names the business toolset. Its catalog is rebuilt the way the worker verifies it (the same
    canonical form, signed with the profile's key), with the business tools as `mcp` provenance rows."""

    def __init__(self, home: Path, tools: list[str] | None = None):
        super().__init__(home)
        self.served = list(BUSINESS_TOOLS if tools is None else tools)

    def configured(self, profile: str) -> list[str]:
        config = self.home / "profiles" / profile / "config.yaml"
        value = yaml.safe_load(config.read_text(encoding="utf-8")) if config.exists() else {}
        return [name for name in (value or {}).get("platform_toolsets", {}).get("api_server", []) if name != "no_mcp"]

    def json_request(self, profile, key, path, method="GET", body=None, extra_headers=None):
        names = self.configured(profile) if profile != "default" else []
        if BUSINESS_TOOLSET not in names or not (path == "/v1/toolsets" or path.startswith("/v1/tools?platform=api_server")):
            return super().json_request(profile, key, path, method, body, extra_headers)
        status, _ = super().json_request(profile, key, "/v1/capabilities")
        if status != 200:
            return status, {"error": "unavailable"}
        standard = [name for name in ALL_TOOLSETS if name in names]
        if path == "/v1/toolsets":
            rows = [{"name": name, "enabled": True, "tools": sorted(tool for tool, _ in TOOLS_IN[name])} for name in standard]
            return 200, [*rows, {"name": BUSINESS_TOOLSET, "enabled": True, "tools": list(self.served)}]
        challenge = (extra_headers or {}).get("X-Hermes-Inventory-Challenge", "")
        entries = [(tool, toolset, "configurable", None) for toolset in standard for tool, _ in TOOLS_IN[toolset]]
        entries += [(tool, BUSINESS_TOOLSET, "mcp", "iacquire_business") for tool in self.served]
        enabled = sorted([*standard, BUSINESS_TOOLSET])
        canonical = {
            "contract": "hermes.api_server.tool_catalog.v1", "profile": profile, "platform": "api_server", "explicitConfigPresent": True, "enabledToolsets": enabled,
            "tools": sorted(
                [{"name": n, "source": src, "toolset": ts, "sourceServer": server, "addedBelowExplicitConfig": False, "available": True} for n, ts, src, server in entries],
                key=lambda row: row["name"],
            ),
        }
        catalog_digest = digest(json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode())
        signed = json.dumps({"contract": "hermes.api_server.tool_catalog.v1", "profile": profile, "challenge": challenge, "digest": catalog_digest}, separators=(",", ":")).encode()
        signature = base64.urlsafe_b64encode(hmac.new(key.encode(), signed, hashlib.sha256).digest()).decode().rstrip("=")
        return 200, {
            "object": "list", "platform": "api_server", "explicit_config_present": True, "enabled_toolsets": enabled,
            "data": [
                {"name": n, "parameters": {}, "available": True, "provenance": {"source": src, "toolset": ts, "requested_toolsets": [ts], "source_server": server, "added_below_explicit_config": False}}
                for n, ts, src, server in entries
            ],
            "contract": "hermes.api_server.tool_catalog.v1", "complete": True, "challenge": challenge, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
            "attestation": {"algorithm": "hmac-sha256", "signature": signature, "key_id": "profile-key"},
        }


class BusinessToolDeliveryTests(unittest.TestCase):
    """The client business tool tier on the worker: the credential is made on this host, written once into the profile's own environment file, never printed or returned, and only its
    hash goes back to the portal. Only a synchronization may carry the tier, only at the URL the worker pinned itself, and the profile must show exactly the reviewed tools."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        (self.home / "profiles").mkdir(parents=True)
        self.gateway_id = uid()
        self.manifest = new_manifest(gatewayId=self.gateway_id)
        self.api = McpHermesApi(self.home)
        self.api.expected_challenge = self.manifest["soulChallenge"]

        def run_command(args, **kwargs):
            profile = self.home / "profiles" / args[3]
            profile.mkdir(mode=0o700)
            (profile / "config.yaml").write_text("model:\n  provider: deepseek\n  name: approved-model\n", encoding="utf-8")
            (profile / ".env").write_text("API_SERVER_KEY=shared-placeholder\n", encoding="utf-8")
            return subprocess.CompletedProcess(args, 0, "", "")

        self.run_command = run_command
        self.provisioner = self.make_provisioner(BUSINESS_URL)
        self.profile_dir = self.home / "profiles" / self.manifest["profile"]
        self.state_dir = self.home / "iacquire-provisioner-state"
        self.api_key = self.provisioner.process(self.manifest)["apiKey"]

    def make_provisioner(self, url: str | None) -> RestrictedProvisioner:
        return RestrictedProvisioner(
            home=self.home, hermes_cli=Path("/opt/hermes/bin/hermes"), api=self.api, gateway_id=self.gateway_id, hermes_version="hermes v0.21.5-test",
            run_command=self.run_command, business_mcp_url=url,
        )

    def sync(self, **updates: Any) -> dict[str, Any]:
        config = updates.pop("configYaml", business_policy())
        manifest = new_manifest(
            gatewayId=self.gateway_id, kind="sync", orgId=self.manifest["orgId"], agentId=self.manifest["agentId"], profile=self.manifest["profile"],
            sourceProvisionJobId=self.manifest["jobId"], soulChallenge=self.manifest["soulChallenge"], soul=self.manifest["soul"], soulSha256=self.manifest["soulSha256"],
            configYaml=config, policyConfigSha256=digest(config.encode()),
            businessCredentialId=uid(), businessTools=list(BUSINESS_TOOLS),
        )
        manifest.update(updates)
        return manifest

    def token(self) -> tuple[str, str] | None:
        lines = (self.profile_dir / ".env").read_text(encoding="utf-8").splitlines()
        values = [line.partition("=")[2] for line in lines if line.startswith("IACQUIRE_BUSINESS_MCP_TOKEN=")]
        if not values:
            return None
        match = re.fullmatch(r"iamcpc1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})", values[0])
        self.assertIsNotNone(match, "the token must have the credential's shape")
        return match.group(1), match.group(2)

    def audit(self) -> str:
        return (self.state_dir / "audit.jsonl").read_text(encoding="utf-8")

    def test_a_synchronization_writes_the_credential_once_and_returns_only_its_hash(self):
        request = self.sync()
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            result = self.provisioner.process(request)
        written = self.token()
        self.assertEqual(written[0], request["businessCredentialId"])
        self.assertEqual(result["businessCredentialSha256"], hashlib.sha256(written[1].encode()).hexdigest())
        self.assertNotIn("apiKey", result)
        # The secret exists on this host only: in the profile's own environment file, not in the result, the audit log, the ownership marker or anything printed.
        for place, text in (("result", json.dumps(result)), ("audit", self.audit()), ("marker", (self.profile_dir / ".iacquire-provisioner.json").read_text(encoding="utf-8")), ("output", captured.getvalue())):
            self.assertNotIn(written[1], text, place)
        self.assertIn(request["businessCredentialId"], self.audit())
        env_lines = (self.profile_dir / ".env").read_text(encoding="utf-8").splitlines()
        self.assertEqual(env_lines[0], "API_SERVER_KEY=" + self.api_key)
        config = yaml.safe_load((self.profile_dir / "config.yaml").read_text(encoding="utf-8"))
        self.assertEqual(config["mcp_servers"], {"iacquire_business": {"url": BUSINESS_URL, "headers": {"Authorization": "Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}"}, "tool_timeout": 12}})
        self.assertIn(BUSINESS_TOOLSET, config["platform_toolsets"]["api_server"])
        self.assertNotIn("no_mcp", config["platform_toolsets"]["api_server"])
        if os.name != "nt":
            self.assertEqual((self.profile_dir / ".env").stat().st_mode & 0o777, 0o600)

    def test_a_retry_with_the_same_credential_id_keeps_the_same_secret_and_a_new_id_makes_a_new_one(self):
        request = self.sync()
        first = self.provisioner.process(request)
        before = self.token()
        again = self.provisioner.process(self.sync(businessCredentialId=request["businessCredentialId"]))
        self.assertEqual(self.token(), before)
        self.assertEqual(again["businessCredentialSha256"], first["businessCredentialSha256"])
        rotated_request = self.sync()
        rotated = self.provisioner.process(rotated_request)
        after = self.token()
        self.assertEqual(after[0], rotated_request["businessCredentialId"])
        self.assertNotEqual(after[1], before[1])
        self.assertNotEqual(rotated["businessCredentialSha256"], first["businessCredentialSha256"])
        self.assertNotIn(before[1], (self.profile_dir / ".env").read_text(encoding="utf-8"))
        self.assertNotIn(before[1], self.audit())

    def test_a_synchronization_that_switches_the_tier_off_removes_the_credential_and_the_server(self):
        self.provisioner.process(self.sync())
        self.assertIsNotNone(self.token())
        plain = self.sync(configYaml=POLICY)
        for key in ("businessCredentialId", "businessTools"):
            plain.pop(key)
        result = self.provisioner.process(plain)
        self.assertIsNone(self.token())
        self.assertNotIn("businessCredentialSha256", result)
        self.assertNotIn("mcp_servers", yaml.safe_load((self.profile_dir / "config.yaml").read_text(encoding="utf-8")))

    def test_what_the_worker_refuses_it_refuses_before_writing_anything(self):
        env_before = (self.profile_dir / ".env").read_text(encoding="utf-8")
        config_before = (self.profile_dir / "config.yaml").read_text(encoding="utf-8")

        def refused(request: dict[str, Any], code: str, provisioner: RestrictedProvisioner | None = None) -> None:
            with self.assertRaises(ProvisioningError) as caught:
                (provisioner or self.provisioner).process(request)
            self.assertEqual(caught.exception.code, code)
            self.assertEqual((self.profile_dir / ".env").read_text(encoding="utf-8"), env_before)
            self.assertEqual((self.profile_dir / "config.yaml").read_text(encoding="utf-8"), config_before)

        refused(self.sync(configYaml=business_policy(url="https://elsewhere.example.test/mcp")), "invalid_policy_config")
        refused(self.sync(configYaml=business_policy().replace("tool_timeout: 12", "tool_timeout: 12\n  second_server:\n    url: https://other.example.test/mcp")), "invalid_policy_config")
        refused(self.sync(configYaml=business_policy().replace('Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}', "Bearer literal-token-value")), "invalid_policy_config")
        refused(self.sync(configYaml=business_policy(toolsets=["memory", "browser"])), "invalid_policy_config")
        # The worker's own pinned URL decides, so a worker that has none refuses the tier altogether.
        refused(self.sync(), "business_tools_not_enabled", self.make_provisioner(None))
        # The policy and the manifest must agree, the keys travel together, only on a synchronization, and the names are shaped like the runtime's.
        mismatched = self.sync()
        mismatched.pop("businessCredentialId")
        mismatched.pop("businessTools")
        refused(mismatched, "invalid_manifest")
        refused(self.sync(configYaml=POLICY), "invalid_manifest")
        lone = self.sync()
        lone.pop("businessTools")
        refused(lone, "invalid_manifest")
        refused(self.sync(kind="provision", sourceProvisionJobId=None), "invalid_manifest")
        refused(self.sync(businessTools=["Not A Tool"]), "invalid_manifest")
        refused(self.sync(businessTools=[]), "invalid_manifest")
        refused(self.sync(businessCredentialId="not-a-uuid"), "invalid_manifest")

    def test_the_profile_must_show_exactly_the_reviewed_business_tools(self):
        for served, why in (
            (BUSINESS_TOOLS + ["mcp_iacquire_business_delete_everything"], "an extra tool"),
            (BUSINESS_TOOLS[:-1], "a missing tool"),
        ):
            self.api.served = served
            with self.assertRaises(ProvisioningError, msg=why) as caught:
                self.provisioner.process(self.sync())
            self.assertIn(caught.exception.code, {"runtime_tool_inventory_incomplete", "runtime_tool_policy_unverified"}, why)

    def test_a_manifest_without_the_business_tier_is_exactly_what_it_always_was(self):
        plain = self.sync(configYaml=POLICY)
        for key in ("businessCredentialId", "businessTools"):
            plain.pop(key)
        result = self.provisioner.process(plain)
        self.assertNotIn("businessCredentialSha256", result)
        self.assertIsNone(self.token())


class FakeClock:
    """Epoch seconds that only move when the loop sleeps, so retry timing is exact and no test waits."""

    def __init__(self):
        self.now = datetime.now(timezone.utc).timestamp()
        self.sleeps: list[float] = []
        self.on_sleep: Any = None

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds
        if self.on_sleep is not None:
            self.on_sleep(len(self.sleeps))


class FakePortal:
    """Scripted portal: each path has a list of answers (status, body) or an exception to raise; the last answer repeats."""

    def __init__(self, claim: list[Any], complete: list[Any] | None = None):
        self.answers = {"/claim": list(claim), "/complete": list(complete or [(200, {"ok": True})])}
        self.calls: list[tuple[str, dict[str, Any] | None]] = []
        self.headers_seen: list[dict[str, str]] = []
        # A loop that regresses into spinning must fail its assertions, not hang the suite: past this many calls the loop is told to stop.
        self.stop: Any = None

    def request(self, url: str, method: str, headers: dict[str, str], body: dict[str, Any] | None = None):
        path = "/" + url.rsplit("/", 1)[1]
        self.calls.append((path, body))
        self.headers_seen.append(headers)
        if len(self.calls) > 60 and self.stop is not None:
            self.stop.set()
        queue = self.answers[path]
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def paths(self) -> list[str]:
        return [path for path, _ in self.calls]


class FakeProvisioner:
    def __init__(self, outcomes: list[Any] | None = None):
        self.outcomes = list(outcomes or [])
        self.processed: list[Any] = []
        self.streak = 0
        self.on_process: Any = None

    def process(self, manifest: Any) -> dict[str, Any]:
        self.processed.append(manifest)
        if self.on_process is not None:
            self.on_process()
        outcome = self.outcomes.pop(0) if self.outcomes else {"ok": True, "jobId": manifest["jobId"]}
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def hermes_unreachable_streak(self) -> int:
        return self.streak


class ProbingProvisioner(FakeProvisioner):
    """A provisioner that can ask the Hermes loopback whether it answers: `gone` makes every probe fail, the way a stale network namespace does."""

    def __init__(self, gone: bool):
        super().__init__()
        self.gone = gone
        self.probes = 0

    def probe_hermes(self) -> None:
        self.probes += 1
        self.streak = self.streak + 1 if self.gone else 0


GATEWAY = "11111111-1111-4111-8111-111111111111"


def job_manifest(clock: FakeClock, **updates: Any) -> dict[str, Any]:
    manifest = {
        "jobId": uid(),
        "leaseToken": uid(),
        "gatewayId": GATEWAY,
        "kind": "provision",
        "orgId": uid(),
        "agentId": uid(),
        "profile": "c-secret-tenant-name-0123456789ab",
        "role": "lead_hunter",
        "soul": "SECRET-SOUL-TEXT do not print",
        "configYaml": "SECRET-CONFIG-TEXT",
        "expiresAt": datetime.fromtimestamp(clock.now + 600, timezone.utc).isoformat(),
    }
    manifest.update(updates)
    return manifest


class WorkerLoopTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.stop = threading.Event()
        self.lines: list[str] = []
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state_root = Path(self.temp.name) / "state"
        self.state_root.mkdir(mode=0o700)
        self.heartbeat = Heartbeat(self.state_root, self.clock)

    def loop(self, portal: FakePortal, provisioner: FakeProvisioner | None = None) -> WorkerLoop:
        self.portal = portal
        portal.stop = self.stop
        self.provisioner = provisioner or FakeProvisioner()
        return WorkerLoop(
            portal,
            self.provisioner,
            self.clock,
            self.clock.sleep,
            self.stop,
            base="https://portal.example.invalid/api/internal/hermes-provisioner",
            headers={"Authorization": "Bearer test-token"},
            gateway_id=GATEWAY,
            heartbeat=self.heartbeat,
            out=self.lines.append,
        )

    def stop_after_sleeps(self, count: int) -> None:
        self.clock.on_sleep = lambda n: self.stop.set() if n >= count else None

    def beat(self) -> dict[str, Any]:
        return json.loads((self.state_root / "heartbeat.json").read_text(encoding="ascii"))

    def test_an_empty_queue_sleeps_five_seconds_and_stays_idle(self):
        self.stop_after_sleeps(2)
        code = self.loop(FakePortal([(200, {"job": None})])).run()
        self.assertEqual(code, 0)
        self.assertEqual(self.clock.sleeps, [5, 5])
        self.assertEqual(self.portal.paths(), ["/claim", "/claim"])
        self.assertEqual(self.portal.calls[0][1], {"gatewayId": GATEWAY})
        self.assertEqual(self.provisioner.processed, [])
        self.assertEqual(self.beat()["state"], "stopping")

    def test_a_failing_claim_sleeps_ten_seconds_and_the_heartbeat_says_portal_unreachable(self):
        states: list[str] = []
        self.clock.on_sleep = lambda n: (states.append(self.beat()["state"]), self.stop.set() if n >= 2 else None)
        self.loop(FakePortal([(503, {"error": "The restricted Hermes provisioner could not be reached."}), ProvisioningError("http_unavailable")])).run()
        self.assertEqual(self.clock.sleeps, [10, 10])
        self.assertEqual(states, ["portal_unreachable", "portal_unreachable"])
        self.assertEqual(self.provisioner.processed, [])

    def test_a_portal_that_is_switched_off_counts_as_healthy_and_idle(self):
        states: list[tuple[str, int | None]] = []
        start = self.clock.now
        self.clock.on_sleep = lambda n: (states.append((self.beat()["state"], self.beat()["lastClaimOkAt"])), self.stop.set())
        self.loop(FakePortal([(503, {"error": "The restricted Hermes provisioner is not enabled."})])).run()
        self.assertEqual(states, [("portal_disabled", int(start))])
        self.assertEqual(self.clock.sleeps, [10])

    def test_a_success_posts_exactly_once_and_prints_one_code_only_line(self):
        manifest = job_manifest(self.clock)
        result = {"ok": True, "jobId": manifest["jobId"], "leaseToken": manifest["leaseToken"], "apiKey": "a" * 64}
        start = self.clock.now
        self.stop_after_sleeps(1)
        loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})], [(200, {"ok": True})]), FakeProvisioner([result]))
        loop.run()
        self.assertEqual(self.portal.paths(), ["/claim", "/complete", "/claim"])
        self.assertEqual(self.portal.calls[1][1], result)
        self.assertEqual(self.provisioner.processed, [manifest])
        self.assertEqual(self.lines, [f"job={manifest['jobId']} kind=provision outcome=succeeded code=- delivery=delivered attempts=1"])
        self.assertEqual(self.beat()["lastJobAt"], int(start))

    def test_a_containment_job_is_delivered_like_any_other_and_logged_by_kind_only(self):
        manifest = {
            "jobId": uid(), "leaseToken": uid(), "gatewayId": GATEWAY, "kind": "deprovision", "orgId": uid(), "agentId": uid(),
            "profile": "c-secret-tenant-name-0123456789ab", "expiresAt": datetime.fromtimestamp(self.clock.now + 600, timezone.utc).isoformat(),
        }
        result = {"ok": True, "jobId": manifest["jobId"], "leaseToken": manifest["leaseToken"], "kind": "deprovision", "revoked": True}
        self.stop_after_sleeps(1)
        self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})], [(200, {"ok": True})]), FakeProvisioner([result])).run()
        self.assertEqual(self.portal.paths(), ["/claim", "/complete", "/claim"])
        self.assertEqual(self.portal.calls[1][1], result)
        self.assertEqual(self.lines, [f"job={manifest['jobId']} kind=deprovision outcome=succeeded code=- delivery=delivered attempts=1"])
        self.assertNotIn("secret-tenant-name", "".join(self.lines))

    def test_two_503_completions_then_200_deliver_one_result_in_three_attempts(self):
        manifest = job_manifest(self.clock)
        result = {"ok": True, "jobId": manifest["jobId"]}
        self.stop_after_sleeps(3)
        loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})], [(503, None), ProvisioningError("http_unavailable"), (200, {"ok": True})]), FakeProvisioner([result]))
        loop.run()
        completes = [body for path, body in self.portal.calls if path == "/complete"]
        self.assertEqual(completes, [result, result, result])
        self.assertEqual(self.clock.sleeps[:3], [2, 4, 5])
        self.assertEqual(len(self.provisioner.processed), 1)
        self.assertEqual(self.lines, [f"job={manifest['jobId']} kind=provision outcome=succeeded code=- delivery=delivered attempts=3"])

    def test_delivery_gives_up_after_five_attempts_with_two_four_eight_sixteen_second_waits(self):
        manifest = job_manifest(self.clock)
        self.stop_after_sleeps(5)
        loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})], [(503, None)]), FakeProvisioner([{"ok": True, "jobId": manifest["jobId"]}]))
        loop.run()
        self.assertEqual(self.portal.paths().count("/complete"), 5)
        self.assertEqual(self.clock.sleeps[:4], [2, 4, 8, 16])
        self.assertEqual(self.lines, [f"job={manifest['jobId']} kind=provision outcome=succeeded code=- delivery=undelivered attempts=5"])

    def test_delivery_stops_retrying_when_the_lease_has_run_out(self):
        manifest = job_manifest(self.clock)
        manifest["expiresAt"] = datetime.fromtimestamp(self.clock.now + 5, timezone.utc).isoformat()
        self.stop_after_sleeps(3)
        loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})], [(503, None)]), FakeProvisioner([{"ok": True, "jobId": manifest["jobId"]}]))
        loop.run()
        # Attempt 1 fails, wait 2 s (lease still valid), attempt 2 fails, wait 4 s (lease now over): no third attempt.
        self.assertEqual(self.portal.paths().count("/complete"), 2)
        self.assertIn("delivery=undelivered attempts=2", self.lines[0])

    def test_a_409_is_dropped_without_a_retry(self):
        manifest = job_manifest(self.clock)
        self.stop_after_sleeps(1)
        loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})], [(409, {"error": "lease"})]), FakeProvisioner([{"ok": True, "jobId": manifest["jobId"]}]))
        code = loop.run()
        self.assertEqual(code, 0)
        self.assertEqual(self.portal.paths().count("/complete"), 1)
        self.assertEqual(self.lines, [f"job={manifest['jobId']} kind=provision outcome=succeeded code=- delivery=dropped attempts=1"])

    def test_a_completion_is_retried_for_the_answers_a_repeat_could_change_and_dropped_for_the_rest(self):
        for status in (408, 425, 429, 500, 502, 503):
            with self.subTest(retried=status):
                self.lines.clear()
                self.stop.clear()
                self.clock.sleeps.clear()
                self.clock.on_sleep = None
                manifest = job_manifest(self.clock)
                self.stop_after_sleeps(5)
                self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})], [(status, None)]), FakeProvisioner([{"ok": True, "jobId": manifest["jobId"]}])).run()
                self.assertEqual(self.portal.paths().count("/complete"), 5)
                self.assertEqual(self.clock.sleeps[:4], [2, 4, 8, 16])
                self.assertIn("delivery=undelivered attempts=5", self.lines[0])
        for status in (400, 404, 410, 422):
            with self.subTest(dropped=status):
                self.lines.clear()
                self.stop.clear()
                self.clock.sleeps.clear()
                self.clock.on_sleep = None
                manifest = job_manifest(self.clock)
                self.stop_after_sleeps(1)
                self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})], [(status, {"error": "no"})]), FakeProvisioner([{"ok": True, "jobId": manifest["jobId"]}])).run()
                self.assertEqual(self.portal.paths().count("/complete"), 1)
                self.assertIn("delivery=dropped attempts=1", self.lines[0])

    def test_the_worker_reads_a_switched_off_portal_by_the_words_the_route_uses(self):
        # The same sentence is asserted against the route's own source by tests/hermes-provisioner-code-parity.test.ts.
        self.assertEqual(worker_module.PORTAL_DISABLED_TEXT, "not enabled")
        self.assertTrue(worker_module._portal_says_disabled({"error": "The restricted Hermes provisioner is not enabled."}))
        self.assertFalse(worker_module._portal_says_disabled({"error": "The restricted Hermes provisioner could not be reached."}))
        self.assertFalse(worker_module._portal_says_disabled(None))
        self.assertFalse(worker_module._portal_says_disabled({"error": 503}))

    def test_a_401_or_403_when_reporting_stops_the_worker_and_reports_unhealthy(self):
        for status in (401, 403):
            with self.subTest(status=status):
                self.lines.clear()
                self.stop.clear()
                self.clock.sleeps.clear()
                manifest = job_manifest(self.clock)
                loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": manifest})], [(status, {"error": "no"})]), FakeProvisioner([{"ok": True, "jobId": manifest["jobId"]}]))
                code = loop.run()
                self.assertEqual(code, 1)
                self.assertEqual(self.portal.paths(), ["/claim", "/complete"])
                self.assertEqual(self.clock.sleeps, [])
                self.assertEqual(self.beat()["state"], "unauthorized")
                self.assertIn("worker stopped code=portal_unauthorized", self.lines)

    def test_a_401_on_the_claim_stops_before_any_work(self):
        code = self.loop(FakePortal([(401, {"error": "Unauthorized."})])).run()
        self.assertEqual(code, 1)
        self.assertEqual(self.provisioner.processed, [])
        self.assertEqual(self.beat()["state"], "unauthorized")
        self.assertEqual(self.lines, ["worker stopped code=portal_unauthorized"])

    def test_a_stop_request_ends_the_loop_between_jobs(self):
        first, second = job_manifest(self.clock), job_manifest(self.clock)
        loop = self.loop(FakePortal([(200, {"job": first}), (200, {"job": second})]), FakeProvisioner())
        self.provisioner.on_process = self.stop.set
        code = loop.run()
        self.assertEqual(code, 0)
        self.assertEqual(self.provisioner.processed, [first])
        self.assertEqual(self.portal.paths(), ["/claim", "/complete"])
        self.assertEqual(self.beat()["state"], "stopping")

    def test_a_failed_job_posts_the_exact_failure_payload(self):
        manifest = job_manifest(self.clock)
        self.stop_after_sleeps(1)
        loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})]), FakeProvisioner([ProvisioningError("profile_gateway_discovery_timeout")]))
        loop.run()
        self.assertEqual(
            self.portal.calls[1],
            ("/complete", {"ok": False, "jobId": manifest["jobId"], "leaseToken": manifest["leaseToken"], "gatewayId": GATEWAY, "code": "profile_gateway_discovery_timeout"}),
        )
        self.assertEqual(self.lines, [f"job={manifest['jobId']} kind=provision outcome=failed code=profile_gateway_discovery_timeout delivery=delivered attempts=1"])

    def test_stdout_holds_ids_and_codes_only(self):
        manifest = job_manifest(self.clock)
        hostile = {"jobId": "sk-live-do-not-print", "leaseToken": "secret-lease", "kind": "rm -rf", "soul": "SECRET-SOUL-TEXT"}
        self.stop_after_sleeps(2)
        loop = self.loop(
            FakePortal([(200, {"job": manifest}), (200, {"job": hostile}), (200, {"job": None})]),
            FakeProvisioner([{"ok": True, "jobId": manifest["jobId"], "apiKey": "b" * 64}, ProvisioningError("Bad Code With Secrets sk-live")]),
        )
        loop.run()
        text = "\n".join(self.lines)
        self.assertEqual(len(self.lines), 2)
        self.assertIn(manifest["jobId"], text)
        for forbidden in (
            manifest["orgId"], manifest["agentId"], manifest["leaseToken"], manifest["profile"], "SECRET-SOUL-TEXT", "SECRET-CONFIG-TEXT",
            "b" * 64, "sk-live", "secret-lease", "rm -rf", "Bad Code",
        ):
            self.assertNotIn(forbidden, text)
        self.assertEqual(self.lines[1], "job=- kind=- outcome=failed code=- delivery=delivered attempts=1")

    def test_a_job_that_crashes_unexpectedly_reports_nothing_and_waits(self):
        manifest = job_manifest(self.clock)
        self.stop_after_sleeps(1)
        loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})]), FakeProvisioner([RuntimeError("token=abc secret")]))
        loop.run()
        self.assertEqual(self.portal.paths(), ["/claim"])
        self.assertEqual(self.lines, [f"job={manifest['jobId']} kind=provision outcome=failed code=worker_internal_error delivery=none attempts=0"])
        self.assertEqual(self.clock.sleeps[0], 10)

    def test_a_run_of_hermes_connection_failures_reports_the_result_then_exits_non_zero(self):
        manifest = job_manifest(self.clock)
        provisioner = FakeProvisioner([ProvisioningError("http_unavailable")])
        provisioner.streak = 20
        loop = self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": manifest})]), provisioner)
        code = loop.run()
        self.assertEqual(code, 1)
        self.assertEqual(self.portal.paths(), ["/claim", "/complete"])
        self.assertEqual(self.portal.calls[1][1]["code"], "http_unavailable")
        self.assertEqual(self.lines[-1], "worker stopped code=hermes_unreachable")
        self.assertEqual(self.beat()["state"], "hermes_unreachable")
        # A shorter run does not exit.
        provisioner = FakeProvisioner([ProvisioningError("http_unavailable")])
        provisioner.streak = 19
        self.stop.clear()
        self.lines.clear()
        self.stop_after_sleeps(1)
        self.loop(FakePortal([(200, {"job": manifest}), (200, {"job": None})]), provisioner).run()
        self.assertNotIn("worker stopped code=hermes_unreachable", self.lines)

    def test_the_hermes_api_counts_connection_failures_in_a_row_and_resets_on_an_answer(self):
        api = HermesApi("http://127.0.0.1:8642")
        answers: list[Any] = [ProvisioningError("http_unavailable")] * 3 + [(200, {"ok": True})]

        class Http:
            def request(self, url, method, headers, body=None):
                answer = answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer

        api.http = Http()  # type: ignore[assignment]
        for expected in (1, 2, 3):
            with self.assertRaisesRegex(ProvisioningError, "http_unavailable"):
                api.json_request("c-a-1", "k" * 64, "/v1/models")
            self.assertEqual(api.consecutive_unavailable, expected)
        self.assertEqual(api.json_request_default("k" * 64, "/v1/models"), (200, {"ok": True}))
        self.assertEqual(api.consecutive_unavailable, 0)

    def test_the_healthcheck_fails_after_fifteen_unreachable_minutes_and_passes_when_the_portal_is_disabled(self):
        home = Path(self.temp.name) / "hermes-home"
        state_root = home / "iacquire-provisioner-state"
        state_root.mkdir(parents=True, mode=0o700)
        heartbeat = Heartbeat(state_root, self.clock)

        def build(portal: FakePortal) -> WorkerLoop:
            self.stop.clear()
            self.clock.sleeps.clear()
            self.portal = portal
            return WorkerLoop(portal, FakeProvisioner(), self.clock, self.clock.sleep, self.stop, base="https://p.example.invalid/x", headers={}, gateway_id=GATEWAY, heartbeat=heartbeat, out=self.lines.append)

        def healthy() -> bool:
            with patch.dict(os.environ, {"HERMES_HOME": str(home)}, clear=True):
                return _worker_healthcheck(now=self.clock.now)

        # Unreachable for 16 minutes (a 60 s heartbeat refresh each loop keeps `at` fresh, so only the claim age can fail it).
        checks: list[bool] = []

        def after_sleep(count: int) -> None:
            self.clock.now += 50
            checks.append(healthy())
            if self.clock.now - start > 16 * 60:
                self.stop.set()

        start = self.clock.now
        loop = build(FakePortal([ProvisioningError("http_unavailable")]))
        self.clock.on_sleep = after_sleep
        loop.run()
        self.assertTrue(checks[0], "a portal that has only just failed is still healthy")
        self.assertFalse(checks[-1], "unreachable for over 15 minutes is unhealthy")
        # The same portal switched off is healthy-idle for as long as it likes.
        start = self.clock.now
        checks.clear()
        loop = build(FakePortal([(503, {"error": "The restricted Hermes provisioner is not enabled."})]))
        self.clock.on_sleep = after_sleep
        loop.run()
        self.assertGreater(len(checks), 10)
        self.assertTrue(all(checks))

    def test_an_idle_worker_whose_loopback_is_gone_exits_so_docker_restarts_it_into_a_fresh_namespace(self):
        # The gateway restarted under the worker: every claim fails (no egress in the stale namespace) and Hermes does not answer either. No job is ever claimed.
        provisioner = ProbingProvisioner(gone=True)
        code = self.loop(FakePortal([ProvisioningError("http_unavailable")]), provisioner).run()
        self.assertEqual(code, 1)
        self.assertEqual(self.beat()["state"], "hermes_unreachable")
        self.assertEqual(self.lines, ["worker stopped code=hermes_unreachable"])
        self.assertEqual(self.provisioner.processed, [])
        # It took about ten minutes of silence (twenty probes thirty seconds apart), not one missed answer.
        self.assertEqual(provisioner.probes, 20)
        self.assertGreaterEqual(sum(self.clock.sleeps), 19 * 30)
        self.assertLess(sum(self.clock.sleeps), 20 * 30 + 10)

    def test_an_idle_worker_with_an_empty_queue_also_exits_when_the_loopback_is_gone(self):
        provisioner = ProbingProvisioner(gone=True)
        # An empty queue is polled every five seconds, so ten minutes is well over the fake portal's own safety cap of sixty calls: use a cap of our own.
        loop = self.loop(FakePortal([(200, {"job": None})]), provisioner)
        self.portal.stop = threading.Event()
        self.stop_after_sleeps(400)
        code = loop.run()
        self.assertEqual(code, 1)
        self.assertEqual(self.lines, ["worker stopped code=hermes_unreachable"])
        self.assertEqual(provisioner.probes, 20)

    def test_a_portal_outage_alone_never_ends_the_worker_while_the_loopback_answers(self):
        # The portal is unreachable for a long time but Hermes answers every probe: that is an outage to wait out, not a stale namespace.
        provisioner = ProbingProvisioner(gone=False)
        loop = self.loop(FakePortal([ProvisioningError("http_unavailable")]), provisioner)
        self.portal.stop = threading.Event()
        self.stop_after_sleeps(300)
        code = loop.run()
        self.assertEqual(code, 0)
        # Three thousand seconds of failed claims and a probe every thirty: far past the ten minutes that end a worker whose loopback is gone.
        self.assertGreater(provisioner.probes, 60)
        self.assertEqual(self.lines, [])
        self.assertEqual(self.beat()["state"], "stopping")

    def test_a_loopback_that_answers_once_resets_the_count(self):
        provisioner = ProbingProvisioner(gone=True)

        def flip(_count: int) -> None:
            # Silent for fifteen probes, one answer, then silent again: the count starts over, so the worker is still running after thirty probes.
            if provisioner.probes == 15:
                provisioner.gone = False
            elif provisioner.probes == 16:
                provisioner.gone = True
            if provisioner.probes >= 30 or _count > 1000:
                self.stop.set()

        self.clock.on_sleep = flip
        loop = self.loop(FakePortal([(200, {"job": None})]), provisioner)
        self.portal.stop = threading.Event()
        code = loop.run()
        self.assertEqual(code, 0)
        self.assertEqual(provisioner.probes, 30)
        self.assertLess(provisioner.streak, 20)
        self.assertGreater(provisioner.streak, 0)

    def test_the_hermes_api_probe_counts_a_missing_answer_and_treats_any_status_as_an_answer(self):
        api = HermesApi("http://127.0.0.1:8642")
        answers: list[Any] = [ProvisioningError("http_unavailable"), ProvisioningError("http_unavailable"), (404, None), (200, {"status": "ok"})]
        urls: list[tuple[str, str]] = []

        class Http:
            def request(self, url, method, headers, body=None):
                urls.append((method, url))
                answer = answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer

        api.http = Http()  # type: ignore[assignment]
        for expected in (1, 2):
            with self.assertRaisesRegex(ProvisioningError, "http_unavailable"):
                api.probe()
            self.assertEqual(api.consecutive_unavailable, expected)
        # A 404 still proves something is listening, so the streak ends.
        self.assertEqual(api.probe(), 404)
        self.assertEqual(api.consecutive_unavailable, 0)
        self.assertEqual(api.probe(), 200)
        self.assertEqual(urls[0], ("GET", "http://127.0.0.1:8642/health"))
        # The provisioner's own probe never raises: the streak is the report.
        answers[:] = [ProvisioningError("http_unavailable")]
        provisioner = RestrictedProvisioner.__new__(RestrictedProvisioner)
        provisioner.api = api
        provisioner.probe_hermes()
        self.assertEqual(provisioner.hermes_unreachable_streak(), 1)

    def test_a_job_keeps_the_heartbeat_fresh_from_a_daemon_thread(self):
        ticks = iter(range(1_000_000, 2_000_000))
        heartbeat = Heartbeat(self.state_root, lambda: next(ticks), interval=0.01)
        heartbeat.update("processing")
        first = self.beat()["at"]
        with heartbeat.keep_alive():
            deadline = time.monotonic() + 5
            while self.beat()["at"] == first and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertGreater(self.beat()["at"], first)
        self.assertEqual(self.beat()["state"], "processing")
        self.assertEqual(self.beat()["auditBytes"], 0)
        self.assertEqual([thread.name for thread in threading.enumerate() if thread.name == "heartbeat"], [])


class HeartbeatHealthcheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.state_root = self.home / "iacquire-provisioner-state"
        self.state_root.mkdir(mode=0o700)
        self.now = 1_800_000_000

    def check(self) -> bool:
        with patch.dict(os.environ, {"HERMES_HOME": str(self.home)}, clear=True):
            return _worker_healthcheck(now=self.now)

    def write(self, state: str, claim_ok: int | None, job: int | None = None, at: int | None = None) -> None:
        _write_worker_heartbeat(self.state_root, state, claim_ok, job, self.now if at is None else at)

    def test_heartbeat_v2_has_exactly_the_five_documented_fields(self):
        (self.state_root / "audit.jsonl").write_bytes(b"x" * 123)
        self.write("idle", self.now - 5, self.now - 60)
        payload = json.loads((self.state_root / "heartbeat.json").read_text(encoding="ascii"))
        self.assertEqual(payload, {"at": self.now, "state": "idle", "lastClaimOkAt": self.now - 5, "lastJobAt": self.now - 60, "auditBytes": 123})
        with self.assertRaises(ValueError):
            self.write("made_up_state", None)

    def test_the_healthcheck_follows_the_documented_rules(self):
        self.write("idle", self.now - 60)
        self.assertTrue(self.check())
        # The heartbeat itself is stale (a hung process).
        self.write("idle", self.now - 60, at=self.now - 601)
        self.assertFalse(self.check())
        self.write("idle", self.now - 60, at=self.now - 600)
        self.assertTrue(self.check())
        # The portal has not answered a claim for more than 15 minutes.
        self.write("portal_unreachable", self.now - 901)
        self.assertFalse(self.check())
        self.write("portal_unreachable", self.now - 900)
        self.assertTrue(self.check())
        # A switched-off portal answers, so it keeps the claim time fresh and is healthy.
        self.write("portal_disabled", self.now)
        self.assertTrue(self.check())
        # The worker's own decisions.
        for state in ("unauthorized", "hermes_unreachable"):
            self.write(state, self.now)
            self.assertFalse(self.check(), state)
        # Nothing claimed yet is fine only while starting or waiting for Hermes.
        for state, expected in (("starting", True), ("waiting_for_hermes", True), ("idle", False), ("processing", False)):
            self.write(state, None)
            self.assertEqual(self.check(), expected, state)

    def test_the_healthcheck_rejects_the_old_shape_extra_fields_and_wrong_types(self):
        path = self.state_root / "heartbeat.json"
        for payload in (
            {"at": self.now},
            {"at": self.now, "state": "idle", "lastClaimOkAt": self.now, "lastJobAt": None, "auditBytes": 0, "extra": 1},
            {"at": self.now, "state": "idle", "lastClaimOkAt": "now", "lastJobAt": None, "auditBytes": 0},
            {"at": self.now, "state": "idle", "lastClaimOkAt": self.now, "lastJobAt": None, "auditBytes": -1},
            {"at": self.now, "state": "bogus", "lastClaimOkAt": self.now, "lastJobAt": None, "auditBytes": 0},
            {"at": True, "state": "idle", "lastClaimOkAt": self.now, "lastJobAt": None, "auditBytes": 0},
        ):
            path.write_text(json.dumps(payload), encoding="ascii")
            self.assertFalse(self.check(), payload)
        path.write_text("{not json", encoding="ascii")
        self.assertFalse(self.check())


class StartupGateTests(unittest.TestCase):
    def setUp(self):
        self.stop = threading.Event()
        self.sleeps: list[float] = []
        self.lines: list[str] = []
        self.heartbeat = Heartbeat(None)

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)

    def gate(self, codes: list[str | None], **kwargs: Any) -> bool:
        queue = list(codes)

        def check() -> None:
            code = queue.pop(0)
            if code is not None:
                raise ProvisioningError(code)

        return _wait_for_hermes(check, self.heartbeat, self.sleep, self.stop, self.lines.append)

    def test_the_gate_waits_with_a_doubling_backoff_capped_at_sixty_seconds(self):
        self.assertTrue(self.gate(["http_unavailable"] * 7 + [None]))
        self.assertEqual(self.sleeps, [5, 10, 20, 40, 60, 60, 60])
        self.assertEqual(self.heartbeat.snapshot()["state"], "waiting_for_hermes")
        self.assertEqual(self.lines, ["gate waiting code=http_unavailable"])

    def test_a_gateway_that_is_up_passes_without_waiting(self):
        self.assertTrue(self.gate([None]))
        self.assertEqual(self.sleeps, [])
        self.assertEqual(self.heartbeat.snapshot()["state"], "starting")

    def test_an_incomplete_catalog_is_waited_for_a_while_and_then_ends_the_start_up(self):
        with self.assertRaisesRegex(ProvisioningError, "runtime_tool_inventory_incomplete"):
            self.gate(["runtime_tool_inventory_incomplete"] * 10)
        self.assertEqual(len(self.sleeps), 9)
        # A gateway that is merely starting recovers inside the limit.
        self.sleeps.clear()
        self.assertTrue(self.gate(["runtime_tool_inventory_incomplete"] * 9 + [None]))

    def test_other_failures_still_end_the_start_up_at_once(self):
        with self.assertRaisesRegex(ProvisioningError, "invalid_profile_route"):
            self.gate(["invalid_profile_route"])
        self.assertEqual(self.sleeps, [])

    def test_a_stop_request_ends_the_wait(self):
        self.stop.set()
        self.assertFalse(self.gate([None]))
        self.assertEqual(self.sleeps, [])
        self.stop.clear()
        stopping = lambda seconds: (self.sleeps.append(seconds), self.stop.set())
        queue = ["http_unavailable"] * 5

        def check() -> None:
            raise ProvisioningError(queue.pop(0))

        self.assertFalse(_wait_for_hermes(check, self.heartbeat, stopping, self.stop, self.lines.append))
        self.assertEqual(self.sleeps, [5])


if __name__ == "__main__":
    unittest.main()
