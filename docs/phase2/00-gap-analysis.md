# Phase 2 gap analysis: Missed-Call Recovery and AI Lead Scoring

Audited on branch `feat/phase2-lead-conversion`, cut from `origin/master` `447249d` (Unified Inbox and AI Workforce already merged).
Everything below was read from this tree; nothing is assumed. File references are to this worktree.

> **Status:** this is the audit of the starting state. Sections 2 and 5 list what was missing and the plan; all of it except the items marked "not built" (a Twilio Voice / GoHighLevel call adapter, and an executable AI call-back) has since been built. What was built is in `01-architecture.md`; how it was verified, and what was not, is in `04-verification.md`; rollout and rollback are in `02-operations-and-rollout.md`.

## 1. What already exists (and is reused)

| Area | Evidence | Reuse decision |
| --- | --- | --- |
| **Voice call ingestion** | `src/app/api/webhooks/{vapi,retell}/route.ts` → `src/server/integrations/voice/handler.ts` → `recordVoiceEvent` in `src/server/crm/calls.ts`. Per-workspace credential from the vault, constant-time compare, failed-auth rate limit, `webhook_receipts` dedupe per (workspace, call id, event), cross-workspace call id refused | Reuse unchanged. The recovery engine hangs off the committed call record, not off the webhook |
| **Call record** | `crm_call_records` (0033): statuses `ringing, in_progress, completed, no_answer, busy, failed, voicemail, cancelled`; E.164-checked numbers; unique `(provider, provider_call_id)`; forward-only status merge; `call.completed` emitted once | Source of truth for classification. Not changed |
| **Contact match** | `matchContactByPhone`: exactly one live contact with that exact E.164, else `null` (two matches = no match, never by name) | Reuse. Unknown/ambiguous callers stay unmatched; nothing is merged |
| **Conversation + Inbox** | `conversations` (channels `sms/whatsapp/email` only, no voice channel), `conversation_events` append-only trail (kind is a free `^[a-z][a-z_]{2,39}$` slug), `recordConversationEvent`, rollout `inboxEnabledFor` | A missed call is recorded as a **conversation event** on the contact's SMS conversation, not as a fake message. Rendered only for workspaces with the new inbox |
| **Send safety chain** | `evaluateSend` in `src/server/messaging/send.ts`: contact deleted, human owner, stale ownership fence, AI pause, escalation pending, automation gate, suppression, consent (`no_consent` for follow-ups with none on record), provider switching, channel enabled, follow-up caps, WhatsApp window, credits/budget, **quiet hours and business hours**, `dedupeKey` at-most-once. Dispatcher turns queued messages into FINAL `blocked/provider_not_enabled` while a provider write switch is off | **Every recovery text goes through `queueOutbound`.** Nothing new sends. Recovery adds only its own pre-checks (case state, attempt cap, newer interaction, booking) |
| **Event outbox + workflows** | `crm_events` (+ `dedupe_key`, depth limit), subscribers in `src/server/crm/dispatch.ts`, triggers in `src/lib/crm/workflow/spec.ts` (`call.completed` exists; no missed-call or score trigger), `conversation_action` step, premium gating `assertStudioEntitled` | Add triggers and steps to the same engine; add one dispatcher subscriber for score reassessment |
| **Scheduler** | 45 jobs in `src/server/ops/tick.ts`, `SCHEDULER_JOBS_ONLY` allowlist (verified present), `worker_job_runs` ledger, `runJob` with per-job interval. Production scheduler has **never run** | Add two jobs to the existing registry. No second scheduler |
| **Notifications** | `notifyOrgRoles`, `notifications_kind_check` extended from the live constraint (0083 pattern) | Same pattern for new kinds |
| **AI Workforce** | Six roles in `src/lib/agents.ts`. `WORKFORCE_CAPABILITIES` has 8 capabilities, **all `read_only`** (no employee may write a business record or contact a customer through a capability). Inbox lets only reply-capable roles be attached to a conversation | No new "AI Receptionist" or "Lead Qualifier" is invented. See §3 |
| **Lead score today** | `contacts.lead_score integer 0..100` (0027), set by hand/import/API, shown in lists/filters/workflows. `leads.score` (0003) belongs to Lead Hunter research candidates, a different object | `lead_score` stays a human/imported field. The engine writes new priority columns beside it (never overwrites it) |
| **LLM** | `llmComplete(config, {system,user,maxTokens})` in `src/server/llm/client.ts`: non-streaming, never throws, no schema validation, **no metering of its own** (`aqi_usage_events` meters only AQi) | Wrap it: strict schema validation, token cap, per-workspace rate limit and a usage row, safe fallback |
| **Custom fields** | `loadFieldDefinitions`, `readFieldValues` (`src/server/crm/fields.ts`) | Scoring criteria can reference native custom fields by key |
| **Permissions** | `calls.view`, `contacts.view/edit`, `messaging.configure`, `workflows.manage`, `analytics.view` in `src/lib/permissions.ts` | Reuse; no new broad permission. Policy edits need `messaging.configure` |
| **Migrations** | Highest on master `0083_unified_inbox`. `0084_restricted_hermes_provisioner` exists only on `codex/client-ai-onboarding`. No ref has `0085+` | Phase 2 uses **0085** (missed-call recovery) and **0086** (lead scoring) |

## 2. Gaps (what does not exist)

