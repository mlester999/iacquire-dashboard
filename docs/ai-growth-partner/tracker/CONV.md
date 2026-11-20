# CONV — Permanent AI Growth Partner conversation

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). Historical audit at commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`; follow-up implementation snapshot `1f56c025`.

Summary (read-only audit of branch claude/ai-growth-partner-completion @ 6e4a4b7e; I read code and tests only, I ran nothing):

Local follow-up evidence as of implementation commit `1f56c025` (2026-11-16): B07 adds an approval-gated route for “this approved prospect” and a task preview/confirm flow. Focused service-path tests use synthetic PGlite tenants; no live model, hosted database or provider was used.

- **What exists and is real:** one canonical, tenant-shared thread per workspace (migration 0121: partial unique index on `chat_conversations.growth_partner_id`, composite FK to the one verified `growth_partner` runtime, RLS policies, retention-exempt). History, search, Business Brain retrieval, app-owned memory, goals and a long ladder of deterministic chat actions (CRM contact/opportunity, calendar, booking preview+confirm, schedule preview+confirm, targeting, preferences, outbound pause, research job, read-only capability jobs) are DB-backed and have PGlite tests (tests/ai-growth-partner-conversation.test.ts, tests/workforce-chat-e2e.test.ts, tests/ai-growth-partner-unified-context-e2e.test.ts).
- **How the chat actually works:** `PermanentGrowthPartnerConversation` -> `POST /api/chat/send` -> `sendChatMessage` (src/server/chat/service.ts:2573). It is NOT an LLM tool-calling agent. A fixed regex "intent ladder" (lines 2784-3245) either executes a reviewed application service, dispatches a read-only work job, refuses, or asks a clarification. Anything that matches nothing goes to Hermes as a plain text run with a read-only evidence snapshot in the prompt (`prepareEmployeeEvidence`). The model has no application tools unless the dormant client business MCP tier (`HERMES_CLIENT_BUSINESS_MCP_ENABLED`, per-workspace `client_business_tools`, both off by default) is switched on.
- **Real vs simulated:** all model replies in tests come from `tests/support/mock-hermes` or the harness fixture model (synthetic-only). No real-model or live-provider evidence exists for this conversation; the docs say so themselves.
- **Biggest gaps:** (1) job-based answers never come back into the conversation (only an acknowledgement; no link; results go to Work Board/notifications), so "Show me my appointments for tomorrow" and "Show which tasks need my approval" start real jobs that do not answer the question; (2) 4 of the 10 example requests have no executing path at all (follow-up task, reporting schedule, weekly activities, single-prospect follow-up draft is actively refused); (3) the shared thread is not permission-scoped per message and prior answers are fed to the model as history for any member (members without `invoices.view` or `activity.view` can read answers an owner's question built from receivables/activity data); (4) the permanent UI has no stop/regenerate/retry, no polling or stream re-attach after a refresh, replaces loaded pages on every refresh, and the cursor loses messages that share a millisecond; (5) the model's own "what can be started from this chat" section is hard-coded empty for the Growth Partner (stale comment, employee-evidence.ts:887-889), so the model tells users nothing can be done although the router can do a lot.

### Ten example requests: exact code path and verdict

| # | Request | Exact code path today | Verdict |
|---|---|---|---|
| 1 | "Show me my new leads today." | sendChatMessage -> no intent matches (`parseWorkforceChatAssignment` GP block, src/lib/workforce-chat-assignment.ts:40-81, has no plain "leads" pattern; only "hot/promising leads", "lead pipeline", "lead generation") -> Hermes text run (service.ts:3388) with the `leads` snapshot section (employee-evidence.ts:638-731: last 10 researched leads with saved timestamp + `addedLast7Days`) | TEXT_ONLY (grounded model answer; no "today" filter; no CRM/inbox/website new-lead source) |
| 2 | "Which leads should we follow up with?" | No parser match (no review verb, no "hot leads" phrase; guardrail does not fire) -> Hermes text run with snapshot (leads, pipeline oldest-in-stage deals). `lead_priority_review` capability exists but only starts for "hot leads / lead priorities / promising leads" (assignment.ts:56) | TEXT_ONLY (model opinion from a partial snapshot; no score-based ranking executed) |
| 3 | "Create a CRM contact for this approved prospect." | `parseWorkforceChatCrmIntent` (src/lib/workforce-chat-crm-intent.ts:71): explicit create matches, but "this approved prospect" is not caught by `PRONOUN_NAME` (line 11, needs exactly "this prospect") and there is no email/phone -> `clarification` ("include their full name and an email address or phone") via `handleChatCrmIntent` (service.ts:1263). With an explicit name + email/phone it really calls `createContact` (duplicate-checked, verified read-back, audit via CRM service). No link to approved researched leads; that flow (approval -> `crm_lead_import` job, approvals/service.ts:73-130) exists only in the Leads UI | PARTIAL (real write for explicit details; this phrasing = clarification only; approved-lead import not reachable from chat) |
| 4 | "Show me my appointments for tomorrow." | Assignment parser GP (assignment.ts:50): "show" + "appointments" -> `dispatchCapabilityJob` `appointment_review` (service.ts:3202-3245) -> `runAppointmentReviewJob` (src/server/workforce/appointment-review.ts) which only emits risk findings (awaiting approval >24h, needs-manual, stuck requests, unassigned). No date filter, no appointment list. The job's report is not posted to chat; the user only sees "I'll review persisted appointment requests..." | PARTIAL (real DB job, but wrong output and no answer returned to the conversation) |
| 5 | "Schedule a follow-up task for Friday." | No refusal (no appointment noun), `parseWorkforceChatBookingIntent` returns none (no appointment word/timestamp), schedule parser needs "every/each" or "daily/weekly" (workforce-chat-schedule-intent.ts:38), assignment parser has no "schedule" review verb -> Hermes text run whose snapshot says nothing can be started (employee-evidence.ts:889-907). Building blocks exist (`createTaskInTx` src/server/crm/tasks.ts:67; MCP tool `create_task` handlers.ts:325 as an approval proposal, flag-gated off) but nothing connects chat to them | MISSING |
| 6 | "What do you know about my business?" | No intent -> `buildRunInstructions(..., memoryQuery=userContent)` (workforce/service.ts:959) -> `insertActiveBusinessBrain` (989) -> `retrieveBusinessBrainFacts` (src/lib/ai-growth-partner.ts:189; 6 always-retrieved identity facts + lexical/topic-group matches, max 24 facts / 8,000 chars, verified/client_confirmed only) + memory/goals/legacy knowledge in `composeRunInstructions` (897) -> Hermes text run | TEXT_ONLY (real retrieval into the prompt; the reply is a model summary; no deterministic dossier, provenance or "not yet confirmed" listing) |
| 7 | "Change your reporting schedule." | `parseWorkforceChatPreferencesIntent` needs tone/language/reply words (workforce-chat-preferences-intent.ts:11-12) -> none; schedule parser: no recurrence words; only `LEAD_SCHEDULE_CHANGE` ("lead research/prospecting schedule", schedule-intent.ts:43) can update an existing schedule -> falls to Hermes text run. Daily/weekly briefing prefs live in notification preferences (`parseProactivePrefs`, `runProactiveBriefings` reports.ts:820, gated by WORKFORCE_BRIEFINGS_ENABLED, off by default) and are not editable from chat | TEXT_ONLY for this phrase (real preview->confirm schedule engine exists but only for lead-research or an explicit "every <day> at <time>, review X" request) |
| 8 | "Show the activities you completed this week." | No parser match -> Hermes text run. Snapshot has only `work_board` counts with `completedToday` (employee-evidence.ts:740-757; work-board.ts:37) and the attention list; no week-scoped completed-activity feed, no audit/Activity read | MISSING (no data source in the prompt or tool layer; any answer would be model text from partial facts) |
| 9 | "Prepare a follow-up message for this prospect." | `workforceChatRefusal` (src/lib/workforce-chat-guardrail.ts:49-58): "message" + "prospect" matches `external_outreach` -> refusal text persisted (service.ts:3127-3137). The only drafting path (`pipeline_followup_drafts`) needs pipeline words and handles <=5 stale-opportunity template drafts in AI-owned conversations (pipeline-followup-drafts.ts, fixed neutral text) | MISSING (a draft-only request is refused as outreach; no per-prospect draft capability) |
| 10 | "Show which tasks need my approval." | Assignment parser GP (assignment.ts:41): "show" + "tasks" -> `proactive_review` job (needs `activity.view`) -> `proactive-review.ts` `pending_approvals` check only counts approvals waiting >24h; no per-item list; result not posted to chat. The Approval Center list and the snapshot's `operations` section (approval titles) are bypassed | PARTIAL (real job, wrong shape, no answer in the conversation) |

<a id="gp-conv-01"></a>
### GP-CONV-01 — One primary conversation per workspace, stable identity, tenant isolation

- **Requirement:** One primary conversation per workspace, stable identity, tenant isolation (directive §5)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0121_ai_growth_partner_conversation.sql`, `src/server/workforce/service.ts:1489`, `src/server/ai-growth-partner/service.ts:715`, `src/server/ai-growth-partner/service.ts:1234`, `src/server/chat/service.ts:2622`, `src/app/(portal)/growth-partner/conversation/page.tsx`
- **Test coverage:** tests/ai-growth-partner-conversation.test.ts (shared by two owners, second insert rejected, other tenant sees 0 rows, retention exempt, survives starter deletion, role-key triggers); tests/workforce-chat-e2e.test.ts:169,818 (retained-role requests land in the one thread, zero role-private conversations); tests/client-legacy-chat-redirect.test.ts; tests/ai-growth-partner-fixture-acceptance.test.ts (harness provisioning). They do not prove: creation when the health check passes before `current_version` exists, or when a soft-deleted canonical row exists.
- **Real or simulated behavior:** Real Postgres/PGlite unique index, composite FK, RLS and triggers; no model involved.
- **Missing dependencies:** none.
- **Remaining work:** Add idempotent ensureGrowthPartnerConversation (today the thread is created only as a side effect of a passing runHealthCheck, workforce/service.ts:1489-1503); handle a soft-deleted canonical row that blocks re-creation (unique index includes deleted rows, insert is on conflict do nothing); add tests for both. | Skeptic adds: Create the thread when the Business Brain is activated after a passing health check (workforce/service.ts:1489-1496 requires current_version is not null and no other code inserts the thread). Soft-delete protection is defence-in-depth only.
- **Verification evidence:** read migration, creation SQL, lookup queries and tests. Prior recorded runs (docs, 2026-11-09): full suite 900 files / 13,828 tests pass; hosted pinned-Hermes run #87/#89 synthetic. I did not run anything.
  - *Skeptic review: Remaining-work item about a soft-deleted canonical row is overstated: no app code or app-role RLS path can soft-delete it. The real gap is activation ordering.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Exactly one non-deleted canonical thread per client workspace with a Growth Partner, created idempotently at provisioning, same id across restarts, unreachable by other tenants, DB tests cover creation edge cases.

