# Phase 7I/7J/7L: security posture, performance tooling and launch operations (audit of feat/phases-3-7 at 9a495af, migrations through 0089)

## Summary
The security architecture is strong and consistently applied. All 306 public tables have RLS, there are no views, anon/authenticated hold no table grants, all 29 SECURITY DEFINER functions pin search_path, and every one of the 115 API routes and the server actions has a guard or a deliberate public mechanism (signature, bearer token or secret URL). Webhook signature verification, receipt-based replay protection, SSRF pinning for client-supplied webhook and automation URLs, the AI-employee scope model and the social publisher's idempotency are well built and tested. The defects I traced are mostly in the newest code and in cost and operations controls rather than in tenant isolation: an env regex that crashes the whole app if META_GRAPH_VERSION is set, public website-chat AI replies and social AI drafts that are never metered or rate limited, weak consent for visitor-typed contact details, no encryption-key rotation path, and an offboarding export that omits the Phase 2 to 4 tables. Performance tooling is good for the CRM and Inbox (50k-contact and 30k-conversation harnesses) but absent for web chat, attribution and social, there is no statement timeout on most paths, and no hosted measurement exists because no staging project does. Launch operations are the weakest area: there is no CI on any mainline ref, the scheduler has never run in production (Vercel Hobby plan), the activation preflight script covers only migrations 0077-0081, Phase 4 has no migration rehearsal or ledger entry, there is no external paging or error tracking, and several release documents are stale or point at a checklist that does not exist. Nothing here was run against a hosted system; evidence is code reading, catalog scans of the migrations, one executed zod check, and the existing test inventory (340 test files).

## Matrix

