# MEM — Memory

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

Audit of branch claude/ai-growth-partner-completion (HEAD 6e4a4b7e), read-only. No tests were run by me; "Verification evidence" separates what I read from what the docs record. Paths are relative to the worktree root.

**Summary.** There are three distinct memory stores, and the product mostly keeps them apart:
1. App-owned Growth Partner memory: table `ai_growth_partner_memories` (migration 0130), service `src/server/ai-growth-partner/memory.ts`, panel `src/components/growth-partner/memory-panel.tsx`, and deterministic `Remember:`/`Forget:` chat commands (`src/server/chat/service.ts:2784-2820`). This is real, database-backed and tenant-scoped (RLS plus composite FK plus service filters), versioned, audited with metadata only, and injected into the Partner prompt as untrusted context (`src/server/workforce/service.ts:920-925`).
2. The Business Brain (`ai_growth_partner_versions.business_brain`): versioned, with provenance and states (verified, client_confirmed, draft_suggestion, superseded...). It is injected as a separate `<client_context>` block (`workforce/service.ts:989-1036`). Conflicts become `draft_suggestion` facts that retrieval excludes.
3. Hermes-native memory (profile `MEMORY.md`): the `memory` toolset is allowed for the Partner (`src/server/workforce/tool-policies.ts:52`, `services/hermes-provisioner/worker.py:57`). The app cannot read, edit, delete or audit its content (`memory_write_api: false`, docs/hermes-live-acceptance.md:30). It was proven only on hosted CI with a mock model (synthetic fixture, 2 tenants, pinned Hermes v0.22.5).

Biggest gaps:
- Secret minimization is pattern-based. App-owned memory and new Growth Partner chat inputs reject recognized credential/contact patterns, and chat history is redacted before Hermes, but uncommon credentials can evade the detector. Hermes-native memory has no app-readable content filter; the chat/customer-reply no-tools boundary and policy wording still need pinned-runtime canary acceptance.
- No end-to-end synthetic lifecycle test (create, recall, update, conflict, delete, restart) exists. The restart script is manual, seeds memory by raw SQL, and covers recall only.
- Conflicting or outdated app notes are not detected, expired or revisioned (the prior text is lost).
- Hermes-native memory is not erased on `Forget:` or at offboarding. App memory is missing from the client data export.
- There is no real-model memory acceptance harness, and no model-level proof that Brain facts take precedence over notes.
- The UI says Hermes-native memory "has not passed the pinned-runtime acceptance", but the docs record synthetic passes (stale wording, and a test pins it).

<a id="gp-mem-01"></a>
### GP-MEM-01 — Persistent application-owned memory (store, service, UI, chat commands)

