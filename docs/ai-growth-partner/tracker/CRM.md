# CRM — CRM end-to-end integration

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). Historical audit at commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`; follow-up implementation snapshot `1f56c025`.

Audit basis: historical read-only reading of the worktree at HEAD 6e4a4b7e (branch claude/ai-growth-partner-completion). Local follow-up evidence as of implementation commit `1f56c025` (2026-11-16): task idempotency and the chat preview/confirm route are now covered by focused synthetic PGlite tests. No hosted database or live model was used.

Summary:
- There are THREE separate ways the Growth Partner touches the CRM, and they have different authorization and idempotency rules: (1) deterministic chat commands (regex intents in src/lib/workforce-chat-crm-intent.ts, executed in src/server/chat/service.ts as the signed-in person via memberActor, immediately, no approval); (2) the client-tier business MCP (src/server/workforce/hermes-client-business-mcp.ts) which exposes 6 read tools and, behind two flags, 6 write PROPOSAL tools that can only become crm_update approvals; (3) the approved-call executor executeApprovedAgentToolCall (src/server/crm/agent-tools/service.ts:455) that replays the stored proposal as the AI agent actor after an owner/admin approves.
- Real vs simulated: everything above is real application code exercised against an embedded PGlite database (tests/crm-agent-tools.test.ts, tests/workforce-chat-e2e.test.ts, tests/growth-partner-crm-ability.test.ts, tests/hermes-client-business-mcp-*.test.ts). No test drives a real model to choose a CRM tool; the pinned-Hermes test (tests/hermes-client-business-mcp-pinned-runtime.test.ts) calls reads through Hermes' own MCP client with NO model, and only asserts that write tools are absent. All evidence is synthetic-tenant, app-functional.
- Operations that exist end to end: find contact, read contact, update contact fields and lead status (proposal + approval), tag/untag, create task (proposal), create/move opportunity (chat direct and proposal), list deals, counts, create contact (chat only).
- Biggest gaps: (a) no AI tool for create contact or add note at all (notes: NOT STARTED; contact create only by an exact-phrase chat command); (b) the model cannot discover a target stage id (no tool lists pipeline stages with ids), so move_opportunity_stage proposals are not usable unaided; (c) create_task has no content-level idempotency and no unique constraint: only the per-run approval key protects it, and the documented keyless autonomous path creates duplicates; (d) approvals stuck in queued/running after a crash are never recovered; (e) authorization parity has specific gaps (create_task ignores contacts.view, create_opportunity checks edit not create, create_task is not gated by the crm.request_update switch, approved changes are absolute overwrites with no staleness check, requester permission is not re-checked at execution, AI reads run as system with no RLS safety net); (f) there is no single failure-mode matrix test (timeout and restart-recovery are untested).
- Docs overstate in places: the Allowed-actions text says crm.request_update cannot edit directly, but chat create/move opportunity (including marking Won/Lost) write immediately under that switch.

<a id="gp-crm-01"></a>
### GP-CRM-01 — Find contact

- **Requirement:** Find contact (directive §11 find contact)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/handlers.ts:174`, `src/server/crm/agent-tools/handlers.ts:194`, `src/server/crm/agent-tools/catalog.ts:59`, `src/server/workforce/hermes-client-business-mcp-policy.ts:25`, `src/server/crm/contacts.ts:141`, `src/server/crm/contacts.ts:650`
- **Test coverage:** tests/crm-agent-tools.test.ts "never reaches another workspace's records" (find returns only own tenant, foreign id 404); tests/hermes-client-business-mcp-permissions.test.ts (person without contacts.view refused before any token); tests/hermes-client-business-mcp-pinned-runtime.test.ts:206-216 (find_contacts through real Hermes MCP client, no model, tenant leak negative). Does not prove: phone/email format matching, archived contacts, ranking, or model-driven use.
- **Real or simulated behavior:** Real read-only SQL against contacts scoped by org from the token or turn; exercised through the real client MCP handler on PGlite. No real model chose the call.
- **Missing dependencies:** none external.
- **Remaining work:** Normalize phone/email query and add exact-identity branch (findByIdentities) to find_contacts; surface archived matches (the create-time duplicate check includes archived, find_contacts does not); add tests for phone/email normalization, archived, 25-row cap.
- **Verification evidence:** own reading of handlers and the tests named above. Recorded (docs/hermes-crm-tools.md) verification is consistent with what the tests show.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A Growth Partner turn asking for a phone or email in any common format returns the matching contact (active or flagged archived) for the right tenant only, proven by a database-backed test.

<a id="gp-crm-02"></a>
### GP-CRM-02 — Create contact from the permanent chat (explicit command)

