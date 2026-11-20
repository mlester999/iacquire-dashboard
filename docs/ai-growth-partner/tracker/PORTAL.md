# PORTAL — Client portal UX and Control Center

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

Audit scope: read-only inspection of worktree gp-completion (HEAD 6e4a4b7e). Nothing was built, run or rendered; every "Verification evidence" line below is from reading source and tests. I did not see the baseline test run, so no row is labelled COMPLETE — VERIFIED.

Domain summary:
- What exists: one client Control Center route (`/growth-partner`, `src/components/growth-partner/control-center.tsx`, 639 lines) that renders partner state, six status cards, 12 permission-filtered shortcut cards, Work Board counts, memory, goals, research-source settings, six capability domains (14 reviewed capabilities), the Business Brain (snapshot, fact editor, draft apply, history), a retained-knowledge review, and a card pointing at the permanent conversation (`/growth-partner/conversation`). The sidebar shows ONE "AI Growth Partner" entry plus Work Board and Schedules & Calendar; the six legacy profiles are hidden behind a "Previous role profiles" entry that appears only while a legacy profile is enabled.
- Real vs simulated: every panel reads real tenant-scoped database services (Business Brain versions, memory, goals, work jobs, schedules, approvals, integration status, audit logs). Nothing on these pages is fixture or scripted copy. The conversation reply text itself depends on the Hermes runtime; in this repo it is only evidenced with synthetic fixtures (docs claim, not observed by me).
- Verification depth: component tests are jsdom renders with server actions mocked. There is NO page-level test for `/growth-partner`, `/work`, `/work/calendar`, `/approvals`, `/activity` or `/settings/integrations`, and NO browser (Playwright/axe) QA script that visits any of these client routes. The only responsive/a11y browser harnesses that exist target legacy `/employees` and `/chat`, the demo showroom, onboarding and CRM. Automated a11y is limited to static guards (aria-label-guard, type-scale-floor, scroll-strip-guard, danger-button-contrast) and one badge test; everything about tablet/phone layout of the Control Center is manual or unverified.
- Biggest gaps: (1) the Control Center has no Reports area and no approvals queue (only counts and links); (2) the permanent conversation never refreshes by itself, has no live-region, no auto-scroll, no link from a message to its job/approval; (3) a throwing Control Center query takes down the whole portal chrome (only root `src/app/error.tsx` exists, and `/growth-partner/page.tsx` has no per-query isolation); (4) legacy six-role residue still leaks into Overview, Approvals ("System" requester) and Work Board fallbacks; (5) 21 `ai_growth_partner.*` audit actions have no friendly label so the Activity log shows raw strings; (6) "Partner connection: Connected" on the Control Center only means a runtime id is linked, while the Integrations page uses a real readiness check, so the two can disagree.

<a id="gp-portal-01"></a>
### GP-PORTAL-01 — One-identity navigation and consistent naming

