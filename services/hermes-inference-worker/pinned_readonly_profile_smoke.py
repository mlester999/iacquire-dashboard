#!/usr/bin/env python3
"""Run the real worker path against a read-only profile mount with the pinned Hermes and no network.

The first production prompt audit failed with "Read-only file system: .../logs/agent.log": Hermes
writes its logs and state under its home directory, and the worker pointed that home at the
read-only profile. The other smokes use a writable synthetic home and could not see it. This one
needs the synthetic profile mounted read-only at /profiles/iacquire-lead-hunter (see the workflow).
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

import worker


ROLE = "lead_hunter"
PROFILE_ROOT = Path(os.environ.get("IACQUIRE_INTERNAL_PROFILE_ROOT", "/profiles"))
INSTRUCTIONS = "Synthetic approved role instructions for a read-only profile audit."
PROVIDER_INPUT = "Synthetic provider-only canary."
CHAT_INPUT = "Synthetic authenticated Chat canary."
DECOY = "SYNTHETIC_DECOY_SECRET"


def snapshot(directory: Path) -> dict[str, str]:
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


def fail(message: str) -> None:
    raise SystemExit(message)


# The worker discards the child's errors on purpose, so a refused audit says only "inference_failed".
# This smoke handles synthetic content only, so when it fails it re-runs the same child with the
# same environment and prints why, which is what makes a CI failure readable.
DIAGNOSTIC_CHILD = """
import io, json, sys, traceback
import inference_runner
sys.stdin = io.TextIOWrapper(io.BytesIO(sys.stdin.buffer.read()), encoding="utf-8")
try:
    inference_runner.main()
except BaseException as error:
    seen, cursor = [], error
    while cursor is not None and len(seen) < 4:
        seen.append(cursor)
        cursor = cursor.__cause__ or cursor.__context__
    for item in seen:
        frames = traceback.extract_tb(item.__traceback__)[-3:]
        where = " <- ".join(f"{frame.filename.rsplit('/', 1)[-1]}:{frame.lineno} {frame.name}" for frame in reversed(frames))
        print(f"child raised {type(item).__name__}: {str(item)[:300]} @ {where}", file=sys.stderr)
    raise SystemExit(3)
