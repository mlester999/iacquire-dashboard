# AQi Operations — Super Admin AI Platform Operations Copilot

Living design and acceptance record for the Super Admin side of AQi. Phase 0 (audit) is complete and is
recorded first; later sections are filled in as each phase lands, and only with evidence that was actually
produced (commands that ran, tests that passed). Nothing here is deployed, pushed or applied to a hosted
database unless a section says so explicitly.

Branch: `worktree-aqi-operations` (from `origin/master` at `03de0bf`). Base migration level: `0067`.

---

## 0. Phase 0 — audit, inventory and dependency map

### 0.1 What already exists (verified in the repository)

| Area | Existing implementation | Notes for this work |
| --- | --- | --- |
| AQi chat core | `src/server/aqi/service.ts` (`runAqiTurn`), `/api/aqi/chat` SSE route, `aqi_*` tables (0047–0052, 0061–0064), budgets/pricing/atomic spend reservation, rate limit `aqiMessageByUser`, citations, follow-up questions, titles, temporary/saved lifecycle, retention | Text-only. **No tool calling anywhere**: `docs/aqi.md` states "AQi never executes a model-generated tool call". `llmStream`/`llmComplete` (`src/server/llm/client.ts`) have no tool/function schema. |
| AQi widget | `src/components/aqi/aqi-widget.tsx` (1,788 lines) mounted once at the shell by `src/components/providers.tsx` (`AqiMount`) for every authenticated surface incl. `/admin/*` | Single client-oriented widget. A Super Admin in `/admin` currently gets the *Client* assistant with an agency route list: same prompt, same "Request support" CTA (`suggestSupport`, `AqiSupportDialog`). |
| Role resolution | `resolveAqiViewer()` (`src/server/aqi/access.ts`): `AqiViewer { user, org, permissions, can, agencyRole }`; agency staff may have `org: null` | The viewer already carries `agencyRole`; the server-side split can key on `agencyRole === "agency_super_admin"`. |
| Permission architecture | `PERMISSION_MATRIX` (`src/lib/permissions.ts`) + DB `role_permissions`; agency permissions via `app.user_has_agency_permission(user, perm)`; per-client scope via `app.user_can_access_org(user, org)` (`agencyCanAccessOrg`, `requireAgencyOrgAccessOrThrow`); super-admin-only gates by `platformRole === "agency_super_admin"` | Tools reuse these exact checks; no parallel permission system. |
| Platform health | `getSystemHealth()` (`src/server/admin/health.ts`, ~9 queries, used by `/admin/health`), `crmDeliveryHealth`, `pingDb`, `pendingMigrations`, `schedulerFreshness` (pure read) and `observeSchedulerFreshness` (**writes an incident** — must not be used by a read tool), incident engine (`src/server/ops/*`: `incidents`, `incident_events`, `worker_job_runs`, collectors for scheduler, queues, messaging, credits, payments, website, domains, integrations, GHL, Hermes, failed runs) | Production scheduler has never been configured (`worker_job_runs` has no `tick` heartbeat), so incident collectors have never run in production. The Operations Overview must show that honestly ("Not configured"/"Never ran"), not green. |
| Hermes workforce | `agent_instances` (status `setup_required\|provisioning\|online\|busy\|offline\|error\|disabled`, `mode` autonomous/approval_required/paused, `last_health_*`), `agent_runs` (`queued\|running\|completed\|failed\|cancelled\|interrupted\|timeout`), `tool_executions`, `approval_requests` (+events, execution status), `automation_pauses` (messaging/outbound/agency scopes), `agent_provisioning_jobs`, Hermes client with a restricted-tool filter, per-role tool policies | There is **no AI Work Board, no Hermes schedule/cron inventory and no task queue other than `agent_runs`/`approval_requests`** in this repository; Hermes's `cronjob` toolset is on the restricted list. `SCHEDULED` therefore cannot be derived from verified data and will not be emitted. |
| Support & Requests | `src/server/support/*` (migration 0065): `listAgencyRequests`, `getAgencyRequest`, `changeRequestStatus`, `changePriority`, `assignRequest`, `escalateRequest`, `linkRequests`, `mergeRequest`, `supportAnalytics`, `findSimilarForAgency`, AI helpers (`summarizeRequest`, `draftReply`, `missingInformation`, `adviseEscalation`), idempotent `submitRequest(ctx)`, lifecycle triggers | Single ticket backend. Internal issues will be created through `submitRequest` against the agency organization (no second backend). Client-side `src/server/aqi/support.ts` + `support-request-dialog.tsx` remain for Client AQi only. |
| Security / audit | `audit_logs` (append-only, indexes `(org_id, created_at)` and `(actor_user_id, created_at)` only), `recordAudit` with metadata sanitiser, vocabulary: `auth.login` (success/failure/denied), `team.role_changed`, `team.permissions_updated`, `team.access_updated/revoked`, `tenant.*`, `agent.*`, `integration.*`, `support.*`, … | An action-scoped time-window scan has no supporting index → one index is proposed in the migration. |
| Business metrics | `getFinancialReport` (`src/server/billing/finance.ts`), `payments` (PayMongo), `credit_ledger_entries`, `metered_usage_events` (provider/unit_type, wholesale vs client micros), `usage_events`, `aqi_usage_events` (cost micros), `agency_finance_entries`, `listUsageByTenant` | Revenue model is **credit top-ups + setup fee + maintenance/project payments**, not subscriptions. Tools must report exactly those and label estimates. |
| Integrations / workflows | `integration_connections` (+checks), `integration_status`, `email_outbox`, `conversation_messages` + `message_delivery_events`, `crm_workflow_runs`, `crm_webhook_deliveries`, `crm_events`, `appointment_reminders`, `getN8nStatus`, GHL mappings, calendar connections | All read-only evidence is present. Retry endpoints that are idempotent exist only for some surfaces; retry will be **preview-only** unless an existing guarded mechanism is reused. |
| Release data | `schema_migrations` + migration files (`pendingMigrations`), `process.env.VERCEL_*` system variables when exposed, `docs/*` status records | No CI result store, no deployment API integration, no error-monitoring service is integrated. These are reported as "Not configured". |
| Notifications | `notifyAgency`, `notifyUser`, `notification_deliveries`, email digest, preferences by kind | Briefings reuse in-app notifications; delivery by email follows the existing preference machinery. |
| Scheduler | `src/server/ops/tick.ts` `JOBS` registry, lease row, `/api/internal/tick` (CRON_SECRET + `SCHEDULER_ENABLED`) | A new job can register here; it will run only when the external scheduler is configured. |
| Navigation | `AdminShell` nav with `superOnly`/group flags (`src/components/admin/admin-shell.tsx`), route registry `AQI_ROUTES` (`src/lib/aqi/routes.ts`) | New route + nav entry + registry entries. |
| Tests | Vitest, PGlite in-memory with all migrations, fixtures in `tests/support/fixtures.ts`, QA harness under `scripts/*qa*` | |

