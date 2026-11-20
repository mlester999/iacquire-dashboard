# INTEG — External integrations architecture

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

Audit of branch claude/ai-growth-partner-completion (HEAD 6e4a4b7e), read-only. I read source, tests and docs; I did not run any test, build or provider call. "Prior recorded runs" below means what docs or test headers claim; I did not re-observe them.

**What exists.** There is no single provider abstraction. Five independent lifecycles coexist:
(1) the agency-only Integration Manager (`src/server/integrations/manager.ts`, providers Hermes/GHL/n8n/LLM, secrets in Supabase Vault through `src/server/security/credentials.ts`);
(2) per-person calendar OAuth for Google and Microsoft (`src/server/calendars/connections.ts` + `adapters/oauth.ts`, tokens sealed with AES-256-GCM under APP_ENCRYPTION_KEY);
(3) Meta social/Facebook-reviews and Google Business Profile reviews (`src/server/social/*`, `src/server/reputation/*`, sealed tokens, behind approval flags);
(4) Automation Studio "connections" (HTTP API and Slack incoming webhook, `src/server/automation-studio/connections.ts`, sealed secret);
(5) messaging/voice transports (Resend, Twilio, Meta WhatsApp, GHL, Vapi, Retell; Vault).

**Real vs simulated.** The calendar OAuth/sync code is the most complete provider integration (PKCE, single-use state, capability test before "connected", refresh, needs_reauth, Google upstream revoke, tenant isolation) and is covered by DB-backed tests, but every provider HTTP call in tests is a fetch mock; docs state it was never run against a live Google or Microsoft account. Reputation and social have an in-process "simulated" adapter that refuses to run in production. GHL, n8n, Hermes, Twilio, WhatsApp, Meta and Google Business are all documented as "not exercised live".

