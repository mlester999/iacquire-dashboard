# Secure integrations setup

Open **Admin → Integrations** (`/admin/integrations`) as an Agency Super Admin. Pick a client to open `/admin/clients/[id]/integrations`. Agency credentials stay global; GHL locations and Hermes employee keys are scoped to their client. Staff can inspect their assigned clients, while credential operations require a super admin.

Each provider has a six-step guided wizard (Hermes, GoHighLevel, n8n). It saves the configuration, saves the secret securely, then **runs the live test inside the wizard** and shows the verified results before you finish. A saved key is shown as **Credentials saved**. Only a successful real read-only check produces **Connected**; the last wizard step reports the persisted status, not an assumption. You can also reopen any step from a card's **Configure / Rotate** and re-run **Test connection** from the card. Diagnostics show capabilities, supported permissions, sanitized errors, the last success/failure and history. Tests do not activate automations or send customer messages. See `docs/credential-security.md` before submitting any actual token.

## Values to gather

Never paste secrets into the development conversation. Enter them only in the secure portal form or hosting environment settings.

| Service | Where to get each value | Preparation |
| --- | --- | --- |
| Supabase | Approved development project dashboard: project URL, publishable key, server secret key, PostgreSQL connection settings | Configure hosting variables from `.env.example`, migrate application data/accounts and enable private Storage/Vault. |
| Hermes | Your agency gateway administrator: approved HTTPS base URL, dedicated profile identifier and that profile's `API_SERVER_KEY` | Confirm installed version and restricted tool configuration. Approve the exact host in `INTEGRATION_ALLOWED_HOSTS`. |
| GHL | Intended client sub-account → Settings → Private Integrations; copy that location's ID and scoped token | Create the sub-account manually using your approved Master Snapshot. Never use Aster Homes or assign the agency location to a client. |
| n8n | Your approved instance → Settings → n8n API: create an API key; record exact instance URL and approved workflow IDs | Confirm installed version, edition and available API scopes. Approve the exact host in server settings. |
| Google Calendar | The client's supported Google/provider authorization flow | The client must grant authorization; an entered email address is insufficient. |
| Email | Your authorized sending provider's verified-domain screen | Verify DNS/provider state separately from entering an address. |
| Website domain | Your approved hosting/domain control panel | Verify domain routing and publication separately from design completion. |

## Hermes gateway and dedicated employees

The adapter preserves the documented bearer authentication, `/p/<profile>/` routing and runs/SSE/approval contract. Its connection check reads `/v1/capabilities`, `/v1/models`, `/v1/toolsets` and the complete runtime catalog at `/v1/tools?platform=api_server`; it starts no AI run. Identity must come from the primary Hermes model entry (`owned_by=hermes`, `parent=null`, `root=id`), rather than a matching alias. Empty or malformed inventories, MCP/plugin/connector/Tool Search bridge entries, changing catalogs and advertised tools outside the reviewed client allowlist fail closed. [Official Hermes API server documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)

**Live client use is currently blocked.** The public `GET /v1/toolsets` handler enumerates configurable toolsets with default MCP servers excluded, while run creation can include default MCP, plugin, runtime-provider and Tool Search deferred tools. The portal therefore requires the native `GET /v1/tools?platform=api_server` contract, an explicit `platform_toolsets.api_server` allowlist, exactly the reviewed toolsets and tools, two matching challenge-bound reads and a digest matching the last health check. A 2026-10-22 authenticated app-terminal probe returned that native contract, but the inspected default profile had `explicit_config_present=false` and broad default-injected tools, so it fails policy. The terminal hostname did not match the earlier recorded Docker ID, so the probe is not tied to a confirmed container. The client-only Docker build definition vendors the reviewed Hermes 0.21.5 backport; its pinned base is an isolated-build candidate only, with security review and runtime acceptance pending. Unpatched Hermes gateways remain **Permission Limited**, employee health stays `setup_required`, and live run submission is refused before HTTP. `completeToolInventoryVerified=false` and `toolInventoryScope=not_verified` explain the limitation. A manual checkbox or review cannot override this backend gate; see [hermes-tool-inventory.md](hermes-tool-inventory.md) and [hermes-restricted-provisioner.md](hermes-restricted-provisioner.md). [Official Hermes API server source](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/gateway/platforms/api_server.py)