### 0.2 What is genuinely missing

1. A tool framework (declared role/permission/scope/schema/risk/approval/idempotency/audit) and a Super Admin runtime that is not the Client prompt with more text.
2. Server-validated investigation scope (platform / tenant / employee / workflow / ticket / incident).
3. Action lifecycle: propose → preview → confirm → execute → verify, persisted, idempotent and audited.
4. Evidence model: every figure/card carries source system, retrieval time and a deep link.
5. A Super Admin interface ("AQi Operations") with a real overview and interactive result cards.
6. Briefing generation, schedule settings, de-duplication and quiet hours.
7. Telemetry for AQi tool latency/failures (derived from audit rows, no new store).

### 0.3 Data sources that do **not** exist (reported, never faked)

API request error rates, application latency/APM, slow-query telemetry (`pg_stat_statements` is not queried), host resource usage, deployment/CI status APIs, error-monitoring service, Hermes schedules/cron, an AI Work Board, voice interaction in AQi, subscription revenue. Each appears in the product as *Not configured* or *Unavailable* with what monitoring would be required.

### 0.4 Architecture decisions

1. **One AQi core, two runtimes.** `/api/aqi/chat` resolves the viewer; `agency_super_admin` is dispatched to `runOpsTurn` (new), every other viewer keeps `runAqiTurn` unchanged. The widget and the full-page console both speak the same SSE protocol (additive events), so persistence, budgets, rate limits, feedback and history are reused.
2. **The model never chooses what is allowed.** A deterministic router maps the question + selected scope to tool calls (bounded, schema-validated). An optional LLM planner can only suggest tool ids/arguments from the *registered* catalogue; every suggestion passes the same validation as the router. The model never receives a tool it is not entitled to.
3. **Tools return structured data + typed cards.** The narrative step receives a bounded, redacted evidence block wrapped as untrusted data; cards are rendered from tool output, never from model text.
4. **DB-light by construction.** One bounded statement per read tool via `readSystem` (no transaction round trips), a per-turn tool cap (6), a concurrency cap (2) because the hosted pool is small, per-tool timeouts, and aggregated SQL rather than row dumps. No per-request fan-out and no background polling.
5. **Writes only through `aqi_ops_actions`.** A write tool is never executed inside a chat turn; the turn only creates a proposal with an exact preview. Confirmation is a separate authenticated, same-origin request that re-validates role, scope, arguments and state, executes through the *existing* domain function, then re-reads state to verify before reporting success.
6. **Reuse before new code.** Support, incidents, automation pause, finance report, setup overview and tenant detail are called, not reimplemented.

### 0.5 Proposed schema changes (migration `0068_aqi_operations`)

| Change | Why it cannot reuse an existing table |
| --- | --- |
| `aqi_conversations.surface` (`assistant`\|`operations`) | Keeps investigations out of the Client history list and lets retention treat them separately. |
| `aqi_ops_actions` | Persisted proposals/confirmations/execution/verification with idempotency. `approval_requests` is tenant-scoped (`org_id not null`, fixed `kind` list) and would need its constraints altered. |
| `aqi_ops_briefing_settings`, `aqi_ops_briefings` | Per-admin explicit opt-in, timezone, quiet hours and de-duplicated generated briefings. |
| `audit_logs (action, created_at desc)` index | Needed for bounded security/telemetry scans. |

No existing table is dropped or rewritten. Rollback file ships with the migration. **Not applied to any hosted database** without explicit approval.

### 0.6 Dependency map (implementation order)

```
types/scope/redaction ──► tool framework (registry, executor, audit, telemetry)
        │                          │
        │                          ├─► read tools (health, tenant, hermes, support, security, bi, integrations, release, product)
        │                          └─► action pipeline (propose → confirm → execute → verify)
        ▼                          ▼
 migration 0068 ───────► runOpsTurn (router → tools → evidence → narrative) ──► /api/aqi/chat dispatch
                                   │
                                   ▼
        overview + scope APIs ──► AQi Operations page (overview, quick actions, scope, console, cards) ──► widget Ops mode
                                   │
                                   ▼
                       briefings (generator, settings, tick job, notifications)
```

### 0.7 Risks

| Risk | Mitigation |
| --- | --- |
| Hosted pool of ~15 / app pool `max: 4`; production already saw `ECHECKOUTTIMEOUT` | Concurrency cap, single-statement tools, bounded windows/limits, no polling, no auto-refresh timers. Measured locally only; **hosted latency is not claimed**. |
| `observeSchedulerFreshness` writes an incident | Read tools use `schedulerFreshness`. |
| Cross-tenant leakage through conversation memory | Scope stored per message; evidence from a previous tenant is never replayed into a different scope; history sent to the model is the visible text only, and a scope change starts a clearly labelled new context. |
| Prompt injection via ticket text/audit metadata/integration errors | All retrieved text is redacted, length-capped, fenced as data, and instruction-like patterns are neutralised; tools have no capability the injected text could widen. |
| Migration index on `audit_logs` | `create index if not exists`, small column set; locking cost on a very large table is a release consideration, listed in deployment notes. |
| Scope creep vs. verified correctness | Capabilities ship only with tests; anything without a verifiable data source is reported as unavailable. |

Status of later phases is tracked in the sections appended below as they complete.

---

## 1. What was built

AQi has two runtimes behind one shared foundation (conversations, budgets, rate limits, feedback, history, the SSE protocol):

| | Client / agency-staff AQi (unchanged) | Super Admin AQi Operations (new) |
| --- | --- | --- |
| Runtime | `runAqiTurn` (`src/server/aqi/service.ts`) | `runOpsTurn` (`src/server/aqi/ops/turn.ts`) |
| Chosen by | the **server-resolved** role at `POST /api/aqi/chat` | `agency_super_admin` only; the browser cannot select it |
| Prompt | immutable Client policy + approved knowledge | immutable Operations policy + fenced, untrusted evidence |
| Data | approved knowledge, the person's own permissions | audited, scoped, read-only operational tools |
| Writes | none, ever | only through confirmed, verified actions (see 3) |
| Interface | floating assistant | `/admin/operations` console + floating *AQi Operations* entry |

The Client widget is not rendered for a Super Admin. `agency_manager` and `agency_staff` keep the assistant; no Operations tool lists them in `roles`.

## 2. Architecture

```
question + selected scope
   │  resolveOpsScope (server verifies the record, derives the tenant, audits the access)
   ▼
planOps (deterministic: keywords + verified scope → bounded tool calls; the model chooses nothing)
   │
   ▼
createOpsRun → loads exactly the permissions the planned tools need (one query)
   │  runTool × ≤6, ≤2 at a time, per-tool timeout, schema-validated args
   │  role → permission → scope → args → run → redact → audit (batched) → typed cards + evidence
   ▼
evidence block (redacted, fenced, untrusted)  ──►  model narrative [E1]… (optional)  ──►  validated citations + links
   │                                                    └─ no provider / budget / failure → evidence-only answer, stated as such
   ▼
SSE: meta · plan · tool · cards · delta · done      persisted as aqi_messages.context.ops
```

