# CRM provider switching

Status: **implemented locally** (Phase 6, package B). Migration `0039_crm_provider_switch.sql` has not been applied to the hosted database. Like
0027–0038, the hosted run needs the user's explicit approval.

A workspace's CRM is split into capabilities. Each capability has exactly one owner, either iAcquire's own CRM ("native") or GoHighLevel:
`CRM_CAPABILITIES` in `src/lib/crm/types.ts`, with contacts, companies, tags, custom fields, pipelines, opportunities, calendars, appointments,
conversations, automations (`workflows`) and reporting.

Provider switching moves the ownership of chosen capabilities from one system to the other. It runs as a guided switch with a preview, a
backup, a dry run, a cutover, a verification, and a way back. Two systems never act on the same record while it runs, or afterwards.

- Service: `src/server/crm/provider-switch.ts`
- Small shared checks: `src/server/crm/provider-guard.ts`
- Client-safe constants: `src/lib/crm/provider-switch.ts`
- Actions: `src/app/actions/crm-provider-switch.ts`
- Backup download: `src/app/api/crm/provider-switch/backup/route.ts`
- UI: Settings → CRM Provider (`/crm/settings/provider`, and the agency's view of it in a support session). The wizard is in
  `src/components/crm/provider-switch/`.
- Tests: `tests/crm-provider-switch.test.ts`

## The seven steps

1. **Choose** the capabilities and the direction.
   - **Move to iAcquire** (`native`): contacts, companies, tags, custom fields, pipelines and opportunities bring their records with them,
     through wave A's GoHighLevel migration (`docs/ghl-migration.md`). Calendars, appointments, conversations, automations and reporting
     move as ownership only. The migration doesn't support their records, so they are set up in iAcquire afterwards.
   - **Hand back to GoHighLevel** (`ghl`): ownership only. iAcquire stops acting on those capabilities, and its records stay in iAcquire,
     read-only. Nothing is deleted here and nothing is ever written to GoHighLevel. The UI says so at every step.
   - When a capability's records point at others, those move too, and the preview says so. Contacts carry tags and custom field values;
     deals carry pipelines, contacts and custom fields. The rule is `requiredForNative`, derived from wave A's `GHL_PREREQUISITES`.
   - When a prerequisite is already iAcquire's but was never imported, its step runs too (`alsoImported`).
2. **Preview** (`previewSwitch`) changes nothing. Per capability, it shows:
   - the owner now and after;
   - iAcquire's record count;
   - GoHighLevel's count, from wave A's `planGhlMigration` (GET requests to the official host only);
   - what depends on it: workflows, forms, campaigns, follow-ups, assignment rules, webhooks, Smart Lists, Blueprints, booking pages,
     calendar connections, channels, queued messages, and the GoHighLevel copies shown read-only.

   It also lists:
   - what pauses during the switch, with counts;
   - what is imported, in order, with counts;
   - what can't come across (wave A's `GHL_NOT_MIGRATED`, plus the unsupported custom field types);
   - blockers, such as no GoHighLevel connection for an import or hand-off, a token GoHighLevel refused, another switch in progress, or nothing to move;
   - warnings, such as capabilities that stay in iAcquire but use one handed to GoHighLevel.

   No switch row, job or ownership change is written. The only rows written are wave A's own audit entry for the preview.
3. **Back up** (`backupBeforeSwitch`) builds the offboarding export (`buildExport` in `src/server/offboarding/export.ts`), the same archive
   a client gets when leaving.
   - The archive is stored in `crm_provider_switch_backups` with its SHA-256 and table counts.
   - That table has row-level security on, no policy, and no grant to any application role, so only trusted server code reads it.
   - The switch row records the plan (counts only) and the ownership snapshot, and points at the backup by id.
   - Only the workspace owner can download the backup (`downloadSwitchBackup`, member actors with `data.export`). An agency session never
     can, because exports stay with the client. Each download is audited.
   - Nothing about ownership changes yet.
