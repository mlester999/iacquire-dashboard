# Client AI workforce onboarding release

Status (2026-10-22): this existing onboarding release is locally merged with current `origin/master` and is in release validation. **Not pushed or deployed by this session.** No production profile, credential, SOUL, migration or customer resource was changed by this work. The restricted host worker and portal integration are implemented, but end-to-end acceptance is blocked on a separate client-only Hermes runtime and a compatible Hermes API contract.

## Client path

1. An agency creates the client workspace and invites its owner. Six tenant-scoped employee records already exist, initially without Hermes profiles or live access.
2. The verified owner saves and resumes the existing adaptive six-stage business questionnaire. Website-derived suggestions and sensitive business answers still require confirmation. The final submission saves the company profile and approved knowledge.
3. The approved platform model proposes only four bounded communication-style fields for each employee. Invalid, risky, identical or unavailable model output falls back to named deterministic role defaults. Confirmed onboarding answers and approved tenant knowledge supply business facts. The model cannot provide pricing, policies, services, contact details, permissions or credentials.
4. The existing guarded version path applies safe configurations and holds risky ones for agency review. The compiled request layers client style and business context beneath immutable policy. Each employee has distinct personality, behavior, procedures, responsibilities, reporting and role answers. Missing operational facts stay missing.
5. Six idempotent provisioning requests appear in the client detail queue for an eligible, verified, non-demo client. The restricted worker leases only an applied client configuration on its pinned, verified client-only gateway. It creates a blank profile, never clones an existing employee, and reports a host attestation to the portal. The worker remains disabled until the separate runtime has passed isolation review.
6. On completion, the client sees six persisted states and a real ready count. Chat links appear only after the existing readiness gate accepts an applied configuration, current credential, authenticated identity, complete safe tool inventory and a passing health check. External booking and messaging still require their own verified connections; the optional maintenance plan does not gate core chat.

The Manage AI Employee screen exposes all generated style fields. Regeneration produces a preview; applying it to a draft requires an explicit click, and saving follows the guarded version path. Later business updates refresh untouched shared fields and knowledge while preserving recorded manual overrides across repeated submissions.

## Hermes boundary and effective instructions

The portal does not receive Docker access, root, SSH, or a filesystem path. The new worker accepts only fixed typed manifests, uses Hermes CLI blank-profile creation, and verifies a unique fresh-session SOUL challenge and complete runtime tool inventory before callback. The portal checks its lease and hashes, saves the profile key through Vault, and still requires its independent identity, tool-policy, inventory and health check before a profile can run.

The authorized read-only Hostinger inspection identified VPS `srv2039372.hstgr.cloud` (ID `2039372`) and Hermes app `hermes-agent-wpwm`, reported earlier as container `008d77b9fd0a`, running Hermes Agent v0.21.5 (2026.9.24). Hermes home `/opt/data` is the bind mount `/docker/hermes-agent-wpwm/data`; it contains all six internal iAcquire profiles and runs in a root-started container. It is **not** an acceptable provisioning target. The app terminal later showed the same bind mount and Hermes processes but returned a different hostname, and Docker inspect/stats were unavailable from that terminal. The installed version returns 404 for the complete `/v1/tools?platform=api_server` catalog that iAcquireOS requires. The worker now enforces the portal's full inventory contract and two stable reads; no available stable Hermes release was verified to implement it. No profile, container or service was changed.

The worker contract, recovery behavior, host findings and production gate are in [hermes-restricted-provisioner.md](hermes-restricted-provisioner.md). The current integrated tree reserves `0084_restricted_hermes_provisioner`; migration `0083` belongs to the Unified Inbox. The latest integrated release verification reports `0081`, `0082` and `0083` applied to production; this session did not re-query the ledger or apply `0084`. A new isolated client-only Hermes runtime and a Hermes version that exposes the complete challenged tool catalog are required before the worker can be enabled. No real host profile has been created.

Profile names contain a stable tenant-slug digest and the full role suffix, preventing truncation collisions between long slugs or roles. Existing mapped profile names are retained.

