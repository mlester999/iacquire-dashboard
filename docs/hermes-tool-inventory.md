# Hermes complete tool-inventory verification

Status: **implemented and fail-closed. The patched gateway is deployed and all six profiles pass the
VPS `verify-catalog` check (6/6), but the six internal employees are still `provisioning`: none has had a
portal health check or an applied configuration, so none can run.**

This page records the contract, the verification rules, the live evidence and the remaining
activation steps. It contains no API keys, profile identifiers, organization names or customer
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

The unpatched gateway (Hermes `0.21.5`, observed 2026-10-18) did not register this route: an
authenticated request returned HTTP 404 (`Unknown or unconfigured profile`). Its
`GET /v1/capabilities` also returned an empty `endpoints` object, so the portal probes
`/v1/tools` directly instead of trusting a capability advertisement. The deployed gateway is now
Hermes `0.21.5` plus the complete-catalog patch (see [Deployed gateway](#deployed-gateway-patched-hermes-0215)),
which returns the response above.

## What the running process could provide before the patch

Read-only probes against the authenticated profile route on 2026-10-18 (the unpatched gateway):

| Surface | Observed | Usable as complete-inventory proof? |
| --- | --- | --- |
| `GET /v1/capabilities` | `hermes.api_server.capabilities`, authenticated, run/SSE/status/stop/approval features, `endpoints: {}` | No inventory payload |
| `GET /v1/models` | The profile's primary Hermes identity | Identity only |
| `GET /v1/toolsets` | 29 configurable toolsets, 5 enabled, 6 enabled tools; default MCP servers excluded by design | No — partial by construction |
| `GET /v1/tools?platform=api_server` | HTTP 404 | No — route absent in 0.21.5 |
| `GET /v1/skills` | HTTP 500 (server error) | No — skills are not callable tools |
| `GET /health/detailed` | Hermes `0.21.5`, gateway running | Diagnostics only; unauthenticated |
| TUI gateway `tools.list` / `tools.configure` / `mcp.*` | Not exposed by the API server | No; the portal must not invent an HTTP route for it |

Because no authenticated API-server surface of the unpatched gateway returned the full model-facing
tool set, the portal could not honestly mark an employee ready. The smallest compatibility change is
the `/v1/tools` endpoint, which the patched gateway now provides; the portal's client and
verification were written against it.

## What the portal implements

| Piece | Location |
| --- | --- |
| Reviewed toolsets, disabled toolsets, Tool Search/connector names | `src/server/integrations/hermes/tool-policy.ts` |
| Typed `GET /v1/tools` client | `src/server/integrations/hermes/client.ts` (`getToolCatalog`) |
| Complete-inventory verifier, digest, attestation, freshness, change detection | `src/server/integrations/hermes/inventory.ts` |
| Persisted attestation columns | `supabase/migrations/0059_hermes_tool_inventory.sql` |
| Health check | `src/server/workforce/service.ts` (`runHealthCheck`) |
| Run gate shared by every run entry point | `src/server/integrations/hermes/client.ts` (`startAgentRun`, `assertAgentRunnable`) |
| Integration inspection | `src/server/integrations/inspection.ts` |
| Read-only live audit | `scripts/hermes-live-audit.ts` (`npm run hermes:audit`; type-checked by `npm run typecheck:scripts`) |
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
6. Every catalog entry has complete provenance and a `parameters` schema, resolves to one of those
   toolsets, is available, and is one of the reviewed tools. The inventory must contain **all five
   required tools** (`memory`, `session_search`, `todo_list`, `web_extract`, `web_search`); `vision_analyze`
   is optional because it exists only when the profile has vision credentials. Any other tool, a repeated
   tool name or a missing required tool fails. This matches `REQUIRED_TOOLS` / `OPTIONAL_TOOLS` in
   `docker/profiles/verify-catalog.py` of the sibling `hermes-tool-catalog-dev` repo, so the portal is at
   least as strict as the operator's VPS check.
7. No entry is from an MCP server (`source: "mcp"`, `source_server`, or a disconnected MCP schema).
8. No entry was added below the explicit allowlist (`added_below_explicit_config`,
   `recently_shipped`, `default_injected`). This catches plugin and release-backfill tools.
9. No Tool Search bridge (`tool_search`, `tool_describe`, `tool_call`) or connector access
   (`manage_connections`, `connectors__*`) is present. Connector access is scoped by
   `connections_in_scope()` in Hermes, which is true only when `manage_connections` is in the
   session tool definitions; disabling the `connections` toolset keeps hosted connectors out of
   scope. The verifier refuses the bridge anyway so a future Tool Search change cannot silently
   widen the catalog.
10. Two consecutive reads with independent challenge nonces produce the same SHA-256 digest. The
    gateway **must echo** each request's challenge (`X-Hermes-Inventory-Challenge`) and report
    `contract: "hermes.api_server.tool_catalog.v1"`; a missing, different or replayed challenge is
    `inventory_incomplete`. A signed catalog extension is verified with HMAC-SHA256 over
    `{contract, profile, challenge, digest}`.
11. The digest matches the one persisted by the last health check. A mismatch records the newly
    observed safe snapshot but leaves the employee `provisioning` for one explicit confirmation
    health check. A **run** additionally requires that a digest exists: with none recorded the
    verifier refuses (`inventory_not_recorded`) before any request, so a never-health-checked
    employee cannot run just because today's live catalog looks safe.
12. The attestation is fresh (two-minute client TTL; a server-provided `expires_at` must also be in
    the future).

Any failure closes the gate. Every run starts through `startAgentRun`, the one shared entry point
(chat, lead research, customer replies and configuration previews all use it). It requires the
employee to be enabled, `online` (or `busy`) and to have a recorded inventory digest; for an internal
agency employee it also applies the identity check and the current Super Admin acknowledgement. It
then re-runs this verification, comparing the live catalog with the persisted digest (not with
whatever the caller supplied), immediately before `POST /v1/runs`. A caller cannot skip it, and no
run is submitted when it fails. `tests/hermes-run-gate.test.ts` also fails if any other module
imports the low-level `startRun`.

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

## Live evidence (2026-10-18, unpatched gateway)

This is the historical result against the original 0.21.5 gateway, kept as the baseline. The current
state is in [Deployed gateway](#deployed-gateway-patched-hermes-0215).

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

## Deployed gateway (patched Hermes 0.21.5)

The gateway is Hermes `0.21.5` plus the complete-tool-catalog patch, which registers
`GET /v1/tools?platform=api_server` with the `hermes.api_server.tool_catalog.v1` contract:

- Base source: Hermes `v2026.9.24` = `0.21.5`, commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`.
  Upstream PR #92729 (head `6a6960cf8fc09cc3a2d3d8baed60384a8a948a20`) does **not** apply cleanly to 0.21.5
  because the MCP module split and `get_tool_definitions` changed, so the patch is a backport.
- Image: `docker/Dockerfile` in the `hermes-tool-catalog-dev` workspace overlays only the runtime files on a
  **digest-pinned** Hostinger base; it never copies profile data or credentials and refuses a non-0.21.5 base.
- The gateway **always echoes** `X-Hermes-Inventory-Challenge` and sends `generated_at` and a 120-second
  `expires_at`. Live rows are flat, not wrapped in `function`:
  `{name, description, parameters, provenance{source: "configurable", toolset, requested_toolsets, source_server: null, added_below_explicit_config: false}}`;
  `available` appears on MCP rows only. The portal accepts both the flat and the `{type, function}` shape.
- Each of the six internal profiles is configured with
  `platform_toolsets.api_server = [memory, session_search, todo, vision, web, no_mcp]`.
- `run-policy.sh verify-catalog` (read-only: one authenticated `GET` per profile with that profile's own key)
  passed **6/6**. Its checks are mirrored by the portal verifier (rules above).
- The portal verifier was cross-tested against the real gateway code on loopback: it passes a profile with the
  policy, blocks one without (`allowlist_missing`) and blocks a wrong key (`auth_failed`).
- Hosted migration `0059_hermes_tool_inventory` is applied (2026-10-18T22:52Z).

This evidence comes from the operator's VPS run and the loopback cross-test. Nothing in this repository
contacted the gateway, and no run has been started.

### What is still not true

The six internal employees are `provisioning`. None has had a portal health check, so none has a recorded
inventory digest or applied configuration version, and the Super Admin profile checks (2026-10-17) and one
acknowledgement are stale. `startAgentRun` therefore refuses every run for them, including
configuration previews, before any request reaches the gateway.

## Activation steps (all explicit, none automatic)

1. **Apply an initial configuration for each of the six employees.** `runHealthCheck` returns
   `setup_required` for an employee with no applied configuration even when the catalog verifies
   ("The employee configuration hasn't been applied yet…"), so it can never go online until one exists. A
   Super Admin switches to the iAcquire (agency) workspace, opens each employee under **AI Workforce**, and
   saves its settings once. That creates and applies version 1; a version held as
   `pending_agency_review` does not count.
2. **Run the employee health check** (Admin → Workforce → *Run health check*). With a configuration applied it
   verifies identity, capabilities, toolsets and the complete inventory (two reads), records the digest, and
   sets the employee `online`. After any later inventory change, one more health check must confirm it.
3. **Run the agency profile check, then record the full-capabilities acknowledgement** for each internal
   profile. The acknowledgement must be newer than the latest profile check, so a re-check invalidates it.
4. **Re-run the read-only audit** (`npm run hermes:audit -- --live`, GET requests only). The audit changes no
   gateway, profile, employee, configuration or inventory state, but it is not strictly zero-write: resolving each
   stored profile credential appends one `credential.resolved` audit-log row. Acceptance requires
   `completeInventoryVerified: true`, `restrictedCount: 0`, `unauthorizedToolsets: []` and
   `readyForControlledRun: true` for every profile; the report also shows whether each employee has an applied
   configuration and a recorded inventory digest.
5. A successful audit still does not start a run. The controlled live-run acceptance in
   [hermes-live-acceptance.md](hermes-live-acceptance.md) remains a separate, explicit step.

If a profile is ever rebuilt, the same policy block must be re-applied
(`platform_toolsets.api_server` as above, plus `agent.disabled_toolsets` as defence in depth; the portal runbook
`buildConfigYaml()` emits both). Saving the selection with `hermes -p <profile> tools` also records
`known_plugin_toolsets`; if a profile was hand-edited, disable every installed plugin toolset in
`agent.disabled_toolsets` as well. The complete catalog is the final proof: any plugin or MCP tool that still
resolves is refused.
