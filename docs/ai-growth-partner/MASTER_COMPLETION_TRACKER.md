# AI Growth Partner completion tracker

Last updated: 2026-11-17. This is the single progress ledger for the product transformation. It separates implemented application behavior, synthetic acceptance and live-provider acceptance. A green synthetic test never counts as proof of a public-source, paid-model or external-integration run.

## Weighted progress

The percentage is a planning estimate, not a launch-readiness score. Each area is weighted by its share of the requested outcome; its completion estimate reflects implemented behavior with available application-level evidence. The total is `sum(weight × completion) / 100`. Synthetic evidence earns credit for the tested application path only. Real-provider and customer-cutover gates are tracked separately below.

| Outcome | Weight | Completion estimate | Evidence and remaining work |
| --- | ---: | ---: | --- |
| One AI Growth Partner identity and permanent conversation | 15% | 90% | New work routes to one Partner and one canonical conversation; legacy profile records remain reviewable. Finish the product-wide language audit and existing-tenant cutover plan. |
| Onboarding and Business Brain | 15% | 82% | Onboarding facts and provenance feed the versioned Brain; identity and contact facts are covered. Complete broader automatic generation, edit/review coverage, and existing-client reconciliation. |
| Unified behavior, personality and memory | 12% | 82% | Shared behavior settings, conversation state and app-owned memory persist. Pinned Hermes-native memory passed a two-tenant synthetic restart test; real-model reasoning is unverified. |
| Authorized CRM and calendar actions | 12% | 72% | Permanent-conversation tests cover native CRM, opportunity, appointment and approval paths with tenant and permission checks. External CRM/calendar account behavior remains unaccepted. |
| Work Board, task state and schedules | 10% | 82% | Tasks, saved schedules and chat-controlled pause/resume have persisted, audited application tests. Production scheduler activation and existing-tenant schedule cutover remain off. |
| Discovery through qualification and CRM import | 10% | 64% | Bundled synthetic fixtures cover research, signals, qualification, disqualified/duplicate/missing-information cases, approval, CRM import and Work Board completion. Public-source discovery remains untested. |
| External integration readiness | 8% | 42% | Provider adapters, configuration and permissions exist. Real external CRM/calendar reads and writes have not passed acceptance. |
| Client, Super Admin, login, landing and demo transformation | 10% | 50% | Recent routes and retained-role surfaces use the single-Partner model. A full wording and navigation audit across every requested surface is still required. |
| Safe legacy migration and customer cutover | 5% | 40% | New client provisioning creates one Partner; read-only reconciliation and disposable migration rehearsals exist. No hosted migration, customer backfill, profile deletion or cutover has occurred. |
| Security, isolated verification and operations | 3% | 70% | Tenant authorization, audit, migration rehearsal, isolated restart, regression and pinned-runtime evidence exist. The environment-wide outbound stop is committed and verified in `ec2d94c`; exact-head pinned-runtime reacceptance remains open. |
| **Weighted estimate** | **100%** | **71%** | **Not a launch-readiness score.** Live discovery, real-model reasoning, external CRM/calendar acceptance and customer cutover remain open. |

## Acceptance evidence