<a id="gp-conv-02"></a>
### GP-CONV-02 — History persistence, safe pagination, search, recovery after refresh and restart

- **Requirement:** History persistence, safe pagination, search, recovery after refresh and restart (directive §5)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/service.ts:1234`, `src/server/ai-growth-partner/service.ts:1320`, `src/app/actions/ai-growth-partner-conversation.ts:34`, `src/components/growth-partner/permanent-conversation.tsx:152`, `src/components/growth-partner/permanent-conversation.tsx:163`, `src/server/chat/service.ts:3827`, `src/server/chat/hub.ts`, `src/app/api/chat/runs/[runId]/stream/route.ts`
- **Test coverage:** tests/ai-growth-partner-conversation.test.ts (first page, search, tenant scoping); scripts/ai-growth-partner-restart-acceptance.ts (file-backed PGlite closed and reopened in a fresh process: thread, marker message, search, memory, goals, job, schedule recover; app DB only, not Hermes); tests/growth-partner-permanent-conversation-ui.test.tsx (3 cases, actions mocked, `hasMore:false`). Not proven: any page with more than 60 messages, cursor boundaries, refresh while a run is streaming, restart while a run is streaming.
- **Real or simulated behavior:** Real DB queries and server actions; UI tests use mocked actions with hasMore=false; restart script covers stored data only, not in-flight runs or Hermes.
- **Missing dependencies:** none.
- **Remaining work:** Keyset cursor (created_at,id) instead of ms-precision timestamp (messages in the same ms as the boundary are skipped, no tie-break); merge pages by id on refresh instead of replacing with latest 60; add useEffect polling or stream re-attach for streaming messages; fix lingering 'streaming' after restart (reconcileOrphanedRuns waits timeout+60s); render errorCode friendly text; add Stop and Try again controls in the permanent UI; tests with >60 messages, equal timestamps, refresh mid-stream. | Skeptic adds: Do not shorten or boot-sweep reconcileOrphanedRuns: it runs on every cold serverless function and would kill live runs on other instances; use a heartbeat or lease column instead. The UI already polls after a send (up to 120 x 1.5 s) and refreshes after the stream; the gap is reload mid-run and SSE drop.
- **Verification evidence:** read code and tests. The docs' "recovery after restart" claim is backed only by the PGlite restart script for stored data; no evidence exists for in-flight run recovery.
  - *Skeptic review: One suggested fix is unsafe in a multi-instance deployment and the 'no polling' claim applies only after a page reload.*
  - *Baseline: 2 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Paging over any number of messages loses/duplicates none; a refresh or restart mid-run converges to final or failed state without manual action; Stop and Try again work; tests cover all cases.

<a id="gp-conv-03"></a>
### GP-CONV-03 — Send path: authentication, permission checks, rate limits, readiness, tenant isolation

- **Requirement:** Send path: authentication, permission checks, rate limits, readiness, tenant isolation (directive §5)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/app/api/chat/send/route.ts:22`, `src/server/chat/service.ts:2573`, `src/server/chat/service.ts:2411`, `src/server/chat/service.ts:2622`, `src/server/chat/service.ts:2697`
- **Test coverage:** tests/chat.test.ts (readiness, inventory drift, duplicate send, other tenants cannot read, stop, retryable failure); tests/workforce-chat-e2e.test.ts (cross-tenant contact/opportunity names resolve to "not found", foreign records unchanged at lines 583-592, 649-676); tests/chat-regenerate-guards.test.ts:218 (foreign message id); tests/client-legacy-chat-redirect.test.ts. Not proven: concurrent sends by two members, SSE path through the real route, and `agents.use` removal mid-session.
- **Real or simulated behavior:** Real server path and DB; Hermes is tests/support/mock-hermes.
- **Missing dependencies:** none.
- **Remaining work:** Route-level tests for /api/chat/send (origin, role enum, size, foreign conversationId); two-member concurrency test; document or fix single-process dependence of the in-memory stream hub.
- **Verification evidence:** read route and service. Docs claim synthetic tenant and isolation coverage; consistent with the tests I read.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every send is authenticated, same-origin, permission checked, rate limited and bound to the single tenant thread; tests prove cross-tenant and cross-role denial for send, regenerate and stream.

