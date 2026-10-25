# Hermes live acceptance procedure and current blocker

Status (2026-10-25): **the 06:27:47 UTC read-only GET audit verified gateway authentication, exact identity, reviewed tool exposure and stable live inventory for all six existing internal profiles. The 06:26:37 UTC portal preflight still reports only Zeng and Lead Hunter available at 6/6; the four target employees have no applied configuration and remain blocked. At 06:22 UTC, the deployed prompt loader returned six non-empty, distinct per-profile SOUL identity blocks for new sessions; the assembled system prompt and a model response remain unverified.**

This page records what was actually observed against the configured gateway and the exact work required
before a model run can be accepted. It deliberately contains no API keys, profile keys, Cloudflare
secrets, customer data or organization names. Current employee and production evidence is in the
[workforce completion checkpoint](verification-status.md#ai-workforce-completion-checkpoint-2026-10-25)
and [2026-10-24 internal workforce preflight](internal-workforce-production-preflight-2026-10-24.md).

## Historical 2026-10-18 audit

Command (no run is started):

```bash
node --env-file=.env --conditions=react-server --import tsx scripts/hermes-live-audit.ts --live
```

Observed on 2026-10-18:

| Check | Result |
| --- | --- |
| Gateway | 1 multiplexed-profile gateway, status connected |
| Gateway authentication | `hermes.api_server.capabilities`, `authenticated: true` |
| Mapped employees | 6, all in the agency workspace; no client employee is mapped yet |
| Profile identity | verified for all 6 through `GET /v1/models` |
| Run capabilities | run submission, SSE events, run status, stop and approval all advertised |
| Streaming fallback | run-status endpoint advertised; polling fallback is implemented |
| SOUL.md write | `admin_config_rw: false`; no portal write |
| Memory read/write | `memory_write_api: false`; no portal read/edit |
| Tool inventory | 29 toolsets, 14 enabled, 38 enabled tools, **32 restricted/unreviewed tools** |
| Complete inventory gate | **false** — the public API cannot prove plugin/MCP completeness |
| Model run | none started |

The 2026-10-18 `provisioning` state and inventory result below are historical, not the current
employee readiness state. See the 2026-10-24 preflight linked above for the current result.

## Historical gateway exposure (2026-10-18, superseded)

Each internal profile exposes restricted or unreviewed tools. The exact enabled toolsets observed are:

```
browser, code_execution, connections, cronjob, delegation, file, image_gen,
memory, session_search, skills, terminal, todo, vision, web
```

The portal's reviewed safe set is:

```
memory, session_search, todo, vision, web
```

The unauthorized enabled toolsets are therefore:

```
browser, code_execution, connections, cronjob, delegation, file, image_gen, skills, terminal
```

Remember that `image_gen` and `skills` are separate from shell/file/browser. The previous runbook did
not disable them; that gap is now fixed in `buildConfigYaml()`. The profiles still exposed them in
the historical 2026-10-18 audit.

At that time, the portal correctly refused to mark the employees online. The 2026-10-25 live audit
verified the restricted tools were no longer enabled; do **not** add unreviewed tools to
`REVIEWED_CLIENT_TOOLS` to bypass any future inventory failure.

### Required remediation

A gateway administrator must apply a restricted tool policy to each profile used by the portal. The
reviewed configuration template is in
[`src/server/workforce/provisioning.ts`](../src/server/workforce/provisioning.ts) (`buildConfigYaml`).
At minimum, `agent.disabled_toolsets` must include:

```yaml
agent:
  disabled_toolsets:
    - browser
    - code_execution
    - computer_use
    - connections
    - cronjob
    - delegation
    - file
    - image_gen
    - skills
    - terminal
    - catalog
    - kanban
```

After the change, the only enabled toolsets should be the reviewed set:
`memory`, `session_search`, `todo`, `vision`, `web`. Disabling the nine unauthorized toolsets does
**not** satisfy the separate complete-inventory contract; it only removes the known dangerous
exposure.

After applying it, restart or reload the affected gateway profiles and verify:

```bash
node --env-file=.env --conditions=react-server --import tsx scripts/hermes-live-audit.ts --live
```

Acceptance for this step: `restrictedCount: 0` and `identityVerified: true` for every profile that will
serve an employee.

The API server advertises `admin_config_rw: false`; the portal cannot make this gateway-side change.
The separate TUI gateway contract (`tools.list` / `tools.configure` / `mcp.*`) is **not** exposed by the
API server, so it must not be called through an invented HTTP route.

## Complete tool-inventory gate

The public API's `GET /v1/toolsets` returns the enabled platform toolsets, but not a
provider-signed/attested complete inventory of plugin and MCP tools. The existing
`hasVerifiedCompleteToolInventory` gate correctly stays closed.

The smallest safe contract that would unblock production is one of:

1. an authenticated, versioned API-server endpoint that returns the **complete resolved tool inventory**
   (toolsets, plugin tools, MCP server tools, enabled state) with a stable contract and an attestation
   the portal can verify; or
2. profile-scoped tool allowlisting enforced **inside the gateway** at run time, with an authenticated
   endpoint the portal can use to verify the applied allowlist; or
3. exposing the documented gateway tool-configuration contract through a supported, authenticated,
   profile-scoped API that the portal can use to read and apply `tools.configure`.

Until one of these exists, live runs stay blocked. The exact missing capability is the complete
inventory/attestation contract, not a lack of API keys.

## Controlled live-run acceptance (only after the gate is satisfied)

Use a non-production tenant and a dedicated blank profile. Never use a client's production profile for
the first run. Never ask the model to send messages, write CRM records, book appointments or touch an
external system.

1. Apply the restricted tool policy and re-run the live audit; require `runtimeProfileVerified: true`
   for the test profile. This is the Hermes gateway/runtime check only.
2. Confirm the portal preflight independently shows an applied configuration, current health and inventory,
   identity verification and (for an internal profile) a current Super Admin acknowledgement before any run.
3. Open the employee's chat and send a read-only prompt such as:
   `Without using any tools, reply with the single word READY.`
4. Verify the real streamed answer, then verify the persisted message and run rows.
5. Test stop on a deliberately slow prompt; verify the UI and run status become `cancelled`.
6. Test a provider failure (temporary invalid profile key on the test employee only); verify the UI
   shows a usable error and the employee becomes offline.
7. If a reviewed read-only tool is used, verify its `tool.started`/`tool.completed` events and that no
   write-capable tool is reachable.
8. Test an approval-required action only on a disposable test CRM record, and verify deny/resume.
9. Test draft preview and confirm it creates no conversation, message, run or configuration version.
10. Record the exact gateway version/contract, profile identities, tool inventory, token usage and
    latency. Do not record credentials.

A successful mock-gateway run is **not** evidence for this checklist.

## Current acceptance matrix

| Capability | Classification |
| --- | --- |
| Gateway authentication and internal profile identity | COMPLETE — verified live for all six on 2026-10-25 06:27:47 UTC |
| Complete inventory and restricted-tool check | COMPLETE — six reviewed tools across five toolsets; zero restricted tools observed |
| Gateway capabilities | Advertised live; no new run was started to exercise events, stop or approvals |
| Internal app readiness | 2/6 complete (Zeng and Lead Hunter) at 2026-10-25 06:26:37 UTC; four employees remain at 0/6 pending configuration and current saved checks |
| Real model response | A historical Lead Hunter production research job exists; this preflight started no new model run |
| Effective SOUL instructions | PARTIALLY VERIFIED — deployed loader returned six distinct identity blocks for new sessions at 06:22 UTC; no assembled prompt or model response was inspected |
| Running application SHA | UNVERIFIED — no deployment record or runtime SHA was available to this audit |
| Client live profile | NOT VERIFIED by this internal-profile audit; sandbox results are documented separately |
| PDF/DOCX extraction | LOCALLY VERIFIED — synthetic real files, no paid OCR |
| SOUL.md read/write via current API | UNAVAILABLE — `admin_config_rw: false`; use an authorized host-side evidence path |
| Memory read/edit | UNAVAILABLE — `memory_write_api: false` |
| Hosted application migrations | 0086 is the latest applied migration in the 2026-10-25 read-only preflight |
