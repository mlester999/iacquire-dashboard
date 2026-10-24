# Internal AI Workforce: production preflight snapshot

Checked: 2026-10-24 (Asia/Singapore). This is a read-only snapshot, not a production release or activation approval.

## What the checks established

- The application migration ledger records `0080`, `0081`, `0082`, `0083`, `0085` and `0086`; `0084_restricted_hermes_provisioner` is absent even though `0085` and `0086` are present. The Supabase CLI ledger table is absent. The focused query was read-only. Migration `0084` is now integrated locally and a PGlite regression test confirms it applies after `0086`; production still needs an approved migration review and application.
- The production company profile has all four required facts: business description, products/services, ideal customers and operating area. The readiness audit printed only completeness counts, not the company text.
- One existing multiplexed Hermes gateway is connected. Its six mapped internal profiles authenticate and match their intended identity. The read-only Hermes audit verified the complete six-tool inventory (`memory`, `session_search`, `todo_list`, `vision_analyze`, `web_extract`, `web_search`) across the five reviewed toolsets, with no restricted tools currently enabled. It did not start a model run or change a profile.
- Gateway capabilities advertise runs, events, status, stop and approval. The API reports `admin_config_rw: false` and no memory write API, so it cannot verify or update the effective deployed SOUL instructions.
- A later read-only Hostinger hPanel check confirmed VPS `srv2039372.hstgr.cloud` and the Hermes Agent application were running (`v0.21.5`). The Hermes dashboard listed the default profile and all six iAcquire employee profiles; each employee profile showed `Gateway running`.
- `WORKFORCE_SCHEDULES_ENABLED`, `WORKFORCE_TRIGGERS_ENABLED`, `WORKFORCE_BRIEFINGS_ENABLED` and `WORKFORCE_WORKER_ENABLED` were all false in the preflight process. No autonomous workforce processing was enabled.
- A read-only Vercel recheck resolved `www.iacquire.online` to production deployment `dpl_J9rkGmZPTEbwsw24iB7bYsiyJzqR` (`READY`). Its Git metadata identifies `36bf78c40f73148fe1d25787a9eba5eb9709c64d` on `master`, matching `git ls-remote origin refs/heads/master`. The local workforce branch is not deployed.

## Additional Hostinger UI read

On 2026-10-24, the profile editor was used only to read the saved SOUL text for the shared `default` profile and all six employee profiles: Performance Analyst, Appointment Setter, CRM Manager, Lead Hunter, Operations Manager and Sales Assistant. Each employee file showed the matching role name and the shared `iAcquire policy (2026-10-21.1)` block, including approval requirements, truthful status reporting, no cold or bulk outreach, and human escalation for unclear or risky requests. The shared default profile contains a short Hermes response-style instruction.

This confirms the text currently rendered by Hostinger's profile editor. It does not prove that the running gateway has loaded those exact contents, that the files have the intended owner or mode, or that a profile reload occurred. No profile was activated, edited, saved, or restarted during the check.

## Internal employee state

| Employee | Saved config | App readiness | Profile / inventory evidence | Chat |
| --- | --- | --- | --- | --- |
| Zeng (Operations Manager) | v4 applied; field audit has one incomplete field, employee name | 6/6 | Current identity, health, inventory and acknowledgement | Available |
| Lead Hunter | v1 applied; configuration audit complete | 6/6 | Current identity, health, inventory and acknowledgement | Available |
| Appointment Setter | None; safe preview 7/7 | 0/6 | Live Hermes identity/inventory pass; saved app check is stale and marked restricted | Unavailable |
| Sales Assistant | None; safe preview 7/7 | 0/6 | Live Hermes identity/inventory pass; saved app check is stale and marked restricted | Unavailable |
| CRM Manager | None; safe preview 7/7 | 0/6 | Live Hermes identity/inventory pass; saved app check is stale and marked restricted | Unavailable |
| Performance Analyst | None; safe preview 7/7 | 0/6 | Live Hermes identity/inventory pass; app has no saved inventory digest and the saved check is stale/restricted | Unavailable |

The configuration previews used the existing role defaults and saved company facts. They did not save or apply any configuration. The local Configure screen now offers a first-config draft for each unconfigured internal role; it fills known role defaults and keeps unknown company details blank. The draft remains unsaved until the normal guarded review/save path. The live Hermes audit is a separate current read from the portal's saved check rows; its successful inventory result has not been written back as employee readiness evidence.

## Activation blockers

1. Apply reviewed initial configurations for the four employees through the guarded Configure/versioning path.
2. After each configuration is applied, perform the application's profile-specific health and complete-inventory check, then the current profile identity check.
3. Have an authorized Super Admin review and record the existing Full Hermes Capabilities acknowledgement for each profile. No acknowledgement was created by these checks.
4. Obtain host-side attestation of the effective, loaded role-specific SOUL instructions and file permissions. The Hostinger UI read confirmed the saved SOUL text, but the Hermes API cannot attest to the loaded instructions or file modes.
5. Recheck the running SHA when assembling any later production release package, and identify its exact target SHA. The current production SHA is now verified as `36bf78c40f73148fe1d25787a9eba5eb9709c64d`; local candidate commits remain undeployed.

The existing six profile identities were preserved. No profiles were created, no employee configurations or readiness rows were changed, and no research, outreach, CRM mutation or appointment booking was started. The Hermes live audit appends its normal `credential.resolved` audit records while resolving credentials; the database readiness audit itself performs only `SELECT` queries. The subsequent Hostinger UI check was also read-only.

A second targeted, read-only database check confirmed that the supplied Lead Hunter work job and
Hermes run are still completed, the request has 10 results, and 10 lead records remain linked to
that request. The eight historical web tool-call events cited in the project brief were not
re-read from a separate Hermes event source.

## Release / approval boundary

The local branch is based on `36bf78c` and contains the read-only all-six readiness audit, guarded appointment booking and appointment-change handoffs, safe first-config drafts for the four unconfigured roles, and the restricted client provisioner integration. Migration `0090_workforce_appointment_changes` and its new approval kind remain local. The branch is not deployed, and these capabilities do not change the four employees' production readiness or availability. The full local regression and release-gate results are recorded in [verification-status.md](verification-status.md). The linked GitHub sandbox run is synthetic evidence only; it does not establish production client provisioning or internal employee activation.

A production request must bundle the exact deploy SHA and reviewed configuration versions with the authorized profile health/identity checks, Super Admin acknowledgement, host-side SOUL attestation, backup/rollback references and a bounded acceptance plan. Until that package is explicitly approved and completed, the four employees remain unavailable in the application. Keep all schedule, trigger, briefing and worker switches off.
