# Unified Conversations Inbox: Phase 0 repository audit

Audited 2026-10-22 on `master` @ `22c68c2` (worktree `.data/wt-unified-inbox`, branch `feat/unified-inbox`). Everything below was read in code or
run in a test; where something was **not** verified it says so. The checkout at the repo root has 51 uncommitted entries from other work
(AI workforce, Hermes cutover, scripts); none of this work touches that tree.

**Headline.** An omnichannel inbox already exists and is substantial: tenant-scoped `contacts`/`conversations`/`conversation_messages`
(migration 0019), three native transports plus GoHighLevel, consent and suppression enforcement, AI ownership/takeover/escalation, an approval
flow for AI drafts, delivery-status reconciliation and a 1,000-line inbox workspace. So this phase is **extend and harden**, not build. The
brief's names for AI employees (Receptionist, Customer Service, Lead Qualifier) do not exist in the repo; the six real roles are used.

## 1. Inventory

### Already implemented and working (covered by tests, mocked providers)

| Area | Evidence |
| --- | --- |
| Tenant model, RLS on every messaging table, read-only grants for the app role (writes by trusted server code only) | `0019_messaging.sql`; `app.can_view_conversation` (`inbox.view` + `inbox.view_all` or owner/assignee) |
| Canonical contact + verified identities, exact-identifier matching (E.164 / lower-case email, never by name), merge ledger | `contact_identities` unique `(org_id, kind, value)`; `resolveContact`, `mergeContacts`, `findDuplicateCandidates` |
| Conversations / messages with provider ids, direction, author kind, delivery status, dedupe key, attempt count | `conversation_messages`; unique `(org_id, dedupe_key)`, unique `(provider, provider_message_id)` |
| Idempotent inbound (provider message id → dedupe key), webhook replay ledger, signature verification | `ingestInbound`, `webhook_receipts`, per-provider webhook routes (`/api/webhooks/{ghl,twilio,resend,meta-whatsapp,retell,vapi}`) |
| Provider-confirmed delivery only: `delivered` is set only by a provider event, status never moves backward, duplicate events ignored | `applyDeliveryEvent*`, `message_delivery_events` |
| The single outbound rule chain (consent, suppression, WhatsApp window/template, quiet hours, credits, AI owner + gate + escalation) run at queue time **and again at dispatch** | `evaluateSend`, `dispatchMessage` |
| Human takeover stops AI: owner flips to human, queued AI messages blocked, follow-ups cancelled; resume is explicit, permissioned and safety-checked | `giveToHuman`, `takeOverConversation`, `resumeAi` |
| Owner-first escalation with timers, per-category authorization, first-claim-wins locking | `human_escalations`, `createEscalation`, `claimEscalation` |
| AI draft approval (also in the Approval Center), AI disclosure, booking via real calendar only | `approveDraft`, `respondToConversation`, `requestBooking` |
| Opt-out keywords, consent history (append-only), suppression list | `detectOptKeyword`, `contact_consent_events` (immutable trigger) |
| Pagination of long threads (newest 200 + "load older"), delivery-event detail per message | `getConversationDetail`, `getOlderMessages` |
| Canned replies / templates with token filling and gap detection | `src/server/crm/message-templates.ts`, `CannedReplyPicker` |
| Notifications with dedupe keys, per-person kind hiding, owner/manager fan-out | `notifyUser`, `notifyOrgRoles`, `message_failed`, `escalation_*` |
| Workflow engine (CRM events outbox → triggers → steps), premium gating by entitlement, loop depth limit (`MAX_EVENT_DEPTH = 8`) | `src/server/crm/workflows/*`, `src/lib/crm/workflow/spec.ts`; trigger `conversation.message_received` |
| Calls: Retell/Vapi/manual records with status, duration, summary, consent-gated recording/transcript refs; `call.completed` trigger | `src/server/crm/calls.ts`, `crm_call_records` |
| Calendar/appointments for a contact (`listContactAppointments`), tasks (`listTasks`), notes (`listNotes`), deals (`listOpportunities`) | `src/server/crm/*`, all take a permission-checked `CrmActor` |
| Offboarding export of conversations, messages, delivery events | `src/server/offboarding/export.ts` allowlist |

