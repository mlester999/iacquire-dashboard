# Phase 5A/5B: proposals and electronic signatures

## Summary
Nothing for tenant proposals or e-signatures exists in this tree or on any other ref. I searched by content, by file name across every local and remote ref (about 65), and by an on-disk scan of the sibling worktrees and the main checkout. There are no tables, services, PDF library, provider integration or catalog entry for PandaDoc, DocuSign, Dropbox Sign, SignNow, SignWell or Documenso, so this is greenfield. The surrounding pieces are strong. iAcquire's own agency-to-client quote flow (project_quotes, hash-bound append-only quote_approvals, explicitly 'not an electronic signature') is the closest relative. The native CRM (deals, events, activities, tasks), private_files storage and the token-based review page are all reusable. The Phase 4 social module supplies the right house pattern: version-bound approvals, a provider adapter with a simulated provider, leased idempotent jobs, sealed per-tenant credentials and an AI drafting guard. Real gaps shape the build: there is no tenant price book (pricing exists only as free text in company_knowledge), no PDF generator, no binary-capable provider HTTP helper, no generic document templates, and no public one-time-code verification. The Sales Assistant's marketing copy also promises 'proposal outlines' with no code behind it. Three defects sit in code the build would reuse: the price-grounding guard is bypassable (I reproduced it), LLM usage in website chat and social AI is never charged, and public token endpoints are throttled only per token. The recommendation is two additive migrations (0090 proposals, 0091 e-sign). The fully local product comes first: builder, versions, version-bound approval, PDF, a tokenized share page with three honest levels of 'seen', and an emailed-code acceptance record labelled as not an e-signature. Then comes a provider adapter interface with a simulated provider and an honest 'not connected' state. PandaDoc is the recommended first adapter, but nothing can be verified against a real provider until the founder supplies a sandbox account. The Phase 3-7 ledger is stale (it still says 0089 is free and Phase 4 is not started), so the next free migration number is 0090.

## Matrix

- [missing] Tenant proposals / quotes / contracts (builder, tables, PDF, delivery) for a client's own customers
    evidence: git grep and git ls-tree over every ref in refs/heads and refs/remotes (patterns: create table ... proposal|contract, filenames proposal|quote|estimat|contract|invoice|signature|pdf), plus a find over .data/wt-*, .claude/worktrees, ~/.codex/worktrees, Temp/iacquire-* and the main checkout. Only unrelated name hits: tests/perf/rls-initplan.proposal.sql, src/lib/website/thumbnail-contract.ts, src/server/setup/provisioning-contract.ts, src/server/leads/research-contract.ts (claude/lucid-nash-f8a473). No tests.
    note: Greenfield. Nothing to port from any other ref; build fresh. docs/roadmap/phases-3-to-7/architecture-and-dependencies.md:20 already says so.
- [existing-verified] iAcquire-to-client project quotes (project_quotes, quote_approvals, client_projects)
    evidence: supabase/migrations/0015_custom_projects.sql:281-346 (versions, one live quote index, append-only approvals); src/server/projects/agency.ts (saveQuoteDraft, sendQuote, withdrawQuote); src/server/projects/client.ts:349-390 (decideQuote re-checks content hash); src/server/projects/shared.ts:141-160 (quoteContentHash); src/lib/projects.ts:241 (QUOTE_ACKNOWLEDGEMENT says 'not an electronic signature'); tests/custom-projects.test.ts (422 lines: accept, hash mismatch, append-only, owner-only).
    note: Different audience (agency to its client, fixed iAcquire price catalog). Copy the pattern (frozen sent version, content hash, append-only decision, acknowledgement text), not the tables. docs/custom-projects.md:115 records that e-signature was never run against a provider.
- [missing] E-signature provider integration (PandaDoc, DocuSign, Dropbox Sign, SignNow, SignWell, Documenso, generic 'e-signature')
    evidence: Zero code hits in every ref and worktree. INTEGRATION_PROVIDERS in src/lib/integrations.ts:1 lists supabase, hermes, ghl, n8n, llm, google_calendar, email, domain, external only. Only mentions: docs/custom-projects.md:67,115 and docs/roadmap/phases-3-to-7/{architecture-and-dependencies,blockers}.md.
    note: The codebase gives no preference for a provider. Choice rests on API-key auth, sandbox, webhook scheme and the founder's own directive naming PandaDoc.
- [existing-incomplete] Integrations framework as a home for a client-owned provider connection
    evidence: integration_connections (0010_secure_integrations.sql:22-65) is agency-run, with RLS for agency only; automation_connections (0072) accepts only kinds http and slack_webhook and is tied to Automation Studio; social_accounts (0089:93-135) is the per-tenant, client-run pattern with AES-GCM credentials in a column the app role cannot read (src/server/social/credentials.ts).
    note: Use a dedicated esign_connections table following social_accounts. Do not extend integration_connections or automation_connections.
- [existing-verified] Provider adapter interface, simulated provider, durable leased idempotent jobs, reconcile-on-unknown-outcome
    evidence: src/server/social/providers/{types,simulated,meta,index}.ts; src/server/social/publisher.ts (lease, skip locked, sendingAt written before the call, reconcile, give-up window); tests/social-publisher.test.ts (321 lines), tests/social-meta.test.ts (236). The Meta adapter has only been run against a replaced HTTP layer.
    note: Direct template for the signature-provider seam and the esignSync job. simulatedAllowed() refuses the simulated adapter in production.
- [existing-verified] Webhook signature verification patterns
    evidence: src/server/billing/paymongo.ts:65-80 (HMAC-SHA256, timingSafeEqual, timestamp tolerance, event-id ledger); tests/billing.test.ts:322+; src/server/social/webhooks.ts (Meta signed_request); src/server/crm/webhooks.ts (outbound HMAC); tests/crm-webhooks.test.ts. No e-sign webhook route exists.
    note: Reuse the shape. The signing scheme of each e-sign provider must be read from that provider's documentation (not available offline).
- [missing] Binary-capable provider HTTP helper (multipart PDF upload, PDF download)
    evidence: src/server/calendars/adapters/http.ts:44-88 sends string bodies only and decodes every answer as UTF-8 text (readLimited -> TextDecoder); src/server/security/pinned-https.ts returns the answer as text (PinnedResponse.body: string).
    note: A new small helper (fixed official origins, https only, redirects refused, Buffer bodies, size and time caps) is part of the e-sign work; about 120 lines plus tests.
- [missing] PDF generation
    evidence: package.json dependencies: no PDF library (sharp is the only media package); node_modules holds none. Only a PDF reader (src/server/knowledge/extract.ts) and a test-fixture writer (tests/support/document-fixtures.ts:104).
    note: Needs a founder-approved dependency (recommended: pdf-lib, exact pin, behind a renderer seam) or a hand-written text-and-table writer. Verify pdf-lib's current maintenance before adding.
- [existing-verified] Private file storage, buckets, authorized reads and signed addresses
    evidence: src/server/storage/private.ts:11-27 (PrivateBucket, MIMES), uploadPrivateFile, readAuthorizedPrivateFile, signAuthorizedPrivateFile, validPrivateFileSignature; 0011/0049/0089 (private_files bucket check, size check relaxed to 50 MB in 0049, app.file_permission); src/app/api/files/[id]/route.ts; tests/support-files.test.ts, tests/social-media.test.ts, tests/supabase-security.test.ts.
    note: Needs a new bucket proposal-documents. app.file_permission is replaced wholesale by each migration that adds a bucket; 0089 holds the latest copy. Only 0049 and 0089 redefine it on any ref, so 0090 must copy 0089's version and add one branch.