<a id="gp-conv-04"></a>
### GP-CONV-04 — Permission-aware context retrieval and the shared-thread privacy gap

- **Requirement:** Permission-aware context retrieval and the shared-thread privacy gap (directive §5)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/employee-evidence.ts:1049`, `src/server/workforce/employee-evidence.ts:884`, `src/server/workforce/employee-evidence.ts:1013`, `src/server/chat/service.ts:2706`, `src/server/ai-growth-partner/service.ts:1234`
- **Test coverage:** tests/employee-chat-evidence.test.ts (role-scoped sections, no side effects, audit without contents); tests/ai-growth-partner-unified-context-e2e.test.ts. No test asserts that one member's privileged answer is hidden from another member.
- **Real or simulated behavior:** Snapshot is real member-scoped DB reads; thread history and prior replies are not filtered per reader; model is mocked.
- **Missing dependencies:** product decision on the thread's privacy model (see remaining work).
- **Remaining work:** Hide or redact messages (page, search, model history) whose evidence sections the reader lacks permission for (e.g. invoices.view, activity.view are owner/admin-limited); replace the hard-coded empty chatRequestsSection for the Growth Partner (employee-evidence.ts:887-889, stale comment) with the real router list; add restricted-member tests.
- **Verification evidence:** read; the UI sentence "Conversation history is shared with members who have AI access" (permanent-conversation.tsx:313) discloses the shared visibility but does not make it permission-safe.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A reply can never expose data the reader lacks permission for in the page, search or model history; the model is told truthfully what can be started; tests prove both.

<a id="gp-conv-05"></a>
### GP-CONV-05 — Business Brain, approved memory, goals and legacy-knowledge retrieval

- **Requirement:** Business Brain, approved memory, goals and legacy-knowledge retrieval (directive §5)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/service.ts:897`, `src/server/workforce/service.ts:989`, `src/lib/ai-growth-partner.ts:189`, `src/server/ai-growth-partner/memory.ts:249`, `src/lib/ai-growth-partner-memory.ts:22`, `src/server/chat/service.ts:2784`, `src/server/ai-growth-partner/goals.ts`
- **Test coverage:** tests/ai-growth-partner-unified-context-e2e.test.ts (active Brain, knowledge, goals, memory in run instructions, tenant boundaries); tests/workforce-chat-e2e.test.ts:1885 (reviewed Brain version used in next run); tests/ai-growth-partner-memory.test.ts; tests/ai-growth-partner-fixture-acceptance.test.ts:377 (Remember/Forget without a Hermes call); tests/workforce-chat-business-brain-e2e.test.ts. They prove the prompt carries the right facts, not that a real model uses them.
- **Real or simulated behavior:** Real DB reads and deterministic lexical ranking into the prompt; answers are model text (mock in tests).
- **Missing dependencies:** real model run for behaviour evidence (see GP-CONV-21).
- **Remaining work:** No model-suggested memory flow (memory is owner/admin typed only); add regression eval for questions whose words do not overlap Brain keys; add deterministic 'what the Partner knows' answer (GP-CONV-15).
- **Verification evidence:** read code and tests; docs say Hermes-native memory is separate and real-model memory behaviour is untested; I agree.
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Verified retrieval of confirmed Brain facts, memory and goals into every run for a fixed question set; owner/admin-only audited memory writes; real-model run shows facts are used.

