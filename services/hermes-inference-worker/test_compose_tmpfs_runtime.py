#!/usr/bin/env python3
"""Verify Compose tmpfs options in disposable, network-isolated containers."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = ROOT / "services/hermes-inference-worker/compose.internal.yaml"
EXPECTED_MOUNTS = (
    ("iacquire-hermes-inference-worker-operations-manager", 32),
    ("iacquire-hermes-inference-worker-lead-hunter", 32),
    ("iacquire-hermes-inference-worker-appointment-setter", 32),
    ("iacquire-hermes-inference-worker-sales-assistant", 32),
    ("iacquire-hermes-inference-worker-crm-manager", 32),
    ("iacquire-hermes-inference-worker-performance-analyst", 32),
    ("iacquire-deepseek-egress-proxy", 8),
)

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
    project = f"hermes-tmpfs-check-{uuid.uuid4().hex[:10]}"
    compose = ["docker", "compose", "--project-name", project, "--file", str(COMPOSE_FILE)]

    with tempfile.TemporaryDirectory(prefix="hermes-tmpfs-runtime-") as temporary:
        temp = Path(temporary)
        profile_root = temp / "profiles"
        for profile in (
            "iacquire-operations-manager",
            "iacquire-lead-hunter",
            "iacquire-appointment-setter",
            "iacquire-sales-assistant",
            "iacquire-crm-manager",
            "iacquire-analyst",
        ):
            (profile_root / profile).mkdir(parents=True, exist_ok=True)

        synthetic_hmac = temp / "synthetic-hmac"
        synthetic_hmac.write_bytes(b"synthetic-test-only")
        env = os.environ.copy()
        env["IACQUIRE_INFERENCE_HMAC_FILE"] = str(synthetic_hmac)
        env["HERMES_PROFILE_BASE"] = str(profile_root)
        env["IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED"] = "false"

        try:
            for service, size_mib in EXPECTED_MOUNTS:
                result = run(
                    compose
                    + [
                        "run",
                        "--no-deps",
                        "--rm",
                        "--network",
                        "none",
                        "--entrypoint",
                        "/opt/hermes/.venv/bin/python",
                        service,
                        "-c",
                        CHECK_MOUNT,
                        str(size_mib * 1024 * 1024),
                    ],
                    env=env,
                )
                if "TMPFS_RUNTIME_PASS" not in result.stdout:
                    raise RuntimeError(f"{service}: mount check did not report success")
                print(f"{service}: {result.stdout.strip().splitlines()[-1]}", flush=True)
        finally:
            # Compose run removes its temporary containers; remove only this unique test project.
            subprocess.run(
                compose + ["down", "--remove-orphans", "--volumes"],
                env=env,
                text=True,
                capture_output=True,
                timeout=90,
            )

    print("COMPOSE_TMPFS_RUNTIME_PASS: all six workers and the proxy used one correctly bounded /tmp mount with no network")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"COMPOSE_TMPFS_RUNTIME_FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
