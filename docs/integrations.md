# Integrations

All external calls run server-side through typed adapters in `src/server/integrations/`. New secrets are
saved by an Agency Super Admin through the Integrations Manager and stored as **managed Supabase Vault**
references; portal tables hold only a reference, fingerprint and metadata, and the user-facing database
role cannot read them. See [credential-security.md](credential-security.md). Nothing below is called from
the browser. Connection setup is documented in [integrations-setup.md](integrations-setup.md).

| Integration | State in this build | Writes? |
| --- | --- | --- |
| Hermes Agent | Shared gateway registry, separate profile mappings, Cloudflare Access credentials and per-profile health checks are implemented. The six agency employees must be mapped and verified. Automatic client profile creation remains unavailable until a restricted provisioning service is installed and verified. | Runs only (chat, research); never edits profiles |
| GoHighLevel | Read-only adapter: identity check, permission probes, metadata discovery (pipelines, calendars, tags, custom fields, custom values, forms, workflow inventory), pipeline/calendar mapping from verified metadata, and the existing opportunity/calendar sync. Not verified live: needs a per-location token. | None (`GHL_WRITES_ENABLED=false`) |
| n8n | Agency-global read-only connection: authenticated workflow inventory, approved-workflow mapping per client, safe execution summaries. Not verified live. | None — never edits, runs or activates workflows |
| Google Calendar, email sending, domains | No connector yet. Setup steps stay actionable and unverified. | None |
| Email | `capture` provider stores mail in the outbox; Resend adapter available. | Only transactional auth/invite mail |
| Help assistant LLM | Off by default; answers from the built-in help center. Optional OpenAI-compatible provider (e.g. DeepSeek). | No |
| Slack | Optional webhook alert for new support tickets. In-app inbox works without it. | Alert only |

## Hermes Agent

### Verified API contract

Checked against the Hermes Agent source (`gateway/platforms/api_server.py`, `api_server_runs.py`,
`tools/approval.py`, `toolsets.py`, `hermes_cli/tools_config.py`) and pinned by
`tests/hermes-contract.test.ts`:

| Call | Used for |
| --- | --- |
| `GET /v1/capabilities` | Health check: requires `features.run_submission` and either `run_events_sse` or `run_status`; reads `run_stop`, `run_approval_response`, and the informational `memory_write_api` / `admin_config_rw` flags |
| `GET /v1/models` | Verifies the intended profile identity (never treats an alias as the primary identity) |
| `GET /v1/toolsets` → `{ object: "list", data: [{ name, enabled, tools[] }] }` | Advertised configurable inventory only. The health check refuses `online` if any restricted or unreviewed tool is enabled, but this endpoint cannot prove plugin/default-MCP/Tool Search completeness |
| `GET /v1/tools?platform=api_server` → complete runtime catalog with per-tool provenance | Required proof for live use. The verifier requires an explicit `platform_toolsets.api_server` allowlist, exactly the reviewed toolsets, only reviewed tools, no MCP/plugin/connector/Tool Search bridge entries, two matching reads and a digest matching the last health check. An unpatched Hermes 0.21.5 returns 404 and is reported as `contract_unavailable`; the isolated client Docker build definition vendors a native backport, but its base-version/security review and runtime acceptance remain pending. |
| `POST /v1/runs` `{ input, instructions, session_id, conversation_history }` + `Idempotency-Key`, `X-Hermes-Session-Key` | Start a chat or research run; the adapter re-verifies the complete inventory immediately before submission and refuses before HTTP if it fails |
| `GET /v1/runs/{id}/events` (SSE) | `message.delta`, `message.interim`, `tool.started`, `tool.completed`, `tool.failed`, `approval.request`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted` |
| `GET /v1/runs/{id}` | Non-streaming fallback: poll run status and render the real completed output once |
| `POST /v1/runs/{id}/stop` | Stop generation |
| `POST /v1/runs/{id}/approval` `{ choice: "once" \| "deny", request_id }` | Resolve a paused tool approval from the Approval Center |

The prior six-profile audit was read-only on 2026-10-18 and reported identity and toolset checks, but its
catalog verification is historical. A 2026-10-22 app-terminal probe now returns the native catalog
contract, complete flag and challenge echo. The inspected default profile nevertheless has no explicit
allowlist and exposes broad default-injected tools, so it fails policy. That terminal's container ID
could not be matched to the earlier Docker ID. All six employees remain `provisioning`; no run was
started. The client-only Docker build definition vendors the reviewed native 0.21.5 backport, but
the image has not been built or accepted in an isolated runtime. See
[hermes-live-acceptance.md](hermes-live-acceptance.md) and
[hermes-tool-inventory.md](hermes-tool-inventory.md) for the exact blocker, contract and
remediation.

With a multiplexed gateway, each profile is served under `/p/<profile>/` and authenticated with
that profile's own `API_SERVER_KEY`. For `hermes-api.iacquire.online`, Cloudflare Access also
requires the separate `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Both credential
pairs are sent only by server-side adapters, loaded from managed Vault references, and never
returned to the browser. The gateway registry and workforce profile mapping are separate records.

