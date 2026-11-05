"""Per-request tool scope for iAcquire's authenticated /v1/runs adapter."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator, Optional

NO_TOOLS_SCOPE = "no_tools"
TOOL_SCOPE_HEADER = "X-IAcquire-Tool-Scope"
TOOL_SCOPE_BODY_KEY = "iacquire_tool_scope"

_RUN_TOOL_SCOPE: ContextVar[Optional[str]] = ContextVar("iacquire_api_run_tool_scope", default=None)


def parse_run_tool_scope(header_value: Any, body_value: Any) -> Optional[str]:
    """Require the header and body marker to agree so idempotency includes the scope."""
    if header_value is None and body_value is None:
        return None
    if header_value == NO_TOOLS_SCOPE and body_value == NO_TOOLS_SCOPE:
        return NO_TOOLS_SCOPE
    raise ValueError("The iAcquire run tool scope must match in the request header and body.")


def no_tool_scope_supported(session_authority: Any) -> bool:
    """Session-authority runs execute on another owner and cannot be locally tool-scoped."""
    return session_authority is None


def current_run_tool_scope() -> Optional[str]:
    return _RUN_TOOL_SCOPE.get()


def toolsets_for_scope(enabled_toolsets: Optional[list[str]], scope: Optional[str]) -> Optional[list[str]]:
    """Keep the ordinary profile toolset unchanged; an explicit scope exposes no toolsets."""
    if scope == NO_TOOLS_SCOPE:
        return []
    return enabled_toolsets


def toolsets_for_current_run(enabled_toolsets: Optional[list[str]]) -> Optional[list[str]]:
    return toolsets_for_scope(enabled_toolsets, current_run_tool_scope())


@contextmanager
def scoped_run_tool_scope(scope: str) -> Iterator[None]:
    token = _RUN_TOOL_SCOPE.set(scope)
    try:
        yield
    finally:
        _RUN_TOOL_SCOPE.reset(token)
