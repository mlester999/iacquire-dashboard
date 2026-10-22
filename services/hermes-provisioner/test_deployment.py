from __future__ import annotations

import re
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).parent


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


if __name__ == "__main__":
    unittest.main()
