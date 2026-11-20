# TERMC — Client-facing terminology and information architecture

Detail for the [Master Completion Tracker](../MASTER_COMPLETION_TRACKER.md). As of commit `6e4a4b7ecbe3d7b0a3a2a41b591cc43d0d59aee9`.

**Domain summary (read-only audit of worktree gp-completion, HEAD 6e4a4b7e; all file:line references are to that tree).**

- The previous team did real work: the client sidebar has one "AI Growth Partner" entry; `/chat/[slug]` and `/employees` redirect clients to `/growth-partner/conversation` and `/growth-partner`; legacy role records are labelled "Previous role profiles" and gated by `hasEnabledLegacyProfile`; setup copy has a presentation shim (`src/lib/setup-copy.ts`) plus migration 0124 for Growth Partner-specific checklist text; Requests Center, Leads, Automation Studio client pages, Settings and Auth copy are almost entirely Growth Partner wording.
- Nothing in the audited tree is a role-selection UI reachable by a client in a Growth Partner workspace. The remaining per-role UI is either agency-only (`chat-rail.tsx` specialists list, `/admin/employees`) or appears only while a workspace still has legacy rows (Overview card, Inbox "AI handler", CRM workflow "Send as" and "AI profile" selectors, Analytics bars, Work Board role chips).
- The biggest terminology gaps are not in the portal chrome but in server-built strings that reach Growth Partner clients: roughly 150 user-visible "AI employee / This employee / Appointment Setter / Lead Hunter" strings in `src/server/chat`, `messaging`, `automation`, `crm`, `calendars`, `appointments`, `offboarding` and `integrations/hermes`. The permanent Growth Partner conversation runs through `src/server/chat/service.ts`, so its failure text ("Your AI employee couldn't finish this request", `service.ts:3442`) and approval notification ("An AI employee is waiting for approval", `service.ts:3760`) are legacy wording shown to Growth Partner clients.
- Two real defects found: (1) Analytics "AI work activity" bars iterate `AGENT_ROLES` only (`analytics-view.tsx:266-282`), so Growth Partner runs never appear in the per-identity breakdown and six legacy role names are shown to every client; (2) the Automation Builder's LLM prompt lists only the six legacy roles as "AI employees" (`builder/catalog.ts:91-93`, `prompt.ts:84,137-139`) and never mentions `growth_partner`.
- Of the twelve required final-vocabulary terms, AI Growth Partner, Business Brain, Integrations, Goals, Permanent Conversation, Capability Access, Workforce Calendar, Growth Partner Settings, Activity and Approvals, and Memory and Knowledge now appear in the Control Center or related page copy. Remaining adoption work includes the shell, Analytics, conversation metadata, AQi/help and server-built strings; the shared navigation still has several older labels.
- Test coverage is thin for this domain: `tests/workforce-navigation.test.tsx` renders the real Sidebar and checks link gating; `tests/shell-titles.test.ts` reads sidebar source for titles; `tests/client-legacy-chat-redirect.test.ts` proves the redirect (services mocked). There is no test that scans client-facing code or rendered output for legacy names, and `tests/overview-growth-partner-navigation.test.tsx` tests `TeamGrid`, a component that is not mounted anywhere. I did not run any tests.
- Never rename identifiers: role keys (`lead_hunter`...), `/employees` and `/chat/[slug]` route slugs, audit event types (`workforce.*`, `agent.*`), notification `kind` values, setup step keys (`ai_employees`), support category keys (`ai_employees`, `change_ai_employee`), AQi target ids (`overview.ai-team`, `nav.workforce`) and DB columns stay as they are; only visible text changes.

