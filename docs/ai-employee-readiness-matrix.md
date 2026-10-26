# AI employee readiness matrix

Last verified: 2026-10-26, on branch `integrate/phases-3-7-workforce` (worktree `.data/wt-release-candidate`), at the release-candidate head this document ships with. It is the honest answer to "is each of the six AI employees real?". It separates what runs in this repository and was tested here from what needs a live Hermes profile, which has **never** been connected for a client. A card that says "online" in a test or a screenshot is a simulated profile, and a simulated profile is not production-ready.

**What changed since the 2026-10-25 version of this document.** Four things it used to list as "not built" are built and tested, and are described below with the code and the tests that prove them: one shared readiness definition with role prerequisites, a scheduled Hermes health probe, a per-role tool allowlist, and storage entitlement. This document no longer repeats the old claims that they are missing. Everything is still **local only**: nothing is deployed, no hosted migration is applied, and no real Hermes profile has ever answered.

## The classes of evidence used here

| Class | Meaning |
| --- | --- |
| **Deterministic, tested** | Runs in this codebase against the database with no model: the 12 reviewed read-only capabilities, the readiness state machine, the health probe's selection and alerting, the tool policy table and the storage classes. Tested on embedded Postgres. |
| **Simulated Hermes** | Needs a Hermes profile. Tested only against `tests/support/mock-hermes.ts` (a local stand-in). Proves the portal's side (gates, preflight, streaming, persistence, readiness, probe); proves nothing about the real model. |
| **Live Hermes** | A real profile answered. **None** has been recorded for any client employee. |

## One definition of ready (built in `src/lib/workforce-readiness.ts`)

Every screen, the Super Admin view, the scheduler and the conformance tests reach the same answer from the same function. There is no second opinion to drift:

* **Thirteen internal stages** (`disabled`, `suspended`, `review`, `setup`, `connection`, `inventory`, `identity`, `attention`, `approval`, `incomplete`, `degraded`, `ready`, `working`) collapse to the **eight states the product speaks in**: `pending_setup`, `configuration_incomplete`, `connection_required`, `provisioning`, `ready`, `degraded`, `unavailable`, `suspended`.
* **`chatAvailable`** means the runtime is verified (enabled, configured, a passing health check, a recorded and valid tool inventory, a current credential, and — for an internal employee — a current identity check and Super Admin acknowledgement).
* **`workReady`** is stricter: the runtime is verified **and** the role's blocking prerequisites are in place. "Ready for authorized work" is never shown because a connection answered.
* **Role prerequisites** (`src/lib/employee-requirements.ts`, judged from workspace facts read by `src/server/workforce/readiness-facts.ts`): blocking means the employee cannot do the job it is named for; advisory means it is better with it and the capability itself says what is missing.

| Role | Blocking prerequisites | Advisory |
| --- | --- | --- |
| AI Lead Hunter | approved company knowledge, saved lead targeting | — |
| AI Appointment Setter | approved company knowledge, a calendar with a host | a customer channel |
| AI Sales Assistant | approved company knowledge, an active sales pipeline | a customer channel |
| AI CRM Manager | CRM set up | approved company knowledge |
| AI Performance Analyst | CRM set up | approved company knowledge |
| AI Operations Manager | — | approved company knowledge |

A workspace that has bought but not finished setting up has all six at **Setup required**; a workspace whose setup payment is outstanding stays there with the reason (`paymentCleared === false`), and a refund stops new provisioning without pausing an AI team that is already authorized.

## The scheduled health probe (built in `src/server/workforce/health-probe.ts`)

* **What it is:** the same authenticated, read-only check an administrator's "check connection" runs (capabilities, identity, the profile's toolsets, the complete tool inventory read twice), on a schedule. It spends no model tokens, starts no run, writes nothing to Hermes and messages no customer.
* **When it runs:** only inside the scheduler, as job `aiHealthProbe`, only when `WORKFORCE_HEALTH_PROBE_ENABLED=true`, and in a staged start only when named in `SCHEDULER_JOBS_ONLY`. It is **not** started; no scheduler has ever run.
* **Bounds:** a batch per tick, a concurrency limit, a per-check timeout with one bounded retry for a gateway that did not answer, and a tick budget after which the rest is deferred and counted as deferred.
* **What it says:** consecutive failures below the threshold (3) read **Degraded**; at the threshold the employee reads **Unavailable** and the owners, admins and assigned agency staff get **one** notice, with one more when it recovers. The probe records what it saw (`agent_health_probes`, pruned by retention) and never confirms a *changed* tool inventory by itself: that stays a person's explicit step.
* **Not claimed:** it is not a capability test, it does not prove the role has what it needs (the prerequisites above do), and it has never run against a real gateway.

## The per-role tool allowlist (built in `src/lib/employee-tool-policy.ts`)

One deny-by-default table decides what each role may do through four doors: a reviewed capability, a chat proposal, a CRM tool scope, and the tools its Hermes profile may call by itself.