### Partially implemented

| Area | Gap |
| --- | --- |
| Conversation status | Only `open / snoozed / closed`; nothing is called Waiting, Resolved or Archived. `snoozed` is never set by any code. |
| "Pause AI" | Only "take over" (owner becomes a person). No way to pause AI replies while keeping the AI employee attached, and no per-conversation AI pause. |
| AI employee on a conversation | `ai_agent_id` exists but is set once, always to the `sales_assistant`; it cannot be changed, and nothing says which roles may handle customer conversations. |
| Stale-AI protection | At dispatch `evaluateSend` rejects an AI send when `owner_kind <> 'ai'`. It compares the kind, not a revision, so *AI → person → AI* between queue and send is invisible. `respondToConversation` checks owner kind and the same inbound id after generation, not the ownership revision. |
| Real-time | `router.refresh()` every 15 s while the tab is visible (skipped while typing). No change feed, no cheap poll, no cross-tab sync. |
| Lifecycle history | `conversation_ownership_events` records owner moves only. Assignment, status, priority and notes are not on the thread's timeline (assignment is audit-logged only). |
| Failed outbound | Visible with its reason and delivery events, but **no retry**: the only automatic retry is bounded and for retryable errors. A person cannot re-send. |
| CRM context panel | Shows stage, source, identities, consent, follow-up, assignment, memories, activity. Missing: company, tags, lead status, owner, opportunity, appointments, tasks, notes, calls, links into the CRM. |
| Search | Name, last-message preview, identity value. Not message bodies. |
| Notifications | Escalation, blocked, failed, website-enquiry exist. No "assigned to you", "unassigned inquiry", "awaiting reply" or AI-help-needed beyond escalation. |
| Workflow triggers | Only `conversation.message_received`. No assigned / resolved / urgent / handoff / idle triggers. |
| Retention | Contact erasure exists (`redactContact`, `eraseContact`); there is no per-conversation retention setting. |

### Missing

* Channels beyond SMS/WhatsApp/Email: **Website AI chat** has no widget, endpoint or table (website forms create a conversation with a system note,
  `src/server/websites/forms.ts`; no chat). **Social** channels: nothing. **Phone calls** are in `crm_call_records`, not in conversations.
* Attachments: inbound attachments are described in the text only ("Attachments aren't shown in the inbox yet", `ingest.ts`); `attachments jsonb`
  is unused. Outbound attachments: none.
* AI-assisted inbox features: no summary, no suggested reply, no next steps, no "why human review is needed" beyond the escalation summary.
* Bulk actions, saved views, sort options.
* A defined list of which AI roles may work customer conversations.
* Automation Studio **actions** on a conversation (assign, set status, note on the conversation).

### Duplicated or conflicting

* Seven code paths insert into `conversations` (`ingest`, `followups`, `outreach`, `campaigns/job`, `crm/message-templates`, `crm/reviews`,
  `websites/forms`), and each makes its own choice of owner/agent. Only `ingest`/`followups`/`outreach`/`campaigns` attach the sales assistant.
  *Not merged in this phase*: touching all seven would risk production behaviour for little gain; new invariants are enforced in the database
  and in the shared evaluators instead.
* Two "notes": conversation internal notes (`conversation_messages`, direction `internal`) vs CRM record notes (`record_notes`). They stay
  separate (different visibility rules); the inbox panel reads both, labelled.
* Two escalation entry points (`createEscalation` from ingest and from the responder). One implementation, no conflict.

### Reusable infrastructure (reused, not rebuilt)

