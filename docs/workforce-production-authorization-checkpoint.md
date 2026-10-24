# iAcquireOS workforce production authorization checkpoint

**Status:** Prepared for review; not approved or executed. No production deployment, schema change, Hermes profile change, worker activation, or autonomous schedule has been performed.

## Candidate and target

- **Code SHA:** `043c5c90f809f1e0546668dabdb32a6654d9116b`
- **Branch:** `codex/iacquire-workforce-completion`, 100 commits ahead of `origin/master` at `36bf78c40f73148fe1d25787a9eba5eb9709c64d` before this evidence-document update.
- **Target:** production iAcquireOS portal at `www.iacquire.online` and its hosted application database.
- **Current deployed SHA:** `36bf78c40f73148fe1d25787a9eba5eb9709c64d`.
- **Scope size:** the candidate contains the master implementation work, including the approved Work Board/Calendar milestone and workforce, onboarding, CRM, and related application changes. It is a 100-commit release candidate, not a small patch. Review the candidate's full diff before promotion.

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

- The current production application exposes 2/6 employees. All six existing Hermes identities and the reviewed six-tool inventory passed a read-only GET audit, but the live gateway cannot attest the effective loaded SOUL (`admin_config_rw=false`). The four target configs are prepared locally but are not applied.
- Work Board ↔ Calendar ↔ Cron Job lifecycle and recurrence/recovery controls pass isolated PGlite route-and-database acceptance. The production database currently has no schedules or triggers; no production execution is implied.
- The real-provider onboarding canary passed for one synthetic organization in in-memory PGlite: six AI-sourced employee configs, six provisioning requests, owner edit preserved, and zero Hermes calls. The client-only runtime remains sandbox-only.
- The production migration ledger reports 80 entries through `0086_lead_scoring`. Candidate migration and rollback acceptance passed 9/9 locally. Rollbacks now refuse to erase active provisioning work, versioned provisioning evidence, recurrence rules, or unresolved schedule/booking proposals.
- The candidate production build and full local regression passed: Next.js 16.4.2 Webpack build; 332 test files, 5,087 passed, 8 skipped.

## Required preconditions before deployment approval

1. Create a current production database backup in the approved secure location and verify a restore into an isolated environment. The available backup was only archive-listed; a restore has not been verified.
2. Complete a final review of the full 100-commit diff, dependency lockfile, migration plan, and production environment differences. The candidate has not been pushed or deployed.
3. Obtain an authoritative current Hermes method for verifying effective loaded SOULs and a safe, reviewed config-apply path. The current API does not provide the required read capability.
4. Confirm the production LLM connection and perform a narrowly scoped, supervised Chat smoke test only after the profile configs and genuine acknowledgements are approved.
5. Keep the scheduler, proactive triggers, worker, and client provisioner disabled until their separate acceptance and approval gates pass.

Hostinger capacity is not current: the previous SSH host-key verification failed closed. Do not install the client runtime until the host identity and current CPU, memory, disk, container, and recovery capacity are verified.

## Rollback and recovery

- The portal can be reverted to the previous Vercel deployment at `36bf78c40f73148fe1d25787a9eba5eb9709c64d` after deployment approval.
- The migration down scripts are guarded and passed local rollback checks. If production data has started using a new column or table, a guarded rollback may refuse; prefer a forward fix to preserve that data.
- Do not apply migrations until the backup restore precondition passes. No production migration or rollback has been run from this candidate.

## Approval record

No production approval has been received for this deployment or any profile, schema, runtime, or scheduler change. This checkpoint is not an authorization token. The protected steps remain on hold until the preconditions above are satisfied and the exact candidate is approved.