- [missing] Document templates
    evidence: Only message templates exist: crm_message_templates and crm_message_template_versions (0031_crm_messaging.sql:85-140; src/server/crm/message-templates.ts, 1000 lines; exercised by tests/crm-blueprints-apply.test.ts and the automation-studio template tests). Website templates (0026) are site layouts.
    note: Proposal templates and versions follow the same draft/approved/archived, current_version, approved_version, content_hash, frozen-version-trigger shape.
- [existing-verified] Native CRM deals, pipelines, stage history, events, activities, tasks
    evidence: 0027/0028 migrations; src/server/crm/opportunities.ts (createOpportunityInTx, moveOpportunityInTx, closeOpportunity), events.ts (emitEvent with dedupe key, recordActivity), actor.ts (CrmActor, systemActor, agentActor); tests/crm-sales.test.ts, tests/crm-reviews.test.ts, tests/crm-api.test.ts.
    note: Proposals link to contacts, crm_companies and native opportunities by composite (id, org_id) foreign keys. crm_events.type must match ^[a-z_]+\.[a-z_]+$ (no digits). Native-only: assertNativeOwner(db, orgId, 'opportunities').
- [missing] Tenant price book / products and services
    evidence: No CRM product, price or catalog table for tenants. service_catalog and service_price_versions (0015:84-135) are iAcquire's own global catalog. A tenant's prices exist only as free text in company_knowledge (0002_workforce.sql:17-34, section approved_pricing).
    note: A tenant-owned proposal_catalog_items table is needed; no prices are seeded. AI may select catalog items by id and never write amounts.
- [existing-incomplete] Price grounding for AI text (ungroundedAmounts) and claim filtering (unsupportedClaims)
    evidence: src/server/webchat/generator.ts:55-63 and src/server/social/ai.ts:47-56 use substring matches on digits. I ran a scratch copy: '$49' vs approved '$1,499', '$15' vs '$150' and '$1' vs a text containing 2026 all returned [] (treated as grounded). tests/webchat-ai.test.ts:115-118 cover only the simple cases.
    note: Do not reuse as the guard for proposals. Use structural grounding (catalog ids) plus exact-token matching of numbers, and fix the shared function.
- [existing-incomplete] LLM client, credits check and AI drafting pattern
    evidence: src/server/llm/client.ts:51-71 (llmComplete returns text only, token usage discarded); src/server/social/ai.ts:92-98 (reads balance only); src/server/webchat/generator.ts returns outcomes without usage; compare src/server/messaging/responder.ts:289-301 (chargeModelUsage, ai_tokens_in/out). tests/social-ai.test.ts and tests/webchat-ai.test.ts use stub completers.
    note: Works for drafting but is unmetered. The proposals AI path should return usage from llmComplete (additive) and charge via chargeUsage with an idempotency key per run.
- [existing-verified] Version-bound approval, edit-voids-approval, self-approval rule
    evidence: src/lib/social/state.ts (approvalRequired: AI origin always true), src/server/social/posts.ts (submitForApproval, decide, updatePost, schedulePost), 0089 social_posts checks; tests/social-posts.test.ts, tests/social-rules.test.ts.
    note: Copy for proposals. Adds discount, limit and signature-lock rules.
