"""Tests for scripts/hermes-client-preflight.sh.

Runs the real script under bash with a PATH-shimmed fake `docker` (answering from a JSON fixture shaped like `docker inspect` output) and fixture secret files whose owner and mode
the shimmed `stat` reports. No Docker daemon and no root are needed. The all-green fixture must exit 0; each defect must exit 1 with its own FAIL line; and no fixture secret value may
appear in the output, ever. The shims are shared with test_ops_scripts.py.
"""
from __future__ import annotations

import json
import re
import subprocess
import unittest
import uuid
from pathlib import Path

from test_ops_scripts import BASH, REPO, ROOT, ShimWorld, posix

PREFLIGHT = REPO / "scripts" / "hermes-client-preflight.sh"
PROJECT = "iacquire-client-hermes"
GATEWAY = f"{PROJECT}-hermes-client-1"
WORKER = f"{PROJECT}-hermes-provisioner-1"
PRIVATE_NET = "iacquire-hermes-private"
GATEWAY_ID = str(uuid.uuid4())

API_KEY = "0123456789abcdef" * 4
TOKEN = "fixture-provisioner-token-" + "z" * 30
MODEL_KEY = "sk-FIXTURE-MODEL-SECRET-VALUE-424242"
SECRETS = [API_KEY, TOKEN, MODEL_KEY, "FIXTURE-CONFIG-CANARY-9"]


def pinned_base_image() -> str:
    text = (ROOT / "client.env.example").read_text(encoding="utf-8")
    match = re.search(r"(?m)^HERMES_BASE_IMAGE=(.+)$", text)
    assert match
    return match.group(1).strip()


def container(name: str, *, image_id: str, memory: int, cpus: int, pids: int, user: str, netmode: str, caps_add: list[str] | None, mounts: list[dict], networks: dict) -> dict:
    return {
        "Id": "id-" + name,
        "Image": image_id,
        "Config": {"User": user, "Image": "iacquire/runtime:0.22.5-v1"},
        "State": {"Running": True, "Health": {"Status": "healthy"}},
        "HostConfig": {
            "RestartPolicy": {"Name": "unless-stopped"}, "Memory": memory, "NanoCpus": cpus, "PidsLimit": pids, "ReadonlyRootfs": True, "Privileged": False,
            "CapDrop": ["ALL"], "CapAdd": caps_add, "SecurityOpt": ["no-new-privileges:true"], "NetworkMode": netmode, "PortBindings": {},
        },
        "NetworkSettings": {"Ports": {"8642/tcp": None}, "Networks": networks},
        "Mounts": mounts,
        "_ps": {"Image": "iacquire/runtime:0.22.5-v1", "Status": "Up 2 hours (healthy)", "Ports": "8642/tcp"},
    }


def bind(source: str, dest: str, rw: bool = False) -> dict:
    return {"Type": "bind", "Name": "", "Source": source, "Destination": dest, "RW": rw}


def volume(name: str, dest: str) -> dict:
    return {"Type": "volume", "Name": name, "Source": f"/var/lib/docker/volumes/{name}/_data", "Destination": dest, "RW": True}


