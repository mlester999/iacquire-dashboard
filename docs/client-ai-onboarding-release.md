# Client AI workforce onboarding release

Status: implementation and local acceptance on `codex/client-ai-onboarding`. **Not deployed or pushed.** No production profile, credential, SOUL, migration or customer resource was changed by this release preparation.

## Client path

1. An agency creates the client workspace and invites its owner. Six tenant-scoped employee records already exist, initially without Hermes profiles or live access.
2. The verified owner saves and resumes the existing adaptive six-stage business questionnaire. Website-derived suggestions and sensitive business answers still require confirmation. The final submission saves the company profile and approved knowledge.
3. The approved platform model proposes only four bounded communication-style fields for each employee. Invalid, risky, identical or unavailable model output falls back to named deterministic role defaults. Confirmed onboarding answers and approved tenant knowledge supply business facts. The model cannot provide pricing, policies, services, contact details, permissions or credentials.
4. The existing guarded version path applies safe configurations and holds risky ones for agency review. The compiled request layers client style and business context beneath immutable policy. Each employee has distinct personality, behavior, procedures, responsibilities, reporting and role answers. Missing operational facts stay missing.
5. Six idempotent provisioning requests appear in the client detail queue for an eligible, verified, non-demo client. An agency manager may claim a bounded manual setup attempt and use the role-specific runbook. Client profile creation remains **operator controlled** until an authenticated restricted host provisioner is installed and verified.
6. On completion, the client sees six persisted states and a real ready count. Chat links appear only after the existing readiness gate accepts an applied configuration, current credential, authenticated identity, complete safe tool inventory and a passing health check. External booking and messaging still require their own verified connections; the optional maintenance plan does not gate core chat.

The Manage AI Employee screen exposes all generated style fields. Regeneration produces a preview; applying it to a draft requires an explicit click, and saving follows the guarded version path. Later business updates refresh untouched shared fields and knowledge while preserving recorded manual overrides across repeated submissions.

## Hermes boundary and effective instructions

The deployed Hermes API supports profile-scoped runs, identity, capabilities and tool-inventory checks. It does **not** expose authorized profile creation, SOUL writes or effective SOUL reads. Therefore this branch does not pretend to provision a remote profile or verify a running SOUL. The agency runbook creates a blank dedicated profile with `--no-alias --no-skills`, never clones another profile, replaces the whole role-specific SOUL, supplies a SHA-256 for host-side file verification, restricts exposed tools, uses a unique API key, and requires a live role and identity check. Its activation step now waits for a verified profile-specific host procedure instead of restarting the whole gateway. The current portal health check verifies identity and complete runtime tool inventory, but it cannot certify which SOUL text the running process loaded. The least-privilege host service contract and proof gate are in [hermes-restricted-provisioner.md](hermes-restricted-provisioner.md). A host-side provisioner with authenticated result attestation is needed before automatic production activation and a 6/6 claim.

Profile names contain a stable tenant-slug digest and the full role suffix, preventing truncation collisions between long slugs or roles. Existing mapped profile names are retained.

## Read-only prerequisite audit

Against the authoritative hosted database on 2026-10-21, migrations 0077–0080 were applied and **0081 was pending**. Agency Operations Manager and Lead Hunter had applied configuration and passing recorded health; Appointment Setter, CRM Manager and Sales Assistant remained setup-required and unconfigured; Performance Analyst remained provisioning and unconfigured. Lead Hunter's saved readiness audit reported 6/6 checks for authorized work, but no live run or effective SOUL proof was performed. The prior all-six activation is incomplete. Do not integrate this branch into production until that dependency is resolved.

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

Resolve any rows deliberately before applying 0082. Apply 0081 first, then 0082, then deploy the application only after an approved production change. The down migration removes the new columns and indexes; rolling back the application build first avoids queries against removed columns. Preserve job/audit history before any rollback.

Production activation requires: prior six-agency release and SOUL remediation verified, approved host access and installed Hermes version inspected, a supported restricted profile provisioner or explicit authorized manual host workflow, distinct profile keys, actual host SOUL hash and profile-specific activation role checks, portal identity/inventory/health checks, required agency approvals, two tenant-isolation smoke clients, and a user-approved production deployment. No new production resources or migrations were created during this work.

## Release gate

- `npx vitest run --maxWorkers=2 --reporter=dot`: 286 files passed; 4,524 tests passed, 8 skipped. Focused onboarding/employee tests were rerun after the final edits (40/40 passed).
- `npm run typecheck`: passed, including script TypeScript.
- `npm run build`: Next.js 16.4.2 production Turbopack build passed after installing dependencies directly in the isolated worktree. The first attempt failed only because Turbopack would not resolve the shared `node_modules` junction outside the worktree root.
- `npm run lint`: exit 0; two existing warnings remain in calendar files outside this change. The new test-file warning was removed and its targeted lint passed.
- `git diff --check`: passed. The release commit SHA is reported with the handoff rather than embedded in its own commit.