<a id="gp-conv-06"></a>
### GP-CONV-06 — Action architecture, tool permission checks and clear action results

- **Requirement:** Action architecture, tool permission checks and clear action results (directive §5)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/chat/service.ts:2784-3245`, `src/server/chat/service.ts:881`, `src/server/chat/service.ts:896`, `src/lib/employee-tool-policy.ts:27`, `src/server/workforce/hermes-client-business-mcp.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts:27`, `src/server/crm/agent-tools/catalog.ts`
- **Test coverage:** tests/workforce-chat-e2e.test.ts (each real action with permissions, ability switch, duplicates, audit, idempotency); tests/hermes-client-business-mcp-*.test.ts (25 files: auth, gate, turn, proposals, limits, pinned runtime with synthetic inference); tests/chat-ability-router.test.ts; tests/workforce-chat-*-intent.test.ts (parsers). Not proven: any free-form phrasing outside the parsers, or an MCP-driven chat in a real deployment.
- **Real or simulated behavior:** Deterministic regex intent ladder calling real services (real DB); default model has no app tools; client business MCP tier is dormant (env flag and per-workspace switch off) and only synthetic-model tested.
- **Missing dependencies:** production flags for the client business MCP tier and a real model for tool selection (founder/ops decision; EXTERNALLY relevant only for the live proof).
- **Remaining work:** Router only understands narrow exact phrasings; widen deterministic read intents (leads today, appointments by date, approvals to review, completed activities), optionally add an intent-classifier step mapping to the same reviewed handlers, and add read tools for leads/appointments/tasks/approvals/activity to CLIENT_BUSINESS_TOOL_MATRIX; keep writes behind preview+confirm or approvals.
- **Verification evidence:** read the ladder end to end. Prior docs claim chat actions "use existing workspace services"; true for the listed actions.
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Each supported action reachable by natural phrasing, executed through the application service under the member's permissions, returns a verified result with an evidence marker; unsupported requests say so with a pointer; DB-backed tests.

<a id="gp-conv-07"></a>
### GP-CONV-07 — Safe retries and prevention of duplicate side effects

- **Requirement:** Safe retries and prevention of duplicate side effects (directive §5)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/chat/service.ts:2691`, `src/server/chat/service.ts:1384`, `src/server/chat/service.ts:3057`, `src/server/chat/service.ts:3179`, `src/server/leads/service.ts:130`, `src/server/chat/service.ts:455`, `src/components/growth-partner/permanent-conversation.tsx:171`
- **Test coverage:** tests/chat.test.ts:314 (duplicate send blocked); tests/workforce-chat-e2e.test.ts (previews idempotently saved, opportunity idempotency, handoff provenance rollback, draft reuse on retry); tests/chat-regenerate-guards.test.ts.
- **Real or simulated behavior:** Real DB unique constraint and handler checks.
- **Missing dependencies:** none.
- **Remaining work:** Return the original message/reply ids on a repeated clientMessageId instead of a conflict error and reconcile in the UI; key research requests by user message id; write a failure notice when a handler throws after the user message is stored; key pending previews per user instead of one slot per shared conversation; tests for each. | Skeptic adds: Duplicate-send check is select-then-insert, so two concurrent identical clientMessageId sends can raise a raw unique violation (23505) instead of the friendly conflict; catch it and return the original ids. Also see missed requirement on concurrent runs.
- **Verification evidence:** read. No evidence of a double-send race test.
  - *Skeptic review: Race in the idempotency check that the audit did not mention.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Replaying any send, confirm or approval with the same key yields exactly one side effect and the same visible result; two members' previews never collide.

