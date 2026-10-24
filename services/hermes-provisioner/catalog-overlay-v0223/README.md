# Hermes v0.22.3 catalog overlay

This overlay adds the iAcquire complete/challenge catalog contract to the official Hermes
v0.22.3 image. The base is pinned by multi-platform image-index digest and upstream source
commit `5b147ab036d6d19131bff8d20701b5001eab844a`. `UPSTREAM_SHA256SUMS` verifies the two
source files before replacement; `SHA256SUMS` verifies the reviewed patched files.

The API route uses Hermes' current `model_tools.get_tool_definitions` path and its registered
tool metadata. `update_last_resolved=False` keeps read-only catalog requests from changing the
global last-tool snapshot. Each response echoes a fresh caller challenge and reports an explicit
`complete` state. The upstream v0.22.3 capabilities endpoint advertises route descriptors as
`{"method":"GET","path":"/v1/tools"}`; the portal and worker accept this exact object form
and the existing array form, while rejecting extra fields, wrong methods, or other paths. Unknown
toolsets, unresolved schemas, enabled MCP inventory, or non-default context-engine inventory fail
closed. The client runtime explicitly selects `no_mcp`, and the worker retains its existing exact
toolset, provenance, and 6/6 readiness checks.

This is a narrowly scoped iAcquire compatibility layer; it is not upstream Hermes functionality.
It must pass the isolated image build and two-tenant runtime acceptance before production review.