| Area | Latest evidence | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Source settings and synthetic discovery | Local application tests previously passed 4 files / 14 tests on the source-settings and fixture CRM increment. | Disabled defaults, persisted authorized settings, invalid-config rejection, request/spend limits, backend enforcement, fixture discovery, approval, duplicate prevention, tenant boundaries, audit and Work Board state. | No OpenStreetMap request, public website crawl, paid inference or live-source integration. |
| Pinned Hermes runtime | Hosted run [#102](https://github.com/mlester999/iacquire-dashboard/actions/runs/44073297356), source commit `46dbf279004551b53ab816225728f799f1c5c3df`, on `ubuntu-24.04`. | Pinned Hermes v0.22.5; two synthetic tenant profiles; internal mock-model inference; network-disabled runtime containers; audit and tenant denials; each tenant's Hermes-native memory recovered after gateway restart. | Not real-model reasoning, public-source access, external CRM/calendar behavior or current-code acceptance for unrelated changes after that source commit. |
| App-owned persistence | Disposable file-backed PGlite restart acceptance passed on the current product line. | Canonical conversation/search, app memory and prompt context, goals, approved legacy knowledge, paused schedules and Work Board task state survive a fresh process. | Not Hermes-native memory; its report explicitly says `hermesMemoryVerified: false`. |
| Migrations | Disposable PGlite apply, guarded rollback, replay and schema comparison passed through migration `0136`. | Local migration ordering, apply path, safe refusal paths and replay against disposable data. | No hosted database access or authorization for a hosted migration. |
| Application regression and build | Hosted run [#114](https://github.com/mlester999/iacquire-dashboard/actions/runs/44085253948) passed on source commit `68346fda15c3ef473ac576fbe89b6882e8809bc4`; current incremental verification is recorded in the latest dated entry of `implementation-status.md`. | Full suite, typecheck, lint and pinned Next build for that source commit; font egress limited to the two approved Google Fonts hosts. | Does not automatically certify changes made after that commit. |

## Mandatory gates before recommending live-source acceptance

1. Keep the first discovery acceptance on bundled fixtures. The separate public-source acceptance must be read-only, use an isolated non-production tenant, stay within separately approved host and request limits, and make no customer communications. No external discovery call is authorized by this tracker.
2. The pinned Hermes runtime gate must use the reviewed GitHub-hosted `ubuntu-24.04` Docker-capable runner, Hermes image `docker.io/nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d` (Hermes v0.22.5), and Node helper image `docker.io/library/node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`. Follow the isolated acceptance workflow: build the reviewed gateway/provisioner, provision two fictional tenants through local routes, use only the internal mock model, disable test-container egress, check tool permissions/audits/tenant boundaries/native memory after gateway restart, then remove test containers, networks, volumes and credentials. Runner setup and pinned image pulls are outside the test containers and must stay within the already approved runner budget and registry scope.
3. No real inference provider, public source, external CRM/calendar, outbound channel, customer record, hosted migration or production deployment is enabled by this checklist. Each requires its own acceptance scope and any required owner approval.

## Product work still required

- Finish one coherent Partner behavior, personality and memory model across onboarding, Brain edits, the permanent conversation, schedules and runtime instructions.
- Complete the server-authorized CRM/calendar action surface and verify it against provider sandboxes only after separately approved credentials and scopes are available.
- Finish the all-surface product-language/navigation audit: client portal, Super Admin portal, login, landing, demo, onboarding, retained settings, notifications and help content. Preserve useful capabilities from the six retained roles without presenting six client-facing AI identities.
- Complete read-only reconciliation for existing clients, with explicit owner review, non-destructive cutover rules, rollback evidence and no customer-profile deletion.
- Keep acquisition as one capability of the Growth Partner. Fixture acceptance is complete evidence for synthetic processing only; public-source and real-model acceptance remain separate gates.
- Keep the production scheduler, messaging master switch, provider writes, customer-facing notifications and external integrations disabled until their independent release reviews.

## Current increment

- Branch: `codex/ai-growth-partner-core-next`; this schedule-control increment is committed locally on top of `ec2d94c7da032ca60c36ef4be8a78eb04764ea8a`.
- Change: extend the permanent Growth Partner conversation's preview-and-confirm flow to reschedule any named saved read-only Growth Partner capability. It preserves the exact schedule row, enabled state and tenant, checks owner/admin permission and current capability access, rejects stale previews, audits accepted changes, and requires explicit cadence/weekdays when converting legacy intervals. No schedule runs while the global scheduler is disabled.
- Focused schedule intent and database-backed chat suites passed **2 files / 49 tests**. Application/script typecheck passed. Repository lint passed with **0 errors** and **3 existing warnings** in unrelated AQI/setup files. The preceding full regression on the verified base commit passed **905 files** (2 skipped) and **13,885 tests** (103 skipped); it did not include the current schedule diff.
- The current change's final `npm run build:clean -- --webpack` passed on Next.js **16.4.5**: optimized compilation in **4.1 minutes**, build TypeScript in **73 seconds**, and **16/16** static pages. Its loopback TLS/SNI-aware proxy allowed only `fonts.googleapis.com` and `fonts.gstatic.com`; `dc.services.visualstudio.com` was denied before a tunnel opened, and the proxy was stopped after the build.
- No schema or migration changed. The local machine has no Docker CLI; the pinned Hermes-native memory evidence remains hosted run **#102** on source commit `46dbf279`, with two synthetic tenants and the internal mock model. That is not exact-head acceptance and does not verify real-model reasoning or live integrations.
- No hosted database, external discovery/model/provider, customer communication, production branch or production deployment was used. Discovery evidence remains synthetic fixtures; no live discovery or public website integration passed.

## Next checkpoint priorities

- Continue with the all-surface product transformation and one-Partner/Business Brain behavior; do not let acquisition work take priority over identity, permanent conversation, authorized tools, Work Board and the UI language audit.
- Keep public-source discovery, real inference, external CRM/calendar acceptance and existing-tenant cutover as separate gates requiring their own scope. They were not run in this increment.
- Continue the all-surface product transformation and one-Partner/Business Brain behavior in the isolated branch; fast-forward a preview only when the target remains non-production and the approved credential flow succeeds.