- **Requirement:** Create contact from the permanent chat (explicit command) (directive §11 create contact)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-chat-crm-intent.ts:71`, `src/server/chat/service.ts:1263`, `src/server/chat/service.ts:2863`, `src/server/crm/contacts.ts:177`, `src/server/crm/contacts.ts:219`, `supabase/migrations/0019_messaging.sql:108`, `src/lib/employee-tool-policy.ts:116`
- **Test coverage:** tests/workforce-chat-e2e.test.ts:474-525 (creates Jamie Lee, second identical command answers "already in the CRM" and leaves one row, ability switch off refuses and creates nothing); tests/workforce-chat-crm-intent.test.ts (parser); tests/employee-ability-enforcement.test.ts and tests/employee-tool-policy.test.ts (switch and policy). Does not prove: concurrent identical commands, a crash between the contact write and the reply, an email that already belongs to a different-named contact, wrong role (viewer without contacts.create) beyond the ability switch, tenant isolation of the name check.
- **Real or simulated behavior:** Real deterministic regex intent then createContact under the signed-in person's memberActor; writes immediately, no approval; no model involved. Duplicate safety is a name-equality pre-check plus the unique identity index.
- **Missing dependencies:** none external.
- **Remaining work:** Key the write to userMessageId/clientMessageId like chat opportunities do; make the name pre-check advisory when email/phone differs; map unique-violation (concurrent double submit) to the duplicate reply; add tests for a role lacking contacts.create, concurrent submit, other-tenant same email. | Skeptic adds: Record AI/chat attribution: the write runs as memberActor (kind member), so createContactInTx stores created_via 'manual' and the crm.contact_created audit row has no agent id or chat message id; only contacts.source carries 'AI Growth Partner chat'. Add via/metadata (conversationId, userMessageId, agentId) to the audit row and timeline entry.
- **Verification evidence:** own reading of service.ts:1263-1331 and the e2e test. Recorded: docs/ai-growth-partner/implementation-status.md line 12 and 275-281 claim duplicate-safe creation; the code supports that for exact identity only.
  - *Skeptic review: Slightly too pessimistic on retry safety, and silent on attribution. A retried chat message carrying the same clientMessageId never reaches the CRM write: chat_messages has a DB unique (conversation_id, client_message_id), so the second attempt is refused before handleChatCrmIntent runs. Remaining-work item 1 (key the write to userMessageId) is therefore low priority; the real duplicate exposure is only a user re-typing the command with a new message id, which the name pre-check and the contact_identities unique (org_id, kind, value) already stop. Status stays IMPLEMENTED_UNVERIFIED.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The command creates exactly one tenant-scoped contact with audit and timeline for the requesting person, never two under any retry or race, refuses for a member lacking contacts.create or a switched-off ability, all proven by DB-backed tests.

<a id="gp-crm-03"></a>
### GP-CRM-03 — Create contact through the shared tool and proposal layer

- **Requirement:** Create contact through the shared tool and proposal layer (directive §11 create contact; tool layer same authorization as human)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/catalog.ts:58`, `src/server/approvals/service.ts:160`, `src/server/leads/service.ts:366`, `src/server/crm/contacts.ts:177`
- **Test coverage:** tests/ai-growth-partner-fixture-acceptance.test.ts and tests/research-source-settings-acceptance.test.tsx cover the lead import (synthetic fixtures). Nothing covers a model-driven create_contact because it does not exist.
- **Real or simulated behavior:** No create_contact tool exists in the 14-tool catalog. Only the approved lead import (system actor, return_existing dedupe, fixtures) creates AI-originated contacts besides the chat command.
- **Missing dependencies:** none external. Needs a product decision that creating a contact from a non-exact chat phrase (for example from a conversation) must be a proposal.
- **Remaining work:** Add create_contact tool (catalog, scope mapped to contacts.create, handler plan() that refuses an existing email/phone before any approval, run() via createContactInTx with idempotency key and return_existing), add to GROWTH_PARTNER_CRM_PROPOSALS behind ability crm.contacts.create and ROLE_SCOPES.growth_partner; add duplicate, cross-turn, tenant and ability tests.
- **Verification evidence:** own reading only.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A model-proposed contact becomes one pending approval, nothing is created before approval, an existing identity returns the existing id, retries or re-approvals never create a second row, and tenant/role/ability denials are tested.

<a id="gp-crm-04"></a>
### GP-CRM-04 — Update contact details (proposal then approved execution)