- [existing-verified] Row-level security on every public table (tenant isolation)
    evidence: Scan of supabase/migrations/*.sql: 306 create table, 306 enable row level security, 0 views, 0 FORCE RLS. tests/tenant-isolation-generic.test.ts (7, reads the live catalog), tests/tenant-isolation.test.ts (19, seeded rows, cross-org/stranger/staff).
    note: 45 tables are RLS with no policy (server-only: auth_*, rate_limit_buckets, integration_credentials, social_oauth_states, ...). Owner role bypasses RLS by design, so every withSystem caller must authorize itself. The generic test only covers tables that have an org_id column.
- [existing-verified] Browser-facing role lockdown (anon, authenticated, PUBLIC)
    evidence: 0009_supabase_foundation.sql:70-95 revokes tables, sequences, functions and default privileges; only grants to authenticated are USAGE on schema app plus 3 functions (0011:94-95). Generic test asserts none of anon/authenticated/public can touch tenant tables. 0087/0088/0089 grant SELECT only to iaq_app_user.
    note: Hosted default-ACL state for 0087-0089 cannot be verified until they are applied; earlier releases verified it by ad hoc read-only queries each time.
- [existing-verified] SECURITY DEFINER functions (29)
    evidence: Scan: all set search_path; all revoke PUBLIC except app.file_permission, file_access_allowed, setup_topic_allowed (deliberately granted to authenticated). app.site_chat_widget (0087) is executable by iaq_site_runtime only.
    note: Verified by my scan, not by any test. app.file_permission has been fully redefined 6 times (0011, 0015, 0020, 0039, 0044, 0049, 0089); 0089 equals 0049 plus one bucket line (diffed).
- [existing-verified] Authorization on API routes and server actions
    evidence: 115 route.ts files and 69 use-server files (628 exports) swept. Every route has requireUserOrThrow, requireOrgContextOrThrow, requireAgency*, resolveCrmActor, resolveAqiViewer, requireOpsAdmin, studioContext, API key, bearer token, signature or secret URL. Mutating cookie routes use assertSameOrigin or requireOpsAdmin({mutating}). Direct withSystem in src/app is org-scoped (workforce.ts, inbox.ts, chat.ts, v1 CRM via API key).
    note: No test enforces 'every new route has a guard'; the proxy comment is explicit that /api/* is never redirected. Recommend a guard-inventory test.
- [existing-verified] Public surface in src/proxy.ts and what each does
    evidence: PUBLIC: /login /forgot-password /reset-password /verify-email /auth/ /invite/ /get-started (rate-limited auth); /api/health (liveness plus scheduler freshness); /api/public/* (booking, forms/submit, portfolio, services, reviews, unsubscribe, webchat/[action], workflows/[token]); /api/webhooks/* (ghl, meta-whatsapp, paymongo, resend, retell, vapi, twilio, meta-social x3); /api/internal/tick (bearer CRON_SECRET, timingSafeEqual, 503 unless SCHEDULER_ENABLED); /widget/chat.js (static); /dev/* (each of 14 pages calls notFound() in production); /book/, /unsubscribe/, /f/, /r/ (token or public data).
    note: /dev/ is public in the proxy and protected only by a per-page guard. Public JSON endpoints each cost one Postgres write for rate limiting.
- [existing-verified] Provider webhook signatures and replay protection
    evidence: PayMongo HMAC with mode check, 24h window, event-id ledger with row lock (billing/payments.ts, paymongo.ts); GHL RSA + webhook_receipts; Twilio signature + receipts keyed on signed fields; Resend/Svix 5-minute tolerance + svix-id receipt; Meta WhatsApp X-Hub-Signature-256 + wamid receipts; Vapi/Retell per-tenant secret + auth-failure rate limit; Meta social signed_request HMAC timing-safe (social/providers/meta-oauth.ts:105). Tests: billing 45, billing-routes 8, messaging-twilio 26, messaging-resend 44, messaging-whatsapp 34, social-meta 24.
    note: PayMongo and every provider contract were exercised only against mocks (paymongo.ts header says never run against a test or live account). webhook_receipts has an index on received_at but nothing prunes it.
- [missing] PayPal (selected payment provider)
    evidence: git grep -i paypal over src, supabase, scripts, docs: no hits outside the roadmap ledger.
    note: Only PayMongo exists and it covers iAcquire's own billing, not client payments. Phase 5 greenfield.
- [blocked-external] Payment idempotency, amount/currency/reference checks, mode separation
    evidence: payments.ts:126-186 (signature before parse, event ledger, for-update lock, reference+mode+amount+currency match, mismatch raises critical notification, live checkout gated by live_payments_review_at).
    note: Correct by reading and mocks; needs PayMongo test keys and an end-to-end test top-up to be called verified.
- [existing-incomplete] Outbound HTTP / SSRF protection
    evidence: Automation Studio and CRM webhooks: lib/automation-studio/outbound.ts policy + server/security/pinned-https.ts (resolve once, public addresses only, pinned socket, no redirects, port 443) - tests/outbound-http.test.ts (15). Onboarding site read pins via safeLookup. LLM, Hermes, n8n, GHL, portfolio and integration probes use fetch with redirect:'error' to agency-configured hosts (INTEGRATION_ALLOWED_HOSTS).
    note: CalDAV and ICS URLs typed by clients use check-then-fetch (calendars/adapters/http.ts:14-17 documents the DNS-rebinding gap). src/server/security/outbound-http.ts only judges responses; the policy lives in src/lib/automation-studio/outbound.ts.
- [existing-incomplete] Rate limiting
    evidence: server/security/rate-limit.ts: Postgres fixed-window counters, 60+ named rules in RATE_LIMITS, webchat RATE in webchat/visitor.ts:21-26. All public endpoints key on the first X-Forwarded-For entry.
    note: Correct on Vercel (header is platform-set); deployment.md:94 tells operators to ensure this elsewhere. No index on window_start; cleanup is a 2% probabilistic delete inside request transactions.
- [existing-incomplete] Credential and secret storage
    evidence: Vault references for Hermes/GHL/n8n (docs/credential-security.md, tests/integrations-security.test.ts 26). Social tokens, calendar tokens, Automation Studio connection secrets and CRM webhook secrets use encryptSecret (AES-256-GCM, key = sha256(APP_ENCRYPTION_KEY)) in columns the app role cannot read (0089:302 column grants).
    note: No key id, decryptSecret ignores APP_ENCRYPTION_KEY_PREVIOUS, no rotation script. credential-security.md claims no new application-encrypted secrets, which is no longer true.
- [existing-verified] Secrets in logs and in client bundles
    evidence: git grep of console.* in src: handlers log only err.name or ids; env secrets never imported by client components; supabase-config.ts rejects NEXT_PUBLIC_ secret keys; webhook and cron error responses are generic.
    note: One exception: chat/service.ts:619 logs the raw error object.
- [existing-verified] File access control (private storage)
    evidence: storage/private.ts: path pattern org/uuid/name, MIME allowlist per bucket, magic-byte check, permission via app.file_permission under withUser on every read and upload, 60-120 s signed URLs, /api/files/[id] blocks aqi bucket and re-checks support visibility; social media preview requires social.view (api/social/media/[id]).
    note: No test asserts that every PrivateBucket has an arm in app.file_permission.
- [existing-verified] AI employee permissions and unsafe tool execution
    evidence: crm/agent-tools/catalog.ts ROLE_SCOPES intersect token scopes intersect CRM permissions; org and agent from the token row; per-employee and per-IP rate limits; write tools become approvals unless autonomous and low impact. lib/workforce-capabilities.ts: allowedRoles, requiredPermission, risk. social_performance_review is read-only for performance_analyst. Tests: crm-agent-tools 28, workforce-review-capabilities.
    note: No seventh employee was introduced (social AI drafting is a plain LLM utility under social.create).
- [existing-verified] Prompt-injection defences
    evidence: webchat/generator.ts: delimited untrusted text, only owner-approved knowledge, price grounding (ungroundedAmounts), instruction-leak block; social/ai.ts: claim and amount filter, no model-written links; AQi ops, builder and config review have hostile-input tests (aqi-ops-*, automation-studio-builder-guards, config-review-hardening, webchat-ai 'keeps a hostile message as data').
    note: Only stub generators were exercised; no real model has been evaluated (blockers.md). Real-model evaluation is blocked on a provider key.
- [broken] AI usage metering and runaway protection
    evidence: messaging/responder.ts:282 charges usage only when outcome.usage exists; webchat/generator.ts:99-101 never sets it because llmComplete (llm/client.ts:48) returns no usage. social/ai.ts:92-100 checks balance>0 only. usage_limits/assertWithinLimits (server/usage.ts) are used by employee chat and AQi help, not by channel replies or social AI.
    note: Public website chat and social drafting can spend iAcquire's LLM budget without debiting the workspace or hitting any per-org ceiling.
- [existing-verified] Idempotency (API, webhooks, publishing, chat)
    evidence: v1 CRM Idempotency-Key with advisory lock (api/v1/crm/_lib/http.ts), webhook_receipts everywhere, social_publish_jobs idempotency_key and one-live-job-per-post unique index, webchat clientMessageId dedupe_key, PayMongo event ledger. Tests: crm-api 16, social-publisher 22, webchat-service 27.
    note: 
- [existing-verified] Scheduler duplication and overlap
    evidence: claimSchedulerTick lease (30 s finished window, 5 min crash reclaim), per-job claims and everyMinutes slot claims, SCHEDULER_JOBS_ONLY staging. tests/scheduler-job-allowlist, scheduler-intervals, operations, automation-studio-scheduler-rehearsal.
    note: The scheduler has never run in production. 52 jobs are registered; 7 (leadScoreReassessment, missedCallRecovery, phase2Retention, webChatRetention, socialPublisher, socialAccountHealth, socialMetrics) are missing from docs/unified-inbox/scheduler-impact.md. A platform-killed tick (120 s maxDuration) leaves the lease for 5 minutes.
- [existing-incomplete] Failed background job visibility
    evidence: worker_job_runs heartbeats per job, scheduler:/queue:/messaging:/credits:/payments:/website:/domain:/integration:/ghl:/hermes:/automation: collectors (ops/collectors.ts:271-281), per-workspace notifications for failed posts.
    note: No collector prefix for social (jobs stuck in unknown, accounts in needs_reauth), webchat, lead-scoring queue depth or ai_work_jobs; the platform never hears about them.
- [existing-incomplete] Subscription / entitlement enforcement
    evidence: Only Automation Studio is entitled (automation-studio/entitlement.ts reads maintenance_subscriptions; every entry point and the engine re-check). org_features (0001) is unused. Social, web chat, lead scoring and missed-call recovery have no plan gate.
    note: Matches the rule 'new features use the existing entitlement system' only if the founder says which features are plan features; today social.* is granted to every client role by 0089.
- [existing-incomplete] Feature flags and kill switches
    evidence: Env: GHL/RESEND/TWILIO/META_WHATSAPP/N8N_ACTIONS/META_SOCIAL writes, CALENDAR_SYNC_DISABLED, INBOX_DISABLED, SCHEDULER_ENABLED + SCHEDULER_JOBS_ONLY, WORKFORCE_*, OFFBOARDING_PURGE_ENABLED. Per workspace: inbox_rollout, web_chat_widgets.enabled, recovery/scoring policies off by default.
    note: No global switch for the public web chat API; social has a publish switch but none for connect or AI drafting; the social menu is visible to every workspace (sidebar.tsx, permission social.view).
- [existing-incomplete] Unauthorized external communication
    evidence: All sends pass evaluateSend with consent, suppression, quiet hours and provider write switches; AI replies fenced by ownership version; social publishes need approval of the exact version and META_SOCIAL_WRITES_ENABLED.
    note: Web chat records service (and, if ticked, marketing) consent on visitor-typed, unverified email/phone (visitor.ts:373-376) and send rules never read contact_identities.verified.
- [broken] Environment validation (src/server/env.ts)
    evidence: Production guards for Supabase, TLS, key length, legacy credentials, Hermes URLs are solid and tested (environment-safety 4). env.ts:107 META_GRAPH_VERSION regex is /^vd{1,2}.d$/ and rejects 'v26.0' (executed with zod); .env.example:141 sets it.
    note: No test parses .env.example or the META_* variables.
- [missing] External penetration test and dependency scanning
    evidence: docs/deployment.md:126 lists a penetration test as outstanding; no .github, no audit step, dependencies pinned exactly except tsx ^4.
    note: Needed before real clients per the repo's own checklist.
- [existing-verified] CRM performance harness
    evidence: tests/perf/{harness,seed,pairs,crm-scale.perf.test}.ts: 50,000 contacts, 20,000 messages, statement capture with timings, EXPLAIN ANALYZE under RLS; docs/crm-performance.md (565 lines); migrations 0057 and 0060 came from it. Run with CRM_PERF=1.
    note: PGlite in memory, indicative only; no hosted EXPLAIN.
- [existing-verified] Inbox and Phase 2 scale probes
    evidence: tests/perf/inbox-scale.perf.test.ts (30,000 conversations, 150,000 messages), phase2-scale.perf.test.ts (20,000 contacts / 8,000 cases); docs/unified-inbox/performance-risks.md: search 611 ms because of RLS on conversation_messages, 5 s poll about 75 ms per tab.
    note: Concurrency and hosted latency (iad1 to Tokyo about 150 ms per round trip) not measured.
- [missing] Performance coverage of Phase 3/4 (web chat, attribution, social)
    evidence: grep of tests/perf for webchat, web_chat, lead_touch, social: no matches.
    note: Widget polls every 8 s (assistant), 4 s (team), 30 s (closed) and each poll costs 3-4 transactions.
- [existing-incomplete] Query timing / telemetry
    evidence: db/index.ts:197-217 IAQ_DB_TRACE=1 prints statements and ms per transaction; /admin/health; AQi ops health tools state that pg_stat_statements and APM are not read (aqi/ops/tools/health.ts:23).
    note: No slow-statement log, no APM, no hosted statement stats.
- [existing-incomplete] Pagination and unbounded reads
    evidence: CRM and Inbox use cursor pages of at most 50 and 200-message caps; calendar 2,000 appointments with a notice. social/posts.ts:129 caps at 500/1000 rows with full captions; social/layout.tsx:7 loads 200 posts to show a count.
    note: Documented known limits in crm-performance.md:522-565.
- [existing-verified] Indexes on the 0087-0089 hot paths
    evidence: web_chat_sessions: unique token_hash, (org_id, created_at), conversation, retention; lead_touches (org_id, contact_id, occurred_at, id) and report index; social_publish_jobs due/lease/active partial indexes; social_posts due and org indexes.
    note: Gaps: rate_limit_buckets(window_start); social_posts calendar query orders by coalesce(published_at, scheduled_at, created_at) but the index uses coalesce(scheduled_at, created_at).
- [existing-incomplete] Statement timeouts and pool
    evidence: db/index.ts:86 pool max 4 (DATABASE_POOL_MAX); withUser default statement_timeout '0' (index.ts:286); only crm/actor.ts:152 sets 30 s; no migration sets role timeouts.
    note: A slow statement on a public path pins a quarter of the pool shared with the portal.
- [existing-verified] Migration runner, prerequisites and sequence guards
    evidence: db/index.ts runMigrations/selectMigrationFiles/MIGRATION_PREREQUISITES; scripts/migrate.ts (--dry-run, --only, --through); tests/migrate-args.test.ts, migration-prefixes.test.ts (duplicate prefix guard). Numbers 0053, 0073-0076, 0084 are unused here; 0090 is free on every ref.
    note: 
- [existing-incomplete] Rollback scripts and migration rehearsal
    evidence: supabase/rollbacks/*.down.sql exist through 0089 and refuse when data exists; scripts/rehearse-migration-order.mjs (0081-0083), rehearse-phase2-migrations.mjs (0085-0086), rehearse-phase3-migrations.mjs (0087-0088) with A-E checks.
    note: No rehearsal or migration test for 0089; verification-evidence.md and the checklist have no Phase 4 entries.
- [existing-incomplete] Production activation preflight and release verification
    evidence: scripts/production-activation-preflight.ts targets migrations 0077-0081 only (TARGETS array). Releases since used hand-run read-only queries recorded in prose (phase2/05-release-readiness.md, unified-inbox/rollout-plan.md).
    note: docs/production-scheduler.md:187,200 refer to a 'release checklist' with a pending-work query; no such file or script exists.
- [existing-incomplete] Backup and restore
    evidence: pg_dump custom-format backups taken and pg_restore --list verified before each hosted migration (phase2/05 release record); docs/offboarding-and-export.md:49 requires one proven restore before OFFBOARDING_PURGE_ENABLED.
    note: A restore into a scratch project has never been done; storage buckets and APP_ENCRYPTION_KEY backup are described but not drilled.
- [blocked-external] Staging environment
    evidence: docs/staging-environment.md and .env.staging.example prepared; docs/unified-inbox/rollout-plan.md update: founder skipped staging stages.
    note: All hosted behaviour (RLS cost, scheduler, concurrency, Vercel limits) remains unmeasured.
- [existing-verified] Scheduler activation checklist and staged start
    evidence: docs/production-scheduler.md (CRON_SECRET + SCHEDULER_ENABLED, SCHEDULER_JOBS_ONLY, ordered steps, rollback), production-audit-2026-10-22.md (Vercel Hobby: daily cron only; no vercel.json).
    note: Not run. Needs Vercel Pro, pg_cron + pg_net, or an external cron; 7 newest jobs need adding to the inventory.
- [existing-incomplete] Provider activation checklists
    evidence: messaging-providers.md, calendar-integrations.md, integrations-setup.md, hermes-*.md, finance-and-billing.md cover existing providers.
    note: None for Meta social (app registration, redirect URI, deauthorize and data-deletion callbacks, App Review) beyond .env.example comments; none for web chat install or PayPal.
- [existing-incomplete] Monitoring and alerting
    evidence: /api/health with scheduler freshness, /admin/health, incident engine (open from evidence, close from later pass), AQi Operations read tools (release.info, health tools). Slack alert only for new tickets and project requests (notifications.ts:154 callers).
    note: No error tracking or APM, no external uptime monitor recorded, critical incidents are in-app only and emailed by a job that runs inside the scheduler that may be the thing that died.
- [missing] CI / CD
    evidence: No .github on any mainline ref. Only codex/hermes-gha-acceptance has a workflow, scoped to that branch; docs/aqi-phase2-release-gate.md:16 says Vercel deploys master automatically.
    note: Typecheck, lint and 5,000+ tests run by hand before pushes.
- [existing-incomplete] Staff support procedures and known-limitations docs
    evidence: support-requests.md, setup-center.md, operations-and-incidents.md (incident semantics), per-module Known limitations sections.
    note: No incident response runbook, no consolidated limitations page, nothing for web chat or social. docs/roadmap/phases-3-to-7 is stale for Phase 4 (README says next number 0089; checklist and architecture matrix say social is not started).

## Other refs

- codex/hermes-gha-acceptance (also origin/codex/hermes-gha-acceptance 8fabb19) :: .github/workflows/hermes-client-acceptance.yml (only CI workflow in the repository, SHA-pinned actions, push-scoped to that branch); services/hermes-provisioner/** (Dockerfile, worker.py, acceptance_harness.py, compose files, catalog overlays, tests); src/app/api/internal/hermes-provisioner/{claim,complete}/route.ts; src/server/workforce/hermes-provisioner.ts, provisioner-http.ts; supabase/migrations/0084_restricted_hermes_provisioner.sql and rollback; tests/hermes-provisioner.test.ts; docs/hermes-restricted-provisioner.md :: 62 files, +20,954 lines relative to origin/master. Useful for 7L as the pattern for a real CI workflow. Its new /api/internal/hermes-provisioner routes sit under the proxy's public /api/internal/ prefix and rely on their own bearer token plus an enable flag. It also edits src/server/env.ts, src/server/db/index.ts and src/server/security/credentials.ts, so porting will conflict with this branch.
- codex/client-ai-onboarding (bda64ac) :: same services/hermes-provisioner/**, 0084 migration, provisioner routes and tests (34 unique files), without the GitHub workflow :: Earlier line of the same provisioner work. The 0084 number is reserved by it; scripts/rehearse-phase3-migrations.mjs section B checks that order does not matter.
- main checkout working tree (not a ref; uncommitted, found by reading the files) :: C:/Users/ZEPHY/Documents/Marky Files/Programming Projects/iAcquire-dashboard: scripts/hermes-cutover/{OPERATOR.md,VALIDATION.md,cutover.py,deploy.py,rollback.py,test_cutover.py}, docs/hermes-production-cutover.md, dist/hermes-cutover-review-20261019.zip, modified scripts/production-activation-preflight.ts (9 lines), tmp/ (115 files of ad hoc hosted-database diagnostics and logs) :: Launch-operations material that exists only in the founder's main checkout, untracked and not git-ignored. A cutover/rollback runbook and scripts for Hermes that 7L should either adopt or consciously leave out; tmp/ must not be committed.
- worktree .claude/worktrees/confident-moser-b13a2b (7a4301e, uncommitted) :: src/server/ops/tick.ts, src/server/ops/jobs.ts, docs/production-scheduler.md, docs/operations-and-incidents.md :: A competing, uncommitted version of the interval-gating change that the memory notes call 'two competing withinInterval fixes'; this branch already carries the merged everyMinutes design, so do not port it.
- all other refs (65 branches, 46 worktrees) :: git ls-tree comparison against HEAD for paths matching security, perf, monitor, health, launch, release, backup, restore, alert, smoke, audit, runbook, preflight, checklist, incident, rollout :: Nothing else relevant exists only on another ref; remaining differences are old UI renames and website thumbnails.

## Reuse
- src/server/security/rate-limit.ts (consumeRateLimit, consumeRateLimitInTx, RATE_LIMITS) for new AI and kill-switch limits
- src/server/usage.ts (assertWithinLimits, recordUsage, usage_limits, usage_events) and src/server/billing/ledger.ts (chargeUsage, getBalance) plus responder.chargeModelUsage (src/server/messaging/responder.ts:289) for AI metering
- src/server/security/pinned-https.ts checkedLookup and src/server/onboarding/website.ts isPublicAddress for the CalDAV/ICS pinned GET
- src/server/security/crypto.ts and the 'v1.' envelope for a versioned key-rotation format
- tests/tenant-isolation-generic.test.ts catalog-reading pattern for new catalog guards (SECURITY DEFINER, bucket parity, route inventory)
- tests/perf/{harness,seed,pairs}.ts and the CRM_PERF=1 switch in vitest.config.ts for web chat, attribution and social scale probes
- scripts/rehearse-phase3-migrations.mjs (sections A-E) as the template for rehearse-phase4 and later rehearsals
- scripts/production-activation-preflight.ts and scripts/migrate.ts --dry-run as the base for scripts/release-verify.ts
- src/server/ops/collectors.ts (prefix collectors), src/server/ops/incidents.ts and notifications.ts sendAgencySlackAlert for new collectors and out-of-band paging
- src/server/ops/tick.ts JOBS with everyMinutes and SCHEDULER_JOBS_ONLY, plus src/lib/ops.ts job labels, for a platformRetention job
- src/server/aqi/ops/tools/release.ts (release.info) and health tools as the in-product view of migrations and switches
- src/server/offboarding/export.ts TABLES spec and tenantTables() in offboarding/service.ts for the export coverage fix and guard
- src/server/automation-studio/entitlement.ts (studioEntitlement pattern) if the founder gates social or web chat behind the maintenance plan
- supabase/migrations/0083, 0087, 0089 notification-kind and constraint-extension DO blocks as the pattern for any constraint change
- docs/production-scheduler.md, docs/unified-inbox/rollout-plan.md, docs/phase2/05-release-readiness.md as the release-record format

## Risks
- Public website-chat traffic can drive unmetered LLM spend that iAcquire pays; the widget key is public and Origin is only enforced by browsers, so per-address limits are the only brake and they depend on a trustworthy X-Forwarded-For.
- Setting META_GRAPH_VERSION as .env.example shows takes down every request in the portal at env() parse time; no test would have caught it.
- The scheduler has never run in production and starts all 52 jobs at once unless SCHEDULER_JOBS_ONLY is used; webChatRetention deletes data, messagesDispatched converts queued messages to blocked while provider switches are off, and the project is on Vercel Hobby (daily cron only, function and payload limits to be verified).
- Nothing is measured on the hosted database (no staging): RLS cost (400 ms of a 611 ms inbox search), 150 ms per round trip to Tokyo, pool of 4, and public polling traffic sharing that pool with the portal are all unquantified.
- app.file_permission is replaced wholesale by each bucket migration; a branch that redefines it from an older copy (0084 branch, or a future Phase 5/6 bucket) silently drops the social-media arm. MIGRATION_PREREQUISITES guards order only for 0089.
- APP_ENCRYPTION_KEY rotation or loss makes social, calendar, Automation Studio connection and webhook secrets unreadable with no recovery path other than reconnecting everything.
- Client data portability and the offboarding promise: the export omits Phase 2-4 data and social media files, while purge deletes them (tenantTables), so a departing client can lose data that was never offered.
- Unverified visitor-typed phone/email with recorded consent can be used to message third parties through workflows or staff; legal exposure (TCPA/GDPR-style) before the chat is enabled for real visitors.
- DNS-rebinding window on CalDAV/ICS fetches (documented, limited to port 443 with certificate checks).
- No CI and automatic Vercel deploy of master: a push that breaks typecheck or tests reaches production.
- The in-process chat stream hub (deployment.md:85) assumes one instance while Vercel runs many; pre-existing, documented, final answers are still saved.
- Social media upload accepts 50 MB through a route handler; Vercel's request body limit (about 4.5 MB, to be verified on the deployed plan) will reject larger files, so videos cannot be added in production as written.
- Mixed line endings (49 CRLF, 8 mixed files, no .gitattributes) make diffs of security-sensitive files such as storage/private.ts unreviewable (490-line diff for zero content change).
- The roadmap ledger stops at Phase 3 while four Phase 4 commits exist; a resuming session would plan migration 0089 again.

## Findings in existing code
- [high] src/server/env.ts:107 META_GRAPH_VERSION is validated with /^vd{1,2}.d$/ (the backslashes were lost). Executed with zod: undefined and blank pass via the default, but 'v26.0' (the default and the value at .env.example:141) and every real version fail. Setting the variable makes env() throw 'Invalid server environment configuration: META_GRAPH_VERSION' on every code path that reads configuration, i.e. the whole portal. No test parses .env.example.
- [high] src/server/webchat/generator.ts:99 Public website-chat AI replies are never metered: llmComplete (src/server/llm/client.ts:48-70) returns only {ok,text}, parseReply (generator.ts:101) attaches no usage, and responder.ts:282 charges only 'if (outcome.usage)'. The balance check (responder.ts 'credits' skip) only stops at zero, which nothing lowers. Callers need only the public widget key and any Origin header (non-browser clients can forge it); bounds are 12 sessions/hour and 150 messages/hour per address (visitor.ts:21-26), 60 default (300 max) messages per session and 300 default (5,000 max) sessions per day per workspace: up to 18,000 default / 1.5 million maximum model calls per workspace per day at 500 tokens each, paid by iAcquire. usage_limits.monthly_agent_messages is not applied to channel replies.
- [medium] src/server/social/ai.ts:92 suggestIdeas/suggestCaptions (ai.ts:124,169) call the platform LLM with no rate limit (no RATE_LIMITS entry) and no usage charge; ready() only checks balance > 0, which these calls never reduce. ai_drafts_enabled defaults to true (0089_social_media_manager.sql:42) and any user with social.create can loop 900/1,200-token calls. Currently gated only by needing a connected account, i.e. by the Meta app being configured.
- [medium] src/server/webchat/visitor.ts:373 captureLead records 'service' consent (and 'marketing' when the box is ticked, line 376) for an email/phone the anonymous visitor typed, stored as unverified. evaluateSend never reads contact_identities.verified, and webchat.lead_captured is a workflow trigger (lib/crm/workflow/spec.ts:220 itself says anyone can type anyone's address), so a workflow SMS/email step or staff can contact a third party who never consented.
- [medium] src/server/security/crypto.ts:72 decryptSecret supports only the current APP_ENCRYPTION_KEY; the v1 envelope has no key id and APP_ENCRYPTION_KEY_PREVIOUS (env.ts:28) is honoured only by review links, workflow URLs and unsubscribe tokens. Rotating or losing the key makes social tokens (social/credentials.ts:8, accounts.ts:142), calendar credentials, Automation Studio connection secrets (automation-studio/connections.ts:128) and CRM webhook secrets (crm/webhooks.ts:157) unreadable; there is no rotation script. docs/credential-security.md still says no new application-encrypted secrets are created.
- [medium] src/server/offboarding/export.ts:28 The export TABLES list contains none of the Phase 2-4 tables (web_chat_*, lead_touches, attribution_costs, social_*, missed-call and lead-score tables) and the file export (line 211) covers only company-documents and brand-assets, so social-media bucket files are omitted; executeDeletion (offboarding/service.ts:339) purges every table found by tenantTables(), so a departing client loses data that was never exported. No test ties tenant tables to export coverage.
- [medium] src/server/db/index.ts:286 withUser applies statement_timeout '0' (unlimited) unless the caller passes one; withSystem, withServiceRole and withSiteRuntime set none; only crm/actor.ts:152 sets 30 s and no migration sets role timeouts. The pool is max 4 (line 86), shared by public endpoints (chat, forms, booking, rate limiting) and the portal, so one pathological statement can pin a quarter of it. docs/crm-performance.md:564 already lists this as not done.
- [medium] docs/aqi-phase2-release-gate.md:16 There is no CI anywhere on the mainline (no .github on master or this branch; the only workflow is branch-scoped on codex/hermes-gha-acceptance) and Vercel deploys master automatically, so typecheck, lint and the 5,000-test suite are enforced only by hand before a push.
- [medium] src/app/api/public/webchat/[action]/route.ts:1 The public web chat API has no global kill switch (INBOX_DISABLED exists for the inbox, META_SOCIAL_WRITES_ENABLED only gates publishing). If the widget key of one workspace is abused, the brake is a per-workspace disable by someone with website.edit or a deployment.
- [low] src/server/calendars/adapters/http.ts:14 CalDAV and ICS URLs typed by clients are checked with assertPublicHttps and then fetched with fetch(), which resolves DNS again (documented known gap, DNS rebinding). The pinned-https.ts checkedLookup exists but only supports a discarded-body POST.
- [low] src/server/security/rate-limit.ts:35 The 2% probabilistic 'delete from rate_limit_buckets where window_start < now() - 1 day' runs inside user-facing and public request transactions, and rate_limit_buckets has no index on window_start (supabase/migrations/0001_foundation.sql:99-104), so it is a sequential scan of the hottest write table. webhook_receipts (0019:292) has an index but nothing ever deletes from it.
- [low] src/app/(portal)/social/layout.tsx:7 Every render of the social layout calls listPosts(..., limit 200) with all joins and caption text only to display '.length' as the approval badge; the approvals page then loads the same list again. A count query is enough.
- [low] src/app/api/social/media/route.ts:20 The handler advertises and accepts 50 MB (MEDIA_MAX_BYTES) but checks size only from Content-Length before request.formData() buffers the whole body, and a platform request-body limit (Vercel's is about 4.5 MB, to be verified for the deployed plan) will reject larger uploads before the handler runs, so videos and large images cannot be uploaded in production as written. The same pattern exists in knowledge/upload and project file routes (10 MB).
- [low] src/proxy.ts:32 /dev/ is a public prefix and production safety depends on each of the 14 dev pages calling notFound() (all do today). There is no central guard or test, so a new dev page without the check would be reachable unauthenticated.
- [low] .gitignore:14 tmp/, dist/, output/ and public/dev/ are not ignored: the main checkout holds 115 untracked files in tmp/ including hosted-database diagnostics and logs, and this worktree has untracked public/dev/qa-axe.min.js and qa-page.js that would be served at /dev/ if committed.
- [low] src/app/actions/attribution.ts:47 Entering campaign costs (which feed the Lead Sources report) requires the analytics.export permission, an unrelated read/export right, so the permission model for who can write financial inputs is implicit rather than designed.
- [low] src/server/chat/service.ts:619 console.error('chat persistence error', err) logs the raw error object, unlike every other handler which logs only err.name; PostgreSQL errors can carry row values in their detail.
- [low] src/server/ops/collectors.ts:271 No collector covers social publishing (jobs stuck in 'unknown', accounts in needs_reauth), web chat, lead-scoring queue depth or ai_work_jobs, and critical incidents are delivered in-app and by the notificationEmails job inside the tick (tick.ts), while sendAgencySlackAlert is used only for new support tickets and project requests (support/service.ts:165, projects/client.ts:211). If the scheduler is what died, nobody is told out of band.
- [low] docs/production-scheduler.md:187 Refers twice (lines 187, 200) to 'the pending-work query from the release checklist'; no such checklist or query exists in docs/ or scripts/. scripts/production-activation-preflight.ts covers only migrations 0077-0081, and docs/unified-inbox/scheduler-impact.md lacks the 7 jobs added since (leadScoreReassessment, missedCallRecovery, phase2Retention, webChatRetention, socialPublisher, socialAccountHealth, socialMetrics).
- [low] docs/deployment.md:128 Stale: still says no production deployment has been performed (line 4), to run one instance (85), payments are mocks only (122), and to 'apply migrations 0016-0025' (128) while production's ledger is at 0086. Also stale: docs/verification-status.md (to 0065), docs/schema-inventory.md (258 tables), docs/crm-performance.md:524 (0060 'not yet on the hosted project'), and docs/roadmap/phases-3-to-7 (handoff, checklist and architecture matrix still say Phase 4 is not started and the next number is 0089).
- [low] src/server/storage/private.ts:1 No .gitattributes: 49 committed files are CRLF and 8 mixed (git ls-files --eol), so the security-critical storage module shows a 490-line working-tree diff with zero content change, and src/server/websites/forms.ts now mixes LF lines from a Phase 3 edit into CRLF content. Diff review of security changes becomes unreliable.

## Founder decisions
- Which features sit behind the Managed Maintenance + Automation Studio plan (US$299/month) versus the US$1,499 implementation: website chat, lead scoring, missed-call recovery, social media. The entitlement system only covers Automation Studio today; no prices are to be invented.
- Vercel plan: stay on Hobby (daily cron only, platform function and payload limits) or move to Pro, or use Supabase pg_cron + pg_net, or an external cron, for the scheduler.
- Approve creating a staging project (cost) so load tests, RLS cost, scheduler rehearsal and Vercel limits can be measured before real customers.
- Introduce CI and decide whether Vercel production deploys must wait for it (required status check or ignored-build step).
- Error tracking / APM provider and budget, who is paged for a critical incident, and through which channel (Slack webhook, email, SMS).
- Commission an external penetration test (auth, tenant isolation, uploads, credentials) before onboarding real clients, and when.
- Consent policy for website chat: require email/SMS verification before any automated or marketing message, and legal review of the default privacy notice and consent wording.
- Data retention periods for webhook receipts, audit logs, rate-limit rows and web chats; whether the Phase 2-4 data belongs in the client export (recommended: yes, minus secrets).
- Credential policy: keep social/calendar/Studio/webhook secrets under the application key with a rotation procedure, or move them to Supabase Vault like Hermes/GHL/n8n.
- Whether to add global kill switches for the public web chat and for social (recommended), and their default state.
- PayPal: scope, timing and account for client payments (PayMongo exists only for iAcquire's own billing).
- Whether social media is visible to every workspace once the Meta app is configured, or rolled out per workspace like the Unified Inbox (inbox_rollout).
- Order and timing of scheduler activation and of applying migrations 0087-0089 (and 0090), including which jobs start first.
- Whether to adopt the main checkout's uncommitted Hermes cutover runbook (scripts/hermes-cutover, docs/hermes-production-cutover.md) into the repository.

## Recommended design
## Shape of the work

Three workstreams, one migration (`0090_launch_hardening`, additive), about 2,500-3,500 lines including tests and docs. No new AI Employee, no new prices, no change to PayMongo/PayPal selection. Nothing is applied, pushed or enabled without the founder's approval. Order matters: fix what is broken first, then close cost and consent exposure, then add the guards that keep it closed, then performance, then launch operations.

### Ordering

1. Env fix (1 hour): correct `env.ts:107` to `/^v\d{1,2}\.\d$/`; add `tests/env-example.test.ts` that parses every `KEY=value` line in `.env.example` and `.env.staging.example` through the schema (blank and unset allowed) and asserts META_GRAPH_VERSION `v26.0` passes and `26.0` fails.
2. AI metering and ceilings (A1).
3. Consent/identity rule (A2).
4. Guard inventory tests (A3), key rotation (A4), export coverage (A5), kill switches (A6), timeouts (A7), DNS pinning (A8).
5. Migration 0090, platform retention job, hot-path changes (B).
6. CI, release-verify, collectors, paging, docs (C).

## A. Security (7J)

**A1. Meter and cap every AI call.**
- `src/server/llm/client.ts`: add `usage?: { inputTokens: number|null; outputTokens: number|null }` to the `ok: true` arm of `LlmReply`; fill it from `json.usage` (OpenAI `prompt_tokens/completion_tokens`, Anthropic `input_tokens/output_tokens`). Backwards compatible.
- Export `chargeModelUsage` from `responder.ts` (or move to `src/server/billing/model-usage.ts`). `createWebChatGenerator` returns `{ kind: "reply", text, usage }` so the existing `if (outcome.usage) chargeModelUsage(...)` runs. Social AI calls `chargeModelUsage(db, orgId, "social-ai:"+runId, usage)` inside the `recordRun` transaction (providerReference unique per run).
- Ceilings reuse `usage_limits` and `usage_events` (0004): migration adds `usage_limits.daily_web_chat_replies integer not null default 500 check (>= 0)` and `daily_social_ai_calls integer not null default 100 check (>= 0)`, and extends the `usage_events.kind` check (read the live constraint and extend it, as 0083/0087/0089 do) with `web_chat_reply` and `social_ai`. Extend `assertWithinLimits(orgId, kind)` / `recordUsage` to those kinds (daily window). Web chat: check before `replyToVisitor` calls the model (a refusal becomes the existing WAIT_MESSAGE and an escalation, never a silent drop); social AI: check in `ready()`.
- New `RATE_LIMITS`: `socialAiByUser` {20/hour}, `socialAiByOrg` {60/hour}, `webchatMessagesByWidget` {600/hour per widget key, a global brake against distributed abuse}. Consume them before the model call.
- Tests: `webchat-metering.test.ts` (reply debits ai_tokens_in/out, daily cap stops the model call and escalates, tokens recorded in usage_events), `social-ai-limits.test.ts` (rate limit, daily cap, debit, balance zero), unit test for usage extraction in both API formats.

**A2. Unverified contact details never authorize automated or marketing sends.**
- `evaluateSend` (`src/server/messaging/send.ts`): new deny reason `identity_unverified` (add to `BLOCK_REASON_LABELS` in `src/lib/messaging.ts`) when scope is AI/automation/workflow/campaign/marketing and the destination `contact_identities.verified = false` and the contact `created_via = 'website_chat'`. A staff member's manual one-off reply is still allowed.
- Web chat lead form: stop recording `marketing` consent at capture for unverified addresses; record it as `pending` evidence on the session and grant it only after verification (email link or SMS code through the existing consent/token machinery) - decision D-consent below. Keep `service` consent for replies in the open chat only.
- Tests: extend `webchat-leads.test.ts` and add a workflow case: `webchat.lead_captured` -> SMS step is blocked with `identity_unverified`; after `staff_confirmed` verification it sends.

**A3. Guard inventory tests (catch regressions at build time).**
- `tests/route-guards.test.ts`: walk `src/app/api/**/route.ts`; each file must match a guard marker regex OR appear in an explicit `PUBLIC_ROUTES` allowlist (the public set listed in the matrix); same for `'use server'` exports (guard marker inside the function or a local wrapper that contains one).
- `tests/dev-pages-guard.test.ts`: every `src/app/dev/**/page.tsx` contains `notFound()` for production; consider also adding `src/app/dev/layout.tsx` that calls `notFound()` when `NODE_ENV === "production"` so a new page is safe by default.
- `tests/definer-functions.test.ts`: live catalog - every `prosecdef` function in schema app/public has `proconfig` containing `search_path` and no PUBLIC EXECUTE except an allowlist of the three file functions.
- `tests/file-permission-buckets.test.ts`: every member of `PrivateBucket` returns a non-null decision from `app.file_permission` for an owner of the right permission and false for a stranger.
- Cross-tenant behavioural cases for the newest modules: web chat token of org A against org B's widget key, social media preview id of org B, OAuth state used by another user, `revokeByProviderUser` only touching accounts with that provider user.

**A4. Key rotation that works.**
- New envelope `v2.<kid>.<iv>.<tag>.<ct>`, `kid = first 8 hex of sha256(key)`; `decryptSecret` selects the key by `kid` from `[APP_ENCRYPTION_KEY, ...APP_ENCRYPTION_KEY_PREVIOUS]` and still reads `v1.` with the current then previous keys. `encryptSecret` writes v2.
- `scripts/rotate-app-encryption-key.ts` (dry-run default, `--apply --confirm-project <ref>` like migrate-credentials-to-vault): re-encrypts `social_accounts.credentials`, `social_oauth_states.pending`, the calendar connection credentials column, `automation_connections.secret_ciphertext`, and CRM webhook secret columns in per-table transactions with row counts and a read-back decrypt check; never prints values.
- Update `docs/credential-security.md` to state which secrets are Vault and which are app-encrypted, and the rotation runbook. Tests: round-trip v1/v2, previous-key read, rotation script on PGlite with all five tables.

**A5. Export coverage and a guard.** Add to `TABLES` in `src/server/offboarding/export.ts`: `web_chat_widgets` (omit public_key? keep, it is not secret), `web_chat_sessions` (omit `token_hash`, `ip_hash`), `lead_touches`, `attribution_costs`, `social_settings`, `social_campaigns`, `social_posts`, `social_post_events`, `social_media_assets`, `social_ai_runs`, `social_post_metrics`, `social_accounts` with `pick` of non-secret columns only (never `credentials`), the missed-call and lead-score tables; extend the private-file export bucket list with `social-media`. Add `tests/offboarding-coverage.test.ts`: every tenant table is in `TABLES`, in `PURGE_RETAINS`, or in an explicit `EXPORT_EXEMPT` set with a reason; fails when a future migration adds a table.

**A6. Kill switches.** `WEBCHAT_DISABLED` and `SOCIAL_DISABLED` booleans in `env.ts` (default false). Web chat: `chatRoute` answers 503 `unavailable` and the widget shows nothing; the `socialPublisher`, `socialAccountHealth`, `socialMetrics` jobs and connect/AI actions return 'temporarily unavailable'; nothing is deleted. Document in `.env.example` and the switch table. Tests like `unified-inbox-switch.test.ts`.

**A7. Time limits.** Prefer connection-level settings to avoid extra round trips: set `statement_timeout` (60 s) and `idle_in_transaction_session_timeout` (30 s) on the `pg` Pool config; keep the CRM 30 s member read and give `withUser` a 30 s default instead of '0'; allow `withSystem(fn, { statementTimeout })` for the few long jobs (imports, exports, tick) with an explicit larger value. Verify on staging that the pooler accepts startup parameters; if not, fall back to `set local` inside the existing first statement of withUser and add one for withSystem only on public paths (web chat, forms, booking).

**A8. Pinned GET for calendars.** Generalize `pinned-https.ts` `post()` into `pinnedRequest({ method, url, headers, body, maxBytes, timeoutMs })` returning status, headers and a size-capped body, and use it in `calendars/adapters/http.ts` for CalDAV/ICS (keep `providerRequest` for Google/Microsoft fixed origins). Remove the 'known gap' paragraph and update `docs/calendar-integrations.md`. Tests extend `outbound-http.test.ts` with the rebinding lookup double already used for POST.

**A9. Smaller fixes.** `addCostAction` should require a cost permission (reuse `analytics.view` plus owner/admin, or add `attribution.costs.manage` delegating to OWNER_ADMIN) instead of `analytics.export`; log only `err.name` at `chat/service.ts:619`; add `.gitattributes` (`* text=auto eol=lf`) and normalize the 57 CRLF/mixed files in a separate whitespace-only commit; add `tmp/`, `dist/`, `output/`, `public/dev/` to `.gitignore`; widget polling backs off (see B).

## B. Performance (7I)

- **Social:** replace the layout count with `countPostsByStatus(ctx, "pending_approval")` (single `select count(*)`); let `listPosts` select a list-shaped column set (caption truncated to 280) and accept a real `limit`; add `social_posts (org_id, (coalesce(published_at, scheduled_at, created_at)) desc)` to match the query.
- **Web chat hot path:** (1) in-process 30 s cache of `getWidgetByKey` + `siteHostsFor` keyed by public key (invalidate on save/rotate through the version column, fall back safely); (2) one `withSystem` for `sessionForToken` + `visitorView` instead of three; (3) widget backoff: poll 8 s for 2 minutes after the last event, then 20 s, then 60 s, stop after 10 minutes hidden/idle, honor `Retry-After`; (4) cheap per-session limit on `messages` GET using an in-process counter like the Inbox poll (a DB write per poll is what we are removing); (5) the platform pool is shared, so cap public concurrency per instance (semaphore of 2 DB-using public requests) so a flood cannot starve the portal.
- **Retention job `platformRetention`** (everyMinutes 1440, registered in `JOBS`, label in `src/lib/ops.ts`): delete `webhook_receipts` older than 90 days, `rate_limit_buckets` older than 2 days (so the 2% in-request delete can be dropped), in batches of 5,000 per run; `payment_webhook_events` and `audit_logs` are not touched. Add index `rate_limit_buckets (window_start)`.
- **Measurement tooling:** `tests/perf/webchat-scale.perf.test.ts` (100,000 sessions, 400,000 messages, 500,000 touches, the sources report, `messages` poll path, daily-count query), `social-scale.perf.test.ts` (50,000 posts, 5,000 jobs, calendar month, claimNext under `skip locked`). Structured slow-statement logging: extend `IAQ_DB_TRACE` with `IAQ_SLOW_MS=250` to log `{label, ms, statements}` only above the threshold (no SQL parameters). `scripts/load-public-endpoints.mjs` (node fetch loop, concurrency flag) that refuses to run unless `--target` host is not the production host or `--allow-production` is passed; run it only on staging.
- Budgets to record on staging (indicative targets, not claims): `config` and `messages` p95 under 150 ms at 50 concurrent visitors, no more than 4 statements per poll, Inbox first page under 120 ms at 30,000 conversations.

## C. Launch operations (7L)

- **CI:** `.github/workflows/ci.yml` modeled on the Hermes workflow (permissions contents:read, SHA-pinned actions, Node 24): `npm ci`, `npm run typecheck`, `npx eslint src tests scripts`, `npx vitest run` (the suite takes about 450 s), `node scripts/build-clean.mjs --webpack` on pull requests and pushes to master; no secrets. Founder decides whether Vercel production deploys wait for the check (required status check or Vercel ignored-build step).
- **`scripts/release-verify.ts`** (read-only, `--live` like the preflight; replaces the 0077-0081-only script): ledger vs migration files and prerequisites; every public table has RLS and a policy for iaq_app_user where granted; no grants to anon/authenticated/PUBLIC; SECURITY DEFINER hygiene; notification kinds and permissions present; env switch NAMES and whether each is on (never values); scheduler state; pending-work counts (queued/sending messages, email_outbox, reminders, workflow runs, campaigns, imports, provider switches, pending webhook deliveries, social_publish_jobs queued/unknown, web chat sessions today, lead-scoring queue). Output a table the release record can paste.
- **`scripts/rehearse-phase4-migrations.mjs`** (0089 and 0090 on PGlite, sections A-E) and a `tests/migration-0089.test.ts` for the rollback refusal and RLS grants.
- **Docs (new `docs/launch/`, short, current):** `release-checklist.md` (backup with pg_dump custom format and `pg_restore --list`, dry run, `--only` one at a time, verify script, deploy order migrate-first, smoke, rollback), `environment-matrix.md` (every variable, who sets it, production guard, kill switch table), `scheduler-activation.md` (move the activation steps here, add the 7 missing jobs and a staged order: scoring/recovery/retention first, social jobs only after Meta is approved, messaging last), `provider-activation/meta-social.md`, `paymongo.md`, `paypal.md` (blocked), `web-chat-install.md`, `backup-restore.md` (include a scratch-project restore drill and storage buckets), `incident-runbook.md` (one section per collector prefix: meaning, safe first actions, who), `known-limitations.md`. Update stale files: `deployment.md` (lines 4, 85, 122-128), `verification-status.md`, `schema-inventory.md`, `credential-security.md`, `crm-performance.md:524`, `production-scheduler.md:187,200`, `unified-inbox/scheduler-impact.md`, and `docs/roadmap/phases-3-to-7/*` (Phase 4 evidence, next number 0091).
- **Monitoring:** new collectors in `ops/collectors.ts`: `social:` (jobs in unknown > RECONCILE_GRACE, accounts needs_reauth > 24 h, failed posts last 24 h per workspace), `webchat:` (AI unavailable ratio, daily limit reached, widget enabled with no allowed origin), `scoring:` (queue depth/age), `workjobs:` (ai_work_jobs failed streak). Critical incident open also calls `sendAgencySlackAlert` directly (not via the scheduler-dependent notificationEmails job). Error tracking: `instrumentation.ts` `onRequestError` forwarding sanitized errors to the chosen service (founder decision). External uptime monitor on `/api/health` alerting on `never_ran`/`stale`/503.
- **Entitlements:** only after the founder decides, add `src/server/entitlements.ts` with `featureEntitlement(db, orgId, "social" | "web_chat")` generalizing `studioEntitlement`, called at the same kinds of entry points (actions, public config, publisher claim). Do not invent plan membership or prices.

## Migration 0090_launch_hardening.sql (additive, rollback file required)
- `create index rate_limit_buckets_window_idx on rate_limit_buckets (window_start)`.
- `alter table usage_limits add column daily_web_chat_replies ..., add column daily_social_ai_calls ...`; extend `usage_events` kind check from the live constraint.
- `create index social_posts_calendar_idx on social_posts (org_id, (coalesce(published_at, scheduled_at, created_at)) desc)`.
- No new tables, no new grants, no new permissions, no new notification kinds. Add `0090` to `MIGRATION_PREREQUISITES` (needs 0004 columns, 0089), rollback drops the columns/indexes and restores the check; rehearse with the Phase 4 script before any hosted step.

## Tests that must exist before launch
env-example parse; route/action guard inventory; dev-page guard; SECURITY DEFINER hygiene; bucket parity; AI metering and caps (web chat, social); identity_unverified send rule; key rotation round trip; export coverage guard; kill switches; statement timeout behaviour; pinned GET rebinding; migration 0089/0090 rehearsal; web chat and social scale probes; collectors open/close.