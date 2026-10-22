# Phase 2 security, privacy and compliance review

Scope: missed-call recovery, lead scoring and their integration. Method: read of every new query and entry point, plus the tests named in the right-hand column. "Simulated" means the embedded database with recorder/stub providers; no real provider was contacted and no real customer was a recipient.

| # | Control | How it holds | Evidence |
| --- | --- | --- | --- |
| 1 | **Tenant isolation, data** | Every table has `org_id`, composite foreign keys that include it, row-level security on reads (`app.permitted_orgs`), no write grant to the application role. Every server query names the workspace; the worker can be limited to one workspace. | `missed-call-ops` (another workspace cannot read a case by id, list or conversation), `lead-scoring-service` ("shows the same contact's priority only inside its workspace", "a worker for one workspace never claims another's"), `rls-initplan-guard`, `crm-migrations` |
| 2 | **Tenant isolation, calls** | A provider call id already recorded for another workspace is refused (existing); a case is keyed to the workspace and the caller number; the same number in two workspaces gives two cases. | `missed-call-detection` ("a different workspace's missed call ... is its own case") |
| 3 | **Authorization** | Reading needs `calls.view` / `contacts.view`; working a case, approving a draft, or setting a priority needs `contacts.edit`; policy needs `messaging.configure`; scoring settings `pipelines.manage`. Agency support sessions inherit their read-only/write mode. A stale owner version is refused. | `missed-call-ops`, `lead-scoring-service`, `phase2-ui` (controls hidden) |
| 4 | **Webhook authenticity** | Unchanged and relied on: per-workspace credential, constant-time comparison, replay receipts. Recovery runs only on a stored, verified call record. | existing `crm-calls` suite (passes) |
| 5 | **Credentials** | None added. The recovery policy and scoring profile hold no secret. | n/a |
| 6 | **Consent, opt-out, quiet hours** | Texts go only through `evaluateSend` (twice: queue and dispatch). Default consent rule is "on record only". The caller-consent option needs a recorded acknowledgement and writes its basis on the consent record; revoked consent and suppression always win. A STOP reply is an opt-out, not a "recovery". | `missed-call-recovery-engine` (no consent, opt-out with the acknowledged basis, quiet hours, business hours, STOP) |
| 7 | **Human takeover** | A person owning the conversation blocks automatic texts at eligibility, at queue time and at dispatch; takeover cancels queued recovery texts; pausing a case stops its queued text. | `missed-call-recovery-engine` ("never texts into a conversation a person owns", "a takeover after the text was queued stops it") |
| 8 | **No unsafe contact merge** | A caller matches a contact only by one exact E.164 number held by exactly one live contact. Two holders match nobody. An unknown caller becomes an *unverified* contact only when the workspace turned recovery on. | `missed-call-detection` |
| 9 | **Idempotency / races** | Unique dedupe keys per action; one open case per caller; row lock per case; leases; three workers at once send one text. | `missed-call-recovery-engine` (concurrency, redelivery) |
| 10 | **Honest outcomes** | A text is `sent` only when the message row says so; blocked or failed delivery ends as failed with the reason; the AI call-back is always `blocked`. | `missed-call-recovery-engine` (provider switch off, provider refusal), `phase2-ui` |
| 11 | **Fair and explainable scoring** | Only authorized CRM data; fields about who a person is cannot be configured and are skipped if stored; every point has a sentence and a record reference; Insufficient data is not Cold; a person's decision is never overwritten and shows beside the rules' own view. | `lead-scoring-engine`, `lead-scoring-service`, `phase2-ui` |
| 12 | **Model risk** | Optional, off by default. Redacted message text only, closed output form, evidence required, no free text kept, no numbers from the model, two tries, daily limit, metered. Hostile message text cannot change the form or the points. | `lead-scoring-engine` (prompt-injection cases), `lead-scoring-service` (failure, limit, retry, off) |
| 13 | **Cost / abuse bounds** | Texts per case <= 5 and the platform's own caps; daily model limit; a daily ceiling on assessments per workspace; manual re-check once a minute per contact; bounded retries then stop. | `lead-scoring-service`, `missed-call-recovery-engine` |
| 14 | **Loops** | `lead.*` and `recovery.*` events never enqueue scoring; unchanged inputs write nothing and emit nothing; Studio's depth limit applies. | `phase2-automation` ("cannot loop"), `lead-scoring-service` |
| 15 | **Privacy of stored text** | Factors, events and actions hold ids, enums and short labels, never message text or numbers; the model's output is stored as enumerations and message ids; drafted wording comes from the workspace's own template; audit entries record field names, not wording. | `lead-scoring-service`, `missed-call-ops` |
| 16 | **Erasure and retention** | See "Erasure and retention" below. | `phase2-privacy` (privacy request, cross-workspace refusal, retention) |
| 17 | **Logs** | Errors log a name and code only; raw errors are printed only when `MCC_DEBUG` is set, never in production mode. | `phase2-privacy` ("what the logs say"), code review (`sync.ts`, `queue.ts`, `engine.ts`) |

## Erasure and retention

**A privacy request for one contact** (`redactContact` in `src/server/messaging/contacts.ts`) calls `eraseRecoveryAndScoring` (`src/server/missed-calls/erasure.ts`) in the same transaction:

* Open recovery cases end as `canceled / privacy_request`, with the move in their history; any drafted or queued text for that person is blocked and its drafted wording removed.
* The caller's number is removed from every case, and from every call record of the contact; the call summary, notes and the recording and transcript references are cleared.
* Every lead assessment, override and queue row of the contact is deleted, and the contact's six priority columns are cleared.
* What stays: the case shell (state, class, times, counts), its history of ids and enums, and the audit trail, so the workspace's numbers and accountability survive. Nothing in them holds message text or a phone number.
* The function is scoped by workspace and contact; asking for a contact in another workspace changes nothing.

**Routine retention** (`purgeExpiredPhase2Records`, scheduler job `phase2Retention`, once a day, bounded per run, oldest first): finished cases with their calls, actions and history 730 days after they finished; assessments that are no longer current after 365 days, always keeping a contact's newest ten and the current one; cleared overrides after 730 days; daily model-usage counters after 400 days. Open cases are never removed by retention.

## Open items a reviewer should know

* **Telemarketing / messaging law** differs by country and state. The product enforces consent, opt-out, quiet hours and business hours, but does not decide what is lawful for a given business and caller location. This needs the founder's legal review before any workspace turns on "send automatically", especially with the "anyone who phoned us" consent option.
* **Caller ID can be spoofed.** A number is never treated as verified identity; the identity row is created unverified.
* **Voice transcripts and recordings** are not read by Phase 2. Only call facts (status, duration, the provider's ended reason) and whether a summary exists are used. The model is never given a call transcript.
* **A real model has not been evaluated.** The extraction path was tested end to end with a stub; its accuracy on real customer messages is unknown.
