# AI Growth Partner migration strategy

**Status:** development strategy; no live client migration or runtime revocation is authorized by this document.

## Compatibility boundary

- New client workspaces receive one `growth_partner` runtime and one linked `ai_growth_partners` identity. Their setup generator does not create the six legacy runtime roles.
- Existing six-role tenants remain unchanged by the foundation migrations. Their Hermes profiles, credentials, approved configuration versions, employee settings, job history, conversation history, work schedules, audit rows, and commercial entitlements remain attached to their current identities.
- Existing setup task rows are snapshots and are not rewritten by the new default template copy. New setup instances for legacy workspaces retain legacy task wording; new partner workspaces receive Growth Partner wording.
- Legacy onboarding submission does not create a Growth Partner identity as a side effect. A tenant moves to the new model only through a separate, reviewed migration operation.
- Existing subscriptions, setup payments, purchase records, optional maintenance terms, and usage protections are not changed by the product-model migrations.

## Staged migration for an existing tenant

1. **Inventory without changes.** Read the tenant's six runtime rows, enabled state, profile identifiers and hosts, credential bindings, health evidence, active and held configuration versions, Business Brain sources, chat/conversation records, schedules, queued/running jobs, Work Board history, permissions, integrations, and purchase entitlements. Record only identifiers and status in the migration report; never copy credentials into a new profile.
2. **Prepare a tenant-specific candidate.** Create the Growth Partner identity in a disabled or setup-required state. Draft one policy/configuration version from approved tenant knowledge and explicit owner choices. Preserve provenance and distinguish confirmed facts from suggestions and unknowns. Do not reuse another tenant's Hermes credentials, profiles, memory, or tool tokens.
3. **Review and connect.** An authorized owner reviews the proposed identity, Business Brain, permissions, capabilities, and any schedule mapping. Provision a new tenant-isolated Hermes profile through the approved provisioning process, then connect its own credentials and run actual health, tool-inventory, tenant-boundary, and permitted-action checks.
4. **Reconcile work before cutover.** Compare every old enabled schedule with the proposed schedule and work assignment. Identify in-flight jobs and their idempotency keys. Pause old schedules through the tenant's authorized controls, wait for or explicitly resolve active work, verify no equivalent job is due or already queued, then enable the new schedule only after the owner approves the cutover. Keep external outreach disabled unless separately authorized.
5. **Preserve continuity.** Keep the six historical identities, configuration versions, audit records, jobs, and conversation messages available as historical records. Do not concatenate six chats into the permanent Growth Partner conversation or expose one employee's private context to another. Add an explicit historical link or a reviewed summary with source references if the owner wants continuity.
6. **Verify and monitor.** Confirm one active Growth Partner identity and one authorized active profile for that tenant, current health evidence, expected CRM/calendar capability checks, correct job ownership, no duplicate active schedules, and no cross-tenant reads. Observe the tenant through an agreed acceptance window before closing the migration.
7. **Retire only with separate approval.** Deprovision or revoke an old Hermes profile only after the migration report and acceptance evidence are reviewed and the owner explicitly approves the exact tenant and profiles. Keep the immutable business/audit history. Never delete old profile records as a shortcut.

## Rollback

- Before cutover, rollback means discard the unapproved candidate and leave the original six roles active as they were.
- After cutover, rollback means pause the Growth Partner schedule and runtime, confirm no job remains in flight, and restore the previously approved legacy schedule and enabled state using the migration report. Re-enable old profiles only after checking their recorded configuration and permissions; do not restore a revoked credential or copy credentials across profiles.
- Keep both identity histories and append rollback events to the audit trail. Do not delete the Growth Partner or rewrite old conversation history.
- Schema rollback scripts restore only the fields introduced by their paired migration and should use exact-current-value guards where a template may have been manually edited. Tenant task snapshots and client data are not migration rollback targets.

## Release and approval boundary

Migration rehearsals and synthetic-tenant acceptance are development checks. They do not authorize production deployment, production database changes, a customer cutover, paid-provider use, customer messaging, payment changes, or Hermes profile revocation. Each production action still needs a separate, explicit approval naming the exact tenant, profiles, environment, and operation.

## Remaining acceptance evidence

The current development implementation has synthetic tenant and chat tests, plus migration rehearsal coverage. It does not yet prove migration against a real tenant runtime, external CRM/calendar providers, a production scheduler, or a customer-approved cutover. Those require a separately authorized staging or production acceptance run and must be reported as real provider evidence rather than inferred from a green setup badge.

## Current read-only inventory aid

The Super Admin client detail includes tenant-scoped record counts for retained role profiles, Hermes profile and credential references, configuration review state, approved and waiting company knowledge, retained knowledge documents, legacy conversation/message history, schedules, open and total Work Board jobs, open approvals, connected integration status rows, member permission overrides, workspace feature overrides, and the Growth Partner identity/permanent conversation. The snapshot is restricted to Super Admins with workforce access, returns no credential values or business content, and makes no changes. It does not validate runtime reachability, credential validity, Hermes memory, external provider state, paid entitlements, or schedule effects; it is not a full migration report and does not create a candidate or establish cutover readiness.
