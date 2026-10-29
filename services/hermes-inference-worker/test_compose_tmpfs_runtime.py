#!/usr/bin/env python3
"""Verify Compose-rendered tmpfs options in disposable network-isolated Docker containers."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


EXPECTED_MOUNTS = (
    ("iacquire-hermes-inference-worker-operations-manager", 32),
    ("iacquire-hermes-inference-worker-lead-hunter", 32),
    ("iacquire-hermes-inference-worker-appointment-setter", 32),
    ("iacquire-hermes-inference-worker-sales-assistant", 32),
    ("iacquire-hermes-inference-worker-crm-manager", 32),
    ("iacquire-hermes-inference-worker-performance-analyst", 32),
    ("iacquire-deepseek-egress-proxy", 8),
)
EXPECTED_IMAGE = "iacquire/hermes-inference-worker:0.22.5-v1"

CHECK_MOUNT = r"""
import re
import sys
from pathlib import Path

expected_bytes = int(sys.argv[1])
matches = []
for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
    fields = line.split()
    separator = fields.index("-")
    if fields[4] == "/tmp":
        matches.append((fields[separator + 1], fields[5], fields[separator + 3]))

assert len(matches) == 1, f"expected one /tmp mount, found {len(matches)}"
filesystem, mount_options, super_options = matches[0]
assert filesystem == "tmpfs", f"expected tmpfs, got {filesystem}"
options = set(mount_options.split(",")) | set(super_options.split(","))
required = {"rw", "nosuid", "nodev", "noexec"}
assert required <= options, f"missing options: {sorted(required - options)}"
sizes = [option.removeprefix("size=") for option in options if option.startswith("size=")]
assert len(sizes) == 1, f"expected one size option, found {sizes}"
match = re.fullmatch(r"(\d+)([kKmMgGtT]?)(?:[bB])?", sizes[0])
assert match, f"unrecognized tmpfs size: {sizes[0]}"
unit = match.group(2).lower()
actual_bytes = int(match.group(1)) * (1024 ** " kmgt".index(unit))
assert actual_bytes == expected_bytes, f"expected {expected_bytes} bytes, got {actual_bytes}"

# --network none must leave the disposable process without a default route.
routes = Path("/proc/net/route").read_text(encoding="utf-8").splitlines()[1:]
default_routes = [line for line in routes if line.split()[1] == "00000000"]
assert not default_routes, f"unexpected default network route: {default_routes}"
print(f"TMPFS_RUNTIME_PASS options=rw,nosuid,nodev,noexec size_bytes={actual_bytes}")
"""


def run(command: list[str], *, env: dict[str, str], timeout: int = 90) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        details = "\n".join(part for part in (result.stdout, result.stderr) if part).strip()
        raise RuntimeError(f"command failed ({result.returncode}): {command!r}\n{details[-4000:]}")
    return result


def main() -> int:
    rendered_path = os.environ.get("COMPOSE_CONFIG_JSON")
    if not rendered_path:
        raise RuntimeError("COMPOSE_CONFIG_JSON must point to docker compose config --format json output")
    services = json.loads(Path(rendered_path).read_text(encoding="utf-8"))["services"]
    env = os.environ.copy()

    for service, size_mib in EXPECTED_MOUNTS:
        compose_service = services.get(service)
        if not isinstance(compose_service, dict):
            raise RuntimeError(f"rendered Compose service is missing: {service}")
        tmpfs = compose_service.get("tmpfs")
        expected_tmpfs = [f"/tmp:rw,noexec,nosuid,nodev,size={size_mib}m"]
        if tmpfs != expected_tmpfs:
            raise RuntimeError(f"{service}: rendered tmpfs mismatch: {tmpfs!r}")
        if compose_service.get("image") != EXPECTED_IMAGE:
            raise RuntimeError(f"{service}: unexpected rendered image")

        result = run(
            [
                "docker", "run", "--rm", "--network", "none", "--read-only",
                "--user", "10000:10000", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--tmpfs", tmpfs[0],
                "--entrypoint", "/opt/hermes/.venv/bin/python", EXPECTED_IMAGE,
                "-c", CHECK_MOUNT, str(size_mib * 1024 * 1024),
            ],
            env=env,
        )
        if "TMPFS_RUNTIME_PASS" not in result.stdout:
            raise RuntimeError(f"{service}: mount check did not report success")
        print(f"{service}: {result.stdout.strip().splitlines()[-1]}", flush=True)

    print("COMPOSE_TMPFS_RUNTIME_PASS: all six workers and the proxy used one correctly bounded /tmp mount with no network")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"COMPOSE_TMPFS_RUNTIME_FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
