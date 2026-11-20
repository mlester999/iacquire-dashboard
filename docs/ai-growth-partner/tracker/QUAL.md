# QUAL — Lead qualification, sales assistance and outreach safety

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). Baseline audit: commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`; current verification updates are dated 2026-11-17.

Domain summary (baseline findings are from the read-only audit of worktree gp-completion at HEAD 6e4a4b7e; current-source changes and test results are recorded in the qualification rows below).
- Provider messages to a prospect or customer funnel through one rule chain (`evaluateSend` / `queueOutbound` / `dispatchMessage` in `src/server/messaging/send.ts`) that re-checks consent, suppression, opt-out, identity verification, quiet hours, frequency caps, ownership, credits and the provider switch before queueing and immediately before the provider call. Website-chat replies use a separate gate for the visitor's open widget. PGlite-backed tests exercise these paths with recorder transports; the test runner blocks all non-loopback sockets (`tests/support/no-network.ts`).
- Lead scoring is a real, deterministic, explainable rules engine (`src/lib/lead-scoring/*`, `src/server/lead-scoring/*`) with `insufficient_data` instead of fake "cold", protected-attribute exclusion, human overrides and an optional, closed-schema model extractor. Cold outreach is structurally absent: lead research stages candidates, import creates a CRM company/contact with no conversation and no consent, and the `outreach` approval kind has no executor.
- Biggest gaps: (1) automatic missed-call recovery has per-contact attempt/spacing limits but no workspace-level hourly/daily ceiling; (2) free-text opt-outs ("please stop texting me") are not detected, only exact keywords like STOP; (3) the qualification definition is split over three unconnected stores (Business Brain `idealCustomers`, `lead_targeting_profiles`, `lead_scoring_profiles`) and the research targeting rules are prompt text only, so "fit" is a model judgement for research candidates; (4) the unified Growth Partner cannot read the engine's per-lead priority, summary, missing items or next action through its CRM tools, and can write an unevidenced `lead_score`/`lead_status`; (5) dynamic tests still do not cover every outbound caller, and free-form AI-generated replies still derive service purpose from reply scope without classifying promotional content; (6) reminders, retention programs and missed-call AI routing still resolve legacy agent roles (`appointment_setter`, `crm_manager`), not the unified Growth Partner; (7) live provider sends (Twilio, Meta WhatsApp, Resend) have never been exercised against a live account. Public-form identity marking, sender-proof requirements, system-actor pause gates and approval scope/employee binding are covered by the current implementation and focused tests below.
- Real vs simulated: all send-chain, scoring, campaign, follow-up, missed-call and approval logic runs on a real (PGlite) database in tests; providers are recorders; LLM calls (signal extraction, reply generation, research) are stubs/fixtures. Nothing here has real-model or live-provider evidence.

---

<a id="gp-qual-01"></a>
### GP-QUAL-01 — Deterministic lead scoring and priority engine

- **Requirement:** Deterministic lead scoring and priority engine (directive §10 priority, qualification requirements, missing-information)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/lead-scoring/engine.ts`, `src/lib/lead-scoring/criteria.ts`, `src/lib/lead-scoring/ai-signals.ts`, `src/server/lead-scoring/service.ts`, `src/server/lead-scoring/facts.ts`, `src/server/lead-scoring/queue.ts`, `src/server/lead-scoring/subscriber.ts`, `src/server/lead-scoring/profile.ts`, `src/server/lead-scoring/ai.ts`, `src/server/lead-scoring/priority.ts`
- **Test coverage:** `tests/lead-scoring-engine.test.ts` (pure: insufficient data is never cold, determinism/fingerprint, caps for unqualified status, protected attributes refused, model cannot set a number), `tests/lead-scoring-service.test.ts` (PGlite: writes once, history order, never writes the hand-entered lead score, overrides, queue debounce, tenant isolation, daily ceiling, model fallback), `tests/lead-scoring-ai-gate.test.ts` (suspended/paused/no-credit workspaces skip the model). Does not prove: score calibration against real conversion data; any real-model extraction.
- **Real or simulated behavior:** Real rules engine on real DB rows (PGlite in tests); optional AI signal extraction is real code exercised only with a stub completion, off by default.
- **Missing dependencies:** A configured LLM for signal extraction (off by default); real conversion history to calibrate hot/warm thresholds (defaults 70/40, min 3 signals).
- **Remaining work:** None blocking. Optional: calibrate hot/warm defaults with real outcomes; expose insufficient_data handling to the Growth Partner (see GP-QUAL-05).
- **Verification evidence:** Read code and tests (own observation). Docs claim of a full green regression is a recorded prior run, not re-observed by me.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every contact has a versioned assessment with score/label, factor evidence refs, missing items and next action; unchanged inputs create no new row; protected attributes cannot enter a score; overrides persist; results identical with the model off.

<a id="gp-qual-02"></a>
### GP-QUAL-02 — Unified qualification criteria (industry, location, size, service need, source, fit, requirements)

- **Requirement:** Unified qualification criteria (industry, location, size, service need, source, fit, requirements) (directive §10 target industry, location, business size, service need, lead source, business fit)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/ai-growth-partner.ts`, `src/lib/leads-targeting.ts`, `src/lib/onboarding/lead-targeting-draft.ts`, `src/lib/lead-scoring/criteria.ts`, `src/server/leads/research-contract.ts`
- **Test coverage:** `tests/onboarding-lead-targeting.test.ts`, `tests/lead-scoring-engine.test.ts` ("business-specific criteria" describe: presets, service area, field operators, fit cannot outweigh behaviour). Not covered: any code path that compares a candidate or contact to Business Brain `idealCustomers`; none exists.
- **Real or simulated behavior:** Three real but disconnected stores: Business Brain idealCustomers, lead_targeting_profiles, lead_scoring_profiles. Targeting is injected into the research prompt only; industry and business size are not first-class scoring criteria and fit criteria default off.
- **Missing dependencies:** Founder/product decision on the canonical qualification schema.
- **Remaining work:** Define one QualificationCriteria shape and derive targeting and scoring criteria from the Business Brain with provenance; add first-class industry, size band, service-need criteria and hard disqualifier caps to criteria.ts; deterministic candidate matcher (GP-QUAL-03); tests that a contact outside stated geography/industry is lowered or capped with a reason.
- **Verification evidence:** Own reading: `planLeadTargeting` never sets `industries`/`businessSize`; fit criteria default off; grep found no code reading Business Brain `idealCustomers` outside prompt/knowledge assembly.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One client-editable qualification definition drives research filtering, CRM fit factors and partner explanations; changing it re-queues assessments; tests prove out-of-criteria contacts are scored lower or capped with a stated reason.

<a id="gp-qual-03"></a>
### GP-QUAL-03 — Evidence-bound prospect qualification (research candidates)

- **Requirement:** Evidence-bound prospect qualification (research candidates) (directive §10 business fit, no manufactured fit evidence, disqualification reasons)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/leads/research-contract.ts`, `src/server/leads/research-job.ts`, `src/server/leads/service.ts`, `src/server/approvals/service.ts`, `src/server/leads/research-source-policy.ts`, `src/server/leads/research-source-runner.ts`, `src/server/leads/openstreetmap-source.ts`, `src/server/leads/company-website-source.ts`
- **Test coverage:** `tests/ai-growth-partner-fixture-acceptance.test.ts` (L522 persists fixture research, qualification, CRM review and report in one isolated partner thread; control tenant cannot read), `tests/lead-research-source-policy.test.ts` (starts disabled, atomic budget reservation, tenant isolation), `tests/acquisition-sources.test.ts` (allowlist, robots fail-closed, rate caps), `tests/workforce-lead-generation.test.ts`, `tests/research-intent.test.ts`. Does not prove: that the model's fit judgement is correct; live sources.
- **Real or simulated behavior:** Real validation and persistence (uncited contact details dropped, model timestamps dropped, score zeroed without citations, disqualification needs matching cited URL); model output in all recorded acceptance is a fixture; no live source or live model run accepted.
- **Missing dependencies:** Live discovery acceptance needs approved source enablement and a real Hermes/model run (externally gated; not done per docs).
  - Remaining work (unblocked): (1) targeting is prompt-only: add a deterministic post-check in `qualifyCandidate` that compares `lead.industry` / `lead.location` / size evidence against `targetingSchema` fields (industries, countries/regions, excluded) and downgrades to `needs_evidence` or `disqualified` only with a matching cited URL; (2) the model-supplied `score` object (service_fit etc., max 30/25/20/15/10) is stored and later copied into the CRM `lead_score` on import: replace with a server-computed priority from cited-evidence counts, or label it as a research priority only and stop writing it to `contacts.lead_score` (`approvals/service.ts` L228); (3) add a test where a candidate that violates targeting is not `evidence_backed`.
- **Remaining work:** Add deterministic post-check of candidate industry/location/size against saved targeting in qualifyCandidate; stop copying the model-supplied score object into contacts.lead_score on import (approvals/service.ts L228) or replace with a server-computed priority; add a test that a targeting-violating candidate is not evidence_backed.
- **Verification evidence:** Own reading of code and fixture test names; docs (implementation-status.md L46, L72, L238) record fixture runs passing: prior recorded run, not observed by me.
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Fit against saved targeting is decided by code with cited evidence; no model-authored number reaches a CRM field; live-source acceptance recorded separately.

<a id="gp-qual-04"></a>
### GP-QUAL-04 — Disqualification reasons and missing-information handling

- **Requirement:** Disqualification reasons and missing-information handling (directive §10 disqualification reasons, missing-information handling)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/lead-scoring/engine.ts`, `src/server/leads/research-contract.ts`, `src/lib/webchat/rules.ts`, `src/server/webchat/visitor.ts`, `src/server/crm/opportunities.ts`, `src/lib/crm/types.ts`, `src/server/crm/agent-tools/catalog.ts`
- **Test coverage:** `tests/lead-scoring-engine.test.ts` (insufficient data, cap), `tests/lead-scoring-service.test.ts`, `tests/webchat-leads.test.ts`, `tests/journeys/journey-2-lead-acquisition.test.ts`. Not covered: a stored reason on a CRM contact marked unqualified (does not exist).
- **Real or simulated behavior:** Real: scoring lists missing items and returns insufficient_data (never cold); research disqualification needs cited evidence; opportunities require a lost reason. Gaps: a CRM contact marked unqualified stores no reason; website-chat qualification answers are stored on the session only and not read by scoring.
- **Missing dependencies:** none.
- **Remaining work:** Add disqualification reason/by/at to contacts when lead_status becomes unqualified (required for AI-proposed changes); map visitor-typed qualification answers to flagged custom fields usable by fit criteria; feed missing[] hints to the partner. | Skeptic adds: Either reword the definition (unknowns are discounted, not ignored) or compute the score over known criteria only and show confidence separately.
- **Verification evidence:** Own reading; `webchat/visitor.ts` L345-402 stores answers in `web_chat_sessions.qualification` and emits an event, but `lead-scoring/facts.ts` never reads them.
  - *Skeptic review: Definition of done 'unknown information is never counted as a negative' does not match the engine: unknown positive criteria add half their weight to the denominator, lowering the numeric score (label stays insufficient_data only below minSignals).*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every not-a-fit decision has a stored reason; unknowns are listed and never counted as negatives; visitor-supplied answers are usable but flagged unverified.

<a id="gp-qual-05"></a>
### GP-QUAL-05 — Qualification summaries, next actions and follow-up recommendations reaching the Growth Partner

- **Requirement:** Qualification summaries, next actions and follow-up recommendations reaching the Growth Partner (directive §10 qualification summaries, follow-up recommendations, suggested next actions)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/lead-scoring/engine.ts`, `src/server/lead-scoring/priority.ts`, `src/server/workforce/lead-priority-review.ts`, `src/server/messaging/inbox-ai.ts`, `src/server/crm/agent-tools/handlers.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts`
- **Test coverage:** `tests/workforce-review-capabilities.test.ts` (lead_priority_review), `tests/crm-agent-tools.test.ts`, `tests/unified-inbox-ai.test.ts`. No test shows the partner citing an engine assessment, because no tool exposes it.
- **Real or simulated behavior:** Summaries and next actions are deterministic engine text (real) and an aggregate read-only lead_priority_review capability; the per-lead assessment (label, summary, factors, missing, next action) is not exposed by get_contact/find_contacts, so the partner cannot cite it.
- **Missing dependencies:** none.
- **Remaining work:** Add current assessment, missing items, next action, override flag and reachability (consent/suppression) to get_contact/find_contacts and the client Business MCP matrix, or add a get_lead_priority read tool; test the fields and tenant isolation.
- **Verification evidence:** Own reading of handlers: result object lists id, name, email, phone, leadStatus, leadScore, source, tags, openDeals, tasks, appointments only.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Asked why a lead is hot or what to do next, the partner answers from the stored assessment, states what is unknown and invents no evidence.

<a id="gp-qual-06"></a>
### GP-QUAL-06 — Draft outreach and follow-up drafts

- **Requirement:** Draft outreach and follow-up drafts (directive §10 draft outreach, follow-up recommendations)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/pipeline-followup-drafts.ts`, `src/lib/workforce-capabilities.ts`, `src/server/crm/agent-tools/handlers.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts`, `src/server/messaging/inbox-ai.ts`, `src/server/messaging/followups.ts`, `src/server/messaging/inbox.ts`
- **Test coverage:** `tests/workforce-review-capabilities.test.ts`, `tests/employee-tool-policy.test.ts`, `tests/crm-agent-tools.test.ts` ("reads only this employee's conversations, drafts without sending, and asks before anything goes out"), `tests/unified-inbox-ai.test.ts`, `tests/approvals-downstream-status.test.ts`. Not covered: a first-contact draft to a qualified prospect (does not exist).
- **Real or simulated behavior:** Real unsent draft rows. pipeline_followup_drafts uses a fixed neutral template (max 5, only AI-owned open conversations, stale deals older than 14 days); prepare_message (model-written) is internal agency tier only and never offered to clients; inbox suggestReply is staff-driven. No first-contact draft for a researched prospect; drafts default to purpose=service.
- **Missing dependencies:** Product decision on whether first-contact outreach to researched prospects is in scope (docs say contact stays behind approval).
- **Remaining work:** Offer approval-only prepare_message to the client tier behind a workspace switch or document drafting as staff-driven; add a no-conversation lead path that makes an unsent draft only when a consent basis exists (else a task); classify or require purpose for AI-generated replies and drafts whose wording may be promotional before they are queued.
- **Verification evidence:** The draft insert in `pipeline-followup-drafts.ts` sets `blocked_reason 'needs_approval'` and has no send call. On 2026-11-17, a marketing-purpose draft with consent revoked after drafting was refused when approved; `queueApprovedDraft` now passes the stored purpose to `evaluateSend`.
  - *Skeptic correction: Approval-time evaluation previously omitted the stored purpose. Fixed and verified by `tests/messaging-core.test.ts`.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every draft is an unsent row with stated purpose, visible in Inbox/Approval Center, and cannot reach a customer without approval and the full rule chain.

<a id="gp-qual-07"></a>
### GP-QUAL-07 — Lead status updates, approval requests and CRM pipeline updates by the partner

- **Requirement:** Lead status updates, approval requests and CRM pipeline updates by the partner (directive §10 lead status updates, approval requests, CRM pipeline updates)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/agent-tools/catalog.ts`, `src/server/crm/agent-tools/service.ts`, `src/server/crm/agent-tools/handlers.ts`, `src/server/approvals/service.ts`, `src/lib/employee-tool-policy.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts`, `src/components/crm/contact-profile.tsx`
- **Test coverage:** `tests/crm-agent-tools.test.ts` ("operating modes", "high-impact changes always wait for a person", "approved calls", tampered arguments, pause since request), `tests/growth-partner-crm-ability.test.ts`, `tests/approvals.test.ts`. Not covered: any requirement that a status/score change cite evidence.
- **Real or simulated behavior:** Real CRM services and approval executor on PGlite; tool calls are made by test code, not a model. update_contact lets an agent write a free 0-100 leadScore and leadStatus with an optional reason; autonomous mode runs it immediately; the CRM shows this manual score beside the engine priority.
- **Missing dependencies:** none.
- **Remaining work:** Remove leadScore from the agent catalog or require approval; require reason plus evidence reference for qualified/unqualified; relabel or hide the manual Lead score; rate-limit autonomous status changes per run.
- **Verification evidence:** Own reading of catalog L43-47 and service.ts L400-410; import sets `leadScore: lead.score` (approvals/service.ts L228).
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No AI path changes qualification state or writes a score without a recorded reason and evidence reference; client-tier writes are proposal-only and execute exactly once after approval.

<a id="gp-qual-08"></a>
### GP-QUAL-08 — Reporting on lead quality

- **Requirement:** Reporting on lead quality (directive §10 reporting on lead quality)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/lead-scoring/priority.ts`, `src/server/crm/reports/leads.ts`, `src/server/attribution/report.ts`, `src/server/workforce/performance-snapshot.ts`, `src/server/workforce/lead-priority-review.ts`
- **Test coverage:** `tests/lead-scoring-service.test.ts` ("reports counts that match the contacts, and flags AI tokens as estimates"), `tests/attribution-service.test.ts`, `tests/workforce-review-capabilities.test.ts`. Not covered: conversion by score band.
- **Real or simulated behavior:** Real SQL counts: scoring stats by label, leads by source/status (qualified = human-set status), research leads created/approved/rejected. No conversion by score band or source quality.
- **Missing dependencies:** none.
- **Remaining work:** Add won/appointment rate by priority label and source, a research funnel (candidate to evidence_backed to approved to imported to contacted to won) and the hot/warm distribution to the performance snapshot, with sample-size caveats.
- **Verification evidence:** Own reading; `qualified` in reports is a human-set status, not the engine label.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A tenant-scoped report answers which sources and score bands produce booked/won work, with definitions and sample-size limits.

<a id="gp-qual-09"></a>
### GP-QUAL-09 — Core outbound rule chain (evaluateSend, queueOutbound, dispatchMessage)

- **Requirement:** Core outbound rule chain (evaluateSend, queueOutbound, dispatchMessage) (directive §10 consent-aware patterns, respect platform rules, outreach safety)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/send.ts`, `src/server/messaging/dispatch-gate.ts`, `src/server/messaging/contacts.ts`, `src/server/messaging/consent-identity.ts`, `src/server/messaging/inbox.ts`, `src/server/messaging/outreach.ts`, `src/server/messaging/followups.ts`, `src/server/appointments/reminders.ts`, `src/server/automation/gate.ts`, `src/lib/webchat/identity.ts`, `src/server/websites/forms.ts`, `src/server/crm/forms/process.ts`, `src/server/crm/contacts.ts`, `src/server/crm/campaigns/rules.ts`
- **Test coverage:** `tests/messaging-core.test.ts` (send chain, explicit human-reply purpose and marketing consent, human reply available during a workspace pause, stored-purpose recheck on approval, takeover and pause re-check at dispatch, quiet-hours holds, single-send under two workers, never calls GoHighLevel while writes are off), `tests/crm-reviews.test.ts` (standalone review request refuses a messaging pause and leaves no request/message), `tests/messaging-fixes.test.ts` (WhatsApp marketing category overrides a sender's service label), `tests/messaging-unverified-*.test.ts` (typed identity blocks every automated/promotional path; form consent remains unaccepted after confirmation and merge; outreach refuses a missing purpose), `tests/website-domains-forms.test.ts` (new and existing typed identities, mismatched phone not attached or consented), `tests/crm-forms.test.ts` (new and existing typed identities), `tests/crm-campaigns.test.ts` (form opt-in excluded from preview before and after identity confirmation), `tests/automation-controls.test.ts` (approval kind, scope and employee binding), appointment and CRM tool suites (approved booking and CRM update still execute), `tests/booking-confirmation-wording.test.ts` (host-confirmation path blocked during a messaging pause), `tests/messaging-business-hours.test.ts`, `tests/messaging-transports.test.ts`, provider tests (`messaging-resend`, `messaging-twilio`, `messaging-whatsapp`), `tests/outbound-caller-gates-inventory.test.ts` (static inventory of `queueOutbound` callers), and `tests/outbound-system-actor-pauses.test.ts` (the three pause scopes on missed-call sends). Proves behaviour with recorder providers only.
- **Real or simulated behavior:** Real chain on PGlite with recorder providers; checks consent, suppression, identity, quiet hours, frequency caps, ownership fence, credits, provider switch at queue time and again before the provider call. Website and CRM form addresses are marked typed while unverified; their marketing checkboxes stay ineligible after identity confirmation, including campaign preview and after a merge. Automated outreach and free-form human inbox replies require an explicit service/marketing purpose; approved AI drafts retain and recheck their stored purpose. WhatsApp marketing template category overrides the selected purpose. Free-form AI reply content still needs purpose classification. No live send.
- **Missing dependencies:** none for the code; live provider verification is GP-QUAL-22.
- **Remaining work:** Dynamically verify every listed `queueOutbound` caller against the gates in its inventory; classify or require purpose for free-form AI-generated replies that may contain promotional wording.
- **Verification evidence:** On 2026-11-17, `tests/messaging-unverified-identity.test.ts`, `tests/messaging-unverified-merge.test.ts`, `tests/website-domains-forms.test.ts`, `tests/crm-forms.test.ts`, and `tests/crm-campaigns.test.ts` passed together (5 files / 124 tests). `tests/automation-controls.test.ts`, `tests/appointments.test.ts`, and `tests/crm-agent-tools.test.ts` passed together (3 files / 118 tests), covering approval kind/scope/tenant/employee binding and approved booking/CRM-update execution. `tests/messaging-core.test.ts`, `tests/messaging-unverified-regression.test.ts`, `tests/partner-only-outbound-programs.test.ts`, `tests/booking-confirmation-wording.test.ts`, and `tests/appointments.test.ts` passed together (5 files / 144 tests), proving stored marketing-purpose rechecks, explicit automated-outreach purpose, and a paused host-confirmation caller. The inbox-purpose update passed nine suites / 248 tests (`messaging-core`, `messaging-fixes`, `messaging-transports`, unified-inbox acceptance/control/list, webchat service, CRM provider switch and entitlements matrix). Follow-up caller tests passed `tests/crm-reviews.test.ts` (24 tests) and `tests/messaging-core.test.ts` (44 tests), including the standalone review pause refusal and human-send pause behavior. `npm run typecheck`, targeted ESLint, and `git diff --check` passed. No live send.
  - *The system-actor pause bypass, public-form identity and marketing-consent gaps, approval kind/scope/employee mismatch, and ambiguous human/outreach purpose defaults are fixed in the current branch; PARTIAL remains because not every caller has caller-specific dynamic gate coverage and free-form AI reply purpose is not classified.*
  - *Baseline: 8 of 8 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No bypass: every queueOutbound caller is proven to honour pauses, consent, suppression, quiet hours and caps, and the dispatcher re-evaluates all of it at send time.

<a id="gp-qual-10"></a>
### GP-QUAL-10 — Opt-out, suppression and unsubscribe handling

- **Requirement:** Opt-out, suppression and unsubscribe handling (directive §10 honoring opt-outs and suppression lists)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/messaging.ts`, `src/server/messaging/ingest.ts`, `src/server/messaging/unsubscribe.ts`, `src/app/api/public/unsubscribe/route.ts`, `src/app/unsubscribe/[token]/page.tsx`, `src/server/messaging/transports/twilio.ts`, `src/server/messaging/transports/meta-whatsapp.ts`, `src/server/messaging/transports/resend.ts`, `src/server/messaging/send.ts`
- **Test coverage:** `tests/messaging-core.test.ts` ("STOP revokes consent, suppresses the number and blocks every later send; START restores it"), `tests/messaging-resend.test.ts` (hard bounce and complaint suppress; "unsubscribe links" L748; RFC 8058 headers), `tests/messaging-twilio.test.ts` L484 (Twilio opt-out, HELP), `tests/crm-campaigns.test.ts` (unsubscribes in consent history), `tests/missed-call-recovery-engine.test.ts` ("a STOP reply is an opt-out, not a recovery"). No test for free-text opt-outs (none exist).
- **Real or simulated behavior:** Real: exact keyword STOP (and a fixed list) revokes consent, suppresses the address and cancels follow-ups; signed one-click unsubscribe; provider opt-out and bounce/complaint suppression. Gap: free-text opt-outs (stop texting me, remove me) are not detected and reach the AI reply path.
- **Missing dependencies:** none.
- **Remaining work:** Add multilingual free-text opt-out detection routed to the same revoke+suppress path with pause-and-escalate fallback; add a platform-level do-not-contact list for complaints; tests for opt-out arriving while campaign, missed-call and follow-up messages are queued. | Skeptic adds: For an unauthenticated email 'STOP', add an inbox flag/escalation to a person and pause automated sends to that address pending review; consider an unsubscribe link on AI follow-up emails.
- **Verification evidence:** Own reading; `ingest.ts` L280 `detectOptKeyword(input.body)` is the only opt-out detector on inbound text.
  - *Skeptic review: Agree with PARTIAL. Add: opt-out from an email sender whose domain was not authenticated is silently ignored; the unsubscribe link/header exists only on marketing email, so AI follow-up emails rely on a 'Reply STOP' text that only works from an authenticated sender.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Any clear opt-out in a supported language stops all automated and promotional messages on that channel immediately, is recorded with evidence, and every send path later refuses the address.

<a id="gp-qual-11"></a>
### GP-QUAL-11 — Gates and kill switches inventory (tenant, agent, global)

- **Requirement:** Gates and kill switches inventory (tenant, agent, global) (directive §10 real outbound separately authorized and explicitly enabled; global kill switch)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/automation/gate.ts`, `src/server/automation/controls.ts`, `src/server/messaging/transports/policy.ts`, `src/server/env.ts`, `src/server/ops/tick.ts`, `src/server/admin/health.ts`
- **Test coverage:** `tests/messaging-core.test.ts` (messaging pause and agency pause block queued AI sends), `tests/automation-controls.test.ts`, `tests/ai-job-gate.test.ts`, `tests/ai-job-gate-pause-paths.test.ts`, `tests/crm-agent-tools.test.ts` (pause stops an autonomous employee), `tests/crm-campaigns.test.ts` (workspace pause holds a campaign), `tests/launch-automation-gate.test.ts`, `tests/messaging-transports.test.ts` (writes off blocks), `tests/outbound-master-switch.test.ts`, `tests/outbound-caller-gates-inventory.test.ts`, `tests/outbound-system-actor-pauses.test.ts`, and `tests/admin-health-outbound.test.tsx`.
- **Real or simulated behavior:** `OUTBOUND_MESSAGING_ENABLED` defaults off and is checked for customer sends in `dispatchMessage` and `sendEmail` (account/sign-in mail is exempt); the flag appears in admin health. Tenant `automation_pauses`, agent mode default `approval_required`, `auto_reply_enabled` default off, verified enabled messaging channels, per-provider `*_WRITES_ENABLED` defaults off, `EMAIL_PROVIDER` capture, and `SCHEDULER_ENABLED` remain in effect. System-actor sends check tenant messaging/outbound and agency/platform pauses.
- **Missing dependencies:** none.
- **Remaining work:** Dynamically verify that every inventoried `queueOutbound` caller honours messaging, outbound and agency/platform pauses; keep owner-facing pause wording aligned with tested behavior.
- **Verification evidence:** On 2026-11-17, `tests/outbound-master-switch.test.ts`, `tests/outbound-system-actor-pauses.test.ts`, and `tests/outbound-caller-gates-inventory.test.ts` passed (3 files / 6 tests); `tests/admin-health-outbound.test.tsx` passed (2/2). Master-switch coverage includes provider sends and the account/sign-in exemption.
  - *The earlier finding that the environment switch was absent and missed-call system sends bypassed pauses is resolved in the current source. PARTIAL remains because dynamic caller-by-caller coverage is incomplete.*
  - *Baseline: 8 of 8 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One documented environment switch gates provider outbound messages and customer email; tenant pauses stop automatic provider sends across paths, verified dynamically for each caller. Website chat uses its separate owner-enabled widget setting and open-session gate.

<a id="gp-qual-12"></a>
### GP-QUAL-12 — Outbound path: AI replies to inbound messages and approved drafts

- **Requirement:** Outbound path: AI replies to inbound messages and approved drafts (directive §10 verify every path that can message a prospect or customer)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/responder.ts`, `src/server/messaging/ingest.ts`, `src/server/messaging/inbox.ts`, `src/server/approvals/service.ts`, `src/server/messaging/web-chat-send.ts`, `src/server/messaging/ai-control.ts`, `src/server/webchat/visitor.ts`, migration `0140_message_sender_verification.sql`
- **Test coverage:** `tests/messaging-responder.test.ts` (unproven, verified and forged-follow-up email cases, direct reply and recovery sweep), `tests/messaging-core.test.ts` (draft/approve/reject, takeover races), `tests/webchat-ai.test.ts`, `tests/unified-inbox-ai.test.ts`, `tests/unified-inbox-automation.test.ts`, `tests/appointment-setter-acceptance.test.ts`, and `tests/crm-migrations.test.ts` (legacy sender-proof backfill). No real-model verification.
- **Real or simulated behavior:** Per-message `sender_verified` proof is persisted at ingest. Email is verified only when the receiving provider supplies explicit proof; contact-level identity verification cannot substitute for proof on the latest inbound message. Direct response and recovery use that latest inbound proof, and model history excludes unverified inbound messages. Historical email without per-message proof remains unverified; authenticated non-email provider messages and token-authenticated web-chat messages are verified. Website chat uses the widget's explicit `ai_enabled` setting, separate from `messaging_settings.auto_reply_enabled`, because replies appear only in the visitor's open widget. Reply text comes from a stub generator in tests; no real-model reply verified. Provider replies default to draft-for-approval until the owner enables autopilot.
- **Missing dependencies:** Real-model run for reply quality; the owner must enable `auto_reply_enabled` (default off, so provider-channel replies are drafts). Website chat has its separate explicit widget setting.
- **Remaining work:** Verify the path with only the unified Growth Partner agent (no legacy `sales_assistant`) under `approval_required`; add held-out evaluation of the claims net against real model output.
- **Verification evidence:** The sender-proof regression passed in the combined messaging suite; `tests/crm-migrations.test.ts` separately proves the 0140 historical backfill. `npm run typecheck`, changed-file ESLint and `git diff --check` passed. `npm run rehearse:migrations` passed all sections on embedded PGlite through 0140 in 593 seconds. No live database or provider was contacted.
  - *The recovery-sweeper forged-sender gap is fixed by per-message proof checks. The earlier website-chat auto-reply finding is resolved by its independent, explicit widget `ai_enabled` control. Real-model and unified-Growth-Partner-only acceptance remain open.*
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** For SMS, email and WhatsApp, with autopilot off every AI reply is a draft needing approval; with it on, replies go only to customers who wrote first, state nothing unbacked by knowledge, and stop on takeover, pause, STOP or escalation. Website chat replies only when the owner explicitly enables the widget's AI setting and remain limited to that visitor session.

<a id="gp-qual-13"></a>
### GP-QUAL-13 — Outbound path: scheduled AI follow-ups to quiet inbound customers

- **Requirement:** Outbound path: scheduled AI follow-ups to quiet inbound customers (directive §10 follow-up recommendations, no mass unsolicited outreach, rate limits)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/followups.ts`, `src/lib/messaging.ts`, `src/server/messaging/send.ts`
- **Test coverage:** `tests/crm-followups.test.ts` (planner, stops, preferred channel, custom limits), `tests/messaging-core.test.ts` ("follow-ups" describe incl. 30-day cap and quiet hours).
- **Real or simulated behavior:** Real planner and sender on PGlite; only conversations the AI owns where the customer wrote first and has not written since; 30-day cap across channels; message is a short template naming the AI and offering STOP.
- **Missing dependencies:** none.
- **Remaining work:** Add a test that an agency or platform pause cancels active plans; confirm plan agent is the Growth Partner for unified tenants. | Skeptic adds: Document the default or add a first-run confirmation before the planner creates plans for a workspace.
- **Verification evidence:** Own reading; follow-ups can only target someone who has already written to the business.
  - *Skeptic review: Record the default: followup_preset defaults to 'balanced' (on), not off. Real sends remain gated by agent mode and auto_reply_enabled (default false), so not unsafe, but it is a default-on planner.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Follow-ups never start for someone who did not initiate contact, are capped per contact per 30 days across channels and halt on every stop reason.

<a id="gp-qual-14"></a>
### GP-QUAL-14 — Outbound path: missed-call recovery texts

- **Requirement:** Outbound path: missed-call recovery texts (directive §10 verify every send path and what gate protects it)
- **Current implementation status:** PARTIAL
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/missed-calls/engine.ts`, `src/lib/missed-calls/eligibility.ts`, `src/server/missed-calls/facts.ts`, `src/server/missed-calls/policy.ts`, `src/server/messaging/send.ts`, `src/server/messaging/dispatch-gate.ts`
- **Test coverage:** `tests/missed-call-recovery-engine.test.ts` (policy off does nothing; team-only; draft for approval; automatic only through the chain; no-consent hold; ack basis; opted-out never texted; quiet hours; attempt cap; takeover stops a queued text; write-switch off fails honestly), `tests/missed-call-ops.test.ts` (case-level pause), `tests/journeys/journey-3-*.test.ts`, and `tests/outbound-system-actor-pauses.test.ts` (client messaging, client outbound and platform-wide agency pauses prevent queueing and hold queued sends until lifted; case records the pause without consuming an attempt).
- **Real or simulated behavior:** Real engine and chain on PGlite; policy off/manual by default, a person must activate send modes, consent and suppression checked, AI call-back always blocked. Workspace and agency/platform pauses are checked before queueing and again at dispatch; a paused case waits and records the pause reason.
- **Missing dependencies:** none.
- **Remaining work:** Add a per-workspace hourly or daily ceiling on automatic recovery texts and a test with many distinct caller numbers.
- **Verification evidence:** On 2026-11-17, `tests/outbound-system-actor-pauses.test.ts` passed all three pause scopes and queued-send hold/resume cases. The focused outbound suite passed 3 files / 6 tests and the admin-health suite passed 2/2. Case events show a paused state and attempts remain at zero during a workspace pause.
  - *The earlier system-actor pause bypass is fixed. PARTIAL remains for the missing workspace-level recovery-text ceiling.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** With any of the three pauses active no missed-call text is queued or dispatched, a queued one is held at dispatch until the pause lifts, and a test proves each pause scope. Automatic recovery also needs a workspace-level hourly or daily ceiling.

<a id="gp-qual-15"></a>
### GP-QUAL-15 — Outbound path: owner-approved marketing campaigns

- **Requirement:** Outbound path: owner-approved marketing campaigns (directive §10 no mass unsolicited outreach by default, consent-aware, rate limits)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/campaigns.ts`, `src/server/crm/campaigns/rules.ts`, `src/server/crm/campaigns/job.ts`, `src/server/messaging/dispatch-gate.ts`, `src/server/messaging/unsubscribe.ts`
- **Test coverage:** `tests/crm-campaigns.test.ts` (owner-only approval bound to list/template/values/schedule/pace; any change voids it; pause holds and resumes; opt-out after start excluded; public-form promotional ticks excluded before and after identity confirmation; pace per minute; quiet hours; credits; email carries one-click unsubscribe; WhatsApp needs Meta marketing template; isolation; viewers cannot create/send).
- **Real or simulated behavior:** Real service on PGlite with recorder providers. Audience needs granted marketing consent whose latest source is not a public form, and no suppression; owner approval bound by hash to list, template, values, schedule and pace; pause holds; per-person re-check at send. Person-initiated only: the Growth Partner has no campaign tool.
- **Missing dependencies:** none for code.
- **Remaining work:** Add a per-workspace daily recipient ceiling independent of pace for new workspaces; require a postal address in marketing email footers (GP-QUAL-23).
- **Verification evidence:** On 2026-11-17, the focused campaign test verifies a public-form marketing tick is excluded from the preview before and after identity confirmation; the combined outbound/form regression passed 5 files / 124 tests with typecheck and changed-file ESLint.
  - *Skeptic review identified that website-form consent could qualify an unverified address. The current branch marks public form identities as typed, rejects form-derived marketing consent at send time, and excludes those grants from campaign audience preview. Remaining campaign limits are stated above.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No campaign sends without an owner approval bound to the exact audience and wording; each recipient is re-checked for consent, suppression, quiet hours and pause at send time.

<a id="gp-qual-16"></a>
### GP-QUAL-16 — Outbound path: workflow send-message and review-request steps

- **Requirement:** Outbound path: workflow send-message and review-request steps (directive §10 verify every path; approvals)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/crm/workflows/executors.ts`, `src/server/crm/workflows/runner.ts`, `src/server/messaging/outreach.ts`, `src/server/crm/workflows/approvals.ts`
- **Test coverage:** `tests/crm-workflow-engine.test.ts`, `tests/crm-automation-engine-fixes.test.ts`, `tests/messaging-unverified-regression.test.ts` (typed identity cannot be texted by a workflow), `tests/unified-inbox-workflow-step.test.ts`, `tests/workflow-operations.test.ts`.
- **Real or simulated behavior:** Real workflow engine on PGlite; a message step needs an owner-approved version and an approved template hash and goes through queueOutreach (AI actor, default sendAs growth_partner) so pauses and every rule apply per recipient.
- **Missing dependencies:** none.
- **Remaining work:** Confirm by test that every message step is blocked under workflows, messaging and outbound pauses. | Skeptic adds: Add tests per pause scope for both step kinds.
- **Verification evidence:** Own reading.
  - *Skeptic review: Not too pessimistic but the remaining 'confirm every message step is blocked under pauses' is largely satisfied by static trace; only a test is missing. send_message uses the AI actor (gate covers messaging/outbound/agency), request_review is a system retention send held at dispatch; queue-time evaluateSend does not stop the latter, the dispatcher does.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A workflow cannot send without an owner-approved version and passes the same chain per recipient.

<a id="gp-qual-17"></a>
### GP-QUAL-17 — Outbound path: automated service messages (reminders, confirmations, retention, review requests, invoice reminders, document delivery)

- **Requirement:** Outbound path: automated service messages (reminders, confirmations, retention, review requests, invoice reminders, document delivery) (directive §10 verify every path; unified Growth Partner conversion)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/appointments/reminders.ts`, `src/server/appointments/booking.ts`, `src/server/calendars/agent-booking.ts`, `src/server/retention/engine.ts`, `src/server/reputation/program-link.ts`, `src/server/crm/reviews.ts`, `src/server/reputation/batch-job.ts`, `src/server/invoices/reminders.ts`, `src/server/messaging/delivery.ts`, `src/server/missed-calls/routing.ts`
- **Test coverage:** `tests/retention.test.ts`, `tests/retention-hold.test.ts`, `tests/appointments.test.ts`, `tests/booking-confirmation-wording.test.ts` (including pause on the host-confirmation message path), `tests/crm-reviews.test.ts` (standalone request refuses the workspace messaging pause), `tests/reputation-retention-link.test.ts`, `tests/reputation-batches.test.ts`, `tests/invoices-reminders.test.ts`, `tests/invoices-delivery.test.ts`, `tests/proposals-delivery.test.ts`. None test a tenant that has only the unified `growth_partner` agent instance.
- **Real or simulated behavior:** Real, consent- and pause-gated paths. Reminders, retention and missed-call AI routing still resolve the legacy appointment_setter and crm_manager agent instances, not the unified Growth Partner, so a partner-only tenant would get agent_missing blocks; no test covers a partner-only workspace.
- **Missing dependencies:** none.
- **Remaining work:** Resolve the sending actor through the unified Partner (ai_growth_partners.runtime_agent_instance_id) with fallback to retained roles; add partner-only workspace tests for reminders, retention and review programs.
- **Verification evidence:** Own grep: `growth_partner` does not appear in `src/server/appointments`, `retention`, `missed-calls` or `reputation`.
  - *Baseline: 9 of 9 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** In a partner-only workspace reminders and programs send under the Partner's mode and pauses or are blocked with a clear reason; legacy roles are never required.

<a id="gp-qual-18"></a>
### GP-QUAL-18 — Outbound path: person-initiated sends (inbox replies, template test sends)

- **Requirement:** Outbound path: person-initiated sends (inbox replies, template test sends) (directive §10 verify every path)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/inbox.ts`, `src/app/actions/inbox.ts`, `src/server/crm/message-templates.ts`, `src/app/actions/crm-templates.ts`, `src/app/actions/crm-campaigns.ts`
- **Test coverage:** `tests/crm-templates.test.ts`, `tests/messaging-core.test.ts` (missing purpose refusal and explicit marketing-consent check), `tests/messaging-fixes.test.ts` (WhatsApp template category remains authoritative), `tests/messaging-transports.test.ts`, `tests/unified-inbox-acceptance.test.ts`, `tests/unified-inbox-control.test.ts`, `tests/unified-inbox-list.test.ts`, `tests/crm-provider-switch.test.ts`, `tests/entitlements-matrix.test.ts`, `tests/webchat-service.test.ts`.
- **Real or simulated behavior:** Real chain. A person's send skips quiet hours, frequency caps and pauses by design but still needs consent or a prior inbound, honours suppression, and test sends go only to approved test destinations that are not a customer's address.
- **Missing dependencies:** none.
- **Remaining work:** Show the pause/quiet-hours bypass in the UI; consider a confirm step for a first message to a contact with unknown consent whose last inbound is old.
- **Verification evidence:** Human sends now require the UI sender to choose service or marketing, and server-side `sendHumanReply` rejects a missing/invalid choice. Marketing sends pass through `evaluateSend` and need marketing consent; WhatsApp marketing-template category remains authoritative. On 2026-11-17, the ten affected inbox/send suites passed (281 tests), and typecheck, targeted ESLint and `git diff --check` passed. This is synthetic PGlite/recorder evidence; no live provider was used.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A person can reply to someone who wrote first but cannot message an opted-out or no-consent contact, and test sends cannot reach real customers.

<a id="gp-qual-19"></a>
### GP-QUAL-19 — Outbound path: platform transactional email and other external writes (social, review replies, e-signature, webhooks)

- **Requirement:** Outbound path: platform transactional email and other external writes (social, review replies, e-signature, webhooks) (directive §10 real outbound separately authorized; post, DM, call)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/email.ts`, `src/server/demo/public.ts`, `src/server/purchase-intents/invitations.ts`, `src/server/support/notify.ts`, `src/server/social/publisher.ts`, `src/server/reputation/providers/google.ts`, `src/server/reputation/providers/meta-reviews.ts`, `src/server/esign/providers/pandadoc.ts`, `src/server/crm/webhooks.ts`
- **Test coverage:** `tests/social-automation.test.ts`, `tests/social-review.test.ts`, `tests/reputation-external-automation.test.ts`, `tests/reputation-gating-guard.test.ts` (R7 nothing writes to a customer), `tests/esign-*.test.ts`, `tests/setup-center.test.ts`, `tests/client-invitation-resend.test.ts`. No test that the platform email path honours a platform do-not-contact list (none exists).
- **Real or simulated behavior:** sendEmail defaults to capture and has a closed template list to the requester or a staff-chosen invitee, but no suppression or bounce check; social posts, review replies and e-sign each need their own *_ENABLED switch and approval; simulated providers are refused in production.
- **Missing dependencies:** Real accounts for live checks (external).
- **Remaining work:** Add suppression/bounce checks to sendEmail for prospect-facing templates (demo_link, proposal_code, purchase_invitation); test that no marketing template can be added without the unsubscribe path.
- **Verification evidence:** Own reading; none of these paths can send a promotional message to an arbitrary prospect.
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Platform email cannot be used for promotion; bounced or complained addresses are not retried; each external write needs its own switch and approval.

<a id="gp-qual-20"></a>
### GP-QUAL-20 — No cold or mass unsolicited outreach by default

- **Requirement:** No cold or mass unsolicited outreach by default (directive §10 no mass unsolicited outreach by default)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/approvals/service.ts`, `src/server/leads/research-contract.ts`, `src/lib/employee-tool-policy.ts`, `src/server/workforce/hermes-client-business-mcp-policy.ts`, `src/server/messaging/send.ts`, `src/lib/ai-growth-partner.ts`
- **Test coverage:** `tests/approvals.test.ts` and `tests/approvals-downstream-status.test.ts` (outreach approvals stay blocked), `tests/ai-growth-partner-fixture-acceptance.test.ts` (import persists CRM company, no message), `tests/messaging-unverified-regression.test.ts`, `tests/employee-tool-policy.test.ts` (walks every role against every action), `tests/crm-campaigns.test.ts`.
- **Real or simulated behavior:** Structural properties of real code: the outreach approval kind has no executor (approved but not sent); lead import creates a company/contact with no conversation or consent; runtime tools contain no send tool; consent unknown with no inbound is refused (no_consent); research prompt forbids messaging and guessed contact details.
- **Missing dependencies:** none.
- **Remaining work:** Add a regression test that a researched, imported prospect with no consent cannot be messaged on any path (human send, workflow, campaign, partner draft); add a static test that no executor exists for kind outreach; keep outreach blocked until a prospecting-compliance design exists.
- **Verification evidence:** Own reading; a human send to a contact with unknown consent and no inbound is refused by `evaluateSend` L322.
  - *Baseline: 6 of 6 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No code path from lead research or the Growth Partner to a first-contact message exists without a recorded consent basis and a person's per-message or per-campaign approval.

<a id="gp-qual-21"></a>
### GP-QUAL-21 — Synthetic acceptance cannot send anything

- **Requirement:** Synthetic acceptance cannot send anything (directive §10 no actual email/SMS/DM/post/call during synthetic acceptance)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P0  |  **Evidence class:** synthetic-only  |  **Unblocked now:** yes
- **Source files:** `tests/support/no-network.ts`, `vitest.config.ts`, `src/server/env.ts`, `src/server/messaging/transports/resend.ts`, `src/server/messaging/transports/twilio.ts`, `src/server/messaging/transports/meta-whatsapp.ts`, `src/server/messaging/provider.ts`, `src/server/missed-calls/engine.ts`
- **Test coverage:** `tests/no-network-guard.test.ts` (the guard's own test), `tests/messaging-core.test.ts` ("never calls GoHighLevel while sending is switched off, and says why"), `tests/messaging-transports.test.ts`.
- **Real or simulated behavior:** Guards are real: the test runner refuses every non-loopback socket, all *_WRITES_ENABLED default off, EMAIL_PROVIDER defaults to capture, AI call-back is always blocked. A synthetic acceptance outside the unit-test runner relies on flags being off and per-script stubs.
- **Missing dependencies:** none.
- **Remaining work:** Add a startup assertion refusing any *_WRITES_ENABLED=true with a PGlite database or non-production NODE_ENV, and extend the admin health inventory to list every provider-specific outbound switch. The default-off master switch is implemented for provider sends and customer email.
- **Verification evidence:** `tests/outbound-master-switch.test.ts` and `tests/admin-health-outbound.test.tsx` passed on 2026-11-17 and cover the default-off customer-message switch, its account/sign-in exemption, and the reported switch state. The Vitest network guard remains test-runner-only; startup refusal of provider-write flags outside production is not implemented.
  - *The earlier missing-master-switch finding is resolved for customer sends. The synthetic acceptance guarantee remains PARTIAL: the no-network guard is Vitest-only, account/sign-in mail is exempt from the customer-message switch, and startup refusal of provider-write flags outside production remains open.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A synthetic acceptance cannot reach a provider by construction and the harness reports the state of every outbound switch.

<a id="gp-qual-22"></a>
### GP-QUAL-22 — Live provider verification (Twilio, Meta WhatsApp, Resend, GoHighLevel)

- **Requirement:** Live provider verification (Twilio, Meta WhatsApp, Resend, GoHighLevel) (directive §10 real outbound separately authorized and explicitly enabled)
- **Current implementation status:** EXTERNALLY BLOCKED
- **Priority:** P1  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** no
- **Source files:** `src/server/messaging/transports/resend.ts`, `src/server/messaging/transports/twilio.ts`, `src/server/messaging/transports/meta-whatsapp.ts`, `src/server/messaging/channels.ts`, `docs/messaging-providers.md`
- **Test coverage:** `tests/messaging-resend.test.ts`, `tests/messaging-twilio.test.ts`, `tests/messaging-whatsapp.test.ts`, `tests/messaging-transports.test.ts` (mock HTTP only).
- **Real or simulated behavior:** Adapters are implemented and tested against mocked HTTP only; their own file headers state they have never been exercised against a live account.
- **Missing dependencies:** Verified sender domains/numbers, provider accounts and sandbox credentials, carrier registration (10DLC/Meta business verification), founder approval to enable each `*_WRITES_ENABLED` flag for one test tenant and one approved test destination.
- **Remaining work:** Outside the repo: run one sandbox send per channel to an approved test destination and record evidence. Inside the repo: add a read-only capability-check runner and a first-live-send checklist.
- **Verification evidence:** Own reading of the file headers; no live evidence exists.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One delivered, webhook-confirmed message per channel to an approved destination, STOP and bounce handling observed live, flags returned to off.

<a id="gp-qual-23"></a>
### GP-QUAL-23 — Platform and legal compliance patterns (WhatsApp, SMS, email, caller consent)

- **Requirement:** Platform and legal compliance patterns (WhatsApp, SMS, email, caller consent) (directive §10 respect platform rules and privacy/anti-spam requirements)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/messaging/send.ts`, `src/server/messaging/whatsapp-templates.ts`, `src/server/crm/campaigns/rules.ts`, `src/lib/messaging/tokens.ts`, `src/server/messaging/transports/resend.ts`, `src/server/missed-calls/policy.ts`, `src/lib/missed-calls/eligibility.ts`, `src/server/crm/contacts.ts`
- **Test coverage:** `tests/messaging-whatsapp.test.ts`, `tests/messaging-core.test.ts` (window and template), `tests/crm-campaigns.test.ts` (opt-out wording refusal), `tests/messaging-resend.test.ts`, `tests/missed-call-recovery-engine.test.ts` (acknowledged basis).
- **Real or simulated behavior:** Real enforcement for the WhatsApp 24h window and approved templates and for unsubscribe headers/footer; SMS opt-out wording is a hard rule for campaigns only (a warning elsewhere); no sender postal address in marketing email; the inbound-call consent basis and staff-recorded consent are unverified business attestations.
- **Missing dependencies:** Legal review of the `inbound_call` basis, per-country SMS rules (10DLC/sender ID registration) and a postal address policy (external decision).
  - Remaining work (unblocked): (1) add a required business postal address field to company profile and append it to marketing email footers in `resend.ts` `textToSafeHtml`, refusing marketing email without it; (2) make the SMS opt-out wording a hard requirement for any marketing-purpose SMS (not only campaigns) in `evaluateSend`; (3) store a consent-evidence class (provider event, form, staff attestation) and require a stronger class before enabling marketing sends; (4) tests for each.
- **Remaining work:** Add a required business postal address and append it to marketing email footers; make SMS opt-out wording a hard requirement for any marketing-purpose SMS in evaluateSend; store a consent-evidence class and require a stronger class for marketing; tests for each.
- **Verification evidence:** Own reading; grep for "postal address" in messaging, templates and campaigns returns nothing.
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Each channel's platform and anti-spam rules are enforced in code or explicitly accepted by a recorded business acknowledgement, with legal sign-off noted for the caller-consent basis.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Website-form (and likely CRM-form) consent on a third-party-typed address is treated as verified for automated and marketing sends", "directiveRef": "§10 consent-aware patterns; privacy and anti-spam requirements", "priority": "P1", "status": "PARTIAL", "remainingWork": "Mark form-typed identities typed_by_visitor (or add a verified flag requirement) so unverifiedIdentityRefusal and the campaign audience SQL exclude them until the address writes back or a person confirms; or add double opt-in for marketing. Evidence: src/server/websites/forms.ts:60-76, src/lib/webchat/identity.ts:46, src/server/webchat/visitor.ts:362,366, src/server/crm/forms/process.ts:285-315 (not fully traced)."}
- {"title": "Outbound path row: website-chat replies (queueWebChatOutbound) use the widget's independent explicit AI setting and have a separate gate list", "directiveRef": "§10 one row per outbound path/gate", "priority": "P1", "status": "IMPLEMENTED_UNVERIFIED", "remainingWork": "Keep the per-path gate inventory current and add a direct test that the owner-disabled widget setting prevents queueWebChatOutbound regardless of messaging_settings.auto_reply_enabled."}
- {"title": "Outbound path row: host-confirmation message to a customer after a person confirms a native booking", "directiveRef": "§10 one row per outbound path/gate", "priority": "P2", "status": "IMPLEMENTED_UNVERIFIED", "remainingWork": "List src/server/appointments/confirmation-watch.ts:61 (AI actor, scope reply, no approval id, dedupe key, only for an upcoming confirmed appointment) among GP-QUAL-17 paths and add a partner-only-workspace test."}
- {"title": "Workspace-level ceiling on automatic missed-call recovery texts", "directiveRef": "§10 no mass unsolicited outreach by default; rate limits", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "Add a per-workspace hourly/daily maximum to missed_call_policies and enforce it in evaluateEligibility; test with many distinct caller numbers. Default policy is already off/manual (src/lib/missed-calls/policy.ts:73)."}
