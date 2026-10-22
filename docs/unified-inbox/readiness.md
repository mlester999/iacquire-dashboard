# Unified Inbox: readiness report

Branch `feat/unified-inbox` (worktree `.data/wt-unified-inbox`, based on master `22c68c2`). Written at the end of Phase 1; see
[README.md](./README.md) for how it works and [audit.md](./audit.md) for the Phase 0 findings this closes.

> **Nothing here has been pushed, deployed or run against production. Migration 0082 has not been applied to any hosted database. No real customer
> message was sent and no live provider or model was called at any point.** Everything below is verified in an embedded Postgres (PGlite) with
> simulated providers and a simulated AI model, in an isolated local QA workspace, unless a row says otherwise.

## 1. Verdict

**Not ready for production release. Ready for a staged rollout that starts with approvals.**

The inbox, its AI controls, the new workflow triggers and step, and the migration are complete and tested to the extent a simulated environment
allows: the whole suite is green apart from failures that already exist on master (section 4), type-check and lint are clean, and every one of the
18 acceptance scenarios passes against the real server code (seventeen in tests; scenario 17, mobile, in a browser). What stops a release is what no test here can prove:

1. **No live provider has been exercised.** GoHighLevel, Twilio, Meta WhatsApp and Resend sending and delivery callbacks are verified against recording
   stand-ins only (as they were before this work). Needs credentials and the owner's approval.
2. **Migration 0082 has not been rehearsed on a production-sized copy,** and its number must be reconciled with master's pending `0081`.
3. **The production scheduler was reported OFF** (Automation Studio state, 2026-10-22). The waiting notices and "went quiet" workflows run from the
   `inboxAttention` job, so they do nothing until the scheduler runs.
4. **It must be merged with master's uncommitted AI-workforce work** (same job-list tests, same `src/server/messaging/*` neighbourhood) and re-tested.

Recommended order: merge and re-run the suite → apply 0082 to a staging copy with provider writes off → verify with provider sandbox accounts → enable the scheduler → production, each step on your approval.

## 2. Estimates

| | Estimate | Basis |
| --- | --- | --- |
| Feature completion against the directive | **about 90%** | Everything in phases 1A to 1F is built except what the audit marked out of scope: Website AI chat and social channels, attachments, per-user read state, websocket push, SLA timers and assignment rules for conversations. |
| Production readiness | **about 65%** | Code, tests, security review and browser QA are done. Live provider verification, production-copy migration rehearsal, scheduler enablement, load measurement on hosted Postgres and the merge with master are not. |

These are judgments, not measurements. The first is the share of the directive's feature list that exists and works; the second counts the
gates in section 9 that are closed.

## 3. Implementation checklist

| Phase | Item | Status |
| --- | --- | --- |
| 0 | Repository audit, risks, decisions | Done ([audit.md](./audit.md)) |
| 1A | Additive migration 0082 with rollback; lifecycle columns; `conversation_events`; revision and status stamps | Done; rehearsed down/up on populated data in tests |
| 1A | Ownership fence and AI pause enforced at queue and at dispatch; stale AI replies refused | Done |
| 1B | Views (10), sorts (3), keyset paging, search, bulk actions (no bulk send), select mode | Done |
| 1B | Thread: lifecycle events inline, resolve with outcome, archive, mark unread, retry with confirmation | Done |
| 1B | Responsive layout (phone, tablet, desktop), keyboard shortcuts, dark theme | Done; axe clean (section 6) |
| 1C | Assign person, choose AI employee (reply-capable roles only), pause, resume, take over, hand to teammate, handoff with notice | Done |
| 1C | AI summary and suggested reply: text only, never saved, never sent, rate and usage limited | Done |
| 1D | CRM context panel (deals, tasks, appointments, notes, calls, duplicates); create task, deal, note; lead status | Done |
| 1D | Honest channel health; web chat and phone shown as not available | Done |
| 1E | Triggers: assigned, resolved, urgent, handoff requested, went quiet; channel filters | Done |
| 1E | Workflow step "Update conversation" (resolve, reopen, priority, assign, assign to owner, pause AI); loop limit; publisher permissions | Done |
| 1E | Notifications: assigned, new unassigned inquiry, customer waiting (capped, de-duplicated); scheduler job | Done; scheduler must be enabled (section 1) |
| 1E | Core inbox without an Automation Studio plan | Done and tested |
| 1F | Tenant isolation and role tests, route tests, migration tests, acceptance walk | Done |
| 1F | Browser QA, accessibility, mobile | Done in the isolated QA workspace (section 6) |
| 1F | Production build | Passes: `npm run build:clean -- --webpack` (isolated output folder, every provider and hosted setting pinned off); type-check inside the build; the six `/api/inbox/*` routes and `/inbox` compile. The default Turbopack build could not resolve `next` from this worktree only because its `node_modules` is a junction to the main checkout; that is the worktree, not the code. |
| 1F | Performance at scale | Measured at 20% of the repo's perf dataset (about 600 conversations and 4,000 messages, `tests/perf`, embedded Postgres, 3 runs): every new read takes 9 to 25 ms (first page of a view 9 to 14, second page by cursor 23, counts for every tab 9, the change poll with counts 17); body search 80 ms, the same as the existing search (84 ms). In those plans the database read each candidate conversation's messages through the per-conversation index instead of using the trigram index `conversation_messages_body_trgm`; whether hosted Postgres ever picks the trigram index for this query shape is **unverified** (check `EXPLAIN` on staging; if it is never used, drop it from the migration, because it costs time on every message insert). **Indicative only**: in-process, no network, small data. Full scale and hosted Postgres were not measured. |

