export const meta = {
  name: 'wave1-adversarial-review',
  description: 'Read-only adversarial review of Wave 1 (proposals, e-signature, customer invoices and payments, reputation, AI cost and consent), every finding independently verified',
  phases: [
    { title: 'Review', detail: '10 lens reviewers + 1 requirement-coverage mapper, read-only' },
    { title: 'Verify', detail: 'each finding checked by independent skeptics that try to refute it' },
  ],
}

const WT = 'C:\\Users\\ZEPHY\\Documents\\Marky Files\\Programming Projects\\iAcquire-dashboard\\.data\\wt-phases-3-7'
const SCRATCH = 'C:\\Users\\ZEPHY\\AppData\\Local\\Temp\\claude\\C--Users-ZEPHY-Documents-Marky-Files-Programming-Projects-iAcquire-dashboard\\32890764-5c6b-4d98-a485-d33dd7eeb47d\\scratchpad'
const BASE = (args && args.base) || '6b00245'
const AUD = 'docs/roadmap/phases-3-to-7/audit'

const COMMON = `
CONTEXT
You are reviewing "Wave 1" of Phase 5 of iAcquireOS, a multi-tenant Next.js (a NON-standard, newer Next.js: AGENTS.md says read node_modules/next/dist/docs before assuming APIs) + Postgres (PGlite embedded for tests, Supabase in production) app. A "client" is a business (the tenant) with a native CRM, AI Employees, Automation Studio, Unified Inbox, website chat and lead attribution. Wave 1 adds, for those clients: proposals with an e-signature seam, customer invoices and customer payments (the client's own PayMongo or PayPal account; iAcquire never holds the money), reputation management (surveys, review request batches, public reviews mirrored from Google and Facebook and replies to them) and retention, plus a shared AI cost meter and a messaging-consent rule for visitors who typed their own contact details.
Worktree (the only tree you review): ${WT}   Branch feat/phases-3-7. Wave 1 = everything changed since commit ${BASE} (git diff --stat ${BASE}; the final stages are uncommitted or in the latest commits, so also read git status). Design documents: ${AUD}/5ab-proposals-esign.md, 5cd-customer-invoices-payments.md, 5fg-reputation-retention.md, 7ijl-security-performance-launch.md and docs/roadmap/phases-3-to-7/phase-5-7-plan.md, docs/esignature.md.
Wave 1 code: src/lib/{proposals,pdf,esign,invoices,reputation,money}, src/server/{proposals,esign,invoices,customer-payments,reputation,llm/meter.ts,webchat/switch.ts,messaging/consent-identity.ts,workforce/receivables-review.ts,workforce/reputation-review.ts}, src/components/{proposals,invoices,reputation}, src/app/(portal)/{proposals,invoices}, src/app/{proposal,pay}/**, src/app/api/public/{proposals,invoices}/**, src/app/api/webhooks/{esign,customer-payments}/**, src/app/api/reputation/**, src/app/dev/simulated-checkout/**, src/app/actions/{proposals,invoices,reputation}.ts, supabase/migrations/0091 to 0095 and their rollbacks, scripts/rehearse-combined-migrations.mjs, and edits to shared files (src/server/ops/tick.ts, src/lib/ops.ts, src/server/messaging/*, src/server/offboarding/*, src/proxy.ts or equivalent, src/server/env.ts).
Product rules this wave must obey (from the founder's directive): nothing financial is ever marked paid, signed or accepted on a guess: only a verified provider fact or an explicit, audited human record; AI output is always a draft a person approves; no fabricated claims, prices, discounts, reviews, ratings or testimonials; review-gating-safe rules R1 to R8 in the reputation audit are law (no filtering, steering or suppressing by sentiment, no incentives for a particular rating); strict tenant isolation (every public path resolves the tenant from a server-side row, never from input); secrets and tokens never reach browsers, logs, audit trails or notifications; honest states (the UI never says a customer has read, signed or paid unless the database says so); consent and quiet-hours rules apply to every customer message; everything dormant until a Super Admin switches the workspace on; simulated providers are refused in production; no real provider call happens without an explicit env switch that is off by default.
There is NO live PandaDoc, PayMongo, PayPal, Google Business or Meta account: every provider adapter is tested only against replaced HTTP layers or a simulated twin. Do not report that as a defect (it is documented). Report what is WRONG within what exists.

RULES FOR YOU
* READ-ONLY. Do not create, edit or delete any file inside the worktree. You may write scratch files ONLY under: ${SCRATCH}
* Another process may be running the full test suite or type checks on this machine. You may run at most two targeted tests, each as: node scripts/run-locked.mjs test -- node node_modules/vitest/vitest.mjs run tests/<one file>   (the lock makes you wait your turn; embedded database, no network). Do NOT run the full suite, a build, a dev server, or anything on ports 3100/3270/3280/3299. Never call any real external API. Be economical.
* Report ONLY real defects or real gaps that you traced through the code to a concrete failure (specific inputs/state -> wrong outcome). No style nits, no speculative "might", no restating that something is simulated or unverified. If your lens finds nothing real, return an empty findings array: an honest empty result is correct and valuable.
* Give exact file paths relative to the worktree and a line number. Severity: critical = cross-tenant exposure, credential leak, money marked received/refunded wrongly, a document signed/accepted on a guess, a customer message sent in breach of consent, or data loss; high = security/authorization hole or silent wrong behaviour users would act on; medium = incorrect behaviour in realistic conditions or a missing guard; low = minor but real.
* Before reporting, look for an existing guard elsewhere (DB constraint, trigger, RLS, unique index, caller check, Zod schema, a test that proves it). A finding that a guard already prevents is wrong. Tests that pass do not make code right: check that a test would actually fail without the guard.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    summary: { type: 'string', description: 'two or three sentences: what you examined and how' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'number' },
          failure_scenario: { type: 'string', description: 'concrete inputs/state and the wrong outcome' },
          suggested_fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'line', 'failure_scenario', 'suggested_fix'],
      },
    },
  },
  required: ['lens', 'summary', 'findings'],
}

const LENSES = [
  {
    key: 'money',
    prompt: `LENS: money arithmetic, payment truth and verified revenue.