**Biggest gaps.** Slack is outbound-webhook only; Notion and Airtable do not exist anywhere (only free-text tool names in the custom-project request wizard); Gmail/Drive/Outlook mail/contacts do not exist. There is no common status vocabulary (the directive's Available to connect / Connected / Needs reauthorization / Not configured / Unavailable / Coming soon is not implemented as such; four different enums are used), the client Integrations page does not show Google/Microsoft/Meta provider cards at all, and the agency manager still carries dead `google_calendar`, `email`, `domain`, `external` cards. Secret handling is good in code and tests, but no CI secret scanner exists, the NEXT_PUBLIC guard only covers Supabase names, and neither Vault nor key rotation has been exercised on a hosted project per the docs.

**Capability matrix (verified = recorded live provider proof; none of the rows below is live-verified in this repo).**

| Provider | Code | Tests (real DB, mocked provider HTTP) | Live provider proof | Class |
|---|---|---|---|---|
| Google Calendar (OAuth, busy read, event write, Meet) | yes | yes (tests/crm-calendar-connections.test.ts) | none, docs say not run live | synthetic-only |
| Microsoft Outlook/365 Calendar (OAuth, getSchedule, Teams) | yes | yes (same file) | none | synthetic-only |
| Apple iCloud / CalDAV / ICS | yes | yes | none | synthetic-only |
| Google Workspace beyond Calendar (Gmail, Drive, Contacts) | no | no | n/a | planned/not started |
| Outlook mail / contacts / OneDrive | no | no | n/a | not started |
| Slack | outbound incoming-webhook only (Automation Studio, premium) | yes (tests/automation-studio-connections.test.ts) | none | synthetic-only |
| Notion, Airtable | no | no | n/a | not started |
| GoHighLevel | agency read-only adapter + migration + messaging transport (writes off by default) | yes | none recorded in repo | synthetic-only |
| Hermes runtime | gateway registry, per-profile keys, tool-inventory verifier, first-party MCP | yes, large suite | CI acceptance on pinned v0.22.5 with synthetic inference; older real-gateway read-only checks per docs | synthetic-only |
| n8n | read-only inventory + gated webhook trigger step (off unless N8N_ACTIONS_ENABLED) | yes | none | synthetic-only |
| Google Business Profile reviews | yes, header says endpoints written from memory | yes (tests/reputation-google.test.ts) | blocked on Google approval | externally-blocked |
| Meta social / Facebook reviews | yes | yes | blocked on Meta app review | externally-blocked |
| Resend / Twilio / Meta WhatsApp / Vapi / Retell | yes | yes | Twilio header: never exercised live | synthetic-only |

---

<a id="gp-integ-01"></a>
### GP-INTEG-01 — Shared provider lifecycle abstraction (twelve lifecycle items)

- **Requirement:** Shared provider lifecycle abstraction (twelve lifecycle items) (directive §15)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/integrations.ts`, `src/server/integrations/manager.ts`, `src/server/security/credentials.ts`, `src/server/calendars/connections.ts`, `src/server/social/accounts.ts`, `src/server/reputation/connections.ts`, `src/server/automation-studio/connections.ts`
- **Test coverage:** tests/integrations-security.test.ts (credential boundaries, rotation/revoke, RLS, GHL/Hermes/n8n); tests/crm-calendar-connections.test.ts (calendar lifecycle, 1530 lines); tests/automation-studio-connections.test.ts; tests/social-accounts.test.ts and tests/reputation-connections.test.ts exist. They prove each family's own lifecycle against PGlite with mocked HTTP. Nothing tests a cross-family contract, because none exists.
  - Lifecycle matrix as implemented (twelve items):
  - Connection availability: calendar `calendarConnectionSettings()` :95 (configured + unavailableReason); reputation `siteEnvironment()` (providers/index.ts); manager has no availability concept beyond `SUPPORTED` set in `src/components/admin/integrations-manager.tsx:23`.
  - OAuth or approved credential flow: OAuth+PKCE only for calendar (google/microsoft), Google Business (reputation) and Meta (social); manager providers use pasted agency-owned credentials; Slack/HTTP use a pasted secret.
  - Scopes: calendar scopes constants in `adapters/oauth.ts:27-37`; GHL `GHL_READ_SCOPES` (inspection.ts:73) with write scopes rejected (tests/integrations-security.test.ts "rejects unapproved endpoints, URL credentials and write scopes"); Hermes toolset allowlist (`hermes/tool-policy.ts`).
  - Tenant ownership: calendar connections are per user within an org with RLS (test "keeps each workspace's connections..."); manager rows keyed `org_id`; automation connections `org_id` and `loadLive` checks org.
  - Token refresh: only calendar (`oauthSession` :319, `refreshAccessToken` oauth.ts:141). Meta stores one access token (social/credentials.ts) with expiry warnings (`warnExpiring`, accounts.ts:473). Everything else is a static key with manual rotation.
  - Revocation handling: calendar `invalid_grant` becomes a CalendarProviderError "auth" and then `markNeedsReauth`; social `markAccountNeedsReauth` (accounts.ts:586) and `revokeByProviderUser` (:438) for deauthorization webhooks; manager has no provider-revocation detection beyond error status.
  - Disconnection: calendar clears credentials, busy rows, revokes Google upstream only (Microsoft has no per-app revoke, `revokeToken` returns false for microsoft, oauth.ts:149); manager disconnect revokes only the portal reference (docs/credential-security.md:30 says so).
  - Error handling: typed CalendarProviderError kinds (auth, rate_limited, unavailable, invalid), `recordProviderFailure` (reputation), `judgeResponse/judgeFailure` (security/outbound-http.ts) for Studio.
  - Permission checks: calendar `calendars.connect`/`calendars.manage` (`assertConnector` :168); manager agency super admin (`authorize` :23); Studio `workflows.manage` plus plan entitlement.
  - Health indicators: calendar status + lastSuccessAt + consecutive_failures; manager `integration_connection_checks`; Studio status/verified_at; admin health service `src/server/admin/health.ts`.
  - Audit logs: `recordAudit` on every family (crm.calendar_connected/disconnected/reauth_required, integration.connection_tested, automation_studio.connection_*); `sanitizeAuditMetadata` (src/server/audit.ts) redacts secret-looking keys.
  - Tool access permissions: see GP-INTEG-14.
- **Real or simulated behavior:** Real code and PGlite DB per family; no common interface. Five independent lifecycles (agency Integration Manager with Vault, per-person calendar OAuth with AES-sealed tokens, Meta/Google Business, Automation Studio connections, messaging/voice transports).
- **Missing dependencies:** none external.
- **Remaining work:** Create one provider registry (e.g. src/server/integrations/registry.ts) declaring availability, auth kind, scopes, owner scope, storage, refresh, revoke, health and tool permissions for every provider; drive client and agency screens from it; remove or implement legacy enum members google_calendar/email/domain/external in src/lib/integrations.ts and src/server/aqi/ops/tools/integrations.ts; add a contract test requiring all twelve items per provider.
- **Verification evidence:** read the files above. Prior recorded: docs/integrations.md and docs/credential-security.md describe the Manager lifecycle; tests/integrations-security.test.ts header says synthetic data and mocked HTTP.
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A single registry drives every integrations screen; a contract test proves each provider declares all twelve lifecycle items and none is active without a recorded check.

<a id="gp-integ-02"></a>
### GP-INTEG-02 — Honest integration status vocabulary and client integrations hub

- **Requirement:** Honest integration status vocabulary and client integrations hub (directive §15)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/integrations.ts`, `src/components/crm/scheduling/connections/status.ts`, `src/app/(portal)/settings/integrations/page.tsx`, `src/lib/integrations/client-tools.ts`, `src/components/admin/integrations-manager.tsx`, `src/server/calendars/connections.ts`, `docs/integrations.md`
- **Test coverage:** tests/client-integrations.test.ts (cards derived from recorded state, "treats a mapped location without a verified check as pending, never connected"); tests/crm-calendar-connections.test.ts "calendar connections screen" (:1243-1320: no fake connect for an unconfigured provider, status words do not overstate); tests/integrations-security.test.ts ("saved credentials are not connected"); tests/growth-partner-capability-readiness-ui.test.tsx. These prove no card shows connected without a recorded check. They do not prove the directive's six-state vocabulary because it is not implemented.
- **Real or simulated behavior:** Status is derived from recorded checks and env configuration; nothing is hard-coded connected. The directive's six-state vocabulary is not implemented; four different enums are used.
- **Missing dependencies:** none.
- **Remaining work:** Add a shared ProviderStatus (available_to_connect, connected, needs_reauthorization, not_configured, unavailable, coming_soon) with mappers from calendar, social, reputation, manager and studio states; add Google Calendar, Outlook, Slack, Meta, Google Business and Coming-soon Notion/Airtable cards to settings/integrations/page.tsx; remove dead agency cards (google_calendar, email, domain, external); fix the client sentence that Slack is internal-only and the stale docs/integrations.md line saying Google Calendar has no connector; test that connected requires a recorded successful check. | Skeptic adds: The client hub's own 'Customer messaging' card overstates: it shows 'Configured' (success icon tile) and says 'Email, SMS and WhatsApp send through iAcquire' from a bare count of messaging_channels.enabled, ignoring the deployment write kill switch (transportWritesEnabled) and the tested/verified state. Reuse describeChannel()/getChannelHealth() (src/server/messaging/channel-health.ts:43-51) which already returns needs_attention when writes are off. Also the hub's Growth Partner runtime query uses runtimeReadySql without credentialRevocation, so a revoked credential can still read 'Ready' until the next health run. Also note integration_status.status holds more vocabularies than the audit lists: configured, disabled, degraded, pending (manager.ts disconnect writes 'disabled'; healthState() maps degraded/disabled/pending).
- **Verification evidence:** read page.tsx, client-tools.ts, status.ts, integrations-manager.tsx and the tests' titles. Not run.
  - *Skeptic review: The audit says no status is hard-coded connected and that 'status words do not overstate'. True for calendars and GHL, but the messaging card is derived from a configuration count, not a recorded check, and conflicts with the same codebase's honest channel-health logic.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every provider shows exactly one of the six states from recorded evidence, unconfigured providers show no working connect control, coming-soon providers are inert, and tests enforce the mapping.

<a id="gp-integ-03"></a>
### GP-INTEG-03 — Secret handling: storage encryption, redaction, prompts, browser bundles, repository

- **Requirement:** Secret handling: storage encryption, redaction, prompts, browser bundles, repository (directive §15)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/security/crypto.ts`, `src/server/security/credentials.ts`, `src/server/security/sealed-secrets.ts`, `src/server/audit.ts`, `src/lib/secrets.ts`, `src/server/aqi/ops/redact.ts`, `src/server/env.ts`, `src/lib/supabase-config.ts`, `src/server/social/credentials.ts`, `.github/workflows/hermes-inference-worker.yml`
- **Test coverage:** tests/integrations-security.test.ts :276-309 (a leaked key must not appear in console output or any diagnostics table, including audit_logs, check rows, credential rows); tests/crm-calendar-connections.test.ts :390-425 (ciphertext does not contain the tokens, application role cannot select `credentials`, audit and views contain no token); tests/automation-studio-connections.test.ts :112-142 (secret encrypted, hint only, no logs, role cannot read column); tests/sealed-secret-rotation.test.ts (rotation, registry of sealed columns); tests/integrations-api.test.ts (no echo, no-store headers); tests/client-bundle-safety.test.ts (client components cannot import src/server or server-only); tests/supabase-config.test.ts (secret in NEXT_PUBLIC refused); tests/credential-secret-encoding.test.ts. These are real-DB tests with mocked provider HTTP.
- **Real or simulated behavior:** Real AES-256-GCM and Vault SQL calls in code; Vault is replaced by SECRET_STORE=test-memory in tests (test-only). Leak tests use real DB tables with mocked provider HTTP. No hosted Vault or hosted key-rotation run recorded.
- **Missing dependencies:** a hosted Supabase project with Vault and a rotation window (founder-gated) for live proof.
- **Remaining work:** Generalize the NEXT_PUBLIC secret guard in src/server/env.ts beyond three Supabase names; add a CI secret scanner under .github/workflows; add a built-bundle scan for server env names in CI; confirm tracked .env.development holds placeholders only (not inspected, read was blocked); extend console/table leak tests to Google/Microsoft token exchange, Slack webhook and Meta paths; record a hosted reseal dry run. | Skeptic adds: Item (4) in the audit is closable now: the tracked .env.development was read key by key without printing values. Provider secrets (SUPABASE_SECRET_KEY, RESEND_API_KEY, LLM_API_KEY, Supabase public values) are empty; all write switches are false; CALENDAR_SYNC_DISABLED=true; the only non-empty secrets are the 43-char APP_ENCRYPTION_KEY and 45-char SITES_FORM_SECRET with a 'local-' prefix (dev-only, publicly visible in a public repo). Remaining real gap: env.ts only requires APP_ENCRYPTION_KEY >= 32 chars in production, so the committed dev key would pass the production check; add a refusal for the known committed dev values (and for the built-in fallback key in crypto.ts:65).
- **Verification evidence:** read all listed source and test titles; ran only `git ls-files`/`git grep` pattern searches (counts and file names, no values printed). Prior recorded: docs/credential-security.md.
  - *Skeptic review: Resolves an item the auditor could not read, and finds the guard that is missing.*
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Automated gates refuse secrets in public variables, the repository and the client bundle; leak tests cover every provider family; a hosted Vault round trip and rotation dry run are recorded.

<a id="gp-integ-04"></a>
### GP-INTEG-04 — Google Calendar (per-person OAuth, busy sync, event write-back, Meet)

- **Requirement:** Google Calendar (per-person OAuth, busy sync, event write-back, Meet) (directive §15)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** no
- **Source files:** `src/server/calendars/adapters/oauth.ts`, `src/server/calendars/adapters/google.ts`, `src/server/calendars/connections.ts`, `src/server/calendars/sync.ts`, `src/app/api/crm/calendar-oauth/[provider]/start/route.ts`, `src/app/api/crm/calendar-oauth/[provider]/callback/route.ts`, `src/server/calendars/availability.ts`
- **Test coverage:** tests/crm-calendar-connections.test.ts "google and microsoft sign-in" :342-486 (hashed single-use state, S256 PKCE, least-privilege scope list, role refusal, support sessions refused, tokens encrypted, capability test ran, expired/denied saves nothing, reconnect updates same row), "google busy sync" :516-703 (refresh and needs_reauth once, 410 resync, rate-limit backoff, scheduler claims, kill switch), "write-back" :887+, "options, disconnecting and tenant isolation" :1044-1114, "oauth routes" :1148-1190. Proves the code path against a faithful mock; does not prove Google's real response shapes.
- **Real or simulated behavior:** Real server code, PGlite DB and crypto; every Google HTTP call is a fetch mock router. docs/calendar-integrations.md states no live Google account was ever used.
- **Missing dependencies:** Google Cloud OAuth app registration and consent-screen verification (sensitive scopes), client ID/secret in server settings (docs/calendar-integrations.md "Registering the Google OAuth app"); a real account for a staging check.
- **Remaining work:** Add a single-flight or race test for concurrent token refresh (oauthSession.doRefresh); run the live checklist in docs/calendar-integrations.md (Not verified yet) on staging. | Skeptic adds: Availability trusts crm_external_busy for any connection with status='connected' and check_conflicts, with no freshness bound (no last_success_at/last_synced_at test). With CALENDAR_SYNC_DISABLED, a stopped scheduler or an ICS poll gap, old busy rows keep suppressing or permitting slots while the screen still says 'Connected' in the success tone with a relative time. Add a staleness cutoff (treat busy data older than N sync intervals as 'Not syncing' and surface it) plus a test.
- **Verification evidence:** read connections.ts, oauth.ts, google.ts head, test titles and the first 430 lines of the test. Prior recorded: docs/calendar-integrations.md states mock-only.
  - *Skeptic review: Status/health honesty hole on the one fully built provider. The row's IMPLEMENTED_UNVERIFIED status is otherwise upheld: the OAuth path (single-use hashed state bound to user, S256 PKCE verifier sealed, capability read before save, Google required-scope check, refresh-token-missing refusal with upstream revoke, needs_reauth on invalid_grant, write scope derived from granted scopes) was re-traced and is real, tenant-scoped code exercised by DB-backed tests with only the provider HTTP mocked.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A real Google account connects on staging, busy read and one event with Meet link round-trip, a revoked grant shows Reconnect needed within one sync cycle, disconnect revokes upstream; evidence recorded.

<a id="gp-integ-05"></a>
### GP-INTEG-05 — Microsoft Outlook / Microsoft 365 Calendar (per-person OAuth)

- **Requirement:** Microsoft Outlook / Microsoft 365 Calendar (per-person OAuth) (directive §15)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** no
- **Source files:** `src/server/calendars/adapters/oauth.ts`, `src/server/calendars/adapters/microsoft.ts`, `src/server/calendars/connections.ts`, `src/server/calendars/sync.ts`, `src/server/env.ts`
- **Test coverage:** tests/crm-calendar-connections.test.ts :458-486 (connect after getSchedule, personal-account fallback), :488-515 (getSchedule mapping: busy/tentative/oof counted), :705-792 (calendarView busy sync), :1115-1147 (Teams meeting), :1320-1353 (Exchange time zones). Real DB, mocked Graph.
- **Real or simulated behavior:** Real code and DB; Graph HTTP mocked; never run against live Microsoft. Requests Calendars.ReadWrite (broader than Google's split scopes); no upstream token revocation exists, disconnect is local only.
- **Missing dependencies:** Azure app registration, publisher verification, client ID/secret, admin-consent decision for organizational tenants.
- **Remaining work:** Test persistence of a rotated refresh token under concurrent refresh; decide on a read-only connect mode vs Calendars.ReadWrite; add a remove-access link in the disconnect copy; run live staging check of getSchedule, personal-account fallback and Teams link.
- **Verification evidence:** read oauth.ts, microsoft.ts exports, connections.ts OAuth flow and test titles.
  - *Skeptic review: Upheld as IMPLEMENTED_UNVERIFIED. Re-traced: Microsoft connect has no required-scope check equivalent to Google's GOOGLE_REQUIRED_SCOPES (the capability read stands in), and the refresh token rotates and is persisted under 'where id=$1 and status<>disconnected' with no single-flight guard, so two concurrent refreshes can leave the connection holding a refresh token the provider already rotated. That is the concurrency test the audit already recommends; it is a plausible real-world failure for Microsoft specifically.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Work and personal accounts connect on staging; busy read, event write and Teams link verified; revoked consent shows Reconnect needed; disconnect copy states the Microsoft limitation.

<a id="gp-integ-06"></a>
### GP-INTEG-06 — Google Workspace beyond Calendar and Microsoft 365 mail, contacts and files

- **Requirement:** Google Workspace beyond Calendar and Microsoft 365 mail, contacts and files (directive §15)
- **Current implementation status:** NOT STARTED
- **Priority:** P2  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/calendars/adapters/oauth.ts`
- **Test coverage:** none.
- **Real or simulated behavior:** Nothing exists: no Gmail, Drive, Sheets, People or Graph mail/contacts code. OAuthProvider is limited to calendar use.
- **Missing dependencies:** product decision on which read scopes the Growth Partner needs (restricted Gmail/Drive scopes require Google security assessment); OAuth app approvals.
- **Remaining work:** Decide required read scopes; generalize OAuthProvider/oauthConfig into a provider-and-purpose registry under src/server/integrations/oauth/; build connectors with the full lifecycle, or show Coming soon cards and document the out-of-scope decision.
- **Verification evidence:** negative grep only.
- **Definition of done:** Either a scoped connector with lifecycle, tests and honest status, or a recorded out-of-scope decision with Coming soon cards.

<a id="gp-integ-07"></a>
### GP-INTEG-07 — Slack

- **Requirement:** Slack (directive §15)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/automation-studio/connections.ts`, `src/server/automation-studio/connections.ts`, `src/server/automation-studio/outbound.ts`, `src/components/automation-studio/connections-panel.tsx`, `src/server/notifications.ts`, `src/server/admin/health.ts`, `src/app/(portal)/settings/integrations/page.tsx`
- **Test coverage:** tests/automation-studio-connections.test.ts :169-179 (only real incoming-webhook shape), :226-259 (verified only after a confirmed test post; Slack answer must be ok), :288-352 (rotate, revoke erases secret), :505-520 (mentions/links neutralized), :623-639 (posts filled escaped message, never shows address), :742-754 (revoked blocks), :521-536 (premium plan gating). Real DB, mocked HTTP.
- **Real or simulated behavior:** Real outbound POST to hooks.slack.com through performOutbound (host pinned, idempotency, redaction), mocked in tests. Incoming-webhook only: no OAuth, no inbound events, no Slack tool for the Growth Partner; premium Automation Studio plan required. SLACK_SUPPORT_WEBHOOK_URL is an iAcquire-internal alert path.
- **Missing dependencies:** Slack app registration only if OAuth/inbound is wanted (product decision).
- **Remaining work:** Fix the client page sentence saying Slack is internal-only and list Slack in the client hub with a true status; if Slack is to be a Growth Partner channel, implement Slack OAuth (scoped), sealed token, auth.revoke, auth.test health, Needs reauthorization on token_revoked, and a proposal-only MCP tool.
- **Verification evidence:** read connections.ts, outbound.ts head, the connections panel text and the Slack test titles.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Slack appears in the client hub with a recorded-evidence status; one verified path with lifecycle tests including revocation; any Growth Partner Slack action is a proposal a person approves.

<a id="gp-integ-08"></a>
### GP-INTEG-08 — Notion

- **Requirement:** Notion (directive §15)
- **Current implementation status:** NOT STARTED
- **Priority:** P3  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/components/projects/request-wizard.tsx`, `supabase/migrations/0015_custom_projects.sql`
- **Test coverage:** none.
- **Real or simulated behavior:** Nothing functional; the word appears only as a free-text tool chip and catalogue seed copy in the custom-project flow.
- **Missing dependencies:** Notion integration (public OAuth app or internal token), product decision about what the Growth Partner would read or write.
- **Remaining work:** Define scope; implement through the GP-INTEG-01 registry with OAuth, sealed token, status, documented lack of token revocation; show a Coming soon card until built.
- **Verification evidence:** repo-wide grep for "notion" in src, tests, docs, scripts, services.
- **Definition of done:** A Coming soon card, or a connector meeting all twelve lifecycle items with tests.

<a id="gp-integ-09"></a>
### GP-INTEG-09 — Airtable

- **Requirement:** Airtable (directive §15)
- **Current implementation status:** NOT STARTED
- **Priority:** P3  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/components/projects/request-wizard.tsx`, `supabase/migrations/0015_custom_projects.sql`
- **Test coverage:** none.
- **Real or simulated behavior:** Nothing functional; free-text tool chip and catalogue seed copy only.
- **Missing dependencies:** Airtable OAuth app (scopes data.records:read, schema.bases:read) and product decision.
- **Remaining work:** As Notion: implement via the registry with OAuth, refresh and revocation handling, Needs reauthorization status; Coming soon card until then.
- **Verification evidence:** repo-wide grep for "airtable".
- **Definition of done:** A Coming soon card, or a connector meeting all twelve lifecycle items with tests.

<a id="gp-integ-10"></a>
### GP-INTEG-10 — GoHighLevel (agency-managed CRM and calendar integration)

- **Requirement:** GoHighLevel (agency-managed CRM and calendar integration) (directive §15)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/integrations/ghl.ts`, `src/server/integrations/inspection.ts`, `src/server/integrations/manager.ts`, `src/server/crm/ghl-migration.ts`, `src/server/messaging/transports/ghl.ts`, `src/lib/integrations/client-tools.ts`
- **Test coverage:** tests/integrations-security.test.ts :124-221 (location mismatch before reads, protected locations never touched, permission-limited reported honestly, no sync before a passing read-only test, GET-only sync, mapping only from verified inventory, super-admin only); tests/ghl-readonly.test.ts; tests/crm-ghl-migration.test.ts; tests/client-integrations.test.ts. Real DB, mocked HTTP.
- **Real or simulated behavior:** Real adapter with Vault-stored per-location tokens and a read-only scope list; mocked HTTP in tests. Writes (messages, appointments) off unless GHL_WRITES_ENABLED. No recorded live GHL acceptance in the repo.
- **Missing dependencies:** a real GHL location token and approved write scopes for any write acceptance.
- **Remaining work:** Map 401/403 to a needs-reauthorization state; move or justify the literal PROTECTED_LOCATIONS ids in src/server/integrations/ghl.ts; test that disconnect cannot be resurrected by later events; run live read-only check. | Skeptic adds: The GHL per-location burst budget (takeGhlBurstSlot) is a process-local Map, so on serverless instances the 90-per-10s cap is not shared; a migration reading across instances can exceed GoHighLevel's limit and rely only on 429 handling. Document or move the counter to the database.
- **Verification evidence:** read ghl.ts and inspection.ts headers, manager flows and test titles.
  - *Skeptic review: Upholds IMPLEMENTED_UNVERIFIED. Re-traced ghlGet: official-origin pin, redirect:'error', 401/403 mapped to a typed error that never carries the token, rows scoped to the mapped location, protected locations rejected before network. The in-process budget is a real limitation the audit did not mention.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Recorded live read-only check on a staging location; token failure shows Needs reauthorization; writes remain off until separately approved and tested.

<a id="gp-integ-11"></a>
### GP-INTEG-11 — Hermes runtime gateway and LLM provider connection

- **Requirement:** Hermes runtime gateway and LLM provider connection (directive §15)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** no
- **Source files:** `src/server/integrations/hermes/client.ts`, `src/server/integrations/hermes/gateways.ts`, `src/server/integrations/hermes/inventory.ts`, `src/server/integrations/hermes/tool-policy.ts`, `src/server/integrations/hermes/setup.ts`, `src/server/integrations/manager.ts`, `src/server/integrations/safety.ts`
- **Test coverage:** ~90 files named tests/hermes-*.test.ts plus tests/agency-hermes-workforce.test.ts and tests/workforce-config.test.ts; tests/integrations-security.test.ts :77-122 (gateway Access credentials stored apart from profile keys, dangerous tool permissions rejected). Real DB, mock gateway.
- **Real or simulated behavior:** Real gateway client with pinned HTTPS, per-profile keys and Access credentials in Vault; acceptance uses a mock gateway and synthetic inference. Docs record a hosted CI acceptance on pinned Hermes v0.22.5 and earlier read-only live gateway checks; real-model and live tenant behaviour are not established by the repo.
- **Missing dependencies:** live gateway and a real model key for real-model verification; founder approvals recorded in project memory for each production step.
- **Remaining work:** Map gateway status into the shared vocabulary (GP-INTEG-02); live verification of the pinned version and reviewed tool inventory; per-tenant profile isolation re-check live.
- **Verification evidence:** read tool-policy.ts, manager Hermes functions, test inventory; docs claims separated above.
  - *Skeptic review: Upheld as IMPLEMENTED_UNVERIFIED. The hosted acceptance runs (docs/ai-growth-partner/implementation-status.md run 87/88/89) are synthetic: mock-model fixture, externalNetwork disabled, two synthetic tenants. Note the acceptance workflow triggers only on codex/hermes-gha-acceptance or a dispatch from codex/ai-growth-partner, not on this branch, so no CI evidence is bound to the audited HEAD.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Pinned-version gateway verified live with the reviewed tool inventory and per-tenant isolation, with recorded evidence.

<a id="gp-integ-12"></a>
### GP-INTEG-12 — n8n (agency workflows)

- **Requirement:** n8n (agency workflows) (directive §15)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** synthetic-only  |  **Unblocked now:** no
- **Source files:** `src/server/integrations/n8n.ts`, `src/server/integrations/n8n-actions.ts`, `src/server/integrations/inspection.ts`, `src/server/integrations/manager.ts`
- **Test coverage:** tests/integrations-security.test.ts :145-165,246-275 (fails safely, rejects arbitrary workflow IDs, filtered payloads, duplicate assignment prevented, health cleared on rotation); n8n step tests in tests/crm-workflow-engine.test.ts, tests/crm-custom-values.test.ts. Real DB, mocked HTTP.
- **Real or simulated behavior:** Real adapter, mocked HTTP; trigger calls off unless N8N_ACTIONS_ENABLED=true; docs/integrations.md says not verified live.
- **Missing dependencies:** an n8n instance and approved workflow ids for live proof.
- **Remaining work:** Live read-only inventory and one approved trigger call on staging; status mapping per GP-INTEG-02. No code gap found.
- **Verification evidence:** read header and function list; test titles.
  - *Skeptic review: Upheld as IMPLEMENTED_UNVERIFIED and arguably stronger than described: the n8n call path takes a per-key pg_advisory_xact_lock, re-checks workspace state and pauses, requires a verified mapping to the agency connection, an agency-approved workflow id list and a stored trigger credential, re-validates the trigger URL, and writes started/finished ledger rows so an unknown outcome is never repeated. Tenant scoping is on every query (org_id = $2). Caveat the audit missed: the idempotency ledger is audit_logs rows with a 30-day window, not a unique constraint, so keys older than 30 days can send again.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Live inventory read and one approved trigger call on staging with the switch enabled only for that test; evidence recorded.

<a id="gp-integ-13"></a>
### GP-INTEG-13 — Other provider integrations found: Google Business Profile reviews, Meta social and reviews, messaging transports, voice

- **Requirement:** Other provider integrations found: Google Business Profile reviews, Meta social and reviews, messaging transports, voice (directive §15)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/reputation/providers/google.ts`, `src/server/reputation/providers/meta-reviews.ts`, `src/server/reputation/providers/index.ts`, `src/server/reputation/connections.ts`, `src/server/social/accounts.ts`, `src/server/social/providers/meta.ts`, `src/server/messaging/transports/twilio.ts`, `src/server/messaging/transports/meta-whatsapp.ts`, `src/server/messaging/transports/resend.ts`, `src/server/integrations/voice/vapi.ts`, `src/server/integrations/voice/retell.ts`
- **Test coverage:** tests/reputation-google.test.ts, tests/reputation-meta-reviews.test.ts, tests/reputation-connections.test.ts, tests/social-meta.test.ts, tests/social-accounts.test.ts, tests/messaging-twilio.test.ts, tests/messaging-whatsapp.test.ts, tests/messaging-resend.test.ts, tests/messaging-transports.test.ts. Real DB, mocked provider HTTP; I did not read these in detail.
- **Real or simulated behavior:** Real adapters behind off-by-default switches; simulated in-process review and social adapters refuse to run in production. Google Business header admits endpoints were written from memory; Twilio header says never exercised live.
- **Missing dependencies:** Google Business API approval and verification; Meta app review; Twilio/Resend/WhatsApp live accounts. Twilio header (twilio.ts:31) says never exercised live.
- **Remaining work:** Map their statuses into the shared vocabulary and client hub; add them to the registry; re-read Google Business endpoint names against current documentation before applying; live acceptance per provider once approvals exist.
- **Verification evidence:** read provider index files, headers and env comments only.
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Each provider shows Unavailable or Not configured honestly (flags already enforce this) or has a recorded live acceptance.

<a id="gp-integ-14"></a>
### GP-INTEG-14 — Growth Partner tool access permissions over integrations (provider capability gating)

- **Requirement:** Growth Partner tool access permissions over integrations (provider capability gating) (directive §15)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/integrations/hermes/tool-policy.ts`, `src/lib/employee-tool-policy.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts`, `src/server/ai-growth-partner/capability-access.ts`, `src/lib/ai-growth-partner-capability-access.ts`
- **Test coverage:** tests/ai-growth-partner-capability-access.test.ts (statuses; groups every capability once); tests/hermes-tool-inventory.test.ts (:146 a `manage_connections` tool is rejected); tests/hermes-tool-policies.test.ts; tests/hermes-client-business-mcp-*.test.ts (permissions, limits, policy, route); tests/workforce-config.test.ts :201 (disabled toolsets). These prove the allowlist logic and that third-party connector tools cannot reach the client Growth Partner.
- **Real or simulated behavior:** Real default-deny policy tables and DB checks; runtime side verified against a mock gateway and CI synthetic inference; client business MCP is dormant behind HERMES_CLIENT_BUSINESS_MCP_ENABLED and the client_business_tools org feature. Third-party connector toolsets (connections, connectors__*, manage_connections, Tool Search) are denied, so Google, Outlook, Slack, Notion and Airtable give the Growth Partner no direct tools today.
- **Missing dependencies:** none for the existing safe design.
- **Remaining work:** When connectors are added (GP-INTEG-06..09), add each to a reviewed per-provider tool matrix in src/lib/employee-tool-policy.ts with read/draft/proposal effect, ability switch, member permission and audit, with tests; make the GP-INTEG-01 registry the single source; do not advertise provider capabilities the Growth Partner cannot perform. | Skeptic adds: The Growth Partner capability access derivation returns status 'available' from member permissions, ability switches and runtime health only; it takes no input for HERMES_CLIENT_BUSINESS_MCP_ENABLED or the client_business_tools org feature (clientBusinessToolsOn), which is what actually makes the business tools answer. While that tier is dormant, a capability can read 'available' with text saying tools 'your AI Growth Partner can use are checked here'. Pass the tier state into deriveGrowthPartnerCapabilityAccess and add a 'not_enabled' state; the current test has no case for it.
- **Verification evidence:** read tool-policy.ts, employee-tool-policy.ts, client MCP matrix, capability-access test; not run.
  - *Skeptic review: The audit praises the honest capability statuses; the 'available' branch itself can be premature. The deny-list/allowlist policy rows were verified (connections/skills/terminal toolsets disabled, connector prefixes denied, explicit read-only matrix) and stand.*
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every provider tool is in a reviewed default-deny matrix tested per role, and the UI only advertises capabilities whose status is available.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Client Integrations hub: 'Customer messaging' card shows Configured / 'send through iAcquire' from a channel-enabled count, ignoring the write kill switch and test state", "directiveRef": "§15 honest status", "priority": "P1", "status": "PARTIAL", "remainingWork": "Drive the card from describeChannel()/getChannelHealth (needs_attention when writes are off, not_connected when no verified sender); use the shared status vocabulary; add a test with RESEND_WRITES_ENABLED=false asserting the card is not 'Configured'. Evidence: src/app/(portal)/settings/integrations/page.tsx:117-135 vs src/server/messaging/channel-health.ts:43-51."}
- {"title": "Growth Partner capability 'available' status ignores whether the client business tool tier is enabled", "directiveRef": "§15 tool access permissions / honest status", "priority": "P1", "status": "PARTIAL", "remainingWork": "Add deployment flag + org feature (clientBusinessToolsOn) and proposals switch to the derivation input and a distinct not-enabled status; test. Evidence: src/lib/ai-growth-partner-capability-access.ts:31-71, src/server/workforce/hermes-client-business-mcp-policy.ts:76-78."}
- {"title": "Production does not refuse the publicly committed development encryption key", "directiveRef": "§15 secret handling (token storage encryption)", "priority": "P2", "status": "PARTIAL", "remainingWork": "In env() production validation, reject APP_ENCRYPTION_KEY / SITES_FORM_SECRET equal to the committed .env.development values and the crypto.ts built-in fallback; add to tests/environment-safety.test.ts. Evidence: src/server/env.ts:404-406, src/server/security/crypto.ts:65, .env.development."}
- {"title": "Connected-calendar busy data has no staleness bound in availability", "directiveRef": "§15 integration health indicators", "priority": "P2", "status": "PARTIAL", "remainingWork": "Bound crm_external_busy use by connection freshness and show 'Not syncing' when sync is paused or stale; test with CALENDAR_SYNC_DISABLED. Evidence: src/server/calendars/availability.ts:125-130."}
- {"title": "Process-local GHL rate budget on serverless, and n8n idempotency ledger limited to 30 days of audit_logs", "directiveRef": "§15 error handling / idempotency", "priority": "P3", "status": "PARTIAL", "remainingWork": "Move the burst counter to a shared store or document the 429 fallback as the actual guarantee; enforce n8n idempotency with a unique key or extend the window beyond the longest workflow retry horizon. Evidence: src/server/integrations/ghl.ts:330-343, src/server/integrations/n8n-actions.ts:39,207-214."}