- **Requirement:** Persistent application-owned memory (store, service, UI, chat commands) (directive §7)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0130_ai_growth_partner_memory.sql`, `supabase/rollbacks/0130_ai_growth_partner_memory.down.sql`, `src/server/ai-growth-partner/memory.ts`, `src/lib/ai-growth-partner-memory.ts`, `src/server/chat/service.ts`, `src/app/actions/ai-growth-partner.ts`, `src/components/growth-partner/memory-panel.tsx`, `src/app/(portal)/growth-partner/page.tsx`
- **Test coverage:** `tests/ai-growth-partner-memory.test.ts` (2 tests, real PGlite): command parsing; save, duplicate, revision 1→2, stale update conflict, member forbidden, bad kind, injection text rejected, cross-tenant update not_found, metadata-only audit, delete. `tests/ai-growth-partner-fixture-acceptance.test.ts:377-444` drives `Remember:`/`Forget:` through `sendChatMessage` with no Hermes call, and asserts the command text is not in later model history. `tests/crm-migrations.test.ts:205-241` covers migration apply/rollback and the rollback guard. `tests/growth-partner-memory-panel.test.tsx` is jsdom with the server actions mocked (UI wiring only). Not covered: the 100-note cap, the `usage_limit` path, concurrent updates, `forget` of a non-match, ranking and truncation limits in the prompt context, and a rejected-secret path through chat.
- **Real or simulated behavior:** Real Postgres/PGlite table and real service code in withSystem transactions (partner row lock, revision check, SHA-256 dedupe, 100-note cap). Chat Remember:/Forget: are deterministic parsing with no model call. Panel test mocks the server actions.
- **Missing dependencies:** none.
- **Remaining work:** Add tests for the 100-note cap, concurrent update/delete, Forget with no match and prompt-context ranking/3500-char/8-note limits (tests/ai-growth-partner-memory.test.ts); one integration test of the panel against real actions; decide whether chat needs an update-note command (today Forget then Remember).
- **Verification evidence:** I read all of the source files above and the tests listed. The docs (implementation-status.md:47, :53) record focused runs (43 tests) and full-suite passes, but I could not observe those runs. The baseline run decides the final status.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Baseline suite passes the memory tests; edge-case tests exist and pass; panel and chat commands both verified against the real DB.

<a id="gp-mem-02"></a>
### GP-MEM-02 — Tenant isolation of application memory (write, read, prompt retrieval)

- **Requirement:** Tenant isolation of application memory (write, read, prompt retrieval) (directive §7)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `supabase/migrations/0130_ai_growth_partner_memory.sql`, `src/server/ai-growth-partner/memory.ts`, `src/server/workforce/service.ts`
- **Test coverage:** `tests/ai-growth-partner-memory.test.ts:77-96` (cross-tenant update returns not_found; a `withUser` read of another org's rows returns []; list for another tenant is []). `tests/ai-growth-partner-unified-context-e2e.test.ts:59-167` (a second tenant's `CROSS_TENANT_PRIVATE_MARKER` memory never appears in the first tenant's composed instructions) and `:169-183` (unlinked runtime refused). `tests/tenant-isolation-generic.test.ts` is a schema-wide RLS guard that picks the new table up automatically. Not covered: delete or forget by a foreign tenant's id, `growthPartnerMemoryPromptContext` called with tenant A's orgId and tenant B's runtime id (the SQL returns empty, but there is no explicit test), and a stale `partner_id`/`org_id` mismatch insert (blocked by the FK, untested).
- **Real or simulated behavior:** Real: composite FK (partner_id, org_id), RLS select policy on app.permitted_orgs('agents.use') with writes revoked from app role, service filters by orgId and partner id, prompt retrieval joins org_id + runtime_agent_instance_id and refuses an unlinked runtime. Writes use withSystem so rely on application checks.
- **Missing dependencies:** none.
- **Remaining work:** Add foreign-tenant delete, forget and mismatched org/agent prompt-context tests to tests/ai-growth-partner-memory.test.ts; confirm tenant-isolation-generic is green for table 0130 in the baseline.
- **Verification evidence:** I read the SQL, service and tests. Docs record passes (implementation-status.md:53). Not observed by me.
  - *Skeptic review: Favourable claim holds on the app-memory store itself: composite FK, select-only RLS under role iaq_app_user (withUser sets it), org_id plus partner filters on every service query, and a real two-tenant prompt test. No status change. Caveat: tenant isolation of the table does not cover who inside a tenant, or which channel, receives the notes (see missed requirements).*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Cross-tenant matrix (read, update, delete, forget, prompt context, Brain+memory composition) passes against two real tenants and the generic RLS guard stays green.

<a id="gp-mem-03"></a>
### GP-MEM-03 — Hermes-native memory integration policy (what the product does with runtime memory)

- **Requirement:** Hermes-native memory integration policy (what the product does with runtime memory) (directive §7)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/tool-policies.ts`, `src/lib/employee-tool-policy.ts`, `src/server/integrations/hermes/client.ts`, `src/server/workforce/instructions.ts`, `src/components/workforce/employee-instructions.tsx`, `src/server/workforce/provisioning.ts`, `services/hermes-provisioner/worker.py`, `services/hermes-provisioner/catalog-overlay/agent/memory_provider.py`
- **Test coverage:** no TypeScript test asserts the Partner's native-memory policy beyond tool inventory. Python `services/hermes-provisioner/test_acceptance_harness.py` tests only the synthetic probe protocol. `tests/employee-instructions-language.test.tsx:32` pins the stale "has not passed the pinned-runtime acceptance" sentence.
- **Real or simulated behavior:** The Partner profile has the real Hermes memory toolset enabled and chat/research runs send X-Hermes-Session-Key iaq:<org>:<role>. The app cannot read, edit, delete or audit its content (memory_write_api false). Inference-only worker uses skip_memory but the Partner is excluded from that path. No TS test of native-memory policy; one test pins stale UI wording.
- **Missing dependencies:** a founder decision on the product policy for native memory (leave it on and uninspectable, restrict it to a write-guarded mode, or disable it for the Partner so app memory is the only long-term memory). Hermes exposes no memory read or delete API (`memory_write_api: false`).
- **Remaining work:** Choose policy (keep, restrict, or disable memory toolset for the Partner) and apply in tool-policies.ts and worker.py with tests; add a no-credentials/no-personal-data memory line to immutablePolicy; correct stale 'has not passed the pinned-runtime acceptance' text (instructions.ts:180, employee-instructions.tsx:154, test employee-instructions-language.test.tsx:32); confirm memory.provider is built-in in client config; decide disposition of retained legacy profiles' native memory. | Skeptic adds: Customer-facing runs use the same Hermes profile and toolset but a per-contact memoryScope (iaq:<org>:contact:<id>, responder.ts:149) with a comment claiming one customer's words never reach another. The only proven store is profile-wide profiles/<p>/memories/MEMORY.md injected via the system prompt (acceptance_harness.py:355-368), so the header cannot partition it. Verify, or prove, whether the built-in memory tool is partitioned by session key. Also note worker.py:113 lists memory in REQUIRED_INVENTORY_TOOLS, so 'disable memory for the Partner' needs a provisioner change, not only tool-policies.ts.
- **Verification evidence:** I read the code above. The docs (implementation-status.md:105, :126) state this boundary honestly. No code mapping from native memory to app records exists.
  - *Skeptic review: Status PARTIAL stands, but the auditor listed only the owner-chat session key (iaq:<org>:<role>) and missed the customer-reply path that also reaches native memory.*
  - *Baseline: 1 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Written, tested native-memory policy; UI text matches verified state; legacy-profile memory has a documented disposition.

