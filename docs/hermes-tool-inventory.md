# Hermes complete tool-inventory verification

Status: **implemented and fail-closed; the six internal employees remain in provisioning because the
deployed gateway does not yet expose the complete runtime tool catalog.**

This page records the contract, the verification rules, the live evidence and the exact remaining
infrastructure changes. It contains no API keys, profile identifiers, organization names or customer
data.

## The problem with `GET /v1/toolsets`

`GET /v1/toolsets` is the documented *advertised configurable* inventory. In Hermes it calls
`_get_platform_tools(config, "api_server", include_default_mcp_servers=False)`: default MCP servers
are deliberately excluded. The endpoint also cannot prove which plugin, release-backfill,
runtime-provider or Tool Search deferrable tools the constructed agent will actually receive. It is
useful for detecting the known restricted toolsets, but it is **not** proof of the complete effective
inventory.

`GET /v1/tools?platform=api_server` is the upstream complete-catalog proposal
([issue #92711](https://github.com/NousResearch/hermes-agent/issues/92711),
[PR #92729](https://github.com/NousResearch/hermes-agent/pull/92729)). It resolves the same platform
toolsets and availability checks used when constructing an agent, returns the pre-Tool-Search
catalog (every deferred tool remains callable through the bridge), and includes per-tool provenance:

```json
{
  "object": "list",
  "platform": "api_server",
  "contract": "hermes.api_server.tool_catalog.v1",
  "complete": true,
  "incomplete_reason": null,
  "explicit_config_present": true,
  "enabled_toolsets": ["memory", "session_search", "todo", "vision", "web"],
  "challenge": "<echo of X-Hermes-Inventory-Challenge>",
  "generated_at": "2026-10-18T…Z",
  "expires_at": "2026-10-18T…Z",
  "data": [
    {
      "name": "web_search",
      "description": "…",
      "parameters": { },
      "provenance": {
        "source": "configurable",
        "toolset": "web",
        "requested_toolsets": ["web"],
        "source_server": null,
        "added_below_explicit_config": false
      }
    }
  ]
}
```

`complete` is the gateway's certification that it enumerated the full model-facing surface. If it
is absent or false, the portal refuses the catalog. This is deliberately stricter than the upstream
PR, which has no completeness signal and can silently omit a failed dynamic provider or an
MCP server that never completed discovery.

The deployed gateway (Hermes `0.21.5`, observed 2026-10-18) does not register this route: an
authenticated request returns HTTP 404 (`Unknown or unconfigured profile`). Its
`GET /v1/capabilities` also returns an empty `endpoints` object, so the portal probes
`/v1/tools` directly instead of trusting a capability advertisement.

## What the running process can actually provide

Read-only probes against the authenticated profile route on 2026-10-18:

| Surface | Observed | Usable as complete-inventory proof? |
| --- | --- | --- |
| `GET /v1/capabilities` | `hermes.api_server.capabilities`, authenticated, run/SSE/status/stop/approval features, `endpoints: {}` | No inventory payload |
| `GET /v1/models` | The profile's primary Hermes identity | Identity only |
| `GET /v1/toolsets` | 29 configurable toolsets, 5 enabled, 6 enabled tools; default MCP servers excluded by design | No — partial by construction |
| `GET /v1/tools?platform=api_server` | HTTP 404 | No — route absent in 0.21.5 |
| `GET /v1/skills` | HTTP 500 (server error) | No — skills are not callable tools |
| `GET /health/detailed` | Hermes `0.21.5`, gateway running | Diagnostics only; unauthenticated |
| TUI gateway `tools.list` / `tools.configure` / `mcp.*` | Not exposed by the API server | No; the portal must not invent an HTTP route for it |

Because no authenticated API-server surface returns the full model-facing tool set, the portal
cannot honestly mark an employee ready on the current deployment. The smallest compatibility
change is the upstream `/v1/tools` endpoint; the portal already implements its client and
verification.

## What the portal implements

| Piece | Location |
| --- | --- |
| Reviewed toolsets, disabled toolsets, Tool Search/connector names | `src/server/integrations/hermes/tool-policy.ts` |
| Typed `GET /v1/tools` client | `src/server/integrations/hermes/client.ts` (`getToolCatalog`) |
| Complete-inventory verifier, digest, attestation, freshness, change detection | `src/server/integrations/hermes/inventory.ts` |
| Persisted attestation columns | `supabase/migrations/0059_hermes_tool_inventory.sql` |
| Health check and run gate | `src/server/workforce/service.ts`, `src/server/integrations/hermes/client.ts` (`startRun`) |
| Integration inspection | `src/server/integrations/inspection.ts` |
| Read-only live audit | `scripts/hermes-live-audit.ts` |
| Super Admin diagnostics | `/admin/workforce` and `/admin/workforce/[slug]` |

### Verification rules (all must hold)

1. The profile is authenticated and `GET /v1/capabilities` returns
   `hermes.api_server.capabilities` with `authenticated: true`.
2. `GET /v1/tools?platform=api_server` resolves successfully. A 404 is reported as
   `contract_unavailable`, not as an empty inventory.
3. The response has `complete: true`. An absent or false flag is `inventory_incomplete`; the
   gateway must not omit a failed dynamic provider, an unknown enabled toolset, or an enabled MCP
   server that has never completed discovery.
4. `explicit_config_present` is `true`: the profile publishes a server-enforced
   `platform_toolsets.api_server` allowlist. A denylist alone (`agent.disabled_toolsets`) is not
   accepted as an allowlist.
5. The enabled toolsets are exactly `memory`, `session_search`, `todo`, `vision`, `web`.
6. Every catalog entry has complete provenance, resolves to one of those toolsets, is available,
   and is in the reviewed client tool allowlist (`REVIEWED_CLIENT_TOOLS`).
7. No entry is from an MCP server (`source: "mcp"`, `source_server`, or a disconnected MCP schema).
8. No entry was added below the explicit allowlist (`added_below_explicit_config`,
   `recently_shipped`, `default_injected`). This catches plugin and release-backfill tools.
9. No Tool Search bridge (`tool_search`, `tool_describe`, `tool_call`) or connector access
   (`manage_connections`, `connectors__*`) is present. Connector access is scoped by
   `connections_in_scope()` in Hermes, which is true only when `manage_connections` is in the
   session tool definitions; disabling the `connections` toolset keeps hosted connectors out of
   scope. The verifier refuses the bridge anyway so a future Tool Search change cannot silently
   widen the catalog.
10. Two consecutive reads with independent challenge nonces produce the same SHA-256 digest. If the
    gateway echoes the challenge, it must match; a signed catalog extension is verified with
    HMAC-SHA256 over `{contract, profile, challenge, digest}`.
11. The digest matches the one persisted by the last health check. A mismatch records the newly
    observed safe snapshot but leaves the employee `provisioning` for one explicit confirmation
    health check.
12. The attestation is fresh (two-minute client TTL; a server-provided `expires_at` must also be in
    the future).

Any failure closes the gate. The live adapter re-runs this verification immediately before
`POST /v1/runs`; a caller cannot skip it, and no run is submitted when it fails.

### Persistence and diagnostics

Migration `0059` adds `tool_inventory_contract`, `tool_inventory_digest`,
`tool_inventory_verified_at`, `tool_inventory_expires_at`, `tool_inventory_tool_count`,
`tool_inventory_snapshot` and `tool_inventory_detail` to `agent_instances`. The snapshot contains
only the contract, profile name, digest, enabled toolsets, tool names/toolsets/sources and
timestamps; it contains no credentials or descriptions.

If the migration is not applied, the code degrades safely: `loadConnection` rolls back only its
digest lookup (savepoint), the health check reports that the snapshot cannot be persisted, and live
runs stay blocked. It does not claim readiness.

The health detail now says exactly which check failed, for example:

```
The gateway does not expose GET /v1/tools (complete runtime tool catalog), so plugin, MCP and
Tool Search access cannot be proven. Deploy a Hermes build with the complete tool-catalog contract
(upstream issue #92711 / PR #92729) before live use.
```

The agency workforce pages also show the inventory contract, tool count, digest prefix, expiry and
the stored inventory detail.

## Live evidence (2026-10-18)

Read-only audit command:

```bash
node --env-file=.env --conditions=react-server --import tsx scripts/hermes-live-audit.ts --live
```

Observed for all six mapped profiles:

| Check | Result |
| --- | --- |
| Gateway | `hermes-api.iacquire.online`, multiplexed profiles, connected |
| Gateway version | Hermes `0.21.5` (`/health/detailed`, not used for authorization) |
| Authentication and identity | capabilities contract and `GET /v1/models` identity verified 6/6 |
| Run capabilities | run, SSE, status, stop and approval advertised |
| `GET /v1/toolsets` | 29 toolsets, 5 enabled, 6 enabled built-in tools per profile |
| Enabled toolsets | `memory`, `session_search`, `todo`, `vision`, `web` |
| Unauthorized toolsets | none |
| Restricted/unreviewed tools | none |
| `GET /v1/tools` | **HTTP 404 — contract unavailable** |
| Complete inventory verified | **false** |
| Employee status | `provisioning` (correct) |
| Live run | none started |

## Development implementation (ready, not deployed)

A backport for the verified Hermes `0.21.5` source is implemented in an isolated workspace:

- Base source: Hermes `v2026.9.24` = `0.21.5`, commit
  `f97608f178d1ffeca59860195ab7da295f7c8e5f`.
- Patch revision: `f6a6230` on a baseline of the same source.
- Upstream reference: PR #92729 head
  `6a6960cf8fc09cc3a2d3d8baed60384a8a948a20` (9 commits, base `8b09a9df…`), which does **not**
  apply cleanly to 0.21.5 because the MCP module split and `get_tool_definitions` changed.
- Hostinger image source: the running 0.21.5 image's `api_server.py`, `tools_config.py`,
  `model_tools.py`, `mcp_tool.py`, `mcp_tool_registration.py`, `agent/memory_provider.py`,
  `agent/memory_manager.py`, `toolsets.py` and `registry.py` are byte-identical to the upstream
  0.21.5 tag. The Hostinger image only adds provider patches/plugins on top.
- New image: `docker/Dockerfile` overlays only the eight runtime files on a **digest-pinned**
  Hostinger base; it never copies profile data or credentials and refuses a non-0.21.5 base.
- Tests: 23 catalog tests pass (builder, explicit allowlist, `no_mcp`, MCP retention, plugin
  registration, plugin discovery failure, Tool Search pre-assembly, model-tools read-only snapshot,
  auth, six-profile isolation, challenge echo, capabilities advertisement).
- Cross-language smoke: the actual Python endpoint was started on localhost and the existing
  iAcquireOS `verifyToolInventory` client verified it end-to-end:
  `verified: true`, contract `hermes.api_server.tool_catalog.v1`, five toolsets, digest, and
  `challenge_bound_authenticated_catalog`.
- This is a development artifact. It has **not** been deployed to the VPS, the hosted database
  migration has **not** been applied, and no run was started.

The exact deployment/rollback procedure is in the isolated workspace (`DEPLOYMENT.md`); the
summary is repeated below.

## Remaining infrastructure changes

These are **not** iAcquireOS changes and were not applied:

1. **Hermes server/deployment:** deploy a Hermes build that registers
   `GET /v1/tools?platform=api_server` with the response shape above (upstream PR #92729 or an
   equivalent, independently reviewed patch). The current 0.21.5 build does not have it.
2. **Hermes profile configuration:** add an explicit server-enforced allowlist to each profile:

   ```yaml
   platform_toolsets:
     api_server:
       - memory
       - session_search
       - todo
       - vision
       - web
       - no_mcp   # server-enforced exclusion of every default MCP server
   ```

   Keep `agent.disabled_toolsets` as defence in depth. The portal's runbook
   (`buildConfigYaml()`) now emits both. Saving the selection with
   `hermes -p <profile> tools` also records `known_plugin_toolsets`, which keeps installed plugin
   toolsets out when they are not in the explicit list; if the profile was hand-edited, disable every
   installed plugin toolset in `agent.disabled_toolsets` as well. The complete catalog is the final
   proof: any plugin or MCP tool that still resolves is refused.
3. **Database migration:** apply `0059_hermes_tool_inventory.sql` to the hosted database as part of
   the release window. Until it is applied, health checks cannot persist the attestation and remain
   fail-closed.

After those three changes, re-run the live audit. Acceptance requires `completeInventoryVerified:
true`, `restrictedCount: 0`, `unauthorizedToolsets: []` and `readyForControlledRun: true` for every
profile. A successful audit still does not start a run; the controlled live-run acceptance in
[hermes-live-acceptance.md](hermes-live-acceptance.md) remains a separate, explicit step.
