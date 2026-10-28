# AI Employee capability repair: change package (2026-10-28)

Status (updated 2026-10-28 evening): **the first commit of this repair, `21b3f6a0`, is already on `origin/master` and is serving production (`iacquire.online`).** It was pushed to master at about 19:45 +08 and Vercel's production deployment `dpl_37NeVCTyTfrT4ud4psqvsJPyQJaq` was Ready at about 19:49, before the security review the founder asked for. Who pushed it is not established (the git credentials are the founder's). **The review in section 10 found defects in that commit. The fixes are in a second commit on `fix/employee-real-capabilities` and are not deployed.** No Hermes profile, SOUL file, credential, role permission, schedule or database row was changed by this work; the only database writes are the additive audit rows the new code writes when a chat runs. Approval to release the fixes is requested in section 9.

## 1. Root causes (exact, from the code)

The employees were not "poorly trained". Three separate defects combined:

1. **The instructions told every employee to use tools that do not exist.** `compileAgentConfig` (`src/server/workforce/compiler.ts`) wrote a section called "Tools you may use" listing each role's portal capability labels (`crm.read`, `crm.request_update`, `calendar.read_availability`, …, from `agent_roles.default_tools`) followed by "Use only these tools". Those are permission labels for settings screens, not functions. The pinned Hermes gateway gives an employee only `memory`, `session_search`, `todo`, `vision` and `web` (`src/server/integrations/hermes/tool-policy.ts`, `docs/hermes-tool-inventory.md`). The model searched for the listed names, found none, and reported "no CRM connection, only web and session tools", reciting the labels. That is exactly the production transcript.
2. **Nothing gave five of the six employees any data.** Only the internal Operations Manager received a server-read snapshot (`internal-capability-context.ts`). The CRM Manager, Sales Assistant, Appointment Setter, Lead Hunter and Performance Analyst received instructions and the user's words, nothing else. The CRM tool endpoint (`/api/agent-tools/*`) exists but is not wired: `AGENT_TOOLS_WIRED = false` in `src/server/crm/agent-tools/overview.ts`, no code calls `issueAgentToolToken`, and `docs/hermes-crm-tools.md` records that token delivery to a Hermes run was never verified. So even a correct tool list would have pointed at nothing.
3. **The chat router only turns specific verbs into background jobs.** `parseWorkforceChatAssignment` needs words like "review/check/show" plus a topic. "How's our CRM right now?" matches nothing, so it falls through to a Hermes run that had no data. Even when it matches, the chat shows an acknowledgement and the result lives on the work board, not in the reply.

Appointment Setter specifically: the calendar is **not configured**, so "no verified appointments" is the correct answer. The employee said "tools unavailable, check the list manually" instead, which is wrong for both causes (calendar not set up vs. integration down).

## 2. What changed

**Architecture decision.** The pinned Hermes runtime cannot call iAcquireOS, and wiring a Hermes-callable tool needs a profile/toolset change that cannot be proven without the VPS. The smallest compatible, independently testable integration is a **server-side, read-only, role-scoped read performed before each run**, handed to the employee as a verified snapshot. This is the pattern already used for the Operations Manager, generalised to all six roles and to client workspaces.

| Area | Files |
| --- | --- |
| Evidence reader (all six roles) | `src/server/workforce/employee-evidence.ts` (new) |
| Pure text, states, leak detector | `src/lib/employee-evidence.ts` (new) |
| Run-time fix of the legacy tool list (no stored config rewritten) | `src/server/workforce/service.ts` (`composeRunInstructions`), `src/lib/employee-evidence.ts` |
| Future configs compile the correct text; "Allowed actions" switches still work | `src/server/workforce/compiler.ts` |
| Chat hands each run its snapshot | `src/server/chat/service.ts` |
| Reuse of existing definitions | `internal-capability-context.ts` (export `readOperationsSnapshot`), `performance-snapshot.ts` (export `readPerformanceMetrics`) |
| Readiness shown as eight separate facts | `src/lib/employee-capability-status.ts`, `src/server/workforce/capability-status.ts`, `src/components/workforce/capability-checklist.tsx`; wired into `employee-detail.tsx`, `agency-workforce-manager.tsx`, `server/admin/queries.ts`, `server/workforce/service.ts` |
| Tests and acceptance tooling | `tests/employee-evidence.test.ts`, `employee-chat-evidence.test.ts`, `employee-capability-status.test.ts`, `capability-checklist.test.tsx`, `employee-acceptance-dump.test.ts`, `scripts/employee-real-model-acceptance.ts`; `workforce-config.test.ts` updated for the new text |