| Runtime tool | Toolset | Roles |
| --- | --- | --- |
| memory | memory | all six |
| session search | session_search | all six |
| to-do list | todo | all six |
| picture analysis (optional) | vision | all six |
| web search | web | **AI Lead Hunter only** |
| web extract | web | **AI Lead Hunter only** |

* **Enforced by default** (`WORKFORCE_ROLE_TOOL_ENFORCEMENT`, present in `.env.example` and `.env.staging.example`; only the exact word `report` relaxes it, and only for a deliberate profile migration). A profile that exposes more than its role allows is refused at the connection check and cannot be brought online, and provisioning tells the gateway to enable only the role's toolsets.
* **Honest note on the evidence:** the test suite runs most of its older Hermes fixtures with `WORKFORCE_ROLE_TOOL_ENFORCEMENT=report` (set in `vitest.config.ts` so a fixture written against the shared toolset still exercises the feature it is about). The enforced path is proved explicitly by `tests/employee-tool-policy.test.ts`, which removes the opt-out and walks every role against the shared set and against its own, and by the unit test that pins `roleToolEnforcement({})` to `enforce`.
* The portal also refuses the *actions* independently of the profile: 65 of the 78 role-and-capability pairs are refused, and a chat proposal or a CRM scope the table does not name is denied whatever the model says. A prompt that tells the Sales Assistant to "act as the Lead Hunter" changes nothing, because the role comes from the employee's database row and the table is looked up by that role.
* **Not claimed:** the gateway-side effect has never been observed on a live profile, and the VPS tool-policy package that would enforce the same allowlist outside the portal exists but has never been run.

## Storage entitlement (built in `src/lib/storage-policy.ts`)

Every private bucket is classified, and a test fails when a bucket is added without a class, so there is no upload path that was never asked the question. The class is enforced at the single place every upload passes (`uploadPrivateFile`), not in the screens.

| Class | Buckets | Gated by the plan? |
| --- | --- | --- |
| core | company-documents, support-attachments, project-files, project-uploads, portfolio-assets, brand-assets, aqi-attachments, proposal-documents, staff-messages | **No.** These keep the workspace running; a lapse never read-blocks them |
| managed_media | social-media | **Yes.** Included with the Managed Maintenance plan |

A client without the plan is told the truth: pictures and videos are kept in its own Google Drive or OneDrive, **which is not built** (each needs an OAuth application registered with the provider), so in practice such a workspace cannot add social media until it has the plan. Nothing already uploaded is lost or locked.

## The six roles

| Employee | Agency profile id (fixed) | Client profile name | Reviewed capabilities (all read-only) | Deterministic evidence | Production status |
| --- | --- | --- | --- | --- | --- |
| AI Lead Hunter | `iacquire-lead-hunter` | `c-<workspace slug>-<12-hex digest>-lead-hunter` | Lead research (Hermes), Lead generation review | Lead generation review completes and reads the research queue and backlog; research stops with its own reason when no profile is connected | Not provisioned for any client |
| AI Operations Manager | `iacquire-operations-manager` | `c-…-operations-manager` | On-demand operations review | Completes and reads blocked or overdue work, failed runs, missing approvals and integration problems | Not provisioned |
| AI Appointment Setter | `iacquire-appointment-setter` | `c-…-appointment-setter` | Appointment review, Calendar availability check, Missed-call review | All three complete; availability reads the real native calendar and says honestly when none exists | Not provisioned |
| AI Sales Assistant | `iacquire-sales-assistant` | `c-…-sales-assistant` | Pipeline review, Lead priority review | Both complete against pipeline and lead-score records | Not provisioned |
| AI CRM Manager | `iacquire-crm-manager` | `c-…-crm-manager` | CRM quality review | Completes and reports missing details, duplicates and unverified identities | Not provisioned |
| AI Performance Analyst | `iacquire-analyst` | `c-…-performance-analyst` | Performance snapshot, Social media review, Receivables review, Reputation review | All four complete and state their period, definition and source; none invents a benchmark | Not provisioned |

## What the tests prove

* `tests/six-employees-conformance.test.ts` (20): exactly six roles with distinct names, slugs and fixed agency profile ids; every capability names real roles and is read-only; every role owns work it can do; a client's profile name is `c-…`, at most 63 characters, never an agency id, and distinct per workspace and role; an employee that is switched on but not connected, provisioning, offline, erroring or disabled cannot chat; all 12 deterministic capabilities finish `completed` with a stated result; the 65 disallowed pairs are refused; a purchase-created workspace has all six in **Setup required** and an owner cannot dispatch to any; a pause stops jobs where they are requested, scheduled, triggered and claimed.
* `tests/employee-readiness-states.test.ts`, `tests/employee-readiness-facts.test.ts`, `tests/employee-runtime-single-definition.test.ts`: the eight states, the blocking and advisory prerequisites, and that only one definition decides them.
* `tests/employee-health-probe.test.ts` (15): due selection, batch and budget, one retry for a silent gateway, degraded below the threshold, one alert at it, one recovery notice, no self-confirmation of a changed inventory, and that an over-wide profile is refused now that the tool policy is enforced.
* `tests/employee-tool-policy.test.ts` (20): the table walked for every role against every action, the enforcement default and its one opt-out, the inventory accepting exactly a role's tools and refusing more or fewer, and the internal agency profiles keeping the shared reviewed set.
* `tests/storage-entitlement.test.ts`, `tests/storage-rollbacks.test.ts`: every bucket classified, the single enforcement point, and a lapse that never read-blocks what is stored.
* `tests/client-content-policy.test.ts` (15): the staff-access rule (D70) itself, and the admin reader that now asks the same question before showing a client's held knowledge.

