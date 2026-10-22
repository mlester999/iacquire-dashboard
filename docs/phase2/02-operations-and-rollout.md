# Phase 2 operations, readiness and rollout

Status (2026-10-22): migrations 0085 and 0086 are applied to production and the code is deployed from `origin/master` `74dcf64`, **dormant**: no workspace policy is on, the scheduler has never run, and no provider switch was touched (see the release record in `05-release-readiness.md`). Everything below about switching it on is still a plan; no real customer was used as a test recipient.

## 1. What changes when this is deployed (and what does not)

| Area | After deploy, before anyone configures anything |
| --- | --- |
| Database | Two migrations (0085, 0086) add tables and six `contacts` columns; no data is moved. Existing behaviour is unchanged. |
| Missed calls | A missed inbound call from a connected Vapi/Retell assistant (or one a person logs) creates a case and an entry on the contact's timeline. **No contact is created, no conversation is created or changed, no task, notice or text is produced** while the workspace policy is off, which is the default. |
| Lead scoring | Scoring is on by default for display (it only reads CRM data and writes the new `priority_*` columns). Contacts are scored when something about them changes **and the scheduler runs**; without the scheduler nothing is scored. No message is sent and no existing field is changed. The language model is **off** and is only asked when a workspace turns it on. |
| Inbox | The missed-call and priority cards/chips appear only in workspaces whose new Inbox is on (none is, today). The previous Inbox is untouched. |
| Automation Studio | New triggers and steps exist; no workflow uses them until someone builds one. Workflows built in the CRM screens need no plan; workflows built in Studio still need the Studio plan. |
| Providers | No provider setting, switch, credential or webhook is touched. |

## 2. Switches and dependencies (all verified in this tree)

| Switch | Effect | State today |
| --- | --- | --- |
| `SCHEDULER_ENABLED` + `CRON_SECRET` + `POST /api/internal/tick` | Nothing recovers or re-scores until the scheduler runs | Never run in production |
| `SCHEDULER_JOBS_ONLY` | Staged activation: name `missedCallRecovery`, `leadScoreReassessment`, `crmEventDispatch`, `messagesDispatched` (and `notificationEmails` if wanted) to run only those | Unset |
| `TWILIO_WRITES_ENABLED` (and the other provider write switches) | While off, a queued text is turned into a final `blocked / provider_not_enabled`, and the case shows **failed** with a plain reason. It is never shown as sent. | Off |
| Workspace policy (`missed_call_policies.enabled`, `mode`, `activated_at`) | Whether anything happens, and whether a text may be drafted or sent | Off |
| Workspace scoring profile (`ai_extraction_enabled`) | Whether a model may read messages | Off |
| `INBOX_DISABLED` | Hides the new Inbox (and so its cards) everywhere | Unchanged |

The recovery job is idempotent and safe to run every minute; the scoring job likewise. Staged activation order that adds risk one step at a time:

1. `SCHEDULER_JOBS_ONLY=crmEventDispatch,leadScoreReassessment`: contacts get scores; nothing is sent.
2. Add `missedCallRecovery` with every workspace's policy off: cases are watched and expired.
3. Turn one internal workspace's policy on in **team-only** mode: it gets call-back tasks and in-app notices, nothing is sent to callers.
4. Only then consider "draft for approval", and last "send automatically", for that workspace, after its text channel, consent rules and sending switch have been checked together with the founder.

## 3. Readiness checklist (what the screens report today, from real state)

Recovery settings show, for the workspace: policy enabled, someone hears about every call, each chosen channel set up and enabled (blocking for texts), the platform's sending switch (informational), the wording is acceptable (blocking), the consent rule is confirmed (blocking), business hours set, and whether the recovery worker ran in the last 30 minutes (informational, reported as **Pending** when the scheduler is off). Activation is refused while a blocking item is unmet, and cleared by any later change to wording, channels, mode or consent rule.

## 4. Founder decisions and external setup

1. Whether any workspace should send missed-call texts at all, and under which consent rule for each country/state where its callers live (we ship "only people with consent on record"; "anyone who phoned us" is an acknowledged opt-in that records its basis). **This needs your legal review.** Automated texts to people who only phoned a business are regulated differently by country and state.
2. Whether the language model may read customer messages for lead signals (off by default; redaction and limits are in place; a real model has **not** been evaluated here).
3. Voice-adapter coverage: Vapi and Retell only. A plain business line (Twilio Voice, GoHighLevel call webhooks) is not connected; adding an adapter is a separate piece of work that needs the provider's webhook contract and credentials.
4. Outbound AI call-backs: need an outbound-calling credential and a verified provider contract. Until then the step is recorded as blocked.
5. Approval to apply 0085 and 0086 to the hosted database (after the dry run and backup described below), and to start the scheduler in the stages above.

## 5. Migration and rollback plan

* Apply order: `0085` then `0086`, after `0083` (enforced by `MIGRATION_PREREQUISITES`). `0084_restricted_hermes_provisioner` lives on `codex/client-ai-onboarding` and `codex/hermes-gha-acceptance`; whichever order it lands in relative to 0085 and 0086, the resulting schema is identical (rehearsed: 11,507 schema facts compared three ways).
* Rehearsal (embedded Postgres only, no network, no environment file): `node scripts/rehearse-phase2-migrations.mjs --report .data/phase2-migration-rehearsal.json`. It checks that 0085 and 0086 are unique across all 63 local and remote branches, the order against 0084, that 400 contacts / conversations / calls and 25 notifications are untouched by up, down and up again, that both rollbacks refuse while data exists and return the schema to exactly what it was when it does not, and a row-level-security probe as the application role (each owner sees only their workspace, a stranger and a request with no user see nothing, an update is refused).
* Before applying: a verified `pg_dump` (the Phase 1 procedure in `docs/unified-inbox/rollout-plan.md`), then `npm run db:migrate -- --dry-run`, then `npm run db:migrate -- --only 0085_missed_call_recovery`, then `-- --only 0086_lead_scoring`, one at a time, from the main checkout whose `.env` points at the intended database, each result checked before the next.
* Rollback: `supabase/rollbacks/0086_lead_scoring.down.sql` then `0085_missed_call_recovery.down.sql`. Each refuses to run if recovery history, assessments, an override, a customised profile or a contact priority exists, so data is never dropped by accident; stop the two scheduler jobs first. After a rollback delete the ledger row so the migration can run again.
* Code rollback: redeploying the previous commit is safe at any time. The new tables are unused by older code, the six `contacts` columns are nullable, and the notification constraint keeps the two new kinds.
