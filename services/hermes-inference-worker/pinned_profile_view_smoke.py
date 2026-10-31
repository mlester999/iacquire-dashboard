#!/usr/bin/env python3
"""Run the real worker path against a worker-only profile view built by scripts/hermes-worker-profile-view.sh.

CI builds the view from synthetic live profiles that carry planted secrets (an API key, a chat token, a business MCP
credential), mounts it read-only at /profiles/iacquire-lead-hunter and runs this smoke with the pinned Hermes and no
network. It proves that what the worker is actually given is enough and no more:

  * the mount holds exactly SOUL.md, config.yaml and .env, and is read-only;
  * .env names are limited to the two DeepSeek settings, and no planted secret is anywhere in the mount;
  * the real worker path (validation, the real runner, result checks) completes a prompt audit from it with the pinned Hermes;
  * the throwaway home the worker builds for inference from it holds the same three files, DeepSeek-only .env included;
  * the mount is unchanged afterwards and no throwaway home is left behind.

It is run from a bind mount, not from the image, so the image stays byte-identical to the one in production.
IACQUIRE_SMOKE_PLANTED is a comma-separated list of the planted values that must not appear anywhere.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

import worker
from pinned_readonly_profile_smoke import diagnose, snapshot


ROLE = "lead_hunter"
PROFILE_ROOT = Path(os.environ.get("IACQUIRE_INTERNAL_PROFILE_ROOT", "/profiles"))
INSTRUCTIONS = "Synthetic approved role instructions for a profile-view audit."
PROVIDER_INPUT = "Synthetic provider-only canary."
CHAT_INPUT = "Synthetic authenticated Chat canary."
DEEPSEEK_NAMES = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    planted = [value for value in os.environ.get("IACQUIRE_SMOKE_PLANTED", "").split(",") if value]
    if len(planted) < 3:
        fail("IACQUIRE_SMOKE_PLANTED must list the planted secrets, so this smoke can prove they are absent")
    profile = PROFILE_ROOT / worker.ROLE_PROFILES[ROLE]

    entries = sorted(path.name for path in profile.iterdir())
    if entries != [".env", "SOUL.md", "config.yaml"]:
        fail(f"the worker's profile mount is not exactly the three files: {entries}")
    probe = profile / ".write-probe"
    try:
        probe.write_text("x", encoding="ascii")
    except OSError:
        pass
    else:
        probe.unlink()
        fail("the profile mount is writable, so this smoke would prove nothing")
    texts = {path.name: path.read_text(encoding="utf-8") for path in profile.iterdir()}
    names = sorted(line.split("=", 1)[0] for line in texts[".env"].splitlines() if line.strip())
    if names != DEEPSEEK_NAMES:
        fail(f"the view's .env is not limited to the DeepSeek settings: {names}")
    everything = "\n".join(texts.values())
    for value in planted:
        if value in everything:
            fail("a planted secret from the live profile is inside the worker's mount")
    if "iamcp1." in everything:
        fail("a business MCP credential is inside the worker's mount")
    before = snapshot(profile)
    soul_bytes = len((profile / "SOUL.md").read_bytes())

    os.environ["IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED"] = "true"
    os.environ["IACQUIRE_INTERNAL_PROFILE_ROOT"] = str(PROFILE_ROOT)
    for name in ("DEEPSEEK_API_KEY", "IACQUIRE_DEEPSEEK_EGRESS_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(name, None)

    request = worker.validate_payload(json.dumps({
        "requestId": str(uuid.uuid4()), "actorId": str(uuid.uuid4()), "role": ROLE,
        "instructions": INSTRUCTIONS, "input": PROVIDER_INPUT, "chatInput": CHAT_INPUT, "history": [], "mode": "prompt_audit",
    }).encode("utf-8"))
    captured: dict[str, Any] = {}
    real_run = subprocess.run

    def recording_run(command: list[str], **kwargs: Any) -> Any:
        captured.update(python=command[0], env=kwargs["env"], input=kwargs["input"], cwd=kwargs["cwd"])
        return real_run(command, **kwargs)

    subprocess.run = recording_run
    try:
        result: dict[str, Any] = worker.execute(request, worker.run_pinned_hermes)
    except worker.RequestError as error:
        subprocess.run = real_run
        print(f"the worker refused the audit from the view: {error.code} ({error.status})")
        if captured:
            diagnose(captured, profile)
        fail("audit from the worker-only view was refused")
    finally:
        subprocess.run = real_run

    expected = {
        "ok": True, "mode": "prompt_audit", "role": ROLE, "profile": worker.ROLE_PROFILES[ROLE], "hermesVersion": "0.22.5",
        "soulBytes": soul_bytes, "syntheticProviderRequests": 2, "toolSchemas": 0, "toolCalls": 0,
    }
    if any(result.get(key) != value for key, value in expected.items()):
        fail("audit from the worker-only view returned the wrong identity or counts")
    if any(value in json.dumps(result) for value in planted):
        fail("the audit result carried a planted secret")

    home = worker.build_runtime_home(profile, "inference", tempfile.gettempdir())
    try:
        home_names = sorted(path.name for path in home.iterdir())
        if home_names != [".env", "SOUL.md", "config.yaml"]:
            fail("the inference home built from the view has the wrong contents")
        home_text = "\n".join((home / name).read_text(encoding="utf-8") for name in home_names)
        if any(value in home_text for value in planted) or "iamcp1." in home_text:
            fail("a planted secret reached the inference home")
        if sorted(line.split("=", 1)[0] for line in (home / ".env").read_text(encoding="utf-8").splitlines()) != DEEPSEEK_NAMES:
            fail("the inference .env is not limited to the DeepSeek settings")
    finally:
        shutil.rmtree(home, ignore_errors=True)

    if snapshot(profile) != before or sorted(path.name for path in profile.iterdir()) != entries:
        fail("the worker-only view changed")
    if [name for name in os.listdir(tempfile.gettempdir()) if name.startswith("iacquire-hermes-home-")]:
        fail("a throwaway Hermes home was left behind")

    print(json.dumps({
        "ok": True, "hermes": "0.22.5", "viewEntries": entries, "viewReadOnly": True, "viewHoldsOnlyDeepSeekSettings": True,
        "plantedSecretsInView": 0, "auditThroughView": True, "providerCalls": 0, "toolSchemas": 0, "toolCalls": 0,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
