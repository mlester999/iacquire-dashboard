# Internal AI Workforce: production preflight snapshot

Checked: 2026-10-24 (Asia/Singapore). This is a read-only snapshot, not a production release or activation approval.

## What the checks established

- The hosted migration ledger has migrations through `0086_lead_scoring`; the workforce tables and RLS hardening migrations `0077`–`0081` are applied, with their expected tables, columns and policies present. No local migrations through `0086` were pending in the read-only preflight.
- The production company profile has all four required facts: business description, products/services, ideal customers and operating area. The readiness audit printed only completeness counts, not the company text.
- One existing multiplexed Hermes gateway is connected. Its six mapped internal profiles authenticate and match their intended identity. The read-only Hermes audit verified the complete six-tool inventory (`memory`, `session_search`, `todo_list`, `vision_analyze`, `web_extract`, `web_search`) across the five reviewed toolsets, with no restricted tools currently enabled. It did not start a model run or change a profile.
- Gateway capabilities advertise runs, events, status, stop and approval. The API reports `admin_config_rw: false` and no memory write API, so it cannot verify or update the effective deployed SOUL instructions.
- `WORKFORCE_SCHEDULES_ENABLED`, `WORKFORCE_TRIGGERS_ENABLED`, `WORKFORCE_BRIEFINGS_ENABLED` and `WORKFORCE_WORKER_ENABLED` were all false in the preflight process. No autonomous workforce processing was enabled.

## Internal employee state

| Employee | Saved config | App readiness | Profile / inventory evidence | Chat |
| --- | --- | --- | --- | --- |
| Zeng (Operations Manager) | v4 applied; field audit has one incomplete field, employee name | 6/6 | Current identity, health, inventory and acknowledgement | Available |
| Lead Hunter | v1 applied; configuration audit complete | 6/6 | Current identity, health, inventory and acknowledgement | Available |
| Appointment Setter | None; safe preview 7/7 | 0/6 | Live Hermes identity/inventory pass; saved app check is stale and marked restricted | Unavailable |
| Sales Assistant | None; safe preview 7/7 | 0/6 | Live Hermes identity/inventory pass; saved app check is stale and marked restricted | Unavailable |
| CRM Manager | None; safe preview 7/7 | 0/6 | Live Hermes identity/inventory pass; saved app check is stale and marked restricted | Unavailable |
| Performance Analyst | None; safe preview 7/7 | 0/6 | Live Hermes identity/inventory pass; app has no saved inventory digest and the saved check is stale/restricted | Unavailable |

The configuration previews used the existing role defaults and saved company facts. They did not save or apply any configuration. The live Hermes audit is a separate current read from the portal's saved check rows; its successful inventory result has not been written back as employee readiness evidence.

## Activation blockers

1. Apply reviewed initial configurations for the four employees through the guarded Configure/versioning path.
2. After each configuration is applied, perform the application's profile-specific health and complete-inventory check, then the current profile identity check.
3. Have an authorized Super Admin review and record the existing Full Hermes Capabilities acknowledgement for each profile. No acknowledgement was created by these checks.
4. Obtain host-side verification of the effective role-specific SOUL instructions. The current Hermes API cannot attest to the loaded instructions, and no Hostinger configuration was read or changed during this preflight.
5. Identify the exact running application SHA before proposing a production deployment. The repository's current `origin/master` is `36bf78c`, but this check did not establish that it is the deployed SHA.

The existing six profile identities were preserved. No profiles were created, no employee configurations or readiness rows were changed, and no research, outreach, CRM mutation or appointment booking was started. The Hermes live audit appends its normal `credential.resolved` audit records while resolving credentials; the database readiness audit itself performs only `SELECT` queries.

A second targeted, read-only database check confirmed that the supplied Lead Hunter work job and
Hermes run are still completed, the request has 10 results, and 10 lead records remain linked to
that request. The eight historical web tool-call events cited in the project brief were not
re-read from a separate Hermes event source.

## Release / approval boundary

The local code branch is based on `36bf78c` and contains a new read-only all-six readiness audit at `scripts/internal-workforce-readiness-audit.ts`. Completed appointment availability now links to the existing guarded booking flow. Local acceptance: 13 files, 158 tests passed; app and script TypeScript checks passed; ESLint passed on all changed code; and Next.js 16.4.2's Webpack production build completed. The default Turbopack build could not resolve dependencies through the isolated worktree's external `node_modules` link. These are local results, not production acceptance.

A production request must bundle the exact deploy SHA and reviewed configuration versions with the authorized profile health/identity checks, Super Admin acknowledgement, host-side SOUL attestation, backup/rollback references and a bounded acceptance plan. Until that package is explicitly approved and completed, the four employees remain unavailable in the application. Keep all schedule, trigger, briefing and worker switches off.