4. **Dry run** (`startSwitchDryRun`) creates wave A's import jobs for the plan's steps with the switch's id
   (`createGhlImportJob(actor, { entity, switchId, duplicates })`).
   - Each job reads its records (GET only) and checks them. Nothing is written to the CRM, and GoHighLevel still owns everything.
   - A step already running in the migration panel blocks the dry run, with the reason.
   - A stopped step can be read again (`retrySwitchStep`). During the dry run a step already checked can be read again too: the checked
     read is cancelled and a fresh one replaces it.
   - Each step shows when it was read. A read older than a day (`SWITCH_READ_MAX_AGE_MS`) is marked "too old to cut over", and the
     wizard offers to read those steps again.
   - The switch is checked again after each step is created: a step created in the moment the switch was cancelled (in another tab, or
     by the agency helper) is cancelled at once (`crm.provider.switch_step_dropped`), and the scheduler cancels any such step it finds.
   - A switch that moves only ownership has nothing to read and goes straight to the cutover.
5. **Cut over** (`cutoverSwitch`) is refused until every step's dry run validated. It is also refused:
   - if the GoHighLevel location mapping was disabled after preview or backup; this check runs for every hand-off to GoHighLevel, even an
     ownership-only switch with no import steps;
   - when a step's read is older than a day: GoHighLevel's forms and automations keep creating records, and the import brings only what
     was read ("The contacts were read 7 days ago; read them again before cutting over...");
   - while a run outside the switch (Settings → Imports & Exports) of one of its steps, or of a step they depend on (required or optional,
     as wave A's `startGhlImport` checks), is still reading, waiting, importing or being undone. It would hold an import half way with
     automations paused.

   The cutover dialog says what the import holds: the records as read at that time, and nothing added in GoHighLevel afterwards.

   Then **one transaction**:
   - locks the workspace;
   - snapshots the ownership as it is;
   - writes an **explicit owner for every capability**: the moving ones get the destination, with `sync_policy = 'import_only'` when their
     records come across, and the rest keep their current owner. In hybrid mode, a capability without a row would otherwise fall back to
     native by default;
   - sets `mode = 'hybrid'` and `switching = true`;
   - records the before/after snapshot;
   - audits `crm.provider.switch_cutover_started`;
   - notifies the owners and admins.

   After the commit, the imports start in `GHL_MIGRATION_ENTITIES` order: custom fields, tags, pipelines, companies, contacts, then opportunities.
   - Each step starts only after the one before it finished (`startGhlImport`).
   - When an earlier step finished after a step's dry run, wave A repeats that dry run (`recheck`) and the next pass starts it.
   - When a run outside the switch holds a step (an admin read a step again in the panel mid-cutover, say), the switch's error names that
     run and where it is ("cancel it there, or roll the switch back"), and the owners and admins are notified. A switch step cancelled from
     the panel says so, and can be read again here.
6. **Verify** runs when every step is imported (`computeVerification`, also available as `verifySwitch`). Per step:
   - GoHighLevel's count against what was read ("reported", or "listed" from the whole list; "at least" means reading stopped early, which
     is an issue);
   - every read record accounted for: mapped, skipped, failed or held for review;
   - nothing failed and nothing held for review;
   - the destination still holds what was mapped;
   - **sample checks** of up to 20 mapped records per step, a fixed spread per switch. Each sampled record must be live, its GoHighLevel link
     (`crm_external_ids`) must point at it, and its email (contacts) or name (everything else) must match what GoHighLevel sent;
   - **a recount of GoHighLevel now** (wave A's `planGhlMigration`, GET requests only). The count GoHighLevel gave at read time always
     agrees with what was read, so it can't catch records created since. When GoHighLevel now holds more than were read, that is an issue
     ("Contacts: GoHighLevel now has 1 more than were read (read …). Read the rest to bring them over."). When it can't be recounted
     (rate-limited, refused, unreachable), that is an issue too: it never passes silently.

   Ownership must be exactly what the cutover set. Counts only; nothing is changed. Any issue leaves the switch waiting for the owner.

   **Read the rest** (`readRestOfSwitchStep`) is offered per imported step while the switch waits for review, and after it completed (as the
   latest switch). It reads that step from GoHighLevel again and imports what is new, inside the switch (same `switch_id`), so a rollback
   undoes it with the rest. Records already here are matched through `crm_external_ids`, never copied twice. The switch cuts over again
   for it: `switching` is on while the step is read and imported, then the verification runs again. It is refused while another switch
   is in progress, after a later switch, or while a run outside the switch holds the step. It holds the worker lease until the new job is
   committed and rechecks the switch state afterwards; a job created after a stop is cancelled before it can hold another import. The
   read-rest initiator is recorded separately and is used for the import/completion audit. Rollback waits for an in-flight cutover step to
   release its lease. Going through the migration panel instead would
   put the run outside the switch, which then blocks the switch's rollback (below).
7. **Complete or roll back.**
   - **Complete** (`completeCutover`):
     - A clean verification completes the switch by itself.
     - With issues, the switch waits as "Needs your review" and automations stay paused. The owner either completes anyway (`acknowledge`,
       recorded as `acknowledged_issues`) or rolls back.
     - Completing turns `switching` off and sets the mode: `native` when iAcquire owns everything, `ghl` when GoHighLevel does, otherwise
       `hybrid` with the explicit owners. The rows stay, as the record of what a switch decided.
   - **Roll back** (`rollbackSwitch`) works for a switch that cut over, is waiting for review, or completed. Only the latest switch of a
     workspace can be rolled back.
     - It is refused up front, before `switching` goes on, when wave A's undo would refuse one of the switch's steps half way:
       a run of the step outside the switch, newer than the switch's run, with something to undo (runs of a step are undone newest
       first); or a run outside the switch of a step pointing at its records (contacts at tags). The message names the run, its date and
       Settings → Imports & Exports. Without this, the rollback would hold every automation in the workspace until someone found out.
     - If such a run appears after the rollback started, the stored error says where to undo it and the owners and admins are notified
       once; the rollback continues by itself afterwards.
     - `switching` goes on again.
     - Every job of the switch that is still reading, checking, waiting or importing is stopped (`cancelImportInTx`).
     - A job that stopped part way through importing is marked cancelled, so what it imported can still be undone.
     - Then `rollbackGhlImport` runs on each job in reverse step order, newest first. Wave A's undo keeps every record changed since the import,
       or still used, as `needs_review` and never drops it.
     - Finally the ownership snapshot from before the cutover is restored exactly: mode, rows and `owner_since`. `switching` goes off.
     - The report lists, per step, what was undone and what was kept. `getSwitchReviewRows` lists the kept records with the reason.
     - Records added in iAcquire after the cutover (contacts, companies, deals, appointments) are counted. A rollback never removes them.

