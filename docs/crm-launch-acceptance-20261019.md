# Native CRM launch acceptance (2026-10-19)

Scope: the deployed `f2165c4` release, checked in an isolated worktree at that commit with a fresh fictional PGlite seed. The unrelated AQi UX refactor in the working checkout was not part of this run. Production remained live and unchanged by this audit.

> **Deployment note:** while this audit ran, parallel work pushed AQi polish, performance and sign-out confirmation commits; production advanced to **`e9fe6f7`**, whose Vercel deployment completed successfully. The `f2165c4..e9fe6f7` diff touches AQi components/routes, the admin/portal shell, global styles and docs — not the CRM, sales, integrations or setup code audited here. The browser matrix was executed on `f2165c4`; the current production health check is `{"status":"ok","database":"ok","scheduler":"never_ran"}`.

## 1. Route, interaction and responsive audit

| Pass | Scope | Result |
| --- | --- | --- |
| Desktop / light | All **114 routes** across owner, GoHighLevel owner, sales rep, public booking/form, agency admin and agency staff; axe on | **114/114 loaded**, 0 not rendered, 0 external requests, 0 5xx, 0 horizontal overflow, 0 axe violations. 5 page-error and 11 console-error records were all dev-server restart/chunk artifacts; the seven affected routes were re-run clean on a fresh higher-memory server: **7/7 with 0 page/console errors**. |
| Interactions | 14 documented CRM interactions | 12 passed. The 2 failures (`create a contact`, `add a tag`) occurred during confirmed dev chunk restarts; `create a contact` passed on rerun, and both passed in the earlier clean release-gate interaction run on the same code. |
| Phone / dark | Focused 390 px/dark pass across every CRM layout: overview, CRM home, contacts, pipelines/board, opportunities, tasks, calendar, forms, workflows, provider settings, setup guide, appointments, GoHighLevel-owned contacts/setup, public booking and public form | 16/17 clean on the first pass; `/appointments` timed out on a cold compile, and its clean rerun passed. Final evidence: all 17 layouts rendered with **0 axe violations, 0 overflow, 0 page/console errors**. A full 114-route phone sweep was attempted but dev-worker restarts invalidated it after 57 routes (0 render/5xx/overflow failures up to that point); the complete phone matrix is not claimed. |

The 14 interactions include contact creation, tag application, keyboard deal move, inbox thread, setup-guide advance, GoHighLevel migration panel (not connected), provider-switch preview, submitted-form contact, public booking, public form submission, sales-rep permission boundary, support session, Blueprint dry run and tenant-boundary check. Public booking and public form submission **passed**, and the submitted form contact appeared to the owner — lead capture works end to end locally.

The QA harness had a real defect: its streamed-redirect helper waited the default 30 seconds for a meta tag on every normal route, doubling the matrix time. It now checks `count()` first and returns immediately when no redirect tag exists. This is test tooling, not CRM behavior.

## 2. Setup labels: configuration versus operational readiness

The CRM setup guide uses separate states:

- `Configured` — the provider/capability is chosen or set up (for example the CRM provider step for a native workspace).
- `Verified` — a live test or a check of the real records passed.
- `Not started` / `Needs client action` / `Needs agency action` / `Failed` — work or evidence is missing.

The Setup Center uses `unverified` / `verified` / `failed` / `attested`; the activation review labels an attestation **“Agency evidence, unverified”**, counts only `verified` checks for technical readiness, and keeps manual work separate from technical verification. Native clients therefore show provider configuration as configured and do not claim operational verification until the evidence checks pass.

## 3. Integration status

