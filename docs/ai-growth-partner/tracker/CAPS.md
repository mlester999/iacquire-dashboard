# CAPS — Capability system and customer support

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). The original audit baseline is commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`; GP-CAPS-17 was rechecked against current source at `bb63ebb3`.

Domain summary (historical read-only audit of branch claude/ai-growth-partner-completion, HEAD 6e4a4b7e; the GP-CAPS-17 row below was rechecked and verified on `bb63ebb3`; older domain-wide observations and test claims retain their original scope):

- The registry (src/lib/workforce-capabilities.ts:28) holds 14 reviewed capability keys, grouped for the Growth Partner into SIX domains (src/lib/ai-growth-partner-capability-access.ts:6; src/lib/ai-growth-partner.ts:7), not the eight A-H of the directive. 13 are read-only reviews or availability checks; one (`pipeline_followup_drafts`) is approval-required. There is no customer-support capability key, no outreach key and no CRM-write key: writes exist only as 12 chat "proposal" ids (src/lib/employee-tool-policy.ts:27) and as Hermes client MCP proposal tools that are off by default (HERMES_CLIENT_BUSINESS_MCP_ENABLED / _PROPOSALS_ENABLED plus per-workspace switches).
- The permission model is genuinely strong and real: role allowlist from the DB row, caller permission, Allowed-actions switches rechecked at dispatch AND at run time, requester re-authorization, agency pause/job gate, denial audit. It is exercised by PGlite database tests (tests/employee-ability-enforcement.test.ts, tests/employee-tool-policy.test.ts, tests/growth-partner-capability-dispatch.test.ts, tests/workforce-jobs.test.ts).
- What is missing from the model: no machine-readable input or output schema per capability (job `input` is `Record<string, unknown>`; `produces` is prose; each handler parses ad hoc), no retry policy field (retry is manual, or automatic only for a lost worker lease), no completion audit row in audit_logs for the read-only reviews (only ai_work_events).
- Customer support is real but sits OUTSIDE the capability model. Website chat uses a direct platform LLM call with no tools and only approved Knowledge Center sections (src/server/webchat/generator.ts:79); SMS/email/WhatsApp use the Growth Partner's Hermes runtime (src/server/messaging/responder.ts:132). Both go through the same escalation chain, claims net and restricted-topic guard, and these are well tested with fixtures and a mock Hermes gateway.
- Biggest support gaps: the Growth Partner now has per-fact Brain audiences and a restricted non-web customer prompt, but the pinned runtime has not been canary-tested for profile SOUL/native-memory isolation; replies carry no source attribution; "inquiry classification" is four regexes plus a model-chosen escalation label; no follow-up task is generated automatically from an escalation.
- Every model-dependent path is evidenced only by fixtures, a mock Hermes gateway and fixture LLM callbacks. No real-model, live OSM/website, live calendar or live messaging acceptance exists (docs themselves say so, implementation-status.md lines 124-126).

<a id="gp-caps-01"></a>
### GP-CAPS-01 — Capability registry and permission model

- **Requirement:** Capability registry and permission model (directive §8)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/workforce-capabilities.ts`, `src/lib/employee-tool-policy.ts`, `src/lib/ai-growth-partner-capability-access.ts`, `src/server/ai-growth-partner/capability-access.ts`, `src/server/workforce/abilities.ts`, `src/lib/agent-tool-scopes.ts`, `src/lib/ai-growth-partner.ts`
- **Test coverage:** tests/employee-tool-policy.test.ts (walks every role against every action; deny by default; growth_partner union equals six-role union; "exposes the six reviewed skill domains"); tests/employee-ability-enforcement.test.ts (all 14 capabilities refused when abilities are off; tables in step); tests/ai-growth-partner-capability-access.test.ts; tests/hermes-business-mcp-capability-matrix.test.ts. They prove permission and switch enforcement. They do not prove any per-capability input/output contract because none exists.
- **Real or simulated behavior:** Real static permission tables and real DB checks; no per-capability input/output schema exists.
- **Missing dependencies:** none external.
- **Remaining work:** Model eight capability areas A-H over the 14 keys (replace six-domain groups); add inputSchema/outputSchema/retry/approval fields to CapabilityDefinition and validate input in dispatchCapabilityJob; add registry-completeness test. | Skeptic adds: Add Growth Partner-role versions of the permission tests: the 'every one of the 14 capabilities is refused when abilities are off' loop deliberately skips growth_partner (it picks the first allowed role that is not growth_partner), and the GP dispatch test covers only performance_snapshot, lead_research (member refusal) and one switch-off. Extend tests/growth-partner-capability-dispatch.test.ts to loop all 14 keys with agentRole growth_partner.
- **Verification evidence:** I read workforce-capabilities.ts, employee-tool-policy.ts, abilities.ts, capability-access files and the test titles. Prior recorded: docs say "all 14 reviewed Growth Partner capabilities grouped into the six skill domains" (implementation-status.md:90).
  - *Skeptic review: The audit cites employee-ability-enforcement 'all 14 capabilities refused when abilities are off' as proof of the permission model for the Growth Partner. That test explicitly excludes the growth_partner role, so it proves the six legacy roles. The GP union ability list (ROLE_ABILITIES.growth_partner) is only exercised by a pure policy test plus one DB switch-off case. Status PARTIAL stays correct.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every capability has area A-H, permissions, validated input schema, output schema, retry rule and approval level; a test fails when a field is missing; malformed input is refused before a job exists; UI and docs show eight capabilities.

<a id="gp-caps-02"></a>
### GP-CAPS-02 — Execution path, retry rules, audit logging and failure states