"""


def diagnose(captured: dict[str, Any], profile: Path) -> None:
    for label, with_empty_dotenv in (("worker home", False), ("worker home plus an empty .env", True)):
        home = worker.build_runtime_home(profile, "prompt_audit", tempfile.gettempdir())
        try:
            if with_empty_dotenv:
                (home / ".env").write_text("", encoding="ascii")
            env = dict(captured["env"])
            env["HERMES_HOME"] = str(home)
            env["PYTHONPATH"] = f"{env.get('PYTHONPATH', '/opt/hermes')}:{Path(worker.__file__).resolve().parent}"
            done = subprocess.run(
                [captured["python"], "-c", DIAGNOSTIC_CHILD],
                input=captured["input"], text=True, capture_output=True, env=env, cwd=captured["cwd"],
                timeout=90, check=False,
            )
            print(f"diagnostic [{label}]: exit {done.returncode}; entries {sorted(path.name for path in home.iterdir())}")
            print(f"diagnostic [{label}] stdout: {done.stdout[-400:]}")
            print(f"diagnostic [{label}] stderr: {done.stderr[-1200:]}")
        finally:
            shutil.rmtree(home, ignore_errors=True)


def main() -> None:
    profile = PROFILE_ROOT / worker.ROLE_PROFILES[ROLE]
    for name in ("SOUL.md", "config.yaml", ".env"):
        if not (profile / name).is_file():
            fail(f"synthetic profile is missing {name}")
    probe = profile / ".write-probe"
    try:
        probe.write_text("x", encoding="ascii")
    except OSError:
        pass
    else:
        probe.unlink()
        fail("the profile mount is writable, so this smoke would prove nothing")
    if DECOY not in (profile / ".env").read_text(encoding="utf-8"):
        fail("synthetic profile .env lost its decoy secret")
    before = snapshot(profile)
    soul_bytes = len((profile / "SOUL.md").read_bytes())

    os.environ["IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED"] = "true"
    os.environ["IACQUIRE_INTERNAL_PROFILE_ROOT"] = str(PROFILE_ROOT)
    for name in (
        "DEEPSEEK_API_KEY", "IACQUIRE_DEEPSEEK_EGRESS_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "all_proxy",
    ):
        os.environ.pop(name, None)

    # The same entry points the production worker uses: validation, the real runner, result checks.
    request = worker.validate_payload(json.dumps({
        "requestId": str(uuid.uuid4()),
        "actorId": str(uuid.uuid4()),
        "role": ROLE,
        "instructions": INSTRUCTIONS,
        "input": PROVIDER_INPUT,
        "chatInput": CHAT_INPUT,
        "history": [],
        "mode": "prompt_audit",
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
        print(f"the worker refused the audit: {error.code} ({error.status})")
        if captured:
            diagnose(captured, profile)
        fail("audit through the read-only profile was refused")
    finally:
        subprocess.run = real_run

    expected = {
        "ok": True,
        "mode": "prompt_audit",
        "role": ROLE,
        "profile": worker.ROLE_PROFILES[ROLE],
        "hermesVersion": "0.22.5",
        "soulBytes": soul_bytes,
        "syntheticProviderRequests": 2,
        "toolSchemas": 0,
        "toolCalls": 0,
    }
    if any(result.get(key) != value for key, value in expected.items()):
        fail("audit through the read-only profile returned the wrong identity or counts")
    provider_bytes, chat_bytes = result["providerOnlyMessageBytes"], result["chatMessageBytes"]
    floor = soul_bytes + len(INSTRUCTIONS.encode("utf-8"))
    if min(provider_bytes, chat_bytes) < floor:
        fail("audit message accounting is below SOUL plus instructions")
    if chat_bytes - provider_bytes != len(CHAT_INPUT.encode("utf-8")) - len(PROVIDER_INPUT.encode("utf-8")):
        fail("audit message delta does not match the two canary inputs")
    encoded = json.dumps(result)
    if INSTRUCTIONS in encoded or DECOY in encoded:
        fail("audit result carried prompt or profile text")

    # The profile is untouched and no throwaway home is left behind.
    if snapshot(profile) != before or sorted(path.name for path in profile.iterdir()) != sorted([".env", "SOUL.md", "config.yaml"]):
        fail("the read-only profile changed")
    leftovers = [name for name in os.listdir(tempfile.gettempdir()) if name.startswith("iacquire-hermes-home-")]
    if leftovers:
        fail("a throwaway Hermes home was left behind")

    # Inference gets a .env too, but only the DeepSeek settings, never the rest of the profile's secrets.
    home = worker.build_runtime_home(profile, "inference", tempfile.gettempdir())
    try:
        names = sorted(path.name for path in home.iterdir())
        dotenv = (home / ".env").read_text(encoding="ascii")
        if names != [".env", "SOUL.md", "config.yaml"] or DECOY in dotenv:
            fail("inference throwaway home has the wrong contents")
        if sorted(line.split("=", 1)[0] for line in dotenv.splitlines()) != ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]:
            fail("inference .env is not limited to the DeepSeek settings")
    finally:
        shutil.rmtree(home, ignore_errors=True)

    print(json.dumps({
        "ok": True,
        "hermes": "0.22.5",
        "profileMountReadOnly": True,
        "profileUnchanged": True,
        "providerCalls": 0,
        "toolSchemas": 0,
        "toolCalls": 0,
        "soulBytes": soul_bytes,
        "providerOnlyMessageBytes": provider_bytes,
        "chatMessageBytes": chat_bytes,
        "syntheticProviderRequests": 2,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