class PreflightFixture:
    """A host that passes every check, built in a temporary directory; tests then break one thing."""

    def __init__(self) -> None:
        self.world = ShimWorld()
        root = self.world.root
        self.secrets = root / "host-secrets"
        self.secrets.mkdir()
        self.config = self.secrets / "config.yaml"
        self.api_key = self.secrets / "hermes-api-key"
        self.token = self.secrets / "provisioner-token"
        self.model = self.secrets / "profile-model-env.json"
        self.config.write_text("model:\n  provider: openai-api\n  model: approved-model-id\n# FIXTURE-CONFIG-CANARY-9\n", encoding="utf-8")
        self.api_key.write_text(API_KEY, encoding="utf-8")
        self.token.write_text(TOKEN, encoding="utf-8")
        self.model.write_text(json.dumps({"schemaVersion": 1, "environment": "OPENAI_API_KEY", "value": MODEL_KEY}), encoding="utf-8")
        self.set_meta(self.config, "0:10000", "440")
        self.set_meta(self.api_key, "0:10000", "440")
        self.set_meta(self.token, "10000:10000", "400")
        self.set_meta(self.model, "10000:10000", "400")
        self.env_file = root / "client.env"
        self.write_env()
        self.meminfo = root / "meminfo"
        self.meminfo.write_text("MemTotal:        8000000 kB\nMemAvailable:    6000000 kB\nSwapTotal:       1048576 kB\n", encoding="utf-8")
        self.world.extra_env.update({
            "PREFLIGHT_OFFLINE": "1", "PREFLIGHT_MEMINFO": posix(self.meminfo), "PREFLIGHT_MIN_DISK_GIB": "0", "PREFLIGHT_DISK_PATHS": posix(root),
            "HERMES_AGENCY_DATA_DIR": "/docker/agency-hermes/data",
        })
        gateway_mounts = [
            volume(f"{PROJECT}_hermes_home", "/opt/data"), volume(f"{PROJECT}_client_profiles", "/opt/data/profiles"),
            bind(posix(self.config), "/opt/data/config.yaml"), bind(posix(self.api_key), "/run/secrets/hermes_api_key"),
        ]
        worker_mounts = [
            volume(f"{PROJECT}_worker_home", "/opt/data"), volume(f"{PROJECT}_client_profiles", "/opt/data/profiles"),
            bind(posix(self.config), "/opt/data/config.yaml"), bind(posix(self.api_key), "/run/secrets/hermes_api_key"),
            bind(posix(self.token), "/run/secrets/provisioner_token"), bind(posix(self.model), "/run/secrets/profile_model_env.json"),
        ]
        state = self.world.state
        state["info"] = {"DockerRootDir": posix(root), "SecurityOptions": ["name=seccomp,profile=builtin", "name=cgroupns"], "Warnings": None}
        state["containers"][GATEWAY] = container(
            GATEWAY, image_id="sha256:" + "a" * 64, memory=2147483648, cpus=1000000000, pids=256, user="", netmode=f"{PROJECT}_client_egress",
            caps_add=["CHOWN", "KILL", "SETGID", "SETUID"], mounts=gateway_mounts, networks={f"{PROJECT}_client_egress": {}, PRIVATE_NET: {}})
        state["containers"][WORKER] = container(
            WORKER, image_id="sha256:" + "b" * 64, memory=536870912, cpus=500000000, pids=128, user="10000:10000", netmode="container:" + "id-" + GATEWAY,
            caps_add=None, mounts=worker_mounts, networks={})
        state["containers"]["agency-hermes-hermes-agent-1"] = {
            "Id": "id-neighbour", "HostConfig": {"Memory": 0}, "_ps": {"Image": "nousresearch/hermes-agent", "Status": "Up 3 days", "Ports": ""},
        }
        state["networks"] = {PRIVATE_NET: {"Internal": True}, f"{PROJECT}_client_egress": {"Internal": False}}
        state["volumes"] = {
            f"{PROJECT}_client_profiles": {"empty": False, "attached": [GATEWAY, WORKER]}, f"{PROJECT}_worker_home": {"empty": False, "attached": [WORKER]},
            f"{PROJECT}_hermes_home": {"empty": False, "attached": [GATEWAY]},
        }
        state["images"] = {"iacquire/hermes-client:0.22.5-v1": {"Id": "sha256:" + "a" * 64}, "iacquire/hermes-provisioner:0.22.5-v1": {"Id": "sha256:" + "b" * 64}}

    def close(self) -> None:
        self.world.close()

    def set_meta(self, path: Path, owner: str, mode: str) -> None:
        self.world.set_meta(path, owner, mode)

    def write_env(self, **overrides: str | None) -> None:
        values = {
            "HERMES_BASE_IMAGE": pinned_base_image(),
            "IACQUIRE_HERMES_IMAGE": "iacquire/hermes-client:0.22.5-v1",
            "IACQUIRE_PROVISIONER_IMAGE": "iacquire/hermes-provisioner:0.22.5-v1",
            "HERMES_CLIENT_CONFIG_FILE": posix(self.config),
            "HERMES_API_KEY_FILE": posix(self.api_key),
            "HERMES_PROFILE_MODEL_ENV_FILE": posix(self.model),
            "IACQUIRE_PROVISIONER_TOKEN_FILE": posix(self.token),
            "IACQUIRE_PROVISIONER_URL": "https://portal.example.test",
            "IACQUIRE_PROVISIONER_GATEWAY_ID": GATEWAY_ID,
            "IACQUIRE_PROVISIONER_MAX_PROFILES": "12",
        }
        for key, value in overrides.items():
            if value is None:
                values.pop(key, None)
            else:
                values[key] = value
        self.env_file.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")

    def run(self, *args: str) -> subprocess.CompletedProcess[str]:
        base = ["--env-file", posix(self.env_file), "--pin-file", posix(ROOT / "client.env.example"), "--compose-dir", posix(ROOT), "--project", PROJECT]
        return self.world.run(PREFLIGHT, *base, *args)

    def container_state(self, name: str) -> dict:
        return self.world.state["containers"][name]