The installed gateway version was read from `/health/detailed` as Hermes `0.21.5`; that unauthenticated endpoint is diagnostic only. `packageVersion` still reports `not_reported` in the adapter's capabilities payload. A successful mock or local backport suite does not prove that the client-only image is built, deployed, or isolated. Require the exact native contract and safe allowlist on every profile before acceptance.

1. Ask your gateway administrator to provision blank, dedicated profiles using the existing **Client → AI workforce → Runbook**. Do not clone internal `iacquire-*` identities. No remote profile-creation endpoint is invented by the portal.
2. Arrange a private route or hardened HTTPS gateway with strict per-profile authentication. Deployed Next.js cannot reach `localhost` on a separate VPS. Raw public gateway access and browser-to-Hermes requests are inappropriate.
3. Review and disable host shell, filesystem, code execution, unrestricted browser/desktop and administrative tools, including hidden/default plugin or MCP tools. Keep each profile key distinct. This review prepares the infrastructure; it does not satisfy the missing complete-inventory verification gate.
4. After a development connection is explicitly authorized, open **Hermes Agent → Connect** and follow the wizard: (1) gateway endpoint, profile and employee, (2) the profile's own key, saved securely, (3) authenticated API test, (4) capability results and permission limitations, (5) profile routing summary, (6) persisted connection health. A real client profile must remain **Permission Limited** while full tool verification is unsupported. Profiles belonging to another tenant and internal `iacquire-*` profiles are refused.
5. Prepare each employee included in the package. The existing workforce page lists all six identities. Its **Health check** may verify API access after configuration is applied, but a live employee remains `setup_required` until supported complete tool verification exists. Global gateway API access, employee Online and final activation readiness are separate states.

No VPS restart or service change has been performed by this development work. Any deployment of the generated agency runbook needs the infrastructure administrator's separate authorization.

## GoHighLevel, read-only first

Create each sub-account manually on your current plan. The portal never creates locations, installs snapshots, publishes workflows, sends messages or writes CRM data. Protected locations are rejected before adapter HTTP access when used for a client.