## 4. Test evidence

* `npx tsc --noEmit -p tsconfig.clean.json`: clean. `eslint` on every directory this branch touched: clean.
* Whole suite, run alone on a quiet machine, on the committed branch: **290 files, 4,621 tests passed, 7 failed, 1 skipped** (430 s). The 7 failures
  are exactly the set that already fails on master (next point). `unified-inbox-ui` (4 tests) was added after that run and was run on its own: it passes.
* `npm run typecheck:scripts` (the scripts project): clean.
* **Failures that are not from this branch.** Six files, seven tests, fail identically on master `22c68c2` (checked in a separate worktree at that commit):
  `appointments` (reminder dispatch), `aqi-answer-pipeline` (a `/website` navigation entry), `aqi-ops-registration` and `scheduler-intervals`
  (the AI workforce jobs master's working tree is adding), `crm-migrations` (two rollback tests blocked by the `ai_work_*` policies that depend on
  `app.permitted_orgs`), `rls-initplan-guard` (the same `ai_work_*` policies). The two job-list tests were updated for `inboxAttention`; the AI workforce
  jobs still make them fail until master's own edits to those tests are merged.
* New test files and their sizes: `unified-inbox-control` (33), `-list` (18), `-ai` (11), `-automation` (14), `-workflow-step` (14), `-migration` (9), `-routes` (8),
  `-sync-logic` (8), `-ui` (4), `-acceptance` (15): 134 tests. Existing suites were extended where the behaviour they cover changed (scheduler lists, fixtures, the perf harness).
* Two of those tests earned their keep during this phase: the migration rehearsal found the notification-constraint parsing bug, and the planner check behind
  `crm-performance` led to the partial sync index.

## 5. Acceptance scenarios

"Simulated" means a recording stand-in provider or a stub model; no scenario was verified live.

