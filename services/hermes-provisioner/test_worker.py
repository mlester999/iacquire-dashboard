from __future__ import annotations

import json
import base64
import hashlib
import hmac
import os
import subprocess
import tempfile
import unittest
import uuid
import yaml
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from worker import (
    ProvisioningError,
    RestrictedProvisioner,
    _load_bootstrap_api_key,
    _load_service_token,
    _sanitize_worker_environment,
    _validate_portal_origin,
    _worker_healthcheck,
    _write_worker_heartbeat,
    HermesApi,
    digest,
    parse_manifest,
    verify_complete_catalog,
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
            final_toolsets = [
                {"name": "memory", "enabled": True, "tools": ["memory"]},
                {"name": "session_search", "enabled": True, "tools": ["session_search"]},
                {"name": "todo", "enabled": True, "tools": ["todo_list"]},
                {"name": "vision", "enabled": True, "tools": ["vision_analyze"]},
                {"name": "web", "enabled": True, "tools": ["web_extract", "web_search"]},
            ]
            if is_canary and self.canary_policy_pending_reads:
                self.canary_policy_pending_reads -= 1
                return 200, final_toolsets
            if not is_canary and self.final_policy_pending_reads:
                self.final_policy_pending_reads -= 1
                return 200, canary_toolsets
            if is_canary:
                return 200, canary_toolsets
            if "web" not in config_text:
                return 200, [{"name": "no_mcp", "enabled": False, "tools": []}]
            return 200, final_toolsets
        if path == "/v1/runs" and method == "POST":
            self.challenge = body.get("session_id", "").split("-")[-1]
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
            entries = [
                ("memory", "memory"),
                ("session_search", "session_search"),
                ("todo_list", "todo"),
                ("web_extract", "web"),
                ("web_search", "web"),
                ("vision_analyze", "vision"),
            ]
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
                "enabledToolsets": ["memory", "session_search", "todo", "vision", "web"],
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
                "enabled_toolsets": ["memory", "session_search", "todo", "vision", "web"],
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

    def test_new_profile_waits_for_profile_route_before_canary(self):
        self.api.profile_discovery_pending = 2
        with patch("worker.time.sleep") as sleep:
            result = self.provisioner.process(self.manifest)

        self.assertTrue(result["effectiveSoulVerified"])
        self.assertEqual(self.api.profile_capability_reads, 5)
        self.assertEqual(sleep.call_count, 2)

    def test_canary_submission_failure_reports_only_the_http_status(self):
        self.api.run_submission_status = 403
        with self.assertRaisesRegex(ProvisioningError, "canary_submission_http_403"):
            self.provisioner.process(self.manifest)

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

    def test_runtime_preflight_accepts_v0223_object_endpoint_descriptor(self):
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


if __name__ == "__main__":
    unittest.main()