### Missed-call recovery
1. **No classification.** "Missed" is only a list filter (`no_answer, busy, voicemail`). Nothing distinguishes ring-no-answer, voicemail, abandoned, after-hours, answered-by-AI, transferred, outbound, or a call answered later.
2. **No durable case.** Nothing records "this missed call needs recovery", its owner, its attempts or its outcome. `call.completed` fires once and a workflow can react, but a workflow run is not a case: no state machine, no eligibility re-check, no stale-owner guard.
3. **No voice channel in the Inbox.** A call never appears in a conversation. A contact with no conversation has nowhere to show it.
4. **No telephony coverage beyond Vapi/Retell.** The Twilio route accepts only `inbound` and `status` **SMS** webhooks; there is no Twilio Voice or GoHighLevel call webhook. Missed calls to a plain business line (not answered by a Vapi/Retell assistant) can only arrive through a manual log or a future adapter. **Not built, documented as a provider gap**; the case model takes any `crm_call_records` row so an adapter later needs no engine change.
5. **No outbound calling.** `crm_voice_connections` stores only a webhook credential; there is no Vapi/Retell outbound-call API credential or call-creation code. **An AI callback therefore cannot be executed or verified.** The engine models it as an action that is `blocked: no verified outbound-call capability` and is never marked complete.
6. **No consent basis for a text to a missed caller.** `evaluateSend` rightly refuses a follow-up with no consent on record. Defaults must keep it that way; recovery falls back to a human task.
7. **No policy, no dashboard, no analytics, no rollout/readiness state.**

### Lead scoring
1. **No engine at all.** `lead_score` has no writer except people/imports/API.
2. **No signal collection, evidence, history, override or explanation.**
3. **No business-specific criteria**, no per-industry presets, no use of onboarding answers.
4. **No reassessment pipeline**: nothing watches new messages, calls, bookings, stage changes.
5. **No AI signal extraction with guardrails.** There is no schema-validated, metered, rate-limited LLM call anywhere outside AQi.
6. **No prioritisation surfaces**: contacts list, smart lists, follow-up queue, AI work board, inbox context, dashboards.

### Automation / workforce
* No triggers for missed call, recovery lifecycle, score change or Hot lead; no steps for eligibility check, reassessment request or priority update.
* No capability lets an AI employee act on a recovery case or a score. All current capabilities are `read_only`.

## 3. AI Workforce: who may do what (verified against `agents.ts` and `workforce-capabilities.ts`)

| Need | Reality in this tree | Phase 2 stance |
| --- | --- | --- |
| Answer a call | None of the six roles answers calls. Calls are answered by a customer-owned Vapi/Retell assistant outside iAcquire | Not changed. Not claimed |
| Call back | No outbound voice capability exists | Blocked state, honest copy |
| Text a missed caller | `sales_assistant` is the default conversation owner and one of two reply-capable roles; `appointment_setter` is the other | Recovery texts are sent as the **system** actor on the workspace's recorded policy decision (never impersonating an AI employee), still through `evaluateSend`. If a person owns the conversation, the AI does not send |
| Schedule | `appointment_setter` has `appointment_availability` (read slots) and `appointment_review`, both read-only | Recovery can **route** a case to the Appointment Setter as a work-board item; booking stays a human/approved action |
| Update contacts / scores | No employee capability writes records | The engine (deterministic, server-side) writes the priority; AI employees read it. Overrides are human-only |
| Follow-ups | Existing follow-up sequences (`src/server/messaging/followups.ts`) | Recovery uses the same send gates and cancels on reply/booking |
| Monitor | `operations_manager` `proactive_review` (read-only) and `performance_analyst` `performance_snapshot` | Recovery health and scoring coverage are added as read-only findings later (2E) |

## 4. Risks found that shape the design

* **Production safety:** all provider write switches are off, the scheduler has never run, and queued sends end `blocked/provider_not_enabled`. So a recovery message can never be reported as "sent" unless the message row says so; the case reads the message status, it does not assume.
* **Race surface:** a person can take over, a customer can reply or book while an action waits. Every action re-reads current state under a row lock and carries the conversation's `ownership_version` fence.
* **Late/out-of-order provider events:** `recordVoiceEvent` can move a record from `completed` to a later final status. The case is recomputed from the latest record after every call-record change and reclassified (a call answered afterwards cancels recovery).
* **Number identity:** caller ID can be spoofed, so a number is never treated as verified identity; unknown callers are never merged into an existing contact.
* **Migration prefixes:** collisions are the known CLI-ledger hazard; `tests/migration-prefixes.test.ts` plus the rehearsal script across all refs guard it.
* **Premium boundary:** Core CRM (cases, scoring, Inbox display) is free. Only native Studio **workflows** that use the new triggers/steps are premium, through the existing `assertStudioEntitled`.

## 5. Build plan

* **2A** migrations `0085` / `0086` + rollbacks, pure state machine, pure eligibility, scoring model types, tests.
* **2B** classification, case sync from call records, conversation/CRM timeline integration, policy, recovery actions through existing services, scheduler job, analytics queries.
* **2C** deterministic scoring engine, bounded AI signal extraction, versioned history, overrides, reassessment queue and job.
* **2D** Inbox and CRM surfaces, settings, dashboard.
* **2E** Studio triggers/steps, work-board read-only findings, notifications.
* **2F** hardening: race/tenant/security tests, performance probe, browser QA, migration + rollback rehearsal, evidence report.