- **Requirement:** Update contact details (proposal then approved execution) (directive §11 update contact)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/handlers.ts:246`, `src/server/crm/agent-tools/catalog.ts:41`, `src/server/crm/agent-tools/service.ts:319`, `src/server/crm/agent-tools/service.ts:455`, `src/server/workforce/hermes-client-business-mcp.ts:226`, `src/server/workforce/hermes-client-business-mcp-policy.ts:49`, `src/server/crm/contacts.ts:244`
- **Test coverage:** tests/crm-agent-tools.test.ts (approval required, autonomous, GHL-managed refused 409, tampered args, pause, gone record, double approve runs once); tests/growth-partner-crm-ability.test.ts:165 (real client MCP API: switch off creates no approval or token, switch on creates a pending approval without changing the contact, switch turned off before approval blocks execution with an audit denial); tests/hermes-client-business-mcp-proposals.test.ts:167 (appointment_setter, sales_assistant, crm_manager: pending, forced, 72h, requester recorded). Does not prove: Growth Partner role through the full proposals matrix (the matrix test iterates the six retained roles, not growth_partner), real-model use.
- **Real or simulated behavior:** Real: client tier is proposal-only (forceApprovalWrites) into a crm_update approval, executed after approval as the agent actor through the human updateContact service. Internal path can run autonomously. No real model.
- **Missing dependencies:** none external.
- **Remaining work:** Record contact version in the approval and refuse stale execution (updateContact supports expectedVersion; handlers.ts:260 passes none); add the growth_partner role to the proposals matrix test; decide whether a chat update command is wanted.
- **Verification evidence:** own reading; recorded in docs/ai-growth-partner/implementation-status.md line 87 (CRM change control, 0132).
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A Growth Partner update proposal changes nothing until approval, applies exactly once as the agent with the person as requester, is refused as stale if the contact version moved, and growth_partner is in the matrix test.

<a id="gp-crm-05"></a>
### GP-CRM-05 — Change permitted lead stages (contact lead status and deal pipeline stage)

- **Requirement:** Change permitted lead stages (contact lead status and deal pipeline stage) (directive §11 change permitted lead stages)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/crm/types.ts:29`, `src/server/crm/agent-tools/handlers.ts:246`, `src/server/crm/agent-tools/handlers.ts:385`, `src/server/crm/opportunities.ts:160`, `src/server/chat/service.ts:1405`, `src/server/workforce/hermes-client-business-mcp-policy.ts:49`
- **Test coverage:** tests/crm-agent-tools.test.ts:372 (Growth Partner proposes a pipeline move, approval, audit with approved true); :338 (won needs approval even autonomous, reopen refused); tests/workforce-chat-e2e.test.ts:626-760 (chat move: foreign tenant not found, audit actor, repeat is no-op, lost reason required, lost recorded). Does not prove: lead-status transition rules (none exist), stale stage at approval time.
- **Real or simulated behavior:** Real. Deal stage: chat command moves immediately as the person (expectedVersion checked); tool path is a proposal and won/lost always needs a person; reopen refused. Contact lead status: any of 7 enum values via update_contact proposal; no transition rules.
- **Missing dependencies:** product decision: what "permitted" lead-status transitions are (for example forbidding the AI from setting `customer`).
- **Remaining work:** Define and enforce permitted lead-status transitions in update_contact plan(); fix stage-id discovery (GP-CRM-06); add expectedVersion/stage staleness check to move_opportunity_stage execution; reconcile chat direct Won/Lost close with the tool rule that won/lost always needs approval (or document it).
- **Verification evidence:** own reading of the cited tests; both paths are database-backed.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Documented transition rules enforced server-side for lead status and deal stage, every change attributed to a person or approved request, stale or closed records refused, and the model can name a valid stage.

<a id="gp-crm-06"></a>
### GP-CRM-06 — View lead pipeline (deals, stages, counts)