- **Requirement:** Execution path, retry rules, audit logging and failure states (directive §8)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/capability-dispatch.ts`, `src/server/workforce/work-runner.ts`, `src/server/workforce/jobs.ts`, `src/server/workforce/action-policy.ts`, `src/server/workforce/read-only-review.ts`
- **Test coverage:** tests/workforce-jobs.test.ts (real research job stages, cancel, retry after failure, tenant-scoped jobs, idempotent key, rejects capability with no handler, lease expiry recovery, stale worker completion rejected); tests/growth-partner-capability-dispatch.test.ts (queues job under the one GP runtime row, rechecks Allowed actions when job starts, does not widen the person's permissions); tests/employee-ability-enforcement.test.ts ("a job queued before the switch was turned off blocks at run time ... and can be retried"); tests/workforce-review-capabilities.test.ts (refuses review when caller cannot use workforce). These prove the control flow against a real database.
- **Real or simulated behavior:** Real durable Postgres jobs, leases, events; handlers run real SQL; research handler uses a mock Hermes in tests.
- **Missing dependencies:** none.
- **Remaining work:** Automatic retry with backoff for transient handler failures (today manual or lost-lease only); audit_logs row for every terminal job state; test HANDLERS covers all capability keys; test dispatchSystemCapabilityJob refuses non-read-only capabilities. | Skeptic adds: Note two further weaknesses: (a) dispatchCapabilityJob writes a 'workforce.capability_dispatched' success audit row even when createWorkJob returned an existing job (created:false is ignored), so a replayed idempotency key produces duplicate audit rows and an audit entry for work that was not newly dispatched; (b) tests that stub registerWorkHandler (employee-ability-enforcement.test.ts:265) overwrite the global HANDLERS map, so those cases prove gating only, not the real handler.
- **Verification evidence:** read all four source files fully and the test titles. Prior recorded: implementation-status.md reports full regression passes (13,8xx tests); I did not rerun and cannot see the baseline.
  - *Skeptic review: Status IMPLEMENTED_UNVERIFIED is fair. Remaining-work item (4) is partly already done: tests/launch-sweep.test.ts already asserts dispatchSystemCapabilityJob refuses pipeline_followup_drafts (non-read-only), refuses another role's capability, an unknown key, and a paused employee. Only a table-driven 'every non-read-only key' version is missing, and only one non-read-only key exists today.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Transient failures auto-retry within maxAttempts with visible reason; every terminal state writes an audit row; completeness and system-dispatch refusal tests pass.

<a id="gp-caps-03"></a>
### GP-CAPS-03 — Honest reporting of an unavailable tool, connector or provider

- **Requirement:** Honest reporting of an unavailable tool, connector or provider (directive §8)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/employee-evidence.ts`, `src/server/workforce/employee-evidence.ts`, `src/lib/ai-growth-partner-capability-access.ts`, `src/server/workforce/abilities.ts`, `src/server/workforce/work-runner.ts`, `src/server/leads/research-job.ts`, `src/lib/employee-capability-status.ts`
- **Test coverage:** tests/employee-capability-status.test.ts; tests/ai-growth-partner-capability-access.test.ts; tests/growth-partner-capability-readiness-ui.test.tsx; tests/employee-ability-enforcement.test.ts (refusal text, "nothing was started"); tests/ai-growth-partner-fixture-acceptance.test.ts:354,446 (blocks research when no-tools boundary cannot be verified or all sources disabled); tests/internal-employee-capability-context.test.ts. They prove the states are computed and refused on real tenant data. They do not prove what a real model says to the user (no real-model test).
- **Real or simulated behavior:** Real server state machine (ready/empty/not_configured/unavailable/no_permission/switched_off) over tenant data; model wording is only prompt-instructed and never tested with a real model.
- **Missing dependencies:** real model run to verify wording compliance (external, see GP-CAPS-19).
- **Remaining work:** GP evidence snapshot lacks inbox/support, reputation, receivables, social, webchat sections; capability 'available' status ignores provider readiness (calendar, lead sources, messaging channel, LLM); add per-capability missing-connector reason + link in Control Center and chat; table-driven test per capability with provider missing. | Skeptic adds: The Growth Partner's evidence snapshot advertises an EMPTY chat-request list ('Nothing can be started from this chat by this person right now' and 'Anything not listed (changing a record, creating a task, proposal, approval or booking ...) cannot be done from this chat') even though chat/service.ts has working Growth Partner handlers for contact create, opportunity create/move, booking preview, appointment change, calendar create and appointment policy. Wire a GP-specific chat-request list into chatRequestsSection so the partner neither under-claims (telling a user it cannot create a contact) nor leaves its real actions undescribed; add a test that the GP evidence block lists what the handlers actually support.
- **Verification evidence:** read employee-evidence.ts head and the GP section map, EVIDENCE_STATE_GUIDE, capability-access derivation, abilities.ts and work-runner.ts. Prior recorded: docs claim client status cards "explain access, permitted tools, service limits and approval rules" (implementation-status.md:40).
  - *Skeptic review: Honest-reporting gap the audit missed: the section is deliberately blank for growth_partner with a code comment saying the permanent conversation does not use the legacy router yet, but the server handlers exist and are keyed to growth_partner. The failure direction is under-claiming (safe) but it contradicts real capabilities and may cause the model to refuse or mis-direct valid requests.*
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Removing any capability's provider/setting yields a specific tested user-visible explanation with a link; blocked jobs never reported as success.

<a id="gp-caps-04"></a>
### GP-CAPS-04 — A. Lead Discovery