## Browser evidence (isolated QA app, real Chromium, no provider)

`scripts/wave3-employee-readiness-qa.mjs` reads the employee screens the workforce work changed and clicks nothing that writes. Signed in as the workspace **owner** and **manager** it visits the client's `/employees` list and all six employee pages; as the **Super Admin** it visits `/admin/employees`, the six agency employee pages, the client-employee, policy and review pages, `/admin/clients` and a client's detail. Each page is loaded at 375 and 1280 px in light and dark, with checks for a heading and content, sideways scrolling or clipped content, **axe-core serious and critical violations (WCAG 2 A and AA)**, the 12px text floor, an error page, and (added after the first run found the defect below) **whether anything in a choice card sits outside the card's own box**. It also records requests that left the QA origin and console, page and server errors.

**Result at this code: 627 of 627 checks passed; 0 console errors, 0 page errors, 0 5xx, 0 requests leaving the QA origin** (`tmp/final-employee-qa3.log`; screenshots `.data/wave2-qa/employees-*.png`, git-ignored). The first run (543 checks) failed 26 and found three real defects, all fixed:

| Found by | Defect | Fix |
| --- | --- | --- |
| axe `link-in-text-block`, 24 pages (owner and manager, dark) | The "Approval Center" and "Open Knowledge Center" links inside sentences were told apart from the text by colour alone until hovered (WCAG 1.4.1) | Underlined at rest (`font-medium text-primary-ink underline underline-offset-2`) in `employee-detail.tsx` and `employee-knowledge.tsx` |
| axe `color-contrast`, `/admin/clients/<id>` (light, both widths) | The shared danger `Button` was white on `#e5484d`, 3.91:1 against the 4.5:1 minimum | `#c6363c` at rest (5.25:1), `#a92f34` on hover, in `src/components/ui/button.tsx`; the same pair for two other white-on-danger fills in the Website editor. `tests/danger-button-contrast.test.ts` reads the classes and fails if any state drops below 4.5:1 |
| Looking at the screenshots (no tool flagged it) | At desktop width the "Current" pill in the operating-mode picker overflowed the "Approval required" card into the next one | The card header wraps (`operating-controls.tsx`); the sweep now fails any choice card whose contents leave its box, and a width probe (375 to 1536 px, both themes) found the pill inside its card at every width |

**What this is not:** it is not a screen-reader pass, it does not exercise connecting, probing or provisioning a profile (no live Hermes exists), and the data is the seeded QA workspace with no real gateway behind it, so an employee shown as "Online" there has never answered anyone. It proves the screens say the same thing as the shared readiness definition and are usable at both widths and themes; it does not prove that any employee works.

## What is still not live-verified

This is the list the founder needs. None of it is claimed anywhere in this repository.

1. **No live Hermes profile has ever answered** — not for a client, not for an internal agency employee. Chat, research, every sentence a model writes, and the gateway's own enforcement of the tool allowlist are unproven outside the mock.
2. **The scheduled probe has never run** (no scheduler has ever started), so its cadence, its alerts and its retention are verified only through injected clocks and a local gateway stand-in.
3. **Memory isolation is unverified against a live profile**: per-employee and per-role memory keyed by workspace is the design, and cross-tenant isolation is tested at the database level only. A two-session canary is still required before any customer-facing launch.
4. **Client profile provisioning is a queue plus an operator runbook**; the restricted host-side provisioner exists only on unmerged branches and has passed a sandbox run only. No client profile exists on a VPS.
5. **Role prerequisites are asserted from workspace facts, not from a real employee doing the job**: a calendar, a pipeline and approved knowledge are checked, but no live employee has booked, sold or reported with them.
6. **The VPS tool-policy package was prepared and never run**, so today's enforcement is portal-side; the gateway is *told* the narrower toolsets but has not been observed excluding anything.
7. **The health probe's alert delivery** (in-app notice) is tested against the database, not through a real notification channel.

## Distinguishing agency and client employees

The agency's own six employees are internal: fixed profile ids, an identity record and a Super Admin acknowledgement are required before one may run. A client's employees are provisioned per workspace with the `c-…` names above; reserved `iacquire-*` names cannot be mapped to a client. Both are checked by the run gate on every Hermes run (`assertAgentRunPreflight`), which re-reads the database immediately before submitting.