- **Requirement:** View lead pipeline (deals, stages, counts) (directive §11 view lead pipeline)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/handlers.ts:607`, `src/server/crm/agent-tools/handlers.ts:570`, `src/server/crm/agent-tools/handlers.ts:194`, `src/server/workforce/employee-evidence.ts:224`, `src/server/workforce/pipeline-review.ts:5`, `src/server/crm/agent-tools/catalog.ts:100`
- **Test coverage:** tests/client-business-list-opportunities.test.ts; tests/crm-agent-tools-onbehalf.test.ts:240 (deals section follows the person's sales.view); tests/hermes-client-business-mcp-permissions.test.ts:71. Does not prove: that a model can use the output to move a deal.
- **Real or simulated behavior:** Real read SQL (list_opportunities, crm_summary_report, context snapshot, read-only pipeline reviews). No tool or snapshot field returns pipeline stage ids, so move_opportunity_stage (needs a stageId uuid) is not usable by a model unaided.
- **Missing dependencies:** none external.
- **Remaining work:** Add list_pipelines read tool (pipeline id, stage id, name, kind, position, open count) with opportunities:read and add to CLIENT_BUSINESS_TOOL_MATRIX.growth_partner, or let move_opportunity_stage accept a stage name resolved in plan(); confirm pipeline_review provider filter; expose deal owner.
- **Verification evidence:** own reading of employee-evidence.ts and catalog.ts; the missing-stage-id gap is derived from reading all 14 tool definitions.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A model can list pipelines with stage ids and open deals under the person's sales.view, and a test proves list_pipelines then move proposal works end to end.

<a id="gp-crm-07"></a>
### GP-CRM-07 — Create follow-up task

- **Requirement:** Create follow-up task (directive §11 create follow-up task)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/handlers.ts`, `src/server/crm/agent-tools/catalog.ts`, `src/server/crm/tasks.ts`, `src/server/workforce/hermes-client-business-mcp.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts`, `src/server/chat/service.ts`, `supabase/migrations/0137_task_idempotency_key.sql`, `supabase/migrations/0138_growth_partner_chat_task_preview.sql`
- **Test coverage:** `tests/hermes-client-business-mcp-proposals.test.ts` covers the Partner proposal gate, ability switch and contact visibility; `tests/crm-agent-tools.test.ts` covers approval, replay, content duplicate and audit-failure handling; `tests/workforce-chat-e2e.test.ts` covers preview/confirm, repeat confirmation, cancellation and audit. Distinct concurrent calls for the same logical task and duplicate requests across separate chat turns are not proven.
- **Real or simulated behavior:** Client-tier MCP calls are proposals gated by `crm.request_update`; contact-linked tasks require `contacts.view`, and the client tier drops unsupported assignee IDs. Task inserts accept a workspace-scoped unique idempotency key. The chat route requires explicit confirmation and keys the insert to the confirmation message. Synthetic DB tests exercise these app paths; no live model or hosted database was used.
- **Missing dependencies:** none external.
- **Remaining work:** Add transactional deduplication for distinct concurrent calls representing the same logical task and across separate chat turns; test both races. Current idempotency keys cover retries with the same call/confirmation key, while content duplicate checks are a preflight and do not serialize distinct simultaneous calls.
- **Verification evidence:** focused MCP, CRM agent-tool, chat E2E and intent/policy suites passed locally; synthetic-only. No hosted DB or live-model verification is claimed.
  - *Historical baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One logical follow-up command yields exactly one task across retries, new turns and concurrent calls (unique constraint proves it), needs the same permissions as the human createTask, and the Growth Partner CRM switch stops it.

<a id="gp-crm-08"></a>
### GP-CRM-08 — Add approved notes

- **Requirement:** Add approved notes (directive §11 add approved notes)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/notes.ts:46`, `src/lib/agent-tool-scopes.ts:11`, `src/server/crm/agent-tools/catalog.ts:58`
- **Test coverage:** none for the AI path.
- **Real or simulated behavior:** Not present for the AI. Only the human addNote service exists (notes.write permission, record_notes table); no scope, tool, chat intent or capability writes a note for the Growth Partner.
- **Missing dependencies:** none external. Product rule needed on who is shown as author of an AI-authored note and whether notes are always approval-gated (they can contain model text derived from customer messages: a prompt-injection surface).
- **Remaining work:** Add notes:write scope, add_note tool (contact or opportunity, body max 4000, always a proposal at client tier), extract addNoteInTx with idempotency key (new column and unique index on record_notes), AI author labelling, ability switch, timeline rule (text never on timeline), tests for tenant, role, retry, denied approval.
- **Verification evidence:** own reading and grep.
- **Definition of done:** The Growth Partner can propose a note, a person approves, exactly one note labelled AI-written is stored with the approval linked in audit, and retries or foreign-tenant records create nothing.

<a id="gp-crm-09"></a>
### GP-CRM-09 — Deduplicate leads and contacts

- **Requirement:** Deduplicate leads and contacts (directive §11 deduplicate leads)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/contacts.ts:141`, `src/server/crm/contacts.ts:177`, `src/server/crm/contacts.ts:495`, `src/server/crm/contacts.ts:461`, `src/server/workforce/crm-quality-review.ts:79`, `src/server/leads/service.ts:366`, `src/server/approvals/service.ts:193`
- **Test coverage:** tests/crm-foundation.test.ts (findDuplicateCandidates); tests/workforce-chat-e2e.test.ts:474 and :820-850 (quality review routed from chat); tests/ai-growth-partner-fixture-acceptance.test.ts (duplicate, possible-duplicate lead cases in fixtures). Does not prove: duplicate suggestions reaching a person with an approval to merge, near-duplicates by phone/email variants.
- **Real or simulated behavior:** Prevention is real (unique contact_identities, findByIdentities, lead import dedupe gate). Detection is thin: the AI quality review is a read-only name-based prompt; findDuplicateCandidates is human-only (contacts.merge); the AI has no merge.
- **Missing dependencies:** none external.
- **Remaining work:** Expose duplicate groups as a Growth Partner read with contacts.merge checked on the viewing person; add propose_merge approval kind executed via mergeCrmContacts after an owner/admin approves with ids pinned and revalidated; improve quality-review signals; add name+company guard for name-only lead-import contacts.
- **Verification evidence:** own reading of the cited functions; recorded lead-fixture acceptance in docs/ai-growth-partner/implementation-status.md lines 46-47 is synthetic.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The Growth Partner surfaces likely duplicates and proposes a merge a permitted person approves; no create path can make a second contact for an existing email/phone; name-only duplicates are flagged, never auto-merged.

<a id="gp-crm-10"></a>
### GP-CRM-10 — Check ownership and retrieve status