- **Requirement:** A. Lead Discovery (directive §8)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/leads/research-job.ts`, `src/server/leads/research-source-runner.ts`, `src/server/leads/openstreetmap-source.ts`, `src/server/leads/company-website-source.ts`, `src/server/leads/research-source-policy.ts`, `src/server/leads/research-contract.ts`, `src/server/leads/scheduled-research.ts`, `src/server/workforce/lead-generation-review.ts`, `src/lib/workforce-chat-targeting-intent.ts`
- **Test coverage:** tests/workforce-jobs.test.ts:162 (real research job, genuine stages, source-backed leads), :249 cancel, :273 retry; tests/ai-growth-partner-fixture-acceptance.test.ts:354,446,522 (blocks before source access without no-tools capability; blocks when sources disabled; persists fixture research+qualification+CRM review in one isolated partner thread); tests/lead-research-source-policy.test.ts; tests/research-source-policy-action.test.ts; tests/research-source-settings-acceptance.test.tsx; tests/workforce-lead-generation.test.ts; tests/research-intent.test.ts. They prove the pipeline, policy, dedupe and stage honesty with fixtures; they do not prove real source behaviour, rate limits, robots/terms handling or any live result.
- **Real or simulated behavior:** Real worker, policy and adapters exercised with injected local OSM/website fixtures on fictional .test domains and a mock Hermes; no live source ever called.
- **Missing dependencies:** owner approval and a controlled test tenant for live OSM/Overpass and company-website reads; recheck of provider terms (docs/ai-growth-partner/acquisition-source-research.md says all other sources X/LinkedIn/Reddit/Meta/Indeed/Yelp etc. are undecided or restricted).
- **Remaining work:** Only two source adapters exist; decide discovery behaviour when sources disabled; end-to-end test approved lead -> CRM with provenance; live acceptance tracked in GP-CAPS-19.
- **Verification evidence:** read research-job.ts header/blocked paths, the contract file functions, and test titles. Prior recorded: docs lines 46,124 "No live OpenStreetMap request, public company website crawl ... or outreach was made. Source evidence remains synthetic."
  - *Baseline: 7 of 7 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A recorded live run for an approved tenant yields source-backed candidates; disabled/missing sources show actionable blocks; leads reach CRM only via approval with provenance.

<a id="gp-caps-05"></a>
### GP-CAPS-05 — B. Lead Qualification

- **Requirement:** B. Lead Qualification (directive §8)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/leads/research-contract.ts`, `src/server/leads/research-job.ts`, `src/server/lead-scoring/service.ts`, `src/server/lead-scoring/priority.ts`, `src/server/workforce/lead-priority-review.ts`, `src/server/webchat/visitor.ts`, `src/lib/webchat/rules.ts`
- **Test coverage:** tests/lead-scoring-service.test.ts (insufficient-data lead gets no score, history, hand score never overwritten, overrides expire), tests/lead-scoring-engine.test.ts, tests/lead-scoring-ai-gate.test.ts (credit/pause gates), tests/webchat-leads.test.ts:126 (qualification answers, completion announced once), tests/workforce-jobs.test.ts research qualification, tests/ai-growth-partner-fixture-acceptance.test.ts (qualified/disqualified/duplicate/missing-info fixtures). Prove deterministic behaviour; do not prove the quality of qualification against real leads or that criteria come from the client's confirmed Brain.
- **Real or simulated behavior:** Deterministic rule code and scoring engine over real DB; the model only supplies research output.
- **Missing dependencies:** none for code; real-lead quality evaluation needs live data (GP-CAPS-19).
- **Remaining work:** Use confirmed Brain idealCustomers.qualification/disqualifiers/minimumBudget deterministically in qualifyCandidate; add a chat-invocable read-only qualification capability for a named lead; show deciding rule; tests where Brain disqualifiers change outcome.
- **Verification evidence:** read research-contract.ts qualification code and persistence in research-job.ts; titles of the lead-scoring tests. Prior recorded: docs list qualified/disqualified/duplicate/missing-information fixtures (implementation-status.md:46).
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A confirmed Brain disqualifier deterministically disqualifies a matching candidate with the fact cited; a chat request qualifies a named lead read-only and states the rule.

<a id="gp-caps-06"></a>
### GP-CAPS-06 — C. CRM Management

- **Requirement:** C. CRM Management (directive §8)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/chat/service.ts`, `src/lib/workforce-chat-crm-intent.ts`, `src/server/workforce/crm-quality-review.ts`, `src/server/crm/agent-tools/catalog.ts`, `src/server/crm/agent-tools/service.ts`, `src/lib/agent-tool-scopes.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts`, `src/server/proposals/crm-effects.ts`, `src/server/approvals/service.ts`
- **Test coverage:** tests/growth-partner-crm-ability.test.ts (migration 0132; switch enforced on direct API calls; earlier approval blocked after switch-off; tenant-scoped gate); tests/workforce-chat-crm-intent.test.ts; tests/workforce-chat-e2e.test.ts; tests/crm-growth-integration.test.ts; tests/workforce-review-capabilities.test.ts:197,219,253 (crm quality review, task from finding, pipeline review); tests/hermes-business-mcp-capability-matrix.test.ts (reads only, writes nothing). Prove tenant-scoped, approval-gated behaviour in the app; do not prove a real model uses the tools correctly.
- **Real or simulated behavior:** Real native CRM services and approval flow in PGlite; Hermes MCP tools exercised only against mock gateway/synthetic tenants and are OFF by default.
- **Missing dependencies:** operator enabling HERMES_CLIENT_BUSINESS_MCP_ENABLED and per-workspace client_business_tools / client_business_proposals for any real use (config/approval); real-model tool-use verification.
- **Remaining work:** Update/tag/merge/note only via dormant MCP proposals (no chat path, no merge/duplicate-resolution proposal); verify approved effects write history with agent actor; refusal wording when another CRM system holds records; real-gateway client-tier test.
- **Verification evidence:** read catalog.ts, ROLE_SCOPES, client MCP policy, chat intent handler signatures, and test titles. Prior recorded: docs line 87 "With crm.request_update off, the direct update call created neither an approval nor a tool token; with it on ..." (synthetic tenants).
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** From chat a person can create/update/tag/note a contact and create/move a deal, each as one approval with history and duplicate warning; paths refuse clearly when switch/CRM disallows; cross-tenant refusal tested.

<a id="gp-caps-07"></a>
### GP-CAPS-07 — D. Appointment Setting

- **Requirement:** D. Appointment Setting (directive §8)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/chat/service.ts`, `src/server/workforce/appointment-availability.ts`, `src/server/workforce/appointment-review.ts`, `src/server/workforce/missed-call-review.ts`, `src/server/appointments/availability.ts`, `src/server/appointments/booking.ts`, `src/server/messaging/responder.ts`, `src/lib/employee-tool-policy.ts`
- **Test coverage:** tests/appointment-setter-acceptance.test.ts:120-225 (exact open times in host zone, never invents availability, previews without holding, approval creates exactly one appointment with buffer), tests/appointments.test.ts, tests/workforce-chat-booking-intent.test.ts, tests/workforce-chat-appointment-change-intent.test.ts, tests/workforce-chat-appointment-policy-intent.test.ts, tests/workforce-chat-calendar-create-intent.test.ts, tests/workforce-calendar*.test.ts, tests/webchat-ai.test.ts:171-244 (offers only calendar times; books nothing for an unlisted time), tests/workforce-review-capabilities.test.ts:282,305,330. Strong database-backed coverage using mock/fixture providers.
- **Real or simulated behavior:** Real native calendar/booking services with person approval; fixture/mock providers; no live external calendar or transport.
- **Missing dependencies:** live calendar provider credentials and a live messaging transport for confirmation messages (external; docs line 125 says provider connector behavior and source-to-booking conversion remain unverified).
- **Remaining work:** Live provider acceptance; customer-facing reschedule path via responder; end-to-end test that booking suppresses AI follow-ups for the GP identity.
- **Verification evidence:** read bookingBlock/respond booking branch, chat booking handler signatures, and test titles. Prior recorded: docs line 125 above; no live provider run.
  - *Skeptic review: The audit's status IMPLEMENTED_UNVERIFIED is supportable and somewhat conservative: the Growth Partner chat booking path is exercised for the growth_partner role with a real approval row (booking previewed, nothing booked until 'confirm booking', then awaiting_approval with requested_by_kind ai and agent_id equal to the GP agent). The audit's cited acceptance tests (appointment-setter-acceptance, webchat-ai) run the legacy appointment_setter or role-agnostic paths, so cite the e2e test as the GP evidence. One caveat for the customer-facing path: the responder books through requestBooking with actor ai, and whether a person approves depends on the workspace's booking policy, not on a fixed preview-then-approve rule as the audit text implies for all channels.*
  - *Baseline: 8 of 8 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A live run books one approved appointment from chat and website chat with a real confirmation delivered; cancel/reschedule covered the same way.

