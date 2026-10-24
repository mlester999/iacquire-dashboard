from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from verify_portal_security_boundary import BoundaryCheckError, verify_boundary


_RUN_AS_ACCEPTANCE_UID = (
    os.name == "posix"
    and hasattr(os, "getuid")
    and os.getuid() == 10000
    and os.getgid() == 10000
)


@unittest.skipUnless(
    _RUN_AS_ACCEPTANCE_UID,
    "the container-owned 0400 secret regression runs in the isolated UID 10000 candidate image",
)
class PortalSecurityBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.temp_dir = Path(self.temp.name)
        self.repo_dir = self.temp_dir / "repository"
        self.repo_dir.mkdir()

        for name, value in (
            ("hermes-api-key", "synthetic-hermes-key"),
            ("provisioner-token", "synthetic-provisioner-token"),
            ("portal-admin-token", "synthetic-portal-token"),
            (
                "profile-model-env.json",
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "environment": "OPENAI_API_KEY",
                        "value": "synthetic-model-key",
                    }
                ),
            ),
        ):
            path = self.temp_dir / name
            path.write_text(value, encoding="ascii")
            path.chmod(0o400)

        for name in ("acceptance-cert.pem", "acceptance-key.pem"):
            path = self.temp_dir / name
            path.write_text("synthetic-tls-input", encoding="ascii")

        self.portal, self.client, self.worker = self._containers()

    def _containers(self):
        portal_mounts = [
            {
                "Type": "bind",
                "Source": str(self.repo_dir),
                "Destination": "/repository",
                "RW": False,
            },
            {
                "Type": "bind",
                "Source": str(self.temp_dir / "provisioner-token"),
                "Destination": "/run/secrets/provisioner_token",
                "RW": False,
            },
            {
                "Type": "bind",
                "Source": str(self.temp_dir / "portal-admin-token"),
                "Destination": "/run/secrets/portal_acceptance_admin",
                "RW": False,
            },
            {
                "Type": "bind",
                "Source": str(self.temp_dir / "acceptance-cert.pem"),
                "Destination": "/run/secrets/acceptance-cert.pem",
                "RW": False,
            },
            {
                "Type": "bind",
                "Source": str(self.temp_dir / "acceptance-key.pem"),
                "Destination": "/run/secrets/acceptance-key.pem",
                "RW": False,
            },
        ]

        def container(user="10000:10000", network_mode="bridge", mounts=None, env=None, networks=None):
            return {
                "Config": {"User": user, "Env": env or []},
                "HostConfig": {
                    "Privileged": False,
                    "ReadonlyRootfs": True,
                    "CapDrop": ["ALL"],
                    "NetworkMode": network_mode,
                },
                "Mounts": list(mounts or []),
                "NetworkSettings": {"Ports": {}, "Networks": networks or {}},
            }

        portal_env = [
            "NODE_ENV=test",
            "DATABASE_DRIVER=pglite-memory",
            "HERMES_PROVISIONER_TOKEN_FILE=/run/secrets/provisioner_token",
        ]
        portal = container(
            network_mode="container:0123456789ab",
            mounts=portal_mounts,
            env=portal_env,
        )
        client = container(networks={"private-ci": {}, "client-egress-ci": {}})
        worker = container(network_mode="container:0123456789ab")
        return portal, client, worker

    def _verify(self):
        verify_boundary(
            self.portal,
            self.client,
            self.worker,
            self.temp_dir,
            self.repo_dir,
            lambda _name: {"Internal": True},
        )

    def test_accepts_container_owned_readonly_synthetic_inputs_and_exact_portal_mounts(self):
        self._verify()

    def test_rejects_a_synthetic_credential_copied_into_portal_environment(self):
        self.portal["Config"]["Env"].append("UNEXPECTED=" + "synthetic-hermes-key")
        with self.assertRaises(BoundaryCheckError) as raised:
            self._verify()
        self.assertEqual(raised.exception.code, "secret_in_portal_environment")

    def test_rejects_a_private_input_with_relaxed_permissions(self):
        (self.temp_dir / "hermes-api-key").chmod(0o600)
        with self.assertRaises(BoundaryCheckError) as raised:
            self._verify()
        self.assertEqual(raised.exception.code, "private_input_mode_mismatch")

    def test_rejects_an_extra_portal_bind_mount(self):
        self.portal["Mounts"].append(
            {
                "Type": "bind",
                "Source": str(self.temp_dir / "profile-model-env.json"),
                "Destination": "/run/secrets/profile-model-env.json",
                "RW": False,
            }
        )
        with self.assertRaises(BoundaryCheckError) as raised:
            self._verify()
        self.assertEqual(raised.exception.code, "portal_bind_allowlist_mismatch")


if __name__ == "__main__":
    unittest.main()
