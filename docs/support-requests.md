# Support & Requests

iAcquireOS Support & Requests is the one place a client asks for help, reports a problem or shares feedback, and the one place the iAcquire team answers, prioritises and measures that work. It **extends the support system that already existed** (`support_tickets`, `support_messages`, `support_attachments`, the agency Support Inbox, the AQi escalation and the notification service). There is no second ticket table, no second chat and no second AI integration.

Branch `feat/support-requests`, migration `0065_support_requests.sql` (rollback: `supabase/rollbacks/0065_support_requests.down.sql`). **Nothing here is deployed, pushed to `master`, applied to a hosted database or emailed to a real person.** See [Verification](#18-verification) for exactly what was run and what was not.

## 1. What was reused and what is new

| Reused as it was | Extended |
| --- | --- |
| `support_tickets`, `support_messages` (public replies and `internal` notes), `support_attachments`, `private_files` and the private `support-attachments` bucket | Tickets gained a type, the `new` status, client-stated urgency, feedback stage, diagnostics, idempotency key and lifecycle timestamps. Messages gained a retry-safe client message id. Attachments can be staged, bound to a message and cleaned up. |
| Agency permission model (`role_permissions`, per-person overrides, client scope via `staff_assignments`) | Seven new `agency.support.*` permissions and one client permission, `support.view_all`. |
| `notifications`, `notification_preferences`, `email_outbox`, `sendEmail`, the scheduler (`/api/internal/tick`) | Per-event delivery rules, an idempotent delivery log, retries, and four new notification kinds. |
| AQi support escalation (`/api/aqi/support`) | A reviewed, consent-gated "Prepare support request" flow. |
| The one AI provider connection (`src/server/llm/client.ts`), help articles, usage limits | Optional, advisory request help. |
| Agency Team, audit log, rate limits, Custom Projects (`/projects`) | Used unchanged. |

## 2. What the client sees

Sidebar group **Requests** (expandable, keyboard accessible, collapsible to icons, shows an attention count):

| Item | Route | Notes |
| --- | --- | --- |
| Custom Projects | `/projects` | The existing My Projects area, unchanged (quotes, milestones, messages). The catalogue stays under "Grow with iAcquire". |
| Report an Issue | `/support/report-issue` | |
| Get Support | `/support` | The old Support list page became this form; the list moved to My Requests. |
| Provide Feedback | `/support/feedback` | |
| My Requests | `/support/requests`, `/support/<id>` | |

* **Get Support / Report an Issue / Provide Feedback** share one form engine. The person's workspace, name and permissions come from the session: nothing about identity is typed. Validation runs in the browser and again on the server. The Send button is single-flight and the submission carries an idempotency key, so a double click, a retry or a dropped connection cannot create two requests. Drafts are kept in this browser only (`localStorage`, wrapped in try/catch) and offered back after a reload.
* **Issue reports** add *What happened / What did you expect / Steps to reproduce*, how much it affects the person, and **Include technical details**: off by default, with the exact list shown before sending. Only an allow-listed set is ever stored (`src/lib/support/content.ts#sanitizeDiagnostics`): page path (no query string), browser and device names, app version, a pasted error reference, time, time zone, screen size and language. Passwords, keys, tokens, cookies, headers, request bodies, records and conversations have nowhere to be stored.
* **Feedback** keeps the shared lifecycle under its own wording: *Received → Under review → Planned → Completed / Not planned*. "Planned" explicitly says it is not a delivery date, and the page never promises a suggestion will be built.
* **Similar requests**: while typing a title the person sees their own earlier, still-relevant requests that read alike (their own view only; never another person's or another client's).
* **Topic suggestion and help pages** come from the person's own words with deterministic rules (no AI call). An optional **"Help me say this more clearly"** button asks the connected AI to tidy the draft; the person accepts or ignores it.
* **My Requests**: filters All / Open / In progress / Waiting / Resolved / Closed with counts, search over titles, references and *public* messages, type filter, sort, pagination (10 per page), a "New reply" marker, and an owner/manager scope switch. The address holds the filters, so a view can be bookmarked.
* **Request page**: where the request stands in plain words, the conversation (public replies only), a reply box with attachments, "Sent / Seen by iAcquire" per message, failed messages that stay on screen with **Try again** (same message id, so retry cannot duplicate), a reopen button for resolved requests inside the reopen window, the shared technical details, and an *Activity* list of client-visible events. The page refreshes itself every 20 seconds while visible and falls back to what it already has if that fails.

### Who can see which request

Inside a workspace, **Business Owners and Managers (`support.view_all`) see every request; Team members, Sales Representatives, Customer Support and Appointment Setters see only the requests they opened.** Viewers cannot use Support. This is enforced by RESTRICTIVE row-level-security policies on `support_tickets`, `support_messages`, `support_attachments` and `support_ticket_events` (and again in the service queries), so it holds even for a query written outside the normal screens. The 0060 policies that other tests pin are unchanged; the new rule is layered on top.

## 3. What the iAcquire team sees: Requests Management Center (`/admin/support`)

Sidebar label **Requests** (was "Support inbox"; the route and breadcrumbs are preserved).

* **Queue** (left): saved views with live counts (Active, Unassigned, Mine, Client replied, Overdue, Escalated, Waiting on client, Resolved, Closed, All), search (including internal notes, for the team only), filters (type, priority, topic, assignee, client), sort, pagination. `j`/`k` move through the list, `/` focuses search.
* **Conversation** (centre): public replies and internal notes in one ordered thread. A **Reply to client** and an **Internal note** composer are visibly different (the note is outlined, labelled "Only your team will see this. The client is not notified." and never notifies anyone). Optional status after sending, attachments (internal files for notes), `r` to reply, Ctrl/⌘+Enter to send. Failed sends stay on screen and retry safely.
* **Details** (right): status (or feedback stage), priority, assignee (with each person's real count of open requests), response-target state, client details, escalation, technical details the client shared, related requests and possible duplicates, AI summary and advice, history.
* Desktop: three panes. Tablet: queue + conversation, details below. Phone: queue and request are separate screens with a back link.
* `/admin/support/<id>` remains a deep link (notifications use it).
* **Analytics** (`/admin/support/analytics`) and **Settings** (`/admin/support/settings`) are tabs shown only to roles that hold the permission.

## 4. Statuses and lifecycle

One lifecycle for every type: `new → open → in_progress ⇄ waiting_for_client → resolved → closed`.

| From | May move to |
| --- | --- |
| new | open, in_progress, waiting_for_client, resolved, closed |
| open | in_progress, waiting_for_client, resolved, closed |
| in_progress | open, waiting_for_client, resolved, closed |
| waiting_for_client | open, in_progress, resolved, closed |
| resolved | open (reopen), closed |
| closed | open (team only) |

Nothing returns to `new`. The table lives once in `src/lib/support/lifecycle.ts`, is enforced by the service (`applyStatusChange`) **and** by a database trigger (`app.support_ticket_guard`); `tests/support-lifecycle.test.ts` walks all 36 pairs against the database to keep them identical. The same trigger makes a request's workspace, reference and type immutable.

* `new` is "received, not yet picked up". The team's first touch (a reply, note or assignment) moves it to `open` without announcing it.
* A public reply defaults to *waiting on client* (the earlier behaviour) unless the person chooses another status; replies to feedback never change feedback status.
* A client reply on *waiting on client* returns it to `open`; a client reply or the Reopen button on a *resolved* request inside the reopen window (default 14 days, configurable, 0 = never) reopens it and tells the team. Closed requests cannot be reopened by clients.
* Timestamps: `created_at`, `first_responded_at` (first public team reply; notes and acknowledgements don't count), `resolved_at`, `closed_at`, `last_reopened_at`, `reopened_count`, plus a complete event history (`support_ticket_events`) and audit entries (`audit_logs`, action prefix `support.`).
* Feedback stage ↔ status: received=new, under_review=open, planned=in_progress, completed=resolved, not_planned=closed. Issues use the shared lifecycle.

## 5. Permissions

Client roles: `support.use` (Owner, Manager, Team member, Sales Rep, Customer Support, Appointment Setter) opens, follows and replies to *their own* requests; `support.view_all` (Owner, Manager) sees the whole workspace.

Agency (all enforced server-side on every call, re-read from the database; the UI only hides what a role cannot do):

| Permission | Default roles | Allows |
| --- | --- | --- |
| `agency.support.view` | Staff, Manager, Super Admin | Read requests for clients in scope |
| `agency.support.queue` | Staff, Manager, Super Admin | See the whole queue for those clients (without it: only requests assigned to the person) |
| `agency.support.manage` | Staff, Manager, Super Admin | The base for every write: public replies, status changes, taking a request for yourself, escalating, attachments |
| `agency.support.notes` | Staff, Manager, Super Admin | Internal notes (also needs `manage`) |
| `agency.support.resolve` | Staff, Manager, Super Admin | Resolve, close, reopen, feedback completed/not planned (also needs `manage`) |
| `agency.support.assign` | Manager, Super Admin | Assign to others, unassign, merge requests |
| `agency.support.priority` | Manager, Super Admin | Change priority, clear an escalation |
| `agency.support.analytics` | Manager, Super Admin | Analytics |
| `agency.support.settings` | Super Admin only (not delegable) | Hours, targets, notification rules, limits |

All except `settings` can be allowed or denied per person from Agency Team. Client scope (all clients, or assigned clients) still applies. A request outside a person's scope reads as "not found".

**Assignment**: assignee must be an active agency user inside the client's scope who holds `view` and `manage`. The assignment list shows each person's real number of open requests, never a score. Self-assign needs only `manage`; assigning others needs `assign`. Every change is a timeline event and an audit entry; the client is told only that "a team member picked this up", never a name (team members appear to clients by first name only on their own messages).

**Priority** is the team's assessment. Clients never set it: their own description of impact (*Not urgent / Needs attention soon / Blocking my work*) is stored separately as `client_urgency` and shown to the team. Older callers that sent a priority are mapped to that field.

## 6. Notifications

The Super Admin chooses, per event, **In-app only / Email only / In-app and email / Off** (Settings → Notifications). Events: request submitted, assigned, new agency reply, new client reply, status changed, priority escalated, response approaching, response overdue, resolved, reopened, closed.

* Recipients are computed from the request, never from the browser: the client side of that request (the opener and people who replied, while active members with `support.use`), the assignee, the people watching that client's queue, or the people who manage priorities. No other client's people, no out-of-scope staff, no viewers. The person who caused the event is not notified of it.
* **Internal notes never notify anyone.** Team-bound notices and email carry the reference, workspace and subject, never what the client wrote; client-bound email carries the reply snippet.
* **Idempotent**: each (event key, person, channel) is claimed in `support_notification_log` before anything is sent; handling the same event twice notifies once.
* **Delivery status** per recipient and channel: in-app `delivered`; email `queued → sent` (accepted by the provider; this is not a delivery receipt) or `failed` (with a safe reason), `captured` (development mailbox), or `skipped` with the reason (rule off, recipient turned email off, inactive). Failed email is retried up to 3 times, 10 minutes apart, by the scheduler job `supportEmails`; stale claims are re-queued after 5 minutes.
* Clients' own "email off" setting is honoured. Quiet hours are not applied to support email (the Super Admin chose email explicitly).
* The in-app notification kinds are `support_ticket_created`, `support_reply` (existing) and `support_assigned`, `support_status`, `support_escalated`, `support_sla` (new).
* In `EMAIL_PROVIDER=capture` (local, test, QA) nothing is sent; Settings says so on screen. No real customer email was sent during this work.

## 7. Response expectations (SLA)

Configured in Settings; **off by default**.

* Turn on *Track response targets*, set the time zone, weekly opening hours (up to three windows a day), holidays, whether the clock counts opening hours only, and a first-reply and later-reply target per priority (empty = no target). *Warn at* a percentage of the target; optionally *escalate when overdue by N minutes* (flags the request for managers; it never changes priority).
* Clients are shown "We aim to reply within …" **only if targets are on, *Show expected response times to clients* is on and a target exists for that request's priority**. Wording is generated from the configured minutes (`describeTarget`). No countdown is ever displayed to clients; the team sees an absolute due time and a state.
* The clock (`support_ticket_ops.response_due_at`) runs only while the request waits on the team, starts at creation or at the client's latest message, is not pushed out by a second client message, stops at the team's first public reply (an internal note or an automatic acknowledgement never stops it), pauses while waiting on the client and stops when finished. A priority change re-times a running clock.
* Business-hours arithmetic (`src/lib/support/sla.ts`) handles weekends, holidays, split windows, time zones and daylight-saving changes; it is covered by pure tests.
* States: *Within target, Target approaching, Overdue, Waiting on client, Finished, No response target*. The scheduler job `supportResponseTargets` raises "approaching" and "overdue" notices once per request and due time.

## 8. Attachments

Private bucket `support-attachments`; downloads are short-lived links issued only after row-level checks, and are served as attachments (never rendered) with `nosniff` and a sandboxing CSP.

* Types: PNG, JPEG, WebP, PDF, Word `.docx`, CSV, plain text. Not accepted: executables, scripts, HTML, SVG, archives, macro-enabled Office files. Each file's **extension, declared type and real contents** (magic bytes / no NUL bytes in text) must agree.
* Limits (Settings): largest file 1–10 MB (default 10), 1–10 files per message (default 5). Private-file records cap at 10 MB.
* Flow: a chosen file is uploaded and **staged** (owned by its uploader, invisible to everyone else including the team) with progress, cancel, retry and preview; it is attached when the request or message is sent. Unsent files are removed after a configurable hold (default 24 hours) by the `supportAttachmentCleanup` job. Files can also be removed by their owner before sending.
* Internal attachments (team notes) are `visibility='internal'` and invisible to clients in the UI, API and storage checks. The generic `/api/files/<id>` route now also requires visibility of the support attachment row.
* Retention: optionally delete the files of requests closed longer than N days (off by default).
* AQi conversation files are **never** copied into a request.
* **Limitation: no malware-scanning service exists in this deployment** (there is none to integrate). Mitigations: restricted non-executable types, content checks, private storage, download-only delivery. Document this to clients in your acceptable-use text.

## 9. AQi integration

When AQi cannot resolve something it offers **Prepare support request**. That opens a dialog showing AQi's draft from the person's own words (subject, description, kind and topic, all editable). Sharing the AQi conversation is **off by default**; if chosen, the exact excerpt that would be shared (last messages, credentials removed) and the page are shown and an explicit consent box must be ticked. Files are optional and fresh (never AQi attachments). **Send to iAcquire support** is the only action that creates a request; the reference appears only after the server confirms it. If sending fails, no request exists and the dialog says so; sending again reuses the same idempotency key so it cannot duplicate. The excerpt is rebuilt on the server from the stored conversation (a browser cannot supply one). Before anything is drafted or shared, credentials are removed (`redactSecrets`): URLs with embedded passwords, API-key-shaped and JWT-shaped values, long token-like strings, and the value in a plain statement such as "my password is …" or "api key: …". Escape closes the dialog unless a send is in flight. The earlier endpoint body still works and still requires consent. Routes: `POST /api/aqi/support/draft` (prepares, creates nothing) and `POST /api/aqi/support`.

**Super Admin.** The customer-facing *Prepare support request* flow is for clients. A Super Admin has no one to ask for help, so both routes (`requireClient` in `src/server/aqi/support.ts`) now refuse a Super Admin with a message pointing to AQi Operations. There, the same Support & Requests service backs four operator actions instead: **Create internal issue**, **Record platform bug**, **Propose engineering task** (each a request in the agency workspace, created only after the preview is confirmed and verified by reading it back) and **Review support queue** (read-only; permissions, SLA and escalation advice come from this module unchanged). See [aqi-operations.md](aqi-operations.md).

## 10. AI help (advisory only)

Uses the connected provider (`resolveLlmConfig`), the support settings switch, a per-person hourly limit, short outputs with a timeout and, for client-side help, the workspace's monthly help-request allowance. Everything is wrapped as data, emails/phones/long numbers/keys are removed first, and **nothing is sent, closed, assigned, prioritised or promised by AI**.

* Clients: tidy a draft (and list up to three questions), topic suggestion and help pages (no AI call).
* Team: conversation summary (includes internal notes, saved for the team only), **suggested reply** (built from the public conversation only so private notes cannot leak into client-facing text, with warnings for refunds, guarantees, timeframes, credentials and claims of work done), missing-information questions (rules), priority/escalation advice (rules), possible duplicates.
* With no provider connected, the UI says "AI help isn't set up yet" and the rule-based help still works. Provider token budgets (the AQi budget machinery) are **not** applied to support AI; limits are the per-person rate limit, output caps and the workspace help-request allowance.

## 11. Duplicate handling

Server-side idempotency keys on request creation and on messages (`client_message_id`) make double clicks, retries, network interruption and AQi resubmits harmless. Similar-request suggestions are shown to the person (their own view) and to the team (same client only). The team can **link** requests (related/duplicate) or **merge** (needs `assign` + `resolve`): the merged request is closed with a thread line, both histories are kept, nothing is deleted or moved, and links across clients are impossible (composite foreign keys). Nothing is merged automatically.

## 12. Analytics definitions (`/admin/support/analytics`)

All numbers come from real rows, limited to the clients the person can reach (and to their assigned requests without `queue`). Empty periods report "No data".

* **Requests created / by topic / priority / type / status**: requests created in the date range (status is where they stand today).
* **Resolved**: distinct requests with a `resolved` event in the range. **Reopened**: `reopened` events in the range. **Reopen rate**: requests created in the range that were reopened at least once ÷ requests created.
* **Open now / Unassigned / Assigned / Escalated / Overdue**: current counts for the chosen filters, not tied to the dates.
* **First response time**: created → first public team reply (elapsed time), for requests created in the range that have one. **Resolution time**: created → first `resolved` event; requests resolved before event history existed are excluded.
* **Workload**: active requests assigned to each person now, and requests assigned to them that were resolved in the range. Counts, never scores.
* **Feedback**: by stage and kind, plus a six-month trend. **Most reported issues**: issue reports grouped by problem type and feature. **Clients sending the most requests**.
* Filters: dates (≤ 1 year; weeks when > 90 days), client, assignee, type, topic, priority, status. Each row links into the queue with the matching filter.

## 13. Database (migration 0065)

Additive. It re-creates only check constraints (status, category, notification kinds, override permissions) with supersets. New: columns on the three support tables; tables `support_ticket_events`, `support_ticket_ops` (agency-only: escalation, response clock, AI summary), `support_ticket_links`, `support_settings`, `support_notification_rules`, `support_notification_log`; restrictive policies; the transition trigger; permission rows; backfill of request type (`bug` → issue), first-response and resolved timestamps, and a `created` event per existing request. All new tables are `org_id`-scoped with RLS, no grants to `anon`/`authenticated`, and policies written with the statement-level helpers from 0060. Indexes cover queue, ownership, assignee, type, idempotency, SLA due and escalation lookups.

Rollback (`supabase/rollbacks/0065_support_requests.down.sql`): documented at the top of the file; `tests/support-migration-0065.test.ts` runs it, checks what survives and re-applies the migration. It discards the timeline, response clocks, links, settings and delivery log, converts `new` → `open` and new categories → `general`, and removes unsent files from the list.

Hosted migration numbering: this branch was cut when 0063 was the newest migration and first used 0064. While it was being built, `master` took 0064 (`0064_aqi_feature_tours`, recorded there as applied to the hosted project), so the migration was renumbered to **0065** and no number is shared. Re-check `ls supabase/migrations` on `master` immediately before merging: if anything newer than 0064 has landed, renumber again (the number appears in the migration file name, the rollback file name, `tests/support-migration-0065.test.ts`, `tests/crm-migrations.test.ts` and this document). **No hosted migration was applied by this work.**

## 14. Security checks that exist as tests

Cross-tenant reads (rows, messages, events, attachments, API thread route, forged ids and uuids); a member reading a colleague's request; viewers; internal notes in UI/API/search/notification/export; agency scope and per-permission denials; forged agency identity; assignment to ineligible people; unauthorised priority/resolve/settings changes; staged-file ownership, expiry, workspace and visibility; file type/size/content; download authorization; notification recipient isolation and idempotency; email content rules; stored-text safety (text is always rendered as text; email rendering escapes); rate limits; AQi consent and failure behaviour; analytics scope; AI redaction and "advisory only". See the test list in [Verification](#18-verification).

## 15. Local test instructions

```bash
npx vitest run tests/support-*.test.ts tests/aqi-support.test.ts   # backend and security (PGlite, real migrations)
npx vitest run                                                       # full regression
npm run typecheck && npm run lint && npm run build
node scripts/run-support-qa-seed.mjs          # QA server stopped; fictional data into .data/crm-qa
CRM_QA_PORT=3262 node scripts/crm-qa.mjs      # isolated server (embedded DB, email captured, no providers)
CRM_QA_PORT=3262 node scripts/support-browser-qa.mjs   # Playwright sweep: roles x viewports, axe, screenshots in .data/crm-qa/support
```

## 16. Staging-first deployment plan

1. Review the diff; merge `feat/support-requests` into a staging branch only after the sidebar conflict with in-flight work is resolved (this branch changes `src/components/shell/sidebar.tsx`).
2. Apply `0065` to the **staging** Supabase project only (`npm run db:migrate -- --only 0065_support_requests` with staging credentials, never production).
3. Staging acceptance, using a staging email provider with test recipients only:
   * Each persona (Owner, Manager, Team member, Viewer, a second client's Owner, agency Super Admin, Manager, Staff in and out of scope) can do and cannot do what section 2–5 say.
   * Run Flows A–F end to end; confirm in the provider's dashboard that mail for *agency reply* and *resolved* arrives at test addresses and that the log shows `sent`, and that a deliberately bad address shows `failed` then retries.
   * Configure hours/targets; confirm approaching/overdue notices and that clients see wording only when enabled.
   * Upload one of each allowed type; confirm a renamed `.exe` and a mismatched PNG are refused; confirm downloads need sign-in.
   * With the AI provider connected: tidy draft, summary, suggested reply (check warnings), and that turning AI off in Settings removes the buttons.
   * Scheduler: confirm `supportResponseTargets`, `supportEmails`, `supportAutoClose`, `supportAttachmentCleanup` appear on System health after an authenticated tick.
   * Realtime fallback: leave a request open in two browsers and confirm the 15–20 s refresh.
4. Only after staging acceptance and written approval: production migration and release. Production deployment from `master` is automatic (Vercel), so do not merge to `master` before that approval.

## 17. Known limitations

* No virus scanning (see section 8).
* Real email delivery, the AI provider, the scheduler on a real host and Supabase RLS on the hosted project were **not** exercised; local runs use embedded PostgreSQL, captured email, a mocked AI client and the QA scheduler.
* Updates use polling (20 s client, 15 s team), not Supabase Realtime. A hidden tab pauses and catches up on return.
* "Seen by iAcquire" and the team's "Client replied" marker use one shared read time per request, not per team member.
* Business-hours maths covers weekly windows and dated holidays; it does not know public-holiday calendars by country.
* Priority/SLA targets apply the request's *current* priority; a client is never told a specific due time.
* Merging does not move messages between requests; the closed request keeps its own history and points to the other.
* Specialised statuses for issue reports were not added; they use the shared lifecycle.
* Screen-reader testing and production build timing were not performed; axe-core ran in Chromium.
* AQi's own tutorials still refer to the Support page by its old purpose in places (they remain valid: the form, list and navigation targets kept their ids).
* Two findings from browser QA sit in code this work did not change and were **not fixed**: with AQi's own panel open, the page has two `<header>` banner landmarks (axe `landmark-no-duplicate-banner`), and the existing `/notifications` list can fail hydration by one minute ("22 vs 21 minutes ago") when a render straddles a minute boundary. The support screens' own relative times are marked `suppressHydrationWarning`.
* Plain-language secret removal is pattern-based ("password is …", "api key: …", key-shaped strings). A password written some other way ("it's Tr0ub4dor") cannot be recognised; that is why sharing the conversation is off until the person has read the excerpt and ticked consent.
* The agency read marker ("Client replied", "Seen by iAcquire") is one shared time per request, not one per team member. The Slack alert for escalations carries the reference only. There is no email-reply ingestion (replying to a notification email does not post to the request).
* Dev-server note for whoever repeats the browser run: `next dev` occasionally answers its first request after a quiet spell with a 500 ("Manifest file is empty"), and restarts itself when memory grows after hours of compiling. Both produced false failures during this work and are handled by the harness (login retry; rerun the affected checks).

## 18. Verification

Evidence is kept in four tiers and never merged: **implemented** (code exists), **automated** (a test ran and passed on the real migrations in an embedded PostgreSQL), **browser** (driven in Chromium against the isolated local server with fictional accounts), **staging / production** (not done; see section 16). All of it ran on 2026-10-20 on branch `feat/support-requests`; no hosted database, email provider, AI provider or customer was involved.

| Gate | Result |
| --- | --- |
| Full test suite | **3,163 passed / 3,166 (194 files).** The 3 failures (`crm-calendars` ×2, `crm-booking-pages` ×1) are not from this work: they fail the same way on `6e18e1b`, the commit this branch started from, and `master` has a later fix (`f59edc7`, calendar fixtures). Support-specific suites: about 128 cases in 12 files (`tests/support-*.test.ts`, `tests/aqi-support.test.ts`) |
| `npm run typecheck`, `npm run lint` | both pass (0 errors, 0 warnings) |
| `next build --webpack` | passes; all support routes and API routes are emitted (`/support`, `/support/requests`, `/support/[id]`, `/support/report-issue`, `/support/feedback`, `/admin/support`, `/admin/support/[id]`, `/admin/support/analytics`, `/admin/support/settings`, `/api/support/*`, `/api/aqi/support`, `/api/aqi/support/draft`) |
| Migration and rollback | `tests/support-migration-0065.test.ts` runs the rollback, checks the earlier schema holds, and re-applies the migration. `tests/crm-migrations.test.ts` now lists 0065 so the CRM rollbacks run newest-first |
| Browser QA | `scripts/support-browser-qa.mjs`, 34 checks, every one passing in its latest execution (the last full sweep was interrupted by the dev server restarting itself; its last 7 checks and the one that exposed a stale read were rerun after the fix). 0 requests left the loopback origin; no 5xx from the application's own routes (the development server's transient 500 on `/login` while it rewrites its manifests did occur, and the harness retries past it) |
| Screens | 390, 768, 1024 and 1440 px for the member, plus 390/768/1024/1440 for the agency Super Admin. No horizontal overflow; axe-core (all impacts) reported nothing at 390 and 1440 on the member pages, the agency queue/thread/analytics/settings, and the AQi dialog (scanned on its own, see section 17) |

Per area (PASS = verified at the tiers stated; PARTIAL = something named is not verified):

| Area | Status | Evidence and what is not covered |
| --- | --- | --- |
| Requests sidebar group, active state, keyboard collapse, role visibility | PASS | Browser (member, viewer) and unit tests of the shell query. |
| Get Support / Report an Issue / Provide Feedback | PASS | Browser: submit with a file, validation messages, draft restore after reload, double-click makes one request, technical-details preview and toggle, feedback starts as Received. Automated: idempotency, ownership, categories, diagnostics allow-list. |
| My Requests and request page | PARTIAL | Browser: list, filters, search, pagination, reply with delivery state, team reply visible and internal note never visible, notification received. **Not driven in a browser:** reopening a resolved request, upload cancel/retry, the 20-second refresh. Those are automated only (reopen window, retry key). |
| Public replies vs internal notes | PASS | Automated across UI, API, search, notifications, export, AQi and analytics paths; browser confirms the member never sees the note while the agency does. |
| Attachments | PARTIAL | Automated: type/size/content checks, staging, ownership, expiry, authorised download. Browser: a file sent with a request. **No malware scanner exists**; progress/cancel/retry UI is not exercised in a browser. |
| Requests Management Center | PASS | Browser as Super Admin, staff and out-of-scope staff: views and counts, open a request, reply and note, change status, priority and assignee, analytics, settings, denial for staff/out-of-scope/clients. Keyboard shortcuts (`j`, `k`, `/`, `r`) are not driven. |
| Lifecycle and permissions | PASS | Automated: all 36 status pairs against the database trigger and the service; every agency permission allowed and denied; per-person overrides; scope. |
| Tenant and role isolation | PASS | Automated (row-level security, service and API) and browser (other client, colleague, viewer, out-of-scope staff, signed-out visitor, client opening agency URLs). |
| Response targets (SLA) | PASS (local) | Automated: pure business-hours arithmetic, clock rules, scheduler job. Browser: wording shown to the client only when configured. Not exercised: the scheduler on a real host. |
| Notifications | PARTIAL | Automated: per-event modes, recipients, idempotency, retry, status values. Browser: an in-app notice arrives. **Real email delivery is unverified** (capture mode only). |
| AI assistance | PARTIAL | Automated with a mocked provider: advisory only, redaction, no auto-send, off when not configured. **A real provider was never called.** |
| AQi "Prepare support request" | PASS | Automated (9 tests) and browser: opens from a saved conversation, a made-up API key and password never reach the draft or the excerpt, sharing is off by default, send waits for explicit consent, Escape closes without sending, send creates a real reference, fits at 390 px. |
| Duplicate handling | PARTIAL | Automated: idempotency, similar-request ranking, link and merge with audit. The similar-request hint in the form is not asserted in a browser. |
| Analytics and settings | PASS | Browser: real numbers, definitions, save and reload, notification rule change. A stale cached read of the settings (found by the browser run) was fixed and has a test. |
| Staging and production | NOT DONE | No staging deployment, hosted migration, push or release was made or authorised. |

Defects found and fixed during browser QA: the unsent-draft autosave wiped the saved draft before it was restored; a server component handed a formatter function to a client chart (analytics page error); "Updated … ago" text mismatched on hydration in four places; the AQi dialog had no Escape handling and a low-contrast chip; heading order in the request list; an unlabeled file input; plain-language passwords were not removed from AQi drafts; the Settings page could show an old value for a few seconds after saving; and the migration number collided with `0064_aqi_feature_tours` on `master`.