<a id="gp-mem-04"></a>
### GP-MEM-04 — Hermes-native memory tenant isolation and gateway-restart recovery (pinned runtime)

- **Requirement:** Hermes-native memory tenant isolation and gateway-restart recovery (pinned runtime) (directive §7)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `services/hermes-provisioner/acceptance_harness.py`, `.github/workflows/hermes-client-acceptance.yml`, `services/hermes-provisioner/test_acceptance_harness.py`
- **Test coverage:** the Python unit test covers protocol logic locally. The end-to-end proof exists only as the hosted workflow on branch `codex/hermes-gha-acceptance`. Docs cite GitHub run #87 and others (implementation-status.md:42-44, :110, :249: `HERMES_MEMORY_RESTART_PASS profiles=2 own_recalls=2 foreign_denials=2`). Docker is unavailable on this machine, so none of it is reproducible locally. No evidence yet for the current HEAD 6e4a4b7e (workflow is branch-scoped).
- **Real or simulated behavior:** Real pinned Hermes v0.22.5 gateway and provisioner in Docker on hosted CI; the model is a deterministic local mock that emits the real memory tool call. Proves persistence, post-restart injection and cross-profile denial mechanics, not model behavior. Docs cite hosted runs #87-#95 (not observed by me); workflow is branch-scoped and has no evidence for the current HEAD.
- **Missing dependencies:** a hosted CI run on the current tip. For the product, GP-MEM-15 (real model).
- **Remaining work:** Re-run hosted acceptance on the completion branch tip and record run id/tree sha/image digest; check toolset parity with the production profile config; add a probe writing a credential-shaped marker to the memory tool to document Hermes behavior. | Skeptic adds: Strengthen the isolation probe: the foreign-denial step asks the tenant's OWN profile, with its OWN key and its OWN session key, for the other tenant's marker, and the mock model answers NOT_FOUND purely by checking its own system text, so it proves file separation, not that a cross-profile request is refused. The separate 'wrong-profile-key denials' in the run record (status doc lines 44, 331) cover the key side; add a memory-specific probe that sends the other tenant's session key and org id with this tenant's key. The workflow's dispatch guard is pinned to ref codex/ai-growth-partner (hermes-client-acceptance.yml:22-25), so a rerun on this branch needs the allowlist edited.
- **Verification evidence:** I read the harness, the workflow steps and the unit tests. The doc-recorded CI runs are the prior team's claim, kept separate from my reading. I cannot confirm the runs.
  - *Skeptic review: The audit said there is no evidence for HEAD 6e4a4b7e. The status doc records hosted run #97 on application tree f40b36c3 with the native-memory restart pass; HEAD differs from f40b36c3 only by docs and a topbar label (git diff --stat f40b36c3 HEAD: 3 files, docs/topbar/one test). So the evidence is one docs-and-label step behind HEAD, not absent. Status stays IMPLEMENTED_UNVERIFIED because I could not observe the run.*
- **Definition of done:** Green hosted run on the final tip showing own-recall and foreign-denial for at least two tenants after restart, linked from the status doc.