def fails(result: subprocess.CompletedProcess[str]) -> list[str]:
    return [line.strip() for line in result.stdout.splitlines() if line.strip().startswith("[FAIL]")]


@unittest.skipUnless(BASH, "needs a POSIX bash")
class ClientPreflightTests(unittest.TestCase):
    def setUp(self):
        self.fx = PreflightFixture()
        self.addCleanup(self.fx.close)

    def assertFailsWith(self, result: subprocess.CompletedProcess[str], needle: str):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(any(needle in line for line in fails(result)), f"no FAIL line contains {needle!r}:\n" + "\n".join(fails(result)))

    def test_the_all_green_fixture_exits_zero_with_no_failure(self):
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(fails(result), [])
        self.assertRegex(result.stdout, r"ok=\d+ warn=\d+ fail=0")
        # The shapes it is meant to confirm are all reported.
        for needle in ("HERMES_BASE_IMAGE digest equals the reviewed pin", "secret file hermes-api-key has owner:group:mode 0:10000:440",
                       "hermes-client has a memory limit", "hermes-client publishes no host port", "the private network iacquire-hermes-private exists and is internal"):
            self.assertIn(needle, result.stdout)

    def test_no_fixture_secret_appears_in_the_output_of_a_passing_or_failing_run(self):
        runs = [self.fx.run(), self.fx.run("--offline-config")]
        self.fx.set_meta(self.fx.api_key, "0:10000", "644")
        self.fx.token.write_text(TOKEN + "\nextra FIXTURE-CONFIG-CANARY-9", encoding="utf-8")
        self.fx.config.write_text("model:\n  api_key: FIXTURE-CONFIG-CANARY-9\n", encoding="utf-8")
        runs.append(self.fx.run())
        for result in runs:
            for secret in SECRETS:
                self.assertNotIn(secret, result.stdout)
                self.assertNotIn(secret, result.stderr)
        self.assertEqual(runs[-1].returncode, 1)

    def test_a_published_port_fails(self):
        self.fx.container_state(GATEWAY)["NetworkSettings"]["Ports"] = {"8642/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8642"}]}
        self.assertFailsWith(self.fx.run(), "hermes-client publishes a host port")

    def test_a_wrong_secret_file_mode_fails(self):
        self.fx.set_meta(self.fx.api_key, "0:10000", "644")
        self.assertFailsWith(self.fx.run(), "secret file hermes-api-key has owner:group:mode 0:10000:644, wanted 0:10000:440")

    def test_a_wrong_secret_file_owner_fails(self):
        self.fx.set_meta(self.fx.token, "0:0", "400")
        self.assertFailsWith(self.fx.run(), "secret file provisioner-token has owner:group:mode 0:0:400")

    def test_an_uncapped_container_fails_for_each_missing_limit(self):
        gateway = self.fx.container_state(GATEWAY)["HostConfig"]
        gateway["Memory"] = 0
        result = self.fx.run()
        self.assertFailsWith(result, "hermes-client has no memory limit")
        gateway["Memory"], gateway["PidsLimit"], gateway["NanoCpus"] = 2147483648, 0, 0
        result = self.fx.run()
        self.assertFailsWith(result, "hermes-client has no process limit")
        self.assertTrue(any("hermes-client has no CPU limit" in line for line in fails(result)))

    def test_a_wrong_digest_fails_in_the_env_file_and_for_a_running_container_on_another_image(self):
        self.fx.write_env(HERMES_BASE_IMAGE="docker.io/nousresearch/hermes-agent@sha256:" + "0" * 64)
        self.assertFailsWith(self.fx.run(), "HERMES_BASE_IMAGE digest in the env file differs from the reviewed pin")
        self.fx.write_env()
        self.fx.world.state["images"]["iacquire/hermes-client:0.22.5-v1"] = {"Id": "sha256:" + "c" * 64}
        self.assertFailsWith(self.fx.run(), "hermes-client runs a different image than iacquire/hermes-client:0.22.5-v1 resolves to now")

    def test_a_tag_instead_of_a_digest_for_the_base_image_fails(self):
        self.fx.write_env(HERMES_BASE_IMAGE="docker.io/nousresearch/hermes-agent:latest")
        self.assertFailsWith(self.fx.run(), "HERMES_BASE_IMAGE is not the official Hermes image pinned by a sha256 digest")

    def test_a_missing_private_network_fails_and_a_non_internal_one_fails(self):
        del self.fx.world.state["networks"][PRIVATE_NET]
        self.assertFailsWith(self.fx.run(), f"the private network {PRIVATE_NET} does not exist")
        self.fx.world.state["networks"][PRIVATE_NET] = {"Internal": False}
        self.assertFailsWith(self.fx.run(), f"the private network {PRIVATE_NET} is not internal")

    def test_a_gateway_not_attached_to_the_private_network_fails(self):
        self.fx.container_state(GATEWAY)["NetworkSettings"]["Networks"] = {f"{PROJECT}_client_egress": {}}
        self.assertFailsWith(self.fx.run(), "hermes-client is not attached to the private network")

    def test_dangerous_mounts_and_privileges_fail(self):
        gateway = self.fx.container_state(GATEWAY)
        gateway["Mounts"].append(bind("/var/run/docker.sock", "/var/run/docker.sock", True))
        self.assertFailsWith(self.fx.run(), "hermes-client has a forbidden mount")
        gateway["Mounts"].pop()
        gateway["Mounts"].append(bind("/docker/agency-hermes/data/profiles", "/x"))
        result = self.fx.run()
        self.assertFailsWith(result, "agency-data")
        gateway["Mounts"].pop()
        gateway["HostConfig"]["Privileged"] = True
        gateway["HostConfig"]["CapAdd"] = ["SYS_ADMIN"]
        result = self.fx.run()
        self.assertFailsWith(result, "hermes-client is privileged")
        self.assertTrue(any("capabilities beyond the reviewed set: SYS_ADMIN" in line for line in fails(result)))

    def test_the_worker_must_not_see_the_hermes_home_or_have_its_own_network(self):
        worker = self.fx.container_state(WORKER)
        worker["Mounts"].append(volume(f"{PROJECT}_hermes_home", "/opt/hermes-home"))
        self.assertFailsWith(self.fx.run(), "hermes-provisioner has a forbidden mount: hermes-home")
        worker["Mounts"].pop()
        worker["HostConfig"]["NetworkMode"] = "bridge"
        self.assertFailsWith(self.fx.run(), "the worker has a network of its own")

    def test_another_container_on_the_profiles_volume_or_publishing_8642_fails(self):
        self.fx.world.state["volumes"][f"{PROJECT}_client_profiles"]["attached"].append("stranger-container")
        self.fx.world.state["containers"]["stranger-container"] = {"_ps": {"Image": "x", "Status": "Up", "Ports": "0.0.0.0:8642->8642/tcp"}, "HostConfig": {"Memory": 1}}
        result = self.fx.run()
        self.assertFailsWith(result, "another container uses the client profiles volume")
        self.assertTrue(any("publishes port 8642" in line for line in fails(result)))

    def test_an_unhealthy_gateway_and_a_stopped_gateway_fail_but_a_stopped_worker_only_warns(self):
        self.fx.container_state(GATEWAY)["State"]["Health"] = {"Status": "unhealthy"}
        self.assertFailsWith(self.fx.run(), "hermes-client health check reports unhealthy")
        self.fx.container_state(GATEWAY)["State"]["Health"] = {"Status": "healthy"}
        self.fx.container_state(WORKER)["State"]["Running"] = False
        stopped_worker = self.fx.run()
        self.assertEqual(stopped_worker.returncode, 0, stopped_worker.stdout)
        self.assertIn("[WARN] hermes-provisioner exists but is not running", stopped_worker.stdout)
        self.fx.container_state(GATEWAY)["State"]["Running"] = False
        self.assertFailsWith(self.fx.run(), "hermes-client is not running")

    def test_the_uncapped_neighbour_and_an_ordinary_client_network_are_warnings_not_failures(self):
        result = self.fx.run()
        self.assertIn("[WARN] neighbour agency-hermes-hermes-agent-1 has no memory limit", result.stdout)
        self.assertIn(f"[WARN] the client network {PROJECT}_client_egress is an ordinary bridge", result.stdout)
        self.assertEqual(result.returncode, 0)

    def test_without_an_agency_data_directory_the_mount_check_is_skipped_with_a_warning_and_never_matches_every_path(self):
        # An empty directory name must not turn "/*" into a pattern that flags every bind mount.
        self.fx.world.extra_env["HERMES_AGENCY_DATA_DIR"] = ""
        self.fx.container_state(GATEWAY)["Mounts"].append(bind("/srv/some/other/path", "/x"))
        result = self.fx.run()
        self.assertEqual(fails(result), [], result.stdout)
        self.assertIn("[WARN] HERMES_AGENCY_DATA_DIR is not set", result.stdout)
        self.assertEqual(result.returncode, 0)

    def test_secret_files_that_are_missing_symlinked_or_malformed_fail(self):
        self.fx.api_key.write_text("short", encoding="utf-8")
        self.assertFailsWith(self.fx.run(), "hermes-api-key is not exactly 64 lowercase hex characters")
        self.fx.api_key.write_text(API_KEY, encoding="utf-8")
        self.fx.config.write_text("model:\n  model: REPLACE_WITH_APPROVED_MODEL_ID\n", encoding="utf-8")
        self.assertFailsWith(self.fx.run(), "config.yaml still holds the REPLACE_WITH placeholder")
        self.fx.config.write_text("model:\n  api_key: FIXTURE-CONFIG-CANARY-9\n", encoding="utf-8")
        self.assertFailsWith(self.fx.run(), "config.yaml looks like it holds a credential")
        self.fx.model.write_text('{"nothing": 1}', encoding="utf-8")
        self.assertFailsWith(self.fx.run(), "profile-model-env.json does not have schemaVersion, environment and value")
        self.fx.model.unlink()
        self.assertFailsWith(self.fx.run(), "secret file profile-model-env.json does not exist")

    def test_env_file_placeholders_and_missing_values_fail(self):
        self.fx.write_env(IACQUIRE_PROVISIONER_GATEWAY_ID="00000000-0000-4000-8000-000000000000", IACQUIRE_PROVISIONER_URL="https://portal.example.invalid")
        result = self.fx.run("--offline-config")
        self.assertFailsWith(result, "IACQUIRE_PROVISIONER_GATEWAY_ID is not a real gateway UUID")
        self.assertTrue(any("IACQUIRE_PROVISIONER_URL is not a real HTTPS origin" in line for line in fails(result)))
        self.fx.write_env(IACQUIRE_PROVISIONER_TOKEN_FILE=None)
        self.assertFailsWith(self.fx.run("--offline-config"), "IACQUIRE_PROVISIONER_TOKEN_FILE is not set in the env file")

    def test_the_tunnel_and_egress_overlay_values_are_checked_when_present(self):
        self.fx.write_env(IACQUIRE_CLOUDFLARED_IMAGE="docker.io/cloudflare/cloudflared:latest")
        self.assertFailsWith(self.fx.run("--offline-config"), "IACQUIRE_CLOUDFLARED_IMAGE is not pinned by a sha256 digest")
        self.fx.write_env(IACQUIRE_EGRESS_PORTAL_HOST="portal.example.test", IACQUIRE_EGRESS_ALLOWED_HOSTS="api.openai.com", IACQUIRE_PROVISIONER_URL="https://other.example.test")
        result = self.fx.run("--offline-config")
        self.assertFailsWith(result, "IACQUIRE_PROVISIONER_URL does not name IACQUIRE_EGRESS_PORTAL_HOST")
        self.assertTrue(any("the portal host is not on IACQUIRE_EGRESS_ALLOWED_HOSTS" in line for line in fails(result)))
        self.fx.write_env(IACQUIRE_EGRESS_PORTAL_HOST="portal.example.test", IACQUIRE_EGRESS_ALLOWED_HOSTS="api.openai.com, portal.example.test")
        self.assertEqual(self.fx.run("--offline-config").returncode, 0)

    def test_offline_config_never_calls_docker_and_still_judges_files(self):
        result = self.fx.run("--offline-config")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.fx.world.docker_calls(), [])
        self.assertNotIn("Docker engine", result.stdout)
        self.fx.set_meta(self.fx.api_key, "0:10000", "666")
        self.assertFailsWith(self.fx.run("--offline-config"), "secret file hermes-api-key has owner:group:mode 0:10000:666")
        self.assertEqual(self.fx.world.docker_calls(), [])

    def test_before_install_turns_missing_runtime_objects_into_warnings_and_after_install_they_fail(self):
        state = self.fx.world.state
        state["containers"] = {}
        state["networks"] = {}
        state["volumes"] = {}
        after = self.fx.run()
        self.assertEqual(after.returncode, 1)
        for needle in ("container hermes-client (", "the private network", "the volume"):
            self.assertTrue(any(needle in line for line in fails(after)), needle)
        before = self.fx.run("--before-install")
        self.assertEqual(before.returncode, 0, before.stdout)
        self.assertIn("(expected before the install)", before.stdout)

    def test_docker_daemon_down_and_user_namespace_remapping_fail(self):
        self.fx.world.state["server_version"] = None
        self.assertFailsWith(self.fx.run(), "cannot talk to the Docker daemon")
        self.fx.world.state["server_version"] = "27.3.1"
        self.fx.world.state["info"]["SecurityOptions"] = ["name=seccomp", "name=userns"]
        self.assertFailsWith(self.fx.run(), "user namespace remapping is on")

    def test_low_memory_fails_and_no_swap_warns(self):
        self.fx.meminfo.write_text("MemAvailable:    1000000 kB\nSwapTotal:       0 kB\n", encoding="utf-8")
        result = self.fx.run()
        self.assertFailsWith(result, "memory available: 976 MiB (below the 2560 MiB of caps)")
        self.assertIn("[WARN] the host has no swap", result.stdout)

    def test_a_compose_file_that_publishes_a_port_fails_the_static_check(self):
        compose_dir = self.fx.world.root / "compose"
        compose_dir.mkdir()
        original = (ROOT / "compose.client.yaml").read_text(encoding="utf-8")
        (compose_dir / "compose.client.yaml").write_text(original.replace("    restart: unless-stopped\n    init: true\n    depends_on:", "    restart: unless-stopped\n    ports:\n      - 8642:8642\n    init: true\n    depends_on:", 1), encoding="utf-8")
        result = self.fx.world.run(PREFLIGHT, "--env-file", posix(self.fx.env_file), "--pin-file", posix(ROOT / "client.env.example"), "--compose-dir", posix(compose_dir), "--offline-config")
        self.assertFailsWith(result, "compose.client.yaml publishes a host port")

    def test_a_stale_or_missing_backup_warns_and_a_fresh_one_passes(self):
        backups = self.fx.world.root / "backups"
        backups.mkdir()
        self.fx.world.extra_env["CLIENT_BACKUP_DIR"] = posix(backups)
        self.assertIn("no backup header found", self.fx.run().stdout)
        (backups / "client-runtime-20261101T120000Z.header.txt").write_text("format=x\n", encoding="utf-8")
        self.assertIn("the newest backup is 0 day(s) old", self.fx.run().stdout)

    def test_usage_errors_exit_2(self):
        self.assertEqual(self.fx.world.run(PREFLIGHT).returncode, 2)
        self.assertEqual(self.fx.world.run(PREFLIGHT, "--env-file", posix(self.fx.env_file), "--wat").returncode, 2)

    def test_the_script_is_read_only_by_construction(self):
        body = PREFLIGHT.read_text(encoding="utf-8")
        docker_verbs = set(re.findall(r"\bD (?:compose )?([a-z]+)", body))
        self.assertLessEqual(docker_verbs - {"inspect", "version", "info", "ps", "network", "volume", "image", "compose"}, set())
        for verb in ("docker run", "docker rm", "docker stop", "docker start", "docker exec", "docker pull", "docker volume create", "docker network create", "rm -", "mkdir", "chmod ", "chown "):
            self.assertNotIn(verb, body)
        # The only redirects are to /dev/null or a file descriptor: nothing is ever written to a file.
        targets: set[str] = set()
        for line in body.splitlines():
            if line.lstrip().startswith("#"):
                continue
            code = re.sub(r"'[^']*'|\"[^\"]*\"", "", line)
            targets.update(re.findall(r"\d?>>?\s*(\S+)", code))
        self.assertLessEqual({target.rstrip(";)") for target in targets}, {"/dev/null", "&1", "&2"})


if __name__ == "__main__":
    unittest.main()