A switch can be cancelled before its cutover (`cancelSwitch`): its dry-run jobs stop, nothing about ownership changes, and the backup is kept.

### Statuses

`crm_provider_switches.status` takes these values:

- `backed_up`
- `dry_run`
- `cutting_over`
- `verifying` ("Needs your review")
- `completed`
- `rolling_back`
- `rolled_back`
- `cancelled`

At most one switch per workspace is in progress (`backed_up`, `dry_run`, `cutting_over`, `verifying` or `rolling_back`). A partial unique
index enforces this.

### Who moves a switch forward

`advanceSwitchWork(switchId)` moves a switch forward a little each call: a dry-run chunk, the next import chunk, starting the next step, the
verification, or the next undo. It takes a two-minute lease on the switch row (`claimed_at`), so the wizard's polling (`advanceSwitch`) and the
scheduler can both call it safely.

The wizard's polling keeps going after a failed refresh (a server error, a restart, a dropped connection): each failure waits longer, up to
30 seconds, and the page says it is retrying. It stops, with the reason, only when the person's access is gone (signed out, permission
removed, switch not found).

The scheduler job `crmProviderSwitches` (`processProviderSwitches`, in `src/server/ops/tick.ts` right after `crmImports`) keeps a switch going
with the wizard closed. The worker acts as the server for the person who started the phase (`cutover_by`, `read_rest_by`,
`rolled_back_by`), and the audit names them.

A step that stops records the error on the switch and notifies the owners once. The switch then holds until someone reads the step again or
rolls back.

## Permissions

