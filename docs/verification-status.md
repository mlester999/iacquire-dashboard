# Verification status

## Current production workforce checkpoint (2026-10-24)

The current production evidence is the read-only [internal workforce preflight](internal-workforce-production-preflight-2026-10-24.md).
It supersedes the dated 2026-10-19 checkpoint and older Hermes inventory observations below.

| Gate | Current result |
| --- | --- |
| Hosted migration ledger | Application ledger records `0080`, `0081`, `0082`, `0083`, `0085` and `0086`; `0084_restricted_hermes_provisioner` is absent. The Supabase CLI ledger table is absent. Local PGlite verifies 0084 can be applied after 0086; hosted application remains an explicitly approved production change. |
| Internal company profile | 4/4 required business facts saved. |
| Application readiness | Zeng and Lead Hunter are 6/6. Appointment Setter, Sales Assistant, CRM Manager and Performance Analyst have no applied configuration and remain 0/6/unavailable. |
| Live Hermes profiles | All six existing internal identities authenticate and match; complete six-tool inventory verified across five reviewed toolsets, with no restricted tools enabled. |
| Saved readiness evidence for new four | Stale/restricted; current live Hermes inventory has not been written into the app's readiness rows. |
| Effective SOUL instructions | Unverified; current API has no admin configuration read endpoint. |
| Production application SHA | Unverified; no deployment record or runtime SHA was available in the preflight. |
| Proactive operator switches | Schedules, triggers, briefings and worker all false; no autonomous workforce processing enabled. |
| Prior Lead Hunter research | Targeted read-only query confirmed the supplied work job and Hermes run remain completed, with 10 saved leads. The eight historical web tool calls were not re-read from a separate event source. |
| Client provisioner sandbox | GitHub Actions run [40059587299](https://github.com/mlester999/iacquire-dashboard/actions/runs/40059587299) passed at commit `85481852c5098044909ad96e87b273c59a720e65`, including isolated synthetic tenants, actual portal routes, provisioner runtime and cleanup. This is sandbox evidence, not production provisioning. |
| Changes during preflight | No employee configuration, profile, acknowledgement, readiness row, schedule, worker or business record was changed. Resolving Hermes credentials appended the normal `credential.resolved` audit rows. |
| Current local code | Branch `codex/iacquire-workforce-completion`, based on local `master` `22c68c2`, includes the guarded appointment handoff, first-config drafts for the four unconfigured internal roles, restricted client provisioner, local-time schedule recurrence, a tenant-scoped calendar data layer and read-only API with bounded schedule projections, the Sales Assistant follow-up draft capability (`1c026d8`), expanded nine-field employee personalization (`e193e54`, UI acceptance coverage `0d60385`), chat-created schedule previews with exact confirmation, stale-version checks and paused-only saves, plus role-aware automation routing and approved named employee handoffs. Migration `0088` is local and has not been applied to the hosted database. Work Board and Calendar frontend implementation is awaiting approval of the design previews. The branch is local and has not been pushed or deployed. |

Local release acceptance on the isolated branch: the prior full regression passed **324 test files, 5,021 tests, with 8 skipped**; focused calendar API/data/recurrence tests passed (15 tests). For Sales Assistant follow-up drafts, the first full-suite run reported **324 files, 5,022 passed, 8 skipped and 1 failed** because a legacy assertion compared title case after lowercasing the actual summary. That assertion was corrected; the four affected chat/workforce test files then passed **44/44**, and the capability test was rerun separately (10/10). The full suite was not rerun after that assertion-only correction. `npm run typecheck` passed after the final source edits. Full ESLint reported **0 errors** and 2 existing warnings in `src/server/calendars/agent-booking.ts` and `src/server/calendars/native-availability.ts`; changed-file lint passed. Next.js 16.4.2 Webpack production build passed and emitted `/api/workforce/calendar`. The restricted provisioner Python suite passed 58 tests with 5 container-only skips. These are local results, not production acceptance. No hosted migration, deployment, employee configuration, profile change or worker activation was performed.

The latest Phase 3 local update expands onboarding and safe regeneration previews from four style fields to nine employee behavior fields (personality, traits, communication, response behavior, procedures, proactive responsibilities, reporting, responsibilities and goals). Company facts, owner-selected tone/language, confirmed role answers and protected approval/escalation rules stay mapped from their existing sources; the nine generated fields remain reviewable before the client applies them to a draft. Focused onboarding, role-template and client-provisioning tests passed **52/52**; the additional nine-field preview/acceptance UI suite passed **11/11**. `npm run typecheck` and changed-file ESLint passed. The default Turbopack build hit a local Next package-resolution error; `npx next build --webpack` completed successfully and emitted the full route set. No live model or production provider was called, and no production state changed.

The latest Phase 5 local update adds deterministic natural-language schedule parsing for all six employee roles. Chat displays the cadence, workspace timezone and next planned time; it requires the exact “confirm schedule” phrase, rechecks current permissions and timezone, and saves schedules paused. Confirmation is atomic with the chat proposal state, repeated confirmation does not duplicate the schedule, and stale, expired, or timezone-changed previews fail closed. Only reviewed read-only capabilities and complete Lead Hunter research assignments are schedulable; writes to messages, bookings, CRM records, assignments and drafts are refused. The focused parser, schedule service and chat acceptance passed **25/25**; the broader workforce acceptance passed **113/113 across 12 files**. `npm run typecheck`, changed-file ESLint, `git diff --check`, and `npx next build --webpack` passed. These tests use PGlite and mocked Hermes; no live model or provider was called. Migration `0088` is applied only by the local test database, and no hosted migration, schedule, deployment or production state was changed. The repository-wide `npm test -- --maxWorkers=2` was stopped after about 13 minutes without returning a result; it is not counted as a pass or failure.

Phase 6 role routing now recognizes explicit requests to create, change, test or activate an automation before employee chat's outbound-action refusal runs. It directs authorized viewers to the actual Automation Studio page, or explains that workflow access is required. The route creates no workflow, email or employee job. The focused classifier/chat acceptance passed **26/26**, and changed-file ESLint, `npm run typecheck` and `npx next build --webpack` passed. This is local evidence only; it does not test Automation Studio entitlement or activate a workflow.

Phase 6 named employee handoffs now accept only an explicitly addressed, supported one-time capability assignment. The target employee's role, caller permissions, readiness and tenant are rechecked by the shared dispatcher. The durable job, target-chat notice, job link, provenance event and audit record commit in one transaction; retries reuse the same job and destination thread. Refused writes cannot be delegated, recurring requests are routed to the target employee's own confirmed schedule flow, and unsupported named requests do not fall through to a generic model promise. Focused parser, guardrail, chat and native-job E2E acceptance passed **50/50 across four files**; typecheck, changed-file ESLint, `git diff --check` and `npx next build --webpack` passed. Tests used PGlite and mocked Hermes and verified a CRM Manager review completed without a Hermes model run, retry reuse, and rollback of the job, event and audit record when handoff persistence fails. This is local evidence only; no hosted configuration, migration, employee readiness, production data or deployment changed.

The Sales Assistant follow-up capability requires `agents.use`, `sales.view` and `inbox.reply`, is not a Work Board action or schedule, and creates only deduplicated unsent Inbox drafts. It uses a neutral deterministic template, does not pass conversation text to a provider, and leaves any later send behind the normal human approval and messaging checks. Its E2E test uses synthetic tenant records and verifies employee ownership scoping, ignored injected discount instructions, retry reuse, and `sent_at IS NULL`.

## Historical application and CRM checkpoint (2026-10-19)

| Gate | Result |
| --- | --- |
| `npm test -- --maxWorkers=2` | **2,911 passed / 2,911 (163 files)** on the final CRM commit |
| `npm run typecheck` | passes on the final CRM commit |
| `npm run lint` | passes on the final CRM commit; 0 errors and 0 warnings |
| Production build | isolated build passes on Next.js 16.4.2 with Webpack and an 8 GiB Node heap |
| RLS migration check | `0060_rls_initplan` is up to date; 166 SELECT policies rewritten. Migration applied to hosted on 2026-10-19 after its guard checks; equivalence and rollback tests pass locally |
| Website thumbnails | 50 regenerated; browser comparison passed 50/50 with 0 flagged templates |
| CRM browser QA | 114 all-route desktop/light visits across six personas, 62 focused phone/dark visits, 9 focused replays; 14/14 interactions passed. 0 axe violations, 0 non-local requests and 0 5xx responses; the phone/dark matrix had 0 overflow |
| Hosted schema | Migration numbers are now unique: CRM `0035`–`0039` → `0054`–`0058`, Hermes inventory `0047` → `0059`, RLS `0053` → `0060`. Applied on 2026-10-19 after `pg_dump` backups: the nine CRM migrations, `0059_hermes_tool_inventory`, `0060_rls_initplan` and the manager Blueprint grants (applied as `0061`, now `0062_agency_manager_blueprint_permissions` because AQi Phase 3 took `0061`/`0063`); the ledger's CRM rows were renamed in the same pass. **251 public tables, 60 migrations recorded, 0 public tables without row level security, no pending migrations** at that point; the ledger now records 62 migrations (`0001`–`0063`) and matches the repository. See [workforce-migration-and-release.md](workforce-migration-and-release.md). |

The CRM browser and Website Studio thumbnail runs are **local only**. They use fictional records, an embedded PGlite database and local sign-in; the browser is restricted to the exact QA loopback origin. No provider, customer message, website publication or deployment was used for this verification.

The final suite, typecheck, lint and build were run from a clean worktree at commit `73a0797`, so the separate, uncommitted AQi Phase 3 work in the main checkout was not included in this CRM verification or push.

The CRM migrations were applied on 2026-10-19 after a `pg_dump` custom-format backup (`pre-crm-20261019T063759.dump`, 2,632 TOC entries, kept outside the repository under the git-ignored `.data/backups/`). A second backup (`pre-renumber-20261019T065124.dump`) was taken before the renumbering. The hosted ledger now records 60 migrations and 251 public tables, no public table lacks row level security, and no migration is pending. `0059_hermes_tool_inventory` and `0060_rls_initplan` were applied in the same pass: the inventory contract is recorded but the deployed Hermes 0.21.5 gateway still fails verification, so health stays fail-closed; the RLS rewrite applied only after its guard checks passed.

This CRM release (`619af13`, Complete CRM Wave B) and the AQi visibility follow-up have no external deployment status recorded in this pass; the deployment URL is protected by Vercel SSO.

Unless a row explicitly says **hosted** or **production**, everything below is **local only**: an in-memory PostgreSQL (PGlite) running the real migrations, RLS policies, services and route handlers, with mocked Supabase Auth and mocked provider HTTP.

Hosted writes recorded in this verification history: migration `0026` on 2026-10-15; workforce migrations `0045`–`0046` and AQi migrations `0047`–`0049` on 2026-10-18; the nine CRM migrations on 2026-10-19 after the custom-format backup; AQi migrations `0050`–`0052` on 2026-10-19; and, after the duplicate-number reconciliation, `0059_hermes_tool_inventory` (2026-10-18T22:52Z, which is 2026-10-19 local time), `0060_rls_initplan` and the manager Blueprint grants (now `0062_agency_manager_blueprint_permissions`) on 2026-10-19. No migration is pending. The CRM browser and thumbnail checks used only fictional data in the isolated local QA environment.
The hosted Supabase project has migrations `0001`–`0026`: `0001`–`0025` were already applied when it was inspected, and `0026` was applied on 2026-10-15 at your request (atomically, with the database empty: 0 organizations, websites, versions, publications and enquiries). Read-only checks afterwards: all five new tables have row level security, the three permissions exist, `app.submit_site_form` has 16 arguments and `iaq_site_runtime` can execute it, `iaq_site_runtime` holds no table privileges, `anon`/`authenticated` hold none on the new tables, and no client role can read template content. 154 public tables, 26 migrations recorded. No deployment was made. The repository has a remote; the commits to `master` were pushed at your request.

A later hosted inspection on 2026-10-18 found `0001`–`0029` and `0034`–`0044`, with `0044_agency_module_view_overrides` as the highest applied migration. Workforce migrations `0045`/`0046` and AQi migration `0047` were then applied on 2026-10-18 with the repository's `--only` runner, one transaction per migration. Cost-control `0048` and attachment `0049` were applied the same way and are now recorded alongside `0047_aqi_assistant`. The hosted project has **213 public tables**, the private `aqi-attachments` bucket (non-public, 50 MB), `aqi_attachments` with RLS and four policies, one global budget row, one published AQi configuration, 14 knowledge entries and 2 conversations (both saved).

The repository has an **external Vercel production deployment** from master. GitHub records a successful Production deployment for **`ceae6e5`** by `vercel[bot]` on 2026-10-19; the deployment URL is protected by Vercel SSO, so the running app itself could not be inspected without a session. `ceae6e5` includes the provider-resolution, role-aware error, budget, support, attachment/composer, GIF-removal, conversational-intelligence and conversation title/lifecycle changes. There is no `.github/workflows` or Vercel config in the repository; the integration is external.

### Support & Requests (2026-10-20; local only, branch `feat/support-requests`, migration `0065` not applied anywhere)

The full evidence, per area and per tier, is in [support-requests.md §18](support-requests.md#18-verification). In short:

| Gate | Result |
| --- | --- |
| `npx vitest run --maxWorkers=2` | **3,163 passed / 3,166 (194 files).** The 3 failures (`crm-calendars` ×2, `crm-booking-pages` ×1) also fail on `6e18e1b`, the commit this branch started from; `master` has a later calendar-fixture fix (`f59edc7`). About 128 of the passing cases are support-specific (`tests/support-*.test.ts`, `tests/aqi-support.test.ts`) |
| `npm run typecheck`, `npm run lint` | pass; 0 errors and 0 warnings |
| `next build --webpack` | passes; the nine support pages and the support and AQi-support API routes are emitted |
| Migration `0065_support_requests` | applied by the test harness on embedded PostgreSQL; rollback and re-apply proved by `tests/support-migration-0065.test.ts`; `tests/crm-migrations.test.ts` rolls it back first. Renumbered from 0064 because `master` took 0064 (`0064_aqi_feature_tours`, applied to the hosted project); **nothing was applied to a hosted database** |
| Browser QA (local only) | 34 checks driven in Chromium against the isolated QA server (embedded database, local sign-in, fictional accounts, email captured): signed-out visitor, client team member, owner, viewer, a second client, agency Super Admin, agency staff and out-of-scope staff, at 390/768/1024/1440 px; axe-core clean at 390 and 1440; 0 requests left the loopback origin. Not driven in a browser: reopening a request, upload cancel/retry, the 20-second refresh, and the agency keyboard shortcuts |
| Not verified | Real email delivery (capture mode only), a real AI provider, the scheduler on a real host, Supabase row-level security on the hosted project, staging, production, screen readers. No malware scanner exists for uploads |

No push, merge to `master`, hosted migration, deployment, customer email or live provider call was made. `master` has moved on since this branch was cut: a trial merge shows one textual conflict, in `src/components/shell/sidebar.tsx` (master added an `onWarm` prop to every `NavLink`; the new Requests group adds calls that need it), and the migration number must be re-checked before merging.

### Native-first surface pass (2026-10-19)

This pass keeps the GoHighLevel integration working while removing the places where a new native client was still shown a GoHighLevel-first experience. All browser evidence below is **local only** (isolated PGlite, fictional data, synthetic sign-in).

| Area | Evidence | Result |
| --- | --- | --- |
| Client Integrations page | New pure card builder (`src/lib/integrations/client-tools.ts`) and `tests/client-integrations.test.ts` (6). Browser-checked as a native owner and a GoHighLevel owner at 1440 px, and at 390 px for overflow: native sees **iAcquire CRM** and **iAcquire Calendar** with real counts, no GoHighLevel CRM card, and an explicit “GoHighLevel is optional” notice; the GoHighLevel owner still sees its saved location, check state and calendar card. 0 axe violations (WCAG 2.0/2.1 A/AA), no horizontal overflow at either width, 0 console/page errors. | Implemented and browser-checked locally; no provider contacted |
| Legacy Sales route | A native or hybrid workspace is redirected from `/sales` to `/crm/opportunities` instead of seeing “connect GoHighLevel”. Browser-verified: `/sales` finished at `/crm/opportunities` with the native CRM workspace rendered. GoHighLevel-owned workspaces keep the existing read-only view. | Implemented and browser-checked locally |
| Agency fleet health | Native CRM data (contacts, native pipelines, active native calendars) or an activated setup counts as configured; a native client no longer needs a GoHighLevel location to be healthy. GoHighLevel workspaces keep the previous rule. `tests/setup-fleet-health.test.ts` (7); the agency clients table now shows the native QA client as “Partly connected” (agents offline) rather than disconnected. | Implemented locally; browser-checked badge |
| Staging preparation | [staging-environment.md](staging-environment.md) now states the exact project, region, size, Free/Pro quota and monthly cost, required credentials, approval list and the end-to-end acceptance matrix. **No staging resource was created.** | Prepared; blocked on approval |
| AQi Phase 3 hardening | Migration `0063` is in the repository and recorded as applied on hosted Supabase with 259 public tables. The browser groups were re-run after the dev-server timeout fixes: tablet 768/1024 px **16/16**, admin/Insights **12/12**; the branch record has the complete 65/65 across groups. | Local browser plus hosted migration recorded; staging acceptance still outstanding |
| Quality gates | `npm test -- --maxWorkers=2`: **3,003 passed / 3,003 (180 files)** on the final release tree; `npx tsc --noEmit --incremental false` exit 0; `eslint src tests scripts --max-warnings=0` exit 0; `next build --webpack` compiled successfully and emitted `/settings/integrations`, `/sales` and `/crm/opportunities`. The final pre-push audit is [native-first-release-audit.md](native-first-release-audit.md). | Local |

The integrations-page axe run covers WCAG 2.0/2.1 A and AA only, not best-practice rules or a screen reader. It does not replace a staging run or a manual accessibility session.

### CRM launch acceptance and funnel audit (2026-10-19)

- [crm-launch-acceptance-20261019.md](crm-launch-acceptance-20261019.md): all **114 CRM routes** at desktop/light and all **114 routes at 390 px/dark**, 0 render/5xx/external/overflow failures; the phone sweep found a real AQi guidance-button dark-mode contrast defect on `f2165c4` (3.49:1 → fixed to 5.36:1, 0 axe after replay); the parallel AQi refactor already in production `e9fe6f7` uses `text-primary-on`. Hosted production is native-first but has no CRM records yet; staging and Hermes/Website Studio live acceptance remain outstanding.
- [sales-and-demo-funnel-audit.md](sales-and-demo-funnel-audit.md): demo workspace, Super Admin demo pipeline, consultation CTA, public checkout and purchase-token invitation are missing; setup-fee/payment infrastructure exists, but activation does not yet require `setup_payment_status = paid/waived`. The dependency-ordered plan is included; no funnel code was added.
- The production scheduler is still **503 / never_ran**; no provider write or scheduler activation occurred.

### Native CRM Phase 6 acceptance (2026-10-19; local only)

The feature matrix and scope notes are in [native-crm-parity.md](native-crm-parity.md); the isolated browser setup and reports are in [crm-local-qa.md](crm-local-qa.md).

| Area | Evidence | Result |
| --- | --- | --- |
| Provider switching | Seven-step Settings → CRM Provider wizard; `tests/crm-provider-switch.test.ts` (15 tests). Browser acceptance previews the wizard but does not confirm a cutover. During a switch, automations, follow-ups, messages and calendar write-backs pause, and iAcquire cannot send for a GoHighLevel-owned capability | Implemented locally; no real provider used |
| Lead items | `tests/crm-lead-items.test.ts`; role-aware lead controls and guarded actions | Implemented locally |
| RLS policy rewrite | Migration `0060`; `tests/rls-initplan-equivalence.test.ts` and `tests/rls-initplan-guard.test.ts` cover policy equivalence and the init-plan form | Implemented locally; not applied to hosted Supabase |
| Browser acceptance | Post-merge: 114 all-route desktop/light visits across six personas and 62 focused phone/dark visits; all selected routes rendered, with 0 axe violations and 0 overflow. The 14 scripted interactions passed. Development-worker chunk resets and one denied-route parse error were cleared by 9 focused replays, all clean | Verified in a real browser against fictional data |
| QA isolation | Local PGlite database, synthetic sign-in, provider send switches off, browser restricted to the QA server's exact loopback port; reports and screenshots remain under git-ignored `.data/crm-qa/` | Verified locally; no hosted database or provider contacted |

The earlier 2026-10-18 full matrix covered 456 page visits across six personas, desktop/phone widths and light/dark themes. The post-merge reports and focused replays are preserved under `.data/crm-qa/reports/`; [crm-local-qa.md](crm-local-qa.md) records both sets of evidence. The browser runs do not establish production identity, hosted migration state, or a live provider cutover.

### AI employee chat and workforce management (2026-10-18, migrations 0045–0046)

Details and the honest scope are in [ai-workforce.md](ai-workforce.md); live gateway evidence and the
controlled-run procedure are in [hermes-live-acceptance.md](hermes-live-acceptance.md).

| Area | Evidence | Label |
| --- | --- | --- |
| Internal and client workforces on one registry | Agency workspace preparation is idempotent and preserves existing identities; super admin internal chat uses the normal chat backend; client employees stay in their own tenant. `tests/ai-workforce-experience.test.ts` | Implemented locally |
| Employee knowledge | Notes and documents are scoped by `org_id` + `agent_instance_id`; the retrieval check uses the same compiler as run instructions; injection-looking content is held; last-used evidence is written only after the provider accepts the run. `tests/ai-workforce-experience.test.ts` | Implemented locally |
| PDF/DOCX extraction | Bounded dependency-free extraction for selectable-text PDF (plain and Flate) and Word `.docx`; explicit `processing`/`ready`/`failed`/`unsupported` states and reasons; encrypted, scanned, malformed and ZIP64 files are rejected honestly; no OCR. Extracted text reaches the real chat instructions. `tests/knowledge-extraction.test.ts` (8), migrations 0045/0046 rollback tests (6) | Implemented locally; **no paid OCR** |
| Live gateway evidence | `scripts/hermes-live-audit.ts --live`: one multiplexed gateway authenticated; all six internal profile identities verified; capabilities advertise runs, SSE, status, stop and approval; `memory_write_api` and `admin_config_rw` false | **Read-only gateway verification passed** (credential resolution wrote audit rows); no run started |
| Tool-inventory gate | The 2026-10-24 profile-specific live audit verified six tools across five reviewed toolsets, with no restricted tools on the six mapped identities. The four inactive employees still have no applied config or saved inventory attestation; profile inventory does not equal app readiness or effective SOUL verification. A separate 2026-10-22 default-profile inspection found 24 default-injected tools and failed policy. `tests/hermes-tool-inventory.test.ts`, `tests/workforce-inventory-health.test.ts`, `tests/hermes-run-gate.test.ts` | **Implemented and fail-closed; activation is a separate, explicit step** |
| Draft configuration testing | The draft is compiled without writing a version; a real provider run uses a unique preview session and memory scope; no conversation, message, run or usage row is written. Tested with the local mock Hermes | Tested with mocks; **no live Hermes draft test** |
| SOUL.md and instruction hierarchy | Read-only SOUL.md, exact applied instructions, version history/rollback and honest “no SOUL.md write endpoint” copy. `tests/ai-workforce-experience.test.ts` covers the compiler and versions | Implemented locally |
| Memory | Conversation history persists; long-term memory remains Hermes-managed with the tenant/role session key. The UI states that inspection/editing is unavailable and does not offer a fake editor | Implemented locally; **memory read/edit not supported by the verified API** |
| Chat UX | Streaming, stop, retry/regenerate, persisted history, new/resume/rename/delete/search, older-message loading, safe Markdown, copy, keyboard and mobile layout | Implemented locally; browser-checked |
| Streaming fallback | When the provider advertises runs but not SSE, chat and draft tests poll the documented `GET /v1/runs/{id}` and show an honest “waiting for the complete response” state. Tested against a polling-only mock profile | Tested with mocks |
| Authorization and isolation | Permission checks plus RLS and composite foreign keys; cross-tenant employee/document/note denial tested; agent preview requires `agents.configure` | Implemented locally |
| Browser QA | `scripts/workforce-browser-qa.mjs` against the isolated embedded database: **10 signed-in pages** at 1440 px and 390 px, **6/6 interactions passed**, **0 axe-core violations**, **0 console/page errors**, **0 failed requests**, **0 horizontal overflow**. The QA seed now uploads a real extracted PDF and DOCX; the browser verifies the `PDF text` and `Word text` provenance badges. Synthetic online states; no provider was contacted | Browser-checked on synthetic data |
| Quality gates | Full `npm test`: **2,727 passed / 2,727 (136 files)** on 2026-10-18; `npx tsc --noEmit` passes; `npm run lint` **0 errors, 0 warnings**. The 20 complete-inventory tests and 4 health/attestation tests are included. Browser QA evidence is from the earlier workforce pass; no new browser run was performed for this inventory change | Local only |
| Schema | `0045_ai_workforce_experience` (employee knowledge, document scope/risk/use evidence), `0046_knowledge_document_extraction` (processing states and extraction evidence), and `0059_hermes_tool_inventory` (complete runtime inventory contract, digest, expiry, compact snapshot and diagnostic). 0045 was renumbered after hosted 0044. The hosted schema was inspected read-only: it has `has_permission`/`current_user_id` but not `permitted_orgs`, so 0045 creates statement-level policies locally and per-row permission policies on hosted. `tests/knowledge-migration-hosted-compat.test.ts` proves the hosted branch on a private schema. Rollbacks are tested. `0045`/`0046` were applied to hosted on 2026-10-18 and `0059_hermes_tool_inventory` on 2026-10-18T22:52Z (see the Hosted schema row at the top) | **Applied to hosted Supabase**; as of the Step 103 audit no employee had recorded an inventory attestation |

**Verified live, read-only:** gateway authentication, capabilities, profile identity for the six
internal employees, run/SSE/status/stop/approval support, and the reviewed built-in tool exposure
(five toolsets, six tools, no restricted tools). **Not verified:** a real model response, a live
client profile, provider costs, hosted migrations, a deployment, a screen reader, touch hardware,
or a production identity provider. The complete-tool-inventory gate blocks live runs until each employee
has passed its own health check (a real portal check against the patched gateway has not been run yet) and
has an applied configuration. Migration `0059_hermes_tool_inventory` is applied to hosted. See
[hermes-tool-inventory.md](hermes-tool-inventory.md).

The previously deployed build used its seeded `deepseek-chat` instead of the integration's `deepseek-flash` and could cache a failed resolution for 30 seconds. The deployed provider fix makes the integration model authoritative unless explicitly overridden, removes negative caching, adds categorized resolution diagnostics and role-aware public errors, and rechecks provider availability on send. The Vercel URL is SSO protected, so the deployed AQi UI itself was not exercised. The hosted database has migrations through `0052`.

### AQi platform assistant (2026-10-18, migration 0047)

| Gate | Result |
| --- | --- |
| AQi schema, RLS, seed knowledge and conversation privacy | Locally verified (`tests/aqi-migration-0047.test.ts`) |
| Provider streaming, SSE fallback, provider failure, 429, timeout, cancellation, interrupted stream and invalid model | Locally verified (`tests/aqi-llm-stream.test.ts`, 9 tests); **live controlled DeepSeek `llmStream` probe passed** (one real delta, usage reported) |
| Provider resolution, DeepSeek/OpenAI adapter, model selection, expired/status failures and recovery after negative cache | Locally verified (`tests/aqi.test.ts`, 10 tests; `tests/aqi-errors.test.ts`, 3 tests) |
| Context, suggestions, knowledge retrieval, conversation CRUD, durable sources, citation validation and publish/rollback | Locally verified (`tests/aqi.test.ts`, 10 tests) |
| Navigation safety, actual agency permissions and cross-role denial | Locally verified (`tests/aqi-security.test.ts`, 5 tests) |
| Atomic AQi budgets, model pricing, per-user limits and concurrent reservation race | Locally verified (`tests/aqi-cost-controls.test.ts`, 4 tests); hosted migration 0048 applied |
| Support escalation with consent, real Support service and duplicate suppression | Locally verified (`tests/aqi-support.test.ts`, 2 tests) |
| Citation validation and stale-knowledge warnings | Locally verified (`tests/aqi.test.ts`) |
| Intent-aware greetings, response length, page-context restraint, clickable navigation, source preview | Locally verified plus real DeepSeek greeting/navigation probes |
| Copy, like/dislike/undo, reason form and selected-state persistence | Locally/browser verified; feedback persisted through the existing message record |
| Stable welcome, reserved suggestion skeletons, permission-filtered suggestions, fixed header and no layout shift | Browser verified with a 2.2 s delayed bootstrap: welcome at 154 ms, four skeletons, composer usable during load, header 91.5 → 91.5 px, support link 811.25 → 811.25 px, zero extra requests over five open/close cycles |
| Automatic conversation titles, greeting suppression, manual-rename precedence and deletion race safety | Locally verified (`tests/aqi-titles.test.ts`, 6; `tests/aqi-lifecycle.test.ts`, 11; `tests/aqi-migration-0051.test.ts`, 3) and browser verified against the configured model plus a deterministic fallback |
| History search/pagination, inline rename, destructive delete confirmation and pending/error states | Locally and browser verified at 1440 px and 390 px: search found generated and manual titles, immediate `Deleting…`, failure retry, success removal, focus return, Escape/busy guards |
| Temporary vs saved lifecycle: application-shell mount, close-only X, explicit Save/Discard/Delete, refresh reset and account isolation | Locally/browser verified (`tests/aqi-conversation-lifecycle.test.ts`, 4; `tests/aqi-migration-0052.test.ts`, 1): **38 assertions, 0 failures**; close showed no prompt and sent no delete, messages/draft/scroll/active streaming survived close and in-app navigation, explicit save survived refresh, discard and delete were separately confirmed, another account saw no previous chat, rapid open/close produced no duplicates, 0 console/page/request errors and 0 axe; migration 0052 is applied hosted |
| Lifecycle browser QA | **58 checks, 0 failures**, 1440 px + 390 px, 0 page errors, 0 failed requests, **0 axe violations**; console only the four deliberately simulated 500 responses and one pre-existing `/login` hydration warning outside AQi |
| Floating launcher, streaming panel, source citations, feedback, support consent, close/reopen, history, reload persistence, expand, mobile, reduced motion, keyboard navigation, Super Admin real-provider test, retrieval preview and budgets | Browser QA passed with **4 pages, 25 interactions, 0 console errors, 0 page errors, 0 failed requests, 0 axe violations**; local streaming/non-streaming provider only |
| Private image/document attachments, emoji picker, upload previews and admin attachment settings | Browser QA passed at 1440 px and 390 px; image/document history rendering, emoji insertion, admin settings and **0 axe violations** |
| Attachment storage/RLS and extraction | Locally verified: private bucket, RLS, image dimensions, PDF/DOCX/TXT text, MP4 duration, ownership denial, cross-user read denial, storage cleanup |
| GIF messaging | **Removed from AQi**; uploads are rejected as unsupported |
| AI image/video understanding | **Not implemented / not claimed**; media is stored, previewed and marked as not inspectable by the selected model |
| Client-facing unavailable state and retry | Mobile 390 px browser QA passed; friendly text, no administrator/technical detail, functional Try again, **0 axe violations** |
| Migration 0047 | **Applied to hosted Supabase 2026-10-18**; six tables, RLS policies and seeded config/knowledge/questions verified |
| Migration 0048 | **Applied hosted 2026-10-18** |
| Migration 0049 | **Applied hosted 2026-10-18**; private bucket, metadata table, RLS and four policies verified |
| Migrations 0050–0052 | **Applied hosted Supabase 2026-10-19**; pending AQi list empty, `saved_at`/`saved_by` and `title_source`/`title_generated_at` present, `aqi_conversations_saved_idx` present, 2 existing conversations backfilled as saved and 2 conversational-knowledge rows inserted |
| Live provider acceptance | **Provider-level PASS** — controlled production DeepSeek `llmComplete` returned `OK` and real SSE returned one delta with usage; full deployed AQi UI remains blocked by Vercel SSO |

AQi details: [aqi.md](aqi.md).

### AQi Phase 3 — guidance, tutorials and Insights (2026-10-19; base deployed, hardening local and browser verified)

Details, honest limits and release gates: [aqi-phase3.md](aqi-phase3.md). Staging procedure:
[aqi-phase3-staging-acceptance.md](aqi-phase3-staging-acceptance.md).

| Gate | Result |
| --- | --- |
| **Migration 0063 knowledge history and contact v2** | Verified (`tests/aqi-migration-0063.test.ts`, 3) including transactional rollback; **applied hosted 2026-10-19** |
| Migration 0061 schema, RLS, seeded 16-tutorial library and tips | Verified (`tests/aqi-migration-0061.test.ts`, 6); guarded rollback (2); applied hosted 2026-10-19 |
| Target registry, definition validation and intent matching | Verified (`tests/aqi-tutorial-engine.test.ts`, 10); every seeded target exists |
| **Tutorial completion accuracy** | Verified: finish is not `verified`; route completion verifies navigation only; contact completion requires a CRM record created during the attempt. Wrong page, missing record and real record covered (`tests/aqi-tutorial-engine.test.ts`); admin nav wording (`tests/aqi-tutorial-admin.test.ts`, 7) |
| Progress persistence, permissions, pause/resume, version change and click-to-advance | Verified; browser verified for refresh/resume and real contact creation |
| Tutorial admin draft/publish/duplicate/archive/rollback, completion rules and structural preview | Verified (7); browser library, validation and draft preview |
| Chat guide offer and structured message guide | Verified (`tests/aqi-guide-chat.test.ts`, 2); greeting/unrelated turns are not offered |
| Onboarding preferences and contextual tips | Verified (`tests/aqi-onboarding-tips.test.ts`, 6); browser welcome dismissal and tip-launched walkthrough |
| **Knowledge document security and tenant isolation** | Verified (`tests/aqi-knowledge-documents.test.ts`, 7): draft-only upload, private `platform/aqi/` path, no `private_files` row, no tenant document in platform tables, client-owner refusal |
| **Knowledge history, compare and restore** | Verified (`tests/aqi-knowledge-history.test.ts`, 3): real prior body preserved, restore creates a draft, no fabricated legacy versions |
| **Tutorial event retention** | Verified (`tests/aqi-tutorial-retention.test.ts`, 2): bounded batch, org scope, active-progress protection, audit, configurable limits |
| Insights real aggregates, filters, privacy and empty states | Verified (`tests/aqi-insights.test.ts`, 4); browser 7/30/90, custom UTC range, invalid range, Reset and axe |
| Typecheck / lint / production build | Passed; build compiled and emitted all routes including `/admin/aqi/insights` |
| Full regression suite | **2,987 tests in 177 files passed** (`npm test -- --maxWorkers=2`) |
| Browser QA | **65/65 checks across six scenario groups**: desktop 14, resume/mobile 11, tablet 20, keyboard 5, error/retry 3, admin/insights 12; 0 unexpected console/page errors, 0 failed requests, 0 5xx, 0 serious/critical axe findings in tested states |
| Hosted migrations 0061 and 0063 | **Both applied 2026-10-19**, each after a custom-format `pg_dump` backup. Verified: **259 public tables**, 16 published tutorials/versions, 6 tips, RLS on tutorial and history tables, no `iaq_app_user` grant on documents or history, `create-contact` v2 `contact_created` published and v1 archived |
| Staging / production | **Not staging-verified.** The hardening release is on `master` and production deployment is triggered by that push; no staging acceptance run or authenticated post-deploy smoke test has been recorded |
| Live chat `Show me how` with a real provider | **Not verified in a browser**; the QA provider is disabled. Server tests prove the stored guide action |

Browser QA used real Chromium against the isolated PGlite CRM QA server and fictional data only. It
found and fixed a tablet tooltip/target overlap on the KPI grid, a focus-restoration loss when the
opening control disappeared, and low-contrast Insights metric labels. It does **not** establish
staging identity, a live-provider chat action or a manual screen-reader result. The hosted schema was
verified separately with read-only queries after migration 0061.

### AQi UX polish (2026-10-19; commit `f6b6b62` pushed to `master` at the owner's request, no migration; deployment result and staging acceptance not verified)

Navigation links and Markdown, the walkthrough card and positioning engine, the welcome popup and
start-up performance were reworked without a schema change. Locally verified: full suite 184 files and
3,042 tests, `tsc`, `eslint` and `npm run build` clean, 62 UX browser checks, and the existing 65-check Phase 3 browser
suite. Measured on the isolated development server only: first spotlight after "Start tour" 444 ms to
109 ms desktop, step change 188 ms to 11 ms, layout shift 0.0818 to 0.0002. **Not verified:** a live
DeepSeek model, a production-build timing, a screen reader, staging. Details, root causes and the
staging acceptance list: [aqi-ux-polish.md](aqi-ux-polish.md).

### Website Studio rebuild (2026-10-15, migration 0026)

Details and the honest scope are in [website-studio.md](website-studio.md); the apply plan is [website-studio-migration-0026.md](website-studio-migration-0026.md).

| Area | Evidence | Label |
| --- | --- | --- |
| Document model, operations, history, drag geometry, diff, section library, publish checks, legacy upgrade | `tests/website-editor-logic.test.ts` (23), `tests/website-templates.test.ts` | Implemented locally |
| 50 designs are distinct and honest | `tests/website-variations.test.ts` (8), `tests/website-art.test.ts` (3: scene weight budget, no script or external address, deterministic): every pair of the 50 differs on ≥4 of 6 character dimensions (three quarters differ on all six), no light-text floating header over a light section, built-in artwork only, sample content blocks publishing | Implemented locally |
| AI assistant | `tests/website-assistant.test.ts` (25): closed edit vocabulary, claim guard, built-in planner, model-reply parsing, one undoable step; `tests/website-admin.test.ts` covers its server boundary with the model **mocked** (outline only, no contact details, rate limit, permission) | Tested with mocks; **no real AI provider was called** |
| Agency Studio server modules | `tests/website-admin.test.ts` (29): template lifecycle and permissions, template changes never alter a client's site, agency scoping (staff vs super admin), comments, edit lock, archive, saved and shared sections, template-update offer, audit | Implemented locally |
| Migration 0026 and its rollback | `tests/website-migration-0026.test.ts` (3): the rollback script runs on a fully migrated local database inside a rolled-back transaction, removes and restores everything it should, and refuses when data would be lost | Implemented locally; **the migration is applied to the hosted project (see above); the rollback was never run there** |
| Renderer security | `tests/website-security.test.ts` (11): hostile text is drawn as text, unsafe links and styles are refused by the model, no scripts or third-party hosts in published output | Implemented locally |
| Responsive pictures, advanced paste | `tests/website-images.test.ts` (5), `tests/website-advanced.test.ts` (4) | Implemented locally |
| Editor, gallery, agency screens in a real browser | `/dev/studio-preview`, `/dev/gallery-preview`, `/dev/admin-studio-preview` (labelled **sample data**, in-memory API, no sign-in). Selection, inline editing, drag reorder and insert, **keyboard-only reorder, duplicate, delete, undo and redo**, device switching (columns stack on a phone), autosave state, assistant propose, apply and undo | Browser-checked on sample data |
| All 50 public designs, real renderer, isolated frames | **No horizontal overflow** on the home page at 390, 768, 1024 and 1440 px and on all six pages at 390 px (500 loads). **axe-core (WCAG 2.0/2.1/2.2 A and AA plus best practice): 0 violations** on all six pages of every design at 1440 px (300 loads) and on home, services and contact at 390 px (150 loads). Fixes made on the way: duplicate menu landmarks, strip galleries not keyboard-scrollable, one muted-text contrast, one skipped heading level, a floating header unreadable over a light page title, mid-tone palettes choosing white text | Browser-checked on sample content |
| Agency screens and editor panels, accessibility | axe on all six agency preview views and on the editor (every left tab, the assistant with a proposal, the shortcuts and save-version dialogs): 0 violations apart from the preview scaffold's own missing landmark/heading and its dev-only theme button | Browser-checked on sample data |
| Public site payload | The sites runtime route's client chunks contain none of the editor's code (marker search of the built chunks). Built-in artwork was slimmed (skyline 78 → 24 KB, city blocks 43 → 12 KB, facade 26 → 8 KB) | Measured locally |

**Not verified:** signed-in client and agency flows against a real database in a browser (the agency screens were driven only on invented sample data); the hosted application (the schema is applied but the hosted database is still empty, so nothing exercises it); real DNS, certificates, domain purchase or publishing to a real host; the AI provider (mocked); screen-reader walkthroughs by a person; touch hardware; dark theme of the new screens; text that sits on images or gradients (axe reports it as "incomplete").

### Website Studio premium pass (2026-10-15, no schema change)

No migration was added or applied; Featured uses the existing `0026` column. Nothing was pushed, deployed or published to a real host, and no hosted service was contacted. Details, commands and the measured effect are in [website-studio-premium-qa.md](website-studio-premium-qa.md).

| Area | Evidence | Label |
| --- | --- | --- |
| Preview scrolling, 50 designs, four widths, real flow | `npm run studio:qa:preview-scroll`: 50 of 50, including device switching that keeps the reader's place (an intermittent loss of place under load was reproduced, root-caused to a stale restore overriding the reader, fixed, and then passed 18 of 18 under load) | Verified locally in a real browser |
| Text fit and colour contrast, 1,200 views | `npm run studio:qa:text-fit` with axe: 0 failing | Verified locally in a real browser |
| Text over photographs, anchors under pinned headers, screenshot against preview, axe (104 views), published runtime (54 checks), agency Template Library (11), editor (17) | the `studio:qa:*` suites listed in the QA doc, each with a negative control where one is possible | Verified locally in a real browser, isolated database |
| Gallery and image loading | 50 of 50 cards use a current screenshot (was 0); gallery payload 48.7 MB to 7.9 MB (development servers, comparison only); image weight per design page 652 KB to 228 KB at 390 px | Measured locally |

**Not verified in this pass:** anything against hosted Supabase or a real host; publishing a site that still has starter photographs in a gallery (refused by design); production-build timings of the gallery; touch on hardware; a screen reader.

### Evidence and honest labels for the all-in-one build

Labels: *Implemented locally* (works on local PostgreSQL) · *Tested with mocks* (provider calls mocked) · *Blocked awaiting credentials/approval*. None is "Verified end to end".

| Area | Evidence | Label |
| --- | --- | --- |
| Operating controls: employee modes, pauses, emergency stops (0016) | Enforced in the execution gate; `tests/automation-controls.test.ts` | Implemented locally |
| Staff roles (0017) | `tests/staff-roles.test.ts`, permission-matrix drift test | Implemented locally |
| Credits, metering, PayMongo checkout and webhook (0018) | `tests/billing*.test.ts`: signature, replay, livemode, idempotency, reconciliation. Live checkout is gated by a review flag | Tested with mocks; **blocked awaiting PayMongo test keys** |
| Unified inbox, consent, autopilot, human takeover (0019) | `tests/messaging-*.test.ts`. Sending is behind `GHL_WRITES_ENABLED=false` | Tested with mocks; **blocked awaiting a GHL test location** |
| Adaptive onboarding, brand assets (0020) | `tests/onboarding-v2.test.ts`, `assets-and-reader.test.ts`; browser-checked on the sample preview | Implemented locally; live LLM not exercised |
| Website Studio, publishing, domains, forms, site runtime (0021) | `tests/website-*.test.ts` (six files). Probe, DNS and certificate checks use injected fakes | Tested with mocks; **no real host, DNS, certificate or domain purchase** |
| Operations: heartbeats, incidents, notification email (0022) | `tests/operations.test.ts` (35). Collectors read recorded state; **no active provider probes** | Implemented locally; email blocked awaiting a sender |
| Appointments: event ledger, availability, booking, reminders, AI booking (0023) | `tests/appointments.test.ts` (67): ordering, dedupe, stale events, slot re-check, approval gates, reminder gating. The n8n processor is untouched and inactive | Tested with mocks; **GHL writes disabled** |
| Retention programs (0024) | `tests/retention.test.ts` (28): approval hash, caps, stop conditions, credit release | Tested with mocks; wording and limits **need legal review** |
| Agency finance statement, billing controls (0018/0025) | `tests/finance.test.ts` (12). Real numbers only; reserve is planning guidance | Implemented locally; **needs accountant review** |
| Fair use, inactivity review (0025) | `tests/fair-use-inactivity.test.ts` (19). No limit ships | Implemented locally; **thresholds await real cost data** |
| Offboarding, export, deletion (0025) | `tests/offboarding.test.ts` (23): ZIP integrity, tenant scope, shutdown steps, every deletion guard, atomic purge. Purge is off by default | Implemented locally; **never run against real data** |

### Browser checks for the new screens

Run against the development-only `/dev/operations-preview` (clearly labelled **sample data**), in the in-app browser. axe-core (wcag2a/2aa/21a/21aa/best-practice) reported **no violations
in the product components** in light and dark for offboarding (agency), "your data" (client) and fair use (client card and agency panel), apart from the preview page's own missing landmark and heading. There was no horizontal
overflow at 375 px for those views or the finance statement. Limits: authenticated pages were not driven against a live database; keyboard-only walkthroughs were not recorded; the pane freezes CSS transitions, so a
dark-mode run reads some buttons mid-transition unless transitions are disabled first (done for the final runs).

## Historical verification record

This page separates what was **actually verified** from what was verified **only with mocks or local
emulation**, and from what is **not verified at all**. Nothing here has been run against a live Supabase
project, Hermes gateway, GoHighLevel location, n8n instance, email provider or domain. No production
deployment, remote push or external mutation has been performed.

## Quality gates (local)

| Check | Result |
| --- | --- |
| `npm test` | 310 tests passed in 23 files |
| `npm run typecheck` | passes |
| `npm run lint` | passes with 0 errors and 0 warnings |
| `npm run build` | passes with no warnings (Next.js 16.3.6, Turbopack) |

The tests run on an in-memory PostgreSQL (PGlite), a local emulation of the Supabase `auth`, `storage`
and `realtime` schemas (`supabase/local-compat.sql`), a mocked Supabase Auth SDK, and mocked provider
HTTP. They exercise the real migrations, Row Level Security policies, services and route handlers.

## What kind of evidence each area has

| Area | Evidence | Status |
| --- | --- | --- |
| Migrations 0001–0015, constraints, RLS | Applied to local PostgreSQL by the test suite; every public table has RLS enabled (tested) | Local only |
| Supabase Auth (sign-in, invitations, verification, reset, logout) | Mocked Auth SDK; state, mapping, single-use and session-revocation rules tested | **Mocked, not live** |
| Account migration to Supabase Auth | Idempotency, UUID preservation and no email-only linking tested against the mock | **Mocked, not live** |
| Storage (private buckets, signed access) | JWT/Storage policy emulation and authorization helpers tested | **Emulated, not live** |
| Supabase Realtime (server publish, browser subscriber, RLS topic policy) | Policy emulation; browser subscriber tested against a fake client (topic validation, malformed payloads, backoff, token renewal, cleanup) | **Emulated / fake client, not live** |
| Live setup sync across devices | Server-sent events and revision polling tested end to end locally; polling fallback is always on | Local only |
| Credentials (Vault references, rotation, revocation) | Test-memory adapter only. The Supabase Vault functions are not exercised | **Not verified against Vault** |
| Hermes adapter | Pinned to the upstream source contract and tested against a local mock gateway | **Mock, not a live gateway** |
| GoHighLevel adapter | Mocked HTTP: location-identity mismatch, protected locations, permission probes, metadata sync, mapping validation, read-only (GET only) | **Mock, not live** |
| n8n adapter | Mocked HTTP: failure handling, approved-ID enforcement, payload filtering, read-only | **Mock, not live** |
| Custom projects: catalog, requests, quotes, milestones, handover (migration 0015) | Services and RLS tested on local PostgreSQL: tenant isolation, agency-only columns, quote hash integrity, append-only approvals, status transitions, tenant-scoped files. Migration also applied to the linked Supabase project. | Local tests; schema applied to Supabase, flows not exercised live |
| Optional managed maintenance | Eligibility, opt-in, allowance, defect lane and tenant isolation tested locally | Local only |
| Founder portfolio import and image handling | Eleven projects imported (hidden, pending review) into the Supabase project; review gate, WebP optimization and publish rules tested locally; source fetch stubbed | Import run for real, images not yet imported or published |
| Assistant: catalog pricing and own-project status | Tested against the local database; no live LLM call | Local only |
| Public feeds `/api/public/services` and `/portfolio` | Called on the local dev server (no sign-in); not deployed | Local only |
| Google Calendar, email sending, domains | No connector exists. Setup steps are actionable and show as unverified | **Not built** |
| Marketplace appointment webhooks / n8n Appointment Event Processor | Not connected. The processor is untouched and inactive | **Not built** |

## Brief Part 16 checklist

| # | Requirement | Evidence | Live? |
| --- | --- | --- | --- |
| 1 | Existing tests remain passing | 247/247 (220 at the start of this session) | n/a |
| 2–4 | Typecheck, lint, build | pass, no warnings | n/a |
| 5 | Supabase login works | `tests/supabase-auth.test.ts` (mock) | **No** |
| 6 | Password reset works | `tests/supabase-auth.test.ts` (mock) | **No** |
| 7 | Client invitation flow works | `tests/supabase-auth.test.ts` (mock), `tests/auth.test.ts` (local mode) | **No** |
| 8 | Database persistence works | Local PostgreSQL only; no hosted persistence or restart check | **No** |
| 9 | RLS blocks cross-tenant access | `tests/tenant-isolation.test.ts` (every tenant table), `tests/supabase-security.test.ts` | Emulated |
| 10 | Client onboarding persists | `tests/modules.test.ts`, `tests/provisioning.test.ts` | Local |
| 11 | Admin can update setup progress | `tests/setup-center.test.ts` | Local |
| 12 | Client receives updated progress | `tests/setup-center.test.ts` (stream/poll), `tests/setup-realtime.test.ts` (fake client) | Local / fake |
| 13 | Task histories remain accurate | `tests/setup-center.test.ts` (append-only events, who/what/when) | Local |
| 14 | Blocked integration prevents activation | `tests/setup-center.test.ts`, `tests/provisioning.test.ts` | Local |
| 15 | Unconfigured connectors show honest statuses | `tests/setup-center.test.ts`, `tests/setup-experience.test.ts`, `tests/integrations-security.test.ts` | Local |
| 16 | Credential APIs reject unauthorized access | `tests/integrations-api.test.ts` (route handler: unauthenticated, non-agency, foreign Origin, oversized/forged bodies), `tests/integrations-security.test.ts` | Local |
| 17 | Secrets absent from browser responses and logs | `tests/integrations-api.test.ts`, and `tests/integrations-security.test.ts` which captures console output and scans audit, check, connection, credential and status tables after saves, failed tests, reflected keys and disconnects (mutation-checked) | Local; hosted logs not checked |
| 18 | Hermes adapter mock tests pass | `tests/hermes-contract.test.ts`, `tests/integrations-security.test.ts` | Mock |
| 19 | GHL location mismatch rejected | `tests/integrations-security.test.ts` | Mock |
| 20 | n8n fails safely when unavailable | `tests/integrations-security.test.ts` | Mock |
| 21 | Mobile UI has no overflow | Real browser at 375 px: all 18 wizard steps (Hermes, GoHighLevel, n8n), client Setup Center, agency Setup Manager, global and client integrations pages: no horizontal overflow | Real browser, **sample data** |
| 22 | Accessibility checks pass | axe-core 4.14.0 in a real browser, fresh page loads in light and in dark theme: 0 violations on all 18 wizard steps and on the global and client integrations pages. The two Setup screens report only the dev-preview banner lacking a landmark (not part of the product). Contrast was fixed first (see below) | Real browser, **sample data** |

### Browser checks: scope and limits

- They ran against the development-only pages `/dev/setup-preview` and `/dev/integrations-preview`, which
  render **clearly labelled sample data** and simulate no connection. Authenticated pages were not driven
  in a browser in this pass, so real data loading, sign-in and the live wizard test calls were not
  exercised visually.
- axe-core could not automatically evaluate roughly 6–9 text nodes per Setup screen because they sit on
  gradient backgrounds (brand buttons and the page backdrop). Those were not measured manually.
- Keyboard use was not tested by hand. The wizard moves focus to each step heading and the dialog is a
  Radix focus-trapping dialog; no keyboard-only walkthrough has been recorded.
- The shared `--faint` text colour failed WCAG AA (2.6:1 light, 3.3:1 dark) in 113 places. It was changed to
  `#667085` (light) and `#7d869a` (dark), which reach at least 4.5:1 on the main surfaces. This subtly
  changes secondary text across the app. The dev-preview banner also lacks a landmark; that is not part of
  the product.
- The in-app browser pane often captured a stale frame mid-animation and never finishes CSS transitions.
  Layout claims above come from DOM measurements and axe, not from screenshots alone. Dark theme was tested
  by persisting `iaq-theme=dark` and loading each page fresh; toggling the theme on a live page produced
  false contrast failures (buttons still mid-transition), so those runs were discarded and redone.

## Live acceptance checklist (after you authorize a development Supabase project)

Do these in order, on the **development** project only, with dedicated test identities.

1. Apply `supabase/migrations` and confirm the table inventory in `supabase-setup.md`.
2. Enable Vault; confirm `credentialStoreReady`; save a **throwaway** credential and confirm only a
   reference and fingerprint reach portal tables, then revoke it.
3. Sign in, sign out, expired invitation, verification email, forgot password, one-time reset link,
   disabled account. Confirm emails actually arrive from a verified sender.
4. With two real client users in different organizations, prove through the Supabase Data API and Storage
   that neither can read the other's rows or files, and that anonymous access gets nothing.
5. Upload and download a private file with signed access that expires within 120 seconds.
6. Open the same client's Setup Center on two devices, change a task as an agency admin, and confirm both
   update (Realtime first; then block WebSockets to confirm the polling fallback).
7. Restart the server and confirm all data persisted.
8. Run the account migration with `--dry-run`, review the counts, then apply on a copy.
9. Only after each of the above passes: connect Hermes (dedicated test profile, never an `iacquire-*`
   profile), run the wizard test; connect a GoHighLevel test location (not the agency or Aster Homes
   locations) with read-only scopes; connect n8n and read the inventory.

Do not activate workflows, publish GHL drafts, enable the Appointment Event Processor, or send any
customer message as part of acceptance. Those need your separate authorization.
