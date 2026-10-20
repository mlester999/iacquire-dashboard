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
