# Hermes live acceptance procedure and current blocker

Status: **read-only gateway audit passed; controlled live run blocked.**

This page records what was actually observed against the configured gateway and the exact work required
before a model run can be accepted. It deliberately contains no API keys, profile keys, Cloudflare
secrets, customer data or organization names.

## What was verified live

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

All six profiles are currently `provisioning`. That status is correct: they are not safe to run.

## Exact gateway-side blocker

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
not disable them; that gap is now fixed in `buildConfigYaml()`. The live profiles still expose them.

The portal refuses to mark these employees online. Do **not** bypass the gate, and do not add these
tools to `REVIEWED_CLIENT_TOOLS` merely to make the screen green.

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

1. Apply the restricted tool policy and re-run the live audit; require `readyForControlledRun: true`
   for the test profile.
2. Confirm the employee is `online` only after a successful authenticated health check.
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
| Gateway authentication | COMPLETE — verified live |
| Internal profile identity | COMPLETE — verified live for all six |
| Gateway capabilities/streaming/stop/approval support | COMPLETE — advertised and adapter-tested; approval/stop not exercised live |
| Tool exposure safety | BLOCKED — 32 restricted tools enabled per profile |
| Complete tool inventory proof | BLOCKED — contract not provided by the public API |
| Real model response | BLOCKED — live-run gate refuses by design |
| Client live profile | NOT STARTED — no client employee is mapped |
| PDF/DOCX extraction | LOCALLY VERIFIED — synthetic real files, no paid OCR |
| SOUL.md write | BLOCKED — `admin_config_rw: false`, no documented write endpoint |
| Memory read/edit | BLOCKED — `memory_write_api: false` |
| Migration 0045/0046 in hosted DB | **APPLIED 2026-10-18** via the `--only` runner, after hosted 0044. See [workforce-migration-and-release.md](workforce-migration-and-release.md) |
