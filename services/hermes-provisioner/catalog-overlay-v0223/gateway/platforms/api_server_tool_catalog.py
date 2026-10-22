"""Build the complete model-facing tool catalog for one API-server platform profile.

This is a deliberately read-only projection of the same resolver and tool-definition path used
when an API-server run constructs its agent. It never starts a run, initializes a provider's
network resources, or mutates ``model_tools``' process-global compatibility snapshot.

The response shape is the iAcquireOS ``hermes.api_server.tool_catalog.v1`` contract:

    {
      "object": "list",
      "platform": "api_server",
      "complete": true,
      "incomplete_reason": null,
      "explicit_config_present": true,
      "enabled_toolsets": [...],
      "data": [
        {"name": "web_search", "description": "...", "parameters": {...},
         "provenance": {"source", "toolset", "requested_toolsets",
                        "source_server", "added_below_explicit_config"},
         "available": true|false   # MCP entries only
        }
      ]
    }

``complete`` is false whenever the projection knows it cannot enumerate the full surface: an
unresolved tool, a failed dynamic-provider lookup, an enabled MCP server that has never completed
discovery, or an unknown enabled toolset. The consumer must reject an incomplete catalog.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolCatalogResult:
    data: List[Dict[str, Any]]
    enabled_toolsets: List[str]
    explicit_config_present: bool
    complete: bool
    incomplete_reason: Optional[str]


def build_model_tool_catalog(config: Dict[str, Any], platform: str) -> ToolCatalogResult:
    """Resolve the model-callable tool surface and per-tool enablement provenance."""
    from hermes_cli.tools_config import (
        _RECENTLY_SHIPPED_TOOLSETS,
        _coerce_platform_toolsets_value,
        _get_platform_tools,
        enabled_mcp_server_names,
    )
    from model_tools import get_tool_definitions
    from tools.registry import registry
    from toolsets import TOOLSETS

    reasons: List[str] = []
    # _load_tools() discovers this profile's plugins before taking the tool snapshot. The
    # catalog must do the same or a profile plugin's tools would be silently omitted while
    # the projection still claimed completeness.
    try:
        from hermes_cli.plugins import discover_plugins

        discover_plugins()
    except Exception:
        logger.debug("Plugin discovery failed during tool-catalog build", exc_info=True)
        reasons.append("Plugin discovery failed")

    enabled = _get_platform_tools(config, platform)
    configured = (config.get("platform_toolsets") or {}).get(platform)
    configured_list = _coerce_platform_toolsets_value(configured, platform)
    explicit_config_present = isinstance(configured_list, list)
    explicit_names = {str(name) for name in configured_list} if explicit_config_present else set()
    configured_mcp = enabled_mcp_server_names(config)
    if "no_mcp" not in explicit_names:
        active_mcp = {
            name for name in configured_mcp
            if name in enabled or f"mcp-{name}" in enabled
        }
        if active_mcp:
            reasons.append("Enabled MCP tool inventory cannot be completely enumerated by this adapter")
    definitions = get_tool_definitions(
        enabled_toolsets=sorted(enabled),
        quiet_mode=True,
        skip_tool_search_assembly=True,
        update_last_resolved=False,
    )
    dynamic_definitions, dynamic_toolsets, dynamic_complete, dynamic_reason = (
        _dynamic_platform_tool_definitions(config, platform, enabled)
    )
    # The client-only runtime explicitly selects `no_mcp`. If a future config enables MCP,
    # fail closed above instead of claiming completeness from a partial registry snapshot.
    mcp_snapshot: Dict[str, Dict[str, Any]] = {}
    aliases = registry.get_registered_toolset_aliases()

    def _canonical_toolset(name: str) -> str:
        if name in aliases:
            return aliases[name]
        if name in mcp_snapshot or name in configured_mcp:
            return f"mcp-{name}"
        return name

    known_names = {
        (definition.get("function") or {}).get("name")
        for definition in definitions
    }
    for definition in dynamic_definitions:
        name = (definition.get("function") or {}).get("name")
        if not name or name in known_names:
            continue
        definitions.append(definition)
        known_names.add(name)

    if not dynamic_complete and dynamic_reason:
        reasons.append(dynamic_reason)

    explicit_canonical = {_canonical_toolset(name) for name in explicit_names}

    requested_by_canonical: Dict[str, List[str]] = {}
    for name in sorted(enabled):
        requested_by_canonical.setdefault(_canonical_toolset(name), []).append(name)

    if explicit_names:
        from toolsets import resolve_toolset

        for explicit_name in sorted(explicit_names):
            if explicit_name not in TOOLSETS:
                continue
            composite_tools = set(resolve_toolset(explicit_name))
            for canonical_toolset, requested_names in requested_by_canonical.items():
                static_tools = set(resolve_toolset(canonical_toolset, include_registry=False))
                if static_tools and static_tools.issubset(composite_tools):
                    explicit_canonical.add(canonical_toolset)
                    if explicit_name not in requested_names:
                        requested_names.append(explicit_name)

    # An enabled name the resolver does not recognize (and that is not the no_mcp sentinel or a
    # known MCP server) means the surface cannot be fully enumerated.
    known_enabled = (
        set(TOOLSETS)
        | set(registry.get_registered_toolset_names())
        | set(mcp_snapshot)
        | set(configured_mcp)
        | {f"mcp-{name}" for name in mcp_snapshot}
        | {"no_mcp"}
    )
    for name in sorted(enabled):
        if name not in known_enabled:
            reasons.append(f"Enabled toolset '{name}' is not recognized by this gateway build")

    data: List[Dict[str, Any]] = []
    unresolved: Set[str] = set()
    for definition in definitions:
        schema = definition.get("function") or {}
        name = schema.get("name")
        if not isinstance(name, str) or not name:
            unresolved.add(repr(name))
            continue
        entry = registry.get_entry(name)
        canonical_toolset = entry.toolset if entry else dynamic_toolsets.get(name)
        requested_toolsets = requested_by_canonical.get(canonical_toolset, [])
        explicitly_enabled = bool(
            canonical_toolset in explicit_canonical
            or explicit_names.intersection(requested_toolsets)
        )

        source_server = None
        if entry is None and canonical_toolset is None:
            source = "unresolved"
            unresolved.add(name)
        elif canonical_toolset and canonical_toolset.startswith("mcp-"):
            source = "mcp"
            source_server = canonical_toolset[len("mcp-"):]
        elif explicitly_enabled:
            source = "configurable"
        elif canonical_toolset in _RECENTLY_SHIPPED_TOOLSETS:
            source = "recently_shipped"
        else:
            source = "default_injected"

        row = dict(schema)
        if source == "mcp":
            # A registered MCP tool is callable (live or lazy reconnect on first call). Only
            # schemas restored from the snapshot after a disconnect are marked unavailable.
            row["available"] = bool(
                entry is not None
                or mcp_snapshot.get(source_server or "", {}).get("connected", False)
            )
        row["provenance"] = {
            "source": source,
            "toolset": canonical_toolset,
            "requested_toolsets": requested_toolsets,
            "source_server": source_server,
            "added_below_explicit_config": (
                explicit_config_present and not explicitly_enabled
            ),
        }
        data.append(row)

    if unresolved:
        reasons.append(
            "Tool(s) could not be attributed to a runtime toolset: "
            + ", ".join(sorted(unresolved)[:8])
        )

    data.sort(key=lambda item: str(item.get("name") or ""))
    unique_reasons = list(dict.fromkeys(reason for reason in reasons if reason))
    return ToolCatalogResult(
        data=data,
        enabled_toolsets=sorted(enabled),
        explicit_config_present=explicit_config_present,
        complete=not unique_reasons,
        incomplete_reason="; ".join(unique_reasons) if unique_reasons else None,
    )


def _dynamic_platform_tool_definitions(
    config: Dict[str, Any],
    platform: str,
    enabled_toolsets: Iterable[str],
) -> Tuple[List[Dict[str, Any]], Dict[str, str], bool, Optional[str]]:
    """Return agent-injected provider schemas that are absent from the static registry."""
    from agent.memory_manager_tools import memory_provider_tools_enabled, normalize_tool_schema

    definitions: List[Dict[str, Any]] = []
    toolsets: Dict[str, str] = {}
    reasons: List[str] = []

    enabled = sorted(str(name) for name in enabled_toolsets)
    if memory_provider_tools_enabled(enabled):
        try:
            from plugins.memory import load_memory_provider
            from tools.memory_tool import get_builtin_memory_config

            provider_name = str(get_builtin_memory_config(config).get("provider") or "").strip()
            if provider_name:
                provider = load_memory_provider(provider_name, register_skills=False)
                if provider is None:
                    reasons.append(
                        f"Memory provider '{provider_name}' is configured but could not be loaded"
                    )
                elif provider.is_available():
                    catalog_getter = getattr(provider, "get_tool_schemas_for_catalog", None)
                    if callable(catalog_getter):
                        raw_schemas = catalog_getter(platform=platform)
                    else:
                        raw_schemas = provider.get_tool_schemas()
                    for raw_schema in raw_schemas:
                        schema = normalize_tool_schema(raw_schema)
                        if schema is None:
                            reasons.append(
                                f"Memory provider '{provider_name}' returned a schema without a name"
                            )
                            continue
                        if schema["name"] not in toolsets:
                            definitions.append({"type": "function", "function": schema})
                            toolsets[schema["name"]] = "memory"
        except Exception:
            logger.debug("Failed to resolve memory-provider schemas for tool catalog", exc_info=True)
            reasons.append("Memory-provider tool enumeration failed")

    if "context_engine" in enabled:
        # Tool schemas for non-default engines depend on initialized model/runtime state. The
        # client-only allowlist excludes this toolset, so refusing completeness is safer than
        # approximating what an API run would expose.
        reasons.append("Context-engine tool inventory requires initialized runtime state")

    unique = list(dict.fromkeys(reasons))
    return definitions, toolsets, not unique, "; ".join(unique) if unique else None