Classification codes used in the hit table: **CFL** = CUSTOMER_FACING_LEGACY (must fix), **LAO** = LEGACY_ADMIN_OK (retained legacy record view labelled as previous profile), **IID** = INTERNAL_IDENTIFIER_OK, **AIO** = AGENCY_INTERNAL_OK (iAcquire's own internal operations assistant and admin surfaces).

---

### Portal navigation and shell
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 1 | `components/shell/sidebar.tsx:123` | "Work Board" | CFL | -> "AI Work Board" |
| 2 | `sidebar.tsx:124` | "Schedules & Calendar" | CFL | -> "Workforce Calendar" |
| 3 | `sidebar.tsx:26-31` | "Analytics", "Approvals", "Knowledge Center", "Activity" | CFL (vocabulary) | relabel/merge per GP-TERMC-02 |
| 4 | `sidebar.tsx:65,121` | "Previous role profiles" (legacyOnly + enabled gate) | LAO | keep |
| 5 | `sidebar.tsx:65` | `CLIENT_NAV` lacks `/work`, `/work/calendar` | CFL (IA) | add |
| 6 | `shell/topbar.tsx:72` | palette ignores crmMode, lists "Sales Pipeline" and "Pipelines", "Appointments" and "Calendar" | CFL (IA) | filter like sidebar |
| 7 | `topbar.tsx:64-65` | "Ask iAcquire Operations" (agency) / "My AI Growth Partner" (client) | AIO / ok | keep |
| 8 | `shell/titles.ts:10-11` | "Configure role profile", "Previous role profiles" | LAO | keep |
| 9 | `titles.ts:19` | "/approvals" -> "Approval Center" (nav "Approvals") | CFL (consistency) | align |
| 10 | `titles.ts:44` | `/work` -> "AI Work Board"; no `/work/calendar` entry | CFL | add calendar title |
| 11 | `lib/chat-navigation.ts:30` | "previous role profiles" / "iAcquire internal profiles" | LAO / AIO | client branch dead |
| 12 | `app/(chat)/chat/loading.tsx` | six skeleton rail rows; comment "AI employee" | AIO | cosmetic |
| 13 | `lib/aqi/routes.ts:18,22`, `lib/aqi/targets.ts:43,108-118,202`, `components/aqi/tutorial/tutorial-stage.tsx:658` | "Previous role profiles", "Previous employee chats" | LAO | keep (docs claim "Previous employee profiles", see doc claims) |
| 14 | `lib/aqi/targets.ts:63`, `tutorials.ts:275` | target `overview.ai-team` labelled "AI Growth Partner" | IID id, text mismatch with card | fix card (row 15) |

### Overview, analytics, dashboard
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 15 | `(portal)/overview/page.tsx:171-203` | "Previous role profiles" card with six role avatars and `agentIdentityLabel` (e.g. "Zeng · Operations Manager"), shown whenever legacy rows exist | CFL | gate on enabled; no avatars |
| 16 | `overview/page.tsx` (tiles array, `aiActivity` key, about line 80) | tile "AI tasks completed": "AI Growth Partner and retained role-profile runs" | LAO | keep |
| 17 | `components/overview/overview-panels.tsx:96-125` | `TeamGrid` with role names and taglines (unmounted) | CFL if mounted | delete + retarget test |
| 18 | `components/analytics/analytics-view.tsx:266-282` | bars per `AGENT_ROLES` (six role names), no growth_partner | CFL + defect | partner + previous group |
| 19 | `analytics-view.tsx:286-287` | "reported by Hermes" | CFL (vendor) | "AI runtime" |
| 20 | `analytics-view.tsx:108,47-53` | eyebrow "Performance intelligence"; "Ask AI Growth Partner" link | vocabulary / ok | "Performance Reporting" |
| 21 | `server/queries/dashboard.ts:213-274` | "Retained profile conversation started", "Review your retained profiles" (legacy branch) | LAO | keep |
| 22 | `server/queries/dashboard.ts:242` | `${workforceRoleShortName(role)} is unavailable` | ok for partner | keep |

### Growth Partner control center
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 23 | `components/growth-partner/control-center.tsx:374,466` | "six connected capabilities", "One partner, six capabilities" | CFL (echo) | "Capability Access", no count |
| 24 | `control-center.tsx:92` | "Partner preferences" -> `/settings/ai` | CFL (vocabulary) | "Growth Partner Settings" |
| 25 | `control-center.tsx:90-91,100` | "Work Board", "Schedules & calendar", "Activity" | CFL (vocabulary) | relabel |
| 26 | `control-center.tsx:357-359,597,608,109,342` | "previous profiles / role profiles" | LAO | keep |
| 27 | `control-center.tsx:407`, `memory-panel.tsx:121`, `goals-panel.tsx:107` | "Permanent conversation", "Partner memory", "Growth goals" | vocabulary | capitalise / rename |
| 28 | `server/chat/service.ts:932,1180,1195,1197` | "Partner Settings" | CFL | "Growth Partner Settings" |

### Onboarding and setup
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 29 | `lib/setup-copy.ts:21-98` | legacy keys ("Your AI team is ready", "Six client-specific Hermes AI employees configured", ...) | IID | keep (match keys) |
| 30 | `supabase/migrations/0008_setup_center.sql:316`, `0013` | seeded old copy | IID | keep |
| 31 | `server/setup/transition.ts:153` | raw `task.completion_notice` in notification | CFL (path bypasses shim) | pass via `currentSetupCopy` |
| 32 | `lib/launch-readiness.ts:1009-1085` | per-role items (`meta.shortName`), step "Retained profile setup" | LAO | keep |
| 33 | `server/setup/launch-readiness.ts:746` | "Appointment Setter books on its own" | CFL | "AI Growth Partner books appointments on its own" |
| 34 | `server/setup/connectors.ts:138,150`; `native-evidence.ts:575,584` | "AI employees passed a live health check" (non-partner branch) | LAO-ish | "retained profiles" |
| 35 | `server/setup/provisioning-contract.ts:71` | "Hermes AI employee profiles" | AIO | confirm not client-visible |
| 36 | `components/onboarding/review-panel.tsx:182,213,249,374,385` | "retained role profiles" | LAO | keep |
| 37 | `lib/onboarding/business-profile.ts:446,449` | "employee update(s) waiting...", "employee(s) were already set up" | CFL | "profile(s)" |
| 38 | `lib/onboarding/business-profile.ts:348-382` | "retained profile(s)" | LAO | keep |
| 39 | `lib/onboarding/crm-setup.ts:380,388` | "Existing profiles" -> `/employees` | LAO | keep |
| 40 | `components/setup/onboarded-banner.tsx:92-112` | "Previous role profiles preserved" | LAO | keep |
| 41 | `server/onboarding/employee-sync.ts:780-781,876-877` | "<Role> is no longer part of your plan" / "was added to your plan", link `/employees` | CFL | skip for partner workspaces |
| 42 | `server/onboarding/service.ts:721` | "N AI employee configuration(s) prepared." (legacy branch) | CFL | "retained profile" |
| 43 | `server/onboarding/employee-generator.ts:216` | prompt "six distinct AI employee roles" | IID (LLM prompt, legacy path) | keep |
| 44 | `lib/agents.ts:312` | "Hermes profile not connected" (client status line) | CFL (vendor) | "AI runtime not connected" |
| 45 | `lib/agents.ts:87,94,319` | taglines "Keeps your AI team coordinated", "your AI team prioritise" | LAO | keep |
| 46 | `lib/agents.ts:85-236,272` | role names, "Zeng" persona (`OPERATIONS_MANAGER_PERSONA`) | IID | keep (legacy defaults) |

### Auth and public
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 47 | `(auth)/login/page.tsx:28`, `get-started/page.tsx:11`, `invite/[token]/page.tsx:72` | "Open your AI Growth Partner...", "Meet your AI Growth Partner" | ok | none |
| 48 | `components/auth/showcase.tsx:21` | "Six connected capabilities" | CFL (echo) | drop count |
| 49 | `components/demo/landing-sections.tsx:105`, `lib/demo/showroom/content.ts:49` | "six coordinated capability areas" | CFL (echo) | drop count |
| 50 | `server/email-render.ts:61,490` | "See the AI team in action", "iAcquire's AI team works" | CFL | AI Growth Partner |

### Settings and team
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 51 | `components/settings/settings-nav.tsx:15` | "AI preferences" | CFL (vocabulary) | "Growth Partner Settings" |
| 52 | `lib/permissions.ts:359` | "works with the AI team" | CFL | AI Growth Partner |
| 53 | `lib/permissions.ts:266`, `components/crm/forms/after-editor.tsx:16`, `crm/recovery/recovery-settings.tsx:22` | human team role "Appointment Setter/setters" | IID (human role) | disambiguate label |
| 54 | `lib/storage-policy.ts:20` | "the AI employees read" | CFL | AI Growth Partner |
| 55 | `settings-forms.tsx:632` | "the employee's long-term memory scope" | CFL | AI Growth Partner |
| 56 | `settings-forms.tsx:548-550,653-654` | "retained profile(s)" | LAO | keep |
| 57 | `server/settings/service.ts:379` | "This employee could not be updated." | CFL | "profile" |

### Calendar
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 58 | `work/calendar/page.tsx:10`, `workforce-calendar.tsx:362-363,378` | "Schedules & Calendar", eyebrow "Work Board" | CFL (vocabulary) | "Workforce Calendar" |
| 59 | `workforce-calendar.tsx:408` | aria "Filter work by AI partner or existing role" | CFL | one partner + previous chip |
| 60 | `server/calendars/schedule.ts:265` | actor "AI employee" | CFL | AI Growth Partner |
| 61 | `server/calendars/agent-booking.ts:112`, `appointments/booking.ts:168` | "AI Employee Chat" | CFL | "AI Growth Partner conversation" |
| 62 | `agent-booking.ts:158`, `appointments/changes.ts:166` | actor "Appointment Setter" | CFL | AI Growth Partner |

### Leads, CRM, recovery
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 63 | `server/leads/research-contract.ts:135,138` | "The Lead Hunter's answer..." | CFL | AI Growth Partner |
| 64 | `server/leads/research-job.ts:278,451,514-568`, `leads/service.ts:90` | fallback "AI employee", "Hermes connection" | CFL | partner wording, no vendor |
| 65 | `lib/crm/blueprints/requirements.ts:65,67`; `views.ts:305` | "lead hunter AI employee", "AI employee memories" | CFL | AI Growth Partner |
| 66 | `components/crm/workflows/step-panel.tsx:676-681,865-872`, `editor-logic.ts:69,76-78,241`, `summaries.ts:327,383`, `server/crm/workflows/context.ts` | "Send as", "AI profile", "Ask <name>" role selectors | CFL (role picker) | partner default; label legacy |
| 67 | `server/crm/workflows/executors.ts:548,755-756` | "AI employee" dry-run text | CFL | AI Growth Partner |
| 68 | `server/crm/reports/{appointments.ts:11, deals.ts:8, export.ts:223, operations.ts:105}` | "AI employee", "Removed AI employee" | CFL | relabel |
| 69 | `components/crm/reports/sections.tsx:28` | provider "Hermes" | CFL (vendor) | "AI runtime" |
| 70 | `lib/missed-calls/state.ts:161`; `server/missed-calls/routing.ts:34` | "Handed to the Appointment Setter" | CFL | AI Growth Partner (key `appointment_setter` is IID) |
| 71 | `components/crm/agent-tools/ai-tools-screen.tsx:116,156-157,222,257` | "CRM access by AI identity"; partner branch handled | ok / LAO link | keep |

### AI Work Board
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 72 | `(portal)/work/page.tsx:12` | metadata "Work Board" | CFL (vocabulary) | "AI Work Board" |
| 73 | `components/work/work-board-kanban.tsx:82-94,167,207` | legacy role identity labels; `/chat/<slug>?c=` and `/employees/<slug>` links | LAO / CFL (links) | mark previous; fix links |
| 74 | `lib/workforce-chat-schedule-intent.ts:185` | research owner "Lead Hunter" for non-partner roles | LAO | keep |

### Chat
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 75 | `(chat)/chat/page.tsx:3-4` | redirect `/chat/operations-manager` | IID / AIO | redirect clients directly |
| 76 | `(chat)/chat/[slug]/page.tsx:15,25` | `AGENT_BY_SLUG` title; client redirect | AIO (clients redirected) | keep |
| 77 | `components/chat/chat-rail.tsx:141,234`, `chat-workspace.tsx:806-831` | "AI specialists", "View employee" (role picker) | AIO | agency only |
| 78 | `server/chat/service.ts:3437-3443` | FRIENDLY_FAILURE "AI employee ..." | CFL | partner wording |
| 79 | `service.ts:3760` | "An AI employee is waiting for approval." | CFL | AI Growth Partner |
| 80 | `service.ts:1729,2012,2429,2574,2834,3305` | "This employee's role can't...", "Your role can't chat with AI employees." | CFL | partner wording |
| 81 | `service.ts:2486,2592-2598,3339` | internal employee / Operations Manager gates | AIO | keep |
| 82 | `server/integrations/hermes/client.ts:592-838` | "This AI employee ...", "Hermes profile/credential" | CFL | partner wording, no vendor |

### Automation Studio
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 83 | `components/automation-studio/**`, `lib/automation-studio/{plan,starters,templates}.ts` | "AI Growth Partner ..." | ok | none |
| 84 | `server/automation-studio/builder/catalog.ts:91-93` | `employeeCatalog()` six legacy roles | CFL + defect | partner catalog |
| 85 | `builder/prompt.ts:84,110,137-139` | "AI employees in this workspace", "AI EMPLOYEES (roleKey values)" | CFL (LLM prompt) | partner wording |
| 86 | `server/automation-studio/templates.ts:73` | "that AI employee isn't in this workspace." | CFL | partner wording |

### Requests Center
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 87 | `lib/support/lifecycle.ts:53-56`, `change.ts:12,19` | keys `ai_employees`, `change_ai_employee`, `ai_employee` | IID | keep |
| 88 | `lifecycle.ts:72,86`, `change.ts:32` | labels "AI Growth Partner ..." | ok | none |
| 89 | `lib/support/suggest.ts:65` | regex with legacy names | IID | keep |

### Notifications, status, exports
| # | Location | Text | Class | Action |
|---|---|---|---|---|
| 90 | `server/workforce/service.ts:652` | link `/employees/` with blank slug for partner | CFL (defect) | `/growth-partner` |
| 91 | `server/workforce/proactive-review.ts:147` | "N AI employee(s) need attention" | CFL | partner wording |
| 92 | `server/workforce/readiness-facts.ts:140-141` | "its AI employees are paused" | CFL | partner wording |
| 93 | `server/workforce/health-alerts.ts:75-110` | uses role short name + partner link | ok | none |
| 94 | `server/messaging/{attention.ts:67, ingest.ts:253, send.ts:487, web-chat-send.ts:66, responder.ts:102-361, ai-control.ts:53,88,99, handoff.ts:367-371, workflow-actions.ts:138-145}` | "AI employee" in notes, escalations, approval reasons | CFL | partner wording |
| 95 | `server/automation/gate.ts:83-88` | "This AI employee is paused/not ready" | CFL | partner wording |
| 96 | `server/approvals/service.ts:667` | "The employee is no longer connected" | CFL | partner wording |
| 97 | `server/offboarding/export.ts:211,341` (`ai-team/` folder = IID) | README and licence text "AI employees" | CFL | reword, keep folder name |
| 98 | `server/offboarding/service.ts:228,334,468` | "Stopped all AI employees...", "AI employee runtime profile(s)" | CFL | partner wording |
| 99 | `server/crm/agent-tools/{service.ts, tokens.ts, handlers.ts, tasks.ts}` | "This AI employee ..." API errors | CFL (low; runtime-facing) | partner wording |
| 100 | `server/workforce/*`, `server/knowledge/service.ts:273` | "AI employee not found." AppError texts | IID-ish (error text) | low priority |
| 101 | `server/workforce/{provisioning.ts:60, compiler.ts:100, policy.ts:45,80}` | persona prompts "AI workforce", "your AI team", "CRM Manager owns..." | LAO (legacy runtime prompt) | keep |
| 102 | `server/ops/collectors.ts:205`; `lib/launch-verification.ts`; `server/aqi/ops/**`; `lib/operations-manager-runtime.ts`; `lib/internal-*.ts` | agency ops | AIO | keep |
| 103 | `lib/notification-groups.ts:9`, `notification-presentation.ts:67` | "AI Growth Partner (status)" | ok | none |

### Admin and dev (not client-facing)
`src/app/(admin)/**`, `src/components/admin/**`, `src/server/admin/**`, `src/lib/admin*`, `src/app/dev/**` fixtures: AIO / LAO, not swept further. `src/components/workforce/*` (employee-detail, gallery, summary, instructions) and `(portal)/employees/**` are LAO: already labelled "Previous role profile / Retained role profile" (`employee-detail.tsx:192,203`, `gallery.tsx:75-77`, `employee-summary.tsx:53`); `employee-detail.tsx:892` "internal Operations Manager" is AIO.

---

## Doc claims not backed by code (as found)
- `docs/ai-growth-partner/implementation-status.md:19`: "The retained-profile chat rail and AQi route guidance now say 'Previous employee profiles.'" The literal does not exist in `src`; the chat navigation says "previous role profiles" (`lib/chat-navigation.ts:30`) and AQi says "Previous employee chats" (`lib/aqi/targets.ts:116-118`, `routes.ts:22`) and "Previous role profiles" (`routes.ts:18`).
- `implementation-status.md:91`: "operations and capability copy no longer presents client automation as a six-person AI workforce." The Automation Builder prompt still lists the six legacy roles as the workspace's "AI employees" (`server/automation-studio/builder/catalog.ts:91-93`, `prompt.ts:84,137-139`) and about 150 server strings still say "AI employee".
- `implementation-status.md:69`: Overview calls preserved legacy records "Previous role profiles": true for the label (`overview/page.tsx:175`), but the card is shown for every workspace with legacy rows, not only those with an enabled profile (contrast `sidebar.tsx:105,121`), and the only test covers an unmounted component.
- `implementation-status.md:18-19`: "removed role-specific copy from the AQi research and calendar tips" and "visitor handoff notices no longer describe the product as a six-employee team": not verified by me (no hits found for the old phrasing in the files I grepped, but I did not read those tips).
- `lib/aqi/tutorials.ts:275` tells the client "Your AI Growth Partner is one click away" anchored to `overview.ai-team`, which is the "Previous role profiles" card (`overview/page.tsx:172`).
- UI text "AI preferences" (`settings-nav.tsx:15`) and "Partner preferences" (`control-center.tsx:92`) vs the server message "Partner Settings" (`chat/service.ts:1180`): the last names a screen that does not exist.

<a id="gp-termc-01"></a>
### GP-TERMC-01 — Portal navigation and shell labels

- **Requirement:** Portal navigation and shell labels (directive §4, §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/shell/sidebar.tsx:17-126`, `src/components/shell/titles.ts:6-45`, `src/components/shell/topbar.tsx:64-72`, `src/components/shell/portal-shell.tsx`
- **Test coverage:** `tests/workforce-navigation.test.tsx` renders the real `Sidebar` in jsdom and proves: one `/growth-partner` link, "Previous role profiles" shown only to `agents.configure` holders with an enabled legacy profile, no `/employees/<slug>` or `/chat/<slug>` links, AQi anchor stays on the Growth Partner link. `tests/shell-titles.test.ts` proves every sidebar href has a non-fallback title. It does not prove any label text other than "AI Growth Partner" and "Previous role profiles", and does not cover the top-bar palette.
- **Real or simulated behavior:** Real React components rendering from shell context (permissions, agents, crmMode); no mock of the unit under test in workforce-navigation tests.
- **Missing dependencies:** none (founder confirmation needed only for whether to relabel or merge entries, see GP-TERMC-02).
- **Remaining work:** sidebar.tsx:123 'Work Board' -> 'AI Work Board'; sidebar.tsx:124 'Schedules & Calendar' -> 'Workforce Calendar'; titles.ts add /work/calendar title above line 44 (calendar page currently titled 'AI Work Board'); titles.ts:19 'Approval Center' vs nav 'Approvals'; CLIENT_NAV (sidebar.tsx:65) omits /work and /work/calendar so Ctrl+K palette cannot reach them; topbar.tsx:72 palette ignores crmMode so native workspaces see both 'Sales Pipeline' and 'Pipelines' and both 'Appointments' and 'Calendar'; add label-set assertions to tests.
- **Verification evidence:** I read `sidebar.tsx` and `titles.ts` in full and traced `CLIENT_NAV` consumers by grep (only `topbar.tsx`). Prior recorded run (docs/ai-growth-partner/implementation-status.md line 69) claims 90/90 focused portal tests and full-suite pass; not re-run by me.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Growth Partner client sees one workforce entry plus AI Work Board and Workforce Calendar; palette finds every sidebar destination exactly once; every portal page has a distinct top-bar title; test asserts the label set.

<a id="gp-termc-02"></a>
### GP-TERMC-02 — Adoption of the required final client vocabulary (12 terms)

- **Requirement:** Adoption of the required final client vocabulary (12 terms) (directive §4, §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/growth-partner/control-center.tsx:52-102,374,407,466`, `src/components/growth-partner/goals-panel.tsx:107`, `src/components/growth-partner/memory-panel.tsx:121`, `src/components/settings/settings-nav.tsx:15`, `src/app/(portal)/growth-partner/conversation/page.tsx:7`, `src/server/chat/service.ts:932,1180,1195,1197`
- **Test coverage:** `tests/growth-partner-capability-readiness-ui.test.tsx` and `tests/growth-partner-goals-panel.test.tsx` now assert Control Center labels; `tests/growth-partner-control-center-states.test.tsx` covers the integrated memory/goal panel and section names. No cross-product vocabulary guard exists yet.
- **Real or simulated behavior:** Real UI text. The Control Center now uses Growth Partner Settings, AI Work Board, Workforce Calendar, Permanent Conversation, Capability Access, Goals, Activity and Approvals, and Memory and Knowledge. Other routes and the shared shell still need the canonical vocabulary.
- **Missing dependencies:** founder decision whether "Activity and Approvals" and "Memory and Knowledge" and "Performance Reporting" become merged destinations or only the relabelled existing ones (Activity + Approvals are two pages, `/activity` and `/approvals`; Knowledge Center and Partner memory are on two pages). Relabelling alone is unblocked.
- **Remaining work:** W1-08/09/10 updated the shared settings label, conversation title, shell destinations and Performance Reporting labels. Remaining work is the product-wide vocabulary guard and the unowned Leads/AQi/help copy sweep; retained-profile naming outside the touched dashboards remains separate.
- **Verification evidence:** W1-05 tests cover the Control Center labels, target-size field, relationship copy and section permissions. The 18-test focused run, targeted ESLint and TypeScript check passed. No whole-product vocabulary scan was run.
  - *Skeptic review: Six-capability count is accurate to the product (lib/ai-growth-partner.ts:7-14) and is not a legacy-model remnant; additional naming inconsistency and test-impact missed.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
  - *W1-08 local follow-up (2026-11-16): 4 focused files passed (20 tests): portal navigation vocabulary, shell titles, workforce calendar UI and workforce navigation. The broader product vocabulary guard remains for W1-12.*
- **Definition of done:** Each of the 12 terms is the only visible name for its destination across nav, title, heading, metadata, AQi/help and server messages; a vocabulary test lists them and fails on old alternates.

<a id="gp-termc-03"></a>
### GP-TERMC-03 — Per-role lists, role pickers and retained-profile views

- **Requirement:** Per-role lists, role pickers and retained-profile views (directive §4)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/overview/page.tsx:171-203`, `src/components/overview/overview-panels.tsx:96-125`, `src/components/analytics/analytics-view.tsx:266-287`, `src/components/inbox/ai-controls.tsx:114-121`, `src/components/inbox/inbox-list-panel.tsx:80-110`, `src/server/messaging/inbox-context.ts:222-241`, `src/components/crm/workflows/step-panel.tsx:676-681,865-872`, `src/server/crm/workflows/context.ts`, `src/components/work/workforce-calendar.tsx:408-411`, `src/components/work/work-board-kanban.tsx:88-94`, `src/app/(portal)/employees/page.tsx`, `src/app/(portal)/employees/[slug]/page.tsx`, `src/app/(chat)/chat/page.tsx:3-4`, `src/app/(chat)/chat/[slug]/page.tsx:25`, `src/components/chat/chat-rail.tsx:141,234`, `src/lib/chat-navigation.ts:30`
- **Test coverage:** `tests/client-legacy-chat-redirect.test.ts` proves a client opening `/chat/lead-hunter` is redirected to `/growth-partner/conversation` before any agent lookup (real page function, mocked services). `tests/workforce-navigation.test.tsx` covers nav gating. `tests/overview-growth-partner-navigation.test.tsx` covers only `TeamGrid` (dead code), so the live Overview card has no test. Inbox identity is covered by the last commit's tests (`unifiedAiIdentity`); I did not read them.
- **Real or simulated behavior:** Real UI over real agent_instances rows. Redirect test mocks the workforce services. Overview test targets TeamGrid, which is not mounted anywhere; the live Overview card is untested.
- **Missing dependencies:** none.
- **Remaining work:** W1-09 now gates the Overview's Previous role profiles card, adds Growth Partner Analytics/Approvals identity and removes role names from those dashboards and the Work Board. Remaining: hide the Inbox handler selector when it has one option; label legacy options in CRM workflow selectors; consolidate Work/Calendar role chips; redirect the client `/chat` index directly; remove the dead client branch in chat-navigation. | Skeptic adds: the Overview links to disabled rows were dead ends; the card now follows enabled retained profiles.
- **Verification evidence:** W1-09 local follow-up: six focused dashboard/Work Board files passed (59 tests), including `overview-previous-profiles`, `analytics-growth-partner-rows`, `approval-requester-partner` and Work Board coverage. The remaining selectors and calendar chips were not changed by that package.
  - *Skeptic review: Strengthens the audit: the card for migrated workspaces lists six role names linking to redirects.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A client workspace with no enabled legacy profile shows no role name anywhere (Overview, Analytics, Inbox, workflows, Work Board, Calendar); with enabled legacy profiles roles appear only under a 'Previous role profiles' label; a test renders Overview and Analytics with six disabled legacy rows plus a partner and asserts no role name.

<a id="gp-termc-04"></a>
### GP-TERMC-04 — Onboarding and setup copy

- **Requirement:** Onboarding and setup copy (directive §4, §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/setup-copy.ts:12-125`, `supabase/migrations/0124_growth_partner_setup_copy.sql`, `src/server/setup/transition.ts:153`, `src/lib/launch-readiness.ts:999-1085`, `src/server/setup/launch-readiness.ts:746`, `src/server/setup/connectors.ts:138-150`, `src/server/setup/native-evidence.ts:575-584`, `src/lib/onboarding/business-profile.ts:340-382,436-449`, `src/components/onboarding/review-panel.tsx:169-385`, `src/components/setup/onboarded-banner.tsx:17-112`, `src/server/onboarding/employee-sync.ts:780-781,876-877`, `src/server/onboarding/service.ts:721`, `src/lib/agents.ts:310-330`
- **Test coverage:** `tests/setup-center.test.ts`, `tests/onboarding-v2.test.ts`, `tests/client-onboarding-ui.test.tsx`, `tests/onboarding-status-wording.test.ts` mention the new copy; I only grepped them and did not read assertions, so I cannot say they prove the legacy branches.
- **Real or simulated behavior:** Real: currentSetupCopy shim runs over real checklist rows (core.ts:404, snapshots.ts:128,303, templates.ts:29); migration 0124 stores partner copy for new checklists. Tests were only grepped, not read.
- **Missing dependencies:** none.
- **Remaining work:** W1-11 resolved the listed onboarding/readiness strings and passes legacy completion snapshots through `currentSetupCopy` without rewriting stored rows. Remaining: run the W1-12 client-copy ratchet and review newly reported pending strings; test a broader set of default checklist rows and custom templates.
- **Verification evidence:** W1-11's new `growth-partner-setup-wording.test.ts` covers the seeded company-info sentence, the 0056 calendar sentence and legacy completion-copy translation. `setup-center.test.ts` exercises a legacy completion notification and verifies the saved notice stays unchanged. Six focused files passed (112 tests); `npm run typecheck`, targeted ESLint and `git diff --check` passed.
  - *Baseline: 4 of 4 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No client checklist row, notification, readiness item or onboarding confirmation names a role or 'AI employee/AI team' unless labelled previous role profile; transition notifications go through the shim; tests feed legacy-copy snapshot rows through render and notification paths.

<a id="gp-termc-05"></a>
### GP-TERMC-05 — Login, authentication and public prospect surfaces

- **Requirement:** Login, authentication and public prospect surfaces (directive §4, §17)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(auth)/login/page.tsx:28`, `src/app/(auth)/get-started/page.tsx:11`, `src/app/(auth)/invite/[token]/page.tsx:72`, `src/components/auth/showcase.tsx:18-28`, `src/components/demo/landing-sections.tsx:105`, `src/lib/demo/showroom/content.ts:49`, `src/server/email-render.ts:61,490`
- **Test coverage:** `tests/demo-pages.test.tsx` renders demo pages (944 lines; I did not read the assertions). Nothing asserts auth copy.
- **Real or simulated behavior:** Real static and server-rendered copy; auth pages are clean.
- **Missing dependencies:** none.
- **Remaining work:** email-render.ts:61 'See the AI team in action' and :490 'iAcquire's AI team works' (prospect demo email) -> AI Growth Partner; drop 'six capabilities' counts in auth/showcase.tsx:21, demo/landing-sections.tsx:105, lib/demo/showroom/content.ts:49. | Skeptic adds: Also welcome-hero.tsx:21 'Six connected capabilities' (authenticated welcome page); treat the count as low priority because it matches the six-item AI_GROWTH_PARTNER_CAPABILITIES list.
- **Verification evidence:** read every `(auth)` page string via grep; the login and get-started copy is clean ("Sign in to iAcquire", "Meet your AI Growth Partner").
  - *Skeptic review changed the status from IMPLEMENTED_UNVERIFIED to PARTIAL: Row lists must-fix CFL strings (prospect email 'AI team') yet is marked IMPLEMENTED_UNVERIFIED; status inconsistent with its own remaining work.*
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** No legacy role name, 'AI team' or 'six' count in auth, welcome, demo or prospect emails; one copy test over those files.

<a id="gp-termc-06"></a>
### GP-TERMC-06 — Settings and team wording

- **Requirement:** Settings and team wording (directive §4, §17)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/settings/settings-nav.tsx:12-25`, `src/components/settings/settings-forms.tsx:548-550,632,653-654`, `src/lib/permissions.ts:266,359`, `src/lib/storage-policy.ts:20`, `src/server/settings/service.ts:379`, `src/app/(portal)/settings/ai/page.tsx:6`
- **Test coverage:** none read for wording; behaviour tests for preferences/profile exist (not read).
- **Real or simulated behavior:** Real settings pages; no per-role settings screens exist in (portal)/settings.
- **Missing dependencies:** none.
- **Remaining work:** settings-nav.tsx:15 'AI preferences' -> 'Growth Partner Settings'; permissions.ts:359 'works with the AI team'; storage-policy.ts:20 'the AI employees read'; settings-forms.tsx:632 'the employee's long-term memory scope'; settings/service.ts:379 'This employee could not be updated.'; disambiguate human team role label 'Appointment Setter' (permissions.ts:266, crm/forms/after-editor.tsx:16, crm/recovery/recovery-settings.tsx:22) without renaming the key.
- **Verification evidence:** read settings-nav fully and grep-read forms; no per-role settings pages exist in `(portal)/settings`.
- **Definition of done:** One AI settings entry named Growth Partner Settings; no 'employee/AI team' text outside retained-profile statements.

<a id="gp-termc-07"></a>
### GP-TERMC-07 — Calendar surfaces (Workforce Calendar, CRM Calendar, Appointments)

- **Requirement:** Calendar surfaces (Workforce Calendar, CRM Calendar, Appointments) (directive §4, §17)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/work/calendar/page.tsx:10`, `src/components/work/workforce-calendar.tsx:362-378,408`, `src/components/shell/sidebar.tsx:38,124`, `src/server/calendars/schedule.ts:265`, `src/server/calendars/agent-booking.ts:112,158`, `src/server/appointments/booking.ts:168`, `src/server/appointments/changes.ts:166`, `src/server/crm/reports/appointments.ts:11`
- **Test coverage:** not read.
- **Real or simulated behavior:** Real; the Workforce Calendar reads persisted jobs and schedules. Which actor strings reach customer-visible timelines was not traced.
- **Missing dependencies:** none.
- **Remaining work:** Rename page metadata/heading/eyebrow to 'Workforce Calendar' and add /work/calendar title; 'AI Employee Chat' (agent-booking.ts:112, booking.ts:168) -> AI Growth Partner conversation; system actor 'Appointment Setter' (agent-booking.ts:158, changes.ts:166) and 'AI employee' (schedule.ts:265, reports/appointments.ts:11) -> AI Growth Partner; role filter aria-label (workforce-calendar.tsx:408).
- **Verification evidence:** read the calendar component headings by grep and the server strings by grep; did not trace which actor strings reach a customer-visible timeline versus an internal audit.
- **Definition of done:** One calendar screen named Workforce Calendar for AI work, CRM Calendar named Calendar; timeline and approval text name the AI Growth Partner.

<a id="gp-termc-08"></a>
### GP-TERMC-08 — Leads, CRM and missed-call recovery wording

- **Requirement:** Leads, CRM and missed-call recovery wording (directive §4)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/components/leads/leads-workspace.tsx:202,445,596-650`, `src/server/leads/research-contract.ts:135,138`, `src/server/leads/research-job.ts:89,278,451`, `src/server/leads/service.ts:90`, `src/lib/crm/blueprints/requirements.ts:65,67`, `src/lib/crm/blueprints/views.ts:305`, `src/server/crm/reports/deals.ts:8`, `src/server/crm/reports/operations.ts:105`, `src/server/crm/reports/export.ts:223`, `src/components/crm/reports/sections.tsx:28`, `src/lib/missed-calls/state.ts:161`, `src/server/missed-calls/routing.ts:34`, `src/server/crm/workflows/executors.ts:548,755-756`
- **Test coverage:** not read; Growth Partner CRM ability tested by `tests/growth-partner-crm-ability.test.ts` (not read).
- **Real or simulated behavior:** Real; Leads page already uses the growth_partner runtime (leads/page.tsx:16) and its copy is clean. Test files not read.
- **Missing dependencies:** none.
- **Remaining work:** research-contract.ts:135,138 'The Lead Hunter's answer'; research-job.ts:278 fallback 'AI employee' and :451 'Hermes connection'; blueprint requirements text 'lead hunter AI employee' and 'AI employee memories'; report labels 'AI employee'/'Removed AI employee' and provider 'Hermes'; missed-calls/state.ts:161 'Handed to the Appointment Setter' (key appointment_setter is an identifier, keep); executors.ts dry-run 'AI employee' text.
- **Verification evidence:** grep + selective reads; `leads-workspace.tsx` copy already says "AI Growth Partner" throughout (clean).
  - *Baseline: 1 of 1 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** Leads, CRM reports, blueprints and recovery history never name a legacy role or 'AI employee' to a Growth Partner client.

<a id="gp-termc-09"></a>
### GP-TERMC-09 — AI Work Board labelling and legacy job rows

- **Requirement:** AI Work Board labelling and legacy job rows (directive §4)
- **Current implementation status:** PARTIAL
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/work/page.tsx:12`, `src/components/work/work-board.tsx:255`, `src/components/work/work-board-kanban.tsx:82-94,167,207`, `src/components/growth-partner/control-center.tsx:90,437-449`, `src/components/shell/sidebar.tsx:123`
- **Test coverage:** not read.
- **Real or simulated behavior:** Real; board reads persisted ai_work_jobs. Capability labels in lib/workforce-capabilities.ts are role-neutral.
- **Missing dependencies:** none.
- **Remaining work:** Metadata `Work Board` in `work/page.tsx:12` and the sidebar label still need `AI Work Board`; historical job rows need a previous-profile marker, and legacy deep links `/chat/<slug>?c=` and `/employees/<slug>` need review (kanban:82-94,167).
- **Verification evidence:** W1-05 updated and tested the Control Center Work Board title, status region and action link. The page metadata and nav remain open.
- **Definition of done:** Board, tile, nav, title and metadata all say AI Work Board; historical legacy jobs are labelled previous role profile.

<a id="gp-termc-10"></a>
### GP-TERMC-10 — Chat and the Permanent Conversation (client-visible strings and role-chat entry points)

- **Requirement:** Chat and the Permanent Conversation (client-visible strings and role-chat entry points) (directive §4, §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/app/(portal)/growth-partner/conversation/page.tsx`, `src/components/growth-partner/permanent-conversation.tsx`, `src/server/chat/service.ts:932,1180,1195,1197,1729,2012,2429,2574,2834,3305,3437-3443,3760`, `src/server/integrations/hermes/client.ts:592-838`, `src/app/(chat)/chat/[slug]/page.tsx:25`, `src/components/chat/chat-rail.tsx`, `src/components/chat/chat-workspace.tsx:806-831`
- **Test coverage:** `tests/client-legacy-chat-redirect.test.ts` (redirect, mocked services); `tests/growth-partner-permanent-conversation-ui.test.tsx` (real component, not read in detail); `ai-growth-partner-conversation.test.ts` (not read). Nothing asserts the user-visible failure/approval strings.
- **Real or simulated behavior:** Real: the permanent conversation uses the shared sendChatMessage run engine (agentRole growth_partner) and the Hermes client. Redirect test mocks workforce services. Role chat rail and /chat/[slug] are agency-only (clients redirected first).
- **Missing dependencies:** none.
- **Remaining work:** Make user-visible strings partner-aware: FRIENDLY_FAILURE (chat/service.ts:3437-3443 'Your AI employee couldn't finish this request'), approval notification body 'An AI employee is waiting for approval.' (:3760), :1729 and :2012 'This employee's role can't prepare...', :2429, :2574 'Your role can't chat with AI employees.', :3305, :2834 'this employee chat', 'Partner Settings' (:932,1180,1195,1197); hermes/client.ts:592-838 AgentRunNotReadyError messages ('This AI employee ... Hermes profile/credential') surface in the conversation. Named-handoff text is already skipped for client partners (service.ts:2849). W1-05 removed the Hermes vendor name from the Growth Partner memory panel.
- **Verification evidence:** read the redirect page and test; traced `namedOtherRole` guard (`service.ts:2849`).
  - *Skeptic review: Vendor leakage in a Growth Partner client component not in the audit's hit table.*
  - *Baseline: 3 of 3 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** A Growth Partner client never sees 'employee' or 'Hermes' in the conversation, its errors or its approval notifications; tests assert the strings for the partner role.

<a id="gp-termc-11"></a>
### GP-TERMC-11 — Automation Studio client copy and Builder prompt

- **Requirement:** Automation Studio client copy and Builder prompt (directive §4)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/automation-studio/builder/catalog.ts:91-93`, `src/server/automation-studio/builder/prompt.ts:84,103,110,137-139`, `src/server/automation-studio/templates.ts:73`, `src/lib/automation-studio/templates.ts:36,181-191`, `src/lib/automation-studio/starters.ts:25,56`, `src/lib/automation-studio/plan.ts:123,140,163`, `src/components/automation-studio/template-gallery.tsx:97`
- **Test coverage:** `tests/support/studio-workspace.ts` and Studio tests exist (not read); no test asserts the builder prompt content.
- **Real or simulated behavior:** Client pages, templates and starters are real and use 'AI Growth Partner'. The Builder is a real LLM call whose prompt is built from workspace options; employeeCatalog() enumerates only the six legacy AGENT_ROLE_KEYS and grep shows zero growth_partner mentions in builder/*.ts.
- **Missing dependencies:** none (a real-model check of builder behaviour would need paid model spend; the prompt change itself is unblocked).
- **Remaining work:** catalog.ts:91-93 employeeCatalog() lists legacy roles and omits growth_partner; prompt.ts:84 'AI employees in this workspace', :110 'asks an AI employee', :137-139 'AI EMPLOYEES (roleKey values)': build the list from the workspace agents (partner first) and word it 'AI Growth Partner'; automation-studio/templates.ts:73 'that AI employee isn't in this workspace.'; add a unit test of the prompt for a partner-only options object. | Skeptic adds: Correct scope: the workspace list already includes growth_partner (it is built from enabled agent_instances of any role); the defect is the static employeeCatalog() advertising six legacy roleKeys and the 'AI employees' wording. Verify the Builder operation validator rejects roleKeys absent from the workspace.
- **Verification evidence:** read catalog.ts and the prompt lines; grep confirms zero `growth_partner` mentions in `builder/*.ts`.
  - *Skeptic review: Audit claim that the Builder never mentions growth_partner is overstated; prompt.ts:84 lists o.agents which comes from an unfiltered enabled-agents query.*
- **Definition of done:** Builder prompt for a partner-only workspace lists only the AI Growth Partner and never the six role names; unit test asserts it.

<a id="gp-termc-12"></a>
### GP-TERMC-12 — Requests Center (Support, Report an Issue, Feedback, Request a Change, My Requests)

- **Requirement:** Requests Center (Support, Report an Issue, Feedback, Request a Change, My Requests) (directive §4)
- **Current implementation status:** IMPLEMENTED — NOT YET VERIFIED
- **Priority:** P3  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/lib/support/lifecycle.ts:53-56,72,86`, `src/lib/support/change.ts:12,19,32`, `src/lib/support/suggest.ts:65`, `src/components/support/request-form.tsx`, `src/components/shell/sidebar.tsx:53-61`
- **Test coverage:** not read.
- **Real or simulated behavior:** Real pages; visible labels already say 'AI Growth Partner'; legacy words appear only as stable keys and a matching regex.
- **Missing dependencies:** none.
- **Remaining work:** none (keys ai_employees, change_ai_employee, ai_employee are identifiers and must not be renamed); covered by the guard in GP-TERMC-14.
- **Verification evidence:** grep of `src/lib/support`, `src/components/support`, `(portal)/support`, `src/server/support` found no visible legacy text.
- **Definition of done:** Unchanged visible copy; guard test confirms no legacy text reintroduced.

<a id="gp-termc-13"></a>
### GP-TERMC-13 — Notifications, status labels, empty states, tooltips and server-built user-visible strings

- **Requirement:** Notifications, status labels, empty states, tooltips and server-built user-visible strings (directive §4, §17)
- **Current implementation status:** PARTIAL
- **Priority:** P1  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `src/server/workforce/service.ts:652`, `src/server/workforce/proactive-review.ts:147`, `src/server/workforce/readiness-facts.ts:140-141`, `src/server/messaging/attention.ts:67`, `src/server/messaging/ingest.ts:253`, `src/server/messaging/send.ts:487`, `src/server/messaging/web-chat-send.ts:66`, `src/server/messaging/responder.ts:102-361`, `src/server/messaging/ai-control.ts:53,88,99`, `src/server/messaging/handoff.ts:367-371`, `src/server/automation/gate.ts:83-88`, `src/server/approvals/service.ts:667`, `src/server/offboarding/export.ts:211,341`, `src/server/offboarding/service.ts:228,334,468`, `src/server/crm/agent-tools/service.ts:286-348`, `src/lib/notification-groups.ts:9`
- **Test coverage:** none for wording. Behavioural tests for these services exist (not read).
- **Real or simulated behavior:** Real strings written to notifications, conversation notes, escalations, exports and API errors; health-alerts.ts already handles the partner correctly. No wording tests.
- **Missing dependencies:** none.
- **Remaining work:** W1-10 updated partner branches for chat failures, approval notices, messaging/inbox notices, runtime readiness, proactive review and autonomy-reconfirm links. Remaining: offboarding export README/licence/progress text (keep the `ai-team/` folder identifier), automation gate strings, low-priority CRM agent-tool API errors and the server-action toast sweep. | Skeptic adds: include `src/app/actions/*.ts` user-visible strings; update old-string assertions as those paths are changed.
- **Verification evidence:** W1-10 added `tests/growth-partner-client-wording.test.ts` and updated Work Board e2e wording assertions. Seven focused files passed (119 tests); typecheck, targeted ESLint and `git diff --check` passed. W1-11 separately covers the onboarding agency notification outcomes. These focused tests do not establish a product-wide string sweep.
  - *Skeptic review: Server actions were not in the audited path list but return toast text to clients.*
- **Definition of done:** Output of every notification builder, escalation/approval note, export README and user-visible API error for a growth_partner workspace contains none of the legacy vocabulary; tests assert builders with a growth_partner role.

<a id="gp-termc-14"></a>
### GP-TERMC-14 — Terminology regression guard

- **Requirement:** Terminology regression guard (directive §4, §17)
- **Current implementation status:** COMPLETE — VERIFIED
- **Priority:** P2  |  **Evidence class:** app-functional  |  **Unblocked now:** yes
- **Source files:** `tests/client-vocabulary.test.ts`, `tests/support/vocabulary-allowlist.ts`, client route/component source under `src/app/(portal)`, `(setup)`, `(auth)`, `src/app/actions`, `src/components` (excluding admin/workforce), and selected `src/lib`/`src/server` copy.
- **Test coverage:** The scanner walks TypeScript AST copy values and ignores comments, identifiers, import paths and object keys. Its file + term + exact-count allowlist classifies reviewed exceptions as IID, LAO, AIO or PENDING. A rendered partner-only fixture covers the Overview card, AnalyticsView and Sidebar with all six legacy profiles disabled; another test checks the twelve required terms on their intended destinations.
- **Real or simulated behavior:** The UI components render from a synthetic Growth Partner shell in jsdom. The scanner reads the integrated source; it does not claim real-model or hosted behavior.
- **Missing dependencies:** none for the guard.
- **Remaining work:** Resolve PENDING client-copy entries owned by W1-13; preserve IID legacy keys, LAO retained-profile surfaces and AIO agency operations. This is follow-up product copy work, not a gap in the regression guard.
- **Verification evidence:** W1-12 commit `7f6d33f9`: both new guard files passed (7 tests total); `npm run typecheck`, targeted ESLint and `git diff --check` passed. The full integrated regression passed immediately before this tests-only commit at `b40606c8`.
  - *Baseline: 2 of 2 cited test file(s) passed on 6e4a4b7e.*
- **Definition of done:** The test fails when a legacy string is added to client-facing code and passes with the allow-list documented.

### Skeptic findings and triage

- {"title": "Work Board Start review resolves Growth Partner and legacy actors correctly", "directiveRef": "§4 (no per-role entry points; one AI Growth Partner)", "priority": "P1", "status": "COMPLETE — VERIFIED", "remainingWork": "Resolved in the integrated branch: startReviewAction selects the bound Growth Partner when present and retains allowedRoles[0] for unbound legacy workspaces. tests/work-start-review-partner-only.test.ts exercises every Work Board capability, the legacy fallback and a paused Partner; 3/3 tests passed on 2026-11-17."}
- {"title": "Server-action error text sweep (src/app/actions)", "directiveRef": "§4, §17", "priority": "P2", "status": "NOT_STARTED", "remainingWork": "About 21 user-visible 'employee' strings: actions/work.ts:25, actions/chat.ts:16,18,90, actions/workforce.ts:23,25,99, actions/automation.ts:17, actions/inbox.ts:192. Keep route slugs and revalidatePath('/employees') calls unchanged."}
- {"title": "Vendor name 'Hermes' on a Growth Partner client page", "directiveRef": "§4 (client vocabulary)", "priority": "P3", "status": "IMPLEMENTED_UNVERIFIED", "remainingWork": "W1-05 changed the memory panel to say 'AI runtime memory'; focused UI tests assert the panel renders without a Hermes reference. No product-wide scan has run yet."}
- {"title": "Welcome hero 'Six connected capabilities' in authenticated setup flow", "directiveRef": "§4, §17", "priority": "P3", "status": "NOT_STARTED", "remainingWork": "src/components/onboarding/welcome-hero.tsx:21; accurate count (six capabilities), so a founder wording decision, not a legacy-model fix."}
- {"title": "Requests Center has no group name in client navigation", "directiveRef": "§4 (Requests Center client pages)", "priority": "P3", "status": "NOT_STARTED", "remainingWork": "No 'Requests Center' string in src; sidebar.tsx:50-61 shows 'Get Support', 'Report an Issue', 'Provide Feedback', 'Request a Change', 'My Requests'. Confirm with the founder whether a group heading is required."}