No migration. No change to the immutable policy text, `POLICY_VERSION`, `INTERNAL_POLICY_VERSION`, stored configuration versions, acknowledgements, Hermes toolsets or profiles.

**What each employee now receives with every message** (as the signed-in person, this workspace only):

| Employee | Sections |
| --- | --- |
| Zeng, Operations Manager | AI work board, scheduled AI work, work waiting on other teammates and which areas are set up; clients also get tasks, approvals and the AI team. The internal agency keeps its existing gated snapshot of tasks, approvals and AI-team activity. |
| Lead Hunter | Leads (counts by review, duplicate and CRM status, ten most recent), saved targeting rules, research requests |
| Appointment Setter | Calendar setup (calendars, hosts, weekly hours, meeting types, what is missing), appointments this week and next 14 days, booking requests waiting, open times (only if the calendar is ready) |
| Sales Assistant | Pipelines and stages, open deals, value, deals missing value/contact/owner/close date, stalled deals |
| CRM Manager | CRM counts and recent activity, record quality (missing details, possible duplicates, masked), pipeline |
| Performance Analyst | The same measured KPIs as the Performance Snapshot job (30 days vs. previous 30), CRM, pipeline, calendar setup |

Every section carries one of six states: `ready`, `empty`, `not_configured`, `unavailable`, `no_permission` (the person may not see it) and `switched_off` (a workspace owner switched this ability off for the employee; added in the section 10 hardening). The block tells the employee how to answer in each, forbids internal names, forbids claiming any action was done, and says the snapshot overrides earlier conversation and memory. "Needs approval" is covered in the rules (changes are proposals; chat has no write path).

## 3. Security impact and tenant isolation

- Read-only. The only write is one `audit_logs` row per read (`workforce.employee_evidence_read`) with section states and timings, never record contents.
- Role and ability gate (section 10): an area is read only when the employee's role includes it and its "Allowed actions" still permit it, as well as the person's own permission. If that cannot be confirmed, nothing is read.
- Runs as the signed-in person: CRM sections through `memberActor` (internal agency: only the Super Admin owner seat, otherwise `no_permission`), other sections through `withUser` (row-level security) after an explicit `ctx.can(...)` check. A person who cannot see an area gets `no_permission`, never a count.
- One workspace: every query is bound to `ctx.org.orgId`. Tests prove a second workspace's contacts, deals and leads never appear for any of the six roles.
- No new network path, no new credential, no Hermes change, no token. Failures become `unavailable` and are logged server-side; a section can never throw into chat. Each section has a 6-second ceiling.
- Hermes-side web access is unchanged (still the reviewed toolsets). The new text says web search is for Lead Hunter research only.
- Customer wording: record text is marked as data, not instructions. PII sent to the model is limited to what the person could already open in the product (duplicate emails/phones are masked).

## 4. Tests and results (local)