<a id="gp-mem-05"></a>
### GP-MEM-05 — Application memory and conversation recovery after process restart

- **Requirement:** Application memory and conversation recovery after process restart (directive §7)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `scripts/ai-growth-partner-restart-acceptance.ts`
- **Test coverage:** none in vitest or CI. The script is not referenced by `package.json`, `tests/` or `.github/workflows/` (grep). It was run by hand per the docs (implementation-status.md:49, :73, :83: "passed"). It does not cover update, conflict or delete after restart, nor the Remember/Forget chat path.
- **Real or simulated behavior:** Real file-backed PGlite closed and reopened in a fresh Node process, but all rows are seeded with raw SQL (not the services) and the check is read-only recall. Not referenced by package.json, tests or CI; docs say it was run by hand.
- **Missing dependencies:** none.
- **Remaining work:** Add npm script and a CI/vitest wrapper; seed through saveGrowthPartnerMemory and sendChatMessage; after restart also update and delete a note and verify audit rows survive.
- **Verification evidence:** I read the whole script. Docs claim passes on 2026-11-07; I did not run it (instruction: no builds or runs).
- **Definition of done:** Restart check runs in CI, seeds through real services, verifies create, recall, update and delete across at least one restart.

<a id="gp-mem-06"></a>
### GP-MEM-06 — Separation of Business Brain facts from saved and conversational memory

- **Requirement:** Separation of Business Brain facts from saved and conversational memory (directive §7)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/service.ts`, `src/lib/ai-growth-partner.ts`, `src/server/ai-growth-partner/memory.ts`, `src/server/workforce/client-prompt.ts`
- **Test coverage:** `tests/ai-growth-partner-unified-context-e2e.test.ts` (Brain facts, goals, memory, approved legacy knowledge compose in separate blocks; unconfirmed Brain facts, pending/rejected knowledge and raw shared knowledge stay out), `tests/client-prompt-fit.test.ts:57-82` (memory shortened first). These prove assembly, not that the model respects the precedence. Memory kinds `decision` and `goal` can freely restate business facts (for example a price), and nothing detects overlap with the Brain.
- **Real or simulated behavior:** Real structural separation: versioned Brain in its own <client_context> block (only verified/client_confirmed facts, max 24), saved memory in a separate untrusted block, raw company knowledge excluded for the Partner, conversation history last 20 turns with memory commands filtered. Tests prove assembly only; model-level precedence is not verified and nothing detects notes that restate Brain fields.
- **Missing dependencies:** real-model check for precedence (GP-MEM-15).
- **Remaining work:** Add overlap warning/promote-to-Brain-draft when a note overlaps a Brain field; add fixture test that a contradicting note still renders under the Brain with header intact; real-model precedence check in GP-MEM-15/16. | Skeptic adds: Replace the evidence for 'memory is shortened first' with a test on the real memory block: tests/client-prompt-fit.test.ts:57-82 uses synthetic 'M'.repeat blocks, not growthPartnerMemoryPromptContext output. Also memoryBlock.rebuild returns an empty string when the budget is exhausted (client-prompt.ts:83), so notes can be dropped entirely with no owner-visible signal and a long note can be cut mid-string.
- **Verification evidence:** I read the composition code and the e2e test. Docs record the full suite passing (implementation-status.md:53, :54, :58, :62, :109).
  - *Skeptic review: Status stands, but one cited test does not exercise the memory path, and the silent-drop behaviour is not mentioned.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Tests show stores never share a prompt block, owners are warned about Brain-overlapping notes, and a real-model run shows the Brain wins on conflict.

<a id="gp-mem-07"></a>
### GP-MEM-07 — Memory retrieval permissions and recall relevance

- **Requirement:** Memory retrieval permissions and recall relevance (directive §7)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/memory.ts`, `src/server/chat/service.ts`, `src/app/(portal)/growth-partner/page.tsx`
- **Test coverage:** `tests/ai-growth-partner-memory.test.ts:69-72,112-113` (member can list, cannot save or delete). `tests/growth-partner-memory-panel.test.tsx` (member read-only rendering, mocked). The only prompt-context test uses a non-matching runtime id and asserts empty; the fixture test asserts one hit. There are no tests of ranking, the always-on preference and goal rule, or truncation.
- **Real or simulated behavior:** Real permission gates (list needs agents.use; write needs agents.configure; chat command gated). Retrieval is lexical token overlap with always-eligible preference/goal notes, top 8, 3500 chars; no embeddings. Notes are workspace-shared with no per-note visibility. Ranking and limits are untested.
- **Missing dependencies:** none.
- **Remaining work:** Add ranking and limit tests; document or change shared-note visibility (optional per-note audience field); test that member chats receive (or do not receive) memory per the decision. | Skeptic adds: Retrieval is not limited to the owner's Partner chat. composeRunInstructions adds the goals and memory blocks for every Partner run, including customer replies (responder.ts:136 passes the customer's message as the memory query, then customerInstructions wraps the same base). Internal notes and goals can therefore be selected by customer text and reach a customer-facing prompt. Decide per surface (owner chat, research job, customer reply, MCP) which blocks are allowed and add tests.
- **Verification evidence:** I read the code and tests. Not run.
  - *Skeptic review: The retrieval-permission row covers roles but not channels. A customer-facing channel is a retrieval boundary the brief asks for.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Documented retrieval policy per role and tested ranking and limit behavior.