The global Hermes wizard registers a gateway without requiring a profile ID. In **Admin → AI
Workforce**, an agency super admin maps the exact existing profile ID and that profile's own
`API_SERVER_KEY` to each of the six internal employee records. The UI does not guess or recreate
agency profiles. Gateway verification runs read-only health checks for all six mapped agency
employees; it shows `Connected` only if every required profile passes. An individual client employee
is mapped to an approved gateway and receives its own profile key. The database enforces the
gateway/profile URL match and prevents one gateway profile from backing multiple employees.

### Client isolation — why each employee gets its own profile

Hermes keeps memory, sessions and `SOUL.md` per profile, and the API server executes tools on the
gateway host. So:

- **Never** route a client to the internal `iacquire-*` profiles or clone them
  (`hermes profile create --clone` copies `SOUL.md` and memory). The database rejects those profile
  names for client tenants.
- Each tenant employee gets a **blank, dedicated profile** (e.g. `acme-dental-sales-assistant`).
  A profile can back only one tenant employee (unique index).
- Client configuration is sent per run as layered `instructions`; the profile's `SOUL.md` only holds
  the role and the immutable iAcquire policy. Client text never becomes privileged system config.
- Long-term memory is additionally scoped with `X-Hermes-Session-Key: iaq:<org>:<role>`.
- Dangerous toolsets are disabled in the profile (`agent.disabled_toolsets`, applied last by Hermes):
  `terminal, file, code_execution, browser, computer_use, cronjob, delegation, connections, catalog, kanban`.
  The portal independently refuses to mark an employee online if `/v1/toolsets` reports any of
  `terminal`, `process_manage`, `read_file`, `write_file`, `patch`, `search_files`, `execute_code`,
  `computer_use`, `cronjob_manage`, `delegate_task`, `manage_connections`, `manage_catalog`,
  `skill_manage`, `browser_*`, `kanban_*`.

The portal cannot enforce those per-tool settings at execution time with the current API contract:
Hermes dispatches tools inside the gateway, after the portal submits a run. Filtering run requests,
SSE events, or results in the portal would happen too late to stop a tool. The authenticated
`/v1/toolsets` response is not a complete effective inventory, and the API has no supported policy
write endpoint. Therefore saved client policies are desired settings only, and client runs stay
fail-closed. The installed production gateway's version and configuration have not been verified.

