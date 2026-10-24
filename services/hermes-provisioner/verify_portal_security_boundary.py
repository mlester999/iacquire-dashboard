"""Read-only security checks for the linked synthetic portal acceptance."""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Callable


class BoundaryCheckError(Exception):
    """A safe, fixed diagnostic category for a failed boundary assertion."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def require(condition: bool, code: str) -> None:
    if not condition:
        raise BoundaryCheckError(code)


def read_private_input(path: Path) -> str:
    try:
        info = path.lstat()
    except OSError:
        raise BoundaryCheckError("private_input_unavailable") from None

    require(stat.S_ISREG(info.st_mode), "private_input_not_regular")
    require(stat.S_IMODE(info.st_mode) == 0o400, "private_input_mode_mismatch")
    if os.name != "nt":
        require(info.st_uid == 10000 and info.st_gid == 10000, "private_input_owner_mismatch")

    try:
        value = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
        raise BoundaryCheckError("private_input_unreadable") from None
    require(bool(value), "private_input_empty")
    return value


def read_synthetic_credentials(temp_dir: Path) -> tuple[str, ...]:
    credentials = tuple(
        read_private_input(temp_dir / name)
        for name in ("hermes-api-key", "provisioner-token", "portal-admin-token")
    )
    try:
        model_config = json.loads(read_private_input(temp_dir / "profile-model-env.json"))
    except (json.JSONDecodeError, TypeError):
        raise BoundaryCheckError("private_model_config_invalid") from None
    require(
        isinstance(model_config, dict)
        and model_config.get("schemaVersion") == 1
        and model_config.get("environment") == "OPENAI_API_KEY"
        and isinstance(model_config.get("value"), str)
        and bool(model_config["value"]),
        "private_model_config_invalid",
    )
    return (*credentials, model_config["value"])


def _inspect_container(container_id: str) -> dict:
    require(bool(re.fullmatch(r"[0-9a-f]{12,64}", container_id)), "container_id_invalid")
    try:
        result = json.loads(subprocess.check_output(["docker", "inspect", container_id], text=True))
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        raise BoundaryCheckError("container_inspection_failed") from None
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict), "container_inspection_invalid")
    return result[0]


def _inspect_network(network_name: str) -> dict:
    require(bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", network_name)), "network_name_invalid")
    try:
        result = json.loads(subprocess.check_output(["docker", "network", "inspect", network_name], text=True))
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        raise BoundaryCheckError("network_inspection_failed") from None
    require(isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict), "network_inspection_invalid")
    return result[0]


def verify_boundary(
    portal: dict,
    client: dict,
    worker: dict,
    temp_dir: Path,
    repo_dir: Path,
    inspect_network: Callable[[str], dict],
) -> None:
    for item in (portal, client, worker):
        host = item.get("HostConfig") or {}
        mounts = item.get("Mounts") or []
        network_settings = item.get("NetworkSettings") or {}
        require(host.get("Privileged") is False, "privileged_container")
        require(
            all("docker.sock" not in str(mount.get("Source", "")) for mount in mounts),
            "docker_socket_mount",
        )
        require(
            all("/docker/hermes-agent-wpwm" not in str(mount.get("Source", "")) for mount in mounts),
            "production_data_mount",
        )
        ports = network_settings.get("Ports") or {}
        require(not any(ports.values()), "published_port")

    portal_config = portal.get("Config") or {}
    portal_host = portal.get("HostConfig") or {}
    worker_config = worker.get("Config") or {}
    worker_host = worker.get("HostConfig") or {}
    require(portal_config.get("User") == "10000:10000", "portal_user_mismatch")
    require(portal_host.get("ReadonlyRootfs") is True, "portal_root_filesystem_writable")
    require("ALL" in (portal_host.get("CapDrop") or []), "portal_capabilities_not_dropped")
    require(worker_config.get("User") == "10000:10000", "worker_user_mismatch")
    require(worker_host.get("ReadonlyRootfs") is True, "worker_root_filesystem_writable")
    require("ALL" in (worker_host.get("CapDrop") or []), "worker_capabilities_not_dropped")

    portal_env = "\n".join(portal_config.get("Env") or [])
    for name in ("DATABASE_URL=", "SUPABASE_SECRET_KEY=", "OPENAI_API_KEY=", "HERMES_PROVISIONER_TOKEN="):
        require(name not in portal_env, "forbidden_portal_environment_key")
    require("DATABASE_DRIVER=pglite-memory" in portal_env, "test_database_not_selected")
    require("NODE_ENV=test" in portal_env, "test_runtime_not_selected")
    require(not any(secret in portal_env for secret in read_synthetic_credentials(temp_dir)), "secret_in_portal_environment")

    portal_network_mode = portal_host.get("NetworkMode") or ""
    require(portal_network_mode.startswith("container:"), "portal_network_not_shared")
    require(portal_network_mode == worker_host.get("NetworkMode"), "portal_worker_network_mismatch")

    client_networks = (client.get("NetworkSettings") or {}).get("Networks") or {}
    require(bool(client_networks), "client_network_missing")
    for network_name in client_networks:
        network = inspect_network(network_name)
        require(network.get("Internal") is True, "external_client_network")

    expected_binds = {
        os.path.realpath(repo_dir): "/repository",
        os.path.realpath(temp_dir / "provisioner-token"): "/run/secrets/provisioner_token",
        os.path.realpath(temp_dir / "portal-admin-token"): "/run/secrets/portal_acceptance_admin",
        os.path.realpath(temp_dir / "acceptance-cert.pem"): "/run/secrets/acceptance-cert.pem",
        os.path.realpath(temp_dir / "acceptance-key.pem"): "/run/secrets/acceptance-key.pem",
    }
    actual_binds: dict[str, str] = {}
    for mount in portal.get("Mounts") or []:
        mount_type = mount.get("Type")
        target = mount.get("Destination")
        if mount_type == "bind":
            source = os.path.realpath(mount.get("Source") or "")
            require(source not in actual_binds, "duplicate_portal_bind")
            require(mount.get("RW") is False, "writable_portal_bind")
            actual_binds[source] = target
        else:
            require(mount_type == "tmpfs" and target == "/tmp", "unexpected_portal_mount")
    require(actual_binds == expected_binds, "portal_bind_allowlist_mismatch")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 5:
        print("PORTAL_SECURITY_BOUNDARY_FAIL: invalid_arguments")
        return 1

    portal_id, client_id, worker_id, temp_dir, repo_dir = args
    try:
        verify_boundary(
            _inspect_container(portal_id),
            _inspect_container(client_id),
            _inspect_container(worker_id),
            Path(temp_dir),
            Path(repo_dir),
            _inspect_network,
        )
    except BoundaryCheckError as error:
        print(f"PORTAL_SECURITY_BOUNDARY_FAIL: {error.code}")
        return 1
    except Exception:
        # Keep unexpected host and Docker details out of the Actions log.
        print("PORTAL_SECURITY_BOUNDARY_FAIL: unexpected_check_error")
        return 1

    print(
        "PORTAL_SECURITY_BOUNDARY_PASS: isolated test database, non-root/read-only app, "
        "internal networks, read-only synthetic inputs, no published ports or production mounts"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