<a id="gp-mem-08"></a>
### GP-MEM-08 — Memory updates after confirmed changes

- **Requirement:** Memory updates after confirmed changes (directive §7)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/service.ts`, `src/server/messaging/inbox.ts`, `src/server/ai-growth-partner/memory.ts`
- **Test coverage:** Brain sync is covered by `tests/ai-growth-partner-foundation.test.ts` and the Brain draft-review UI tests (I did not read these in depth). No test exists for "a confirmed change updates or flags saved memory", because that behavior does not exist.
- **Real or simulated behavior:** Business Brain syncs confirmed Settings, messaging-hours and approved-knowledge changes into new versions (real). App memory notes change only by explicit owner/admin action; nothing flags, supersedes or proposes notes after a confirmed change, and no outcome learning exists. Brain sync tests were not read in depth.
- **Missing dependencies:** a product decision on whether the Partner may propose memory updates from confirmed outcomes (owner approval required; never silent writes).
- **Remaining work:** Flag notes matching changed Brain facts or goals as possibly out of date in memory-panel.tsx (optionally last_reviewed_at); add an approval queue for suggested notes from confirmed outcomes; tests.
- **Verification evidence:** I read the sync functions' structure. Doc claims are in implementation-status.md:98-99 (not independently verified by me).
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A confirmed Brain/goal change makes affected notes visibly stale, and any outcome-derived memory is owner-approved and audited, with tests.

<a id="gp-mem-09"></a>
### GP-MEM-09 — Handling conflicting or outdated information

- **Requirement:** Handling conflicting or outdated information (directive §7)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/service.ts`, `src/lib/ai-growth-partner.ts`, `src/server/ai-growth-partner/memory.ts`, `supabase/migrations/0130_ai_growth_partner_memory.sql`
- **Test coverage:** `tests/ai-growth-partner-foundation.test.ts:545,637` (Brain conflict state); `tests/ai-growth-partner-memory.test.ts:98-110` (stale revision conflict). Nothing for note-versus-note or note-versus-Brain contradiction.
- **Real or simulated behavior:** Brain: real conflict handling (company_knowledge_conflict as draft_suggestion excluded from retrieval, client overrides preserved, superseded/historical states). App memory: only revision-lock conflict and fingerprint dedupe. No contradiction detection between notes, no expiry or last_confirmed, no prior-content history (update overwrites), only a prompt header saying notes may be stale.
- **Missing dependencies:** none for the deterministic parts. Semantic contradiction detection beyond lexical overlap would need a model (external).
- **Remaining work:** New migration for last_confirmed_at/expires_at and superseded linkage or a revisions table; stale flag in panel; lexical overlap warning on save; exclude superseded notes from prompt; tests.
- **Verification evidence:** I read the conflict code and the memory update path. Prior CI records are in the docs only.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A conflicting new note is flagged at save time; outdated notes can be marked, expire or be superseded with history; the prompt never receives a superseded note.

<a id="gp-mem-10"></a>
### GP-MEM-10 — Sensitive-data minimization; secrets never persisted into model memory