| # | Scenario | Evidence | How |
| --- | --- | --- | --- |
| 1 | A connected channel receives an inbound message | `unified-inbox-acceptance` 1-2 (ingest, duplicate delivery is one message) | Simulated provider webhook |
| 2 | Existing contact found, or a new one safely created | same: exact normalised identifier, a stranger gets a new contact | Simulated |
| 3 | Conversation appears in the inbox | `acceptance` 3, list tests, browser | Simulated + browser |
| 4 | A human opens it and replies | `acceptance` 4-5; control tests | Simulated provider |
| 5 | Provider acknowledges delivery status | `acceptance` 4-5: "sent" until the provider's own event, then "delivered" with its events | Simulated callbacks |
| 6 | An authorized AI employee is assigned | `acceptance` 6; the four internal roles are refused by the server | Simulated |
| 7 | The AI employee responds using permitted tools and context | `acceptance` 7; `messaging-responder` tests | **Stub model** (no model call) |
| 8 | A human takes over and no stale AI reply is sent | `acceptance` 8; fence tests in `control` (queue-time, dispatch-time, mid-generation) | Simulated |
| 9 | Transfer to another authorized team member | `acceptance` 9; browser hand-over | Simulated + browser |
| 10 | A CRM task or opportunity is linked | `acceptance` 10 (idempotent deal, events, panel) | Simulated |
| 11 | An authorized workflow reacts to an inbox event | `acceptance` 11; `unified-inbox-automation`; `-workflow-step` (resolve, assign, pause, loop limit); browser: published and turned on | CRM workflow engine, embedded DB |
| 12 | Two staff viewing the same thread get consistent updates | `acceptance` 12 (same change and revision, same thread); `sync-logic`; browser: a second tab updated in about 9 s | Simulated + browser |
| 13 | An unauthorized user cannot reach another tenant's conversation | `acceptance` 13; `unified-inbox-routes` (404 identical to "does not exist", list, sync, context, assist) | Real RLS, embedded DB |
| 14 | An unsubscribed workspace keeps the core inbox | `acceptance` 14 and the workflow tests (no plan throughout) | Real entitlement check |
| 15 | A disconnected provider produces an honest error | `acceptance` 15 (health state, plain refusal, blocked AI reply, nothing sent); browser "3 channels need attention" | Simulated |
| 16 | A failed delivery can be inspected and retried safely | `acceptance` 16; `control` (classification, one retry, unconfirmed needs acknowledgement, concurrency, opt-out still enforced) | Simulated provider |
| 17 | A mobile user can read, reply and open customer context | Browser at 375x812: thread, composer, Customer sheet, retry; no horizontal scroll; Send clear of the floating button | **Browser only** |
| 18 | An AI suggestion stays a draft until sent or approved | `acceptance` 18; `unified-inbox-ai`; browser: preview card, "AI-written, not verified" | Stub model + browser |

## 6. Browser QA (isolated QA workspace, embedded database, every send switch off, simulated AI provider)