Start with `locations.readonly` for explicit location identity verification and `opportunities.readonly` for pipelines. Add `calendars.readonly` and `calendars/events.readonly` when calendar reads are needed. Optional metadata reads use the specific tags, custom fields, custom values, forms and workflows read scopes; they are not requested by default. Choose the documented API contract matching your authorized token (`2021-07-28` retains the existing adapter contract; `v3` is also supported by the manager). [Private integrations](https://help.gohighlevel.com/support/solutions/articles/155000003054-private-integrations-everything-you-need-to-know), [official scope list](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/index.html)

Open **Admin → Integrations**, choose the client (this opens `/admin/clients/[id]/integrations?connect=ghl`) and follow the wizard:

1. **Select client** — confirms the client and reminds you of the manual sub-account process.
2. **Location ID** — enter the new sub-account's ID, a label and the API contract.
3. **Scoped token** — enter that client's Private Integration token and choose read-only scopes. Write scopes are not offered. The token must belong to the selected location.
4. **Test read-only access** — `/locations/{locationId}` must return the exact expected identifier before any metadata is read. A location mismatch is rejected. Each requested scope is then probed with a real read.
5. **Discover CRM metadata** — the **Read permissions** panel shows which scopes were proven by a real read (requested scopes are intentions; endpoint success is the evidence; missing access is **Permission limited**; the portal has no invented token-scope introspection endpoint). **Sync metadata** re-reads the permitted reference lists (names and IDs only), stamps the sync time and is refused until a successful test exists.
6. **Save verified mapping** — choose the pipeline and calendars the system should prepare to use. Only identifiers found in this location's verified metadata can be selected; a typed or forged ID is rejected. This records preparation only and never writes to GoHighLevel.

The existing client CRM **Sync now** separately refreshes pipelines/opportunities/calendar events in portal caches, after location identity verification.

Typed adapters cover pipelines/stages, tags, custom fields, custom values, forms, calendars and workflow inventory. Opportunity mappings are retained in the existing read-through sync. Booking URLs and website/funnel references require agency mappings or a reviewed supported provider; raw custom-value contents and workflow definitions are not returned. Matching a Master Snapshot's exact expected assets and calendar/provider authorization remains an explicit readiness gate. API visibility does not prove snapshot installation. [Get location](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/locations/get-location/), [pipelines](https://marketplace.gohighlevel.com/docs/ghl/opportunities/get-pipelines/), [workflow inventory](https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow/)

A Private Integration token is separate from a Marketplace webhook subscription. Appointment-event authentication/delivery is unverified until its dedicated connection and end-to-end checks are approved and completed.

## n8n agency connection and client mappings

Configure the agency n8n base URL and key. HTTP calls use `X-N8N-API-KEY` and the official `/api/v1` read endpoints. The manager reads paginated workflow inventory and execution summaries with `includeData=false`, discarding nodes, credentials, pinned data and execution payloads. It never edits, executes, retries, activates or deactivates workflows. [n8n API authentication](https://docs.n8n.io/api/authentication/), [official API reference](https://docs.n8n.io/connect/n8n-api/api-reference)

Restricted API-key scopes are an Enterprise feature; non-Enterprise keys have broad account-resource access. Installed edition and key restrictions cannot be inferred from workflow-list success. The UI treats an unverified key as high risk. Confirm version and edition in the actual instance's administration interface and use `workflow:list` and `execution:list` where supported. [n8n API scope documentation](https://docs.n8n.io/connect/n8n-api/authentication.md)

Open **Admin → Integrations → n8n → Connect** (agency scope only; a client page offers workflow mapping, not its own n8n credential) and follow the wizard:

1. **Instance URL** — exact HTTPS instance address; its host must be approved in `INTEGRATION_ALLOWED_HOSTS`.
2. **Secure API key** — saved to Vault. Treat the key as high risk until your administrator verifies the edition's key restrictions.
3. **Test authentication** — authenticates and reads the workflow list. No version or scope endpoint is invented.
4. **Workflow inventory** — shows each workflow's name, ID and active state. Only that is kept; nodes, credentials and execution data are discarded.
5. **Map approved workflows** — tick the workflows the portal may read execution summaries for, then **Save approvals & re-test**. If the Appointment Event Processor is listed, the wizard shows that it is only read, never activated or edited.
6. **Connection health** — the persisted status, last success and last failure.

Then, on a client's **Integrations** page, choose from **Agency-managed workflow mapping**. Only the verified global approval list can be selected, and a workflow cannot back two clients; provision a dedicated instance when needed. Save mappings and run that client's n8n connection test. The backend resolves the agency secret only after super-admin authorization, and returns only the approved client workflow summaries. Visible metadata alone never establishes authenticated appointment-event delivery or full workflow readiness.

The existing Hostinger appointment processor remains inactive, and its deduplication, ordering and PostgreSQL locking architecture is unchanged. Its event database is separate from Supabase portal data and from n8n's internal database. No Hostinger services have been modified.

## Other service cards and honest readiness

Supabase is configured through secure hosting settings. Its test checks the signed-in profile's actual Supabase Auth identity, PostgreSQL read and required private buckets; Realtime is verified separately through the authorized subscriptions.

Google Calendar, sending provider, domains and future provider cards stay **Not configured** until a supported authorization/verification adapter is connected. Client setup actions guide reviews, missing information and provider authorization. A manually entered email, address or URL cannot turn a technical check into Connected. Human design completion remains separate from publication, domain/DNS and provider state. Unsupported technical checks continue to block final activation; agency evidence is clearly labeled and cannot replace them.

## Verification boundary

This implementation's automated adapter/credential tests use PGlite synthetic data and mocked provider HTTP. No actual development Supabase/Vault project, Hermes gateway, GHL location or n8n instance has been verified by these tests. Connect the approved development project and then use the authenticated manager's explicit read-only tests. Production deployment and live automation activation require separate authorization.

## AI model connection tests

The agency AI model dialog first sends a GET request to the provider's model-list endpoint. If that list includes the selected model, the test requests no completion. Network failures, authentication failures, rate limits, other server errors, malformed responses and empty lists stop the test; they do not trigger inference.

Only an explicit unsupported listing response (HTTP 404, 405 or 501) triggers the disclosed minimal model response test: a POST completion request with one output token requested. This may consume provider credits. The dialog explains this before **Save & test connection**. **Load models** performs GET only and never starts a completion.

Diagnostics and audit metadata distinguish `verificationOperation=model_listing` from `basic_model_response`; the latter has `safeReadOnlyTest=false`. The existing database verification-mode enum remains compatible, so read the operation field alongside it when reviewing checks. Completion history is labeled **Minimal model response**, including older checks recorded as `verification=one_token_completion`. No live model provider was contacted during automated verification; `tests/llm-verification.test.ts` intercepts all HTTP with synthetic responses.
