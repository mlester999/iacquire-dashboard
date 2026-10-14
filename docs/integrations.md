# Integrations

All external calls run server-side through typed adapters in `src/server/integrations/`. New secrets are
saved by an Agency Super Admin through the Integrations Manager and stored as **managed Supabase Vault**
references; portal tables hold only a reference, fingerprint and metadata, and the user-facing database
role cannot read them. See [credential-security.md](credential-security.md). Nothing below is called from
the browser. Connection setup is documented in [integrations-setup.md](integrations-setup.md).

| Integration | State in this build | Writes? |
| --- | --- | --- |
| Hermes Agent | Adapter complete, contract pinned by tests against the Hermes source. The admin wizard saves the gateway and profile, then a live check verifies identity, capabilities and restricted tools. No client profiles provisioned yet. | Runs only (chat, research); never edits profiles |
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
| `GET /v1/capabilities` | Health check: requires `features.run_submission` and `run_events_sse`; reads `run_stop`, `run_approval_response` |
| `GET /v1/toolsets` → `{ object: "list", data: [{ name, enabled, tools[] }] }` | Health check refuses `online` if any restricted tool is enabled |
| `POST /v1/runs` `{ input, instructions, session_id, conversation_history }` + `Idempotency-Key`, `X-Hermes-Session-Key` | Start a chat or research run |
| `GET /v1/runs/{id}/events` (SSE) | `message.delta`, `message.interim`, `tool.started`, `tool.completed`, `tool.failed`, `approval.request`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted` |
| `POST /v1/runs/{id}/stop` | Stop generation |
| `POST /v1/runs/{id}/approval` `{ choice: "once" \| "deny", request_id }` | Resolve a paused tool approval from the Approval Center |

With the multiplexed gateway each profile is served under `/p/<profile>/` and authenticated with
that profile's own `API_SERVER_KEY`.

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

### Provisioning a client employee (agency runbook)

The portal never touches the VPS. When a client finishes onboarding, provisioning requests appear
in **Admin → Clients → (client) → AI workforce**. For each employee, **Runbook** generates
the exact profile name, `SOUL.md`, `config.yaml` snippet and steps:

1. `hermes profile create <profile> --description "…"` (blank — no `--clone`).
2. Save the generated `SOUL.md` into `~/.hermes/profiles/<profile>/`.
3. Merge the `config.yaml` snippet (disabled toolsets; Docker terminal backend as defence in depth).
4. In the profile's `.env`: `API_SERVER_ENABLED=true` and a unique `API_SERVER_KEY`; configure the
   model provider (`hermes -p <profile> model`, e.g. DeepSeek).
5. `hermes gateway restart`, then verify from the VPS:
   `curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8642/p/<profile>/v1/toolsets`.
6. In the portal: **Admin → Clients → (client) → Integrations → Hermes Agent → Connect** (guided wizard:
   approved HTTPS gateway URL, profile name, employee, then the profile's own key). The key goes to
   managed Supabase Vault and is never shown again. The wizard then runs a live test inside the flow.
   Finally run the employee **Health check** from the AI workforce page. The employee turns `online`
   only if it passes.

The gateway must be reachable from the portal over HTTPS (reverse proxy in front of the API
listener). `ALLOW_INSECURE_HERMES_URLS` exists for local testing and is refused in production.

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
