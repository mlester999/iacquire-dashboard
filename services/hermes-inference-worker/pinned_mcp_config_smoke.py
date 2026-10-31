#!/usr/bin/env python3
"""Prove that a business MCP entry in a profile's config.yaml cannot change the inference worker.

A4a adds an `mcp_servers` entry to each live employee profile (and, in the profile's .env, that employee's business MCP
credential). The worker copies config.yaml into its throwaway Hermes home unchanged, so the pinned Hermes sees the entry.
In the pinned source MCP discovery is run by the CLI and gateway start-up code and deliberately not when an AIAgent is built,
so the entry should be inert for the worker. This smoke checks that on the real runtime, with no network:

  * the real worker path (validation, the real runner, result checks) gives the same audit with and without the entry;
  * the worker never connects to the address in the entry and never starts the command in it;
  * the audit stays inside the worker's request time budget;
  * the throwaway home for inference holds only SOUL.md, config.yaml and a DeepSeek-only .env, and the credential in the
    profile's .env is nowhere in it (config.yaml carries only the variable name).

It is run from a bind mount, not from the image, so the image stays byte-identical to the one in production.
Set IACQUIRE_SMOKE_HERMES_SRC (and IACQUIRE_HERMES_PYTHON) to run it outside the pinned image.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import worker


ROLE = "lead_hunter"
PROFILE = worker.ROLE_PROFILES[ROLE]
INSTRUCTIONS = "Synthetic approved role instructions for an MCP-entry audit."
PROVIDER_INPUT = "Synthetic provider-only canary."
CHAT_INPUT = "Synthetic authenticated Chat canary."
CREDENTIAL = "iamcp1.synthetic-credential-must-never-reach-a-worker.0000.0000.0000.AAAA"
DECOY = "SYNTHETIC_DECOY_SECRET=never-copy-this-value-0001"


class Listener:
    """Counts TCP connections made to a loopback port; it never answers."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        self._stop = False
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        self.sock.settimeout(0.2)
        while not self._stop:
            try:
                connection, _ = self.sock.accept()
            except (socket.timeout, OSError):
                continue
            self.connections += 1
            connection.close()

    def close(self) -> None:
        self._stop = True
        self.sock.close()


def fail(message: str) -> None:
    raise SystemExit(message)


def config_text(port: int | None, marker: Path | None, python: str) -> str:
    lines = ["model:", "  provider: deepseek", "  default: deepseek-flash", "agent:", "  api_max_retries: 1", "  auto_recovery_cycles: 0"]
    if port is not None and marker is not None:
        lines += [
            "mcp_servers:",
            "  iacquire_business:",
            f"    url: http://127.0.0.1:{port}/api/internal/hermes-business/mcp",
            "    headers:",
            '      Authorization: "Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}"',
            "    tool_timeout: 12",
            "  local_probe:",
            f"    command: {json.dumps(python)}",
            f"    args: [\"-c\", {json.dumps(f'open({str(marker)!r}, chr(119)).write(chr(120))')}]",
        ]
    return "\n".join(lines) + "\n"


def audit(work: Path, label: str) -> dict[str, Any]:
    request = worker.validate_payload(json.dumps({
        "requestId": str(uuid.uuid4()), "actorId": str(uuid.uuid4()), "role": ROLE,
        "instructions": INSTRUCTIONS, "input": PROVIDER_INPUT, "chatInput": CHAT_INPUT, "history": [], "mode": "prompt_audit",
    }).encode("utf-8"))
    extra_path = os.environ.get("IACQUIRE_SMOKE_HERMES_SRC")
    real_run = subprocess.run

    def patched_run(command: list[str], **kwargs: Any) -> Any:
        # Outside the image only: point the child at a local Hermes source tree and keep what Windows needs to start Python.
        if extra_path:
            env = dict(kwargs["env"])
            env["PYTHONPATH"] = os.pathsep.join([extra_path, str(Path(worker.__file__).resolve().parent)])
            for name in ("SystemRoot", "TEMP", "TMP", "USERPROFILE"):
                if os.environ.get(name):
                    env[name] = os.environ[name]
            kwargs["env"] = env
        return real_run(command, **kwargs)

    subprocess.run = patched_run
    started = time.monotonic()
    try:
        result = worker.execute(request, worker.run_pinned_hermes)
    except worker.RequestError as error:
        fail(f"{label}: the worker refused the audit: {error.code} ({error.status})")
    finally:
        subprocess.run = real_run
    result["seconds"] = round(time.monotonic() - started, 2)
    return result