- New: 30 evidence tests (pure text, every role, empty/not-configured/ready, tenant isolation, permission, audit), 11 chat end-to-end tests (all six acceptance questions through `sendChatMessage` to a local Hermes stand-in: the run carries the role's sections, the old tool list is gone, the policy appears once after the snapshot, the reply is stored, no booking/approval/contact/deal/job is created), 11 capability-status tests, 3 checklist render tests.
- Full `tsc` (app and scripts) exit 0; ESLint on all changed files clean; all files LF.
- Existing suites touched by the change (workforce config, chat, Hermes provisioning, knowledge, lead-hunter context, jobs, role playbooks, readiness, onboarding generator): pass; two assertions in `workforce-config.test.ts` and none elsewhere were rewritten because they pinned the old tool-list wording.
- Full suite: 694 test files pass. 8 files fail (appointments reminders, automation-studio hardening, chat-rail, demo showroom nav width, messaging 30-day allowance, staff-workload calendar, type-scale floor, workforce navigation). **The same 8 tests fail identically on an untouched checkout of production commit `d4adb4fd`**, so they are pre-existing and unrelated to this change; I did not touch them.

**Real-model acceptance (not a Hermes run).** `scripts/employee-real-model-acceptance.ts` sends each scenario's exact assembled instructions plus the acceptance question to the configured model provider (synthetic data only; the key is read from `.env`, never printed). "Control" is production's stored instructions before the fix, "fixed" is what a run is now given.

| | Control | Fixed |
| --- | --- | --- |
| Checks passed (13 scenarios; fixed run twice) | 0 of 13 (1 of 13 on an earlier run; the model varies) | 26 of 26, and none of the 26 replies contained an internal name |

The control reproduces the production failure (leaked labels, "I'd need to pull the records", questions about whose calendar). Fixed replies, for example: "Your CRM is set up and ready, but it's empty right now — zero contacts, zero companies and zero deals…"; "I can't show any appointments for this week … because the booking calendar isn't set up yet… Want me to help get that calendar set up?"; with a calendar, "You have 1 appointment this week: Thursday, October 22 at 10:00 AM GMT+8 — Consultation with Ana Reyes, confirmed, hosted by Mark".

## 5. Per-employee result

| Employee | Role awareness | Real tool access | Verified workspace data | Actual chat result | Authorized task result | Remaining blocker |
| --- | --- | --- | --- | --- | --- | --- |
| Zeng | Yes (role standard + sections) | Read-only server read of work board, schedules, handoff counts (+ existing internal snapshot) | Synthetic: board clear, schedules none, 10 leads waiting | Real model: "Nothing is running or waiting… 10 leads are waiting for human review" | None created (proposals only) | Production run not yet done; Hermes cannot call tools |
| Lead Hunter | Yes | Read-only leads, targeting, requests | Synthetic: 10 leads, all pending, 1 possible duplicate | "You currently have 10 researched leads. All 10 are awaiting human review…" | No research started, nothing sent | Web research only through its existing approved path |
| Appointment Setter | Yes | Read-only calendar setup, appointments, open times | Calendar not configured → says so; configured → lists the real booking | Both real-model answers correct | No booking created | **Calendar must be saved and activated by a person**; Google Meet needs a connected Google account |
| Sales Assistant | Yes | Read-only pipeline and deals | Zero deals reported as zero; one real deal named with value | "Your sales pipeline is set up and ready, but it's empty right now…" | No deal changed | None for read-only |
| CRM Manager | Yes | Read-only CRM, quality, pipeline | Empty CRM reported as ready and empty | "Your CRM is set up and ready, but it's empty right now…" | No record changed | None for read-only; proposals need the approval flow |
| Performance Analyst | Yes | Read-only measured KPIs | Real leads reported; nothing-recorded state says figures are not available yet | Correct in both states, no invented money or percentages | None | Revenue/conversion are not tracked anywhere yet |

## 6. Readiness (Phase 7)

The existing badge and its 7 requirements are unchanged and are not forced. A new "What this employee can do right now" list (customer view: plain sentences; admin view: the evidence) shows eight separate facts: set up, connected, safe tools confirmed, business setup ready, can read your records, changes need approval, has answered a real question, allowed to work on its own. A fact is "Yes" only on recorded evidence (the latest audited read, completed chat runs, switched-on schedules); with none it says "Not confirmed". Business data is deliberately not counted as a runtime tool: the server reads it.

## 7. Client onboarding compatibility (Phase 9)

The same reader runs for client workspaces (verified in tests): the knowledge block, SOUL and snapshot all come from the signed-in workspace; nothing from the internal agency or the demo workspace is read. Workspaces whose CRM or appointments live in GoHighLevel report "kept in another system, not connected to your assistant" rather than "empty". Provisioning, package entitlements and Pending Setup are unchanged and still **not** production-verified. Not claimed.

## 8. What is not verified

- No production run. Real Hermes (SOUL.md plus the per-run instructions) has not been exercised; the model test above had the run instructions only.
- The profile SOUL files on the VPS were generated from configurations that contained the old tool list. The run-time text tells the employee those names are not callable, but I have not seen the VPS files. Hardening (a reviewed SOUL revision) is optional and separately gated.
- The new checklist UI was rendered in tests, not opened in a browser.
- Production database facts (stored instructions, calendar state, `default_tools`) are taken from the user's report and the code, not from a production read.
- A Hermes-callable tool bridge is **not** built. If wanted later: issue the existing per-run token (`issueAgentToolToken`) from the chat run, deliver it to a Hermes HTTP/MCP tool declared in the profile (`no_mcp` and the reviewed toolset would change), extend the inventory attestation, flip `AGENT_TOOLS_WIRED`. That needs a VPS dry run per `docs/hermes-restricted-provisioner.md`.
- Chat messages that match the background-job router (for example "review our pipeline") still answer with an acknowledgement and put the result on the work board.

## 9. Release, deployment, rollback

**Where things are now (checked 2026-10-28 ~19:50 and again before this release package):**

| Item | State |
| --- | --- |
| Production (`iacquire.online`) | Was serving `21b3f6a0` (first commit, without the section 10 fixes) from ~19:49 +08 (deployment `dpl_37NeVCTyTfrT4ud4psqvsJPyQJaq`). At 22:50 a separate, unrelated commit (`a8708414`, transactional email branding, pushed by the founder's git account) went to `master` on top of it; production now serves that (deployment `iacquire-dashboard-i03vpkj4b`), which still contains the unhardened `21b3f6a0`. |
| Previous production deployment (the way back) | `iacquire-dashboard-kmzo210pj-mlester999s-projects.vercel.app` = `dpl_GcfzGttUhCdhVRB1HEim1BNZmoi5`, built from `d4adb4fd`, Ready since 14:08 +08. |
| `origin/master` | `a8708414` (= `21b3f6a0` plus the email branding commit). |
| Review branch | `fix/employee-real-capabilities`: the section 10 fixes, tests and this document, merged with current `master` so that it fast-forwards onto it. Against current `master` it changes exactly four files (`src/lib/employee-evidence.ts`, `src/server/workforce/employee-evidence.ts`, `tests/employee-evidence-hardening.test.ts`, this document). Not on master, not deployed. |
| Vercel Preview environment | Has **no environment variables** (checked with `vercel env ls preview`; production has 44). A Preview build of the review branch therefore compiles but has no database, no credentials and no model key: it cannot read or write any real workspace. |

**Proposed release (needs the founder's explicit approval, nothing below has been done):**

1. Push `fix/employee-real-capabilities` to `origin` as the review branch. Vercel builds a Preview (compile-only, see above). No effect on production.
2. On approval, fast-forward `master` to the review branch tip (`git push origin fix/employee-real-capabilities:master`, no force; it is a fast-forward because the branch contains current `master`. If `master` moves again first, merge it into the branch again). Vercel builds production from it (about 4 minutes). No migration, no Hermes or VPS step, no credential change, no environment change.
3. Production acceptance (section 11 and the founder's step 3) runs only after step 2.

**Rollback (any time, nothing to clean up):** `vercel rollback iacquire-dashboard-kmzo210pj-mlester999s-projects.vercel.app` (or promote it from the dashboard) puts `d4adb4fd` back in about a minute; stored configurations, acknowledgements, policy text and SOUL files were never touched, and the audit rows the new code writes are additive and harmless. Because `master` now also carries the email branding commit, rolling back to the `d4adb4fd` build would also take that email change out of production until the next deploy; the code-side alternative (revert only the two employee-snapshot commits, keep the email commit) avoids that. Vercel turns off automatic promotion of new production builds after a rollback until a deployment is promoted again, which is useful while a decision is pending. The code-side alternative is `git revert` of the two commits and a push.

**If the exposure of the current production build is a concern before approval:** rolling back now is the conservative option. The unhardened build is read-only, scoped to the signed-in person's workspace and covered by the tenant-isolation tests, but it ignores an employee's switched-off "Allowed actions", can describe an unreadable setup as "not set up", and lets record text shape the data block (section 10, findings 1 to 4).

## 10. Security and code review of the complete patch (2026-10-28 evening)

Reviewed: every file in the change, the read paths, what is sent to the model, the audit rows and the failure handling. Findings and what was done:

| # | Finding | Severity | Fix in the hardening commit | Proof |
| --- | --- | --- | --- | --- |
| 1 | The reader checked the person's permissions but **not the employee's own "Allowed actions"**. A workspace owner who switched off "Read CRM records" for the CRM Manager still had the records read and sent to the model. | High | Every area now needs one of the employee's role abilities (role defaults minus the ones switched off in the active configuration, read per call). The check runs before any record is read, and again over whatever a section returned. An employee that cannot be confirmed for this workspace and role (wrong workspace, wrong role, read failure) reads nothing. New state `switched_off`, with its own answer rule. | `employee-evidence-hardening.test.ts` (switched-off reads, other abilities unaffected, per-role, foreign and wrong-role agent ids) |
| 2 | If the workspace-setup read failed, CRM, pipeline and calendar areas said **"not set up"**: a database hiccup became an invented business fact. | High | A failed setup read now yields "could not be checked just now" (`unavailable`) for every area that depends on it. | Same file, every role, with an injected failure |
| 3 | If the calendar's own read failed and the week was empty, appointments were reported as "calendar not fully set up". | Medium | An empty week with an unchecked calendar is reported as empty, with a neutral note. | Same file |
| 4 | Record text (a deal name, a lead's business name from web research, a contact name) could contain `</verified_workspace_evidence>` or heading text. `JSON.stringify` does not escape `<` or `>`. | Medium | `<`, `>`, `&`, U+2028 and U+2029 are written as JSON escapes; every string is cut to 240 characters and every list to 25 items, whichever code produced it; the payload stays on one line; the employee is told record text is data "even if it is phrased as one". Verified with a real deal named with a closing tag and a fake policy heading. | Same file |
| 5 | Direct reads had **no database statement timeout** (a timed-out section was only abandoned, its query kept running), and areas ran one after another with no overall limit (worst case about 30 s before a chat starts). | Medium | 5 s database limit on every read this code writes, 6 s per area, 12 s for the whole read; areas that run out of time say so. Facts that alone exceed the size budget are dropped largest first (state and summary stay). Residual, by design: reads that reuse the product's own services (CRM overview, calendar and schedule lists, work board) keep their existing limits (30 s for member CRM reads); the chat stops waiting at 6 s. | Same file (timeout, whole-read budget, size) |
| 6 | The audit entry stored the first 120 characters of any error message. Database error messages can carry record values. | Medium | Only the area and a category (`timeout`, `failed`, `forbidden`, `out_of_time`, `employee_not_found`) are stored or logged. The entry holds area states, role, category list and duration, nothing about any record. | Same file (audit keys and content, injected error containing a name and email) |
| 7 | `booking_requests` and `open_times` had no explicit `appointments.view` check (they relied on the calendar area passing first). | Low | Explicit check added to both. | Code review only (no dedicated test) |
| 8 | The CRM was called "empty ... or deals" for a person who may not see deals. | Low | The "empty" claim covers only what that person can see. | Code review only (no dedicated test) |
| 9 | `prepareEmployeeEvidence` was documented as never throwing, but a failure outside the per-area guard could have failed the chat. | Low | Whole function wrapped; formatting has a fallback. | Code review only (no dedicated test) |

**Checked and found sound (no change):** every query is bound to the authenticated workspace (`ctx.org.orgId`) and the CRM/pipeline/quality/booking reads run as the signed-in person under row-level security (`withUser`); Client A's records never appear in Client B's evidence (existing test, all six roles, plus the foreign-agent test above); the run record (`agent_runs`) does not store the instructions, so the snapshot is not persisted; retrieved records go only into the per-run instructions, never into a stored configuration, SOUL file, acknowledgement or knowledge entry; background and customer-reply paths (`research-job.ts`, `messaging/responder.ts`) never receive the snapshot and their instructions say "no live view of this workspace's records" (tested); the chat rate limit runs before the reads; stored configuration versions, immutable policy text, `POLICY_VERSION` and Super Admin acknowledgements are untouched.

**What is sent to the model provider (DeepSeek, through Hermes) with each chat message, per role:** counts and states; deal, task, approval and AI-work titles (120 characters at most); contact display names on appointments, booking requests and deals; names of workspace members who are hosts, owners or assignees; lead business names, websites, industry and location; the last three research requests (140 characters each); the last six CRM activity lines (system-written summaries, notes are excluded). **Never sent:** email addresses, phone numbers, street addresses, note or message bodies, meeting links (only whether one exists), payment or invoice details. Possible duplicates are masked (first two letters of the email name plus the domain; last three digits of a phone number). The whole block is limited to about 14,000 characters (about 3,500 tokens), which is added to every chat message of the role.

**Residual risks (not eliminated, stated plainly):**

- *Shared employee memory.* A Hermes run uses `memoryScope = iaq:<workspace>:<role>`, so everyone in a workspace talks to the same employee memory. Text the employee saves to memory or notes from one person's chat could be recalled for another person who may not be allowed to see it. The block now tells the employee not to save details from the snapshot, but only a Hermes-side memory policy would enforce that. This risk existed for conversation text before this patch; the patch adds more data to the conversation.
- *Per-message cost.* Up to about a dozen read-only queries and about 3,500 extra tokens per message, with no caching. Not a correctness issue; worth a cache if chat volume grows.
- *Not a Hermes run.* The 25/26 and 26/26 results below are from the model provider with the assembled instructions. Real Hermes (SOUL.md plus per-run instructions) is exercised only in production acceptance.
- *Phrase-matched acceptance.* One of 26 checks in the hardened run (Performance Analyst, nothing recorded, second of two runs) failed the phrase matcher although the reply was correct ("I can't show any meaningful performance figures"); the other run of the same scenario passed. Recorded as model wording variance, not as a pass.

## 11. Verification of the hardened branch

Run on commit `6b77d56f` (the hardening commit), 2026-10-28. After that, `master` moved (email branding, 4 unrelated files) and was merged into the review branch; the merged tree was re-checked with the TypeScript compiler and the affected tests (see the last rows). The full suite and the production build were **not** repeated on the merged tree.

| Check | Result |
| --- | --- |
| TypeScript, app and scripts (`npm run typecheck`) | Pass |
| ESLint, whole repository (`npm run lint`) | 0 errors, 2 warnings (unused imports in `src/server/aqi/service.ts`, a file this work does not touch) |
| Production build (`npm run build`, Next 16.4.2) | Pass |
| Focused: 16 new hardening tests, 30 evidence tests, 11 chat end-to-end tests, 11 capability-status tests, 3 checklist tests, workforce config tests | 87 of 87 pass |
| Tenant isolation | Pass: Alpha's evidence never contains Bravo's contacts, deals or leads for any of the six roles; an employee id from another workspace, or the right workspace under the wrong role, reads nothing and sends no record |
| Permission denial | Pass: a person without the permission gets `no_permission`, never a count; an agency staff member without the internal CRM seat gets `no_permission`; an employee's switched-off ability gets `switched_off` and no record is read or sent |
| Role context | Pass: each role receives only its own areas (`EXPECTED_SECTIONS` in `employee-chat-evidence.test.ts`) and no section carries a system label |
| Full suite (`npx vitest run`) | 695 files pass, 8 fail, 1 skipped; 11,088 tests pass, 8 fail, 2 skipped |
| The same 8 failures on clean production `d4adb4fd` | Yes. Re-run 2026-10-28 in a temporary worktree of `d4adb4fd`: the same 8 tests fail with the same assertions. |
| Real-model acceptance (synthetic data, deepseek-flash, two runs; not a Hermes run) | Before the fix 0 of 13; after 25 of 26 (see section 10, last residual risk) |
| Vercel Preview build of `6b77d56f` | Ready (compile-only: the Preview environment has no variables) |
| After merging current `master` (`a8708414`): TypeScript | Pass |
| After merging current `master`: the six evidence suites, workforce config, `proposals-crm` and `email-render` (8 files) | 117 of 118 tests pass. The one failure is `tests/email-render.test.ts` ("renders the invitation ..." expects the old logo URL): a ninth failure that comes from `master`'s own commit `a8708414`, which changed the email branding without updating the test. This work does not touch email rendering; not fixed here. |

**The eight failures, unrelated to this work (they fail identically on production `d4adb4fd`):**

1. `tests/appointments.test.ts`: reminders stop being planned when the owner switches them off.
2. `tests/automation-studio-hardening.test.ts`: usage metering counts every failed attempt of a given-up run.
3. `tests/chat-rail.test.tsx`: the chat rail shows the brand and a way back to AI Employees (cannot find the wordmark text).
4. `tests/demo-showroom-controls.test.tsx`: the showroom navigation rail folds and unfolds (expects 68px, gets 76px).
5. `tests/messaging-core.test.ts`: the 30-day per-contact allowance at planning and send time.
6. `tests/staff-workload-views.test.ts`: a dated item appears on the team calendar on its day.
7. `tests/type-scale-floor.test.ts`: no Tailwind arbitrary text size below 12px (14 offenders in the existing code).
8. `tests/workforce-navigation.test.tsx`: the sidebar wordmark through the shared Logo.

**Changed files against production `d4adb4fd` (23 files: 13 added, 10 changed; two commits, `21b3f6a0` and `6b77d56f`):**

- Added: `docs/ai-employee-capability-repair-2026-10-28.md`, `scripts/employee-real-model-acceptance.ts`, `src/components/workforce/capability-checklist.tsx`, `src/lib/employee-capability-status.ts`, `src/lib/employee-evidence.ts`, `src/server/workforce/capability-status.ts`, `src/server/workforce/employee-evidence.ts`, `tests/capability-checklist.test.tsx`, `tests/employee-acceptance-dump.test.ts`, `tests/employee-capability-status.test.ts`, `tests/employee-chat-evidence.test.ts`, `tests/employee-evidence-hardening.test.ts`, `tests/employee-evidence.test.ts`.
- Changed: `src/app/(portal)/employees/[slug]/page.tsx`, `src/components/admin/agency-workforce-manager.tsx`, `src/components/workforce/employee-detail.tsx`, `src/server/admin/queries.ts`, `src/server/chat/service.ts`, `src/server/workforce/compiler.ts`, `src/server/workforce/internal-capability-context.ts`, `src/server/workforce/performance-snapshot.ts`, `src/server/workforce/service.ts`, `tests/workforce-config.test.ts`.

The second commit alone (the hardening) touches only `src/lib/employee-evidence.ts`, `src/server/workforce/employee-evidence.ts`, `tests/employee-evidence-hardening.test.ts` and this document.

**Not verified by any check above:** a real Hermes run, the VPS SOUL files, how the new checklist looks in a browser, any production database state, and Vercel production behaviour of the hardening commit (it is not deployed).

## 12. What each employee can do, and what still needs a tool bridge (remaining-work matrix)

Three different things are easy to confuse, so they are kept apart:

- **Read-only Chat (this release).** The server reads the person's own workspace before each run and hands the employee a verified snapshot. This lets the employee *answer*. It does not let the employee *do* anything, and it must not be described as tool access.
- **Server-run work (already in the product).** The chat router and the work board turn requests such as "review our pipeline" into durable background jobs that the iAcquireOS server runs under the person's permissions (14 reviewed capabilities in `src/lib/workforce-capabilities.ts`). These are not Hermes tool calls. They exist in the product and have their own tests, but they were not exercised in production acceptance and the scheduler is off.
- **Hermes-to-iAcquireOS tool execution (not built, not wired).** The per-run token and HTTP tool endpoints exist (`src/server/crm/agent-tools/*`, scopes per role in `src/lib/agent-tool-scopes.ts`), but `AGENT_TOOLS_WIRED = false`, nothing issues a token to a chat run, and token delivery to Hermes was never verified. Until that is built and proved on the VPS, **no employee can edit a record, request a booking, draft a message or create a task from chat.**

| Employee | Read-only Chat (this release) | Server-run work today (background, work board) | Needs the tool bridge (truly missing) | Awaiting approval or switched off |
| --- | --- | --- | --- | --- |
| Zeng, Operations Manager | AI work board, scheduled work, handoff counts, set-up status; clients also tasks, approvals, AI team (internal agency keeps its own gated snapshot) | On-demand operations review | Create or assign a task (`tasks:write`), request an approval, write a summary | Scheduled and proactive work (scheduler off); anything autonomous |
| Lead Hunter | Existing researched leads, review and duplicate status, saved targeting rules, recent research requests | Lead research (approved public sources), lead generation review | Tag a lead or create a follow-up task from chat (`tags:write`, `tasks:write`) | Outreach (never enabled: research is not consent); adding leads to the CRM needs approval; new research needs saved targeting rules |
| Appointment Setter | Calendar setup status and what is missing, this week's and next two weeks' appointments, waiting booking requests, open times | Appointment review, availability check, missed-call review | Submit a booking request (`appointments:request`), update a contact, draft a confirmation, read a conversation (`conversations:read`, `messages:draft`) | Live bookings (a person confirms by default); every customer message; the consultation calendar must be created and activated by a person first |
| Sales Assistant | Pipelines, stages, open deals, value, gaps and stalled deals | Pipeline review, follow-up drafts, lead priority review | Propose a deal or contact change (`opportunities:write`), draft a follow-up (`messages:draft`) | Sending follow-ups (never autonomous); every deal change goes through an approval |
| CRM Manager | CRM counts and recent activity, record quality, possible duplicates (masked), pipeline | CRM quality review | Propose record updates, tags, tasks (`contacts:write`, `tags:write`, `tasks:write`, `opportunities:write`) | Every CRM change is a proposal for a person to approve; merges and deletes are not offered |
| Performance Analyst | Measured KPIs (30 days against the previous 30), CRM, pipeline and calendar setup | Performance snapshot, social, receivables and reputation reviews | Nothing required: its role scope is read-only reports | Revenue, conversion rate and cost are not recorded anywhere yet, so they are never reported |

**What the founder must do before some answers can be "real":** create and activate the consultation calendar (Host Mark, Asia/Manila, Mon-Fri 9-5, 30 minutes, 15 minute buffer, 24 hours notice, 30 days ahead, Google Meet needs a connected Google account); save lead targeting rules; the internal workspace's CRM, pipeline and knowledge state was not read from production for this work.

**Next focused work, only for the truly missing rows above, in this order, each separately approved:**

1. Prove the bridge on the VPS in a dry run (`docs/hermes-restricted-provisioner.md`): issue the existing per-run token from the chat run, deliver it to a Hermes tool declared in the profile, extend the tool inventory attestation. Nothing else is worth building before this works, because every "does something" row depends on it.
2. Read tools first (`conversations:read`, `opportunities:read`), then proposal-only write tools that create approvals (`contacts:write`, `opportunities:write`, `tasks:write`, `appointments:request`, `messages:draft`). The approval, role-scope and permission intersection already exists in `catalog.ts` and is enforced again by every CRM service.
3. A small chat-router change so a plain question ("how's our pipeline?") is answered in the chat from the snapshot instead of being turned into a background job with a work-board result (section 8, last bullet).
4. Optional: refresh the six SOUL files from the corrected configuration text (separately gated).

Kept disabled throughout: autonomous work, customer outreach, live bookings, and broad platform deployment.
