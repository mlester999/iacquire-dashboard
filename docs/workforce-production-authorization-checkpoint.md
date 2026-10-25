# iAcquireOS workforce production authorization checkpoint

**Status:** Prepared for review; not approved or executed. No production deployment, schema change, Hermes profile change, worker activation, or autonomous schedule has been performed.

## Candidate and target

- **Product code SHA:** `82793ab8b6e92c9dba7ced8bd65ce349f50ba0c2` (includes the Hermes audit correction and Zod security update below; later checkpoint-only commits do not change product code).
- **Branch:** `codex/iacquire-workforce-completion`, based on current production `master` at `36bf78c40f73148fe1d25787a9eba5eb9709c64d`. The candidate is a large, 170+ file release and requires review as a whole.
- **Target:** production iAcquireOS portal at `www.iacquire.online` and its hosted application database.
- **Current deployed SHA:** `36bf78c40f73148fe1d25787a9eba5eb9709c64d`.
- **Scope size:** the candidate contains the master implementation work, including the approved Work Board/Calendar milestone and workforce, onboarding, CRM, and related application changes. Review the candidate's full diff before promotion.

## Production changes that would require approval

1. Promote the reviewed portal code at the exact candidate SHA above.
2. Apply these currently unapplied migrations, in dependency order: `0084_restricted_hermes_provisioner`, `0087_workforce_local_recurrence`, `0088_workforce_chat_schedule_previews`, `0089_workforce_chat_booking_previews`, `0090_workforce_appointment_changes`. The hosted ledger last reported `0086_lead_scoring`; no migration is to be replayed.
3. In a separate protected operation, review and apply guarded configs to the four existing internal profiles (Appointment Setter, Sales Assistant, CRM Manager, Performance Analyst) and complete genuine Super Admin acknowledgements only after fresh identity, inventory, health, and effective-config checks. Preserve Zeng and Lead Hunter. This step cannot be performed until an approved effective-config read/write path exists.
4. After those profile changes are independently approved and verified, run supervised, read-only production Chat acceptance for all six employees. Do not send messages, modify customer records, book appointments, import leads, or perform outbound work during this acceptance.

## Explicitly excluded from this approval

- No Hermes profile creation or replacement, SOUL write, gateway upgrade, or client-only Hermes runtime deployment.
- No schedule creation or autonomous production execution. `SCHEDULER_ENABLED` remains false; the scheduler was last observed returning 503 because `CRON_SECRET` and the enable switch were absent.
- No client provisioner activation. `HERMES_PROVISIONER_ENABLED` remains false.
- No customer communications, lead imports, CRM writes, real bookings, paid infrastructure, or Automation Studio billing changes.

Any later activation of schedules, the client-only provisioner, or Hermes profile updates requires a separate approval with its own verified run scope. The code and migration deployment must not be interpreted as authorization for profile or worker changes.

## Readiness and impact

- The 2026-10-25 production preflight reports **2/6** with app 6/6 readiness and Chat availability. Zeng's applied v4 configuration is incomplete (6/7 role fields); Lead Hunter's v1 configuration is complete (8/8). Both inventory attestations are expired, so new Chat submissions must refresh the inventory and live runs must pass the adapter's two-read check. The other four roles remain 0/6 without applied configurations or current health, inventory, identity, and acknowledgement evidence. The 2026-10-25 Hermes GET audit verified all six existing identities and the reviewed six-tool inventory, but the live gateway cannot attest the effective loaded SOUL (`admin_config_rw=false`). The candidate now reports this as runtime verification only, separate from portal run readiness. No production model/task run was started.
- Work Board ↔ Calendar ↔ Cron Job lifecycle and recurrence/recovery controls pass isolated PGlite route-and-database acceptance. The production database currently has no schedules or triggers; no production execution is implied.
- The real-provider onboarding canary passed for one synthetic organization in in-memory PGlite: six AI-sourced employee configs, six provisioning requests, owner edit preserved, and zero Hermes calls. The client-only runtime remains sandbox-only.
- The production migration ledger reports 80 entries through `0086_lead_scoring`. Candidate migration and rollback acceptance passed 9/9 locally. Rollbacks now refuse to erase active provisioning work, versioned provisioning evidence, recurrence rules, or unresolved schedule/booking proposals.
- On product candidate `82793ab8b6e92c9dba7ced8bd65ce349f50ba0c2`, a fresh isolated `npm ci` install passed the full regression (**332 files; 5,088 passed, 8 skipped**), `npm run typecheck`, and `npm run build -- --webpack` on Next.js 16.4.2. The build includes `/api/internal/tick`, `/api/workforce/calendar`, `/work`, and `/work/calendar`.
- Dependency security: npm identified the high-severity [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) in direct production dependency Zod 4.6.5 (affected versions `<4.6.6`). Zod is now pinned to 4.6.7 in `package.json` and the lockfile. `npm audit --omit=dev` now reports zero vulnerabilities. Vitest is updated from 4.1.11 to 4.1.12 as a development dependency; the isolated Python worker pins `PyYAML==6.0.3`.

## Required preconditions before deployment approval

1. Create a current full production database backup in the approved secure location and verify a restore into a Supabase-compatible isolated environment. The available October 22 archive predates migrations 0085–0086, contains only `app` and `public`, and is not a full-project backup. On October 25, `pg_restore --list` verified its 3,741 TOC entries, but a restore into isolated PostgreSQL 18 failed at `public.auth_recovery_sessions → auth.users` because the archive omits Supabase's managed `auth` schema. The single-transaction restore rolled back. Do not treat this archive as a passing restore or apply migrations until a full restore succeeds.
2. Complete a final review of the full candidate diff, dependency lockfile, migration plan, and production environment differences. High-risk workforce, provisioning, migration, dependency and release paths have been reviewed; the full 170+ file diff still needs final release review. The candidate has not been pushed or deployed.
3. Obtain an authoritative current Hermes method for verifying effective loaded SOULs and a safe, reviewed config-apply path. The current API does not provide the required read capability.
4. Confirm the production LLM connection and perform a narrowly scoped, supervised Chat smoke test only after the profile configs and genuine acknowledgements are approved.
5. Keep the scheduler, proactive triggers, worker, and client provisioner disabled until their separate acceptance and approval gates pass.

Hostinger capacity is not current: the previous SSH host-key verification failed closed. Do not install the client runtime until the host identity and current CPU, memory, disk, container, and recovery capacity are verified. PostgreSQL 18 client/server tools are available locally at `C:\Program Files\PostgreSQL\18\bin` (not on `PATH`); their availability did not resolve the incomplete archive or restore blocker.

## Rollback and recovery

- The portal can be reverted to the previous Vercel deployment at `36bf78c40f73148fe1d25787a9eba5eb9709c64d` after deployment approval.
- The migration down scripts are guarded and passed local rollback checks. If production data has started using a new column or table, a guarded rollback may refuse; prefer a forward fix to preserve that data.
- Do not apply migrations until the backup restore precondition passes. No production migration or rollback has been run from this candidate.

## Approval record

No production approval has been received for this deployment or any profile, schema, runtime, or scheduler change. This checkpoint is not an authorization token. The protected steps remain on hold until the preconditions above are satisfied and the exact candidate is approved.