Read src/lib/money/index.ts, src/lib/invoices/{lines,state,close-rule,number,hash,guards}.ts, src/server/invoices/{invoices,payments,core,apply,overdue,revenue,share}.ts, src/server/customer-payments/{attempts,events,reconcile,read-back,links,ids}.ts, src/lib/proposals/{money,lines,doc}.ts, migration 0093 triggers that freeze money after issue, src/lib/invoices/revenue.ts, tests/money.test.ts, tests/invoices-rules.test.ts, tests/invoices-service.test.ts, tests/customer-payments-reconcile.test.ts.
Examine: per-line rounding vs total, tax-inclusive vs exclusive, discounts, zero-decimal currencies (JPY), BigInt vs number mixing, PGlite returning bigint as number versus the hosted driver returning text (anything that adds or compares columns as JS numbers); overflow; negative or zero amounts; partial payments, over-payment, refunds (partial, full, repeated, concurrent), disputes and reversals; the rule that an invoice becomes paid only from a payment row the database counts (provider-verified or an explicit audited manual record) and never from a browser return, a redirect, a client-supplied amount or a webhook that was not verified; amount and currency checked against the invoice and the attempt when the provider says paid (a short-paid or wrong-currency payment must not close the invoice); duplicate provider events and event replays (idempotency keys, unique indexes); out-of-order events (refund before payment, paid after void); the state machine (void/write-off of a paid or part-paid invoice); invoice numbering gaps/duplicates under concurrency; frozen snapshots; the verified-revenue definition in the Lead Sources report (live, provider-confirmed, net of refunds and tax, cohort to date, per currency, test/simulated/manual excluded, disputed held out) and whether the SQL and the pure rules agree.`,
  },
  {
    key: 'public-links',
    prompt: `LENS: public pages, share links, one-time codes and sessions (anything reachable without signing in).
