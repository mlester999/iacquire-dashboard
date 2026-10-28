#!/usr/bin/env python3
"""No-network acceptance of the pinned Hermes AIAgent tool policy."""
from __future__ import annotations

import contextlib
import http.server
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


MODEL = "deepseek-v4-pro"
REPLY = "Synthetic pinned-Hermes response."


class FakeDeepSeekHandler(http.server.BaseHTTPRequestHandler):
    requests: list[dict[str, Any]] = []
    request_summaries: list[dict[str, Any]] = []
    server_version = "iAcquirePinnedHermesSmoke/1"
    sys_version = ""

    def log_message(self, _format: str, *args: Any) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802
        size = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(size))
        self.requests.append(request)
        messages = request.get("messages")
        self.request_summaries.append({
            "path": self.path,
            "model": request.get("model"),
            "stream": request.get("stream"),
            "maxTokens": request.get("max_tokens"),
            "maxCompletionTokens": request.get("max_completion_tokens"),
            "toolSchemaCount": len(request.get("tools", [])) if isinstance(request.get("tools", []), list) else -1,
            "toolChoice": request.get("tool_choice"),
            "messageCount": len(messages) if isinstance(messages, list) else -1,
            "messageRoles": [row.get("role") for row in messages if isinstance(row, dict)] if isinstance(messages, list) else [],
        })
        if self.path != "/v1/chat/completions" or request.get("model") != MODEL:
            self.send_error(404)
            return
        if request.get("tools") not in (None, []):
            self.send_error(400)
            return
        if request.get("max_tokens", request.get("max_completion_tokens", 999)) > 128:
            self.send_error(400)
            return
        self.send_response(200)
        if request.get("stream") is True:
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunks = [
                {"id": "synthetic-completion", "object": "chat.completion.chunk", "created": 1, "model": MODEL, "choices": [{"index": 0, "delta": {"role": "assistant", "content": REPLY}, "finish_reason": None}], "usage": None},
                {"id": "synthetic-completion", "object": "chat.completion.chunk", "created": 1, "model": MODEL, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}},
            ]
            for chunk in chunks:
                self.wfile.write(b"data: " + json.dumps(chunk).encode("utf-8") + b"\n\n")
            self.wfile.write(b"data: [DONE]\n\n")
            return
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        response = {
            "id": "synthetic-completion",
            "object": "chat.completion",
            "created": 1,
            "model": MODEL,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": REPLY}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25},
        }
        self.wfile.write(json.dumps(response).encode("utf-8"))


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="iacquire-hermes-smoke-") as raw_home:
        home = Path(raw_home)
        (home / "config.yaml").write_text(
            "model:\n  provider: deepseek\n  model: deepseek-v4-pro\nagent:\n  api_max_retries: 1\n  auto_recovery_cycles: 0\n",
            encoding="utf-8",
        )
        (home / ".env").write_text("", encoding="ascii")
        (home / "SOUL.md").write_text("Synthetic test SOUL canary: This employee helps internal iAcquireOS staff.", encoding="utf-8")
        os.environ["HERMES_HOME"] = raw_home
        os.environ["HOME"] = raw_home
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeDeepSeekHandler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        thread.start()
        try:
            from run_agent import AIAgent

            host, port = server.server_address
            with open(os.devnull, "w", encoding="utf-8") as sink_out, open(os.devnull, "w", encoding="utf-8") as sink_err:
              with contextlib.redirect_stdout(sink_out), contextlib.redirect_stderr(sink_err):
                agent = AIAgent(
                    base_url=f"http://{host}:{port}/v1",
                    api_key="synthetic-test-profile-key-012345",
                    provider="deepseek",
                    model=MODEL,
                    max_iterations=1,
                    enabled_toolsets=[],
                    save_trajectories=False,
                    verbose_logging=False,
                    quiet_mode=True,
                    max_tokens=128,
                    ephemeral_system_prompt="You are an internal employee in a synthetic, no-tool acceptance test.",
                    skip_context_files=True,
                    load_soul_identity=True,
                    skip_memory=True,
                    skip_background_review=True,
                    run_budget_seconds=15,
                    fallback_model=None,
                )
                try:
                    if getattr(agent, "provider", None) != "deepseek" or getattr(agent, "model", None) != MODEL:
                        raise SystemExit("pinned Hermes selected an unexpected provider/model")
                    if getattr(agent, "tools", None) not in ([], None) or getattr(agent, "valid_tool_names", set()):
                        raise SystemExit("pinned Hermes exposed a tool schema")

                    def deny_tool_dispatch(*_args: Any, **_kwargs: Any) -> None:
                        raise SystemExit("pinned Hermes attempted to dispatch a tool")

                    agent._execute_tool_calls = deny_tool_dispatch
                    result = agent.run_conversation("Say hello in one short sentence.")
                    request_summaries = FakeDeepSeekHandler.request_summaries
                    completion_indices = [
                        index for index, summary in enumerate(request_summaries)
                        if summary["path"] == "/v1/chat/completions"
                    ]
                    metadata_count = sum(summary["path"] == "/api/show" for summary in request_summaries)
                    unexpected_paths = [
                        summary["path"] for summary in request_summaries
                        if summary["path"] not in {"/api/show", "/v1/chat/completions"}
                    ]
                    if len(completion_indices) != 1 or metadata_count > 1 or unexpected_paths:
                        raise SystemExit(
                            "pinned Hermes made an unexpected number or type of synthetic requests; "
                            f"request metadata={json.dumps(request_summaries, separators=(',', ':'))}"
                        )
                    request = FakeDeepSeekHandler.requests[completion_indices[0]]
                    if request.get("tools") not in (None, []) or request.get("tool_choice") not in (None, "none"):
                        raise SystemExit("pinned Hermes sent a callable tool schema")
                    output_limits = [
                        request[key] for key in ("max_tokens", "max_completion_tokens") if key in request
                    ]
                    if not output_limits or any(
                        type(limit) is not int or limit < 1 or limit > 128 for limit in output_limits
                    ):
                        raise SystemExit(
                            f"pinned Hermes sent an invalid output token limit: {json.dumps(output_limits)}"
                        )
                    messages = request.get("messages")
                    if not isinstance(messages, list) or not any(
                        isinstance(row, dict) and "Synthetic test SOUL canary" in str(row.get("content", ""))
                        for row in messages
                    ):
                        raise SystemExit("pinned Hermes did not include the synthetic profile SOUL")
                    if not isinstance(result, dict) or result.get("completed") is not True or result.get("final_response") != REPLY:
                        raise SystemExit("pinned Hermes did not return the synthetic completion")
                    if int(getattr(agent, "session_api_calls", 0)) != 1:
                        raise SystemExit("pinned Hermes reported an unexpected provider request count")
                finally:
                    agent.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)
    print(json.dumps({"ok": True, "hermes": "v0.22.5", "provider": "deepseek", "requests": 1, "toolSchemas": 0, "toolDispatch": 0, "maxOutputTokens": 128}))


if __name__ == "__main__":
    main()