<a id="gp-conv-08"></a>
### GP-CONV-08 — Honest outcome reporting, error handling and audit logging

- **Requirement:** Honest outcome reporting, error handling and audit logging (directive §5)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/evidence-class.ts`, `src/components/chat/evidence-chip.tsx`, `src/lib/action-claims.ts:83`, `src/server/chat/service.ts:3470`, `src/server/chat/service.ts:810`, `src/server/workforce/employee-evidence.ts:1120`, `src/components/growth-partner/permanent-conversation.tsx:358`
- **Test coverage:** tests/chat-evidence-marker.test.ts (markers for every reply class, every insert stamps a marker, static source check); tests/chat-regenerate-guards.test.ts:253-304 (claim correction + audit, no text stored); tests/employee-chat-evidence.test.ts:169-179 (audit without contents, no side effects).
- **Real or simulated behavior:** Real server composition and DB audit rows; the action-claim guard is a regex over model text.
- **Missing dependencies:** none.
- **Remaining work:** Extend claim verbs (drafted, queued, started, non-English) with an eval; render error_code reasons in the permanent UI (failed rows show 'No message text was saved.'); fix the model being told nothing can be started; consider an audit row per accepted user turn (ids only). | Skeptic adds: Claim guard runs only post-hoc on completed runs: raw deltas stream to the viewer, 1.5 s partial snapshots are persisted unguarded, and cancelled/failed rows keep uncorrected model text. Apply the correction (or hide text) for every terminal status and for persisted snapshots.
- **Verification evidence:** read. No UI path found that claims an external send/booking; deterministic handlers only say "booked/saved" after a read-back (see `handleChatCrmIntent` 1315-1323, schedule 778-785).
  - *Skeptic review: The 'UI never claims an action succeeded' guarantee does not cover the live stream, a mid-run refresh, or stopped/failed runs on the model path.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No reply, banner or acknowledgement states an external or record-changing action succeeded without a backing ledger row; every refusal/failure shows a plain reason; audit rows exist per action class without message text.

<a id="gp-conv-09"></a>
### GP-CONV-09 — Results of asynchronous work return to the conversation

- **Requirement:** Results of asynchronous work return to the conversation (directive §5)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/chat/service.ts:3202`, `src/server/chat/service.ts:3061`, `src/server/leads/research-job.ts:120`, `src/server/workforce/reports.ts:772`, `src/server/workforce/reports.ts:488`, `src/server/approvals/service.ts:80`, `src/components/growth-partner/permanent-conversation.tsx`
- **Test coverage:** tests/workforce-chat-e2e.test.ts (job created, settles `completed`); tests/ai-growth-partner-fixture-acceptance.test.ts:522 (research report lands in the thread). Nothing asserts a review job's findings appear in the conversation, because they do not.
- **Real or simulated behavior:** Real jobs and reports; only research results, briefings (off by default) and lead-import notices are written back to the thread; read-only review results go to notifications/Work Board only.
- **Missing dependencies:** none.
- **Remaining work:** On job completion insert an idempotent notice message (client_message_id job-result:<jobId>, record_retrieval marker, Work Board link) for all 13 non-research capabilities; add the link to the acknowledgement; render workJobId in the permanent UI and poll while a linked job runs; tests.
- **Verification evidence:** read; grep shows `insert into chat_messages` only in the places listed above.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every chat-started job posts its outcome (success, no finding, blocked, failed with reason) into the same thread exactly once with a link, visible without manual reload.

<a id="gp-conv-10"></a>
### GP-CONV-10 — Request 1: Show me my new leads today (verdict TEXT_ONLY)

- **Requirement:** Request 1: Show me my new leads today (verdict TEXT_ONLY) (directive §5 request 1)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-assignment.ts:40`, `src/server/chat/service.ts:3388`, `src/server/workforce/employee-evidence.ts:638`, `src/server/leads/service.ts`
- **Test coverage:** none for this phrase; tests/employee-chat-evidence.test.ts:163 covers the snapshot only.
- **Real or simulated behavior:** Model text over a real read-only snapshot (last 10 researched leads, addedLast7Days); no executed 'today' query; no CRM/inbox new-lead source.
- **Missing dependencies:** none.
- **Remaining work:** Add a deterministic read intent 'new leads (today|yesterday|this week)' in the workspace timezone answered synchronously by a new listLeadsSince(ctx, window) combining researched leads, new CRM contacts and new inbound conversations under leads.view/contacts.view; record_retrieval marker reply with links; DB tests across timezones and restricted members.
- **Verification evidence:** read code; verdict TEXT_ONLY today (grounded but approximate, not "today").
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Reply lists exactly the leads created in the requested local-day window that the member may see, with counts, source and links, or says none.

<a id="gp-conv-11"></a>
### GP-CONV-11 — Request 2: Which leads should we follow up with (verdict TEXT_ONLY)

- **Requirement:** Request 2: Which leads should we follow up with (verdict TEXT_ONLY) (directive §5 request 2)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-assignment.ts:56`, `src/server/workforce/lead-priority-review.ts`, `src/server/lead-scoring`, `src/server/workforce/employee-evidence.ts:638`, `src/server/workforce/employee-evidence.ts:214`
- **Test coverage:** tests/workforce-chat-assignment.test.ts covers the narrow phrases; nothing for this question.
- **Real or simulated behavior:** Model opinion from a partial snapshot; the lead_priority_review capability exists but only triggers on 'hot leads / lead priorities / promising leads'.
- **Missing dependencies:** none.
- **Remaining work:** Map follow-up/priority questions to a synchronous ranked answer using lead scores, last-contact dates and open deals (reuse lead-priority-review queries) with data-backed reasons and no outreach; tests.
- **Verification evidence:** read; verdict TEXT_ONLY (model opinion from partial facts).
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Reply is a ranked, tenant- and permission-scoped list with stated data-backed reasons; next steps offered, not performed.