<a id="gp-caps-08"></a>
### GP-CAPS-08 — E. Sales Assistance

- **Requirement:** E. Sales Assistance (directive §8)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/pipeline-followup-drafts.ts`, `src/server/workforce/pipeline-review.ts`, `src/server/workforce/lead-priority-review.ts`, `src/lib/workforce-chat-assignment.ts`, `src/server/messaging/inbox-ai.ts`, `src/server/crm/agent-tools/catalog.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts`
- **Test coverage:** tests/workforce-review-capabilities.test.ts:253,488 (pipeline review changes nothing; follow-up drafts require inbox.reply), tests/pipeline-draft.test.ts, tests/workforce-chat-assignment.test.ts, tests/workforce-chat-routing.test.ts. Prove drafts are unsent, bounded, permission-gated and idempotent; prove nothing about sales content quality.
- **Real or simulated behavior:** Real stale-deal SQL and real unsent drafts, but draft text is a fixed template (buildFollowUpDraft); no model or Brain-grounded sales content.
- **Missing dependencies:** none external. Real-model drafting needs paid model spend for evaluation.
- **Remaining work:** Brain-grounded follow-up/proposal/discovery-call drafts through the claims net and approval; tone from Brain; objection handling and call prep; consent/opt-out and unapproved-price tests.
- **Verification evidence:** read pipeline-followup-drafts.ts top 120 lines (static template confirmed), tool catalog and the client-tier never-offered list, router text. Prior recorded: none specific for sales content.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** From chat the partner prepares a Brain-grounded unsent draft for a named opportunity, claims-checked and approval-gated, with source awareness.

<a id="gp-caps-09"></a>
### GP-CAPS-09 — F. Customer Support as a permissioned capability

- **Requirement:** F. Customer Support as a permissioned capability (directive §8, §14)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/responder.ts`, `src/server/webchat/generator.ts`, `src/server/messaging/ingest.ts`, `src/server/webchat/config.ts`, `src/lib/webchat/rules.ts`, `src/server/workforce/compiler.ts`, `src/lib/ai-growth-partner.ts`
- **Test coverage:** tests/webchat-service.test.ts:38 ("defaults new Growth Partner workspaces to the same identity in website chat"), :160 (visitor chat answered through the same reply path), tests/messaging-responder.test.ts (fixture/mock Hermes), tests/webchat-ai.test.ts. They prove the reply path, not that support is a governed capability.
- **Real or simulated behavior:** Reply behaviour is real (responder, webchat, escalation) but outside the capability registry/permissions/Allowed actions/evidence; website chat is a direct platform LLM call not the Hermes partner; models are fixtures/mocks.
- **Missing dependencies:** none external.
- **Remaining work:** Add customer_support capability area with permissions and an Allowed-actions switch enforced at responder start; evidence snapshot section; support summary capability; resolve website-chat-is-not-the-partner-runtime claim.
- **Verification evidence:** read responder.ts, webchat generator/config, ingest.ts assignment SQL, compiler.ts GP summary. Prior recorded: docs line 19 "Website-chat health names the AI Growth Partner when that is the assigned runtime".
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Customer Support has explicit permissions and switch; switching it off stops AI replies and escalates; Control Center, evidence and Work Board show its state; test proves the switch blocks webchat and SMS/email.

<a id="gp-caps-10"></a>
### GP-CAPS-10 — G. Office and Workflow Operations