- **Requirement:** Check ownership and retrieve status (directive §11 check ownership; retrieve status)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/handlers.ts:194`, `src/server/crm/agent-tools/handlers.ts:607`, `src/server/crm/agent-tools/service.ts:202`, `src/server/workforce/hermes-client-business-mcp-gate.ts:58`, `src/server/crm/workspace.ts:96`
- **Test coverage:** tests/hermes-client-business-mcp-gate.test.ts:155-200 (GHL and hybrid workspaces are unavailable, not empty; nothing created by asking); tests/crm-agent-tools.test.ts:309 (GHL write refused, reads work); tests/crm-agent-tools.test.ts:446 (repeat after decision says what happened). Does not prove: owner id exposure or a status lookup across turns.
- **Real or simulated behavior:** Real reads. Record owner returned as a name only; provider ownership (native vs GoHighLevel) enforced with 'unavailable' answers; status of a prior proposal learnable only by repeating the identical call in the same run (a new turn creates a new approval).
- **Missing dependencies:** none external.
- **Remaining work:** Add owner id/assignedToMe to get_contact and list_opportunities; add get_proposal_status read tool (own employee, tenant scoped) returning status, approver name, execution status; tests. | Skeptic adds: Note the context snapshot already carries a deal owner name for 8 deals; make list_opportunities consistent rather than adding a second source.
- **Verification evidence:** own reading.
  - *Skeptic review: Small factual correction: the auditor says deals expose no owner. The role context snapshot (get_role_workspace_context) already returns the assigned user's name for up to 8 open deals (oldest in stage). list_opportunities and get_contact are still where an ownership question would be asked, so PARTIAL stands.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The Growth Partner truthfully answers who owns a record and what happened to an earlier proposal from a tenant- and permission-scoped read tool.

<a id="gp-crm-11"></a>
### GP-CRM-11 — Approval and audit evidence

- **Requirement:** Approval and audit evidence (directive §11 record approval and audit evidence)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/service.ts:146`, `src/server/crm/agent-tools/service.ts:167`, `src/server/crm/agent-tools/service.ts:239`, `src/server/crm/agent-tools/service.ts:455`, `src/server/approvals/service.ts:471`, `src/server/approvals/service.ts:573`, `src/server/workforce/hermes-client-business-mcp.ts:210`
- **Test coverage:** tests/crm-agent-tools.test.ts:393-446 (runs once, audit row with approved true and approval_id, tool_executions label approved, high risk needs the owner); tests/hermes-client-business-mcp-proposals.test.ts:298 (one audit row per recorded request naming person, employee, approval; none in the other workspace), :383-431 (approve once, other tenant's owner and non-deciders refused); tests/growth-partner-crm-ability.test.ts:165 (denial audited).
- **Real or simulated behavior:** Real: approval row with requester, risk and 72h expiry, approval_events, audit_logs per call (proposal audit is in the same transaction as the approval), tool_executions, CRM timeline, notifications. The approved/autonomous execution audit is written after commit in a separate transaction and failures are swallowed.
- **Missing dependencies:** none external.
- **Remaining work:** Write the execution audit/tool log inside the execute transaction (or fail the approval if it cannot be written); include approver and requester ids in the approved audit row; add approval ref to timeline activities of approved executions; test the log-failure case. | Skeptic adds: Add agent/chat attribution (agentId, conversationId, userMessageId) to audit rows and timeline entries for chat-direct CRM writes; either give them their own evidence class/label such as 'applied on your typed request' or make the approved_write hint accurate for them; test that one audit query by user message id returns the write.
- **Verification evidence:** own reading and tests above.
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: The row is graded on the proposal/approval path only. The three Growth Partner chat CRM writes (create contact, create opportunity, move stage) have no approval row and their audit rows (crm.contact_created, crm.opportunity_created, crm.opportunity_stage_changed) are written under the signed-in person with no agent id, no run id and no chat message id, so an auditor cannot tell an AI-chat write from a manual UI write. The chat reply is also labelled with the evidence class approved_write, whose registry text says 'A person approved this and iAcquire saved it', although no approval was recorded. The auditor's own point that the execution audit is written after commit by a swallowing safeLog is confirmed.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One query on approval_id returns request, requester, decision, approver, execution and timeline entry for every Growth Partner CRM change, and no change can commit without its audit row.

<a id="gp-crm-12"></a>
### GP-CRM-12 — Authorization parity: AI tool layer vs human CRM actions

- **Requirement:** Authorization parity: AI tool layer vs human CRM actions (directive §11 AI tool layer must not bypass CRM service authorization)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/agent-tool-scopes.ts:56`, `src/server/crm/agent-tools/service.ts:121`, `src/server/crm/agent-tools/service.ts:319`, `src/server/crm/agent-tools/service.ts:455`, `src/server/crm/actor.ts:97`, `src/server/crm/actor.ts:166`, `src/server/crm/tasks.ts:98`, `src/server/crm/opportunities.ts:117`, `src/server/crm/tags.ts:195`, `src/server/workforce/hermes-client-business-mcp.ts:226`, `src/server/workforce/hermes-client-business-mcp-policy.ts:49`
- **Test coverage:** tests/crm-agent-tools-onbehalf.test.ts:159-207 (per-person overrides refuse before anything is read; viewer without edit cannot even propose; unknown person id never falls back to the unrestricted path); tests/hermes-client-business-mcp-permissions.test.ts; tests/crm-agent-tools.test.ts:215 (role allowlist and token scope intersection). Does not prove the gaps below.
- **Real or simulated behavior:** Real layered checks (role allowlist, token scopes, agent permissions, signed-in person's permissions, gate, forced approval, approver permission, re-validation). Writes call the in-transaction services, which skip the human wrappers' extra checks.
- **Missing dependencies:** none external.
  - Remaining work (each is a concrete parity gap): (1) create_task: add contacts.view (when contactId set) to the person check and to the agent permission set, matching tasks.ts:99-100; today a person without contacts.view can cause a contact's display name to appear in an approval via contactLabel (handlers.ts:329). (2) create_opportunity: human path needs opportunities.create (assertCanCreate), the client tier checks only opportunities.edit (catalog.ts:192 permissions); require opportunities.create for the person. (3) multi-contact tag changes: human tagContacts needs contacts.bulk (tags.ts:198); the AI path forces approval but never checks the requester's contacts.bulk; add it. (4) requester permission is re-checked only at request time; executeApprovedAgentToolCall does not re-check requested_by's current role (a demoted person's old proposal still executes once approved); re-load the requester and refuse. (5) GROWTH_PARTNER_CRM_PROPOSALS omits create_task, so the crm.request_update switch does not stop it (see GP-CRM-07). (6) defense in depth: human reads run under RLS via withUser (actor.ts:166-180) but AI tool reads and writes run as withSystem with only explicit org_id predicates (handlers.ts, every query reviewed contains org_id, so no leak found, but there is no second layer); consider running reads for a client-tier call under withUser(person) as get_conversation_history already does for visibility. (7) approved changes are absolute overwrites (see GP-CRM-04, GP-CRM-05). Add a table-driven parity test that, for every write tool, enumerates the human service's required permissions and asserts the AI path refuses a person lacking each.
- **Remaining work:** Add contacts.view to create_task when a contact is linked; require opportunities.create for create_opportunity; require the requester's contacts.bulk for multi-contact tag changes; re-check the requester's current permissions at execution; gate create_task by crm.request_update; consider RLS (withUser) for client-tier reads; add a table-driven parity test over every write tool comparing the human service's required permissions with the AI path at request and execution time.
- **Verification evidence:** own reading of the code paths above. No parity matrix test exists.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A generated test proves that for every write tool a person or role the human UI refuses is refused by the AI path at request time and at execution time, and a role the human UI allows is blocked only by the approval step.

<a id="gp-crm-13"></a>
### GP-CRM-13 — Idempotency of retried Growth Partner commands

- **Requirement:** Idempotency of retried Growth Partner commands (directive §11 retried command must never create duplicate contacts or tasks)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/service.ts`, `src/server/crm/agent-tools/handlers.ts`, `src/server/approvals/service.ts`, `src/server/chat/service.ts`, `src/server/crm/tasks.ts`, `supabase/migrations/0137_task_idempotency_key.sql`, `supabase/migrations/0138_growth_partner_chat_task_preview.sql`
- **Test coverage:** `tests/crm-agent-tools.test.ts` covers same-key task replay and content duplicate refusal; `tests/workforce-chat-e2e.test.ts` covers repeat task confirmation, repeated lead-import request and other chat retries. Does not prove distinct concurrent calls or the same logical task across separate chat turns.
- **Real or simulated behavior:** Tasks now have an optional `(org_id, idempotency_key)` unique index and the CRM tool and chat confirmation paths supply keys. Existing approval, opportunity, contact identity, draft, claim and chat-message deduplication remains. Contact creation and distinct-key task races still need stronger transactional deduplication.
- **Missing dependencies:** none external.
- **Remaining work:** Key chat contact creation to the user message; derive approval keys from conversation/message identity where proposal requests can be replayed across runs; add database-backed concurrency tests for identical distinct-key task calls and each remaining write path. CRM task inserts are now protected for repeated identical keys, but distinct-key races remain.
- **Verification evidence:** focused CRM agent-tool and chat E2E tests passed locally against synthetic PGlite tenants; no hosted DB or live-model verification is claimed.
  - *Historical skeptic review at 6e4a4b7e found the prior replay record was best-effort. Task writes now have a database unique key, resolving same-key replay atomicity; distinct-key concurrent and chat cross-turn duplicates remain open.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For every write operation, N parallel or sequential retries (same turn, new turn, new run id) produce exactly one record, proven by tests and enforced by a database unique constraint.

<a id="gp-crm-14"></a>
### GP-CRM-14 — Tenant isolation and provider ownership for CRM operations

- **Requirement:** Tenant isolation and provider ownership for CRM operations (directive §11 wrong tenant; AI tool layer authorization)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/tokens.ts`, `src/server/crm/agent-tools/service.ts:102`, `src/server/crm/agent-tools/service.ts:321`, `src/server/crm/agent-tools/handlers.ts`, `src/server/workforce/hermes-client-business-mcp.ts:60`, `src/server/workforce/hermes-client-business-mcp-gate.ts:83`, `src/server/crm/workspace.ts:96`
- **Test coverage:** tests/crm-agent-tools.test.ts:183 (foreign contact ids 404, orgId argument 400, no approval for a foreign record, other workspace's employee sees only its own counts); tests/workforce-chat-e2e.test.ts:586-672 (foreign contact/opportunity not found, foreign row unchanged); tests/growth-partner-crm-ability.test.ts:194; tests/hermes-client-business-mcp-pinned-runtime.test.ts:191-232 (two tenants on one real pinned gateway, find_contacts never crosses; synthetic, no model); tests/hermes-client-business-mcp-limits.test.ts:181.
- **Real or simulated behavior:** Real: org and employee come only from the token row or authenticated turn, strict input objects reject orgId, every handler query names org_id, GHL-managed workspaces refuse writes. Pinned-runtime two-tenant test is synthetic with no model. AI path has no RLS backstop.
- **Missing dependencies:** none external.
- **Remaining work:** Table-driven wrong-tenant test over every tool with the growth_partner role; a policy test that fails if a handler query lacks an org_id predicate; confirm create_task skipping assertNativeOwner is intended; consider RLS backstop for AI reads. | Skeptic adds: Replace 'confirm create_task skipping assertNativeOwner is intended' with 'add a test that create_task still works in a GoHighLevel-managed workspace' (the gate comment says tasks are iAcquire-owned whatever the CRM mode).
- **Verification evidence:** own reading; tests listed.
  - *Skeptic review: Status IMPLEMENTED_UNVERIFIED is fair; I could not refute it. Handler queries I read (find_contacts, get_contact, task/opportunity/pipeline/stage plans, draft approval) all carry org_id from the token or turn, and the approved path reloads the agent with org_id from the approval row. Contacts and tasks RLS is permission based, not owner based, so reading as system does not widen visibility beyond what the person could see. One correction to remaining-work item 3: skipping assertNativeOwner for create_task is intentional and documented in the gate; what is missing is a test, not a decision.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A generated wrong-tenant test for every tool passes and a policy test guards org_id predicates in handlers.

<a id="gp-crm-15"></a>
### GP-CRM-15 — Failure-mode test matrix and restart recovery

- **Requirement:** Failure-mode test matrix and restart recovery (directive §11 failure-mode test matrix)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/service.ts:280`, `src/server/crm/agent-tools/service.ts:167`, `src/server/approvals/service.ts:573`, `src/server/workforce/hermes-client-business-mcp.ts:156`, `src/server/admin/queries.ts:287`
- **Test coverage:** see per-case list above; the files are tests/crm-agent-tools.test.ts, tests/crm-agent-tools-onbehalf.test.ts, tests/growth-partner-crm-ability.test.ts, tests/hermes-client-business-mcp-proposals.test.ts, tests/hermes-client-business-mcp-gate.test.ts, tests/workforce-chat-e2e.test.ts, tests/approvals.test.ts.
- **Real or simulated behavior:** Real tests scattered over about eight files, no single matrix. Covered: valid, invalid, missing contact, wrong tenant, wrong role, approval denied, retried; partial: duplicate (tasks missing), partial failure (no mid-batch or log-failure test). Not covered: tool timeout (no handler timeout exists), restart recovery (executeApproval has no caller other than decideApproval; rows stuck at queued/running are never re-driven).
- **Missing dependencies:** none external.
- **Remaining work:** Add tests/growth-partner-crm-failure-matrix.test.ts covering all 11 cases for each Growth Partner write tool; add a sweeper that re-drives or fails approvals stuck at approved+queued/running past a timeout; add a bounded timeout around execute(); add reconciliation for chat commands whose user message was saved but whose reply and write never completed. | Skeptic adds: The realistic restart-loss mode is the HTTP request that clicks Approve: decideApproval runs executeApproval inline in the same request (approvals/service.ts:537), so a serverless timeout or crash between the claim and the final status update leaves approved + running with no re-driver. The only other writers of execution_status 'running' are in messaging/inbox.ts, so nothing in src or scripts recovers CRM rows. Add a sweeper AND a test that simulates a thrown executor and a killed claim.
- **Verification evidence:** own reading; no recorded evidence of timeout or restart tests.
  - *Skeptic review: Confirms the auditor's PARTIAL and the no-timeout / no-recovery findings by grep: no AbortSignal or statement_timeout appears in agent-tools/service.ts or handlers.ts, and executeApproval has a single caller.*
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One matrix test is green for every write tool, a killed-mid-execution approval is recovered or surfaced within a bounded time, and no listed case is untested.

<a id="gp-crm-16"></a>
### GP-CRM-16 — Pinned-runtime scripted-inference proof of CRM proposals

- **Requirement:** Pinned-runtime scripted-inference proof of CRM proposals (directive §11 AI tool layer end to end)
- **Current implementation status:** NOT STARTED
- **Priority:** P2  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `tests/hermes-client-business-mcp-pinned-runtime.test.ts`, `tests/support/c6-runtime.ts`, `services/hermes-business-mcp-acceptance`
- **Test coverage:** none for write proposals through a real runtime.
- **Real or simulated behavior:** Existing pinned Hermes 0.21.5 tests call read tools through Hermes' own MCP client with no model and only assert write tools are not registered for read-only inventories. No scripted-inference run issues a proposal tool and asserts a pending approval.
- **Missing dependencies:** needs the pinned runtime prepared in CI (Linux, Docker), which exists in hosted CI; no paid model needed (scripted inference).
- **Remaining work:** Extend the acceptance harness with a scripted-inference run for the growth_partner profile with proposals on that calls update_contact/create_task through the registry and asserts one pending crm_update approval, an audit row and no record change, repeated on retry.
- **Verification evidence:** own reading.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** CI shows a pinned-Hermes run where a Growth Partner tool call produces exactly one pending approval and no CRM change, and a retry reuses the same approval.

<a id="gp-crm-17"></a>
### GP-CRM-17 — Real-model verification of Growth Partner CRM tool use

- **Requirement:** Real-model verification of Growth Partner CRM tool use (directive §11 the AI actually performing CRM operations)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `src/server/workforce/hermes-client-business-mcp.ts`, `src/server/env.ts`
- **Test coverage:** none with a real model.
- **Real or simulated behavior:** Nothing real-model has run; all recorded acceptance is synthetic-inference or no-model; client business MCP flags are off by default and production is dormant.
- **Missing dependencies:** paid model spend and provider credentials, a verified client-only gateway, the founder's approval to switch the two flags in a test workspace.
- **Remaining work:** After GP-CRM-06, GP-CRM-07 and GP-CRM-16, run a scripted checklist of natural-language CRM requests on a real model in a synthetic workspace (find, update, task, stage move, duplicate request twice, wrong-tenant ids) and record the audit and approval evidence.
- **Verification evidence:** none.
- **Definition of done:** A recorded real-model run shows each CRM operation producing the right proposal or refusal with no duplicate records.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "AI attribution and approval-equivalent evidence for chat-direct CRM writes (create contact, create opportunity, move/close deal)", "directiveRef": "§11 record approval and audit evidence; AI tool layer authorization parity", "priority": "P1", "status": "PARTIAL", "remainingWork": "Chat commands write as memberActor with via 'manual', no approval row, no agent/run/message id in audit or timeline. Add a distinct via ('growth_partner_chat'), put conversationId/userMessageId/agentId into audit metadata and the timeline summary, and add a test that one query on user_message_id returns the write, the actor and the ability switch state. Decide and document that a typed, exact-phrase command is the human's decision (same permission as the UI) but is not an 'approval'."}
- {"title": "Honest evidence label for direct chat CRM writes", "directiveRef": "§11 approval/audit evidence; no status shown as approved when no approval exists", "priority": "P2", "status": "PARTIAL", "remainingWork": "serverMarker('approved_write') on chat contact/opportunity/stage replies renders 'Approved and applied: A person approved this' (evidence-class.ts:200) though there is no approval request. Use a class or label that says it was applied from the typed request, and add a test on the marker for these three replies."}
- {"title": "Won/Lost closure from chat bypasses the high-impact approval rule that the tool path enforces", "directiveRef": "§11 change permitted lead stages; approvals for high-impact changes", "priority": "P1", "status": "PARTIAL", "remainingWork": "The auditor raised this inside GP-CRM-05 as a copy question; treat it as its own requirement: chat can close a deal Won/Lost immediately (chat/service.ts:1465-1495) while move_opportunity_stage marks it highImpact and needs the owner (handlers.ts:410). Get the founder's decision on one rule, enforce it in code for both paths, and test both."}
- {"title": "Growth Partner role coverage in the proposals and failure-mode tests", "directiveRef": "§11 failure-mode test matrix", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "Only one Growth Partner CRM tool test exists (crm-agent-tools.test.ts:372, move_opportunity_stage via the token path) plus the ability-switch test; the client-tier proposals tests run appointment_setter, sales_assistant and crm_manager. Add growth_partner rows for update_contact, create_task, apply/remove_tag, create_opportunity through the real client MCP handler, including requester-demoted-before-approval and duplicate-across-turn cases."}