| Who | Preview / back up / dry run / cut over / complete / roll back / cancel | Download the backup | See the switch |
|---|---|---|---|
| Workspace owner (`crm.provider.manage`) | yes | yes (also needs `data.export`) | yes |
| Admin (manager), sales, setter, support, viewer | no | no | yes (read-only view) |
| Agency super admin, write support session | yes | no | yes |
| Agency staff or super admin, read session | no (no GoHighLevel request is made) | no | yes |
| Agency staff (can't open a write session) | no | no | yes in a read session |
| AI employees, API keys | no | no | no |

- The worker continues a cutover that was authorized, even when the owner changes mid-switch.
- Completion and rollback are authorized per call. The former owner is refused; the new owner can finish or roll back.

## Hybrid safety: every path that sends, books or acts

The rule is in `src/server/crm/provider-guard.ts`:

- **While switching**, everything that could act twice **holds** and continues afterwards; nothing is dropped.
- **When GoHighLevel owns a capability**, iAcquire's own automation for it **refuses or skips**, with the reason.
- **When a switch moved a capability to iAcquire**, the GoHighLevel-side path that acts for it refuses (`ghlPathRefusal`). "Moved" means a
  switch to iAcquire whose moved set (`crm_provider_switches.capabilities`, overwritten at the cutover with what actually moved) names it,
  and that wasn't rolled back or cancelled. An explicit owner row isn't enough: every cutover writes a row for all eleven capabilities,
  the untouched ones too. So capabilities no switch moved keep their earlier behaviour: a native workspace that hands only conversations
  to GoHighLevel still books its connected GoHighLevel calendar.
- **The conversations rule applies in GoHighLevel mode as well as in a hybrid**: while GoHighLevel owns conversations, iAcquire's own
  providers never send (otherwise both systems would message the same people). A native channel switched on in such a workspace is
  shown on Settings → CRM Provider ("… switched on with iAcquire's own providers, but GoHighLevel owns conversations here, so it doesn't
  send"), and the preview of a switch that hands conversations to GoHighLevel warns about the channels that stop sending. Refusing to
  switch such a channel on is enforced by the server. Channel settings show why sending is paused, and `ChannelStatus.ready` reports the
  ownership issue so API callers and the UI use the same decision (`nativeChannelRefusal` in `provider-guard.ts`).

The paths were found by searching for every sender (`queueOutbound`, `queueOutreach`, `evaluateSend`, `dispatchMessage`), every booking creator
(`bookNativeAppointment`, `requestBooking`, `executeBooking`, `requestNativeBooking`, `executeNativeBooking`), the calendar write-back, the
event dispatcher and its subscribers, and the workflow runner.

| Path | While switching | When GoHighLevel owns it |
|---|---|---|
| **All customer messages**: `src/server/messaging/send.ts` `evaluateSend` (used by `queueOutbound` and again by `dispatchMessage`). | Waits, keeping its credit hold (`provider_switching`, retried every 10 minutes; existing). A person's own send is refused with "wait". | **New:** conversations owned by GoHighLevel means iAcquire's own providers (Resend, Twilio, Meta) never send. The message is refused (`provider_owned`), and a queued one is blocked at dispatch, never sent. The GoHighLevel transport, which sends through the owner itself, is unchanged. |
| AI replies: `messaging/responder.ts` → `queueOutbound`. | As above. | As above. |
| Follow-up sequences: `messaging/followups.ts` `processDueFollowUps`. | **New:** due steps of a switching workspace aren't picked; they stay `scheduled` and go out afterwards. Other workspaces aren't crowded out. | Each step's send is refused (`provider_owned`). |
| Appointment reminders: `appointments/reminders.ts` → `queueOutreach` → `queueOutbound`. | Waits (send rule). | Refused (send rule). |
| Workflow `send_message`: `crm/workflows/executors.ts` → `queueOutreach`. | The run holds (runner, below). | Refused (send rule). |
| Retention programs: `retention/engine.ts` → `queueOutreach`. | Waits (send rule). | Refused (send rule). |
| Campaigns: `crm/campaigns/job.ts`. | Waits in place, workspace-wide (`waiting:provider_switching`, from the send rule; existing). | **New:** GoHighLevel owning conversations stops the campaign before anything is queued (notice `provider`). Contacts owned by GoHighLevel already stopped it. |
| Review requests: `crm/reviews.ts` → `queueOutbound`. | Waits (send rule). | Refused (send rule). |
| Template test sends and human replies: `crm/message-templates.ts`, `messaging/inbox.ts`. | Refused with "wait" (a person retries). | Refused with the reason. |
| Booking confirmations: `appointments/booking.ts`, `calendars/agent-booking.ts` → `queueOutbound`. | Waits (send rule). | Refused (send rule). |
| **Workflow runs**: `crm/workflows/runner.ts`. | Hold and wake again after 10 minutes (existing `isSwitching`). | Hold, "managed in GoHighLevel" (existing `assertNativeOwner('workflows')`). |
| Workflow definitions (held reason shown): `crm/workflows/definitions.ts`. | Existing. | Existing. |
| **Event dispatch** (workflow triggers, lead assignment, follow-up stops, outbound webhooks): `crm/dispatch.ts` claim. | **New:** a switching workspace's events aren't claimed; no attempt is counted, so they can't dead-letter. They're dispatched once each afterwards. A claim made just before a cutover is checked again when the event is handled, under a key-share lock on the workspace row (the cutover and rollback lock it for update first, so neither commits while an event is handled); a switching workspace's event is handed back unhandled, with no attempt counted. Events the migration wrote are already marked dispatched, so they never run. | Each subscriber checks its own owner (existing). |
| Outbound webhook deliveries already queued: `crm/webhooks.ts` `deliverDueWebhooks`. | Delivered (they describe events from before the switch; nothing new is queued while switching). | n/a |
| **Native booking**: `calendars/booking.ts` `bookNativeAppointment`, `reschedule…`, `cancel…`, `setNativeAppointmentStatus`. Callers: public booking pages (`calendars/public-booking.ts`), website booking (`sites/booking-trusted.ts`), staff (`app/actions/crm-scheduling.ts`), the AI (`calendars/agent-booking.ts`). | People keep booking. | Refused (existing `assertNativeOwner('appointments')`). |
| **AI bookings**: `appointments/booking.ts` `requestBooking` (GoHighLevel calendar) and `calendars/agent-booking.ts` `requestNativeBooking`. | **New:** an AI booking that would go straight in waits for a person's approval instead. | Native: refused (above). |
| **GoHighLevel-calendar booking**: `appointments/booking.ts` `requestBooking` / `executeBooking`. | — | **New, the other direction:** once a switch gave iAcquire the appointments (explicit native owner), GoHighLevel's calendar takes no new booking from iAcquire, and an approval decided earlier isn't written to GoHighLevel. The time is released with the reason. |
| **Calendar write-backs**: `calendars/sync.ts` `writeBackDue`. | **New:** nothing is written to Google or Microsoft calendars; the writes stay pending. The rule is checked when a connection is leased, again before it is opened (a lease taken just before a cutover is given back, with no failure counted), and before each appointment is written. A write already sent can't be called back, so at most the one in flight finishes after the cutover. | **New:** calendars owned by GoHighLevel means iAcquire writes nothing to outside calendars; the writes stay pending. |
| Calendar setup and connections: `calendars/setup.ts`, `connections.ts`, `activation.ts`. | People keep working. | Refused (existing `assertNativeOwner('calendars')`). |
| Pipelines and opportunity moves: `crm/pipelines.ts`, `crm/opportunities.ts`, workflow `move_stage`, agent tools. | People keep working (workflow moves hold with their run). | Refused (existing `assertNativeOwner`). |
| Contacts, companies, tags, custom fields, imports, agent tools, the public API. | People keep working. The import runs only for capabilities already moved. | Refused (existing `assertNativeOwner`). |
| Blueprint apply: `crm/blueprints/apply.ts`. | Refused while switching (existing). | Refused (existing). |

### Resuming

Paused work resumes by itself once `switching` is off:

- events and follow-ups resume on the next tick;
- workflow runs, held messages and waiting campaigns resume within 10 minutes (their own retry);
- calendar write-backs resume on the next write-back pass.

Nothing is re-dispatched twice. Migration events are already marked dispatched, and every subscriber is idempotent.

### Screens

- **Contacts:** when GoHighLevel owns contacts, the contacts screen shows the "managed in GoHighLevel" notice. This was a gap found in the
  audit (§6). When iAcquire still holds contacts (for example after handing contacts back), they are listed read-only under a notice, with no
  editing controls.
- **Companies, opportunities and pipelines:** already had the notice.
- **Navigation:** the portal sidebar is capability-aware. Sections owned by GoHighLevel carry a “GHL” badge with a “Managed in
  GoHighLevel” label; their pages remain reachable and show the existing read-only ownership notices.

## Data model (0039)

- `crm_provider_switches` holds one row per switch, with:
  - the direction and capabilities, and the status;
  - `before_snapshot` and `after_snapshot` (mode, switching, every row with provider, sync policy and owner since);
  - `preview` (counts only: native counts, pause counts, the plan's steps, owners before and after);
  - `verification` and `rollback_report` (counts only);
  - `backup_id` and `backup_bytes`, `error`, `acknowledged_issues`;
  - who started each phase, the timestamps, and the lease (`claimed_at`).

  Customer data never goes in this row (the test checks for a contact's email and name). Members with `crm.view` may read it under
  row-level security (`crm_provider_switches_select`, rewritten by package R's 0040 for speed).
- `crm_provider_switch_backups` holds the backup ZIP (`bytea`, at most 256 MB), its SHA-256 and table counts. It is trusted code only.
- `crm_import_jobs_switch_fk`: `crm_import_jobs.switch_id` → `crm_provider_switches(id) on delete set null` (wave A added the column without
  a target).
- Rollback: `supabase/rollbacks/0039_crm_provider_switch.down.sql`. It refuses while any switch or backup is recorded, and leaves the
  workspace's ownership exactly as it is.

## Setup Center and setup guide

- Changing the mode or the owners re-scopes the Setup Center automatically (the 0037 triggers).
- Every switch step is audited as `crm.provider.switch_<step>`:
  - `backed_up`
  - `dry_run_started`
  - `cutover_started`
  - `needs_review`
  - `completed`
  - `rollback_started`
  - `rolled_back`
  - `cancelled`
  - `step_retried`
  - `step_stopped_for_rollback`
  - `step_dropped` (a step created for a switch that had just been cancelled or rolled back)
  - `read_rest_started`
  - `backup_downloaded`

  The setup guide's first-time provider choice (`providerChoiceLock`) locks on these entries, on the explicit owner rows, and on
  `switching`.
- Wave A's migration panel sends owners to "Settings → CRM provider" for the import. That is this wizard.

## Known limitations

- **GoHighLevel keeps creating records after the read and after the switch.** Nothing here stops GoHighLevel's forms, funnels and
  automations, and nothing may be written to GoHighLevel. The cutover refuses a read older than a day, the verification recounts
  GoHighLevel and holds the switch when it has more, and **Read the rest** brings them over. The owner should point lead capture at
  iAcquire (forms, booking pages, website) once the switch completes, then read the rest of what was created in the meantime. The wizard
  says so in the cutover, review and completed states.
- **Migration panel actions are locked during an active provider switch.** The panel is read-only and directs the owner to Settings → CRM
  Provider. Server checks also reject ordinary create, check, cancel, start and rollback requests while a switch is active. Only the
  provider-switch worker can operate on jobs linked to that switch.

- **Not run against a live GoHighLevel account** (by rule). The GoHighLevel side uses wave A's read-only migration and its caveats
  (`docs/ghl-migration.md`), such as the deprecated `GET /contacts/`.
- **The backup is built in the request that asks for it.** A very large workspace may take a while. Over 256 MB it is refused with a message
  to take the backup separately. Backups are kept until someone removes them deliberately; there is no automatic expiry.
- **A switch that waits for review keeps automations paused** until the owner decides. The owners and admins are notified.
- **Ownership-only moves to iAcquire** (calendars, appointments, conversations, automations, reporting) don't copy GoHighLevel's records; the
  migration doesn't support them.
- **Rolling back after more work happened** keeps that work in iAcquire, counted in the report, while GoHighLevel owns the capability again.
  It is visible read-only on the contacts screen, and as notices elsewhere.
- **Moving tags or custom fields to GoHighLevel while contacts stay in iAcquire** leaves those contacts unable to create tags or fields. The
  preview warns; it doesn't refuse.
- **Browser QA is local and synthetic.** The complete isolated browser matrix is recorded in [crm-local-qa.md](crm-local-qa.md) and
  `.data/crm-qa/report.md`. It previews the provider wizard but never confirms a cutover or contacts a real GoHighLevel account.
