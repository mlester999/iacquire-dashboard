from __future__ import annotations

import re
import sys


ERROR_RULES = (
    ("api_key_secret_unavailable", "api_key_secret_unavailable"),
    ("api_key_secret_invalid", "api_key_secret_invalid"),
    ("permission_denied", "permission denied"),
    ("permission_denied", "permissionerror"),
    ("operation_not_permitted", "operation not permitted"),
    ("missing_file", "no such file or directory"),
    ("read_only_write", "read-only file system"),
    ("address_in_use", "address already in use"),
    ("connection_refused", "connection refused"),
    ("timeout", "timed out"),
    ("python_traceback", "traceback (most recent call last)"),
    ("configuration_error", "invalid config"),
)

COMMANDS = (
    "usermod",
    "groupmod",
    "mkdir",
    "chown",
    "chmod",
    "touch",
    "printf",
    "tee",
    "rm",
    "sed",
    "mv",
    "cp",
    "s6-rc",
    "s6-setuidgid",
    "entrypoint-dispatch",
    "stage2-hook",
)

PATH_ROOTS = (
    ("etc", "/etc"),
    ("opt_data_config", "/opt/data/config.yaml"),
    ("opt_data_env", "/opt/data/.env"),
    ("opt_data_soul", "/opt/data/soul.md"),
    ("opt_data_profiles", "/opt/data/profiles"),
    ("opt_data", "/opt/data"),
    ("opt_hermes", "/opt/hermes"),
    ("run_s6_container_environment", "/run/s6/container_environment"),
    ("run_s6", "/run/s6"),
    ("run_secrets", "/run/secrets"),
    ("run_user", "/run/user"),
    ("var_run", "/var/run"),
    ("run", "/run"),
    ("tmp", "/tmp"),
)
RUNTIME_STOP_CODES = {"api_key_secret_unavailable", "api_key_secret_invalid"}


def classify_runtime_log(text: str) -> tuple[str, ...]:
    """Return a bounded set of safe error codes, never raw log content."""
    lines = text.lower().splitlines()
    codes: set[str] = set()

    for index, line in enumerate(lines):
        matched = {code for code, phrase in ERROR_RULES if phrase in line}
        if not matched:
            continue
        codes.update(matched)

        context = " ".join(lines[max(0, index - 2) : index + 1])
        for code in matched:
            for command in COMMANDS:
                if re.search(rf"\b{re.escape(command)}\b", context):
                    codes.add(f"{code}_command_{command.replace('-', '_')}")
            for root_name, root in PATH_ROOTS:
                if re.search(rf"{re.escape(root)}(?:/|\b)", context):
                    codes.add(f"{code}_path_{root_name}")

    codes.update(
        value
        for value in re.findall(
            r"hermes client runtime stopped: ([a-z0-9_]+)", text.lower()
        )
        if value in RUNTIME_STOP_CODES
    )
    if codes:
        return tuple(sorted(codes)[:16])
    if not text.strip():
        return ("no_runtime_output",)
    if any(term in text.lower() for term in ("error", "fatal", "exception", "failed")):
        return ("unclassified_runtime_error",)
    return ("runtime_output_without_error_marker",)


def main() -> None:
    print(",".join(classify_runtime_log(sys.stdin.read())))


if __name__ == "__main__":
    main()