- [existing-verified] Tokenized public page with open tracking, rate limits and hash-only token storage
    evidence: src/server/crm/reviews.ts:69-125 (HMAC-derived token, only sha256 stored), 860-935 (public page), src/app/r/*, src/app/api/public/reviews/*, src/proxy.ts:19-44 (PUBLIC list, SECRET_URL headers); tests/crm-reviews.test.ts. Its own comment says opens can include email scanners.
    note: Pattern to copy. Gaps: throttling is per token only, and 'opened' conflates scanners with people (see findings).
- [missing] Identity check of a public recipient by emailed one-time code
    evidence: Only portal-account flows exist (verify_email, password_reset in src/server/email.ts:6; auth_recovery_sessions in 0011). No public OTP challenge table or flow.
    note: Needed for 'signer identification' on the acceptance record. Built on sendEmail with a new template, hashed codes, attempt and rate limits.
- [existing-verified] Delivery of a customer-facing private link through the messaging chain (consent, opt-out, quiet hours, credits)
    evidence: src/server/crm/reviews.ts:525-620 (queueReviewRequestInTx via evaluateSend/queueOutbound); placeholder filled only at dispatch (src/server/messaging/send.ts:807-817); masking in src/server/messaging/redact.ts:15-45; tests/crm-reviews.test.ts.
    note: Reusable but hardcoded to the review link. A proposal link needs a generalized placeholder plus masking (inbox, AI context, exports). This touches the shared send path, so it is staged after the copy-link flow.
- [existing-incomplete] Entitlements and per-workspace rollout
    evidence: Only entitlement logic: studioEntitlement / assertStudioEntitled (src/server/automation-studio/entitlement.ts; plan = maintenance_subscriptions, US$299/month). social and webchat are permission-gated only. org_features (0001_foundation.sql:226-233, RLS select) is defined but not read or written anywhere in src/. Rollout precedent: inbox_rollout (0083) with src/server/messaging/inbox-rollout.ts.
    note: Use org_features rows ('proposals', 'esign'; absent = off) as the Super Admin activation switch. Whether any of it sits under the US$299 plan is a founder decision.
- [existing-verified] Automation Studio triggers (event outbox to workflows)
    evidence: src/lib/crm/workflow/spec.ts:46-60 (EVENT_TRIGGER_TYPES incl. social.*), 180-226 (TRIGGERS with carries levels); commit 0750677; tests/social-automation.test.ts.
    note: Add proposal.* and signature.* triggers. No send-proposal step is added, by design.
- [existing-verified] Notification kinds, groups and scheduler registry
    evidence: 0089 DO block extends notifications_kind_check from the live constraint; src/lib/notification-groups.ts; src/lib/ops.ts:61,94-96 (IN_APP_BY_DEFAULT, job labels); src/server/ops/tick.ts:61-130 (JOBS, SCHEDULER_JOBS_ONLY); tests/scheduler-intervals.test.ts:230, tests/aqi-ops-registration.test.ts.
    note: Follow the 0089 pattern. Scheduler has never run in production.
- [existing-incomplete] AI Employee proposal capability (Sales Assistant)
    evidence: Copy only: src/lib/agents.ts:142,163 ('Outline a proposal for a new client'), supabase/migrations/0006_reference_data.sql:22-24 ('Proposal outlines'), src/lib/role-playbooks.ts:82. ROLE_SCOPES.sales_assistant (src/server/crm/agent-tools/catalog.ts:58) has no proposal scope or tool. Hermes is not provisioned in production (blockers.md).
    note: In-portal AI drafting closes the gap now; an agent tool of kind 'proposal' (draft only) can follow.
- [existing-incomplete] Contact erasure and offboarding hooks
    evidence: src/server/messaging/contacts.ts:241-280 (redactContact calls eraseRecoveryAndScoring and eraseWebChatAndAttribution); src/server/offboarding/service.ts:310-378 purges all private_files buckets; src/server/offboarding/export.ts:211 exports only company-documents and brand-assets; tests/offboarding.test.ts.
    note: Proposals need an erase hook with a retention policy for accepted records (legal decision) and must be added to the data export.
- [missing] Client invoices and payments (5C/5D, adjacent)
    evidence: No invoice object: billing_accounts.invoice_url is a pasted link (src/app/(portal)/settings/billing/page.tsx:18-39). PayMongo is iAcquire's own billing (src/server/billing/paymongo.ts); no PayPal code.
    note: Out of scope here. Do not build payment on acceptance; leave an event and task hook.
- [existing-incomplete] Money formatting and currency exponent
    evidence: src/lib/billing.ts formatMinor divides every amount by 100; project quotes and CRM values assume two decimals.
    note: Restrict proposal currencies to an explicit list of two-decimal currencies until exponents are modelled.
- [existing-verified] Public routes under the proxy/CSP (frame and object blocked, Next.js 16)
    evidence: src/proxy.ts:19-44 (PUBLIC, SECRET_URL, CSP with object-src 'none', frame-ancestors 'none'); next.config.ts headers (X-Frame-Options DENY). AGENTS.md: read node_modules/next/dist/docs before writing routes (the docs directory is present).
    note: The public page cannot embed the PDF. Offer a download route. Add /proposal/ to PUBLIC and SECRET_URL.
- [existing-incomplete] Roadmap ledger accuracy
    evidence: docs/roadmap/phases-3-to-7/README.md:8 says next free migration is 0089; implementation-checklist.md lists Phase 4 'Not Started'; handoff.md says Phase 4 is next. But 0089_social_media_manager.sql and commits 76289ce..9a495af exist. Last ledger commit is ad7dc55.
    note: Next free number is 0090 (also unused on every other ref; 0084 is reserved by codex/client-ai-onboarding). Update the ledger as part of this work.
- [blocked-external] Counsel-reviewed acknowledgement and terms wording
    evidence: Existing acknowledgement text is src/lib/projects.ts:241 (agency quotes) only.
    note: Needs the founder/counsel before the module is enabled for real clients. No enforceability claim may be made from a typed name or an email code.
- [blocked-external] Real provider verification (sandbox account, API key, webhook secret)
    evidence: docs/roadmap/phases-3-to-7/blockers.md:13.
    note: Until the founder supplies a sandbox account, the real adapter stays unexercised and is labelled so, like the Meta adapter.
- [deferred-intentionally] Native typed-name 'signature'
    evidence: Founder directive plus QUOTE_ACKNOWLEDGEMENT precedent.
    note: Not built. The no-provider path records an acceptance (verified email code, version hash) and says it is not an e-signature.

## Other refs

- All local and remote refs (about 65) and all 46 listed worktrees plus the main checkout :: searched with git grep, git ls-tree and an on-disk find (terms: pandadoc, docusign, dropbox sign, hellosign, signnow, signwell, documenso, e-signature, create table ... proposal|contract; filenames proposal, quote, estimate, contract, invoice, signature, pdf) :: Nothing relevant exists anywhere. Only unrelated name matches: tests/perf/rls-initplan.proposal.sql (a performance test), src/lib/website/thumbnail-contract.ts, src/server/setup/provisioning-contract.ts, src/server/leads/research-contract.ts (claude/lucid-nash-f8a473). The founder has no port-vs-build decision: build fresh.
- origin/master 36bf78c and master 22c68c2 (agency quotes, shared base of this branch) :: supabase/migrations/0015_custom_projects.sql; src/server/projects/{agency,client,shared}.ts; src/lib/projects.ts; tests/custom-projects.test.ts :: The agency-to-client quote flow with content-hash-bound, append-only decisions. Already in this tree. Pattern source only.
- codex/client-ai-onboarding (bda64ac) and codex/hermes-gha-acceptance (8fabb19, also worktree ~/.codex/worktrees/client-ai-onboarding) :: supabase/migrations/0084_restricted_hermes_provisioner.sql :: Reserves migration number 0084. 0085/0086 are on feat/phase2-lead-conversion (applied to production); 0087-0089 are on this branch only. 0090 and 0091 are unused on every ref (verified with git ls-tree over all refs).
- feat/phases-3-7 (this branch, not pushed) :: supabase/migrations/0087-0089; src/server/social/*; src/lib/social/*; tests/social-*.test.ts; tests/support/social.ts; scripts/rehearse-phase3-migrations.mjs :: The house pattern for the new module. All Phase 4 work is local; nothing pushed or applied.
- Sibling worktrees on automation-studio branches (e.g. feat/automation-studio-final, .data/wt-studio-*, Temp/iacquire-studio-*) :: src/server/security/pinned-https.ts; src/server/security/outbound-http.ts; src/server/automation-studio/outbound.ts; supabase/migrations/0072_automation_connections.sql :: SSRF-safe, pinned-DNS outbound HTTP for header-auth JSON calls is already in this tree. It is text-only, so a binary variant is needed for PDF upload and download.
- This tree: consulting blueprint starter :: src/lib/crm/blueprints/starters/consulting.ts:30,59,200-207 :: Already has a 'Proposal sent' stage, a proposal-sent tag and a follow-up workflow triggered by that tag. proposal.sent can optionally add the tag or move the deal, replacing the manual step.
- Uncommitted state of this worktree :: src/server/storage/private.ts, src/server/websites/forms.ts, scripts/inbox-mock-llm.mjs, scripts/ui-qa.vitest.config.ts; untracked public/dev/, scripts/run-phase4-qa-seed.mjs, scripts/ui-qa-phase4-seed.qa.ts :: The four modified files differ from HEAD only by line endings (git diff --ignore-space-at-eol is empty). private.ts is the file the new bucket edit touches, so take care with CRLF and use the editor tools.

## Reuse
- src/server/social/posts.ts + post-core.ts + src/lib/social/state.ts: version-bound approval, edit voids approval, expectedVersion conflicts, event log, announce() to crm_events, approvalRequired (AI origin always true).
- src/server/social/providers/{types,simulated,index}.ts and publisher.ts: adapter interface (mayCreate/step/reconcile/health), in-process simulated world with failNext/loseResponseNext, lease + skip locked + sendingAt-before-send + unknown-outcome reconciliation. Mirror as src/server/esign/providers/*.
- src/server/social/credentials.ts + accounts.ts + settings.ts + webhooks.ts: sealed credentials column the app role cannot read, connect/health/status machine, versioned settings saves, signed callbacks.
- src/server/social/ai.ts: loadContext/ready/recordRun/extractJson/tidy structure for AI drafting (but replace the grounding check and add metering, see findings).
- supabase/migrations/0089_social_media_manager.sql: RLS select-only with app.permitted_orgs, column-level grants that hide secrets, role_permissions rows, notification-kind extension read from the live constraint, bucket + private_files check + app.file_permission replacement; supabase/rollbacks/0089_*.down.sql refuse-if-data pattern; MIGRATION_PREREQUISITES in src/server/db/index.ts:~390; tests/crm-migrations.test.ts; scripts/rehearse-phase3-migrations.mjs as the template for a phase 5 rehearsal.
- src/server/crm/reviews.ts:69-125, 528-620, 860-935 and src/app/r/*, src/app/api/public/reviews/*: derived bearer token with hash-only storage, public page by token, rate-limit rules, customerActor = systemActor, queueing a message that carries a link placeholder; src/proxy.ts PUBLIC and SECRET_URL.
- src/server/projects/shared.ts quoteContentHash, client.ts decideQuote, 0015 quote_approvals append-only trigger and project_quotes_one_live index, src/lib/projects.ts QUOTE_ACKNOWLEDGEMENT: frozen-version + hash + append-only decision + 'not an electronic signature' wording.
- src/server/crm/opportunities.ts (moveOpportunityInTx, closeOpportunity target-stage lookup), tasks.ts createTaskInTx, events.ts emitEvent/recordActivity, actor.ts (CrmActor, systemActor, agentActor, AGENCY_READ_PERMISSIONS), assignment/tags services for optional send effects.
- src/server/storage/private.ts: uploadPrivateFile, readAuthorizedPrivateFile (public download after token checks), signAuthorizedPrivateFile, validPrivateFileSignature; /api/files/[id] route headers as the template for the PDF route.
- src/server/security/{crypto,rate-limit}.ts: encryptSecret/decryptSecret, randomToken, sha256, hashIp (keyed), consumeRateLimit(+InTx) and RATE_LIMITS; src/server/billing/paymongo.ts verifyWebhookSignature shape.
- src/server/webchat/generator.ts widgetKnowledge (approved, unflagged knowledge only) and src/server/llm/client.ts (llmComplete, resolveLlmConfig); src/server/billing/ledger.ts chargeUsage and src/server/messaging/responder.ts chargeModelUsage for metering.
- src/server/notifications.ts, src/lib/notification-groups.ts, src/lib/ops.ts (IN_APP_BY_DEFAULT, job labels), src/server/ops/tick.ts (JOBS), src/lib/crm/workflow/spec.ts (EVENT_TRIGGER_TYPES/TRIGGERS).
- src/server/workforce/social-review.ts + read-only-review.ts: Performance Analyst read-only checks (pattern for a later proposal review capability).
- src/lib/permissions.ts (PERMISSION_MATRIX, AGENCY_TEAM_PROTECTED_PERMISSION_INFO) with tests/agency-team-permissions.test.ts:37 and tests/workforce-config.test.ts parity checks.
- src/server/email.ts + email-render.ts for the one-time-code email; org_features (0001) as the activation switch; src/server/offboarding/* and redactContact hooks.
- tests/support/{messaging,crm,social}.ts fixtures (messagingOrg, crmOrg, per-role contexts) on embedded Postgres; src/server/knowledge/extract.ts to parse generated PDFs back in tests.

## Risks
- Price integrity: the existing guard (ungroundedAmounts) passes invented amounts that are substrings of approved ones. If AI text is checked with it, a fabricated price can reach a client document. Mitigation: AI output schema has no money fields; amounts come only from catalog rows; free text is checked with an exact-token numeric match; humans approve every AI draft.
- app.file_permission is re-created in full by each migration that adds a bucket. 0090 must copy 0089's version exactly and add one branch. If 0089 were applied after 0090 it would silently drop the new rule, so MIGRATION_PREREQUISITES must list 0089. Add a regression test that every existing bucket's rule is unchanged.
- Bearer links: a share link is a credential. It must never be stored in message bodies, logs, audit metadata, AI context, exports or Referer headers (use hash-only storage, a derived token, no-referrer, no-store, noindex, masking in redact.ts if email delivery is added).
- Delivery through the messaging chain touches the shared send path (send.ts, redact.ts, used across about 124 files). Ship copy-link first; add the generalized placeholder with the review-link tests as the safety net.
- View tracking can be wrong: email scanners and prefetchers open links. Never show 'viewed' on a server GET alone. Keep three levels (opened, viewed after a browser beacon, verified by emailed code) and label them honestly.
- An emailed code proves control of one mailbox, not identity, and not legal signature. Copy must say so. Nothing may claim enforceability from a typed name, a checkbox or a code. Counsel must approve the acknowledgement text before enabling.
- Erasure vs retention: immutable version snapshots, the PDF and append-only decisions conflict with a contact erasure request. A policy for accepted/signed records is needed before enabling; otherwise redactContact will either leave personal data or break the audit trail.
- E-sign provider facts here come from memory (no network). The adapter must be written from the provider's current documentation, and stays unexercised and labelled until a sandbox key exists. No binary-capable HTTP helper exists yet.
- Superseded-version signing: a signer may finish a request for an older version after staff revise the proposal. The completion must be recorded as an event and flagged, never applied as acceptance of the current version.
- Race conditions: accept vs edit vs expire vs sign vs revise on the same proposal. Every transition must run in one transaction with select ... for update, compare version and content hash, and be idempotent.
- Webhooks: spoofing, replay and cross-tenant confusion. Route by a per-connection secret path token (hashed), verify the signature against that connection's sealed key, dedupe by provider event id, look documents up by (connection_id, provider_document_id), cap body size, answer fast.
- Money math: rounding, per-line discounts and tax, recurring vs one-time totals, currency exponents. Sums must equal the displayed lines exactly. Property tests are required; restrict currencies to a vetted two-decimal list.
- PDF generation: a new dependency (or a hand-rolled writer), Latin-only standard fonts unless a font is bundled, determinism (fixed creation date so the stored hash is stable), time/size caps inside serverless functions.
- Unmetered AI: llmComplete discards token usage, so website chat and social AI cost nothing to the client today. A proposals AI path built the same way would repeat the leak.
- Tenant isolation: every public path resolves the tenant from the token row, never from input; every later query filters on that row's org_id; the PDF read must verify the file belongs to the link's version before readAuthorizedPrivateFile (which does no permission check of its own). New tables must revoke all from iaq_site_runtime, anon, authenticated and public.
- The one-time code is placed in the email outbox (sendEmail stores the message). Keep the code short-lived (10 minutes), hash it in the challenge table, and consider purging outbox rows for this template quickly.
- Offboarding data export covers only company-documents and brand-assets (export.ts:211); proposals and signed copies would be omitted unless added.
- Process hazards: ledger docs are stale (0089 and Phase 4 not recorded); tests that must be extended with each registration (tests/crm-migrations.test.ts, tests/scheduler-intervals.test.ts, tests/aqi-ops-registration.test.ts, tests/agency-team-permissions.test.ts:37, workforce-config parity); withSystem cannot be nested; phone numbers in tests must be unique; edit files with the editor tools (heredocs mangle backslashes); the worktree has EOL-only uncommitted diffs.
- Nothing may be pushed, applied to a hosted database, or enabled for a real customer without approval. All verification here would be embedded Postgres, a simulated provider and a replaced HTTP layer; none of it is evidence about a real provider.

## Findings in existing code
- [high] src/server/webchat/generator.ts:60 ungroundedAmounts treats a stated amount as grounded when its digits are a substring of the approved text (corpus.includes(digits)). I reproduced it with a scratch copy: '$49' against 'Implementation: $1,499 one-time. Maintenance $299/month.', '$15' against 'inspection $150', and '$1' against a text containing '$150' and '2026' all return [] (no ungrounded amount). So a fabricated price can pass the only code-level check on visitor-facing replies and on social AI drafts. The tests cover only the simple cases (tests/webchat-ai.test.ts:115-118).
- [medium] src/server/social/ai.ts:54 The percentage check in unsupportedClaims has the same substring flaw: '5%' is accepted if the approved knowledge contains '15%' or '25%', so an invented discount or statistic can survive the filter. The same function feeds the claim filters for AI-written posts.
- [medium] src/server/llm/client.ts:51 llmComplete returns only the text and drops the provider's token usage. As a result website-chat replies (src/server/webchat/generator.ts:96-111 returns no usage) and social AI drafts (src/server/social/ai.ts:92-98 only reads the balance) are never charged, while the Hermes reply path charges ai_tokens_in/out (src/server/messaging/responder.ts:289-301). Clients' AI usage through these two features is unmetered despite the 'service credits' gating.
- [medium] src/server/crm/reviews.ts:931 The public review page and its form endpoints rate-limit by a key derived from the token only (limitKey, lines 863-867). A flood of random 43-character strings is never throttled, and each request does a rate_limit_buckets upsert plus a lookup; the cleanup of old rows runs on about 2% of calls and removes only rows over a day old (src/server/security/rate-limit.ts:33-35). There is no per-IP limit on this unauthenticated endpoint, and the same design would be copied by any new tokenized page.
- [low] src/server/projects/agency.ts:399 Quote validity compares valid_until with new Date().toISOString().slice(0, 10), the UTC date, not the workspace's date (same at src/server/projects/client.ts:369 and :171). For a workspace east of UTC a quote can still be accepted for several hours after it has expired locally. The new proposal module must compute expiry in the workspace time zone.
- [low] docs/roadmap/phases-3-to-7/README.md:8 The ledger is stale. README.md:8 says the next free migration is 0089, implementation-checklist.md lists Phase 4 as Not Started and handoff.md says Phase 4 is the next action, but 0089_social_media_manager.sql and commits 76289ce..9a495af are already on the branch. The next free number is 0090. Anyone resuming from the ledger would pick a number that is taken.
- [low] src/lib/agents.ts:163 The Sales Assistant is presented as able to 'Outline a proposal for a new client' (also agents.ts:142, supabase/migrations/0006_reference_data.sql:22-24 'Proposal outlines', src/lib/role-playbooks.ts:82), but no tool, scope or code exists: ROLE_SCOPES.sales_assistant (src/server/crm/agent-tools/catalog.ts:58) has no proposal capability. Product copy promises a capability that is not built.

## Founder decisions
- E-signature provider and account model: approve PandaDoc as the first adapter (or choose another), and decide whether each client connects their own provider account (recommended: no resale or per-document cost for iAcquire) or iAcquire runs one master account. Supply a sandbox account and API key for adapter QA, and approve either a public tunnel URL for webhook tests or polling-only testing.
- Commercial placement: whether proposals and e-signature are part of the US$1,499 implementation, sit behind the US$299/month Managed Maintenance + Automation Studio plan (one entitlement call), or are enabled per workspace by a Super Admin only. No new price is invented here.
- Legal wording and posture: counsel-approved acknowledgement text, disclaimers about enforceability and jurisdiction, and who owns the terms (the tenant). The platform must not claim that a typed name, a checkbox or an emailed code is a legally enforceable signature.
- Retention and erasure policy for accepted or signed proposals and their PDFs when a contact asks for erasure or a workspace leaves.
- Dependency decision for PDF output: add one exact-pinned library (pdf-lib recommended behind a renderer seam; check its maintenance first) or approve a hand-written text-and-table PDF writer; and whether to bundle a Unicode font (licence review) or accept Latin-only PDFs at first.
- Whether recipients must verify by emailed code just to view or download (more friction, stronger privacy) or only to accept, decline or ask for changes (recommended).
- Delivery: ship copy-link first and add email through the Inbox messaging chain later, which means a change in the shared send path and a generalized private-link placeholder.
- Defaults for deal automation (add tag or move stage on send; move to the won stage on acceptance). Recommended: all off, enabled per workspace by the owner.
- AI drafting: default off per workspace (recommended), which knowledge sections the model may read, whether it may see deal descriptions, and whether to wait for Hermes before offering a Sales Assistant tool.
- Approval policy defaults: who may approve (owner and admin), whether two-person approval is the default, and the approval threshold for large totals.
- Supported currencies at launch and whether tenants may configure tax rates themselves (recommended: yes, exclusive rates only, platform gives no tax advice).
- Whether agency staff may build templates, the price book and tax rates for clients as a setup service (recommended: yes), while sending and approving stay with the client.
- Activation sequence: approval to apply 0090 and 0091 to the hosted database one at a time with backup and dry run, to start the new scheduler jobs, and to enable any workspace.

## Recommended design
## 0. Shape and cut line

Two additive migrations, applied separately and only on approval.

- **0090_proposals** is the whole local product: settings, tax rates, tenant price catalog, templates, proposals, frozen versions, events, share links, one-time-code challenges and sessions, decisions, AI runs, permissions, notification kinds and the proposal-documents bucket.
- **0091_esign** holds provider connections, signature requests and signature events. It depends on 0090.

Services take a CrmActor, as src/server/crm/reviews.ts does. That one code path serves a member, a customer actor for public-token actions (systemActor labelled 'Customer') and, later, an agent actor. Permissions are checked with assertCan. Everything is dormant until a Super Admin adds org_features rows ('proposals', 'esign'); absent means off. Write a small helper `featureOn(orgId, feature)` with a 3 second cache, like src/server/messaging/inbox-rollout.ts.

Cut line: checkpoints C1-C3 give a complete local product with no provider. C4 adds signing against a simulated provider. The PandaDoc adapter stays unexercised until a sandbox key exists.

## 1. Tables

Every table is org-keyed with composite (id, org_id) foreign keys, has RLS, gives iaq_app_user SELECT only through `org_id = ANY((SELECT app.permitted_orgs('proposals.view'))::uuid[])`, and revokes all from public, anon, authenticated and iaq_site_runtime. Writes run in trusted server code after an assertCan.

**0090_proposals.sql** (add `"0090_proposals": ["0049_aqi_attachments","0065_support_requests","0089_social_media_manager"]` to MIGRATION_PREREQUISITES):

- `proposal_settings(org_id pk, ai_drafts_enabled bool default false, approval_mode text check in ('ai_and_discounts','all') default 'ai_and_discounts', approval_over_cents int null, discount_needs_approval bool default true, two_person bool default false, default_validity_days int null check 1..365, tag_on_send_id uuid null, stage_on_send_id uuid null, deal_on_accept text check in ('none','won_stage') default 'none', version int, updated_by, updated_at)`. No invented defaults for validity, terms or prices.
- `proposal_counters(org_id pk, last_number int)` for P-0001 style numbers, incremented with an upsert returning the value.
- `proposal_tax_rates(id, org_id, name, rate_bps int 0..10000, tax_id_label text null, archived_at)`. Rates are exclusive only (added on top of the price). Tenants configure their own; the platform has no jurisdictional tax logic.
- `proposal_catalog_items(id, org_id, name, description, unit_label, unit_price_cents int >= 0, currency, billing in ('one_time','monthly','yearly'), tax_rate_id, version, archived_at, created_by)`. Nothing is seeded. Lines in a proposal snapshot the price, so a later catalog edit never changes a sent version.
- `proposal_templates(id, org_id, key, name, status draft|approved|archived, current_version, approved_version, approved_by, approved_at)` and frozen `proposal_template_versions(template_id, version, doc jsonb, content_hash, created_by)`, same shape as 0031.
- `proposals(id, org_id, number text unique per org, title, status, contact_id, company_id, opportunity_id (composite FKs, on delete set null (col)), template_id, template_version, owner_user_id, currency char(3), valid_until date, requires_signature bool, client_name, client_email citext, doc jsonb (working copy, size check), totals columns (one_time_total_cents, monthly_total_cents, yearly_total_cents), internal_notes text (never in snapshot or PDF), origin human|ai, ai_run_id, version int, approved_version, approved_by, approved_at, sent_version, sent_at, sent_by, signature_state text, closed_at, created_by)`.
  - Checks: `approved_version <= version`; `status in ('approved','sent','accepted','declined','expired','withdrawn') -> approved_version is not null`; `status in ('sent','accepted','declined','expired','withdrawn') -> sent_version and sent_by (a user) are not null`; `origin = 'ai' and status <> 'draft' -> approved_by is not null`.
- `proposal_versions(id, org_id, proposal_id, version, snapshot jsonb, totals, content_hash, pdf_file_id -> private_files, pdf_sha256, pdf_bytes, created_by, created_at, sent_at, superseded_at)`. Unique on (proposal_id, version). A trigger blocks changing snapshot, content_hash and pdf columns once set. A version row is written when a draft is submitted (the reviewer sees exactly what is frozen).
- `proposal_events(id bigint identity, org_id, proposal_id, version null, at, kind, actor_id, actor_kind in user|ai|system|recipient|provider, detail jsonb)`, immutable (app.immutable_row).
- `proposal_share_links(id, org_id, proposal_id, version, token_hash unique, recipient_email, recipient_name, expires_at, revoked_at, delivery_channel in manual_link|email, delivery_message_id (composite FK to conversation_messages), first_opened_at, last_opened_at, open_count, first_viewed_at, viewed_count, verified_at, downloaded_at, created_by)`. Partial unique index: one unrevoked link per (proposal, version). Column grant excludes token_hash. The token is derived (HKDF key labelled 'proposal-link-v1', HMAC of the link id, 43 characters, like reviewTokenFor), so it can be re-shown to staff without storing it.
- `proposal_link_challenges(id, link_id, org_id, code_hash, expires_at, attempts, consumed_at, created_at)` and `proposal_link_sessions(id, link_id, org_id, session_hash unique, verified_email, expires_at, ip_hash, ua_hash)`. No grants to the app role at all, like social_oauth_states.
- `proposal_decisions(id, org_id, proposal_id, version, content_hash, decision accepted|declined|changes_requested, method verified_acknowledgement|provider_signature|recorded_by_staff, decided_name, decided_email, acknowledgement_version, acknowledgement_text, note, ip_hash, ua_hash, signature_request_id (FK added in 0091), recorded_by, attestation_file_id, decided_at)`. Append-only trigger; partial unique index so there is one accepted/declined row per version.
- `proposal_ai_runs` (copy of social_ai_runs).
- Bucket `proposal-documents`: extend private_files_bucket_check, replace app.file_permission with 0089's body plus `when 'proposal-documents' then app.has_permission(p_org, case when p_write then 'proposals.create' else 'proposals.view' end)`, insert into storage.buckets (application/pdf, image/png, image/jpeg; 10 MB). Add the bucket to PrivateBucket and MIMES in src/server/storage/private.ts.
- Notification kinds, appended by the same read-the-live-constraint DO block as 0089: proposal_approval_requested, proposal_approval_decided, proposal_viewed, proposal_accepted, proposal_declined, proposal_changes_requested, proposal_expiring, signature_completed, signature_failed.
- role_permissions rows (section 8). Rollback refuses while any proposal, link, decision, file or notification exists, restores the bucket check and 0089's file_permission.

**0091_esign.sql** (`"0091_esign": ["0090_proposals"]`):

- `esign_connections(id, org_id, provider check in ('pandadoc','simulated'), mode sandbox|live|simulated, label, credentials text (sealed JSON; not granted to the app role), webhook_token_hash unique, account_label, status connected|needs_attention|error|revoked|disconnected, status_detail, last_checked_at, last_success_at, connected_by, disconnected_at)`. One non-disconnected connection per org in v1.
- `signature_requests(id, org_id, proposal_id, proposal_version, version_hash, pdf_file_id, connection_id, provider, mode, status queued|sending|sent|viewed|completed|declined|expired|voided|failed|unknown|superseded, signer_name, signer_email, signer_contact_id, expires_at, provider_document_id, provider_state jsonb, idempotency_key unique, run_at, attempt, max_attempts, lease_until, claimed_by, last_error, completed_at, signed_file_id, certificate_file_id, signed_sha256, created_by)`. Partial unique index: one live request per proposal version (status in queued, sending, sent, viewed, unknown).
- `signature_events(id, org_id, request_id, at, kind, source user|system|provider_webhook|provider_poll, provider_event_id, detail jsonb)`, with a unique partial index on (request_id, provider_event_id) for webhook replay safety.
- Permission `proposals.connect`; add the proposal_decisions.signature_request_id foreign key.

## 2. State machines (pure, in src/lib/proposals/state.ts and src/lib/esign/state.ts)

Proposal: draft -> pending_approval -> approved | changes_requested | rejected; approved -> sent; sent -> accepted | declined | expired | withdrawn. A sent, declined, expired or withdrawn proposal can be revised: `revise` creates version+1 as a draft, marks the old version superseded and revokes its link. Accepted is terminal; an amendment is a new proposal.

Approval is bound to one version, as with social posts:
- Any content edit bumps `version` and clears approval.
- Send requires approved_version = version and the current doc hash equal to the approved version row's content_hash.
- Editing is refused while a live signature request exists for that version; revising voids the request first.

`approvalRequired` is true when the origin is ai, when any discount exists (if discount_needs_approval), when the total is over approval_over_cents, when approval_mode is 'all', or when the author lacks proposals.send. It is never configurable to false for AI origin. If it is false, the author with proposals.send self-approves at send time and the history says 'self_approved'.

Signature request: queued -> sending -> sent -> viewed -> completed | declined | expired | voided | failed. unknown is a lost provider answer after an attempt to create; it is reconciled and never re-sent on a guess. superseded marks a request whose proposal was revised.

## 3. Pure rules (src/lib/proposals/*)

- `money.ts`: integer cents; quantity in thousandths; line gross = round-half-up(qty x unit price); line discount (percent in bps, or fixed cents, never above gross); tax per line on the net amount, in bps, rounded half-up. Totals are sums of rounded line figures, so lines add up exactly. Totals are kept per billing group (one_time, monthly, yearly), never mixed. An explicit two-decimal currency whitelist (USD, PHP, EUR, GBP, AUD, CAD, SGD at the start).
- `doc.ts`: zod schema for the document (sections of heading and limited markdown with no HTML, line items, terms, client block, no signature section), limits, canonical JSON with sorted keys, `contentHash`, and PDF-safe character check.
- `tokens.ts`: a small renderer for client.*, deal.*, proposal.*, business.*, sender.* tokens. Unknown tokens are an error. Do not add proposal tokens to TEMPLATE_TOKENS (that catalog feeds message templates).
- `problems.ts`: blocking and warning checks: no lines; manual price differs from catalog; archived tax rate; valid_until missing, past, or past in the workspace time zone; client email missing (acceptance falls back to staff-recorded); requires_signature without a connected provider; discount without permission or over limit; unsupported PDF characters; AI-origin lines without a catalog id.
- `ack.ts`: PROPOSAL_ACKNOWLEDGEMENT_VERSION and the fixed text. Draft for counsel: 'I confirm I have reviewed proposal P-0007 (version 2). Accepting records my decision, the time, and the email address I verified against this exact document. It is not an electronic signature and has not been verified by a signing service.'

## 4. Server (src/server/proposals/*, src/server/esign/*)

- `core.ts`: row loaders with FOR UPDATE, addEvent, announce() with dedupe keys `proposal.sent:{id}:{version}`, CRM activity helpers.
- `settings.ts`, `catalog.ts`, `templates.ts`: version-checked saves (copy social/settings.ts); template approve by proposals.settings holders only.
- `proposals.ts`:
  - create from deal, contact or template.
  - update(expectedVersion): discount fields change only with proposals.discount.
  - submit; decide(version) with note; send; withdraw; revise; duplicate; recordOfflineDecision.
  - Cross-tenant ids (contact, company, deal, catalog item, template, tax rate) are refused as 'not found'.
  - `send` accepts only a signed-in member actor with proposals.send. The agent, system, API and workflow actors are refused in code, and the DB checks above make a sent AI draft without a human approver impossible.
- `documents.ts`: render the snapshot to PDF through a seam `renderProposalPdf(snapshot): Promise<Buffer>`, store with uploadPrivateFile (path `${orgId}/${fileId}/Proposal-P-0007-v2.pdf`), record sha256. Fixed PDF creation date from the version's frozen time so the hash is stable.
- `share.ts` and `public.ts` (section 6), `crm-effects.ts` (section 7), `jobs.ts`, `features.ts`.
- `esign/` (section 9).

## 5. AI drafting that can never send

`ai.ts` follows social/ai.ts, with these changes.

- **Authorization:** proposals.create plus proposal_settings.ai_drafts_enabled (default off, owner-controlled) plus an LLM config plus credits.
- **Context allowlist:** contact name and company name; deal name and description (inside a delimited untrusted-data block); the chosen template; active catalog items (id, name, description, unit, price, billing); and approved, unflagged knowledge sections (business_description, products_services, approved_pricing, policies, brand_voice) via widgetKnowledge. No conversation history, no other contacts, no internal notes.
- **Output schema:** `{intro, scopeSummary, items:[{catalogItemId, quantity, note?}], assumptions[], nextSteps[]}`. There are no fields for prices, totals, discounts, taxes, dates or terms. The server builds lines from catalog rows and rejects unknown ids and quantities outside 1..999.
- **Free-text checks:** every string passes the claim filter and an exact-token numeric check against the allowed set (catalog prices, numbers in approved pricing, the proposal's own totals). Offending text is dropped and recorded in proposal_ai_runs.output.dropped.
- **Result:** a draft with origin 'ai', owned by the requester. It can only go through approval, and approvalRequired(ai) is always true.
- **Metering:** extend llmComplete to return usage, and charge ai_tokens_in/out with chargeUsage keyed `proposal-ai:{runId}:{unit}`.
- **Automation:** no Automation Studio step can send a proposal; only triggers exist.
- **Agent tool (later):** a `prepare_proposal_draft` tool (kind 'proposal', scope `proposals:draft`, Sales Assistant only), which calls the same service. This needs src/server/crm/agent-tools/catalog.ts and the Hermes tool inventory/policy files updated, and cannot be verified until Hermes is provisioned.

## 6. Share link, verified views, acceptance

**Routes.** `/proposal/[token]` (server-rendered from the frozen snapshot), `/proposal/[token]/pdf` (download route with attachment, nosniff, no-store and `default-src 'none'; sandbox`, calling readAuthorizedPrivateFile only after the link's version owns that file), and `/api/public/proposals/[token]/{view,code,verify,decide}`. Add `/^\/proposal\//` to PUBLIC and SECRET_URL in src/proxy.ts. The page cannot embed the PDF (frame and object are blocked by policy), so it offers a download link.

**Three honest levels of 'seen'.**
- *Opened*: the server saw a GET. It may be a scanner and is never shown as 'viewed'.
- *Viewed*: a same-origin beacon fired after the page is visible for 3 seconds with a user interaction, deduplicated per session.
- *Verified*: the recipient entered the emailed code.

**One-time code.**
- The code is sent only to the link's recipient_email, never to an address typed on the page, and shown masked.
- It is 6 digits, hashed (HMAC over the challenge id), valid 10 minutes, 5 attempts, 60 second resend cooldown, at most 5 per link per hour.
- It is delivered by sendEmail with a new template added to EmailTemplate and the renderer.
- Success creates a hashed session (cookie HttpOnly, SameSite=Lax, 30 minutes sliding, 8 hours maximum).

**Actions.**
- Accept, decline, request changes and a staff question are verified-only.
- Accept needs the ticked acknowledgement and is valid only when the proposal is sent, the link version equals sent_version, the link is not revoked or expired, valid_until has not passed in the workspace time zone, and the recomputed content hash matches. All of it runs under FOR UPDATE.
- If requires_signature is true the Accept button does not exist. The page shows the signing state, or 'The business has not connected a signing service. Contact them.'

**Rate limits** (new RATE_LIMITS rules).
- Per IP hash on every public path, checked before any token lookup. This closes the random-token flood gap.
- Per token on page loads; per link and per email on code requests; per challenge on attempts; per link on decisions.

**Recording.** Decisions are append-only rows with a content hash, a verified email, and ip and ua hashes. With no email on file the link is view-only, and staff can use recordOfflineDecision (owner or admin, optional attached scan), which is labelled 'recorded by <name>; not verified by the client'.

## 7. CRM integration (src/server/proposals/crm-effects.ts)

- **On send:**
  - A recordActivity row on the contact and deal.
  - emitEvent proposal.sent.
  - Optional (off by default): add the configured tag (this lets the consulting blueprint's 'proposal-sent' workflow start automatically) and move the deal to the configured open stage via moveOpportunityInTx.
- **On accept, decline, expire or changes requested:**
  - Activity and event, and a notification to the proposal owner and deal owner.
  - A task via createTaskInTx ('Confirm next steps for P-0007').
  - The deal moves to the won stage only if deal_on_accept = 'won_stage' (default none), through the same in-transaction move that records history.
- **Failure handling:** an effect that fails is recorded as a proposal event, and never blocks the customer's decision.
- **Deal value:** proposal totals are shown on the deal and contact panels (new Proposals tab in opportunity-profile.tsx and contact-profile.tsx). The deal value is not overwritten in v1.
- **Triggers** (registered in spec.ts with DEAL carry levels): proposal.sent, proposal.viewed (first verified view per version), proposal.accepted, proposal.declined, proposal.changes_requested, proposal.expired, proposal.approval_requested, signature.completed, signature.failed. Event payloads carry ids and totals only.
- **Erasure and export:** add `eraseProposalsForContact(db, orgId, contactId)` to redactContact, with the retention policy from the founder; add proposal records and PDFs to the offboarding export.

## 8. Permissions, notifications, jobs, env

**Permissions** (PERMISSION_MATRIX, AGENCY_TEAM_PROTECTED_PERMISSION_INFO, role_permissions rows, and AGENCY_READ_PERMISSIONS for proposals.view):

| Permission | Roles |
|---|---|
| proposals.view | owner, admin, member, sales_rep, viewer, plus agency staff for support-session reads |
| proposals.create | owner, admin, member, sales_rep |
| proposals.discount | owner, admin |
| proposals.approve | owner, admin |
| proposals.send | owner, admin, sales_rep |
| proposals.record_decision | owner, admin |
| proposals.catalog (price book, templates, tax rates) | owner, admin, and agency staff as a setup service |
| proposals.settings | owner |
| proposals.connect (0091) | owner, admin |

None are delegable in v1.

**Notifications.** Kinds above, a new group 'proposals' in notification-groups.ts, and proposal_viewed in IN_APP_BY_DEFAULT.

**Scheduler** (register in tick.ts, ops.ts labels, tests):
- `proposalExpiry`: every 60 minutes; sent -> expired by workspace-local date; revokes links; emits proposal.expired and proposal_expiring warnings.
- `proposalHousekeeping`: daily; purges expired challenges and sessions.
- `esignSync` (0091): every 5 minutes; claims queued requests under a lease, sends them, reconciles unknown outcomes, polls non-terminal requests as a safety net, retrieves signed copies.

**Env** (src/server/env.ts, .env.example): `PROPOSALS_PUBLIC_DISABLED` (public pages and webhooks answer unavailable), `ESIGN_WRITES_ENABLED` (real provider calls only when true; the simulated adapter reaches nothing and is refused in production).

## 9. E-signature

**Provider seam** (src/server/esign/providers/types.ts), modeled on SocialProvider:
- `health(creds)`
- `mayCreate(input, state)`
- `createRequest(creds, input, state) -> StepResult` (resumable: upload PDF, create recipient, send)
- `reconcile(creds, input, state, since)` (find by external reference when the answer was lost)
- `getStatus(creds, providerDocumentId)`
- `downloadSigned(creds, providerDocumentId) -> {signedPdf, certificate?}`
- `cancel(creds, providerDocumentId)`
- `verifyWebhook(rawBody, headers, secret)`

Statuses are normalized to the request states in section 2.

**Flow** (provider-delivered signing, mode A: the provider emails the signer; embedded signing is deferred):
1. `requestSignature` needs proposals.send, a sent and current proposal, a connected provider (simulated, or real with ESIGN_WRITES_ENABLED) and a stored PDF. It locks the version by recording pdf_sha256 and creating one live request with an idempotency key `proposal:{id}:{version}`.
2. The job sends it; the provider contacts the signer.
3. The provider calls `/api/webhooks/esign/[connectionToken]`. The route hashes the token to find the connection, verifies the signature with that connection's sealed key, dedupes by provider event id, caps body size, and answers 200 fast.
4. On completion, the job downloads the signed PDF and the certificate (if any), stores them in proposal-documents, records signed_sha256, writes a decision with method 'provider_signature', sets the proposal to accepted, and runs the section 7 effects.
5. If the copy cannot be fetched, the state shows 'completed, signed copy not retrieved yet' and is retried.
6. A completion for a superseded version creates an event and a notification, and is not applied.

**Honest states.**
- No connection: Send is blocked for requires_signature proposals with 'This proposal needs a signature but no signing service is connected. Connect one, record signing done offline, or turn off the signature requirement.'
- A simulated connection shows 'Simulated: no real document was sent and nothing is legally binding'.
- A sandbox connection shows 'Sandbox'.

**Credentials.** Per-workspace, owner or admin connects with their own provider account (sealed JSON with API key and webhook key). Health check and status machine as in social/accounts.ts. Secrets are never returned to the browser or logs.

**First adapter: PandaDoc**, written only after the engineer reads PandaDoc's current API reference. From memory, to be verified:
- API-key auth per workspace; free sandbox keys.
- PDF upload with recipients, then a send call.
- HMAC-signed webhooks with a shared key.
- Download of completed documents.
- Pricing and plan requirements for production API use.
- Field-placement mechanism.

It runs in tests only against a replaced HTTP layer (tests/esign-pandadoc.test.ts, labelled as unexercised). DocuSign is the natural second adapter (reach, more setup: integration key and go-live review). SignWell is a cheaper API-key alternative. Self-hosted Documenso means iAcquire operates a signing server, so it is not first.

## 10. Pages and routes

- **Portal:**
  - `/proposals` (list, filters, status chips)
  - `/proposals/new`
  - `/proposals/[id]` with tabs Edit, Preview, Versions, Activity, Delivery, Signature
  - `/proposals/approvals`
  - `/proposals/templates`
  - `/proposals/catalog`
  - `/proposals/settings` (approval policy, tax rates, AI toggle, e-signature connection card)
  - A sidebar entry gated by proposals.view and org_features.
- **Public:** `/proposal/[token]`, `/proposal/[token]/pdf`, `/api/public/proposals/...`.
- **Webhook:** `/api/webhooks/esign/[connectionToken]`.
- **Server actions:** src/app/actions/proposals.ts, using the act() wrapper pattern of src/app/actions/social.ts.
- **Before writing any route or page:** read node_modules/next/dist/docs (AGENTS.md; the pattern is async params and `export const dynamic = 'force-dynamic'`).

## 11. Tests (embedded Postgres, tests/support/proposals.ts built on messagingOrg and crmOrg)

- **tests/proposals-rules.test.ts:** property tests for rounding and sum identity, discount and tax rules, currency whitelist, approvalRequired truth table, state transitions, token rendering, hash stability, validity in the workspace time zone.
- **tests/proposals-service.test.ts:**
  - Roles per permission.
  - Version-bound approval; edit voids approval; stale expectedVersion; a discount without permission is refused.
  - AI-origin always needs approval and cannot be sent without a human approver; DB checks reject sent-without-approval; frozen version trigger.
  - Cross-tenant ids refused; a viewer cannot write.
- **tests/proposals-public.test.ts:**
  - Bad, expired, revoked and superseded tokens.
  - Unknown-token flood is throttled per IP.
  - Code flow: wrong code, expiry, attempts, replay.
  - Decisions only when verified; double accept yields one decision; edited-after-send is refused by hash; decisions are append-only.
  - Open, view and verified counters; the PDF is served only for the link's version; cross-tenant.
- **tests/proposals-pdf.test.ts:** render, parse back with extract.ts, pagination, unsupported characters blocked, stable hash.
- **tests/proposals-ai.test.ts:** stub completer; selection by catalog id only; invented price, percentage and claim dropped; injection text in the deal description ignored; draft status; credits out; setting off; metering charged once.
- **tests/proposals-crm.test.ts:** events and activities deduped; tag and stage effects off by default; effect failure does not block acceptance; redaction hook; org_features gating; the offboarding export includes proposals.
- **Migrations and RLS:** extend tests/crm-migrations.test.ts, write scripts/rehearse-phase5-migrations.mjs (sections A-E like phase 3), plus RLS tests: RLS on, select-only for the app role, nothing for anon, authenticated, public or iaq_site_runtime, and no secret column granted.
- **tests/esign-rules.test.ts, tests/esign-service.test.ts** (simulated provider): connect and disconnect; idempotent enqueue; lost answer -> unknown -> reconcile; webhook signature valid, invalid, replayed and cross-tenant; completion stores the signed copy and sets accepted; superseded completion not applied; void on revise; honest not-connected errors; simulated refused in production; secrets never selectable.
- **Browser QA:** a new phase 5 seed and script following the phase 3 recipe (local cookie bridge, no password in chat); public page at 375 and 1280, light and dark, axe, link-scanner simulation; mobile behavior of the builder.

## 12. Order of work and size

1. **C1, about 2,000 lines with tests.** 0090 and its rollback, rehearsal, MIGRATION_PREREQUISITES, permissions, notification kinds, pure rules, settings, catalog, templates and proposals services (no PDF or public pages), org_features helper, ledger update.
2. **C2, about 1,800.** PDF seam and renderer (needs the dependency decision), bucket, versions, share links, public page and PDF route, one-time code, decisions, CRM effects, jobs, proxy entries.
3. **C3, about 1,500 plus about 1,800 of screens.** AI drafting with the grounding and metering fixes, triggers, portal screens, deal and contact panels, browser QA.
4. **C4, about 1,500.** 0091, binary HTTP helper, provider seam, simulated provider, connection, request service, webhook route, esignSync, signature UI, PandaDoc adapter written to the documentation and labelled unexercised.
5. **C5, optional.** Email delivery through the messaging chain with a generalized bearer-link placeholder and masking; the Sales Assistant tool; a Performance Analyst proposal review.

Deferred on purpose: DOCX export, multi-signer and countersigning, embedded signing sessions, tax-inclusive pricing, optional/selectable line items, deal-value sync, payment on acceptance (5C/5D).

Each checkpoint ends with full tests, both typechecks, lint, a clean build and the migration rehearsal on embedded Postgres only. Nothing is pushed or applied without approval.