- **Requirement:** G. Office and Workflow Operations (directive §8)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/proactive-review.ts`, `src/server/workforce/reports.ts`, `src/server/workforce/finding-actions.ts`, `src/server/workforce/schedules.ts`, `src/server/chat/service.ts`, `src/server/chat/workforce-handoff.ts`, `src/server/workforce/work-board.ts`
- **Test coverage:** tests/workforce-proactive-review.test.ts, tests/workforce-proactive-delivery.test.ts, tests/workforce-schedules.test.ts, tests/workforce-schedule-recurrence.test.ts, tests/workforce-schedule-windows.test.ts, tests/workforce-chat-schedule-intent.test.ts, tests/workforce-review-capabilities.test.ts:219 (finding becomes one idempotent assigned task), tests/workforce-chat-outbound-control-intent.test.ts, tests/workforce-triggers.test.ts. Prove DB-backed scheduling/reporting; not live delivery.
- **Real or simulated behavior:** Real Work Board, schedules, reports and tasks-from-findings in Postgres; Automation Studio deliberately not driven by the partner.
- **Missing dependencies:** none external (email delivery of briefings uses the existing email provider; unverified live).
- **Remaining work:** Define scope; add chat task create/assign intent with approval and an Allowed-actions switch (create_task is not gated for GP); notes/reminders; test scheduled work respects pause/business hours with visible blocked reasons.
- **Verification evidence:** read the job registry, chat handler list and the refusal text for automation requests; test titles. Prior recorded: docs lines 92,212 (chat schedule pause/resume; due-schedule worker fix).
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Partner creates and tracks a task from chat with approval and audit, schedules review work, explains blockers on the Work Board; documented scope.

<a id="gp-caps-11"></a>
### GP-CAPS-11 — H. Performance Reporting

- **Requirement:** H. Performance Reporting (directive §8)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/performance-snapshot.ts`, `src/server/workforce/social-review.ts`, `src/server/workforce/receivables-review.ts`, `src/server/workforce/reputation-review.ts`, `src/server/workforce/read-only-review.ts`, `src/server/workforce/reports.ts`, `src/server/workforce/employee-evidence.ts`
- **Test coverage:** tests/workforce-review-capabilities.test.ts:366,401,420 (measured KPIs, AI figures hidden from a Team member, month comparison in workspace zone), tests/social-review.test.ts, tests/invoices-receivables-review.test.ts:176 (reads nothing of another workspace), tests/reputation-review-capability.test.ts:181 (counts only own workspace), tests/crm-performance.test.ts. Good real-path coverage, mostly with synthetic rows.
- **Real or simulated behavior:** Real SQL metrics with stated period/definition/source; no model decides numbers.
- **Missing dependencies:** none.
- **Remaining work:** Compare against confirmed goals/reporting cadence from Brain; add cross-tenant test for performance_snapshot; verify chat summary repeats data limits. | Skeptic adds: Remove remaining-work item (1) 'compare against Brain goals'. Only the cross-tenant test for performance_snapshot specifically and the 'chat summary repeats data limits' check remain, plus running the goal comparison for period=last_30_days (goals attach only when input.period is current_month).
- **Verification evidence:** read registry text, test titles, evidence section map. Prior recorded: docs line 271 (proactive review tenant-scoped counts).
  - *Skeptic review: Too pessimistic on goals: runPerformanceSnapshotJob already loads the Growth Partner's monthly goal targets and attaches goal {targetValue, cadence, percentComplete} to matching metrics for the current_month period, and a real DB test asserts the exact object. Also the cross-tenant claim is overstated: tests/internal-workforce-capabilities.test.ts seeds a foreign tenant 'Foreign Tenant Secret Company/Lead' as a tripwire and dispatches performance_snapshot, then asserts the foreign names never appear in any result. That is a weak (absence-of-string) check but it is a cross-tenant check for this capability.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Reports state period, source and limits, compare against confirmed goals, never fabricate a benchmark, with a tested cross-tenant refusal.

<a id="gp-caps-12"></a>
### GP-CAPS-12 — Support: FAQ answers sourced from knowledge and Business Brain with source awareness