<a id="gp-conv-12"></a>
### GP-CONV-12 — Request 3: Create a CRM contact for this approved prospect (verdict PARTIAL)

- **Requirement:** Request 3: Create a CRM contact for this approved prospect (verdict PARTIAL) (directive §5 request 3)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-crm-intent.ts`, `src/server/chat/service.ts`, `src/server/approvals/service.ts`, `src/server/leads/service.ts`, `supabase/migrations/0129_research_lead_crm_imports.sql`
- **Test coverage:** `tests/workforce-chat-crm-intent.test.ts` and `tests/workforce-chat-e2e.test.ts` cover demonstrative references, one approved evidence-backed lead, pending-review and duplicate refusals, permission and ability denial, approval link, and repeated request reuse.
- **Real or simulated behavior:** The deterministic chat route resolves one eligible lead from the current thread's latest research report, otherwise only a single eligible approved lead in the workspace. It submits through the approval-gated import service, does not create a literal demonstrative-name contact, checks role and ability, and reuses an existing approval. The tests exercise the app service with synthetic PGlite tenants; no model or hosted database was used.
- **Missing dependencies:** none.
- **Remaining work:** Verify the phrasing and approval outcome in the real-model acceptance harness and rehearse the migration on a hosted non-production database. The thread/global fallback intentionally asks for clarification when the lead is ambiguous.
- **Verification evidence:** focused CRM-intent and E2E files passed locally; evidence remains synthetic-only. No live-model, hosted-database or provider verification is claimed.
  - *Skeptic review: Real wrong-write path through the executing handler that the audit did not find; row stays PARTIAL but the defect is concrete.*
  - *Historical baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Exactly one CRM record is created or queued for exactly one identified approved lead with duplicate protection, permission checks, audit and a verified link.

<a id="gp-conv-13"></a>
### GP-CONV-13 — Request 4: Show me my appointments for tomorrow (verdict PARTIAL)

- **Requirement:** Request 4: Show me my appointments for tomorrow (verdict PARTIAL) (directive §5 request 4)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-assignment.ts:50`, `src/server/chat/service.ts:3202`, `src/server/workforce/appointment-review.ts`, `src/server/workforce/employee-evidence.ts:470`
- **Test coverage:** tests/workforce-chat-e2e.test.ts:1480 ("a safe appointment review"); no test of date-scoped listing.
- **Real or simulated behavior:** Real queued appointment_review job that emits risk findings (no date filter, no list); report not posted back to chat; only an acknowledgement is shown.
- **Missing dependencies:** none.
- **Remaining work:** Add date-window parsing (tomorrow, weekday, ISO date) in workspace timezone and answer synchronously from listSchedule under appointments.view with a link; keep appointment_review for risk reviews; timezone-edge and restricted-member tests.
- **Verification evidence:** read; verdict PARTIAL: the job is real but does not answer.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Reply lists tomorrow's appointments (or says none) in the workspace timezone, or states the calendar is not set up, with no job indirection.

<a id="gp-conv-14"></a>
### GP-CONV-14 — Request 5: Schedule a follow-up task for Friday (verdict MISSING)