To enable client runs safely, Hermes must expose an authenticated complete effective tool inventory
with profile, gateway-version, and configuration-revision identity, and enforce the synchronized
default-deny policy in its final tool dispatcher. Enforcement must cover aliases, alternate dispatch
paths, plugins/MCP tools, and nested or delegated calls; an incomplete, stale, or unsynchronized
policy must deny execution. A policy write endpoint without that execution-time enforcement is not
sufficient. See the open [Hermes inventory contract request](https://github.com/NousResearch/hermes-agent/issues/92711).

### Provisioning a client employee (agency runbook)

The portal never touches the VPS. When a client finishes onboarding, provisioning requests appear
in **Admin → Clients → (client) → AI workforce**. For each employee, **Runbook** generates
the exact profile name, `SOUL.md`, `config.yaml` snippet and steps:

1. Follow the staged Cloudflare and endpoint checks in [hermes-cloudflare-setup.md](hermes-cloudflare-setup.md).
2. For a manually approved non-production profile, use Hermes' documented profile CLI to create a
   blank profile (`hermes profile create <profile>`; never use `--clone`). Apply the role's reviewed
   configuration and an independent `API_SERVER_KEY` using the installed-version runbook.
3. Verify the exact profile route locally and through Cloudflare Access. The application does not
   create profiles or apply remote configuration; do not mark these manual steps as automatic
   provisioning.
4. In **Admin → Clients → (client) → Integrations → Hermes Agent**, select the registered gateway,
   employee role, exact profile ID, and that profile's own key. The key is stored in managed Vault
   and is not shown again.
5. Run the profile's read-only health check. The profile is `online` only after identity, capabilities,
   the explicit reviewed toolset allowlist and the complete runtime tool catalog are verified. The
    catalog endpoint (`GET /v1/tools`) is absent from unpatched Hermes 0.21.5. The current default
    profile also fails its allowlist policy; automatic client runs remain blocked until the isolated
    client image and profiles pass acceptance. See
   [hermes-tool-inventory.md](hermes-tool-inventory.md).

Profiles made this way are operator-managed. Six-profile automatic client provisioning is not ready;
production profile creation and activation must wait for an independently authenticated, narrowly
scoped provisioning service and an approved production activation process.

Use the operator checklist in [hermes-cloudflare-setup.md](hermes-cloudflare-setup.md) before
activating DNS or connecting the production gateway. The planned hostname is allowlisted in the
application, but an allowlisted URL is not proof that DNS, Tunnel, Access or Hermes is live.
`ALLOW_INSECURE_HERMES_URLS` is refused in production.

### Scale note

One profile per employee means up to six profiles per client. Confirm the VPS has the memory and
concurrency for the planned number of clients before onboarding many tenants; usage limits per
tenant are configurable in **Admin → Clients → (client) → Usage & limits**.

## GoHighLevel

- Each tenant maps to exactly one sub-account (`ghl_location_mappings`), assigned by an agency
  admin. The location ID is stored server-side and never accepted from a client request.
- Protected: Aster Homes (`u69CVh0ZlAofUmRoj1zF`) is rejected by a database constraint; the agency
  location (`SQvVnld5MBHdMQ1qnSfw`) can only belong to the agency organization.
- Calls used (LeadConnector API v2, read-only): `GET /opportunities/pipelines?locationId=`,
  `GET /opportunities/search?location_id=`, `GET /calendars/events?locationId=&calendarId=&startTime=&endTime=`.
  Results are cached in `crm_pipelines`, `crm_opportunities` and `appointment_refs` for the
  Sales and Appointments pages.
- Needed to go live: a sub-account (location) private integration token with read scopes for
  opportunities and calendars, entered through the guided wizard in
  **Admin → Clients → (client) → Integrations → GoHighLevel** (location, scoped token, live read-only
  test, **Sync metadata**, then a pipeline/calendar mapping chosen from the verified metadata), then
  **Sync now** on the client page to refresh the CRM caches. Writes (lead import, CRM updates, bookings) stay disabled: approvals for them are
  recorded as "approved, held" until a reviewed write path is built and `GHL_WRITES_ENABLED` is
  turned on deliberately.
- Draft GHL workflows are never touched.

## n8n

Read-only. The agency connects n8n once, in **Admin → Integrations → n8n** (instance URL, API key in
Vault, approved workflow IDs chosen from the live inventory). Each client is then associated with
specific approved workflows from that list; clients can never name a workflow. The portal reads
workflow inventory and execution summaries (`includeData=false`) only, and never activates, edits,
retries or triggers workflows. Optional `N8N_BASE_URL` / `N8N_API_KEY` server settings still power the
System Health `/healthz` probe and its report of whether the "iAcquire Appointment Event Processor"
exists and is active. The processor is treated as unverified and not production-ready; its own
PostgreSQL-backed deduplication and locking are untouched.

## Email

`EMAIL_PROVIDER=capture` stores messages in `email_outbox` (shown at `/dev/mailbox` in development).
For production set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and a verified `EMAIL_FROM` domain.
Only verification, password reset and invitation emails are sent. No customer messaging.

## iAcquire Assistant (help widget)

Separate from every client AI employee. It answers from the curated help center
(`src/server/help/articles.ts`), refuses off-topic questions with a fixed redirect, deep-links to
portal pages and escalates to human support tickets. Optionally set `HELP_LLM_PROVIDER=openai_compatible`
with `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` to phrase answers with an LLM restricted to the
help-center content. It has no tools and no access to tenant data.

## Linking from the public website

The marketing site only needs plain links — no shared code, cookies or embedding (the portal sends
`frame-ancestors 'none'`):

| Link | URL |
| --- | --- |
| Log in | `https://<portal-domain>/login` |
| Client portal | `https://<portal-domain>/` (redirects to login or the workspace) |
| Get started | `https://<portal-domain>/get-started` (access request for agency review; provisions nothing) |

Use a subdomain such as `portal.<your-domain>` so the session cookie stays host-only.