## Read-only prerequisite audit

The older read-only check on 2026-10-21 reported 0081 and 0082 pending. The newer integrated release verification dated 2026-10-22 reports `0081_ai_work_job_rls_hardening`, `0082_client_employee_provisioning` and `0083_unified_inbox` applied after a verified backup. This session made no hosted database connection, so use a fresh read-only ledger check before any future migration. Agency Operations Manager and Lead Hunter had applied configuration and passing recorded health; Appointment Setter, CRM Manager and Sales Assistant remained setup-required and unconfigured; Performance Analyst remained provisioning and unconfigured. Lead Hunter's saved readiness audit reported 6/6 checks for authorized work, but no live run or effective SOUL proof was performed. The prior all-six activation is incomplete.

## Local evidence

- Two isolated fictional PGlite clients each completed one saved onboarding submission. Each received six tenant-scoped saved configuration versions, including versions correctly held for review, and six provisioning requests. A repeated submit created no additional versions or jobs. Cross-tenant company text was absent from the other client's compiled instructions. These are test database records, **not deployed Hermes profiles**.
- Focused tests cover six distinct safe defaults, bounded model output, prompt-injection rejection, manual override preservation, long profile names and SOUL digest, authorization, retry lease and tenant boundaries.
- Existing onboarding browser QA passed 52 checks at 320, 360, 390, 430, 768 and 1440 pixel widths in light and dark modes. The browser harness uses preview fixtures and does not prove authenticated live Hermes behavior.
- Final full-suite, lint and production-build results are recorded at the release gate below.

## Migration and activation checkpoint

`0082_client_employee_provisioning.sql` adds one-open-job uniqueness, bounded attempt count, lease and retry metadata. Before applying it, check for duplicate open jobs:

```sql
select agent_instance_id, count(*)
from public.agent_provisioning_jobs
where status in ('requested','in_progress','awaiting_health_check')
group by agent_instance_id having count(*) > 1;
```

The integrated release record reports 0081 through 0083 already applied. After a fresh read-only ledger check and duplicate-open-job review, migration 0084 is the next provisioner schema change; deploy the portal with the worker disabled. The 0084 down migration refuses rollback while sync-job history exists. Roll back the application before dropping its schema, and preserve job/audit history.

Production activation requires: prior six-agency release and SOUL remediation verified; a separate client-only Hermes runtime with no agency profiles; a Hermes version that exposes the complete challenged tool catalog; isolated two-tenant acceptance; a reviewed, unprivileged worker deployment; the migration sequence above; a privileged isolation attestation and pinned worker credential; profile identity, effective-SOUL and inventory checks; portal health checks; and explicit approval for production deployment. No new production resources or migrations were created during this work.

## Release gate

- `npx vitest run --maxWorkers=2 --reporter=dot` on the merged tree: 309 files passed; 4,809 tests passed, 8 skipped.
- The focused onboarding/provisioner set passed 26/26. Database-backed tests exercise gateway isolation, leases, Vault key storage and callback replay, versioned sync, run gating, tenant ownership, and invalid host attestations.
- `python -m unittest discover -s services/hermes-provisioner -p 'test_*.py' -v`: 12/12 isolated worker tests passed using temporary fictional profiles and a fake Hermes API. No test used Hostinger.
- `npm run typecheck`: passed.
- `npm run build`: Next.js 16.4.2 production build passed, including both internal provisioner routes.
- `npm run lint`: exit 0; two existing warnings remain in `src/server/calendars/agent-booking.ts` and `src/server/calendars/native-availability.ts`.
- `git diff --check`: pending final merge commit.

The actual end-to-end production provisioning result remains **zero profiles created and zero production changes**. The worker has not been installed or exercised against a live Hermes runtime. A compatible complete-catalog Hermes build and an isolated client-only runtime are still missing, so isolated Hermes acceptance and production readiness remain blocked. The local release is validated against the integrated master tree but is not pushed, deployed, migrated or approved for activation.
