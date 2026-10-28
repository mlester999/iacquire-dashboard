# AI Employee capability repair: change package (2026-10-28)

Status: **built and tested locally on branch `fix/employee-real-capabilities` (based on production commit `d4adb4fd`). Not committed, not pushed, not deployed. No production system, Hermes profile, SOUL file, credential, role permission or schedule was read or changed.** The one approval this needs is at the end.

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

Every section carries one of five states: `ready`, `empty`, `not_configured`, `unavailable`, `no_permission`. The block tells the employee how to answer in each, forbids internal names, forbids claiming any action was done, and says the snapshot overrides earlier conversation and memory. "Needs approval" is covered in the rules (changes are proposals; chat has no write path).

## 3. Security impact and tenant isolation

- Read-only. The only write is one `audit_logs` row per read (`workforce.employee_evidence_read`) with section states and timings, never record contents.
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

## 9. Deployment, rollback, approval

Release shape: one commit on `fix/employee-real-capabilities` on top of `origin/master` (`d4adb4fd`). Local `master` carries unreleased work and is **not** part of this; do not merge it.

1. Approve committing the branch. 2. Approve pushing it to `origin/master`; Vercel builds it. 3. No migration, no Hermes or VPS step, no credential change.
4. Production read-only acceptance (needs the founder at the keyboard for the calendar): run the six questions in the employees' real chats and check replies for the states above. Before that, calendar (not done, not assumed): Host Mark (verify the user mapping), Asia/Manila, Mon–Fri 09:00–17:00, 30 min, 15 min buffer, 24 h notice, 30 days ahead, Google Meet (needs a connected Google account); create it in Calendars & Types and activate it.
5. Optional later, separately approved: refresh the six SOUL files from the corrected configuration text.

Rollback: `vercel rollback` to the previous deployment (the one built from `d4adb4fd`) or `git revert` the commit. Nothing is stored that needs undoing: stored configs, acknowledgements and policy are untouched, and the audit rows are additive.

Read-only production checks to run first, if you want them (no writes, no credentials printed):

```
node --conditions=react-server --import tsx scripts/internal-workforce-readiness-audit.ts --live
node --conditions=react-server --import tsx scripts/hermes-live-audit.ts
```

**Approval requested:** commit this branch and push it to `origin/master` for a Vercel deployment, then run the six production chats with you present.
