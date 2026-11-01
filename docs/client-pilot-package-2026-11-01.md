# Supervised pilot: one real client, six employees (prepared 2026-11-01, not started)

**Status: prepared for a separate approval. Nothing here has been run on production, and nothing in this file starts it.** It turns section 2 of `client-provisioning-dependencies-2026-10-31.md` (item 7) into a checklist that can be approved, stopped and audited. The application side it relies on is described in section 0 of that file and is verified locally on synthetic clients; the client-only Hermes runtime it needs is **NOT RUN** anywhere.

## Preconditions (each is a decision for the founder, not for the build)

1. **A friendly client** who agrees in writing to a supervised trial, with no customer-facing automation. Test mode for their setup payment first.
2. **The client-only runtime exists** beside the internal gateway: restricted provisioner installed unprivileged, pinned image reviewed, capacity and placement decided (the last recorded headroom was about 6 GiB with no swap; six profiles per client), and the 0.21.x to 0.22.x security assessment done. Each is its own approval (section 2, items 1 to 5).
3. **Backups and a way back.** Confirm that the hosted database tier's backup and restore coverage is adequate before a real client's data goes in, or record the founder's explicit acceptance of the gap.
4. **Release.** The application commit that carries the launch readiness work is on `master` through the usual separate release approval. No migration is part of it.
5. **A named person watches** the whole run and can pause employees (the pause switches already exist).

## Sequence

1. Create the client workspace and complete the questionnaire as the client would. Expect: **Questionnaire submitted**, no provisioning job.
2. Record the setup payment (test mode). Expect: exactly the plan's provisioning jobs, once.
3. Watch each profile: the worker leaves its profile and key, the portal's own health check verifies identity, capabilities, restricted toolsets and the complete stable inventory. Expect each employee **Ready** only after that check; a failure shows as **Failed**, names iAcquire as the one to act, and creates no second job.
4. The client walks the panel on **/setup**: choose a host, use or set weekly hours, activate the calendar. Expect the public booking page to stay off.
5. The final checks start by themselves for every ready employee. Expect **100% Ready to Launch** only when all pass. A check that fails names what is missing.
6. Do not turn on customer messaging, the booking page or any automation as part of the pilot. Those are separate, per-workspace decisions after it.

## What to record, and when to stop

Record per employee: the profile name, the soul digest, the inventory digest, the provisioning job's attempts, the health observations and the final check's job. Stop and pause the employees on any of: a profile that is not the one expected for that client and role; any record or instruction from another workspace; a verification that reads Ready while a check failed; a message sent or a booking made that nobody asked for; a repeated failed health check; a worker that holds a lease past its expiry. Pausing does not delete anything; the client's data and configuration stay as they are.

## Rollback

Pause the six employees (reversible) and leave the workspace as it was. Removing the client's profiles from the runtime is not automated: the provisioner handles provision and sync only (the deprovision job kind exists in the database but no worker acts on it), so taking a pilot client's profiles off the runtime is a manual step that needs its own approval. The application release is a fast-forward and can be reverted like the earlier ones. No migration is involved, so there is nothing to undo in the database.