Verified by hand in a real browser: list, tab counts and definitions; search and filters; select mode and a bulk resolve with an outcome (toast, counts,
Resolved view); thread header and controls for owner and support roles; hand-over to a teammate (the support user then sees only that conversation; the
"Nothing is assigned to you yet" wording for an empty restricted list is covered by `unified-inbox-ui`, not re-checked in the browser); Customer panel with the simulated summary; failed and unconfirmed sends with "Send again"; two tabs
staying in step; notifications; the workflow editor (new triggers listed, the new step's panel, publish and turn on with no plan); phone, tablet and
desktop widths; light and dark theme. axe-core (WCAG 2 A/AA, 2.1 A/AA, best practice) found and we fixed: contrast of "via provider" text inside tinted
bubbles and a loading skeleton with `aria-label` on a plain element; after the fixes the list and thread report no violations in light or dark.

Not done in a browser: the Viewer role (the QA pane's sign-out did not respond; the role's limits are covered by route and service tests), the
scheduler-driven notices (covered by tests; the QA server runs without the scheduler), and anything against a real provider or model.

## 7. Security and tenant-isolation findings

* **Isolation:** every read goes through row-level security as the signed-in person; a foreign, hidden or non-existent conversation all answer the same 404.
  `conversation_events` is read-only for the application role and bound to the conversation's visibility. Cross-tenant writes are refused by the composite foreign keys.
* **Found and fixed during this phase:** the notification-constraint rewrite in the migration and rollback could have allowed no notification kinds at all if the
  constraint printed in its other text form (it now reads both and refuses to proceed on a short read); the sync stamp would have matched a workspace's entire
  history on the first poll after deploy (old messages now stay NULL, the index is partial); a regex with a stray backspace character made hand-over lines read
  wrongly; opted-out customers counted as "waiting" (they no longer do); the legacy list silently changed its cap (restored).
* **Workflow step:** cannot message a customer or resume AI replies; the publisher needs the matching inbox permission; changes carry the run's event depth; resolve is
  refused over a customer who wrote since the run started or a person who was asked to take over.
* **Open, low:** pause reasons are free text up to 120 characters in the event trail (ids and enums otherwise); they are exported with the workspace but are not redacted if a
  contact is erased on its own. Unread state is shared by everyone who can see a conversation (Phase 0 risk 4): two people opening a thread clear each other's unread mark.

## 8. Integration readiness matrix

| Integration | Built | Verified here | Live status | Needed |
| --- | --- | --- | --- | --- |
| GoHighLevel (SMS, email, WhatsApp via GHL) | Inbound, outbound, delivery events, health | Simulated provider | **Not verified live** | GHL test location, credentials, `GHL_WRITES_ENABLED` decision |
| Twilio (SMS, WhatsApp) | Same | Simulated | **Not verified live** | Account, registered sender, webhook URL, owner approval |
| Meta WhatsApp Cloud | Same, including the 24 h window and templates | Simulated | **Not verified live** | Business account, approved templates, owner approval |
| Resend (email) | Same | Simulated | **Not verified live** | Domain, API key, owner approval |
| Hermes AI employees (Sales Assistant, Appointment Setter) | Assignment, pause, fence, responder | Stub model | **Not verified live** | VPS dry run (separate gate), approval |
| AI assist (summary, suggested reply) | Via the shared `llmComplete` | Simulated provider | **Not verified live** | A configured AI provider |
| Native CRM (contacts, deals, tasks, notes, calls) | Context panel and four actions | Real services, embedded DB | Same code as production | None |
| CRM workflow engine / Automation Studio | Triggers, step, loop limit, plan boundary | Real engine, embedded DB | Same code as production; **scheduler reported OFF** | Enable the scheduler |
| Notifications | Three new kinds | Real | Same code as production | Migration 0082 |
| Website AI chat, social, phone as inbox channels | Shown as not available | n/a | **Not built** | Product decision |

## 9. Remaining issues and gates

| # | Severity | Item | Next step |
| --- | --- | --- | --- |
| 1 | **High** | No live provider or model verified (matrix above) | Credentials and approval; staging with sandbox accounts first |
| 2 | **High** | Migration 0082 unrehearsed on a production copy; number collision with master's pending 0081 | Rehearse on a copy; renumber if another branch lands first |
| 3 | Medium | Production scheduler reported OFF: waiting notices and "went quiet" workflows are inert | Confirm and enable, per the Automation Studio runbook |
| 4 | Medium | Merge with master's uncommitted AI-workforce changes. **Rehearsed locally:** three files conflict (one line in `send.ts`, two job-list tests), all resolved; the merged tree passes type-check and the whole suite (293 files, 4,654 tests, 0 failed) | The workforce stream commits first, then the real merge; see [rollout-plan.md](./rollout-plan.md) |
| 5 | Medium | Seven pre-existing test failures on master | Not present in the merged tree, so by elimination fixed by master's pending workforce changes (not run on their own); needs those committed |
| 6 | Medium | Polling every 5 s per open tab, per-process rate limit (not shared across instances); no load measurement on hosted Postgres | Measure on staging; add a shared limiter if instances multiply |
| 6b | Info | **Per-workspace rollout built (local, unapplied).** Off by default; a Super Admin switches workspaces on one at a time; enforced on the server; the previous inbox is kept for every other workspace; audited; every in-flight item survives a switch-off ([workspace-rollout.md](./workspace-rollout.md)). The global switch `INBOX_DISABLED=true` remains and now returns workspaces to the previous screen. A changed variable applies on the next deployment | Decided: first deployment dark (`INBOX_DISABLED=true`), second deployment lifts the switch, then internal workspace, test clients, gradual customers (rollout plan, stage 6). Needs migration 0082 (the rollout table) and your choice of waves (D6) |
| 6c | Low | The previous inbox is kept alongside the new one for the duration of the rollout (two screens to maintain; the previous one is frozen at master `22c68c2`). A rollout change reaches other server instances within 3 s; an open tab keeps its screen until it next loads | Delete the previous screen after the last workspace has moved and held; see workspace-rollout.md section 9 |
| 7 | Low | Shared unread state; free-text pause reason in the trail | Per-user read state is a larger change; consider dropping the free text |
| 7b | Low | The Priority sort orders by a computed rank, so each list read scans the workspace's open conversations and sorts them before taking the first page (fine for hundreds or a few thousand; it grows with the workspace) | Measure on staging with a realistic workspace; if needed, store the rank or index the common views |
| 8 | Low | Viewer role not exercised in a browser | Repeat when sign-out works in the QA pane |
| 9 | Info | The trigram index is built inside the migration transaction, and may turn out to be unused by the search query | Check `EXPLAIN` on staging; drop it from the migration if unused; on a large table build it `CONCURRENTLY` first (same name; the migration then finds it) |

## 10. Approvals this work is waiting on

Push the branch; apply 0082 anywhere hosted; enable any provider write switch; run any live provider or model check; enable the scheduler; deploy.
