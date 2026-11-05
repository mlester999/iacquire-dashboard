"""Unit tests for the per-run no-tools boundary; no Hermes service or network is used."""

from __future__ import annotations

import ast
import asyncio
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).parent
OVERLAY = ROOT / "catalog-overlay-v0225"
MODULE_PATH = OVERLAY / "gateway" / "platforms" / "api_server_run_tool_scope.py"
SPEC = importlib.util.spec_from_file_location("api_server_run_tool_scope_test", MODULE_PATH)
assert SPEC and SPEC.loader
scope = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scope)


class RunToolScopeTests(unittest.TestCase):
    def test_scope_requires_matching_header_and_idempotency_body_marker(self):
        self.assertIsNone(scope.parse_run_tool_scope(None, None))
        self.assertEqual(scope.parse_run_tool_scope("no_tools", "no_tools"), "no_tools")
        for header, body in ((None, "no_tools"), ("no_tools", None), ("web", "web"), ("no_tools", "web")):
            with self.subTest(header=header, body=body), self.assertRaises(ValueError):
                scope.parse_run_tool_scope(header, body)

    def test_no_tools_scope_removes_every_toolset_and_normal_scope_is_unchanged(self):
        self.assertEqual(scope.toolsets_for_scope(["memory", "web"], "no_tools"), [])
        self.assertEqual(scope.toolsets_for_scope(["memory", "web"], None), ["memory", "web"])
        self.assertEqual(scope.toolsets_for_scope(None, None), None)

    def test_scope_is_refused_when_session_authority_owns_execution(self):
        self.assertTrue(scope.no_tool_scope_supported(None))
        self.assertFalse(scope.no_tool_scope_supported(object()))

    def test_scope_flows_into_the_long_lived_run_task_and_resets_afterward(self):
        async def read_scope():
            return scope.current_run_tool_scope()

        async def check():
            self.assertIsNone(scope.current_run_tool_scope())
            with scope.scoped_run_tool_scope("no_tools"):
                self.assertEqual(await asyncio.create_task(read_scope()), "no_tools")
            self.assertIsNone(scope.current_run_tool_scope())

        asyncio.run(check())

    def test_gateway_and_dispatch_overlay_wire_the_scope_before_tools_can_run(self):
        api_server = (OVERLAY / "gateway" / "platforms" / "api_server.py").read_text(encoding="utf-8")
        model_tools = (OVERLAY / "model_tools.py").read_text(encoding="utf-8")
        ast.parse(api_server)
        ast.parse(model_tools)
        self.assertIn("parse_run_tool_scope(", api_server)
        self.assertIn('"run_tool_scope_no_tools"', api_server)
        self.assertIn("toolsets_for_current_run(enabled_toolsets)", api_server)
        self.assertIn("current_run_tool_scope()", model_tools)
        self.assertIn("Tool execution is disabled for this run.", model_tools)


if __name__ == "__main__":
    unittest.main()
