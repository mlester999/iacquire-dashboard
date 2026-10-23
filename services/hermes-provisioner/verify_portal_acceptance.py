#!/usr/bin/env python3
"""Verify synthetic portal evidence against files written by the real Hermes worker."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


PROFILES = Path("/opt/data/profiles")
STATE = Path("/opt/data/iacquire-provisioner-state")
EVIDENCE = Path(os.environ.get("ACCEPTANCE_RESULT_EVIDENCE_FILE", "/run/acceptance-results/portal-evidence.json"))
ROLES = {
    "operations_manager",
    "lead_hunter",
    "appointment_setter",
    "sales_assistant",
    "crm_manager",
    "performance_analyst",
}


class VerificationError(Exception):
    def __init__(self, code: str):
        super().__init__(code)


def require(condition: bool, code: str) -> None:
    if not condition:
        raise VerificationError(code)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def regular_file(path: Path) -> os.stat_result:
    require(not path.is_symlink(), "unexpected_symlink")
    info = path.stat()
    require(stat.S_ISREG(info.st_mode), "expected_regular_file")
    require(info.st_uid == os.getuid(), "file_owner_mismatch")
    require(info.st_gid == os.getgid(), "file_group_mismatch")
    require(stat.S_IMODE(info.st_mode) == 0o600, "private_file_mode_mismatch")
    return info


def read_private_text(path: Path) -> str:
    regular_file(path)
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(read_private_text(path))
    require(isinstance(value, dict), "invalid_json_object")
    return value


def env_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in read_private_text(path).splitlines():
        name, separator, value = line.partition("=")
        require(bool(separator) and name not in values, "profile_env_invalid")
        values[name] = value
    return values


def main() -> dict[str, int | str]:
    evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    require(isinstance(evidence, dict), "evidence_invalid")
    rows = evidence.get("profiles")
    require(isinstance(rows, list) and len(rows) == 12, "profile_count_mismatch")
    require(evidence.get("duplicateCallbackReplays") == 1, "callback_idempotency_mismatch")

    org_names: dict[str, str] = {}
    roles_by_org: dict[str, set[str]] = {}
    seen_profiles: set[str] = set()
    seen_agents: set[str] = set()
    seen_keys: set[str] = set()
    expected_jobs: set[str] = set()
    audit_profiles: set[str] = set()
    api_keys: list[str] = []
    profile_keys: list[tuple[str, str, str]] = []

    for row in rows:
        require(isinstance(row, dict), "profile_evidence_invalid")
        org_id = row.get("orgId")
        org_name = row.get("orgName")
        other_name = row.get("otherOrgName")
        profile = row.get("profile")
        role = row.get("role")
        agent_id = row.get("agentId")
        require(all(isinstance(value, str) and value for value in (org_id, org_name, other_name, profile, role, agent_id)), "profile_identity_invalid")
        require(row.get("status") == "online", "portal_health_not_online")
        require(row.get("credentialIdPresent") is True, "credential_missing")
        require(row.get("gatewayId"), "gateway_missing")
        require(row.get("activeConfigVersionId") == row.get("profileConfigVersionId"), "config_version_not_synced")
        require(row.get("activeConfigVersionId") == row.get("configVersionId"), "job_config_version_mismatch")
        require(profile.startswith("c-") and re.fullmatch(r"c-[a-z0-9][a-z0-9_-]{0,60}", profile), "profile_namespace_invalid")
        require(role in ROLES, "role_invalid")
        require(profile not in seen_profiles and agent_id not in seen_agents, "duplicate_profile_identity")
        seen_profiles.add(profile)
        seen_agents.add(agent_id)
        org_names[org_id] = org_name
        roles_by_org.setdefault(org_id, set()).add(role)

        profile_dir = PROFILES / profile
        require(not profile_dir.is_symlink() and profile_dir.is_dir(), "profile_directory_missing")
        require(stat.S_IMODE(profile_dir.stat().st_mode) == 0o700, "profile_directory_mode_mismatch")
        require(profile_dir.stat().st_uid == os.getuid(), "profile_directory_owner_mismatch")
        require(profile_dir.stat().st_gid == os.getgid(), "profile_directory_group_mismatch")

        soul_path = profile_dir / "SOUL.md"
        config_path = profile_dir / "config.yaml"
        marker_path = profile_dir / ".iacquire-provisioner.json"
        key_path = profile_dir / ".env"
        soul = read_private_text(soul_path)
        regular_file(config_path)
        config = config_path.read_bytes()
        marker = read_json(marker_path)
        values = env_values(key_path)

        require(sha256(soul.encode("utf-8")) == row.get("soulSha256"), "effective_soul_digest_mismatch")
        require(sha256(config) == row.get("effectiveConfigSha256"), "effective_config_digest_mismatch")
        require(org_name in soul and other_name not in soul, "cross_tenant_soul_leak")
        require(marker.get("profile") == profile, "marker_profile_mismatch")
        require(marker.get("orgId") == org_id and marker.get("agentId") == agent_id, "marker_tenant_mismatch")
        require(marker.get("gatewayId") == row.get("gatewayId"), "marker_gateway_mismatch")
        require(marker.get("lastJobId") == row.get("jobId"), "marker_job_mismatch")
        require(marker.get("sourceProvisionJobId") == row.get("sourceProvisionJobId"), "marker_source_job_mismatch")
        require(marker.get("configVersionId") == row.get("activeConfigVersionId"), "marker_config_mismatch")
        require(marker.get("soulSha256") == row.get("soulSha256"), "marker_soul_mismatch")
        require(marker.get("policyConfigSha256") == row.get("policyConfigSha256"), "marker_policy_mismatch")
        require(marker.get("effectiveConfigSha256") == row.get("effectiveConfigSha256"), "marker_effective_config_mismatch")
        require(values.get("API_SERVER_KEY") and re.fullmatch(r"[0-9a-f]{64}", values["API_SERVER_KEY"]), "profile_key_invalid")
        key = values["API_SERVER_KEY"]
        key_hash = sha256(key.encode("ascii"))
        require(key_hash == row.get("apiKeySha256"), "portal_profile_key_hash_mismatch")
        require(key_hash not in seen_keys, "duplicate_profile_key")
        seen_keys.add(key_hash)
        api_keys.append(key)
        profile_keys.append((org_id, profile, key))

        source_job = row.get("sourceProvisionJobId")
        current_job = row.get("jobId")
        require(isinstance(source_job, str) and isinstance(current_job, str), "job_identity_invalid")
        expected_jobs.add(source_job)
        expected_jobs.add(current_job)
        audit_profiles.add(profile)

    require(len(org_names) == 2 and all(roles == ROLES for roles in roles_by_org.values()), "tenant_role_matrix_mismatch")
    require(len(seen_profiles) == 12 and len(seen_agents) == 12 and len(seen_keys) == 12, "isolation_count_mismatch")
    require(sum(1 for row in rows if row.get("jobKind") == "sync") == 1, "configuration_sync_missing")

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def profile_route_status(profile: str, key: str) -> int:
        request = urllib.request.Request(
            f"http://127.0.0.1:8642/p/{profile}/v1/capabilities",
            headers={"Authorization": "Bearer " + key, "Accept": "application/json"},
        )
        try:
            with opener.open(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
        except Exception:
            raise VerificationError("profile_route_probe_failed") from None

    wrong_profile_key_denials = 0
    cross_tenant_denials = 0
    for org_id, profile, key in profile_keys:
        require(profile_route_status(profile, key) == 200, "profile_key_authentication_failed")
        for other_org_id, other_profile, other_key in profile_keys:
            if other_profile == profile:
                continue
            require(profile_route_status(profile, other_key) in {401, 403, 404}, "profile_key_scope_failed")
            wrong_profile_key_denials += 1
            if other_org_id != org_id:
                cross_tenant_denials += 1
    require(wrong_profile_key_denials == 132 and cross_tenant_denials == 72, "profile_key_isolation_count_mismatch")

    model_config = json.loads(read_private_text(Path("/run/secrets/profile_model_env.json")))
    secret_values = [
        read_private_text(Path("/run/secrets/provisioner_token")).strip(),
        read_private_text(Path("/run/secrets/hermes_api_key")).strip(),
        str(model_config.get("value", "")),
        *api_keys,
    ]
    require(all(len(value) >= 16 for value in secret_values), "synthetic_secret_missing")

    audit_path = STATE / "audit.jsonl"
    regular_file(audit_path)
    audit_text = audit_path.read_text(encoding="utf-8")
    require(all(value not in audit_text for value in secret_values), "audit_secret_leak")
    matching: list[dict[str, Any]] = []
    for line in audit_text.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            raise VerificationError("audit_record_invalid") from None
        if isinstance(event, dict) and event.get("jobId") in expected_jobs:
            matching.append(event)
    require({item.get("jobId") for item in matching if item.get("outcome") == "succeeded"} == expected_jobs, "audit_success_evidence_mismatch")
    require({item.get("profile") for item in matching} == audit_profiles, "audit_profile_matrix_mismatch")
    require(all(item.get("orgId") in org_names for item in matching), "audit_tenant_mismatch")

    return {
        "result": "PORTAL_HERMES_E2E_PASS",
        "syntheticTenants": len(org_names),
        "uniqueProfiles": len(seen_profiles),
        "rolesPerTenant": len(ROLES),
        "effectiveSoulsVerified": len(seen_profiles),
        "isolatedProfileKeys": len(seen_keys),
        "crossTenantDenials": cross_tenant_denials,
        "wrongProfileKeyDenials": wrong_profile_key_denials,
        "portalHealthChecksOnline": len(rows),
        "configurationSyncChecks": 1,
        "idempotentCallbackReplays": evidence["duplicateCallbackReplays"],
        "auditSucceededJobs": len(expected_jobs),
        "auditSecretLeaks": 0,
    }


if __name__ == "__main__":
    try:
        result = main()
    except VerificationError as error:
        print("PORTAL_HERMES_E2E_FAIL: " + str(error), file=sys.stderr)
        raise SystemExit(1) from None
    print("PORTAL_HERMES_E2E_PASS: " + json.dumps(result, sort_keys=True, separators=(",", ":")))