- **Requirement:** Sensitive-data minimization; secrets never persisted into model memory (directive §7)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/memory.ts`, `src/server/aqi/ops/redact.ts`, `src/server/workforce/policy.ts`, `src/server/chat/service.ts`
- **Test coverage:** `tests/ai-growth-partner-memory.test.ts` covers rejection of password, API key, GitHub token, credentialed database URL, email and phone content before an app-memory row is written. `tests/aqi-ops-redact.test.ts` covers natural-language passwords, common GitHub/AWS/Google/Slack/Twilio credentials, credentialed URLs and PEM keys. `tests/workforce-chat-business-brain-e2e.test.ts` proves a new credential-bearing Growth Partner message is refused before persistence, a legacy credential is redacted before Hermes, and the run has no tools, Hermes session ID or native-memory scope. No Hermes-native canary-secret probe or real-model check is covered.
- **Real or simulated behavior:** App notes reject injection phrasing and content changed by secret/email/phone screening; audits contain metadata only. New Growth Partner chat inputs with recognized credential patterns are refused before database insertion, while input/history reaching Hermes are redacted. Growth Partner chat runs require the verified per-run `no_tools` scope and omit Hermes session and memory scope. The client policy now forbids saving passwords, keys, access tokens, one-time codes, payment details and private contact details. Pattern matching is not a complete credential detector, and other runtime paths still require acceptance. Hermes-native memory has no app-readable content filter.
- **Missing dependencies:** pinned Hermes runtime canary proving the client policy and no-tools scope prevent native-memory writes on the relevant run types; a real-model evaluation remains separate.
- **Remaining work:** Keep PARTIAL until a hosted synthetic canary probes a unique secret through the pinned runtime and confirms it cannot be written/recalled; assess remaining secret formats and false positives; verify other Growth Partner run types that can expose Hermes-native memory; and run a real-provider acceptance if required by the deployment gate. | Skeptic review: the detector is heuristic, so passing its listed formats is not proof that arbitrary secrets are caught. Phone screening can also reject benign long numeric strings in app memory.
- **Verification evidence:** In this local worktree, focused secret-redaction, app-memory, chat-boundary and workforce-policy tests passed 31/31 across 4 files; the client role digest suite passed 4/4 after the review record was updated. `npm run typecheck`, targeted ESLint and `git diff --check` passed. These checks use synthetic fixtures and mock Hermes only; no Hermes runtime or real provider was exercised.
- **Definition of done:** App-owned memory and chat tests prove listed credential-shaped strings are rejected or redacted before persistence/Hermes; policy and per-run boundaries are pinned; hosted Hermes synthetic canary verifies no native-memory write/retrieval; limitations and remaining provider evidence are documented.

<a id="gp-mem-11"></a>
### GP-MEM-11 — Retention and deletion behavior (app memory, export, native memory, conversation)

- **Requirement:** Retention and deletion behavior (app memory, export, native memory, conversation) (directive §7)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** no
- **Source files:** `src/server/ai-growth-partner/memory.ts`, `src/server/offboarding/service.ts`, `src/server/offboarding/export.ts`, `src/server/chat/service.ts`, `docs/offboarding-and-export.md`
- **Test coverage:** delete and forget are covered in `tests/ai-growth-partner-memory.test.ts:121-123` and the fixture test; rollback guard in `tests/crm-migrations.test.ts`. `tests/offboarding.test.ts` and `tests/offboarding-runtime-profiles.test.ts` were not read in full. No test shows the purge removes `ai_growth_partner_memories` rows, that an export contains them, or any native-memory erasure.
- **Real or simulated behavior:** Real hard delete with audit for app notes; tenant purge deletes all org_id tables except PURGE_RETAINS so the table is purged by default (untested for Partner tables). Gaps: Remember message and model replies remain in the permanent conversation; no conversation retention control; no note TTL; data export has no Partner memory/Brain/goals/conversation; profile containment at offboarding deletes nothing so native MEMORY.md survives; no native Forget path.
- **Missing dependencies:** a Hermes-side deletion mechanism for profile memory (outside this repo: provisioner worker support is needed); counsel and founder input on conversation retention.
- **Remaining work:** Add Partner tables to EXPORT_TABLES in export.ts; purge test with a populated Partner tenant; provisioner job to wipe profile memories/sessions and make executeDeletion require it; owner-only per-message erase/redact for the permanent conversation; decide note TTL.
- **Verification evidence:** I read the offboarding service sections, the export table list and the memory service. The docs say permanent deletion is off by default (docs/offboarding-and-export.md).
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Export includes Partner memory; purge test covers it; native profile memory has a verified erase step; conversation retention is documented and tested.

<a id="gp-mem-12"></a>
### GP-MEM-12 — Auditability of memory changes

- **Requirement:** Auditability of memory changes (directive §7)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/ai-growth-partner/memory.ts`, `supabase/migrations/0130_ai_growth_partner_memory.sql`, `src/server/workforce/instructions.ts`
- **Test coverage:** `tests/ai-growth-partner-memory.test.ts:84-90` asserts the create audit row and that the note text is not in metadata. Update and delete audit rows, and the chat-source variants, are not asserted. No UI shows the audit trail (the panel shows `vN · updated <time>` only). Prior content is not recoverable, so an edit cannot be reviewed after the fact.
- **Real or simulated behavior:** Real in-transaction audit rows for create, update and delete (metadata only: kind, revision, characters, source) plus created_by/updated_by/source_message_id columns. Only the create audit row is asserted; no UI shows the trail; prior content is not recoverable. Native Hermes memory writes appear only as tool-execution names.
- **Missing dependencies:** none.
- **Remaining work:** Assert update, delete and chat-source audit rows in tests; show last changed by and source in the panel; optionally add a tenant-scoped revisions table with prior content.
- **Verification evidence:** I read the audit calls and the single audit assertion. Not run.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every memory mutation has a tested audit row; owners can see who changed what and when, with prior text if revisions are added.

