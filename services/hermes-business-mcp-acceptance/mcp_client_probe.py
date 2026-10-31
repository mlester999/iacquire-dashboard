#!/usr/bin/env python3
"""In-runtime probe for the business MCP compatibility proof (C6).

Run it with the Python of a pinned Hermes runtime (PYTHONPATH naming the Hermes source, HERMES_HOME naming a DISPOSABLE profile directory). It uses Hermes' own MCP client, the same
modules the gateway uses: it reads the profile's `mcp_servers` configuration, connects, discovers the tools and optionally calls one through the real tool registry.

    mcp_client_probe.py discover
    mcp_client_probe.py call <spec file>      the spec is JSON: {"tool": "<registered name>", "arguments": {...}, "expect": {"contains": [...], "excludes": [...]}}

It prints exactly one JSON object. It never prints the credential, a header, or any record text: only versions, tool names, toolsets, counts and booleans. Each `expect` string is
searched in the tool's reply and only whether it was found is reported.
"""
import importlib.metadata
import json
import logging
import re
import sys

REDACT = re.compile(r"(iamcp1\.[A-Za-z0-9_.-]+|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,})")


def redact(text: str, limit: int = 240) -> str:
    return REDACT.sub("<redacted>", str(text))[:limit]


class Captured(logging.Handler):
    """Keeps a bounded, redacted copy of the MCP client's warnings so a failed connection can be reported without its details leaking."""

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.lines = []

    def emit(self, record):
        if len(self.lines) < 12 and record.name.startswith(("tools.mcp", "mcp")):
            self.lines.append(f"{record.name}: {redact(record.getMessage())}")


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("discover", "call"):
        print(json.dumps({"ok": False, "error": "usage"}))
        return 2
    captured = Captured()
    logging.getLogger().addHandler(captured)

    report = {
        "hermes": {"python": sys.version.split()[0]},
        "mode": mode,
    }
    try:
        report["hermes"]["mcp_sdk"] = importlib.metadata.version("mcp")
    except Exception:
        report["hermes"]["mcp_sdk"] = None
    try:
        import tomllib
        import pathlib

        import tools.registry as registry_module  # noqa: F401  (anchors the source root)
        root = pathlib.Path(registry_module.__file__).resolve().parent.parent
        report["hermes"]["version"] = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    except Exception:
        report["hermes"]["version"] = None

    try:
        from tools.mcp_tool_discovery import discover_mcp_tools
        from tools.registry import registry

        names = sorted(discover_mcp_tools())
        report["discovered"] = [
            {
                "name": name,
                "toolset": getattr(registry.get_entry(name), "toolset", None),
                "arguments": sorted(((getattr(registry.get_entry(name), "schema", None) or {}).get("parameters") or {}).get("properties", {}).keys()),
            }
            for name in names
        ]
        report["warnings"] = captured.lines

        if mode == "call":
            with open(sys.argv[2], encoding="utf-8") as spec_file:
                spec = json.load(spec_file)
            name, arguments, expectations = spec["tool"], spec.get("arguments") or {}, spec.get("expect") or {}
            raw = registry.dispatch(name, arguments)
            text = raw if isinstance(raw, str) else json.dumps(raw)
            try:
                payload = json.loads(text)
            except Exception:
                payload = None
            error = payload.get("error") if isinstance(payload, dict) else None
            report["call"] = {
                "tool": name,
                "registered": registry.get_entry(name) is not None,
                "error": redact(error) if error else None,
                "bytes": len(text.encode("utf-8")),
                "contains": {needle: needle in text for needle in expectations.get("contains", [])},
                "excludes": {needle: needle not in text for needle in expectations.get("excludes", [])},
                "keys": sorted(payload.keys())[:12] if isinstance(payload, dict) else None,
            }
        report["ok"] = True
    except Exception as error:  # a failure to connect or discover is a result, not a crash
        report["ok"] = False
        report["error"] = f"{type(error).__name__}: {redact(error)}"
        report["warnings"] = captured.lines
    finally:
        try:
            from tools.mcp_tool_lifecycle import shutdown_mcp_servers

            shutdown_mcp_servers()
        except Exception:
            pass
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
