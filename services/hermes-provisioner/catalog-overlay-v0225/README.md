# Hermes v0.22.5 catalog overlay

This overlay adds the iAcquire complete/challenge catalog contract to the official Hermes
v0.22.5 image. The base is pinned by multi-platform image-index digest
`sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d` and upstream source
commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`. `UPSTREAM_SHA256SUMS` verifies the two
source files before replacement; their hashes match the v0.22.5 source. `SHA256SUMS` verifies the
reviewed patched files.

The API route uses Hermes' current `model_tools.get_tool_definitions` path and its registered
tool metadata. `update_last_resolved=False` keeps read-only catalog requests from changing the
global last-tool snapshot. Each response echoes a fresh caller challenge and reports an explicit
`complete` state. The upstream v0.22.5 capabilities endpoint advertises route descriptors as
`{"method":"GET","path":"/v1/tools"}`; the portal and worker accept this exact object form
and the existing array form, while rejecting extra fields, wrong methods, or other paths. Unknown
toolsets, unresolved schemas, enabled MCP inventory, or non-default context-engine inventory fail
closed. The client runtime explicitly selects `no_mcp`, and the worker retains its existing exact
toolset, provenance, and 6/6 readiness checks.

This is a narrowly scoped iAcquire compatibility layer; it is not upstream Hermes functionality.
The previous v0.22.3 image locked Node.js v26.7.0, which is in the affected Node.js 26.x range for
the high-severity Brotli decoder issue in the [October 21, 2026 Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases/).
The v0.22.5 pin carries Node.js v26.12.1. This candidate must pass a fresh isolated image build and
two-tenant runtime acceptance before production review.