- **Requirement:** Support: FAQ answers sourced from knowledge and Business Brain with source awareness (directive §14)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/webchat/generator.ts`, `src/lib/webchat/rules.ts`, `supabase/migrations/0087_website_chat.sql`, `src/server/knowledge/service.ts`, `src/server/ai-growth-partner/service.ts`, `src/lib/ai-growth-partner.ts`, `src/server/workforce/service.ts`
- **Test coverage:** tests/webchat-ai.test.ts:44-75 (only exposed, approved sections; no prices unless opted in; says so when no knowledge), tests/ai-growth-partner-legacy-knowledge.test.ts, tests/ai-growth-partner-unified-context-e2e.test.ts, tests/ai-growth-partner-foundation.test.ts (retrieval). Fixture LLM callbacks only.
- **Real or simulated behavior:** Website chat stuffs approved Knowledge Center sections into a platform LLM prompt; non-web path uses keyword-scored Brain facts; Brain sync is one-way; fixture models only.
- **Missing dependencies:** real model for answer-quality evaluation.
- **Remaining work:** Persist and display which sections/Brain facts a reply used; pick one public source of truth for both channels; FAQ item model beyond 4,000/16,000 char stuffing; retrieval tests for support-style questions.
- **Verification evidence:** read generator.ts fully, retrieveBusinessBrainFacts, insertActiveBusinessBrain, sync function names. Prior recorded: docs line 38 (retained knowledge review) only; nothing about customer support.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A FAQ question is answered from that FAQ, reply records sources visible to staff, uncovered questions escalate, one documented public knowledge source drives both channels.

<a id="gp-caps-13"></a>
### GP-CAPS-13 — Support: unknown-answer handling and no fabricated policy, prices or guarantees

- **Requirement:** Support: unknown-answer handling and no fabricated policy, prices or guarantees (directive §14)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/responder.ts`, `src/lib/customer-topic-guard.ts`, `src/server/webchat/reply-check.ts`, `src/server/webchat/amounts.ts`, `src/server/social/claims.ts`, `src/server/webchat/generator.ts`
- **Test coverage:** tests/messaging-responder.test.ts:218-290 (holds "10% off", price check against approved knowledge, never uses another workspace's knowledge, approval policy), :292-378 (restricted topics escalate before the model is called), tests/webchat-ai.test.ts:77-157, tests/webchat-generator-checks.test.ts, tests/customer-topic-guard.test.ts, tests/webchat-metering.test.ts. Strong and real-path, but with fixture models; regex nets are bounded heuristics.
- **Real or simulated behavior:** Real server-side nets and restricted-topic guard before the model; model is a fixture/mock; nets are regex heuristics.
- **Missing dependencies:** real-model red-team run (paid spend, external).
- **Remaining work:** Add real-model adversarial regression and improve grounding for policy/cancellation/refund/timeline claims. Growth Partner non-web claims now use customer-safe Brain facts; other employee replies use approved Knowledge Center content. The pre-model restricted-topic guard remains opt-in, not a default floor: restrictedTopicsFor returns only the topics the client selected in a confirmed onboarding answer (plus pricing when the client said never share prices). A workspace that skipped or has not confirmed c.sensitive_topics has no server-side legal, medical, safety, warranty or complaint topic guard at all (only the four ingest regexes for human/refund/complaint/phone). Add a non-removable default set (legal, medical, safety) that always escalates, and a test with no onboarding answers asserting 'my child swallowed the medication' or 'gas leak' is escalated before any model call.
- **Verification evidence:** read responder.ts and generator.ts in full, reply-check.ts, customer-topic-guard.ts. Prior recorded: none in docs for support specifically.
  - *Skeptic review: Status IMPLEMENTED_UNVERIFIED is fair, but the audit's description 'restricted-topic guard run BEFORE any model call' reads as a universal protection. It protects only what the client selected; for everything else it depends on the model following the prompt or on regex claim nets that check amounts and promises, not on safety or legal content. For a P0 row this deserves an explicit remaining-work line.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
  - *Follow-up at `bb63ebb3`: the non-web Growth Partner claim net is now checked against customer-safe Brain facts; focused application-boundary tests passed in the same 3-file / 38-test run documented for GP-CAPS-17.*
- **Definition of done:** 50+ fabrication attempts against the real model yield zero unapproved claims sent; each is an escalation or approved text.

<a id="gp-caps-14"></a>
### GP-CAPS-14 — Support: human handoff, escalation routing and activity history

- **Requirement:** Support: human handoff, escalation routing and activity history (directive §14)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/handoff.ts`, `src/lib/escalation.ts`, `src/server/messaging/ingest.ts`, `src/server/messaging/events.ts`, `src/server/webchat/visitor.ts`, `src/server/webchat/respond.ts`, `src/server/staff/service.ts`
- **Test coverage:** tests/messaging-handoff.test.ts (owner window 2/5 minutes, configurable, owner away/busy, concurrent claimants, unauthorized and other-workspace refusal, urgent queue, existing escalation reused, takeover/resume safety checks, who can see which conversations), tests/webchat-service.test.ts:286-355 (handoff button, team reply stops AI, unavailable assistant tells the visitor and asks a person), tests/messaging-responder.test.ts:98,109. Strong real-path coverage.
- **Real or simulated behavior:** Fully real DB logic with owner-first windows, eligible staff, atomic claim, takeover, audit and conversation trail; live alert delivery unverified.
- **Missing dependencies:** none external; live email/SMS delivery of alerts unverified.
- **Remaining work:** Route by Brain escalationContacts/handoffRules or document staff availability as source; Control Center view of aged escalations; test no-one-available visitor message.
- **Verification evidence:** read handoff.ts (createEscalation, claim, giveToHuman), escalation.ts, respond.ts, visitorView, test titles. Prior recorded: none in docs.
  - *Skeptic review: Claim holds (owner-first windows, atomic claim, takeover, audit rows for created, opened_to_staff, claimed, declined, resolved, taken_over, resumed). Remaining-work item (4) is partly already satisfied: the nobody-available escalation path is tested in tests/messaging-handoff.test.ts:171 (visible urgent queue plus owner and manager alert), and the visitor-facing wording for an unavailable assistant is in webchat-service. Only the combination (visitor sees honest wait copy when nobody is available) lacks a single test. No status change.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Existing behaviour retained plus Brain-driven routing and an operator view of aged escalations, each tested.

<a id="gp-caps-15"></a>
### GP-CAPS-15 — Support: inquiry classification and follow-up task generation

- **Requirement:** Support: inquiry classification and follow-up task generation (directive §14)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/ingest.ts`, `src/lib/customer-topic-guard.ts`, `src/lib/escalation.ts`, `src/server/messaging/responder.ts`, `src/server/messaging/inbox-context.ts`, `src/server/messaging/followups.ts`, `src/server/workforce/finding-actions.ts`
- **Test coverage:** tests/messaging-handoff.test.ts:226 (plain request for a person is never ignored), tests/customer-topic-guard.test.ts, tests/messaging-responder.test.ts:174. No test of automatic task generation or an intent taxonomy because neither exists.
- **Real or simulated behavior:** Four regexes pre-model plus model-chosen escalation label; customer follow-up sequences real; CRM task from a conversation only by a person.
- **Missing dependencies:** none external.
- **Remaining work:** Persist support_intent classification on conversations; auto-create one idempotent assigned task per escalation/unknown answer; knowledge-gap list from unanswered questions; tests for taxonomy, idempotency, cross-tenant.
- **Verification evidence:** grepped createTask usage in messaging/webchat/workforce (only inbox-context.ts manual), read detectEscalationSignal and ESCALATION_CATEGORIES. Prior recorded: none.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Each inbound support conversation has a stored classification; an escalation or unknown answer creates exactly one assigned task; owner sees repeat unanswered questions.

<a id="gp-caps-16"></a>
### GP-CAPS-16 — Support: no private account or business data disclosed to unauthenticated website visitors

- **Requirement:** Support: no private account or business data disclosed to unauthenticated website visitors (directive §14)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/webchat/generator.ts`, `src/server/webchat/visitor.ts`, `src/server/webchat/http.ts`, `src/server/webchat/route.ts`, `src/server/webchat/config.ts`, `src/lib/webchat/identity.ts`, `src/server/webchat/context.ts`, `src/server/messaging/responder.ts`
- **Test coverage:** tests/webchat-service.test.ts:86-157 (public settings only, origin refusal, key isolation between workspaces), :194 (token from another workspace opens no session), :230 (never shows internal notes, drafts, blocked replies); tests/webchat-leads.test.ts:94 ("a visitor who types someone else's address is never merged ... and learns nothing about them"); tests/webchat-ai.test.ts:77 (hostile message stays data); tests/webchat-site.test.ts; tests/webchat-switch.test.ts. Strong real-path coverage.
- **Real or simulated behavior:** Real public route/session/DB design; AI sees only approved exposed knowledge with no tools; fixture LLM.
- **Missing dependencies:** none external.
- **Remaining work:** Assert prompt contents contain no CRM/account/other-contact/Brain-internal text; account-claim attempt must not unlock records; guard that no tool is reachable from public path; exfiltration prompt-injection tests beyond the narrow leak regex.
- **Verification evidence:** read visitor.ts functions (session, lead capture, view), generator.ts, context.ts and test titles. Prior recorded: none specific in docs.
  - *Skeptic review: Claim is substantially upheld for the website widget path: the generator passes only approved, risk-flag-free, widget-exposed company_knowledge sections (default set excludes prices, customer_service and escalation), sends no tools, and visitorView returns only visitor-visible messages scoped by org and conversation. Confirmed first-hand. But the row's scope is the website only; the same unauthenticated-sender risk exists on SMS, email and WhatsApp customer runs through hermesReplyGenerator and is not covered by this row (see missed requirements). Do not read the P0 favourable status as covering all customer channels.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Tests prove an anonymous visitor retrieves nothing outside exposed approved sections and their own conversation, including adversarial prompts and account-claim attempts, with prompt-content assertions.

<a id="gp-caps-17"></a>
### GP-CAPS-17 — Support: separation of internal Business Brain/memory from public customer-facing information (non-web channels)

- **Requirement:** Support: separation of internal Business Brain/memory from public customer-facing information (non-web channels) (directive §14)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/responder.ts`, `src/server/workforce/service.ts`, `src/lib/ai-growth-partner.ts`, `src/server/ai-growth-partner/memory.ts`, `src/server/ai-growth-partner/goals.ts`
- **Test coverage:** `tests/brain-customer-audience.test.ts` covers audience defaults and compiled-profile filtering. `tests/workforce-chat-business-brain-e2e.test.ts` verifies non-web customer prompt canaries, public Brain grounding, no-tools/native-memory scope, and fail-closed behavior on the mock Hermes path. `tests/messaging-responder.test.ts` covers the non-Growth-Partner approved-knowledge claim net.
- **Real or simulated behavior:** The application now keeps confirmed customer-safe Brain facts in the Growth Partner customer prompt, removes compiled role/context/free-form preferences and private sources, omits app goals/memory and Hermes-native memory scope, requires Hermes to verify a no-tools run, and grounds claim checks against customer-safe Brain facts only. PGlite plus mock Hermes verifies this boundary; no real model or live gateway was used.
- **Missing dependencies:** none for application-side controls. Pinned-runtime validation is still needed to determine whether the shared profile SOUL or memory backend can inject context outside the app's per-run prompt and no-tools overlay.
- **Remaining work:** Keep PARTIAL until a pinned-runtime canary proves customer-originated content cannot reach another customer's reply or the owner's internal Partner chat, and verifies the no-tools overlay blocks every runtime tool. If the runtime injects shared profile context despite the overlay, move customer replies to a narrowed profile. Add a real-model grounding evaluation before claiming end-to-end verified behavior.
- **Verification evidence:** Commit `bb63ebb3` (`fix: isolate Growth Partner customer replies`): 3 focused files / 38 tests passed; `npm run typecheck`, targeted ESLint and `git diff --check` passed. The run used a synthetic PGlite tenant and mock Hermes only.
  - *Historical audit at 6e4a4b7e accurately described the older leak path but is superseded by the source and focused evidence above.*
- **Definition of done:** Customer-channel Growth Partner runs receive only customer-safe Brain facts and the current customer conversation; private profile instructions, internal facts, goals, app memory and runtime tools are unavailable; unsupported claims are checked against the customer-safe source. Pinned-runtime and real-model evidence are required before marking verified.

<a id="gp-caps-18"></a>
### GP-CAPS-18 — Cross-capability tenant-isolation and integration test coverage

- **Requirement:** Cross-capability tenant-isolation and integration test coverage (directive §8)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/read-only-review.ts`, `src/server/workforce/capability-dispatch.ts`, `src/server/workforce/work-runner.ts`
- **Test coverage:** tests/tenant-isolation.test.ts, tests/tenant-isolation-generic.test.ts, tests/workforce-jobs.test.ts:288 (tenant-scoped jobs), tests/employee-ability-enforcement.test.ts:184 (other workspace untouched), tests/employee-tool-policy.test.ts:253 (other workspace's employee is not found), tests/growth-partner-crm-ability.test.ts:194, tests/social-review.test.ts:246, tests/invoices-receivables-review.test.ts:176, tests/reputation-review-capability.test.ts:181, tests/missed-call-ops.test.ts:28, tests/hermes-business-mcp-capability-matrix.test.ts, tests/messaging-handoff.test.ts:158, tests/webchat-service.test.ts:107,194. Gap found by reading: tests/workforce-review-capabilities.test.ts uses ONE organization (createOrg once, line 38) for crm_quality_review, pipeline_review, appointment_review, appointment_availability and performance_snapshot, so none of those five proves another tenant's rows are excluded; lead_generation_review, proactive_review and lead_priority_review have no cross-tenant data assertion that I found.
- **Real or simulated behavior:** Real PGlite tests with synthetic tenants; tests/workforce-review-capabilities.test.ts uses one organization so crm_quality_review, pipeline_review, appointment_review, appointment_availability and performance_snapshot have no cross-tenant data assertion.
- **Missing dependencies:** none.
- **Remaining work:** Table-driven two-tenant canary test over all 14 handlers; dispatch refusal for another tenant's agent for all 14; one end-to-end test per capability area A-H; RLS tests for ai_work_events visibility. | Skeptic adds: Correct the gap list: tests/internal-workforce-capabilities.test.ts already seeds a foreign tenant (crm_companies and leads rows) as a tripwire and dispatches appointment_availability, pipeline_followup_drafts, crm_quality_review and performance_snapshot, then asserts no 'Foreign Tenant Secret' string in any result. The real uncovered handlers are pipeline_review (only indirectly via the follow-up drafts candidate query), appointment_review, lead_generation_review, proactive_review and lead_priority_review, and the existing tripwire is an absence-of-string check against only two foreign tables (companies, leads), not deals, bookings or conversations.
- **Verification evidence:** grepped org usage in the review test file and cross-tenant phrases across related tests. Prior recorded: docs cite synthetic isolation coverage for chat/Brain/migration (implementation-status.md:9).
  - *Skeptic review: The audit says five handlers (crm_quality_review, pipeline_review, appointment_review, appointment_availability, performance_snapshot) have no cross-tenant data assertion. That is wrong for crm_quality_review, appointment_availability and performance_snapshot (and pipeline_followup_drafts), which have a weak tripwire. PARTIAL stays right, but the gap is smaller and differently shaped, and the proposed table-driven test is still worthwhile because the tripwire seeds too few tables.*
  - *Baseline: 13 of 13 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One generated test proves for every capability that a second tenant's data never appears; per-area integration tests pass in CI.

<a id="gp-caps-19"></a>
### GP-CAPS-19 — Live-model and live-provider verification of the capabilities

- **Requirement:** Live-model and live-provider verification of the capabilities (directive §8, §14)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** externally-blocked  |  **Unblocked now:** no
- **Source files:** `services/hermes-business-mcp-acceptance`, `docs/ai-growth-partner/implementation-status.md`
- **Test coverage:** none against a real model or provider. Prior recorded: "real model-provider memory behavior remains untested" (docs line 126); "live discovery is not accepted" (line 124); "provider connector behavior ... remain unverified end to end" (line 125).
- **Real or simulated behavior:** All model/provider paths verified only with a mock Hermes gateway, harness fixture OpenAI-compatible endpoint, injected OSM/website transports and fixture calendars.
- **Missing dependencies:** paid model spend and a real model key; approval for live OSM/Overpass and company-website requests; calendar and messaging provider credentials for a controlled test tenant; founder approval for any outbound test.
- **Remaining work:** Unblocked part: write the scripted acceptance harness and checklist (real-model client-tier tool use, support fabrication suite, one live discovery, one live booking, one live confirmation). Execution needs the external items.
- **Verification evidence:** docs statements above; I found no live-provider test files.
- **Definition of done:** A recorded acceptance run per capability with real model/provider output and request ids, tenant-isolated, reviewed by the founder.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Customer-facing Hermes runs (SMS, email, WhatsApp) are not started with a no-tools scope, and the client business MCP credential is per-employee profile, not per-run", "directiveRef": "§14 (no disclosure of private account or business data to unauthenticated customers); §8 (tool policy)", "priority": "P1", "status": "NOT_STARTED", "remainingWork": "hermesReplyGenerator calls startAgentRun without requirements.toolScope = 'no_tools' (the research job does pass it). The client business MCP tier (dormant: needs HERMES_CLIENT_BUSINESS_MCP_ENABLED plus the workspace switch) offers the Growth Partner find_contacts, get_contact, get_conversation_history, crm_summary_report, list_opportunities, and its authorization finds 'exactly one running Chat turn' of that employee, not the calling run. If the owner has a chat turn in flight (up to 20 minutes) while an inbound customer message triggers a reply run on the same profile, that customer run's model could call those read tools under the owner's turn, steered by an unauthenticated sender's text. Not reproduced; derived from code. Fix: pass toolScope no_tools for every customer-reply run (the gateway feature run_tool_scope_no_tools already exists), require the MCP call to carry the run id of the chat turn, and add a test with a concurrent chat turn and a customer run asserting the customer run cannot read. Evidence: src/server/messaging/responder.ts:143-150; src/server/integrations/hermes/client.ts:818-849 and :398-426; src/server/workforce/hermes-client-business-mcp.ts:138-170; src/server/workforce/hermes-client-business-mcp-policy.ts:29-39."}
- {"title": "Default safety floor for customer-facing topics (legal, medical, safety) independent of onboarding answers", "directiveRef": "§14 (unknown-answer handling, no fabricated policy or guarantees, escalation routing)", "priority": "P0", "status": "PARTIAL", "remainingWork": "The server-side topic guard only fires for topics the client selected in confirmed onboarding answers. With no answer, safety, legal and medical messages reach the model with only prompt-level instruction to escalate. Add a default always-on set, show it in settings as non-removable, and test the unconfigured workspace. Evidence: src/server/messaging/responder.ts:219-226; src/lib/customer-topic-guard.ts:62-72."}
- {"title": "Growth Partner-role coverage for the eight capability areas: per-capability dispatch, ability switch-off and tenant tests run mostly with the legacy six roles", "directiveRef": "§8 (one identity with multiple permissioned capabilities; tenant-isolation and integration tests per capability)", "priority": "P1", "status": "PARTIAL", "remainingWork": "Most review and booking tests in the audit's evidence lists use sales_assistant, appointment_setter, crm_manager or performance_analyst (0 growth_partner references in workforce-review-capabilities, appointment-setter-acceptance, social-review, pipeline-draft, crm-performance). Handlers are role-agnostic SQL so handler logic transfers, but the GP's own permission path (ROLE_ABILITIES union, allowedRoles including growth_partner, requester gate, switch-off at run time) is proven for only one capability. Add a table-driven GP-role test over all 14 keys covering dispatch, switch-off refusal, run-time block and cross-tenant refusal. Evidence: tests/employee-ability-enforcement.test.ts:219; tests/growth-partner-capability-dispatch.test.ts."}
- {"title": "Growth Partner chat evidence does not describe its real chat actions", "directiveRef": "§8 (honest reporting of what the partner can and cannot do)", "priority": "P2", "status": "PARTIAL", "remainingWork": "chatRequestsSection returns an empty list for growth_partner and tells the model nothing can be started from chat, while chat/service.ts runs real GP handlers. Wire the GP list to the real handler set and abilities and test it. Evidence: src/server/workforce/employee-evidence.ts:884-905; src/server/chat/service.ts:2868-2920."}
