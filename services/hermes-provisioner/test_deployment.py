from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).parent
CATALOG_OVERLAY_SHA256 = {
    "model_tools.py": "ebfec9d0392f3c138da196d97c87f14e95b9e7cb2e82a4068a541f0c76603562",
    "agent/memory_provider.py": "5ec7974c8262b56a587d2d6c8cdad0d69c68e09871fadd3c80109b3523f224ae",
    "gateway/platforms/api_server_tool_catalog.py": "a503826b8b9ccb1efe014268bbb0470c0481425686408c632c8e5d2a34318a19",
    "gateway/platforms/api_server.py": "e0e7274d3a9eac772e02396cdb21355db88d6b106460c0c52b3acff5e5118d55",
    "plugins/memory/honcho/__init__.py": "3e2b61673150e58e9320b0c80e2352e34dce979e06de5f5e672eb19172bb37e0",
    "plugins/memory/supermemory/__init__.py": "afb2d8279d73e8c1bc6d8db2d141a4c4cf858c9d43401c2398ddace13f5a8e34",
    "tools/mcp_tool_registration.py": "a5111f846cb1a84233d653973eba274ea6c2e73d7f52a61db0eb6a9c8e8edb3d",
    "tools/mcp_tool.py": "144bed331c2e4f9577e8b82564a714b8bfdc9beb172e477568e8925b4c9a9c0a",
}


class ClientRuntimeDeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compose = yaml.safe_load((ROOT / "compose.client.yaml").read_text(encoding="utf-8"))
        cls.services = cls.compose["services"]

    def test_worker_is_opt_in_unprivileged_and_has_no_hermes_home_mount(self):
        worker = self.services["hermes-provisioner"]
        self.assertIn("provisioner", worker["profiles"])
        self.assertEqual(worker["user"], "10000:10000")
        self.assertTrue(worker["read_only"])
        self.assertEqual(worker["cap_drop"], ["ALL"])
        self.assertEqual(worker["network_mode"], "service:hermes-client")
        sources = {
            mount.get("source") if isinstance(mount, dict) else mount.split(":", 1)[0]
            for mount in worker["volumes"]
        }
        self.assertIn("client_profiles", sources)
        self.assertIn("worker_home", sources)
        self.assertNotIn("hermes_home", sources)

    def test_no_host_port_or_docker_socket_is_declared(self):
        hermes = self.services["hermes-client"]
        self.assertNotIn("ports", hermes)
        self.assertEqual(hermes["environment"]["HERMES_DASHBOARD"], "0")
        stack = (ROOT / "compose.client.yaml").read_text(encoding="utf-8")
        self.assertNotIn("/var/run/docker.sock", stack)
        self.assertNotIn("privileged: true", stack)

    def test_worker_home_initializer_is_volume_scoped_and_networkless(self):
        initializer = self.services["init-worker-home"]
        self.assertEqual(initializer["network_mode"], "none")
        self.assertEqual(initializer["user"], "0:0")
        self.assertEqual(
            {
                mount.get("source") if isinstance(mount, dict) else mount.split(":", 1)[0]
                for mount in initializer["volumes"]
            },
            {"worker_home", "client_profiles"},
        )

    def test_model_provider_secret_is_mounted_only_into_the_worker(self):
        def targets(service):
            return {mount.get("target") for mount in service["volumes"] if isinstance(mount, dict)}

        self.assertNotIn("/run/secrets/profile_model_env.json", targets(self.services["hermes-client"]))
        self.assertIn("/run/secrets/profile_model_env.json", targets(self.services["hermes-provisioner"]))

    def test_build_rejects_mutable_or_non_official_hermes_image_references(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertRegex(dockerfile, r"nousresearch/hermes-agent@sha256:")
        self.assertRegex(dockerfile, r"\[0-9a-f\]\{64\}")
        self.assertNotRegex(dockerfile, r"nousresearch/hermes-agent:latest")

    def test_isolated_build_candidate_uses_the_verified_immutable_release_digest(self):
        env_example = (ROOT / "client.env.example").read_text(encoding="utf-8")
        expected = "fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7"
        self.assertRegex(
            env_example,
            rf"(?m)^HERMES_BASE_IMAGE=docker\.io/nousresearch/hermes-agent@sha256:{expected}$",
        )
        self.assertIn("No production use", env_example)

    def test_catalog_overlay_matches_reviewed_hermes_0215_backport_hashes(self):
        overlay = ROOT / "catalog-overlay"
        manifest = {
            path: checksum
            for checksum, path in (
                line.split(None, 1)
                for line in (overlay / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
                if line.strip()
            )
        }
        self.assertEqual(manifest, CATALOG_OVERLAY_SHA256)
        for path, expected in CATALOG_OVERLAY_SHA256.items():
            actual = hashlib.sha256((overlay / path).read_bytes()).hexdigest()
            self.assertEqual(actual, expected, path)

        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn('version == "0.21.5"', dockerfile)
        self.assertIn("SHA256SUMS", dockerfile)
        self.assertIn("_handle_tools", dockerfile)
        self.assertIn("update_last_resolved", dockerfile)
        self.assertIn("test -x /opt/hermes/bin/hermes", dockerfile)
        self.assertIn("test -x /opt/hermes/docker/entrypoint-dispatch.sh", dockerfile)


if __name__ == "__main__":
    unittest.main()