- **Requirement:** Request 5: Schedule a follow-up task for Friday (verdict MISSING) (directive §5 request 5)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/tasks.ts:67`, `src/server/crm/agent-tools/handlers.ts:325`, `src/lib/employee-tool-policy.ts`, `src/lib/workforce-chat-schedule-intent.ts:38`, `src/server/chat/service.ts:3388`
- **Test coverage:** `tests/workforce-chat-task-intent.test.ts` and `tests/workforce-chat-e2e.test.ts` cover date parsing, preview without writes, explicit confirmation, cancellation, repeat confirmation, contact ambiguity, permission checks and audit. `tests/employee-tool-policy.test.ts` and `tests/employee-ability-enforcement.test.ts` cover the Partner-only proposal policy and ability gate.
- **Real or simulated behavior:** The chat service deterministically creates a preview, confirms it through `createTaskInTx`, records the task and audit together, and links to the task. Contact matching requires an exact unique match; ambiguous matches ask for clarification. Tests use synthetic PGlite tenants; no model or hosted database was used.
- **Missing dependencies:** none.
- **Remaining work:** Verify natural-language date resolution and the preview/confirm exchange in the real-model acceptance harness; rehearse migration 0138 on a hosted non-production database. Numeric dates without an unambiguous interpretation and ambiguous contacts intentionally request clarification.
- **Verification evidence:** focused intent, E2E and policy suites passed locally; evidence remains synthetic-only. No live-model, hosted-database or provider verification is claimed.
  - *Skeptic review changed the status from PARTIAL to NOT_STARTED: Status PARTIAL contradicts the auditor's own verdict (MISSING, no chat path executes anything). Unwired building blocks (createTaskInTx, dormant MCP create_task) do not make the request path partial; consistent with rows 17 and 18.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Member sees a preview with the resolved date, confirms, exactly one task exists with permission checks, audit and a verified link; ambiguous dates are asked about, never guessed.

<a id="gp-conv-15"></a>
### GP-CONV-15 — Request 6: What do you know about my business (verdict TEXT_ONLY, grounded)

- **Requirement:** Request 6: What do you know about my business (verdict TEXT_ONLY, grounded) (directive §5 request 6)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/service.ts:959`, `src/server/workforce/service.ts:989`, `src/lib/ai-growth-partner.ts:189`, `src/server/ai-growth-partner/memory.ts:249`, `src/server/ai-growth-partner/service.ts:473`
- **Test coverage:** tests/ai-growth-partner-unified-context-e2e.test.ts and tests/workforce-chat-e2e.test.ts:1885 prove the prompt content; no answer-quality test.
- **Real or simulated behavior:** Real Brain/memory/goal retrieval into the prompt (max 24 facts, 8,000 chars, verified/client_confirmed only); the reply is model text; tests prove prompt content only.
- **Missing dependencies:** real model for answer quality (GP-CONV-21).
- **Remaining work:** Add a deterministic 'business summary' intent rendering confirmed facts by section with provenance and listing draft/unknown gaps from getGrowthPartnerControlState; tests.
- **Verification evidence:** read; verdict TEXT_ONLY but properly grounded.
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: For the exact request 'What do you know about my business?' lexical retrieval matches only on 'know' and 'business', so beyond the six always-retrieved identity facts the model sees a vocabulary-dependent subset. Infrastructure row GP-CONV-05 is fine; the request row is not a faithful 'what do you know' answer.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Reply lists only verified/client-confirmed facts with source, marks gaps, links to the Brain editor, independent of lexical retrieval or model.

<a id="gp-conv-16"></a>
### GP-CONV-16 — Request 7: Change your reporting schedule (verdict TEXT_ONLY for this phrase)

- **Requirement:** Request 7: Change your reporting schedule (verdict TEXT_ONLY for this phrase) (directive §5 request 7)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-schedule-intent.ts:183`, `src/lib/workforce-chat-schedule-intent.ts:43`, `src/server/chat/service.ts:446`, `src/server/workforce/schedules.ts`, `src/lib/proactive.ts`, `src/server/workforce/reports.ts:820`
- **Test coverage:** tests/workforce-chat-e2e.test.ts:200,1227,1294,1421,1453 (preview, confirm, cancel, conflict, timezone expiry for schedules); tests/workforce-chat-schedule-intent.test.ts. Nothing for briefing preferences via chat.
- **Real or simulated behavior:** Preview->confirm schedule engine is real (DB, audit, conflict/timezone guards) but only for lead research updates or explicit 'every <day> at <time>' review proposals; this phrase and briefing preferences are not reachable from chat; briefings are off by default.
- **Missing dependencies:** founder decision whether briefings are in scope for launch and when WORKFORCE_BRIEFINGS_ENABLED is turned on.
- **Remaining work:** Add a chat intent for daily briefing/weekly summary time and on/off with preview+confirm saving through the notification-preferences service; for a bare 'change your reporting schedule' read and show current settings then ask what to change; tests.
- **Verification evidence:** read; verdict TEXT_ONLY for this exact phrase.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Partner shows the current reporting schedule, accepts a clear change, previews, saves after confirmation with audit, and the next briefing honours it.

<a id="gp-conv-17"></a>
### GP-CONV-17 — Request 8: Show the activities you completed this week (verdict MISSING)

- **Requirement:** Request 8: Show the activities you completed this week (verdict MISSING) (directive §5 request 8)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/employee-evidence.ts:740`, `src/server/workforce/work-board.ts:37`, `src/server/workforce/jobs.ts`, `src/app/(portal)/activity/page.tsx`
- **Test coverage:** none.
- **Real or simulated behavior:** No data source in the prompt or tool layer beyond completedToday count and an attention list; any reply is model text.
- **Missing dependencies:** none.
- **Remaining work:** Add a read intent for completed activities by window answered synchronously from ai_work_jobs (completed in the workspace-timezone week), reports and approved writes with ledger links under activity.view/agents.use; add completedThisWeek to the work-board summary for the model path; tests.
- **Verification evidence:** read; verdict MISSING.
- **Definition of done:** Reply lists jobs and actions actually completed in the window with timestamps and links, or says none; never invents activity.

<a id="gp-conv-18"></a>
### GP-CONV-18 — Request 9: Prepare a follow-up message for this prospect (verdict MISSING, refused)