| Area | Status | Evidence |
| --- | --- | --- |
| AQi | **Implemented and locally verified** | Phase 3 browser record 65/65 across groups; the deployed release includes the 0063 hardening. No authenticated production AQi session was inspected. |
| Hermes | **Implemented, live acceptance blocked** | The agency has 6 employees in `provisioning`; clients have 12 in `setup_required`; one Hermes integration check is recorded connected (2026-10-17) and two are not configured. No live agent run was performed. The deployed gateway still fails the tool-inventory verification documented in [hermes-tool-inventory.md](hermes-tool-inventory.md), so health stays fail-closed. |
| Website Studio | **Implemented and locally verified** | `/website` rendered at 1440 light and 390 dark with 50 designs, 0 axe violations, no overflow, 0 console/page errors. No website exists in production, so publishing/DNS/host acceptance remains outstanding. |
| Calendars / booking | **Local browser verified** | Native calendar routes and both public booking routes rendered; the “book on the public booking page” interaction passed. |
| Forms / lead capture | **Local browser verified** | Public form submission passed (HTTP 201), and the submitted-form contact appeared to the owner after the local worker processed it. |
| CRM records | **Local browser verified** | Contacts, companies, pipelines, opportunities, tasks, notes/timeline, reports, imports/exports and the record detail routes rendered cleanly in the matrix. |
| Background workflows | **Not activated** | Workflow pages and the workflow engine tests pass, but the production scheduler is off and no production workflow run exists. |

## 4. Hosted staging readiness

No staging project exists: the Supabase organization has only the production project `lkkiavjwxaeoqgsbjyso`. The execution path and the staging-only migration command are in [staging-environment.md](staging-environment.md). No billable resource was provisioned and no production migration was applied.

Hosted production was read-only inspected on 2026-10-19:

- migrations through `0063_aqi_phase3_hardening`, **no pending migrations**, **259 public tables**, **0 without RLS**;
- **2 client organizations**, both `native`; **0 contacts, companies, deals, tasks, calendars, forms, workflows or websites**;
- AQi has **8 conversations** and **14 published knowledge entries**;
- one Hermes check connected (2026-10-17), two not configured; LLM connected;
- **0 scheduler runs**; no queued messages, emails, reminders, campaigns, imports, provider switches or webhook deliveries.

This means production is provisioned native-first but has **not exercised the native CRM with real records**, so hosted auth, persistence, tenant isolation and end-to-end workflows remain staging acceptance items.

## 5. Scheduler readiness

Production is gated correctly:

- `GET /api/internal/tick` → **503**
- `POST /api/internal/tick` → **503**
- `/api/health` → `scheduler: "never_ran"`
- no `CRON_SECRET` or `SCHEDULER_ENABLED=true` in the production environment; `GHL_WRITES_ENABLED=false`.

The supervised activation checklist is in [production-scheduler.md](production-scheduler.md): keep the scheduler disabled, deploy the host cron, invoke once manually with a 24+ character secret, inspect `worker_job_runs`/health/outbox, confirm no send, then enable the recurring schedule and rollback by setting `SCHEDULER_ENABLED=false`. **Not activated; approval required.**

## 6. Defects fixed in this audit

- CRM browser-QA redirect wait no longer costs 30 seconds on every normal route.
- [client-provisioning.md](client-provisioning.md) no longer says every client gets four preparation jobs/GoHighLevel mapping; native clients get three jobs and no mapping job.
- [crm-setup.md](crm-setup.md) records that native clients do not get `manual_ghl_mapping`.
- [staging-environment.md](staging-environment.md) now gives a staging-only migration command and warns that `npm run db:migrate` loads production env files.

No CRM feature was rebuilt. No provider write, scheduler activation, production migration or CRM migration was performed.

## 7. Remaining launch blockers

1. Hosted staging project, credentials and approval; run the 12-point matrix in [staging-environment.md](staging-environment.md).
2. Hosted auth/persistence/tenant-isolation/end-to-end acceptance with real staging identities.
3. A live Hermes acceptance run against a gateway whose tool inventory verifies.
4. Website Studio publish/DNS/host acceptance (no production website exists).
5. Supervised scheduler activation and a live workflow/outbound test (approval required).
6. The remaining funnel work in [sales-and-demo-funnel-audit.md](sales-and-demo-funnel-audit.md): consultation CTA, demo pipeline, purchase intent/invitation, payment gate and purchase-triggered provisioning.
7. A complete all-route phone/dark sweep (the desktop 114-route pass and the focused 17-layout phone pass are clean; the full phone sweep was stopped after 57 routes because the QA dev worker kept restarting) and a manual screen-reader pass.
