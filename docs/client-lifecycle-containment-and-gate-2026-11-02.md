# Client lifecycle: containment, fleet synchronization and the customer-facing gate (Wave 8, 2026-11-02)

Everything here is built and tested on synthetic clients and a synthetic gateway, and everything that changes behaviour is OFF by default. Nothing has been applied to production, rolled out to the client runtime or switched on.

## 1. What exists

| Piece | Switch | Default | Proven by |
| --- | --- | --- | --- |
| Containment of a client employee's runtime profile (key replaced, tools switched off, nothing deleted) | `HERMES_PROVISIONER_DEPROVISION_ENABLED` (the portal hands the job to the worker only with it on) | off | `tests/hermes-provisioner-deprovision.test.ts` (16), `RevokeTests` in `services/hermes-provisioner/test_worker.py` (8) |
| Fleet synchronization (re-apply every provisioned employee's applied configuration) | none: it is an agency action, one job per employee, bounded to 200 a call | n/a | `tests/fleet-sync.test.ts` (5) |
| Containment at offboarding, and the deletion guard | the same switch for the request; the guard is always on | off / on | `tests/offboarding-runtime-profiles.test.ts` (6) |
| Customer-facing activity gate | `CLIENT_CUSTOMER_FACING_GATE_ENABLED` | off | `tests/customer-facing-gate.test.ts` (21) |
| Client role text digest and prompt budgets | none (tests and records only) | n/a | `tests/client-role-text-digest.test.ts` (4), `tests/client-prompt-budget.test.ts` (10) |
| Migration 0118: a purge can detach audit rows from a deleted employee | applied with the migrations | n/a | `tests/audit-purge-detach-migration.test.ts` (4) |

## 2. Containment

`requestDeprovision` (agency workforce permission, a Super Admin in the admin action, a reason of 5 to 500 characters kept in the audit log) opens one `deprovision` job for an employee whose profile the restricted worker made on the pinned gateway. It refuses an agency's or a demo's employee and one mapped from the internal tier, and then writes nothing. A request already open is returned, never doubled; an open setup or synchronization request is replaced.

The worker (`RestrictedProvisioner.revoke`) takes the profile lock, checks all five fields of the ownership marker, replaces the profile's key with a random one nobody is given, writes the no-tools configuration, and then waits for the gateway: containment is proven only when the NEW key is accepted and shows no enabled toolset AND the OLD key is refused with a 401. A gateway that keeps accepting the old key never gets a success (`revoke_not_applied`, retried later). The old key is kept in a private file of the worker's own state only until that proof, so an attempt interrupted after the key was replaced can finish. A retired profile reports the same success again without rotating anything. The profile directory, SOUL and marker stay: removing a profile is a separate, deliberate step that is not built.

Only after that proof does the portal, in one transaction, revoke the employee's own Hermes credential and its business-tool credentials, clear `hermes_profile`, `hermes_gateway_id`, `credential_id` and `hermes_base_url`, mark the employee not set up (or disabled, if it was switched off), and write one audit row. A claim for containment is deliberately lighter than a setup claim: a suspended workspace, a switched-off employee, a refunded payment and an emergency pause are reasons to hurry, never to wait. It still needs the pinned, verified, client-only gateway.

**Not proven, and to prove before the switch is turned on:** whether the real gateway re-reads a profile's key from its environment file without a restart. The worker fails closed if it does not (the job fails with `revoke_not_applied` and the old key is never reported dead), but the rollout then needs a restart window. The pinned-runtime test that answers it for the business-tool entry (Wave 9) should also answer it for the key.

**Rollout order (each its own approval):** (1) build and roll out a worker image that contains `revoke` to the client runtime, with the switch still off; (2) prove containment on a synthetic profile of the client runtime; (3) turn on `HERMES_PROVISIONER_DEPROVISION_ENABLED`. With the switch on, a shutdown asks for containment of every provisioned employee and records the result as a step; with it off, deletion refuses until each profile is contained or the agency writes down why it is being left (at least 10 characters), and that statement is kept in the audit trail (`offboarding.runtime_profiles_left`: the count, the profile names, the gateway).

## 3. A defect this found: no provisioned client could be deleted

Offboarding's permanent deletion deleted a client's employees and stopped: `audit_logs.agent_instance_id` is `ON DELETE SET NULL`, and setting a column to null is an UPDATE that the append-only rule on `audit_logs` refused. Every provisioned client has audit rows that name its employees, so "Deletion stopped because agent_instances could not be removed. Nothing was deleted." was certain for every one of them. Nothing was lost (the purge is all or nothing, and it has never been switched on in production).

Migration `0118_audit_logs_purge_detach` keeps the rule exactly as strict with one exception: while a purge has declared itself (`iaq.purge`, which only offboarding sets), an audit row may lose its pointer to an employee being deleted, and nothing else about it may change (the whole row is compared). The rollback restores the unconditional rule. It must be applied before any provisioned client is deleted.

## 4. The customer-facing gate

With the switch on, a CLIENT workspace may switch customer-facing activity ON only when the setup payment is cleared (paid or waived: the one definition) and, for the three calendar activities, when it has an active calendar that has passed every activation check. The agency's own workspace and demo workspaces are never held back; only a real OFF to ON change is judged, so switching off and saving anything else are never refused; a refusal writes nothing and says what to do ("Finish setup first: ...").

Gated: automatic replies (`updateMessagingSettings`); the website chat going live, plus the AI answering visitors and visitors booking through it while it is live (`saveWidgetSettings`); appointment reminders and letting the AI book (`savePolicy`); the public booking page (`setCalendarPublic`, and `updateCalendar` with `public`).

**Other places that make something reach customers, reported and NOT changed** (decide whether the gate should extend to them): publishing a website (`publishWebsite`), publishing a form (`publishForm`), publishing an automation workflow (`publishWorkflow`), scheduling a social post (`schedulePost`), sending a proposal (`sendProposal`), switching a retention program on (`setProgramEnabled`), switching a messaging channel on (`setChannelEnabled`, which already needs iAcquire's verified sender), CRM campaign sends and review requests.

## 5. Not done in this wave

**B7-P2 (database isolation hardening) is not implemented, on its own rule** (stop and report if it cannot be made green without weakening an existing test). Its trigger, which would forbid an agency employee on an attested client-only gateway, contradicts `tests/hermes-provisioner-attest.test.ts`, which builds exactly that state on purpose to prove the claim-time guard (`not exists` an agency employee on the gateway) and the attestation refusals. The same invariant is enforced at claim time and at attestation today. The composite same-tenant keys and the column-level grants on `agent_provisioning_jobs` are higher risk and are not needed for a supervised pilot; they need a production-data preflight first.

**Prompt budgets (see `docs/client-role-texts-review-2026-11-01.md`, section 5):** with the longest answers the questionnaire accepts, the Lead Hunter's per-run instructions are over the restricted worker's 20,000-character cap, and a chat message with the workspace snapshot added is over it for every role. Recorded as breaches in the tests, with options; a founder decision.
