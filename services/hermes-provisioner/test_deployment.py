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
    "gateway/platforms/api_server.py": "8f687c01c32eccd5644ceec8f4ad7eaf6ec42de96cd3403b4d3cab6b92d32322",
    "model_tools.py": "2e2bdc4d77a1f9a672ce1de79ae77929e5ea226370263bea9d949c01e233965d",
    "gateway/platforms/api_server_tool_catalog.py": "53682d305a91b802055bf00dfeee615045f3668a17a57b2c6e5cffdc13798327",
    "gateway/platforms/api_server_run_tool_scope.py": "c8e63b7b5d070b4e2438e2cebe788f8bf246dcaeff12e056e9eea4f4f7457855",
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
        self.assertIn("--network none --user 10000:10000 --cap-drop=ALL", workflow)
        self.assertIn("--cpus=0.5 --memory=256m --pids-limit=32", workflow)
        self.assertIn('CLIENT_CONFIG_SOURCE=present:', workflow)
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

    def test_acceptance_workflow_has_scoped_manual_and_one_time_push_triggers_and_pins_helper_image(self):
        workflow_path = ROOT.parent.parent / ".github" / "workflows" / "hermes-client-acceptance.yml"
        workflow_text = workflow_path.read_text(encoding="utf-8")
        workflow = yaml.load(workflow_text, Loader=yaml.BaseLoader)
        self.assertIn("CANDIDATE_CONTAINER_START_ERROR:", workflow_text)
        self.assertIn("CANDIDATE_TEST_RUNNER_ERROR_CLASS:", workflow_text)
        self.assertIn("api[_-]?key", workflow_text)
        self.assertEqual(set(workflow["on"]), {"push", "workflow_dispatch"})
        self.assertEqual(
            workflow["on"]["push"]["branches"],
            ["codex/hermes-gha-acceptance", "codex/ai-growth-partner"],
        )
        self.assertEqual(workflow["on"]["push"]["paths"], [".github/hermes-acceptance.trigger"])
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        dispatch = workflow["on"]["workflow_dispatch"]
        confirmation = dispatch["inputs"]["confirm_external_execution"]
        self.assertEqual(confirmation["type"], "choice")
        self.assertEqual(confirmation["required"], "true")
        self.assertEqual(confirmation["options"], ["RUN_SYNTHETIC_HERMES_ACCEPTANCE"])

        job = workflow["jobs"]["build-and-accept"]
        self.assertIn("github.event_name == 'workflow_dispatch'", job["if"])
        self.assertIn("github.ref_name == 'codex/ai-growth-partner'", job["if"])
        self.assertIn(
            "github.event.inputs.confirm_external_execution == 'RUN_SYNTHETIC_HERMES_ACCEPTANCE'",
            job["if"],
        )
        self.assertIn("github.event_name == 'push'", job["if"])
        self.assertIn("github.ref_name == 'codex/hermes-gha-acceptance'", job["if"])
        self.assertIn("github.event.head_commit.message == 'test: run one-time synthetic Hermes acceptance'", job["if"])
        self.assertIn("startsWith(github.event.head_commit.message, 'test: retry synthetic Hermes acceptance')", job["if"])
        self.assertEqual(job["runs-on"], "ubuntu-24.04")
        self.assertEqual(job["timeout-minutes"], "30")
        self.assertIn("--cpus=2 --memory=2g --pids-limit=128", workflow_text)
        self.assertIn("--cpus=0.5 --memory=512m --pids-limit=64", workflow_text)
        runner_check = next(step for step in job["steps"] if step.get("name") == "Verify runner and branch scope")
        self.assertIn('if [[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]; then', runner_check["run"])
        self.assertIn('[[ "$GITHUB_REF_NAME" == codex/ai-growth-partner ]]', runner_check["run"])
        self.assertIn('[[ "$GITHUB_EVENT_NAME" == push ]]', runner_check["run"])
        self.assertIn('[[ "$GITHUB_REF_NAME" == codex/hermes-gha-acceptance ]]', runner_check["run"])
        self.assertIn('[[ "$(uname -m)" == "x86_64" ]]', runner_check["run"])
        self.assertIn(
            '[[ "$trigger_value" == RUN_SYNTHETIC_HERMES_ACCEPTANCE* ]]',
            runner_check["run"],
        )
        self.assertIn(
            '[[ "$HERMES_ACCEPTANCE_CONFIRMATION" == RUN_SYNTHETIC_HERMES_ACCEPTANCE ]]',
            runner_check["run"],
        )

        helper_image = "docker.io/library/node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d"
        overlay_path = ROOT / "compose.portal-acceptance.yaml"
        overlay = yaml.load(overlay_path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
        service = overlay["services"]["portal-acceptance"]
        self.assertEqual(service["image"], helper_image)
        self.assertEqual(service["platform"], "linux/amd64")
        self.assertIn(f"docker pull {helper_image}", workflow_text)

    def test_acceptance_fixture_has_container_resource_limits(self):
        compose_path = ROOT / "compose.acceptance.yaml"
        compose = yaml.safe_load(compose_path.read_text(encoding="utf-8"))
        service = compose["services"]["acceptance-harness"]
        self.assertEqual((service["mem_limit"], service["cpus"], service["pids_limit"]), ("512m", 0.5, 64))

    def test_manual_acceptance_restarts_gateway_and_rebinds_isolated_probe_before_memory_check(self):
        workflow_path = ROOT.parent.parent / ".github" / "workflows" / "hermes-client-acceptance.yml"
        workflow = yaml.load(workflow_path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
        steps = workflow["jobs"]["build-and-accept"]["steps"]
        restart_index = next(
            index for index, step in enumerate(steps)
            if step.get("name") == "Restart isolated Hermes and verify native memory recovery"
        )
        portal_index = next(
            index for index, step in enumerate(steps)
            if step.get("name") == "Provision through real iAcquireOS routes and verify Hermes state"
        )
        cleanup_index = next(
            index for index, step in enumerate(steps)
            if step.get("name") == "Remove all synthetic containers, networks, volumes, and credentials"
        )
        self.assertLess(portal_index, restart_index)
        self.assertLess(restart_index, cleanup_index)
        run = steps[restart_index]["run"]
        self.assertIn('docker restart --time 60 "$client_id"', run)
        self.assertIn('compose up -d --no-build --force-recreate --no-deps acceptance-harness', run)
        self.assertIn('harness_id_before="$(compose ps --all -q acceptance-harness | head -n 1)"', run)
        self.assertIn('harness_id_before" == "$harness_id_after', run)
        self.assertIn("rebound_probe_unhealthy", run)
        self.assertIn('docker exec "$harness_id_after"', run)
        self.assertLess(run.index('docker restart --time 60 "$client_id"'), run.index("acceptance-harness >/dev/null"))
        self.assertLess(run.index("acceptance-harness >/dev/null"), run.index("verify-hermes-memory"))
        self.assertIn("verify-hermes-memory", run)
        self.assertIn("hermesMemoryRestartVerifiedProfiles", run)
        self.assertIn("hermesMemoryRestartForeignDenials", run)
        self.assertIn("docker exec \"$client_id\" /opt/hermes/.venv/bin/python", run)
        self.assertIn('"hermesMemoryVerified": False', workflow_path.read_text(encoding="utf-8"))
        self.assertIn('"externalNetwork": "disabled"', workflow_path.read_text(encoding="utf-8"))

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
        self.assertIn("chmod 0711 /opt/data", command)
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



def mounts(service: dict) -> dict[str, tuple[str, str, bool]]:
    """target -> (named volume or bind source, kind, read-only) for every mount of a Compose service."""
    result: dict[str, tuple[str, str, bool]] = {}
    for mount in service.get("volumes", []):
        if isinstance(mount, dict):
            result[mount["target"]] = (mount["source"], mount["type"], bool(mount.get("read_only")))
        else:
            source, target = mount.split(":")[:2]
            result[target] = (source, "volume", False)
    return result


class ClientRuntimeLimitsAndPolicyTests(unittest.TestCase):
    """The resource limits, restart policies, health checks and the exact set of mounts and networks are part of the isolation story, so they are pinned."""

    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / "compose.client.yaml").read_text(encoding="utf-8")
        cls.compose = yaml.safe_load(cls.text)
        cls.services = cls.compose["services"]
        cls.hermes = cls.services["hermes-client"]
        cls.worker = cls.services["hermes-provisioner"]

    def test_resource_limits_are_set_on_both_long_running_services(self):
        self.assertEqual((self.hermes["mem_limit"], self.hermes["cpus"], self.hermes["pids_limit"]), ("2g", 1.0, 256))
        self.assertEqual((self.worker["mem_limit"], self.worker["cpus"], self.worker["pids_limit"]), ("512m", 0.5, 128))
        self.assertEqual(self.hermes["stop_grace_period"], "60s")
        self.assertEqual(self.worker["stop_grace_period"], "30s")

    def test_both_long_running_services_restart_unless_an_operator_stopped_them(self):
        self.assertEqual(self.hermes["restart"], "unless-stopped")
        self.assertEqual(self.worker["restart"], "unless-stopped")
        # The one-shot initialisers must never come back by themselves.
        self.assertEqual(self.services["init-hermes-home"]["restart"], "no")
        self.assertEqual(self.services["init-worker-home"]["restart"], "no")

    def test_health_check_commands_and_timing(self):
        health = self.hermes["healthcheck"]
        self.assertEqual(health["test"][:3], ["CMD", "/opt/hermes/.venv/bin/python", "-c"])
        self.assertIn("http://127.0.0.1:8642/health", health["test"][3])
        worker_health = self.worker["healthcheck"]
        self.assertEqual(worker_health["test"], ["CMD", "/opt/iacquire-hermes/.venv/bin/python", "/opt/iacquire-hermes/worker.py", "--healthcheck"])
        for check in (health, worker_health):
            self.assertEqual((check["interval"], check["timeout"], check["retries"], check["start_period"]), ("30s", "5s", 3, "90s"))
        # The worker starts only once Hermes answers and the worker home exists.
        self.assertEqual(self.worker["depends_on"]["hermes-client"]["condition"], "service_healthy")
        self.assertEqual(self.worker["depends_on"]["init-worker-home"]["condition"], "service_completed_successfully")

    def test_container_logs_rotate(self):
        self.assertEqual(self.hermes["logging"], {"driver": "local", "options": {"max-size": "10m", "max-file": "3"}})
        self.assertEqual(self.worker["logging"], {"driver": "local", "options": {"max-size": "5m", "max-file": "3"}})

    def test_the_named_volume_set_is_exact(self):
        self.assertEqual(set(self.compose["volumes"]), {"hermes_home", "client_profiles", "worker_home"})
        hermes_mounts = mounts(self.hermes)
        self.assertEqual(
            {target: (kind, readonly) for target, (_, kind, readonly) in hermes_mounts.items()},
            {
                "/opt/data": ("volume", False),
                "/opt/data/profiles": ("volume", False),
                "/opt/data/config.yaml": ("bind", True),
                "/run/secrets/hermes_api_key": ("bind", True),
            },
        )
        self.assertEqual(hermes_mounts["/opt/data"][0], "hermes_home")
        self.assertEqual(hermes_mounts["/opt/data/profiles"][0], "client_profiles")
        worker_mounts = mounts(self.worker)
        self.assertEqual(
            {target: (kind, readonly) for target, (_, kind, readonly) in worker_mounts.items()},
            {
                "/opt/data": ("volume", False),
                "/opt/data/profiles": ("volume", False),
                "/opt/data/config.yaml": ("bind", True),
                "/run/secrets/hermes_api_key": ("bind", True),
                "/run/secrets/provisioner_token": ("bind", True),
                "/run/secrets/profile_model_env.json": ("bind", True),
            },
        )
        self.assertEqual(worker_mounts["/opt/data"][0], "worker_home")
        self.assertEqual(worker_mounts["/opt/data/profiles"][0], "client_profiles")
        # No bind mount reaches a host directory: every bind source is a variable naming one private file.
        for service in (self.hermes, self.worker):
            for source, kind, _ in mounts(service).values():
                if kind == "bind":
                    self.assertTrue(source.startswith("${"), source)

    def test_the_network_set_is_exact_and_the_private_network_is_internal(self):
        self.assertEqual(set(self.compose["networks"]), {"client_egress", "hermes_private"})
        self.assertIs(self.compose["networks"]["hermes_private"]["internal"], True)
        self.assertNotIn("internal", self.compose["networks"]["client_egress"])
        self.assertEqual(self.hermes["networks"], ["client_egress", "hermes_private"])
        # The worker has no network of its own: it shares the gateway's, so it reaches Hermes on loopback and the portal over that same egress.
        self.assertEqual(self.worker["network_mode"], "service:hermes-client")
        self.assertNotIn("networks", self.worker)
        for name in ("init-hermes-home", "init-worker-home"):
            self.assertEqual(self.services[name]["network_mode"], "none")

    def test_no_service_publishes_a_port_or_gets_privileges(self):
        for name, service in self.services.items():
            self.assertNotIn("ports", service, name)
            self.assertNotIn("privileged", service, name)
            self.assertNotIn("pid", service, name)
            self.assertNotIn("devices", service, name)
            self.assertNotEqual(service.get("network_mode"), "host", name)
            self.assertNotIn("docker.sock", str(service.get("volumes", [])), name)
        for needle in ("docker.sock", "privileged", "\n    ports:"):
            self.assertNotIn(needle, self.text)
        self.assertEqual(self.worker["cap_drop"], ["ALL"])
        self.assertNotIn("cap_add", self.worker)

    def test_the_gateway_allows_one_concurrent_run(self):
        config = yaml.safe_load((ROOT / "client-config.yaml.example").read_text(encoding="utf-8"))
        self.assertEqual(config["gateway"]["api_server"]["max_concurrent_runs"], 1)
        self.assertIs(config["gateway"]["multiplex_profiles"], True)

    def test_the_workers_profile_ceiling_is_wired_from_the_env_file_to_the_container(self):
        self.assertEqual(self.worker["environment"]["IACQUIRE_PROVISIONER_MAX_PROFILES"], "${IACQUIRE_PROVISIONER_MAX_PROFILES:-}")
        self.assertNotIn("IACQUIRE_PROVISIONER_MAX_PROFILES", self.hermes["environment"])
        env_example = (ROOT / "client.env.example").read_text(encoding="utf-8")
        match = re.search(r"(?m)^IACQUIRE_PROVISIONER_MAX_PROFILES=([0-9]*)$", env_example)
        self.assertIsNotNone(match)
        self.assertGreaterEqual(int(match.group(1)), 1)

    def test_no_secret_value_is_declared_inline_in_the_worker_environment(self):
        for name, value in self.worker["environment"].items():
            if "TOKEN" in name or "KEY" in name or "SECRET" in name:
                self.assertTrue(name.endswith("_FILE"), name)
                self.assertTrue(str(value).startswith("/run/secrets/"), name)


if __name__ == "__main__":
    unittest.main()