def main() -> None:
    work = Path(tempfile.mkdtemp(prefix="iacquire-mcp-smoke-"))
    listener = Listener()
    try:
        profiles = work / "profiles"
        profile = profiles / PROFILE
        profile.mkdir(parents=True)
        (profile / "SOUL.md").write_text("Synthetic profile persona for an MCP-entry audit.\n", encoding="utf-8")
        (profile / ".env").write_text(
            f"{DECOY}\nIACQUIRE_BUSINESS_MCP_TOKEN={CREDENTIAL}\nDEEPSEEK_API_KEY=sk-synthetic-mcp-config-smoke-0123456789\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n",
            encoding="utf-8",
        )
        marker = work / "stdio-command-ran.marker"
        python = os.environ.get("IACQUIRE_HERMES_PYTHON", "/opt/hermes/.venv/bin/python")

        os.environ["IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED"] = "true"
        os.environ["IACQUIRE_INTERNAL_PROFILE_ROOT"] = str(profiles)
        os.environ["IACQUIRE_HERMES_TEMP_ROOT"] = str(work)
        for name in ("DEEPSEEK_API_KEY", "IACQUIRE_DEEPSEEK_EGRESS_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            os.environ.pop(name, None)

        (profile / "config.yaml").write_text(config_text(None, None, python), encoding="utf-8")
        baseline = audit(work, "baseline")
        (profile / "config.yaml").write_text(config_text(listener.port, marker, python), encoding="utf-8")
        with_entry = audit(work, "with mcp_servers")
        time.sleep(0.5)  # a late connection would show up here

        compared = ("ok", "mode", "role", "profile", "hermesVersion", "soulBytes", "providerOnlyMessageBytes", "chatMessageBytes", "syntheticProviderRequests", "toolSchemas", "toolCalls")
        if any(baseline.get(key) != with_entry.get(key) for key in compared):
            fail("the audit changed when the profile config gained an mcp_servers entry")
        if listener.connections:
            fail(f"the worker connected to the address in the mcp_servers entry ({listener.connections} connection(s))")
        if marker.exists():
            fail("the worker started the command in the mcp_servers entry")
        for label, result in (("baseline", baseline), ("with mcp_servers", with_entry)):
            if result["seconds"] >= worker.REQUEST_TIMEOUT_SECONDS:
                fail(f"{label}: the audit took {result['seconds']} s, not inside the worker's {worker.REQUEST_TIMEOUT_SECONDS} s budget")

        # The throwaway home the worker builds for inference: three files, the config unchanged, no credential anywhere in it.
        home = worker.build_runtime_home(profile, "inference", str(work))
        try:
            names = sorted(path.name for path in home.iterdir())
            if names != [".env", "SOUL.md", "config.yaml"]:
                fail("the inference home has the wrong contents")
            text = "\n".join((home / name).read_text(encoding="utf-8") for name in names)
            if CREDENTIAL in text or "iamcp1." in text or "SYNTHETIC_DECOY_SECRET" in text:
                fail("the business credential or another profile secret reached the worker's home")
            if (home / "config.yaml").read_bytes() != (profile / "config.yaml").read_bytes():
                fail("config.yaml was not copied unchanged")
            if "${IACQUIRE_BUSINESS_MCP_TOKEN}" not in (home / "config.yaml").read_text(encoding="utf-8"):
                fail("the smoke's config no longer refers to the credential by variable name, so it proves nothing")
            if sorted(line.split("=", 1)[0] for line in (home / ".env").read_text(encoding="utf-8").splitlines()) != ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]:
                fail("the inference .env is not limited to the DeepSeek settings")
        finally:
            shutil.rmtree(home, ignore_errors=True)

        print(json.dumps({
            "ok": True, "hermes": baseline["hermesVersion"], "identicalWithAndWithoutMcpEntry": True,
            "loopbackConnections": listener.connections, "stdioCommandRan": False,
            "secondsBaseline": baseline["seconds"], "secondsWithEntry": with_entry["seconds"],
            "providerOnlyMessageBytes": with_entry["providerOnlyMessageBytes"], "chatMessageBytes": with_entry["chatMessageBytes"],
            "credentialInWorkerHome": False, "providerCalls": 0,
        }, separators=(",", ":")))
    finally:
        listener.close()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