Key modules (all under `src/server/aqi/ops/` unless noted): `tool.ts` (the declaration contract), `registry.ts` (the only registration point), `executor.ts` (pipeline, limits, audit batch), `scope.ts`, `redact.ts`, `planner.ts`, `turn.ts`, `prompt.ts`, `memory.ts`, `actions.ts`, `briefing.ts`/`briefings.ts`, `overview.ts`, `conversations.ts`, `http.ts`; tools in `tools/*.ts`; shared types in `src/lib/aqi/ops/`; UI in `src/components/aqi/ops/`.

Every tool declares: id, title, description, group, allowed roles, required agency permission, allowed scopes, strict zod input, risk class, approval policy, idempotency, audit action, timeout. `tests/aqi-ops-core.test.ts` fails if any tool lacks one, accepts unknown arguments, or is offered to a role below Super Admin.

### Tool catalogue

| Area | Tool | Reads | Scope |
| --- | --- | --- | --- |
| Platform health | `platform.health` | database probe, migrations, scheduler heartbeat, incidents, email, AI provider status, Hermes status, integrations, CRM delivery, payment webhooks | platform |
| | `platform.incidents` / `platform.jobs` | incident engine and timeline; `worker_job_runs` | platform, client, incident |
| Client workspaces | `workspace.directory` / `workspace.find` / `workspace.summary` | Setup Center, integrations, messaging channels, AI Employees (metadata only) | platform / client |
| Hermes workforce | `workforce.status` / `.runs` / `.approvals` | `agent_instances`, `agent_runs`, `tool_executions`, `approval_requests`, `automation_pauses` | platform, client, employee |
| Support | `support.queue` / `.ticket` / `.duplicates` / `.draft_reply` | the existing Support & Requests service (permissions, SLA, escalation advice, AI assist) | platform, client, ticket |
| Security | `security.events` | `audit_logs` by exact action name | platform, client |
| Business | `business.summary` / `.client_costs` | the Billing & finance report, `metered_usage_events` | platform |
| Integrations | `integrations.status` / `.trace` | connections, message/reminder/workflow/webhook delivery evidence (no message bodies) | platform, client, workflow |
| Release | `release.info` | runtime commit variables, `schema_migrations` | platform |
| Product | `product.requests` | issue/feedback themes by distinct clients, severity, volume | platform, client |
| Briefings | `briefing.compose` | the sections above, with period and sources | platform |

Action tools (never run inside a turn): `incident.acknowledge` (low), `support.escalate` (medium, reason), `support.set_priority` (medium), `automation.agency_pause` (**high**, typed client name + reason), `issue.create` (medium; internal issue / platform bug / proposed engineering task as a Support & Requests item under the agency workspace).

## 3. Actions: propose → preview → confirm → execute → verify

A turn can only create a row in `aqi_ops_actions` with the exact preview. Confirmation is a separate same-origin request (`POST /api/aqi/ops/actions/[id]`) that: re-checks the session with the auth server, the role, the permission, the scope and the target's *current* state; atomically claims the proposal (`status = 'proposed' and expires_at > now()`); runs the existing domain function (so lifecycle rules, notifications and audit of that module apply unchanged); reads the system back; and records `succeeded` only when the read-back matches (a database check makes `succeeded` without `verified` impossible). A repeat confirmation returns the stored outcome and never re-executes. An interrupted `executing` row is settled by verifying, never by re-running. Proposals expire after 30 minutes. Only the requesting Super Admin can confirm.

## 4. Scope, tenant isolation and data minimisation

Scopes: platform, client, AI Employee, workflow, support ticket, incident. The browser names a record; the server returns the verified label and tenant. Selecting a client writes an audited `aqi.ops_tenant_access` row before any tool runs. Tools read operational metadata only: no contacts, conversations, message bodies or CRM records. Free text that people or systems wrote (ticket subjects, errors, audit metadata) is length-capped, secret- and contact-redacted, defanged against prompt delimiters and flagged when it reads like an instruction. History and memory sent to the model are limited to messages recorded in the **same scope**, so one client's conversation never reaches another client's context; memory expires after 30 days and is always labelled as not evidence of current state.

## 5. Honest states

Platform states are `Healthy`, `Degraded`, `Unavailable`, `Unknown`, `Not configured`; there are no percentages. "Healthy" overall requires the database, migrations, scheduler and incident collection to be verified; an absent scheduler (the production situation today) yields `Unknown`, never green. Employee states follow recorded evidence (precedence in `deriveEmployeeState`); `Scheduled` is never produced because no schedule data exists. Every health answer lists what cannot be measured and what would be required.

## 6. Verified data sources vs. gaps (not faked)

