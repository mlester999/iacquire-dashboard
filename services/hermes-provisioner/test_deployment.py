from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).parent
CATALOG_OVERLAY_V0215_SHA256 = {
    "model_tools.py": "ebfec9d0392f3c138da196d97c87f14e95b9e7cb2e82a4068a541f0c76603562",
    "agent/memory_provider.py": "5ec7974c8262b56a587d2d6c8cdad0d69c68e09871fadd3c80109b3523f224ae",
    "gateway/platforms/api_server_tool_catalog.py": "a503826b8b9ccb1efe014268bbb0470c0481425686408c632c8e5d2a34318a19",
    "gateway/platforms/api_server.py": "e0e7274d3a9eac772e02396cdb21355db88d6b106460c0c52b3acff5e5118d55",
    "plugins/memory/honcho/__init__.py": "3e2b61673150e58e9320b0c80e2352e34dce979e06de5f5e672eb19172bb37e0",
    "plugins/memory/supermemory/__init__.py": "afb2d8279d73e8c1bc6d8db2d141a4c4cf858c9d43401c2398ddace13f5a8e34",
    "tools/mcp_tool_registration.py": "a5111f846cb1a84233d653973eba274ea6c2e73d7f52a61db0eb6a9c8e8edb3d",
    "tools/mcp_tool.py": "144bed331c2e4f9577e8b82564a714b8bfdc9beb172e477568e8925b4c9a9c0a",
}
CATALOG_OVERLAY_V0225_SHA256 = {
    "gateway/platforms/api_server.py": "e20f4fdbb8099354934ab23e0ba6daea9c90f6488195509e3f52090d33f8e482",
    "model_tools.py": "311867fa4fe1689e12a6097b729e05d4bc5e5bd39a19f8e502605c46a5082153",
    "gateway/platforms/api_server_tool_catalog.py": "53682d305a91b802055bf00dfeee615045f3668a17a57b2c6e5cffdc13798327",
}
CATALOG_OVERLAY_V0225_UPSTREAM_SHA256 = {
    "gateway/platforms/api_server.py": "71ac56c28683aa6b935a432b58e5bfe3753492363ef2cf9f8853b121d0e8214f",
    "model_tools.py": "da5b7db1b05de615658e56c4172426ed82099a093c5b586e48e65ef930b778c8",
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

    def test_gateway_has_a_readonly_image_filesystem_and_narrow_runtime_access(self):
        hermes = self.services["hermes-client"]
        self.assertTrue(hermes["read_only"])
        self.assertEqual(hermes["cap_drop"], ["ALL"])
        self.assertEqual(set(hermes["cap_add"]), {"CHOWN", "KILL", "SETGID", "SETUID"})
        self.assertIn("no-new-privileges:true", hermes["security_opt"])
        self.assertEqual(hermes["environment"]["HERMES_UID"], "10000")
        self.assertEqual(hermes["environment"]["PYTHONDONTWRITEBYTECODE"], "1")
        self.assertEqual(
            hermes["tmpfs"],
            ["/run:rw,exec,nosuid,nodev,size=64m", "/tmp:rw,noexec,nosuid,nodev,size=128m"],
        )

        mounts = {mount.get("target"): mount for mount in hermes["volumes"] if isinstance(mount, dict)}
        self.assertTrue(mounts["/opt/data/config.yaml"]["read_only"])
        self.assertTrue(mounts["/run/secrets/hermes_api_key"]["read_only"])
        self.assertNotIn("/docker/hermes-agent-wpwm/data", str(hermes["volumes"]))

    def test_client_home_allows_bootstrap_path_search_without_extra_capabilities(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertRegex(
            dockerfile,
            r"(?m)^RUN install -d -o 10000 -g 10000 -m 0711 /opt/data && \\\n\s+test \"\$\(stat -c '%u:%g:%a' /opt/data\)\" = \"10000:10000:711\"$",
        )
        hermes = self.services["hermes-client"]
        self.assertEqual(hermes["cap_drop"], ["ALL"])
        self.assertNotIn("DAC_OVERRIDE", hermes["cap_add"])
        self.assertTrue(
            next(
                mount["read_only"]
                for mount in hermes["volumes"]
                if isinstance(mount, dict) and mount.get("target") == "/opt/data/config.yaml"
            )
        )

    def test_startup_failure_probe_is_readonly_and_limits_output_to_home_metadata(self):
        workflow = (
            ROOT.parent.parent / ".github" / "workflows" / "hermes-client-acceptance.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("--network none --user 0:0 --cap-drop=ALL", workflow)
        self.assertIn('CLIENT_HOME_OWNER_MODE="', workflow)
        self.assertIn('CLIENT_CONFIG_VISIBLE=yes', workflow)
        self.assertIn('CLIENT_CONFIG_READABLE=yes', workflow)
        self.assertIn('^CLIENT_HOME_OWNER_MODE=([0-9:]+|unknown)$', workflow)
        self.assertIn('^CLIENT_CONFIG_(VISIBLE|READABLE)=(yes|no)$', workflow)
        self.assertIn(
            'probe_image="${IACQUIRE_HERMES_IMAGE:-iacquire/hermes-client:acceptance}"',
            workflow,
        )
        self.assertIn('--entrypoint /bin/sh "$probe_image" -c', workflow)

    def test_acceptance_bind_file_modes_support_dropped_caps_without_widening_reads(self):
        hermes = self.services["hermes-client"]
        self.assertNotIn("DAC_OVERRIDE", hermes["cap_add"])
        workflow = (
            ROOT.parent.parent / ".github" / "workflows" / "hermes-client-acceptance.yml"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'sudo chown 0:10000 "$temp_dir/hermes-api-key" "$temp_dir/client-config.yaml"',
            workflow,
        )
        self.assertIn(
            'sudo chmod 0440 "$temp_dir/hermes-api-key" "$temp_dir/client-config.yaml"',
            workflow,
        )
        self.assertIn('"0:10000:440"', workflow)
        self.assertIn('"10000:10000:400"', workflow)

    def test_worker_home_initializer_is_volume_scoped_networkless_and_sets_profile_permissions(self):
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
        command = " ".join(initializer["command"])
        self.assertRegex(command, r"chown 10000:10000 [^;]*/opt/data/profiles")
        self.assertRegex(command, r"chmod 0700 [^;]*/opt/data/profiles")
        self.assertIn("touch /opt/data/config.yaml", command)
        self.assertIn("chmod 0600 /opt/data/config.yaml", command)

    def test_hermes_home_initializer_prepares_readonly_config_bind_target_safely(self):
        initializer = self.services["init-hermes-home"]
        self.assertEqual(initializer["network_mode"], "none")
        self.assertEqual(initializer["user"], "10000:10000")
        self.assertTrue(initializer["read_only"])
        self.assertEqual(initializer["cap_drop"], ["ALL"])
        self.assertIn("no-new-privileges:true", initializer["security_opt"])
        self.assertEqual(
            {
                mount.get("source") if isinstance(mount, dict) else mount.split(":", 1)[0]
                for mount in initializer["volumes"]
            },
            {"hermes_home"},
        )
        command = " ".join(initializer["command"])
        self.assertIn("if [ -L /opt/data/config.yaml ]; then exit 1; fi", command)
        self.assertIn("if [ -d /opt/data/config.yaml ]; then rmdir /opt/data/config.yaml; fi", command)
        self.assertIn("touch /opt/data/config.yaml", command)
        self.assertIn("chmod 0600 /opt/data/config.yaml", command)
        self.assertEqual(
            self.services["hermes-client"]["depends_on"]["init-hermes-home"]["condition"],
            "service_completed_successfully",
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
        expected = "9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d"
        self.assertRegex(
            env_example,
            rf"(?m)^HERMES_BASE_IMAGE=docker\.io/nousresearch/hermes-agent@sha256:{expected}$",
        )
        self.assertIn("still needs isolated runtime acceptance", env_example)

    def test_legacy_and_candidate_overlays_match_reviewed_hashes(self):
        overlay = ROOT / "catalog-overlay"
        manifest = {
            path: checksum
            for checksum, path in (
                line.split(None, 1)
                for line in (overlay / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
                if line.strip()
            )
        }
        self.assertEqual(manifest, CATALOG_OVERLAY_V0215_SHA256)
        for path, expected in CATALOG_OVERLAY_V0215_SHA256.items():
            actual = hashlib.sha256((overlay / path).read_bytes()).hexdigest()
            self.assertEqual(actual, expected, path)

        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn('["/opt/hermes/bin/hermes","--version"]', dockerfile)
        self.assertIn('v?0\\.22\\.5', dockerfile)
        self.assertIn('v26.12.1', dockerfile)
        self.assertIn("catalog-overlay-v0225", dockerfile)
        self.assertIn("verify_overlay.py", dockerfile)
        self.assertIn("_handle_tools", dockerfile)
        self.assertIn("update_last_resolved", dockerfile)
        self.assertIn("test -x /opt/hermes/bin/hermes", dockerfile)
        self.assertIn("test -x /opt/hermes/docker/entrypoint-dispatch.sh", dockerfile)

    def test_v0225_overlay_and_upstream_checksums_match_reviewed_sources(self):
        overlay = ROOT / "catalog-overlay-v0225"
        overlay_manifest = {
            path: checksum
            for checksum, path in (
                line.split(None, 1)
                for line in (overlay / "SHA256SUMS").read_text(encoding="ascii").splitlines()
                if line.strip()
            )
        }
        self.assertEqual(overlay_manifest, CATALOG_OVERLAY_V0225_SHA256)
        for path, expected in CATALOG_OVERLAY_V0225_SHA256.items():
            self.assertEqual(hashlib.sha256((overlay / path).read_bytes()).hexdigest(), expected, path)

        upstream_manifest = {
            path: checksum
            for checksum, path in (
                line.split(None, 1)
                for line in (overlay / "UPSTREAM_SHA256SUMS").read_text(encoding="ascii").splitlines()
                if line.strip()
            )
        }
        self.assertEqual(upstream_manifest, CATALOG_OVERLAY_V0225_UPSTREAM_SHA256)


    def test_dockerfile_copy_sources_resolve_from_repository_root_context(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        repository_root = ROOT.parent.parent
        copied_sources = (
            "services/hermes-provisioner/hermes-client-entrypoint.sh",
            "services/hermes-provisioner/worker.py",
            "services/hermes-provisioner/requirements.txt",
            "services/hermes-provisioner/catalog-overlay-v0225",
        )
        for source in copied_sources:
            path = repository_root / source
            self.assertTrue(path.exists(), source)
            self.assertIn(f"COPY --chown=0:0 {source}", dockerfile)
        self.assertIn("COPY --chown=0:0 services/hermes-provisioner/requirements.txt", dockerfile)
        self.assertIn('from pm import uv_launcher', dockerfile)
        self.assertIn('uv_launcher("uv")', dockerfile)
        self.assertIn('"venv", "--python", "/opt/hermes/.venv/bin/python"', dockerfile)
        self.assertIn('"pip", "install", "--no-cache"', dockerfile)
        self.assertIn('"--python", "/opt/iacquire-hermes/.venv/bin/python"', dockerfile)
        self.assertIn('ENTRYPOINT ["/opt/iacquire-hermes/.venv/bin/python"', dockerfile)


if __name__ == "__main__":
    unittest.main()