Transports and `evaluateSend`/`queueOutbound`/`dispatchMessage`; `ingestInbound`; `handoff.ts`; `approvals/service`; `notifications.ts`; the CRM
event outbox + workflow engine + Automation Studio entitlement (`src/server/automation-studio/entitlement.ts`); `CrmActor` services for tasks,
notes, deals, appointments, calls; `consumeRateLimit`; `recordAudit`; `tests/support/messaging.ts` fixtures; the design system in
`src/components/ui`.

## 2. Security and production risks found

| # | Severity | Finding |
| --- | --- | --- |
| 1 | **High** | **No live provider has ever been exercised.** `docs/messaging-providers.md`: "Nothing here has been exercised against a live provider account: every test mocks fetch." `docs/verification-status.md`: GHL sending "blocked awaiting a GHL test location". Every transport is behind a `*_WRITES_ENABLED` kill switch that defaults off. |
| 2 | Medium | Stale-AI fence compares `owner_kind`, not a revision (see above). Window is small but real: generation takes up to 60 s. |
| 3 | Medium | Delivery failures after an *unconfirmed* send are recorded as plain `failed/provider_error`. A naive retry could double-message a customer, which is why no retry existed. A retry must tell the person when the first attempt may have been delivered. |
| 4 | Medium | `markConversationRead` marks read **for everyone** (one shared `unread_count`). Two staff viewing the same thread clear each other's unread state. Documented, not changed (per-user read state is a larger model change). |
| 5 | Low | Inbound attachments are dropped (only a count is noted). No storage, no malware scanning, so none is claimed. |
| 6 | Low | `listConversations` caps at 200 rows with no cursor; busy workspaces cannot page beyond that. |
| 7 | Info | Migration numbering: master has an untracked `0081`; other worktrees stop at 0081. This phase uses **0082**. Renumber at merge if another branch lands 0082 first (`tests/workforce-migration-renumber.test.ts` guards collisions). |

## 3. Decisions (what this phase builds, and what it deliberately does not)

1. **No new messaging tables for messages or contacts.** `conversations` / `conversation_messages` stay the single source of truth. New
   columns are additive; the only new table is an append-only `conversation_events` for lifecycle history (also the workflow trigger source).
2. **Eligible AI roles for customer conversations** are `sales_assistant` (default; the only one the responder is wired for today) and
   `appointment_setter` (booking conversations; it already books through the real calendar). The other four roles are internal analysts or
   researchers with no customer-facing capability in `WORKFORCE_CAPABILITIES`, so they are refused server-side, not hidden in the UI.
3. **Pause AI is separate from takeover.** A pause keeps the employee attached and stops its replies; a takeover makes a person the owner.
   Both bump `ownership_version`; AI-authored sends carry the version they were prepared under, and dispatch refuses a stale one.
4. **Status model stays `open | closed` plus `archived_at`.** The UI says Open / Waiting / Resolved / Archived. *Waiting* is derived (we
   spoke last, so we are waiting on the customer), because a stored "waiting" flag rots.
5. **Real-time = a cheap authorized poll,** not websockets: an indexed `revision` per conversation and a `/api/inbox/sync` that returns what
   changed since a cursor (with overlap, so out-of-order commits are harmless). Correctness over cleverness.
6. **Honest channel state.** Each channel is Connected only when `messaging_channels.enabled` (which the database only allows after a passed
   capability test), Needs attention when its recent sends fail, otherwise Not connected / Not available. Website chat and social are
   **Not available**; nothing pretends otherwise.
7. **AI assistance never sends.** Suggested replies, summaries and next steps are generated on demand, shown as drafts, and stored (if at all)
   as drafts/insights. Customer text is fenced as data in the prompt. Sending still goes through the same rule chain and a person.
8. **Automation:** new CRM event types and one conversation step kind on the existing engine; nothing parallel.

Out of scope / blocked, stated now so nobody assumes otherwise: live provider verification (needs credentials and the owner's approval),
Website AI chat widget, social channels, attachment storage, per-user read state, production migration.
