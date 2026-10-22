from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from worker import ProvisioningError, RestrictedProvisioner, _sanitize_worker_environment, _validate_portal_origin, digest, parse_manifest


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
            return 200, {"auth": {"required": True, "type": "bearer"}, "features": {"run_submission": True}}
        if path == "/v1/models":
            return 200, {"data": [{"id": profile, "owned_by": "hermes", "parent": None, "root": profile}]}
        if path == "/v1/toolsets":
            config = self.home / "profiles" / profile / "config.yaml"
            config_text = config.read_text(encoding="utf-8") if config.exists() else ""
            if "web" not in config_text:
                return 200, [{"name": "no_mcp", "enabled": False, "tools": []}]
            return 200, [{"name": "web", "enabled": True, "tools": ["web_search"]}]
        if path == "/v1/runs" and method == "POST":
            self.challenge = body.get("session_id", "").split("-")[-1]
            return 202, {"run_id": "run-test"}
        if path == "/v1/tools?platform=api_server":
            challenge = (extra_headers or {}).get("X-Hermes-Inventory-Challenge", "")
            return 200, {
                "platform": "api_server",
                "complete": True,
                "explicit_config_present": True,
                "challenge": challenge,
                "tools": [{"name": "web_search"}],
            }
        raise AssertionError("unexpected Hermes request " + path)

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

        self.assertTrue(result["effectiveSoulVerified"])
        self.assertTrue(result["toolInventoryComplete"])
        self.assertEqual(result["soulSha256"], self.manifest["soulSha256"])
        self.assertEqual(result["apiKey"], env_text.split("API_SERVER_KEY=", 1)[1].strip())
        self.assertRegex(result["apiKey"], r"^[0-9a-f]{64}$")
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.commands[0][1:3], ["profile", "create"])
        self.assertEqual(self.commands[0][3], self.manifest["profile"])
        self.assertIn("--no-alias", self.commands[0])
        self.assertIn("--no-skills", self.commands[0])
        self.assertNotIn("--clone", self.commands[0])
        self.assertNotIn("API_SERVER_KEY", json.dumps(marker))
        self.assertNotIn("IACQUIRE_PROVISIONER_TOKEN", self.command_envs[0])
        self.assertNotIn("OPENAI_API_KEY", self.command_envs[0])
        self.assertEqual(self.command_envs[0]["HERMES_HOME"], str(self.home))
        self.assertIn("provider: deepseek", config)
        self.assertIn("api_server:", config)
        if os.name != "nt":
            self.assertEqual((profile / ".env").stat().st_mode & 0o777, 0o600)
            self.assertEqual(profile.stat().st_mode & 0o777, 0o700)

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
        recovered = interrupted.process(self.manifest)
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
            "OPENAI_API_KEY": "model-key",
            "DATABASE_URL": "database-secret",
        }, clear=True):
            _sanitize_worker_environment(self.home, "http://127.0.0.1:8642")
            self.assertEqual(os.environ.get("PATH"), "worker-path")
            self.assertEqual(os.environ.get("HERMES_HOME"), str(self.home))
            self.assertEqual(os.environ.get("HERMES_PROVISIONER_API_BASE"), "http://127.0.0.1:8642")
            self.assertNotIn("IACQUIRE_PROVISIONER_TOKEN", os.environ)
            self.assertNotIn("OPENAI_API_KEY", os.environ)
            self.assertNotIn("DATABASE_URL", os.environ)


if __name__ == "__main__":
    unittest.main()
