# Phase 2 architecture: Missed-Call Recovery and AI Lead Scoring

Branch `feat/phase2-lead-conversion`, cut from `origin/master` `447249d`. Migrations `0085_missed_call_recovery` and `0086_lead_scoring` (rollbacks in `supabase/rollbacks/`). Nothing here has been applied to a hosted database, pushed or deployed.

## 1. Reused, not rebuilt

| Need | Reused |
| --- | --- |
| Call ingestion, signature checks, tenant resolution, replay protection | `src/server/integrations/voice/*`, `recordVoiceEvent` (`src/server/crm/calls.ts`). Unchanged except one call at the end of the transaction that syncs the case |
| Sending a text or email | `queueOutbound` / `evaluateSend` / `dispatchDue` (`src/server/messaging/send.ts`): consent, opt-out and bounce suppression, quiet hours, business hours, platform follow-up spacing and 30-day cap, credits and budget, provider switch, channel readiness, ownership fence |
| Inbox | `conversations`, `conversation_events`, `recordConversationEvent`, `inbox_rollout` (the new cards appear only where the new Inbox is on; the previous Inbox is untouched) |
| CRM timeline, tasks, notifications, events | `recordActivity`, `createTaskInTx`, `notifyOrgRoles`, `emitEvent` (`crm_events` outbox with dedupe keys and depth limit) |
| Scheduler | the one registry in `src/server/ops/tick.ts` (`SCHEDULER_JOBS_ONLY`, `worker_job_runs` heartbeats). Two jobs added: `missedCallRecovery`, `leadScoreReassessment` |
| Automation Studio | the one workflow engine: triggers and steps added to `src/lib/crm/workflow/spec.ts`, executors in `src/server/crm/workflows/executors.ts`, same validation, permission derivation, approval and plan rules |
| AI Workforce | the six existing roles and `WORKFORCE_CAPABILITIES`; two read-only reviews added. No new employee, no new tool, no write capability |
| LLM | `llmComplete` / `resolveLlmConfig`, wrapped (schema, limit, retry, metering) in `src/server/lead-scoring/ai.ts` |

## 2. Missed-call recovery

```
provider webhook -> recordVoiceEvent (crm_call_records, verified, deduped)
                         |  same transaction, own savepoint
                         v
                 syncCaseForCall  --classify-->  missed_call_cases (+ missed_call_case_calls)
                         |                         one OPEN case per caller number; late corrections reclassify
                         v                         contact link: exact E.164, exactly one match
   contact timeline (call.missed) + conversation event + crm_events "call.missed"
                         |
   scheduler job missedCallRecovery (lease, per-workspace fairness)  -> processCase
        reconcile -> facts -> evaluateEligibility -> close | team actions | message path
```

* **Classification** (`src/lib/missed-calls/classify.ts`, pure): inbound only; ring/no answer, voicemail, busy, cancelled (hung up), failed to connect, and a connected call that ended within the workspace's threshold with nothing said. Answered calls, transfers, outbound calls and calls with no reported duration are never missed.
* **State machine** (`src/lib/missed-calls/state.ts`): detected, awaiting_eligibility, eligible, suppressed, scheduled, in_progress, awaiting_response, recovered, completed_without_recovery, failed, canceled. Only the listed moves exist; every move is versioned and written to `missed_call_case_events` with its actor; `failed` can be reopened by a person only.
* **Eligibility** (`src/lib/missed-calls/eligibility.ts`, pure): settles (callback answered, caller replied, appointment, expiry, call answered later), then the team part (policy on, class in scope, not paused), then the text (policy activated, number present, contact present, nobody has messaged, a person does not own the conversation, attempt cap, channel connected, address, opt-out, consent, delay, spacing, quiet hours, business hours). `evaluateSend` repeats consent, opt-out, ownership, quiet hours and spacing when the text is queued and again when it is dispatched.
* **Actions** are rows with a unique dedupe key (`mcc:<case>:<kind>[:n]`): owner, call-back task, notice, deal timeline note, text or draft, Appointment Setter routing, blocked AI call-back, follow-up reminder. `sent` is written only when the message row says `sent`/`delivered`.
* **Human control** (`src/server/missed-calls/ops.ts`): assign, pause, resume, escalate, close (recovered / no recovery / not a real missed call), retry a failed case, approve or discard a drafted text. Each names the owner version the person saw; a stale request is refused.
* **Policy** (`missed_call_policies`): off by default; modes team-only, draft for approval, send automatically; `activated_at` set by a person (and cleared by any change to wording, channels, mode or consent basis) before any text is drafted; a consent rule of "recorded only" by default, with an acknowledged "caller consent" option that writes its basis on the consent record.
* **Not built, and why:** a Twilio Voice / GoHighLevel call adapter (the platform has none: the Twilio route carries SMS only), and any AI call-back (no outbound-call credential exists, so the step is recorded as `blocked: no_outbound_call_capability` and never completes).

## 3. Lead scoring

* **Engine** (`src/lib/lead-scoring/engine.ts`, pure and deterministic): enabled criteria give a fraction of their weight or "unknown"; `score = earned / (known + 0.5 x unknown)`; fewer than the profile's minimum of known qualifying signals gives **Insufficient data** with no score; a team-set status of unqualified or inactive caps the score at 20.
* **Criteria** (`criteria.ts`): intent, engagement, urgency, completeness, penalties, and fit criteria (service area, source, tags, deal size, custom fields) that are off until configured. Presets for real estate, home services and agency/B2B are starting points the workspace edits. Fields about who a person is (age, gender, race, religion, health ...) are refused when saved and skipped if stored.
* **Model use** (`ai-signals.ts`, `ai.ts`): optional, off by default. The model sees only redacted message text; it fills a closed form; every non-unknown answer must cite a message; anything else is discarded; points come from rules. Daily limit, two tries, token estimates metered in `lead_score_usage`.
* **Service** (`service.ts`): three phases (read, extract, write under a contact lock). A snapshot older than the current one is discarded; identical inputs write nothing; a person's override is never written over; events `lead.score_updated`, `lead.label_changed`, `lead.became_hot`, `lead.qualification_completed` carry dedupe keys.
* **Queue** (`queue.ts`): one row per contact, debounced (10 minutes, never later than an hour after the first change), leased, five tries then stop with the reason, a daily ceiling per workspace. Events from scoring and recovery (`lead.*`, `recovery.*`) never enqueue.
* **Surfaces**: contact page card, Inbox card and list chips, contacts list column / filter / sort, smart-list filters, settings page, Studio triggers and steps, Workforce review.
* **Not stored in `contacts.lead_score`:** that column stays a hand-entered number. The engine writes `contacts.priority_*`.

## 4. Data model

`missed_call_policies`, `missed_call_cases`, `missed_call_case_calls`, `missed_call_actions`, `missed_call_case_events`; `lead_scoring_profiles`, `lead_score_assessments`, `lead_score_overrides`, `lead_score_queue`, `lead_score_usage`; six columns on `contacts`. Every table is tenant-keyed with composite foreign keys, has row-level security (`SELECT` through `app.permitted_orgs`, no write grant to the application role) and an append-only history where one is kept. Two notification kinds are added by reading the live constraint (never a copied list).