Not available in this deployment, and reported as such everywhere they would matter: API error rate and latency (no APM), slow-query telemetry, host resource usage, deployment/CI status and release notes, error monitoring, Hermes schedules/cron and an AI Work Board (neither exists in this repository), voice interaction in AQi, subscription revenue/retention (no such billing model), voice-call minutes (not a metered unit), and any message retry (retrying inside a client's CRM requires an audited support session, which AQi does not hold; retries are therefore preview-and-explain only).

## 7. Briefings, memory, history and telemetry

**Briefings** (`src/server/aqi/ops/briefing.ts`, `briefings.ts`). Nothing is generated or sent for an administrator who has not opted in on the Briefings panel (`aqi_ops_briefing_settings`: daily, weekly, critical alerts; time zone, hour, weekday, quiet hours; all off by default). Every briefing states its reporting period and the data sources it used, ranks items by evidence, and ends with a *Recommended* section that is a proposal, never an action taken. Delivery is an in-app notification (`notifyUser`), withheld during the administrator's quiet hours (the briefing is still stored and shown in the console). Each briefing is keyed per person and local day or incident (`aqi_ops_briefings.dedupe_key` is unique), so a scheduler that runs every minute cannot duplicate one. A slot is marked done only after its announcement succeeded: if the notification store fails, the stored briefing stays `generated` and the next tick announces *that* briefing (no second one is composed, no second notice is sent). Once a slot is done a tick only reads the settings. Up to 25 opted-in administrators are handled per run. The daily and weekly slots follow each administrator's own time zone: the first tick at or after the chosen local hour on a local date takes that date, a skipped hour at the start of daylight saving still produces that day's briefing at the first existing hour, and the repeated hour at the end of it produces nothing extra (verified for New York, London, Kolkata and Auckland in `tests/aqi-ops-briefing-schedule.test.ts`). **Scheduled** briefings run from the `aqiOperationsBriefings` job and therefore need the scheduler configured (`CRON_SECRET`, `SCHEDULER_ENABLED`); *Generate one now* works without it and is stored without a notification. If migration 0068 is not applied yet the job treats the missing table (`42P01`) as "nothing to do" instead of failing the tick.

**Memory** (`memory.ts`). Short notes the person's earlier turns left in the *same scope* are offered to the model labelled as past conversation, never as evidence of current state, and expire after 30 days. A question about one client never receives another client's memory.

**History and retention** (`conversations.ts`). Investigations are `aqi_conversations` rows with `surface = 'operations'`, owned by the Super Admin who ran them, with no organization; the Operations history endpoints return only those rows. The Client assistant's history queries are deliberately **unchanged** so that the Client assistant keeps working before migration 0068 is applied (filtering on the new column would fail there). Consequence: the same Super Admin could list their own investigations through the Client history endpoints, which the Operations console does not use and the Super Admin no longer sees a Client widget for; nobody else can, because every query is keyed by owner. Cards stored with an answer are re-hydrated with the *current* state of any action, so a reopened investigation shows the verified result rather than a stale proposal. Investigations and stored briefings older than 180 days are deleted 100 of each at a time by `aqiOperationsRetention`; confirmed actions remain in `aqi_ops_actions` and the audit log.

**Telemetry** (`tools/telemetry.ts`, tool `aqi.telemetry`: "How is AQi performing?"). AQi measures itself from rows it already writes and stores nothing extra: one `aqi.ops_tool_run` audit row per tool run (outcome, duration), `aqi_usage_events` for model calls (tokens, estimated-or-priced cost, latency) and `aqi_ops_actions` (proposed / verified / failed). Medians and 95th percentiles are computed over successful runs only. It does not claim database query latency, which is not recorded anywhere in this deployment.

## 8. Security review

| Risk | Control | Evidence |
| --- | --- | --- |
| A lower role reaching Operations | The runtime is chosen by the **server-resolved** role. Every tool lists the roles it is offered to; the executor refuses a role, a missing agency permission or a scope mismatch again at call time. Only `agency_super_admin` matches. | `aqi-ops-core`, `aqi-ops-routes`, browser: manager and client owner get 403 on every Operations API and keep their assistant |
| Prompt injection through ticket text, errors, audit metadata | The model never chooses a tool or an argument (a deterministic planner does). Evidence is length-capped, secret- and contact-redacted, defanged against role markers and delimiters, flagged when it reads like an instruction, and fenced as untrusted data in the prompt. Writes exist only as proposals. | `aqi-ops-redact`, `aqi-ops-turn`, `aqi-ops-core` ("instruction-like text … cannot pick tools") |
| Cross-client leakage | The browser names a record; the server verifies it and derives the tenant. Tenant selection writes an audited `aqi.ops_tenant_access` row first. Tools read operational metadata only (no contacts, conversations or message bodies). History and memory are keyed by scope. | `aqi-ops-tools`, `aqi-ops-boundaries`, browser ("another client's data does not appear") |
| Unsafe writes | Five action tools only; propose → preview → confirm (separate same-origin request, re-authenticated with the auth server) → execute through the existing domain function → read back → record `succeeded` only if the read-back matches. High-impact actions need a reason and the typed client name. Atomic claim, idempotency key, 30-minute expiry, only the requester can confirm. A database check makes "succeeded without verification" impossible. | `aqi-ops-actions` (10), `aqi-ops-hardening`, `aqi-migration-0068`, browser (preview creates nothing; confirm gating; pause and resume verified) |
| A stale session or a changed account acting | Every run re-reads the caller's *current* platform role and status in the same statement that loads their permissions; if the account was demoted, disabled or removed since the session was issued, the run is refused ("Your access has changed"). The confirm endpoint also re-authenticates with the auth server. | `aqi-ops-hardening` ("tool authorization", and each action refused after a demotion) |
| Two things at once | A proposal is claimed with one conditional update; a partial unique index allows only one *executing* action per tool and target; the target is checked again after the claim, so a second confirmation that loses the race reports "already acknowledged / already paused" as a failed action instead of running the change again. An abandoned execution is settled from the real state, never re-run. | `aqi-ops-hardening` (double confirm, confirm vs cancel, two pause proposals, two acknowledgements), `aqi-migration-0068` |
| An argument naming a different target than the one selected | The acknowledge, escalate and priority tools refuse any record other than the selected context (the pause tool already refused any other client). | `aqi-ops-hardening` ("will not act on a target other than the one selected") |
| A credential pasted into a reason or issue text | Removed before it is stored, shown in a preview or passed to the domain function; the audit metadata of the AQi rows never contains the reason. | `aqi-ops-planner`, `aqi-ops-hardening` |
| A question taken for an instruction | A change is prepared only for an instruction; questions ("Should we pause automation?"), requests naming two changes, and things AQi never does (restart, delete, run SQL, approve, refund, impersonate…) get an explanation instead of a proposal. | `aqi-ops-planner` (105 cases) |
| Secrets in answers or logs | `redactValue` on every card, summary and audit metadata (tokens, bearer values, key-shaped strings, emails, phone numbers); failures log a sanitized class, not the message. No tool reads Vault, environment secrets or provider keys. | `aqi-ops-redact`, performance test (a thrown `token=sk-live…` never appears in output) |
| Cost and abuse | Per-person limits: 12 action requests / 10 min, 40 refreshes / 5 min, plus the existing chat limits and the AQi spend reservations; ≤6 tools per turn, ≤2 at once, a wall-clock timeout per tool (a timed-out tool is reported and the turn continues; the database statement itself is not cancelled, which is why every query is bounded and indexed). | `aqi-ops-performance`, `aqi-ops-actions` |
| Over-claiming | Honest-state vocabulary (section 5), mandatory "not measured" list, citations validated against the evidence actually retrieved (an invented `[E9]` is removed), evidence-only fallback when no model is available. | browser ("narrative … drops the invented id"), `aqi-ops-turn` |
| Customer-facing support flow reaching a Super Admin | `requireClient` refuses a Super Admin on the AQi support routes. | `aqi-ops-boundaries` |

Residual risks: the optional narrative is model-written text, so it can still phrase evidence loosely (it is cited and the cards beside it are the source of truth); `aqi_usage_events` cost can be estimated from text length when a provider omits usage (the card says so); a Super Admin session that is already compromised can confirm the five actions (each is audited and reversible by the existing screens).

## 9. Performance (measured, local database only)

AQi Operations is deliberately DB-light: every tool is a bounded, paginated, mostly single aggregate query; a turn runs at most six tools, two at a time; nothing fans out per record; the overview and the console are not polled (Refresh is explicit and re-runs read tools only). `tests/aqi-ops-performance.test.ts` seeds 62 workspaces, 600 support requests, 400 incidents, 300 pending approvals and 6,000 audit rows, then fails if a tool exceeds its statement budget, 4 s, or 70 KB.

| Tool | Time | SQL statements | Payload |
| --- | ---: | ---: | ---: |
| `platform.health` | 13 ms | 3 (+ 1 driver ping) | 5.6 KB |
| `platform.incidents` / `platform.jobs` | 4 / 2 ms | 1 / 2 | 6.3 / 0.7 KB |
| `workspace.directory` / `.find` / `.summary` | 6 / 2 / 4 ms | 1 / 1 / 2 | 6.9 / 0.6 / 5.0 KB |
| `workforce.status` / `.runs` / `.approvals` | 57 / 2 / 13 ms | 1 / 1 / 1 | 10.0 / 3.8 / 4.1 KB |
| `support.queue` | 210 ms | 5 | 6.7 KB |
| `support.ticket` / `.duplicates` / `.draft_reply` | 12 / 43 / 8 ms | 10 / 1 / 7 | 1.6 / 10.4 / 0.3 KB |
| `security.events` | 17 ms | 3 | 7.1 KB |
| `business.summary` / `.client_costs` | 15 / 2 ms | 10 / 1 | 4.2 / 1.0 KB |
| `integrations.status` / `.trace` | 3 / 3 ms | 3 / 1 | 2.0 / 0.9 KB |
| `release.info` / `product.requests` | 2 / 1 ms | 1 / 1 | 2.9 / 0.9 KB |
| `briefing.compose` | 11 ms | 4 | 7.2 KB |
| `aqi.telemetry` | 6 ms | 3 | 5.0 KB |

These are in-process PGlite figures on one developer machine. They prove the **shape** (constant statements per tool, capped payloads, pagination, no N+1) and catch regressions; they are **not** hosted latency and no hosted figure is claimed. `support.ticket` and `business.summary` reuse existing services that issue several fixed queries; their count does not grow with data. Lists report the true total and say how many more exist (for example 600 requests → 8 shown), and a request for more than the cap is refused rather than honoured. A slow tool times out and is reported as such without blocking the others; a failing tool is isolated from the rest of the turn. Besides the indexes on its own tables, migration 0068 adds three for scans that had none: `audit_logs (action, created_at desc)`, `appointment_reminders (org_id, updated_at desc)` and `crm_webhook_deliveries (org_id, created_at desc)`.

## 10. Deployment, configuration and rollback

**Status: committed on branch `worktree-aqi-operations` only. Not pushed. Not deployed. Migration 0068 has not been applied to any hosted project.**

Order of operations when approved:

1. Review the migration `supabase/migrations/0068_aqi_operations.sql` and its rollback `supabase/rollbacks/0068_aqi_operations.down.sql`, and the audit in section 14. It is additive: one column with a default (`aqi_conversations.surface`), three new tables (RLS on, no grants to the app roles) and their indexes, and five indexes on existing tables. It starts with `set local lock_timeout = '5s'`, so if a long transaction holds a lock it fails whole and fast instead of queueing behind it.
2. Apply 0068 to **staging** first, then verify: Super Admin sees *AQi Operations*; a client owner still gets the Client assistant; `/api/aqi/ops/*` returns 403 for everyone else.
3. Apply to production **before** the code is deployed. The old code ignores the new objects, so the migration is safe to apply early. The new code tolerates a missing table in the scheduled jobs but the console and actions need it.
4. Deploy. No new environment variables are required. Scheduled briefings and the retention job additionally need the scheduler (`CRON_SECRET`, `SCHEDULER_ENABLED`; see `docs/production-scheduler.md`); without it they are simply not run, and the console says briefings are on-demand.
5. Rollback: revert the deployment (the Client assistant is unaffected either way), then run `supabase/rollbacks/0068_aqi_operations.down.sql` only if the objects must be removed. It **refuses to run** while `aqi_ops_actions` has rows (they are the audit trail of what a Super Admin approved) or any operations conversation exists; archive or delete those first, then it drops the indexes, the three tables and the `surface` column. Briefings and briefing settings are dropped without a check, so export them first if they matter.

The Client assistant does not reference any migration 0068 object, so a deploy that fails halfway cannot affect clients.

## 11. Verification record (what was actually run)

Everything below ran in this branch on 2026-10-20, against isolated local fixtures only (in-process PGlite, a capture-only email provider, a loopback mock model server). Nothing was run against a hosted database, Vercel project or provider account.

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | clean (app and scripts) |
| Lint | `npm run lint` | clean |
| Full unit/integration suite | `npx vitest run --maxWorkers=2` | **230 files, 3,619 tests, all passed** (exit 0), run after every source change below except one added test file. `tests/aqi-ops-registration.test.ts` (17 tests, passing) was added after that run started, so the suite as it now stands is 231 files and 3,636 tests, of which the last 17 were run on their own. An earlier full run (before this hardening pass) was 3,420 of 3,421: its one failure was `tests/aqi-migration-0047.test.ts` listing every `aqi_*` table, fixed for the three new ones. |
| AQi Operations tests | `tests/aqi-ops-*.test.ts`, `tests/aqi-migration-0068.test.ts`, `tests/scheduler-intervals.test.ts`, `tests/notification-badge-a11y.test.tsx` | Foundation set (81): redaction (5), registry and permissions (14), real-schema tools (16), action lifecycle (10), turns (9), routes (6), briefings (9), boundaries (3), performance (4), migration (5). Hardening set (this pass, 220 in 7 files, run together: 220 passed): planner matrix 105, action failure/concurrency/authorization/isolation 48, briefing schedule 18, scheduler intervals 19, registration 17, notification badge 4, migration 9 (4 more than before) |
| Browser and accessibility QA | `scripts/ops-browser-qa.mjs` (Playwright, isolated server on its own port, mock model, `EMAIL_PROVIDER=capture`) | **56 checks, 0 failed** on the final run, with **nothing excluded from the axe scans** (the notification bell is on screen with its badge: "9+" for the Super Admin, a single digit for the manager). Covers the console and overview, health investigation, client scope and tenant isolation, employee states, AQi's own telemetry, action preview → confirm → verified, typed confirmation, pause and resume, history restore, briefings, mobile (390 px) without overflow, dark mode, axe-core (no serious/critical on console desktop, mobile, dark, the confirmation dialog and a manager page with an unread badge), launcher correct immediately after sign-in without a reload, Escape/focus return, agency manager and client owner refused, Client assistant unchanged, no external requests, no console or page errors |
| Production build | `IAQ_DIST_DIR=.next-aqi-ops npx next build --webpack` | compiled successfully (exit 0); `/admin/operations` and the seven `/api/aqi/ops/*` routes are in the route table; `tsconfig.json` restored afterwards |

Defects found by this testing and fixed: a role marker (`system:`) surviving defanging; a tenant-access audit row lost to an un-awaited write; contrast and accessible-name failures on the scope chip, the confirmation dialog and (this pass) the notification bell's unread badge; slow-rhythm scheduler jobs that ran once and never again; a stale session object being trusted for the caller's role; three action tools that did not bind their argument to the selected context; two confirmations for the same target able to run the change twice; "Raise the priority of this ticket" and "Should we pause…?" being read as instructions to create an issue or pause automation; a credential pasted into a reason being stored; a failed briefing notification that was never retried; stored briefings that were never purged; missing indexes for foreign keys and for the retention scan. A planner regex corrupted by a scripted edit (control characters) was caught by the new planner tests.

## 12. Known limitations and follow-ups

* **No APM, error monitoring, host-resource, deployment/CI or slow-query data exists in this deployment.** AQi says so on every health answer rather than inferring it. Integrating a provider (and its credentials) is a separate, approved piece of work.
* **Hermes**: no schedule/cron data and no AI Work Board exist in this repository, so `Scheduled` is never shown. Employee health is `Unknown` until a health check has passed.
* **Message retry is not executed.** Retrying inside a client's CRM would need an audited support session, which AQi does not hold; the integration debugger previews and explains only.
* **No model-driven tool planning.** The planner is deterministic keyword/scope routing; questions it does not recognise get a list of what can be investigated, not a guess. An optional LLM planner constrained to the registered tools could be added, but it was not needed to satisfy the safety model and was not built.
* **Operating costs are not revenue.** There is no subscription revenue or retention model and voice-call minutes are not a metered unit, so the business tools report only what the billing report and `metered_usage_events` contain.
* **Scheduler** is not configured in production, so scheduled briefings, retention and every slow-rhythm job do nothing there until it is. The `withinInterval` defect that would have made the slow jobs run only once is fixed on this branch (section 13); **another session fixed the same defect on a different branch** (see section 16), so the two must be reconciled before either is merged.
* **Performance numbers are local.** Hosted latency was not measured and is not claimed.
* **The Client history endpoints** are unchanged (section 7).
* **Agency Manager and Staff have no Operations access.** A proposed matrix for limited access later is in section 15; none of it is implemented.

## 13. Scheduler: how slow-rhythm jobs run

**The defect.** Nine jobs were meant to run on a slow rhythm (`supportAutoClose`, `supportAttachmentCleanup`, `fairUseChecks`, `inactivityReview`, `offboardingReminders`, `crmWorkflowRecovery`, `whatsappTemplateSync`, `setupEvidence`, `aqiTutorialEventRetention`). Each tested `withinInterval(name, minutes)` inside its own body and returned `0` when not due. `runJob` recorded that `0` as a success and moved `last_success_at` forward, which is what `withinInterval` reads, so after its first run every gated job was "within interval" on every later tick, forever. It was reproduced with a throwaway test (0 executions over 24 further five-minute ticks) and is unobserved in production only because the scheduler is not configured there.

**The fix** (`src/server/ops/jobs.ts`, `src/server/ops/tick.ts`). A job now declares `everyMinutes` on its `JOBS` entry and its body contains no gating. `runJob(name, fn, summarize, { everyMinutes, now })` decides and claims in one statement (`insert … on conflict do update … where <due> returning`):

| Situation | Result |
| --- | --- |
| Never ran | Due now |
| Last run finished and succeeded | Due when at least `everyMinutes` have passed since it **started** (anchoring on the start, not the end, stops the cadence drifting by the run time) |
| Last run failed | Due again after `min(everyMinutes, 15)` minutes, so a failing job is retried soon but not on every tick |
| Last run started and never finished | Treated as running (skipped, reason `running`) for 15 minutes, then as dead and due |
| Not due | **Nothing is written.** `last_success_at`, `last_started_at` and `runs_total` still describe the last real run; the tick response reports `"skipped"` |
| Two ticks at the same moment | The conditional update lets one claim the slot; the other is skipped as `running`. A failure to make the claim itself is reported as that job failing and does not stop the others |

Intervals are elapsed time, not calendar slots. A daily job runs 24 hours after the previous run started: in UTC the gap is exactly 1,440 minutes across a daylight-saving change, and in New York the local hour shifts by one (asserted in `tests/scheduler-intervals.test.ts`). Per-person calendar slots live elsewhere: the briefing job decides each administrator's daily and weekly slot in their own time zone (section 7) and is deliberately not interval-gated.

| Job | Cadence |
| --- | --- |
| `crmWorkflowRecovery` | 5 min |
| `setupEvidence` | 15 min |
| `supportAutoClose`, `supportAttachmentCleanup`, `fairUseChecks` | 60 min |
| `whatsappTemplateSync` | 180 min |
| `inactivityReview`, `offboardingReminders` | 360 min |
| `aqiTutorialEventRetention` | 1,440 min |
| every other job, including `aqiOperationsBriefings` and `aqiOperationsRetention` | each tick |

**Evidence** (`tests/scheduler-intervals.test.ts`, 19 tests, simulated clock through the real `runScheduledJobs`): hourly runs 48 times in two days exactly 60 minutes apart; daily runs once per 24 hours for a week across the 8 March 2026 US clock change; weekly runs on days 0, 7, 14 and 21; a 15-minute job with one-minute ticks runs every 15; a late tick neither runs early nor twice; two jobs on different cadences do not disturb each other; a skipped tick leaves the heartbeat row byte-for-byte unchanged; failures retry after 15 minutes and recover to the normal interval; overlapping ticks execute once; a crashed run is recovered; the registry holds exactly the nine slow jobs with the cadences above and the two AQi jobs run every tick; and the real job list, run at the same instant twice, executes every slow job once and then skips all nine. The real list is also run at +5 min (only `crmWorkflowRecovery` due), +60 min and +24 h.

## 14. Migration 0068 audit

Checked against the migration file and the repository's runner. Hosted migrations were **not** applied or rehearsed.

| Concern | Finding | Action |
| --- | --- | --- |
| Lock on `aqi_conversations` | `add column … not null default 'assistant' check (…)` does not rewrite the table (PostgreSQL 11+ stores the default); the CHECK is verified by one scan of a small table while the lock is held. | `set local lock_timeout = '5s'` added, so a blocked migration fails whole and fast rather than queueing behind a long transaction and stalling every query behind it |
| Index on `audit_logs (action, created_at desc)` | A plain build takes a `SHARE` lock: inserts into `audit_logs` wait for the build. The index is needed (the table has only `(org_id, created_at)` and `(actor_user_id, created_at)`; platform-wide security and telemetry queries filter by action and time). A **separate concurrent migration is not possible here**: the application runner (`npm run db:migrate`) wraps every file in `begin … commit` and appends its bookkeeping insert to the same script, `create index concurrently` is an error inside a transaction, and the PGlite test database applies migrations the same way. Read-only evidence: one `supabase inspect db table-stats --linked` call returned `public.audit_logs` at about 449 estimated rows and 288 kB, so the inline build takes milliseconds today. A second read of that output was blocked by the environment's production-read guard and was not retried. | Kept inline. The migration header documents the escape hatch: if `pg_class.reltuples` for `audit_logs` is large when this is applied, create the index by hand first with `create index concurrently if not exists audit_logs_action_created_idx on audit_logs (action, created_at desc);` (outside a transaction); the migration's own statement is `if not exists` and then does nothing. A failed concurrent build leaves an INVALID index: drop it and retry. |
| Other indexes on existing tables | `appointment_reminders (org_id, updated_at desc)` and `crm_webhook_deliveries (org_id, created_at desc)` serve per-client delivery traces; both tables are small today. `aqi_conversations (user_id, surface, last_message_at desc)` serves history; `aqi_conversations (last_message_at) where surface = 'operations'` is **new** and keeps the retention job from scanning every Client conversation each tick. | Added the retention index |
| Foreign keys on the new tables | `aqi_ops_actions.conversation_id`, `.message_id` and `.confirmed_by` are `on delete set null`; without indexes every conversation, message or user delete would scan the table. | Partial indexes added for all three; a test now fails if any foreign key on the new tables lacks an index (and a negative control proves the check can fail) |
| Concurrency | Nothing stopped two confirmations of different proposals for the same target executing together. | `aqi_ops_actions_one_executing_idx`: unique on `(tool_id, target)` while `status = 'executing'` (section 8) |
| Retention | `aqi_ops_briefings` had no retention and no index for it. | `aqi_ops_briefings (created_at)` and a 180-day purge in `aqiOperationsRetention` |
| RLS and grants | All three tables have RLS enabled, **no policies**, and `revoke all` from `public`, `anon`, `authenticated`; the application role has no grants (tested through `iaq_app_user`). The server reaches them only through system-level queries after authorising a Super Admin. | Unchanged; tested |
| Data safety | No existing row is updated or deleted; the new column has a safe default for existing and new Client conversations (tested). Every table and index is `create … if not exists`, and the whole file runs in one transaction, so a failed run leaves nothing behind. | Test asserts the migration contains no `drop`, `truncate`, `delete` or `update` |
| Rollback | `supabase/rollbacks/0068_aqi_operations.down.sql` refuses while `aqi_ops_actions` has rows or any operations conversation exists, then drops the indexes, tables and column. | Round trip tested: down then up inside a rolled-back transaction restores every index |
| Deploy order | Old code ignores the new objects; new code tolerates a missing table in the two scheduled jobs but its console and actions need the migration. | Apply 0068, then deploy (section 10) |

## 15. Agency Managers and Staff: current access and a proposed matrix

**Today: none.** The runtime is chosen by the server-resolved role, no Operations tool lists `agency_manager` or `agency_staff` in `roles`, the console and every `/api/aqi/ops/*` route answer 403, and a run for anyone below Super Admin is refused at the executor (all read tools were exercised for both roles and are denied with an audit row). Managers and Staff keep the existing assistant. **No access is granted by this work.**

The matrix below is a **proposal for a later decision**, built from permissions that already exist (each tool already names its agency permission, and a Super Admin can already grant or withhold permissions per person in Agency team settings). It is not implemented and needs approval.

| Capability | Tools | Permission already required | Super Admin | Manager (proposed) | Staff (proposed) |
| --- | --- | --- | --- | --- | --- |
| Client workspace summary | `workspace.summary` | `agency.workforce.view` | all clients | assigned clients | assigned clients |
| Client directory and search | `workspace.directory`, `.find` | `agency.workforce.view` | all clients | **only after** the tool filters to assigned clients (today it lists all) | same |
| AI Employee status, runs, approvals | `workforce.*` | `agency.workforce.view` | all | assigned clients, read only | assigned clients, status only |
| Support queue, ticket, duplicates | `support.queue`, `.ticket`, `.duplicates` | `agency.support.view` (+ `.queue`) | all | as in Support & Requests (the service already scopes by assignment) | assigned requests only |
| Draft a reply | `support.draft_reply` | `agency.support.manage` | yes | yes | yes, advisory |
| Integration status and traces | `integrations.*` | `agency.integrations.health` | all | assigned clients | assigned clients |
| Security events | `security.events` | `agency.audit.view` | platform-wide | one assigned client at a time | no |
| Product themes | `product.requests` | `agency.support.analytics` | yes | yes | no |
| Platform health, incidents, jobs, release, briefings | `platform.*`, `release.info`, `briefing.compose` | `agency.security.manage` | yes | summary only, if granted `agency.security.manage` | no |
| Costs and usage | `business.*`, `aqi.telemetry` | `billing.agency_view`, `agency.audit.view` | yes | **no** (financial) | no |
| Escalate a request | `support.escalate` | `agency.support.manage` | confirm with reason | yes, confirm with reason | no |
| Change request priority | `support.set_priority` | `agency.support.priority` | confirm | yes | no |
| Record an internal issue | `issue.create` | `agency.support.queue` | confirm | yes | yes |
| Acknowledge an incident | `incident.acknowledge` | `agency.security.manage` | confirm | only if granted that permission | no |
| Pause or resume a client's automation | `automation.agency_pause` | `agency.security.manage` | typed confirmation | **never** (lifting an emergency pause is already Super-Admin-only in the domain code) | never |
| Briefings | `aqiOperationsBriefings` | opt-in per person | yes | assigned clients only, opt-in | no |

Prerequisites before any role is switched on (summary of the matrix above): (1) every platform-scope aggregate (directory, support queue totals, incident lists, briefings) filters to the person's assigned clients, with a test that a second client's records never appear; (2) a Super Admin-controlled setting per role, off by default, with an audit row when it changes; (3) separate rate limits and an AQi budget line for those roles; (4) the tenant-isolation and authorization tests in `tests/aqi-ops-hardening.test.ts` repeated for each newly enabled role; (5) a review of what ticket text and audit metadata a Manager may see, since Operations tools return more cross-cutting detail than the Support screens do; (6) written approval from the Super Admin for each row.

## 16. Production-readiness report (for approval)

**State: ready for review, not released.** Branch `worktree-aqi-operations`; commits `3af7c98` (foundation), `646d9e4` (console, briefings, retention, telemetry) and the hardening commit that contains this section (`git log -1 -- docs/aqi-operations.md`). Nothing is pushed, merged, deployed or applied to a hosted database, and the production scheduler is not enabled.

### What the hardening pass changed

| Request | Outcome |
| --- | --- |
| Scheduler defect | Fixed with an atomic, interval-aware claim in `runJob` (section 13). 19 regression tests on a simulated clock: hourly, daily, weekly, 5- and 15-minute cadences, daylight saving, late and overlapping ticks, failure retry, abandoned runs, and the real job list. No job outside the nine slow ones changed behaviour (asserted by name and order). |
| Briefing delivery, quiet hours, deduplication, retention | Reviewed and tested for New York, London, Kolkata and Auckland (spring-forward, fall-back, half-hour offset, local weekday that differs from UTC's), quiet windows across midnight, equal start and end, critical alerts through quiet hours, overlapping ticks, 14 days of 15-minute ticks, seven administrators, deactivated accounts and retention. **Defects fixed:** a failed notification was never retried (the slot was marked done first); administrators beyond the fifth were never handled; stored briefings were never purged. |
| Notification bell accessibility | Fixed in `notification-center.tsx`: the accessible name now contains the badge text (`Notifications, 9+ unread`), the badge is white on the dark red in light mode (6.5:1) and the dark ink on the brighter red in dark mode (5.5:1), and its entrance no longer fades the text. Unit tests assert the label and the contrast from the real tokens; the browser scans run with nothing excluded and the badge on screen. Notification behaviour is unchanged (the existing notification tests pass). |
| Migration 0068 | Audited (section 14). Added fail-fast locking, a retention index, foreign-key indexes, a one-executing-per-target guard, and a documented concurrent-index path for `audit_logs`. A separate concurrent-index migration is not possible with the repository's runner and was not made. |
| Operations runtime | Planner: 105 cases across supported requests, paraphrases, questions that must not become actions, multiple changes, unsupported instructions and ambiguity. Five actions: failure, verification mismatch, double confirmation, confirm-versus-cancel, competing proposals, demotion, argument tampering, credential redaction, audit completeness. Authorization matrix over every read tool for Manager and Staff. Tenant isolation with canary records in a second client across tenant and ticket scopes. Client AQi: no import of Operations code from any Client module (tested) and the Client service files are unchanged (see below). |
| Agency Manager and Staff | Still excluded; proposed matrix in section 15; nothing granted. |
| Final QA | Full suite, typecheck, lint, build, browser and accessibility run (section 11). Registration test confirms every page, route, navigation entry, rate limit, planner tool and scheduled job is wired. |

Changes to existing (non-AQi-Operations) behaviour in this pass: `src/server/ops/jobs.ts` and `src/server/ops/tick.ts` (the nine slow jobs now run on their declared cadence, which they did not before; the tick response shows `"skipped"` instead of `0` for a job that was not due) and `src/components/notifications/notification-center.tsx` (label, colours, entrance animation). Client AQi: comparing the Client assistant's code with the base commit (`git diff --stat 03de0bf -- src/server/aqi src/components/aqi src/lib/aqi`, excluding the `ops` folders) shows two small changes in all: the one-line registration of `/admin/operations` in `src/lib/aqi/routes.ts` and the refusal of the customer support flow for a Super Admin in `src/server/aqi/support.ts` (+5 lines). `service.ts`, the prompts, knowledge, widget and history code are untouched.

### Migration plan (nothing below has been done)

1. **Reconcile numbering.** 0068 follows 0067 on `origin/master` as last fetched in this checkout. Re-check immediately before applying that no other branch has taken 0068.
2. **Pre-flight, read only** (needs your approval to run against the hosted project): the latest `schema_migrations` row is `0067_notification_authorization`; `select reltuples::bigint from pg_class where oid = 'public.audit_logs'::regclass` (if it is more than about a million, create the index first with the concurrent statement in section 14); no long-running transaction is open on `aqi_conversations`.
3. **Backup** per `docs/deployment.md`.
4. **Staging first**: `npm run db:migrate`, then check: the nine objects exist; a Client conversation still inserts (`surface = 'assistant'`); a client owner still gets the Client assistant; every `/api/aqi/ops/*` answers 403 to non-Super Admins; the Super Admin console loads with every tile either measured or "not measured". Rehearse the rollback on staging with data present and absent.
5. **Production**: apply 0068, then deploy the code. Do not enable the scheduler in the same step.
6. **Enable the scheduler later and separately** (`CRON_SECRET`, `SCHEDULER_ENABLED`, `docs/production-scheduler.md`), after deciding between the two scheduler fixes (below). Watch `/admin/health`: the nine slow jobs should show a last run that advances only at their cadence.
7. **Rollback**: redeploy the previous build (the Client assistant never depended on 0068); run the down migration only if the objects must go and only after archiving what it refuses to delete.

### Local versus hosted verification

| Verified locally (isolated PGlite, mock model, captured email) | Not verified on a hosted project |
| --- | --- |
| Every test, build, lint and browser result in section 11 | Migration 0068 on a hosted database (never applied, never rehearsed) |
| Query shape, statement counts and payload sizes (section 9) | Hosted latency, connection pooling, plan choices on real data volumes |
| Briefing time zones, quiet hours, retention, scheduler cadences on a simulated clock | A real scheduler calling `/api/internal/tick` (not configured in production) and real notification delivery |
| Role boundaries, tenant isolation, action lifecycle, concurrency within one process | Concurrency across several server instances against one hosted database (the guards are database constraints, so they should hold, but it was not exercised) |
| Accessibility of the pages scanned, in light, dark and 390 px | A real AI provider's narrative quality and cost; a real Super Admin session through Supabase Auth's fresh-session check |
| One read-only hosted fact: `audit_logs` is about 449 rows (a single `supabase inspect db table-stats --linked`; a further production read was blocked by the environment and not pursued) | Everything else about the hosted project |

### Two scheduler fixes exist

A separate session, started from a proposal in this one, fixed the same defect in worktree `confident-moser-b13a2b` (branch `claude/confident-moser-b13a2b`, cut from a newer master; **uncommitted**, per its own note). It gates inside `runScheduledJobs` with the existing `withinInterval` helper and also has `everyMinutes` and a `tests/scheduler-intervals.test.ts` **with the same file name as this branch's**. This branch's version additionally claims the slot atomically, anchors on the run's start, retries failures after 15 minutes, detects abandoned runs and survives overlapping ticks. Merging both would conflict in `tick.ts`, `jobs.ts` and that test. **Choose one** before merging either; the newer master also changed the `setupEvidence` job (it has its own lease there), which this branch does not have, so that entry needs a manual merge whichever is chosen.

### Remaining gaps

* No APM, error-monitoring, host-resource, deployment/CI or slow-query data source exists; AQi says so rather than inferring.
* No Hermes schedule or AI Work Board data exists in the repository, so `Scheduled` is never shown.
* Message retry is explanatory only; an audited support session would be needed to retry inside a client's CRM.
* The planner is deterministic keyword and scope routing. Phrasings outside its tables fall back to "I couldn't map that…" with what can be investigated; an optional model-assisted planner constrained to the registered tools was not built.
* The Client assistant's history endpoints are unchanged, so the same Super Admin could list their own investigations through them (section 7).
* Platform-wide aggregates are not filtered to assigned clients, which is why Managers and Staff stay excluded.
* Hosted latency and multi-instance concurrency are unmeasured.