Read src/app/proposal/**, src/app/pay/**, src/app/api/public/{proposals,invoices}/**, src/server/proposals/{public,share,view,jobs}.ts and src/server/proposals/public-http.ts if present, src/server/invoices/{public,public-http,share,links}.ts, src/lib/invoices/{token,public-http,public-status}.ts, src/lib/proposals/share.ts, the proxy / middleware entries for these routes (grep proxy.ts for /proposal and /pay, CSP and nonce handling), src/server/security/rate-limit.ts additions, tests/proposals-public*.test.*, tests/invoices-public*.test.*.
Examine: token entropy and storage (hash only, constant-time compare), token in URL vs header, referrer and caching headers (no-store, noindex, no-referrer), enumeration (every unknown token answers identically, timing), rate limits keyed by something an attacker can rotate, one-time emailed code (length, expiry, attempts, per-link and per-address limits, replay, code reuse across links, email enumeration, code sent to an address that is not the proposal's recipient), session cookie flags and binding, CSRF on the answer/accept/decline/pay endpoints, what a link scanner's plain GET can trigger (a GET must never accept, decline, pay or even count as read), the beacon, open redirects, tenant resolution from the token only, suspended/archived/paused workspaces, content injection into the public document (stored HTML/links in proposal text rendered to the customer), PDF download authorization, information leaked on the public page (internal notes, other customers, cost, margins, staff names beyond need), and the pay page's server-computed amount (a client cannot set the amount, currency or invoice).`,
  },
  {
    key: 'webhooks-providers',
    prompt: `LENS: provider webhooks, outbound provider calls and credential handling.
Read src/app/api/webhooks/{esign,customer-payments}/**, src/server/esign/{webhook,webhook-token,http,worker,apply,connections,credentials,providers/*}.ts, src/lib/esign/{pandadoc,multipart,errors,state}.ts, src/server/customer-payments/{webhooks,connections,credentials,providers/*,switches,health}.ts, src/server/reputation/{connections,providers/*,sync}.ts, src/app/api/reputation/**, src/server/env.ts additions (the *_ENABLED switches), tests/esign-webhook*.test.ts, tests/customer-payments-webhooks.test.ts, customer-payments-route.test.ts, customer-payments-paypal.test.ts.
Examine: signature / shared-key verification (HMAC over the RAW body, timing-safe compare, timestamp window, replay, header spoofing, a missing signature header, a signature for another connection), webhook address secrecy (token in the path: hashed? rotatable? does the route resolve the tenant from the path token and nothing else?), the PayPal remote verification call (can an unauthenticated caller make iAcquire spend the business's credentials or reach another host? SSRF), outbound HTTP helpers (fixed official origins, https only, no redirects, size and time caps, no user-controlled host, request smuggling via header injection), event idempotency and ordering, error handling that leaks provider responses or keys into logs, notifications, audit rows, thrown messages shown in the UI; sealed credentials (encryption, previous-key fallback, never selected into a browser-bound object, never in server action return values or RSC props, never in a log line), the production refusals (simulated twins refused when NODE_ENV=production or the real-calls switch is off; the live-mode switch), connection health states that stay honest, OAuth for Google/Meta reviews (state single use and bound to user and org, redirect URI, scope, token storage, who may connect).`,
  },
  {
    key: 'proposals-esign-integrity',
    prompt: `LENS: proposal approval, acceptance and e-signature integrity.
Read src/lib/proposals/{state,snapshot,problems,hash,validity,ack}.ts, src/server/proposals/{proposals,versions,public,signing,crm-effects,templates,catalog,erase,jobs}.ts, src/lib/esign/state.ts, src/server/esign/{requests,apply,lifecycle,worker,maintenance,simulate}.ts, migrations 0091 and 0092 (triggers, checks), tests/proposals-lifecycle.test.ts, tests/esign-completion.test.ts, tests/esign-requests.test.ts.
Examine: approval bound to the exact frozen version and a source hash; any edit after approval invalidates; AI-origin proposals can never be sent or shown without a named human approver (service and database); the customer acceptance path (verified emailed code, acknowledgement text stored verbatim with its version, one decision per version, immutability triggers, the purge switch exception) and whether a decision can be forged or replayed from another proposal, version or link; accepted/declined/expired races (expiry job vs acceptance, two simultaneous accepts, withdraw vs accept, revise vs accept: row lock order); the signature request lifecycle (created, sent, viewed, completed, declined, expired, voided, failed) and every transition; a completion event for the wrong document, wrong connection, wrong tenant or a document that was withdrawn/revised since; completion verdict for late events; the signed copy fetch and storage (hash, size cap, bucket permission, who can download), what happens when the signing connection is disconnected; "record signing done offline" (who, evidence, audit); proposals that require a signature but are accepted on the page; totals shown to the customer equal the frozen version's totals; placeholders and template injection; CRM effects (stage move, won deal, tasks) that must not run twice or move a deal backwards; erasure and offboarding of append-only records.`,
  },
  {
    key: 'tenancy-migrations',
    prompt: `LENS: migrations 0091 to 0095, row-level security, permissions and tenant isolation.
Read supabase/migrations/{0091_proposals,0092_esign,0093_customer_invoices_payments,0094_reputation_followthrough,0095_external_reviews}.sql and their rollbacks fully, scripts/rehearse-combined-migrations.mjs (what it proves), src/server/db/index.ts MIGRATION_PREREQUISITES, src/lib/permissions.ts and src/server/crm/actor.ts additions, tests/{proposals,esign,invoices,reputation}-migration.test.ts, tests/tenant-isolation-generic.test.ts and tests/tenant-isolation.test.ts changes.
Examine: SQL correct on real Postgres 15/16 (not only PGlite): constraint expressions, composite (id, org_id) foreign keys, partial unique indexes matching ON CONFLICT clauses, check constraints that reject legitimate states or allow illegal ones, triggers (SECURITY INVOKER vs DEFINER, search_path pinned, the iaq.purge exception), indexes for hot queries; RLS enabled on every new table, select-only policies through app.permitted_orgs with the right permission, no insert/update/delete grant to the app role, column-level grants that hide token_hash / credentials / ciphertext, tables with no grant at all that the app still reads through a role it does not have; permission rows (role_permissions) consistent with the TypeScript matrix; agency staff access (can assigned agency staff read customer names, emails, invoices or reviews without a support session? is that intended and consistent with the Phase 4 social decision?); roles that should NOT get a permission (support, appointment_setter, sales_rep: invoices.settings, connections, refunds, write-offs); rollback scripts that refuse while data exists and restore prior function definitions exactly; ordering and prerequisites when 0091..0095 are applied to a database that is at 0090; anything that would fail when applied to hosted Supabase (extensions, roles, schemas, owner-only statements, statement timeouts on table rewrites, ALTER TYPE ... in a transaction).`,
  },
  {
    key: 'consent-messaging',
    prompt: `LENS: customer messages, consent, quiet hours and the unverified-identity rule.
Read src/server/invoices/{reminders,reminder-auth}.ts, src/lib/invoices/{reminder-rules,reminder-text,reminders}.ts, src/server/reputation/{batches,batch-job,batch-audience,batch-binding,jobs,feedback,program-link}.ts, src/lib/reputation/{batches,ask-criteria,incentives,settings}.ts, src/server/crm/reviews.ts, src/server/messaging/{send,consent-identity,contacts,ingest,outreach,followups}.ts diffs vs ${BASE}, src/server/webchat/switch.ts, tests/invoices-reminders.test.ts, tests/reputation-batches.test.ts, tests/webchat-switch.test.ts, tests/messaging-unverified-*.test.ts.
Examine: every path that sends a message to a customer (invoice reminder, review ask, batch ask, survey link, proposal code and notice emails, esign notices) goes through evaluateSend with the right scope and consent, honours suppressions, opt-outs, quiet hours, frequency caps, the retention pause, archived contacts, paused/suspended workspaces, WhatsApp window rules; billing messages are never marketing; the owner authorization of reminders (fingerprint of exact wording, channels, schedule; lapses when anything changes; 90 days) cannot be bypassed by a stale cache, by a race between authorize and send, or by a changed template; a reminder never goes out for a paid, void, disputed or written-off invoice (checked again at dispatch); review asks: the review-gating-safe rules R1 to R8 (criteria that cannot name sentiment or score; the same public links for everyone; no incentives; no "if you are happy" wording; unhappy private feedback cannot suppress the public ask; the 30-day cool-down), batch approval bound to a hash of template, criteria, channel and rate, pacing under the batch row lock, drift stops; the visitor-typed contact rule for website-chat contacts (messages blocked until confirmed; promotional consent evidence); the messages' content (never contains the payment link in a template-injectable way; no balances that can be stale; no threats, fees or interest).`,
  },
  {
    key: 'reputation-reviews',
    prompt: `LENS: public reviews, replies and review-site adapters.
Read src/lib/reputation/{external,reply-rules,reply-state,reply-draft,renewals}.ts, src/server/reputation/{sync,replies,reply-ai,reply-hash,public-reviews,connections,housekeeping,renewals,erasure,entitlement}.ts, src/server/reputation/providers/*, src/app/api/reputation/**, src/app/actions/reputation.ts, src/components/reputation/{reply-editor,public-reviews-panel,connections-panel}.tsx, migration 0095, tests/reputation-sync.test.ts, reputation-replies.test.ts, reputation-reply-ai.test.ts, reputation-gating-guard.test.ts, reputation-google.test.ts, reputation-meta-reviews.test.ts.
Examine: the mirror shows only what the review site returned (never invented, never edited, ratings not rounded, removed reviews handled honestly, a partial read never marks reviews removed); idempotent upsert and the lease on a sync pass; the 48-hour backfill rule; replies: version-bound approval (hash of the exact words, location and review), intent recorded BEFORE the provider request, lost answers reconcile by reading the site (never resent on a guess), double-press, a reply approved then edited, a review changed or removed meanwhile, who may draft/approve/post (permissions, agency staff, AI actor), the claim filter and word lists on AI-drafted replies (no promises of compensation, no confirming a person was a customer or patient, no private details, no arguing), AI reply drafting metered and rate limited and always a draft; Facebook replies posted by a person (their word, audited); the static guard that review-gating code never reads sentiment; reviewer personal data (name, picture, words): retention constants, erasure, export, logs; OAuth connect flows; entitlement switch and env switches default off.`,
  },
  {
    key: 'ai-cost-metering',
    prompt: `LENS: AI cost, metering and rate limits across the new AI calls.
Read src/server/llm/meter.ts, src/server/llm/* diffs vs ${BASE}, src/server/webchat/switch.ts, src/server/webchat/* AI reply path, src/server/social/ai.ts changes, src/server/proposals/ai*.ts (the AI proposal drafting service and its guards: grep for llmComplete and meterModelUse across src/ to find EVERY model call site), src/server/reputation/reply-ai.ts, src/lib/proposals/ai.ts, src/server/messaging/responder.ts (shared chargeModelUsage), src/server/billing/*, tests/llm-*.test.ts, tests/webchat-metering.test.ts, tests/proposals-ai*.test.ts, tests/reputation-reply-ai.test.ts.
Examine: is every model call that Wave 1 or its predecessors added recorded and, where a unit rate exists, charged exactly once per call (idempotency key), including calls whose result is later discarded or fails guards; a failed or timed-out call; usage fields missing; concurrent calls; per-person and per-workspace rate limits (windows, who is counted, bypass by multiple sessions or agency users, public/anonymous callers such as website chat visitors being able to run up cost: caps, kill switch, per-IP limits); prompt-injection defences on every AI feature (untrusted data fenced, brief length caps, output schema without money fields, claim/number checks that can actually be defeated, e.g. a price written in words, spaced digits, another currency symbol); outputs always stored as drafts needing a person; whether 'recordUsage kind help_request' stand-ins remain anywhere and charge the wrong thing; whether the metering incident path (metering:failed) can hide a billing gap; whether an AI call can happen for a workspace that is suspended, paused, out of credits or has the feature off.`,
  },
  {
    key: 'ui-actions-honesty',
    prompt: `LENS: screens, server actions and honest states.
Read src/app/(portal)/{proposals,invoices}/**, src/app/actions/{proposals,invoices,reputation}.ts, src/components/proposals/**, src/components/invoices/** (including public/), src/components/reputation/**, src/components/crm/attribution/sources-report.tsx, src/lib/proposals/{list,activity,editor,settings-form,share}.ts, src/lib/invoices/{labels,screens,public-status}.ts, src/components/shell sidebar/topbar diffs, tests/proposals-screens-ui.test.tsx, tests/invoices-screens.test.tsx, tests/esign-screens-ui.test.tsx, tests/reputation-external-ui.test.ts.
Examine: server components and server actions each re-check authentication, workspace and permission (a button hidden in the UI must also be refused by the action; an action must derive the org from the session, never from a form field); input validation (Zod strictObject, lengths, ids belong to the caller's workspace); results never echo secrets or tokens; every status label is honest (never "paid", "received", "signed", "accepted", "read", "delivered", "connected", "live" unless the database fact says so; simulated and test-mode data labelled; "checked when the scheduler runs" instead of implying live monitoring); empty/error/loading/disabled states; dangerous actions (void, write off, refund, record payment by hand, disconnect, approve, post reply) have confirmations and audit; optimistic-concurrency (expected version) on editors; double-submit; the sticky save bar and long forms; dark-mode tokens (text-white on tinted backgrounds), 44 px targets, 16 px inputs on phones (class names), labelled fields, role=status/alert; stored text rendered as text (no dangerouslySetInnerHTML with customer or staff text); the feature switch hides the module's menu entry, command-palette entries and AQi guidance when off; secrets (typed payment keys) kept out of component state after submit.`,
  },
  {
    key: 'lifecycle-rollout',
    prompt: `LENS: lifecycle, scheduler, offboarding, erasure, export and rollout safety.
Read src/server/ops/tick.ts and src/lib/ops.ts diffs vs ${BASE} (new jobs: proposalHousekeeping, esignSync, invoiceOverdueSweep, invoiceReminders, customerPaymentReconcile, reviewRequestBatches, reviewSync, renewalReminders, reputationRetention and any others), docs/production-scheduler.md, src/server/env.ts and .env.example additions, src/server/offboarding/{service,export}.ts diffs, src/server/proposals/erase.ts, src/server/invoices/erasure.ts, src/server/reputation/erasure.ts, src/server/messaging/contacts.ts (merge/erase), scripts/crm-qa-env.mjs, tests/aqi-ops-registration.test.ts, tests/scheduler-job-allowlist*.test.ts, tests/scheduler-intervals.test.ts, tests/*offboarding*.test.ts, tests/environment-safety.test.ts, tests/*production*.test.ts.
Examine: every new job is registered consistently (JOBS, labels, intervals, lock names, allowlist parity with SCHEDULER_JOBS_ONLY, docs), is safe to run when the scheduler starts (does any new job send customer messages, call a provider, write to a provider, or charge anyone as soon as the scheduler runs, before an owner/Super Admin opted in? what does each do for a workspace with the feature off?), has a work budget/limit per run and tenant fairness, is idempotent and lease/lock protected, survives a provider hanging; every env switch (real calls, live mode, writes, public disabled) defaults to off in code AND in .env.example AND in the QA env; production refuses simulated adapters; the offboarding shutdown ends open work (proposals, signature requests, invoices' reminders, review batches, reply posts), the export contains the client's own data and none of another tenant's and no secrets/token hashes, final deletion respects the append-only tables (iaq.purge), erasure of a contact: what is kept and what is blanked, and whether the kept records still expose the erased person's name/email in places the screens show; contact merge keeps references consistent for every new table with a contact_id; a rollback runbook that is actually possible.`,
  },
]

const COVERAGE_PROMPT = `ROLE: requirement-coverage mapper (not a bug hunter).
Map every requirement below to the code and tests that satisfy it, and judge each honestly. Read the Wave 1 code listed in the context, the tests, the audits under ${AUD}, and docs/roadmap/phases-3-to-7/*.md (the ledger; the checklist is stale for Phase 5). For each requirement return: status ('implemented' = code + at least one test, 'partial' = some part missing or untested, 'missing' = nothing, 'blocked-external' = needs a provider account, approval or counsel and the local part is done), the evidence (files/functions/tests) and, for partial/missing, exactly what is absent and whether it can be built and tested locally without external accounts.

REQUIREMENTS (from the founder's directive, Phase 5 Wave 1)
5A proposals: templates; AI-assisted drafts from business knowledge and CRM context; product/service price book; pricing and tax rules; versioning; approval workflow; PDF or web proposal; send by email/portal link; view tracking (honest levels); acceptance/decline/expiry; CRM deal linkage; Automation Studio triggers.
5B e-signature: provider seam (no invented provider capabilities); signature request lifecycle; signed-document storage; audit trail; verified completion; manual offline record; honest states; no legal claims.
5C customer invoices: create from proposal/deal/contact; line items; tax; discounts; currency; numbering; statuses; PDF/print; send; reminders (consent, wording approval); overdue; void/write-off; credit notes if scoped; tenant isolation; separate from iAcquire's own billing.
5D customer payments: client's own provider account (PayMongo, PayPal); no custody of funds by iAcquire; checkout link; webhooks verified; payment recorded only from verified facts; partial payments; refunds; disputes; manual payment record; reconciliation; test mode vs live mode; revenue attribution into lead sources (verified revenue only).
5E (if in Wave 1) payment gate/other: report what exists.
5F reputation: review requests after service (consent, no gating); private feedback surveys (CSAT/NPS) with sample-size gates; escalation of unhappy customers to a person (not a filter); review request batches with owner approval; public review mirror (Google, Facebook) read-only honest; reply drafting with human approval; reply posting where API allows; analytics.
5G retention: win-back, renewals, birthdays etc. as scoped by the audit; retention pause honoured; searchable; contact merge/erasure integrity.
Cross-cutting: AI cost metering for every model call; consent for customer messages; the unverified-identity rule; kill switches; per-workspace feature switches (nothing on by default); Super Admin surface to switch modules on (the audit calls for it); permissions for each module; export/offboarding/erasure; scheduler jobs registered but dormant; browser/accessibility readiness; documentation of founder decisions and blocked-external items.
Also judge, with evidence: which of these are wired end to end (UI -> action -> service -> DB -> CRM effects -> audit) versus only a service with no screen, and list every module that still cannot be switched on from the product (no Super Admin screen).`

const COVERAGE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string' },
          status: { type: 'string', enum: ['implemented', 'partial', 'missing', 'blocked-external'] },
          evidence: { type: 'string' },
          gap: { type: 'string', description: 'what is absent; empty when implemented' },
          buildable_locally: { type: 'boolean' },
        },
        required: ['requirement', 'status', 'evidence', 'gap', 'buildable_locally'],
      },
    },
  },
  required: ['summary', 'rows'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'partly'] },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
    reasoning: { type: 'string', description: 'the call path you traced and any guard you found or failed to find' },
    corrected_fix: { type: 'string', description: 'the right fix if confirmed or partly; otherwise empty' },
  },
  required: ['verdict', 'severity', 'reasoning', 'corrected_fix'],
}

phase('Review')

const coveragePromise = agent(COMMON + '\n' + COVERAGE_PROMPT, { label: 'coverage-map', phase: 'Review', schema: COVERAGE_SCHEMA })

const verified = await pipeline(
  LENSES,
  (lens) => agent(COMMON + '\n' + lens.prompt, { label: 'review:' + lens.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
  async (review, lens) => {
    if (!review || !review.findings || !review.findings.length) return { lens: lens.key, summary: review ? review.summary : 'agent failed', results: [] }
    const results = await parallel(review.findings.map((f, i) => async () => {
      const votesNeeded = f.severity === 'critical' || f.severity === 'high' ? 3 : 2
      const votes = await parallel(Array.from({ length: votesNeeded }, (_, v) => () =>
        agent(
          COMMON +
            `\nROLE: adversarial verifier #${v + 1}. Another reviewer (lens: ${lens.key}) claims the following defect. Your job is to REFUTE it: trace the real code from the entry point named, look for a guard (DB constraint, RLS, unique index, caller check, validation, transaction, trigger) that already prevents it, and check the claimed inputs really reach the claimed line. If you cannot find a concrete failing path, the verdict is 'refuted'. If the defect is real but its impact is smaller or larger than claimed, say 'partly' with the corrected severity. You may run one targeted test file (under the lock) or write a scratch repro under the scratchpad if it settles the question.\n\nCLAIM\nTitle: ${f.title}\nSeverity claimed: ${f.severity}\nWhere: ${f.file}:${f.line}\nFailure scenario: ${f.failure_scenario}\nSuggested fix: ${f.suggested_fix}`,
          { label: `verify:${lens.key}#${i + 1}.${v + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ),
      ))
      const ok = votes.filter(Boolean)
      const confirmedVotes = ok.filter((x) => x.verdict !== 'refuted')
      const survives = ok.length > 0 && confirmedVotes.length * 2 > ok.length
      return { finding: f, votes: ok, survives }
    }))
    return { lens: lens.key, summary: review.summary, results: results.filter(Boolean) }
  },
)

const coverage = await coveragePromise
const lensOut = verified.filter(Boolean)
const confirmed = []
const refuted = []
for (const l of lensOut) {
  for (const r of l.results) {
    const rec = { lens: l.lens, ...r.finding, votes: r.votes.map((v) => ({ verdict: v.verdict, severity: v.severity, reasoning: v.reasoning, corrected_fix: v.corrected_fix })) }
    if (r.survives) confirmed.push(rec)
    else refuted.push({ lens: l.lens, title: r.finding.title, claimed: r.finding.severity, why: r.votes.map((v) => v.reasoning).join(' || ') })
  }
}
log(`Wave 1 review: ${confirmed.length} confirmed, ${refuted.length} refuted; lenses reporting: ${lensOut.length}/${LENSES.length}`)
return { confirmed, refuted, lensSummaries: lensOut.map((l) => ({ lens: l.lens, summary: l.summary, found: l.results.length })), coverage }