- **Requirement:** One-identity navigation and consistent naming (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/shell/sidebar.tsx`, `src/components/shell/topbar.tsx`, `src/components/shell/titles.ts`, `src/components/work/work-board.tsx`, `src/components/work/workforce-calendar.tsx`, `src/components/growth-partner/control-center.tsx`
- **Test coverage:** `tests/workforce-navigation.test.tsx` renders the real `Sidebar` and proves one `/growth-partner` link, legacy link only when enabled legacy profile and `agents.configure`, no `/employees/*` or `/chat/*` links, active state, AQi anchor. `tests/shell-titles.test.ts` and `tests/shell-topbar-title.test.tsx` check titles for side-menu entries. Not proven: any title for `/work`, `/work/calendar`, `/approvals`; mobile drawer contents; keyboard navigation; ctrl+K destination search.
- **Real or simulated behavior:** Real shell data from the database; sidebar render test uses the real Sidebar component with a mocked router.
- **Missing dependencies:** none.
- **Remaining work:** Canonical vocabulary (AI Work Board vs Work Board; Workforce Calendar vs Schedules & Calendar; Approvals vs Approval Center); add /work/calendar title above /work in titles.ts; align topbar 'My AI Growth Partner' with sidebar 'AI Growth Partner' and decide on a sidebar link to the conversation; extend shell-titles test to every CLIENT_NAV route plus /work/calendar and /growth-partner/conversation.
- **Verification evidence:** own reading of the files above. Prior recorded runs (docs/ai-growth-partner/implementation-status.md L69): "Focused portal/help checks passed 90/90"; not re-run by me.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every portal destination has one name used identically in sidebar, breadcrumb, H1, Control Center shortcut and AQi help; a test iterates the route list and fails on mismatch.

<a id="gp-portal-02"></a>
### GP-PORTAL-02 — Legacy six-role residue removed from the client experience

- **Requirement:** Legacy six-role residue removed from the client experience (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/overview/page.tsx`, `src/server/workforce/service.ts`, `src/components/approvals/approval-center.tsx`, `src/server/approvals/service.ts`, `src/app/(portal)/work/page.tsx`, `src/app/(portal)/activity/page.tsx`, `src/components/overview/overview-panels.tsx`, `src/app/(portal)/employees/page.tsx`
- **Test coverage:** `tests/overview-growth-partner-navigation.test.tsx` tests `TeamGrid`, which is dead code in the app (the real Overview page renders its own inline list), so it proves nothing about the shipped page. `tests/workforce-navigation.test.tsx` covers the sidebar rule only. Nothing tests the Overview card rule, the Approval requester chip for `growth_partner`, or the "Review profiles" dead end.
- **Real or simulated behavior:** Real legacy rows surfaced by UI rules; the only Overview test targets the unused TeamGrid export, not the shipped page.
- **Missing dependencies:** none.
- **Remaining work:** Gate the Overview 'Previous role profiles' card on any enabled legacy profile (same rule as sidebar) and remove or reuse dead TeamGrid; make Approval Requester chip render 'AI Growth Partner' for agent_role growth_partner (today falls to 'System'); stop Work Board falling back to legacy role names when partner runtime is missing; add page-level Overview and Approvals tests; retarget the stale overview test.
- **Verification evidence:** own reading. `tests/workforce-navigation.test.tsx` shows the sidebar half is clean; Overview/Approvals halves read directly from source.
  - *Skeptic review: Confirmed, and one aggravating detail: in the Overview 'Previous role profiles' card each ENABLED legacy avatar links to /growth-partner/conversation, so six named role avatars all lead to the same place, which is exactly the role-selection confusion the brief forbids. listAgents returns all six legacy rows regardless of enabled (service.ts:186-194), so a fully migrated workspace still shows the card.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** In a Growth Partner-only workspace no screen outside /employees shows a legacy role name, avatar or tagline and Approvals attribute partner requests to AI Growth Partner, asserted by page-level tests.

<a id="gp-portal-03"></a>
### GP-PORTAL-03 — Permanent conversation experience

- **Requirement:** Permanent conversation experience (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/growth-partner/permanent-conversation.tsx`, `src/app/(portal)/growth-partner/conversation/page.tsx`, `src/app/actions/ai-growth-partner-conversation.ts`, `src/components/chat/evidence-chip.tsx`, `src/lib/aqi/launcher.ts`
- **Test coverage:** `tests/growth-partner-permanent-conversation-ui.test.tsx` (3 tests, `fetch` stubbed, server actions mocked): no "new chat" control, send posts into the shared conversation id and refreshes, setup-in-progress empty state, previous-profile search labelling. Server side: `tests/ai-growth-partner-conversation.test.ts`, `tests/workforce-chat-business-brain-e2e.test.ts` (not read in depth). NOT covered: the SSE streaming branch, stream error/disconnect, send failure rollback, load-older, failed/cancelled message badges.
- **Real or simulated behavior:** Real thread storage, send API and search; UI tests stub fetch and mock server actions; model reply text only evidenced with synthetic fixtures.
- **Missing dependencies:** none for the UI work; live model replies need the Hermes runtime (external).
- **Remaining work:** No auto-refresh (component has no effects; poll loop lacks unmount guard); add role=log/aria-live and scroll-to-latest; render workJobId and evidence ledger as links to /work and /approvals; add Stop/Retry for streaming/failed/cancelled; use 16px Textarea primitive for the composer; check AQi launcher overlap on /growth-partner/conversation; add UI tests for SSE path, send failure rollback, load-older. | Skeptic adds: Keep the clientMessageId across a retry of the same unsent text (store it with the restored input) so the server dedupe actually applies; test the network-failure path.
- **Verification evidence:** own reading of component and test; the docs' recorded runs (implementation-status.md, permanent chat acceptance) are prior claims.
  - *Skeptic review: Row stays PARTIAL. One additional risk beyond the auditor's list: on a fetch network error the UI deletes the optimistic message and restores the text (L206-211), but the server may already have stored it; the server dedupes on (conversation_id, client_message_id) (service.ts:2691-2700, migration 0002 unique), yet the retry generates a NEW crypto.randomUUID() (L175), so a retry after an ambiguous network failure can post a duplicate user message and start a second run. Plausible, not reproduced. Server-side tenancy and idempotency otherwise sound (agents.use gate, assertSameOrigin, uuid-validated conversationId).*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** New messages appear without reload and are announced; action messages link to their work item/approval; failed streams can be retried; phone-width browser run shows composer uncovered and no zoom.

<a id="gp-portal-04"></a>
### GP-PORTAL-04 — Control Center composition and in-page navigation

- **Requirement:** Control Center composition and in-page navigation (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/growth-partner/control-center.tsx`, `src/app/(portal)/growth-partner/page.tsx`
- **Test coverage:** `tests/growth-partner-capability-readiness-ui.test.tsx` and `tests/growth-partner-control-center-states.test.tsx` render the real component; the latter covers connection health states, active/draft/absent Brain, pause and previous-profile states, migration review, permission-filtered shortcuts, unavailable-section retries, and the real memory and goals panels. `tests/growth-partner-page-access.test.tsx` covers the page's early no-access guard and failed optional reads.
- **Real or simulated behavior:** Data is read from tenant-scoped services. The Control Center tests render the real component and memory/goals/legacy-knowledge panels; the page tests mock data services to exercise access and failure handling.
- **Missing dependencies:** none.
- **Remaining work:** Add the Reports card, approvals queue summary, calendar preview and integrations strip; add sticky section navigation; expand keyboard and visual browser QA.
- **Verification evidence:** W1-05 focused run passed 5 files / 18 tests; targeted ESLint and `npx tsc --noEmit -p tsconfig.clean.json` passed. Optional page reads fall back to individual retry panels, and the viewer guard runs before partner service calls. No full suite, browser or production check was run.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every directive area is visible or one click from /growth-partner; each component state is rendered by a test; section navigation works by keyboard.

<a id="gp-portal-05"></a>
### GP-PORTAL-05 — Business Brain view, edit and apply

- **Requirement:** Business Brain view, edit and apply (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/growth-partner/control-center.tsx`, `src/components/growth-partner/brain-fact-editor.tsx`, `src/components/growth-partner/brain-draft-review.tsx`, `src/app/actions/ai-growth-partner.ts`, `src/server/ai-growth-partner/service.ts`
- **Test coverage:** `tests/growth-partner-business-brain-draft-review.test.tsx` (dialog and action wiring, action mocked); `tests/ai-growth-partner-foundation.test.ts` and `tests/ai-growth-partner-unified-context-e2e.test.ts` (service level; real database path). No test renders `BrainSnapshot`, `BrainFactEditor`, history or the "Prepare draft" empty state.
- **Real or simulated behavior:** Real versioned database service; UI tests mock the actions, service tests run the real path; no test renders BrainSnapshot, fact editor or history.
- **Missing dependencies:** none.
- **Remaining work:** Per-fact Confirm/Mark unknown for draft_suggestion facts (today only edit-and-resave confirms); show all provenance sources not just the first; draft-vs-active diff; UI tests for snapshot, edit with stale baseVersion, history, empty state. | Skeptic adds: Add a UI test that a draft containing draft_suggestion facts, once applied, still shows them as 'Draft suggestion' (not confirmed) in BrainSnapshot; state in the apply dialog that unconfirmed suggestions are not used by the partner.
- **Verification evidence:** own reading. Prior docs: Business Brain review/activation increment (implementation-status.md L74) cites focused tests passing; not re-run.
  - *Skeptic review: Auditor left open what activation does with unreviewed draft_suggestion facts. Re-traced: activation only moves current_version (service.ts:689-695) and does not check suggestions, BUT the runtime retrieval path filters to verified/client_confirmed facts only, so an applied suggestion never reaches the model as a fact. This is enforced in the library and tested (foundation test L139-151). The per-fact Confirm/Reject item is therefore a UX/clarity gap, not a correctness risk; keep IMPLEMENTED_UNVERIFIED, lower the weight of 'activation must require no unreviewed suggestions'. Server enforcement is real (agents.configure gate L574/L660, baseVersion conflict L591, expectedCurrentVersion conflict L674, 'for update' row lock, audit rows).*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Facts show state, source, date; suggestions can be confirmed or rejected individually; activation consequence is explicit; tests render each Brain state with real fixtures.

<a id="gp-portal-06"></a>
### GP-PORTAL-06 — Growth goals panel

- **Requirement:** Growth goals panel (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/growth-partner/goals-panel.tsx`, `src/server/ai-growth-partner/goals.ts`, `src/lib/ai-growth-partner-goals.ts`, `src/app/actions/ai-growth-partner.ts`
- **Test coverage:** `tests/growth-partner-goals-panel.test.tsx` (3 tests, actions mocked: progress display, save with revision + refresh, read-only for non-managers); `tests/ai-growth-partner-goals.test.ts` (service level). Does not cover a save error, a paused goal, or the unsupported-access branch.
- **Real or simulated behavior:** Real progress computed from recorded workspace activity; UI tests mock actions, service tests exercise the real path.
- **Missing dependencies:** none.
- **Remaining work:** Surface the top goal on Overview or Control Center status cards; test save-error and paused states.
- **Verification evidence:** W1-05 replaces the raw number field with the shared 16px Input primitive. Focused goal UI test passes as part of the 18-test W1-05 run; service-level tests remain as previously recorded.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Goals can be created, paused, resumed and read at phone width without zoom; error and paused states tested.

<a id="gp-portal-07"></a>
### GP-PORTAL-07 — Capability access view (six domains, 14 capabilities)

- **Requirement:** Capability access view (six domains, 14 capabilities) (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/growth-partner/control-center.tsx`, `src/lib/ai-growth-partner-capability-access.ts`, `src/server/ai-growth-partner/capability-access.ts`, `src/lib/workforce-capabilities.ts`
- **Test coverage:** `tests/ai-growth-partner-capability-access.test.ts` (pure derive function, grouping, states; no database), `tests/growth-partner-capability-readiness-ui.test.tsx` (real component; asserts the sales domain, "Your access needed", disclaimer text, and that internal terms such as "runtime" are absent).
- **Real or simulated behavior:** Real derivation from permissions, saved allowed actions and health; tests cover the pure derive function and a real component render, not the DB-backed loader.
- **Missing dependencies:** none.
- **Remaining work:** 'Ready to request' offers no way to request: link each capability to Work Board start-review or a prefilled conversation prompt; explain blocked state with next step; add loader-to-UI integration test with a real tenant.
- **Verification evidence:** own reading; no run by me. Prior docs claim 54/54 focused tests (implementation-status.md L90).
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Each capability card tells the member what to do next and the link works; loader-to-UI integration is tested.

<a id="gp-portal-08"></a>
### GP-PORTAL-08 — Integrations and connection states

- **Requirement:** Integrations and connection states (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/settings/integrations/page.tsx`, `src/lib/integrations/client-tools.ts`, `src/lib/integrations/growth-partner-runtime-summary.ts`, `src/components/growth-partner/control-center.tsx`
- **Test coverage:** `tests/client-integrations.test.ts` (pure card builder), `tests/growth-partner-runtime-summary.test.ts` (pure summary), and W1-05 Control Center tests cover unlinked, paused, unhealthy, setup, healthy and unchecked partner states. No Integrations page render test; no test that Control Center and Integrations agree.
- **Real or simulated behavior:** Integrations page reads real integration_status, CRM and readiness tables; the Control Center now derives its label and tone from runtimeEnabled, runtimeStatus and runtimeHealthOk. No live provider evidence.
- **Missing dependencies:** provider credentials for any live provider check (external; states render without them).
- **Remaining work:** Derive the Control Center card and Integrations runtime row from one shared function; add an integrations strip; add Integrations page render tests and decide coverage for calendar/email/website/social connections. Live provider evidence still needs configuration.
- **Verification evidence:** own reading. Page shows tone + icon + label + "Checked X ago" + request-connection button per state (good); no live provider evidence.
  - *Skeptic review: Auditor is right that 'Partner connection: Connected' is weak, but understated: the control state ALREADY carries runtimeEnabled, runtimeStatus and runtimeHealthOk (fetched in the same query) and the component ignores all three, rendering a success-toned 'Connected' for any linked runtime id, including a disabled one or one whose last health check failed. The only UI test asserts the label text exists, not its value. This is a status shown green without the available check.*
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** One source of truth for partner connection state; each integration row has a distinct labelled state with last-checked time; page test covers every state.

<a id="gp-portal-09"></a>
### GP-PORTAL-09 — AI Work Board

- **Requirement:** AI Work Board (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/work/page.tsx`, `src/components/work/work-board.tsx`, `src/components/work/work-board-kanban.tsx`, `src/components/work/job-progress.tsx`, `src/server/workforce/work-board.ts`, `src/server/workforce/schedules.ts`, `src/server/workforce/triggers.ts`
- **Test coverage:** `tests/work-board-ui.test.tsx` (about 12 tests: statuses, lease expiry, start review, pause/save/edit schedule, triggers; actions mocked) and `tests/work-board-kanban.test.tsx` (4 tests: single partner identity, lane truthfulness, prepared-not-completed lane, filters); `tests/workforce-proactive-review.test.ts`, `tests/workforce-schedules.test.ts` (database-backed, tenant visibility and summary counts).
- **Real or simulated behavior:** Real ai_work_jobs, schedules and triggers with evidence-based lanes; UI tests mock actions, service tests are database-backed.
- **Missing dependencies:** operator switches for schedules/triggers are off by default (external/ops decision); the board states this honestly.
- **Remaining work:** Page-level test for /work; resolve naming; confirm ten-lane Kanban usability at 375px in a browser; verify job-list pagination beyond server limit; link jobs to their conversation message. | Skeptic adds: Show a truncation notice or paginate when 100 rows are returned; make the attention filter and metric use one definition; decide what a completed job with no evidence class should display (not the green lane).
- **Verification evidence:** own reading; scroll region has `role="region" tabIndex=0` and an accessible name (kanban L343). Prior docs: acceptance claims recorded; not re-run.
  - *Skeptic review: Two checks the auditor left unverified. (a) listWorkBoardJobs has a hard 'limit 100' with no pagination and the UI has no 'showing latest 100' notice, while the metric cards come from workBoardSummary which counts ALL rows, so counts and visible rows can silently disagree for busy workspaces. (b) The 'Needs attention' metric (summary.needsAttention) excludes waiting_for_approval, but the 'attention' filter includes it, so clicking the card's filter shows more rows than the number. (c) Lane hint says 'Saved execution evidence' for Completed, but workJobEvidence returns null for a completed job whose capability definition is unknown, and jobLane then puts it in the green Completed lane with no chip. Core 'no job completed without evidence' claim holds for the known-capability path only.*
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Board and Control Center counts agree; phone/tablet browser run reaches all lanes; no job shows completed without execution evidence (already tested).

<a id="gp-portal-10"></a>
### GP-PORTAL-10 — Schedules and Workforce Calendar

- **Requirement:** Schedules and Workforce Calendar (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/work/calendar/page.tsx`, `src/components/work/workforce-calendar.tsx`, `src/server/workforce/calendar.ts`, `src/lib/workforce-calendar-view.ts`, `src/lib/workforce-schedule-recurrence.ts`
- **Test coverage:** `tests/workforce-calendar.test.ts` (database-backed, real service), `tests/workforce-calendar-route.test.ts`, `tests/workforce-calendar-view.test.ts`, `tests/workforce-calendar-ui.test.tsx` (3 tests: future occurrence vs job, filter by identity, canonical partner name). Not covered: refresh error/retry banner, empty period, view switching, keyboard operation.
- **Real or simulated behavior:** Real database service merging recorded jobs and projected schedule occurrences; UI tests render the component with props.
- **Missing dependencies:** none.
- **Remaining work:** Default to agenda view below sm (month grid is 7 columns with 104px cells on phones); verify week view's 800px min-width on tablet; fix title mismatch; tests for refresh error/retry and empty period; browser QA at 390/768/1024.
- **Verification evidence:** own reading; accessible markup is good (grouped days with item counts, `aria-pressed`, `role="alert"`, live "Updating calendar" status).
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Phone default is a usable agenda; browser run at three widths shows no horizontal page overflow; retry and empty states tested.

<a id="gp-portal-11"></a>
### GP-PORTAL-11 — Memory and knowledge

- **Requirement:** Memory and knowledge (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/growth-partner/memory-panel.tsx`, `src/components/growth-partner/legacy-knowledge-review.tsx`, `src/components/knowledge/knowledge-center.tsx`, `src/app/(portal)/knowledge/page.tsx`, `src/server/ai-growth-partner/memory.ts`, `src/server/ai-growth-partner/legacy-knowledge.ts`
- **Test coverage:** `tests/growth-partner-memory-panel.test.tsx` (2 tests, actions mocked), `tests/ai-growth-partner-memory.test.ts` (service), `tests/growth-partner-legacy-knowledge-review.test.tsx`, `tests/ai-growth-partner-legacy-knowledge.test.ts`, `tests/knowledge-history-ui.test.tsx`. In the Control Center test the memory and legacy-knowledge panels are mocked out.
- **Real or simulated behavior:** Real app-owned memory, Knowledge Center and reviewed legacy knowledge import; UI tests mock actions; Control Center test mocks the panels.
- **Missing dependencies:** none.
- **Remaining work:** Verify memory list search and limits.
- **Verification evidence:** W1-05 adds the relationship explanation, Knowledge Center link, and integrated Control Center test with the real memory panel. The 18-test focused run and targeted typecheck/ESLint passed; no memory search/limit test was added.
  - *Skeptic review: Auditor's 'real' classification is correct and slightly under-credited: memory is tenant-scoped, revision-locked, deduped by content fingerprint, deletable, and actually injected into the runtime prompt (growthPartnerMemoryPromptContext, workforce/service.ts:923), so memory genuinely feeds the partner. Status IMPLEMENTED_UNVERIFIED stands (UI tests mock the actions; the Control Center test mocks the panel).*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Client can see, correct and delete memories and knowledge, understands which feeds the partner, and the integrated Control Center is tested with real panels.

<a id="gp-portal-12"></a>
### GP-PORTAL-12 — Approvals

- **Requirement:** Approvals (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/approvals/page.tsx`, `src/components/approvals/approval-center.tsx`, `src/server/approvals/service.ts`, `src/server/workforce/work-board.ts`, `src/components/growth-partner/control-center.tsx`
- **Test coverage:** `tests/approvals.test.ts`, `tests/approvals-downstream-status.test.ts` (database-backed decisions and downstream state), `tests/evidence-chip-ui.test.tsx` (renders `ApprovalCenter` read-only rows and chips). No test for the requester chip, the decide dialogs, or high-risk gating UI.
- **Real or simulated behavior:** Real approval_requests decisions and downstream status; no UI test of requester chip or decide dialogs.
- **Missing dependencies:** none.
- **Remaining work:** Fix 'System' requester for growth_partner approvals; Control Center 'Waiting for approval' counts ai_work_jobs while sidebar/Approvals count approval_requests: show approval-request count plus top pending list in the Control Center; component tests for approve/reject/request-changes and blocked high-risk path.
- **Verification evidence:** own reading; empty states and risk/expiry chips are present.
  - *Skeptic review: Confirmed, no status change. The 'System' requester claim is correct (approval-center.tsx:106-124 only maps AGENT_ROLE_KEYS; growth_partner is not in that list, service L384 returns role_key). Server enforcement is solid and DB-backed, so the 'real path' rating is fair: decideApproval is permission-gated, org-scoped, status-guarded (single pending->decided update, 'already decided' conflict), high-risk owner gate, audited.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Control Center, sidebar and Approvals page show the same pending count; a pending approval is reviewable from the Control Center; attribution says AI Growth Partner.

<a id="gp-portal-13"></a>
### GP-PORTAL-13 — Reports

- **Requirement:** Reports (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** awaiting-configuration  |  **Unblocked now:** yes
- **Source files:** `src/components/work/proactive-reports.tsx`, `src/server/workforce/reports.ts`, `src/app/(portal)/work/page.tsx`, `src/app/(portal)/analytics/page.tsx`, `src/components/growth-partner/control-center.tsx`
- **Test coverage:** `tests/work-board-ui.test.tsx` (3 report tests: honest monitoring state + acknowledge action, single-identity coverage, no continuous-monitoring implication, failed review); `tests/workforce-proactive-review.test.ts`, `tests/workforce-proactive-delivery.test.ts` (database-backed).
- **Real or simulated behavior:** Real verified reports from completed jobs; UI honestly reports monitoring off when no schedule runs. Reports exist only inside the Work Board page.
- **Missing dependencies:** monitoring only produces reports once an owner enables a schedule AND the operator switch is on (external ops decision).
- **Remaining work:** Add a Latest reports card to the Control Center (three newest verified reports, acknowledge state, link to /work?report=); decide relation of Analytics, CRM reports and Performance Snapshot; page-level test.
- **Verification evidence:** own reading.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A member finds the latest verified report from the Control Center in one click and sees whether monitoring is running.

<a id="gp-portal-14"></a>
### GP-PORTAL-14 — Suggestion vs completed-action distinction

- **Requirement:** Suggestion vs completed-action distinction (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/evidence-class.ts`, `src/components/chat/evidence-chip.tsx`, `src/components/growth-partner/permanent-conversation.tsx`, `src/components/work/work-board-kanban.tsx`, `src/components/work/job-progress.tsx`, `src/components/approvals/approval-center.tsx`
- **Test coverage:** `tests/evidence-class.test.ts` (31 tests, pure classification and drift guards), `tests/evidence-chip-ui.test.tsx` (12 tests, chat/approvals chips), `tests/work-board-kanban.test.tsx` (prepared work not in Completed). Pure functions plus component renders; no end-to-end test that a real conversation turn produces the marker the chip shows.
- **Real or simulated behavior:** Real stored classification (six evidence classes) displayed in chat, Work Board and Approvals; tests are pure-function and component renders, no end-to-end turn-to-chip test.
- **Missing dependencies:** none.
- **Remaining work:** Make chips link to their ledger row; document one client-facing glossary aligning 'Ready to request' and 'Draft suggestion' wording with the six classes; confirm outcome pill always present when approved_write shows no chip; add an integration test (send message in PGlite, assert marker and chip).
- **Verification evidence:** own reading. This is the strongest-tested portal quality bar; I did not re-run the tests.
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every AI-authored line, job and approval shows exactly one of the six labels with a link to its ledger row and a glossary explains them.

<a id="gp-portal-15"></a>
### GP-PORTAL-15 — Activity logs

- **Requirement:** Activity logs (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/activity/page.tsx`, `src/lib/activity.ts`, `src/app/(portal)/overview/page.tsx`, `src/server/ai-growth-partner/service.ts`
- **Test coverage:** `tests/evidence-class.test.ts` L419-426 only tests the fallback string and a few labels. No Activity page test.
- **Real or simulated behavior:** Real audit_logs and agent_runs reads; 20+ ai_growth_partner.* actions have no friendly label so raw text such as 'ai growth partner business brain activated' is shown.
- **Missing dependencies:** none.
- **Remaining work:** Add labels in src/lib/activity.ts for every ai_growth_partner.* action plus a test that every emitted audit action has a label; paginate/filter (150 audit and 60 run limits); add recent partner activity to the Control Center and link rows to target records; page-level test.
- **Verification evidence:** own `grep` found no `growth` string in `src/lib/activity.ts`.
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Every partner action reads as a sentence; log is filterable and paginated; a test fails when a new audit action lacks a label.

<a id="gp-portal-16"></a>
### GP-PORTAL-16 — Onboarding and setup progress

- **Requirement:** Onboarding and setup progress (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/setup/page.tsx`, `src/components/setup/setup-center.tsx`, `src/components/setup/launch-readiness-panel.tsx`, `src/components/onboarding/adaptive-onboarding.tsx`, `src/components/onboarding/onboarding-progress.tsx`, `src/components/onboarding/review-panel.tsx`, `src/lib/onboarding/engine.ts`
- **Test coverage:** `tests/onboarding-ui.test.tsx` (636 lines), `tests/client-onboarding-ui.test.tsx`, `tests/client-onboarding-acceptance.test.ts`, `tests/onboarding-status-wording.test.ts`, `tests/shell-launch-percent.test.ts`. Browser QA scripts `scripts/onboarding-browser-qa.mjs` and `scripts/wave2-onboarding-qa.mjs` contain no Growth Partner reference (grep), i.e. they pre-date the unified model.
- **Real or simulated behavior:** Real answers, live checklist stream and launch readiness; onboarding browser QA scripts contain no Growth Partner path.
- **Missing dependencies:** none.
- **Remaining work:** setup/page.tsx L35 uses planScope(enabled legacy roles) instead of onboardingScope(roles, workforceModel) so saved-question counts can differ from the wizard; replace hasGrowthPartner title string match in setup-center.tsx with a typed flag; remove six-role provisioning query; re-run onboarding browser QA with a Growth Partner workspace. | Skeptic adds: Replace planScope with onboardingScope(enabledRoles, workforceModel) at workforce.ts:101 and employee-sync.ts:551,591 and setup/page.tsx:35; add a test with a growth_partner workspace that has one legacy role enabled.
- **Verification evidence:** own reading.
  - *Skeptic review: The scope inconsistency is wider than the one line the auditor cited. onboardingScope (workforce-model aware) is used by the wizard and submit, but planScope(enabled legacy roles) is still used by three downstream consumers: regenerate-preferences action, knowledge seeding after submit sync, and the launch sweep sync. In a Growth Partner workspace that still has some legacy role enabled, answers to the three role-gated questions (b.lead_target, b.qualification, d.handoff_requirements) are asked by the wizard but dropped from confirmedAnswers there. Narrow (3 questions, needs a partially enabled legacy set) but it is a data-loss path, not just a progress-count mismatch.*
  - *Baseline: 5 of 5 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Saved-question counts match the wizard; no role-based logic on Setup; browser QA covers the Growth Partner path at phone and desktop.

<a id="gp-portal-17"></a>
### GP-PORTAL-17 — Loading, error and empty states

- **Requirement:** Loading, error and empty states (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/error.tsx`, `src/app/(portal)/error.tsx`, the portal-level loading state, and route-specific loading files for `/growth-partner`, `/work`, `/approvals`, `/activity` and `/knowledge`.
- **Test coverage:** `tests/portal-error-boundary.test.tsx` covers retry and generic error copy; `tests/growth-partner-page-access.test.tsx` covers the viewer no-access card and optional read failures. Browser error-boundary behavior is not exercised.
- **Real or simulated behavior:** The portal error boundary is inside the portal layout and uses Next.js `retry`; per-section read failures show a local refresh action. Route loading files provide accessible skeletons. No browser check was run.
- **Missing dependencies:** none.
- **Remaining work:** Add a portal-chrome not-found page; empty states for Reports/Activity; browser-level checks for boundary behavior. `/growth-partner/conversation` access handling is tracked separately.
- **Verification evidence:** W1-05 read the installed Next.js `error.md` and `loading.md` guidance. Five focused files / 18 tests passed, plus targeted ESLint and TypeScript. No browser or full-suite run.
  - *Skeptic review: Mostly confirmed. Additional concrete throw path: getGrowthPartnerControlState and getGrowthPartnerCapabilityAccess both throw AppError('forbidden') when the member lacks agents.use, and page.tsx calls them unguarded. The viewer role is excluded from agents.use, so a viewer who opens /growth-partner by URL lands on the root 'Something went wrong' page (outside the portal chrome) instead of a permission message. Also small overstatement: a root src/app/not-found.tsx exists, so 'add not-found handling' means a portal-chrome version, not a missing handler.*
- **Definition of done:** Forcing an error in any Control Center query shows an in-shell error card with retry; each major route has a matching skeleton; tests render these boundaries.

<a id="gp-portal-18"></a>
### GP-PORTAL-18 — Tablet and mobile layout

- **Requirement:** Tablet and mobile layout (directive §17)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/shell/portal-shell.tsx`, `src/components/shell/sidebar.tsx`, `src/components/growth-partner/control-center.tsx`, `src/components/work/work-board-kanban.tsx`, `src/components/work/workforce-calendar.tsx`, `scripts/workforce-browser-qa.mjs`
- **Test coverage:** AUTOMATED: `tests/scroll-strip-guard.test.ts` and `tests/type-scale-floor.test.ts` (static source guards: no text under 12 px, strips contained). `tests/demo-mobile-layout.test.tsx` asserts class names for the DEMO showroom only, not the portal. BROWSER (manual-run harnesses): `scripts/workforce-browser-qa.mjs` (390x844 for `/employees`, `/chat/*` legacy only), `scripts/demo-responsive-qa.mjs` (demo), `scripts/crm-browser-qa.mjs`. NOTHING automated or scripted visits `/growth-partner`, `/growth-partner/conversation`, `/work`, `/work/calendar`, `/approvals`, `/activity` or `/settings/integrations` at any viewport.
- **Real or simulated behavior:** Real Tailwind CSS with a mobile drawer. Automated: static source guards only (demo-mobile-layout covers the demo, not the portal). Browser harnesses (manual-run) cover legacy /employees and /chat, demo, CRM; none visits /growth-partner, /growth-partner/conversation, /work, /work/calendar, /approvals, /activity or /settings/integrations.
- **Missing dependencies:** none.
- **Remaining work:** Create scripts/portal-browser-qa.mjs modeled on workforce-browser-qa.mjs: seeded Growth Partner workspace, seven routes at 390/768/1024/1440, overflow, touch-target and screenshot checks; fix known risks (calendar month grid on phone, 14px inputs, AQi launcher over composer); confirm tablet gets drawer by design; add a CI-runnable subset.
- **Verification evidence:** own grep of `scripts/` for the route paths and Growth Partner strings (none for the routes above).
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A recorded browser run at four widths shows no horizontal page overflow, no overlapped controls and reachable primary actions on the seven routes.

<a id="gp-portal-19"></a>
### GP-PORTAL-19 — Accessibility of portal controls

- **Requirement:** Accessibility of portal controls (directive §17)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/shell/portal-shell.tsx`, `src/components/shell/sidebar.tsx`, `src/components/growth-partner/permanent-conversation.tsx`, `src/components/work/workforce-calendar.tsx`, `src/components/approvals/approval-center.tsx`, `src/components/ui/overlays.tsx`
- **Test coverage:** AUTOMATED static/unit: `tests/aria-label-guard.test.ts` (no aria-label on role-less div/span), `tests/danger-button-contrast.test.ts`, `tests/notification-badge-a11y.test.tsx`, plus role/name queries inside component tests (Testing Library). AXE runs only inside browser QA scripts (`scripts/workforce-browser-qa.mjs` L112 loads axe-core; `scripts/studio-a11y-qa.mjs`, `scripts/wave2-*.mjs`); none targets the Control Center, conversation, Work Board, calendar, approvals or activity routes. Manual only: keyboard-only walkthrough, screen-reader announcement, 200% zoom.
- **Real or simulated behavior:** Real markup with sound practices (skip link, aria-current, labelled regions, aria-pressed, role alert/status). Automated: static guards and Testing Library role queries. Axe exists only in browser QA scripts that do not visit these routes; keyboard-only, screen reader and zoom checks are manual only.
- **Missing dependencies:** none.
- **Remaining work:** Run axe on the seven routes in the new portal browser QA; add role=log/live region to conversation; fix duplicate landmark naming (Primary navigation aside wrapping nav Main, repeated in drawer); contrast check of 12px badges in light and dark; keyboard tests for calendar grid and Kanban. | Skeptic adds: When adding portal-browser-qa, reuse runAxe from chat-navigation-qa.mjs and re-run it on /growth-partner so the shared sidebar is checked in its Growth Partner state.
- **Verification evidence:** own reading; the aria-label guard was read and does what it says.
  - *Skeptic review: Small overstatement: 'no automated axe on portal routes' is true for the Control Center and the seven routes, but scripts/chat-navigation-qa.mjs does run axe-core (wcag2a/aa, 21aa) against the shared sidebar nav (nav.workspace-nav) after visiting /employees and /chat; it is a manual-run browser script, not CI, and covers only the shell nav, not page content. So the sidebar/landmark half has browser axe evidence; the page half has none.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** axe reports zero serious/critical violations on the seven routes in light and dark; keyboard-only run completes send-message, approve, start review and edit-fact flows.

### Requirements the skeptic found missing from this section (to be triaged)

- {"title": "Graceful no-access state on /growth-partner for members without agents.use (viewer role)", "directiveRef": "§17 reliable loading and error states", "priority": "P2", "status": "PARTIAL", "remainingWork": "Pages call services that throw forbidden for the viewer role; the user sees the generic root error page. Add an explicit permission check and a no-access card in /growth-partner and /growth-partner/conversation, with a test."}
- {"title": "Work Board silent 100-job cap and attention-count mismatch", "directiveRef": "§17 AI Work Board; clear distinction of states", "priority": "P2", "status": "PARTIAL", "remainingWork": "listWorkBoardJobs limits to 100 with no pagination or notice while metrics count all jobs; 'Needs attention' metric excludes waiting_for_approval but the filter includes it. Add truncation notice or paging and one shared attention definition, with a database-backed test above 100 rows."}
- {"title": "Control Center 'Partner connection' shows green without using available health fields", "directiveRef": "§17 clear integration states", "priority": "P1", "status": "PARTIAL", "remainingWork": "runtimeEnabled/runtimeStatus/runtimeHealthOk are already in the control state and unused. Derive the card from them and test enabled, disabled, unhealthy and unknown cases."}
- {"title": "Onboarding scope applied inconsistently downstream of the wizard (planScope vs onboardingScope)", "directiveRef": "§17 clear onboarding progress (data consistency)", "priority": "P2", "status": "PARTIAL", "remainingWork": "Use onboardingScope in actions/workforce.ts:101, onboarding/employee-sync.ts:551,591 and setup/page.tsx:35 so answers the wizard asked are not dropped from preference regeneration and knowledge sync in Growth Partner workspaces with a legacy role still enabled."}
- {"title": "Retry after ambiguous network failure can duplicate a conversation message", "directiveRef": "§17 permanent conversation; reliable error states", "priority": "P2", "status": "PARTIAL", "remainingWork": "Persist clientMessageId with the restored draft text so a retried send hits the server's (conversation_id, client_message_id) unique dedupe; add a UI test for the network-failure then resend path."}