- **Requirement:** Request 9: Prepare a follow-up message for this prospect (verdict MISSING, refused) (directive §5 request 9)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-guardrail.ts:49`, `src/server/chat/service.ts:3127`, `src/server/workforce/pipeline-followup-drafts.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts:41`
- **Test coverage:** tests/chat.test.ts:356 and tests/workforce-chat-e2e.test.ts (refusals); no test of a draft-only request.
- **Real or simulated behavior:** Static refusal text: the external_outreach guard matches 'message' + 'prospect' so a draft-only request is refused; the only drafting capability is a batch of <=5 fixed-template drafts for stale opportunities in AI-owned conversations.
- **Missing dependencies:** founder decision on whether single-prospect AI-written drafts (unsent, owner-approved) are in scope; legal/consent rules for outreach.
- **Remaining work:** Exempt draft-only phrasing from external_outreach; add an intent resolving one named/current prospect that writes an unsent Inbox draft via the existing draft service (drafts.create ability, inbox.reply) and replies with a link plus 'nothing was sent'; sending stays approval-gated; tests including no-prospect clarification.
- **Verification evidence:** read; verdict MISSING (refused).
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Exactly one unsent draft exists linked to the prospect and visible for review; the reply says nothing was sent; 'send it' remains refused or approval-gated.

<a id="gp-conv-19"></a>
### GP-CONV-19 — Request 10: Show which tasks need my approval (verdict PARTIAL)

- **Requirement:** Request 10: Show which tasks need my approval (verdict PARTIAL) (directive §5 request 10)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-assignment.ts:41`, `src/server/workforce/proactive-review.ts:79`, `src/server/workforce/employee-evidence.ts:782`, `src/server/approvals/service.ts`
- **Test coverage:** tests/workforce-chat-e2e.test.ts:844 (operations review dispatch); nothing for approvals-for-me.
- **Real or simulated behavior:** Real queued proactive_review job (needs activity.view) that only counts approvals waiting more than one day; no per-item list; result not posted to chat; the Approval Center and the snapshot's approval titles are bypassed.
- **Missing dependencies:** none.
- **Remaining work:** Add a synchronous 'approvals waiting for me' intent using the approvals service with the member's decide rights, listing title, risk, age, requester and links; keep proactive_review for 'review operations'; tests.
- **Verification evidence:** read; verdict PARTIAL.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Reply lists exactly the pending approvals this member can decide, with links, or says none.

<a id="gp-conv-20"></a>
### GP-CONV-20 — Automated acceptance harness for the ten example requests and conversation behaviours

- **Requirement:** Automated acceptance harness for the ten example requests and conversation behaviours (directive §5)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `tests/workforce-chat-e2e.test.ts`, `tests/support/mock-hermes.ts`
- **Test coverage:** none exists for the ten phrases (grep of tests/ found none).
- **Real or simulated behavior:** To be built on PGlite plus mock Hermes; no existing test sends any of the ten phrases.
- **Missing dependencies:** none.
- **Remaining work:** Add tests/growth-partner-conversation-acceptance.test.ts sending each of the ten requests as owner and as a restricted member asserting path taken, DB effects, evidence markers, no false action claim and tenant isolation; plus >60-message pagination, refresh-during-stream, restart recovery and duplicate-send replay.
- **Verification evidence:** none yet.
- **Definition of done:** Suite runs in CI and fails on any regression of the verdicts in CONV.md.

<a id="gp-conv-21"></a>
### GP-CONV-21 — Live Hermes and real-model proof of the permanent conversation

- **Requirement:** Live Hermes and real-model proof of the permanent conversation (directive §5)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `docs/ai-growth-partner/implementation-status.md`, `scripts/ai-growth-partner-restart-acceptance.ts`, `tests/hermes-client-business-mcp-pinned-runtime.test.ts`
- **Test coverage:** synthetic only.
- **Real or simulated behavior:** All existing evidence is synthetic (mock Hermes or harness fixture model; hosted runs #87/#89).
- **Missing dependencies:** paid model provider credentials and approved spend, a production-class Hermes gateway, the founder's approval to enable the client business MCP flags in a test workspace.
- **Remaining work:** After GP-CONV-20, run the ten requests once against a real model in a disposable tenant and record transcripts, tool calls and cost; verify refresh/restart recovery with a real streamed run.
- **Verification evidence:** docs only; I found nothing contradicting their statement.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A recorded real-model run of all ten requests showing grounded answers, no unbacked action claims and correct permission behaviour.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Serialise or guard concurrent runs in the shared Growth Partner thread", "directiveRef": "§5 (stable conversation, safe retries, duplicate side effects)", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "sendChatMessage has no 'reply already streaming' check, so two members can start concurrent Hermes runs on the same hermes_session_id; the second run's history excludes the first's streaming reply (status = 'complete' filter, chat/service.ts:2706-2712). Reject or queue a send while a run in the thread is queued/running, with a two-member test."}
- {"title": "Author attribution in model history for the multi-member thread", "directiveRef": "§5 (permission-aware context, tenant-shared thread)", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "History passed to the model is role+content only (chat/service.ts:2706-2714), so the model cannot tell which member asked what or under whose permissions a prior answer was built. Label user turns by author and drop assistant turns whose evidence sections the current reader lacks (links to GP-CONV-04)."}
- {"title": "Shared-thread run visibility and stop for non-originating members", "directiveRef": "§5 (recovery after refresh, clear action results)", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "Stream subscribe and abort are owner-only (src/server/chat/hub.ts), so another member sees 'In progress' for a colleague's run with no stream and no way to stop it. Let any agents.use member of the tenant attach read-only and owner/admin stop; test it."}
- {"title": "Audit trail for routing decisions and accepted turns", "directiveRef": "§5 (audit logging)", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "No audit row exists for an accepted user turn or for a deterministic route that only clarifies or refuses without a service-level audit; record ids and route kind (never text) so each of the ten request classes is traceable."}