<a id="gp-mem-13"></a>
### GP-MEM-13 — Complete synthetic-tenant memory lifecycle test (create, recall, update, conflict, delete, restart)

- **Requirement:** Complete synthetic-tenant memory lifecycle test (create, recall, update, conflict, delete, restart) (directive §7)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `tests/ai-growth-partner-memory.test.ts`, `tests/ai-growth-partner-fixture-acceptance.test.ts`, `tests/ai-growth-partner-unified-context-e2e.test.ts`, `scripts/ai-growth-partner-restart-acceptance.ts`
- **Test coverage:** see above. There is no test named for a lifecycle.
- **Real or simulated behavior:** Stages exist but are spread over four artifacts and no single test runs one tenant through all six. The conflict stage is only an optimistic-lock conflict. Restart stage is a manual SQL-seeded script. Missing: recall after update, prompt absent after delete, update/delete after restart, Brain-vs-note conflict.
- **Missing dependencies:** none.
- **Remaining work:** Add tests/ai-growth-partner-memory-lifecycle.test.ts for two synthetic tenants covering create (Remember: and panel), recall in buildRunInstructions, update, stale-edit and Brain-vs-note conflict, delete via Forget:, confirmation that prompt/search/export no longer contain it, audit rows per step, then a fresh-process restart repeating recall, update and delete; wire the restart part into CI. | Skeptic adds: The existing Forget acceptance (fixture-acceptance.test.ts:430-440) asserts only that conversation_history lacks the note. It never asserts that the follow-up run's composed instructions lack the deleted note, so 'deleted note is not recalled' is unproven at the prompt level. Include that assertion in the lifecycle test.
- **Verification evidence:** I traced each stage to a test or script by reading.
  - *Skeptic review: Narrows the 'recall absent after delete' gap with file:line evidence.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One named test passes in CI covering all six stages for two tenants including a fresh-process restart.

<a id="gp-mem-14"></a>
### GP-MEM-14 — Permanent conversation continuity and long-horizon recall

