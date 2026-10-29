#!/usr/bin/env python3
"""Verify the prompt-audit path with the pinned Hermes runtime and no external network."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import inference_runner


ROLE = "lead_hunter"
PROFILE = "iacquire-lead-hunter"
SOUL_SENTINEL = "Synthetic prompt-audit SOUL marker: never return this text."


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="iacquire-hermes-prompt-audit-") as raw_home:
        home = Path(raw_home)
        home.joinpath("config.yaml").write_text(
            "model:\n  provider: deepseek\n  model: deepseek-v4-pro\nagent:\n  api_max_retries: 1\n  auto_recovery_cycles: 0\n",
            encoding="utf-8",
        )
        home.joinpath(".env").write_text("", encoding="ascii")
        soul = home / "SOUL.md"
        soul.write_text(SOUL_SENTINEL, encoding="utf-8")
        os.environ["HERMES_HOME"] = raw_home
        os.environ["HOME"] = raw_home
        os.environ["IACQUIRE_INTERNAL_PROFILE"] = PROFILE
        os.environ["IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED"] = "true"
        for name in (
            "DEEPSEEK_API_KEY", "IACQUIRE_DEEPSEEK_EGRESS_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
            "http_proxy", "https_proxy", "all_proxy",
        ):
            os.environ.pop(name, None)
        result = inference_runner.run_prompt_audit({
            "requestId": "synthetic-prompt-audit",
            "role": ROLE,
            "instructions": "Synthetic approved role instructions for a no-tool prompt audit.",
            "input": "Synthetic provider-only canary.",
            "chatInput": "Synthetic authenticated Chat canary.",
            "history": [],
            "mode": "prompt_audit",
        }, soul)
        encoded = json.dumps(result, separators=(",", ":"))
        expected = {
            "ok": True,
            "mode": "prompt_audit",
            "role": ROLE,
            "profile": PROFILE,
            "hermesVersion": "0.22.5",
            "soulBytes": len(SOUL_SENTINEL.encode("utf-8")),
            "toolSchemas": 0,
            "toolCalls": 0,
        }
        if any(result.get(key) != value for key, value in expected.items()):
            raise SystemExit("pinned Hermes prompt-audit identity or no-tool check failed")
        provider_bytes = result.get("providerOnlyMessageBytes")
        chat_bytes = result.get("chatMessageBytes")
        app_bytes = len("Synthetic approved role instructions for a no-tool prompt audit.".encode("utf-8"))
        if type(provider_bytes) is not int or type(chat_bytes) is not int or min(provider_bytes, chat_bytes) < app_bytes + result["soulBytes"]:
            raise SystemExit("pinned Hermes prompt-audit message accounting failed")
        input_delta = len("Synthetic authenticated Chat canary.".encode("utf-8")) - len("Synthetic provider-only canary.".encode("utf-8"))
        if chat_bytes - provider_bytes != input_delta:
            raise SystemExit("pinned Hermes prompt-audit message delta failed")
        if SOUL_SENTINEL in encoded or "Synthetic approved role instructions" in encoded:
            raise SystemExit("prompt audit returned prompt text")
        print(json.dumps({
            "ok": True,
            "hermes": "0.22.5",
            "providerCalls": 0,
            "toolSchemas": 0,
            "toolCalls": 0,
            "providerOnlyMessageBytes": provider_bytes,
            "chatMessageBytes": chat_bytes,
            "syntheticProviderRequests": 2,
            "promptTextReturned": False,
        }, separators=(",", ":")))


if __name__ == "__main__":
    main()