- **Requirement:** Permanent conversation continuity and long-horizon recall (directive §7)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/chat/service.ts`, `src/server/ai-growth-partner/service.ts`, `supabase/migrations/0121_ai_growth_partner_conversation.sql`
- **Test coverage:** `tests/ai-growth-partner-conversation.test.ts`, `tests/growth-partner-permanent-conversation-ui.test.tsx`, and the restart script. These show persistence and search, not that older context survives for the model.
- **Real or simulated behavior:** Real single canonical conversation per tenant, searchable by humans and recovered after restart. Model context is the last 20 turns plus memory/Brain/goals/legacy knowledge; no summarization and no model-accessible search of older conversation.
- **Missing dependencies:** none for a deterministic summary, a real model for quality evaluation.
- **Remaining work:** Decide between owner-visible rolling summaries (a distinct memory kind with provenance) and explicit-memory-only; if summaries are added, test recall past 20 turns.
- **Verification evidence:** I read the history assembly and the service signatures.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Documented, tested behavior for context older than 20 turns.

<a id="gp-mem-15"></a>
### GP-MEM-15 — Real-model memory acceptance: controlled harness

- **Requirement:** Real-model memory acceptance: controlled harness (directive §7)
- **Current implementation status:** NOT STARTED
- **Priority:** P1  |  **Evidence class:** not-applicable  |  **Unblocked now:** yes
- **Source files:** none (to create: `scripts/growth-partner-memory-real-model-acceptance.ts` or a vitest config like `scripts/builder-eval.vitest.config.ts`).
- **Test coverage:** none.
- **Real or simulated behavior:** Nothing exists. All memory acceptance uses the harness mock model or the Partner fixture mock. Docs say real-model memory behavior is untested.
- **Missing dependencies:** none to write the harness; running it needs GP-MEM-16.
- **Remaining work:** Create a gated script (explicit env flag, spend cap, synthetic tenants only, no outreach) checking: relevant-note recall, deleted-note non-use, Brain-over-note precedence, refusal of instruction-like note text, cross-tenant canary absence, secret canary not written to native memory, recall after real-Hermes restart; JSON result with model id and cost; excluded from the default suite; mock-model dry-run mode.
- **Verification evidence:** grep of scripts and tests found no such test.
- **Definition of done:** Reviewed harness exists, is excluded from the default suite, and its dry-run passes against the mock model.

<a id="gp-mem-16"></a>
### GP-MEM-16 — Real-model memory acceptance: execution

- **Requirement:** Real-model memory acceptance: execution (directive §7)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** depends on GP-MEM-15 and the pinned Hermes deployment.
- **Test coverage:** none.
- **Real or simulated behavior:** Not run.
- **Missing dependencies:** founder approval for paid model spend, a provider credential and model selection for the controlled test environment, and a Docker or VPS host able to run the pinned Hermes gateway with two synthetic profiles (Docker is unavailable on this machine).
- **Remaining work:** After approval, run the GP-MEM-15 harness once against synthetic tenants and record run id, model id, cost and results in docs/ai-growth-partner/implementation-status.md.
- **Verification evidence:** docs state that real-model memory behavior is untested; nothing contradicts that.
- **Definition of done:** A recorded run with model and spend where all GP-MEM-15 assertions pass.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Native Hermes memory is profile-wide, but customer-originated content runs with the same memory tool", "directiveRef": "§7 tenant/boundary and sensitive-data minimization; native memory", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "Verify on the pinned runtime whether a customer-conversation run (memoryScope iaq:<org>:contact:<id>) can write profile MEMORY.md and whether another customer's run or the owner's Partner chat then sees it. If so, run customer replies with the memory toolset withheld (a no-tools or memory-free scope) or add a write guard. Add a hosted-CI probe: customer A states a canary, customer B and the owner chat try to recall it. Evidence: responder.ts:149 comment claims per-customer isolation, but the proven store is one file per profile (acceptance_harness.py:355-368) and nothing in the repo partitions it."}
- {"title": "Workspace memory and goals flow into customer-facing replies (channel-level retrieval permission)", "directiveRef": "§7 retrieval permissions; tenant boundaries", "priority": "P1", "status": "IMPLEMENTED_UNVERIFIED", "remainingWork": "buildRunInstructions(..., ctx.customerMessage) at responder.ts:136 adds the owner's saved notes and goals to the prompt used to write customer SMS/WhatsApp/email replies, with retrieval driven by the customer's own words. Add a surface parameter so customer replies exclude internal notes (or only include notes marked customer-safe), then test with an internal-only note and a customer message that matches it."}
- {"title": "Customer-level app memory (contact_memories: confirmed_fact vs ai_summary) not audited", "directiveRef": "§7 persistent application memory; retention and deletion; auditability", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "A second app-owned store exists (migration 0019; responder.ts:193 injects confirmed facts into replies; inbox.ts:139 lists 30 rows incl. ai_summary). Audit: org_id filter missing on the two reads (they rely on contact_id and RLS), the secret and contact-detail screen (none seen on this path), who may write ai_summary, deletion is a soft delete (contacts.ts:351,387) so purge and export behaviour needs checking, and a Partner-era test of recall, update and delete."}
- {"title": "Memory-command parser swallows ordinary messages that start with Remember or Forget", "directiveRef": "§7 memory updates; conversational memory separation", "priority": "P2", "status": "IMPLEMENTED_UNVERIFIED", "remainingWork": "parseGrowthPartnerMemoryCommand returns 'clarify' for any message starting with 'remember' or 'forget' (e.g. 'Forget the old plan, what about leads?'), so the canned reply is sent and the model is never called (ai-growth-partner-memory.ts:20-31, chat/service.ts:2784-2796). The test pins this (ai-growth-partner-memory.test.ts:51). Decide whether to let non-colon forms through to the model."}
