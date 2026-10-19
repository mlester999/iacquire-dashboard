# CRM setup: the Setup Center on iAcquire CRM, and the client's CRM setup guide

Phase 6, package C. This covers two things:

1. The **Setup Center** (the agency's checklist at `/admin/clients/<id>/setup`, the client's at `/setup`) now works for a client on iAcquire's own CRM. Before this, every checklist assumed GoHighLevel, so a native client that bought the CRM service could never reach activation.
2. The **CRM setup guide** (`/crm/setup`, and `/admin/clients/<id>/crm/setup` for the agency) walks a client through setting up their CRM, one step per screen, with statuses taken from real records only.

Migration: `supabase/migrations/0056_crm_setup_native.sql`. Rollback: `supabase/rollbacks/0056_crm_setup_native.down.sql`. The hosted database is not migrated by this work; 0056 needs the same explicit approval as 0027–0033 and 0054–0056.

## 1. Setup Center on iAcquire CRM

### Steps that follow the CRM provider

A setup step can now be scoped to a CRM provider (`client_setup_tasks.crm_provider`: `ghl`, `native` or null for both). A step for a provider the workspace doesn't use is excluded exactly like a step outside the purchased services (`service_excluded`): it never counts for or against the client, the client never sees it, and steps that depend on it no longer wait for it (an excluded prerequisite never counts as unmet).

| Step | Scope | Effect |
|---|---|---|
| GHL sub-account created (`ghl_subaccount`) | `ghl` | Native clients never get it. GoHighLevel and hybrid clients keep it, and every step that depends on it (`crm_snapshot`, `calendar`, `integration_tests`) still waits for it. |
| SMS sender connected and tested (`sms_sender`) | `native`, `crm` service, optional | New. Verified only by a passed live capability test. Never blocks activation. A client without the CRM service (website only, say) doesn't get it. |
| WhatsApp sender connected and tested (`whatsapp_sender`) | `native`, `crm` service, optional | Same, for WhatsApp. |

Which providers a workspace uses (`app.setup_crm_uses`): native mode uses only iAcquire CRM, `ghl` mode only GoHighLevel, and a controlled hybrid uses iAcquire CRM plus GoHighLevel when at least one capability is owned there.

The scope follows the provider automatically. Changing `crm_workspaces.mode`, or a row of `crm_capability_providers`, fires a trigger that, in the same transaction:

- recomputes every step's applicability (`app.refresh_setup_applicability`);
- bumps the checklist revision, so open browsers refetch;
- records an internal `services_changed` event with `{ "reason": "crm_provider" }`;
- cancels a pending final review if a required, unfinished step now applies.

So client creation (the mode is recorded after the checklist is created), the guide's initial provider choice and a later provider switch all keep the checklist right without calling anything. `syncSetupApplicability(db, orgId)` in `src/server/setup/core.ts` does the same recomputation on demand, and `setServices` now uses it.

The CRM snapshot step's title follows whoever owns pipelines, the same signal that picks its check: "CRM snapshot installed" while GoHighLevel does (`ghl` mode, or a hybrid with pipelines on GoHighLevel), "CRM Blueprint applied" otherwise. `app.refresh_setup_applicability` swaps it, so this holds for checklists created after 0056 (`ensureSetupInstance` runs the same refresh) and after any provider change. Only the two default titles swap, and never on a completed step, an activated checklist or a title the agency renamed.

Existing checklists that aren't activated were updated by 0056: provider scopes set, the two sender steps added, and native workspaces given the new wording. Activated checklists keep their history exactly as it was.

**Rollout note (existing in-setup clients).** 0027 makes every existing client without a GoHighLevel location mapping native, including a client whose sub-account the agency was still creating. 0056 then excludes that client's "GHL sub-account created" step. Nothing is deleted: its status, notes, attachments and history stay, and the agency checklist still lists it (dimmed). For each such step that had progress (any status but pending, a note, a blocked reason, a completion note or an attachment), 0056 records an internal `services_changed` event on the step with `{"reason":"crm_provider","migration":"0037","template_key":"ghl_subaccount","status":…}`. To restore the step, the owner (or a super admin in a write support session) chooses GoHighLevel in `/crm/setup` while the CRM has no records; otherwise switch providers in Settings → CRM Provider. Before migrating a database that has clients, list the affected ones:

```sql
select i.org_id, t.status from client_setup_instances i
join client_setup_tasks t on t.instance_id = i.id and t.template_key = 'ghl_subaccount'
where i.state <> 'activated' and t.status <> 'pending'
  and not exists (select 1 from ghl_location_mappings m where m.org_id = i.org_id);
```

### Which check applies

`connectorsFor(db, orgId)` (`src/server/setup/connectors.ts`) returns the registry for one workspace, chosen by capability owner:

| Check | Native (default registry, `CONNECTORS`) | GoHighLevel-owned (`GHL_CONNECTORS`) |
|---|---|---|
| `crm_snapshot` "CRM Blueprint applied" | Implemented (follows the pipelines owner) | Unimplemented, as before ("cannot inspect which snapshot is installed") |
| `crm_assets` | Implemented (pipelines owner) | Unimplemented, as before |
| `calendar` | Implemented (calendars owner) | Unimplemented, as before ("Google authorization ... not verified") |
| `email_domain` | Implemented (conversations owner) | Unimplemented, as before |
| `sms_sender`, `whatsapp_sender` | Implemented (conversations owner) | Unimplemented ("verified in GoHighLevel") |
| `workflows` | n8n mappings first; native workflows when there are none (see below) | Unchanged |

`runChecks`, `verifyTask`, `attestTask` and the agency snapshot all use the workspace's registry. Attestation is offered only for checks that are unimplemented **for that workspace**, so a native client can never attest a native check, and a GoHighLevel client keeps the attestation path it had. An attestation still never completes a verified step (the database refuses it: `technical_completion_requires_connector`), and a failing check can never be covered by evidence (that refusal now comes first, whichever registry applies).

### What each native check accepts

All of these read the workspace's own rows inside one transaction (`src/server/setup/native-evidence.ts`). None calls a provider, so a live run and a recorded pass give the same answer. The detail is for the agency only; the client is told only that something needs attention.

- **CRM Blueprint applied** (`crm_snapshot`). Reads the newest application of each Blueprint (`crm_blueprint_applications`) and every record its links point at (`crm_blueprint_links`). Verified when the newest application of every live Blueprint finished and every record it created or linked still exists and isn't archived (a stage under an archived pipeline counts as archived). Records the client renamed or adjusted still count: tailoring the CRM is expected, so "drift" means deleted or archived, not edited. Failed when records are gone (the detail names each one, for example `tag “VIP” (deleted)`) or when the last application failed. Unverified when nothing was applied, the application was rolled back, or it applied only in part.
- **CRM pipelines, tags, fields and forms** (`crm_assets`). The expected manifest is every pipeline, stage, tag, custom field and form the live Blueprints created or linked; the actual rows must all be present, and at least one active pipeline must have two or more stages. Without a live Blueprint there is no expected manifest, so nothing can be verified. **Decision:** a client deliberately set up by hand ("blank CRM") needs the agency to mark the CRM Blueprint and CRM asset steps optional; the portal won't guess what "complete" means.
- **Calendar and availability** (`calendar`). **Decision:** two setups count. (a) A connected calendar: every connection that isn't disconnected and has conflict checking on must be `connected` with a successful read of its busy times (`last_success_at`) in the last 24 hours. (b) Calendar-only: nothing to connect. Either way at least one active iAcquire calendar must pass every activation check, including a real open time a customer could book in the next 14 days (`verifyCalendarInTx`). A connection that needs signing in again or keeps failing fails the check. Saved calendar credentials alone never verify it. At most five active calendars are checked per run.
  - Only a successful busy read counts. `last_synced_at` is the last *attempt*: a failed read (sync keeps a connection `connected` for about a day of failures) and a connection with conflict checking off both touch it without reading anything, so neither verifies the check.
  - A connection with conflict checking off reads nothing. It never counts as synced, and it doesn't block a calendar-only setup either.
  - When the client told the CRM setup guide they use an outside calendar (Google, Microsoft 365, CalDAV or a feed), a connection of that kind must be connected, read busy times and be freshly synced. If it is connected with conflict checking off, the check stays unverified and says so.
- **Senders** (`email_domain`, `sms_sender`, `whatsapp_sender`). Verified only by the recorded result of the latest live capability test (`messaging_channels.capability_test`, run from Communication settings with Resend, Twilio or the WhatsApp Cloud API): passed within the last 30 days, with the sender verified and registered. A failed latest test fails the check. Saved credentials without a passed test stay unverified, and a channel still on GoHighLevel stays unverified (the portal can't test it). The test itself sends nothing. For email, Resend's test proves the domain is verified for sending (SPF and DKIM).
- **Automation workflows** (`workflows`). If the workspace has agency n8n workflow mappings, the existing rule applies unchanged (it can't prove end-to-end wiring, so it never verifies). Otherwise, for native workflows: verified when at least one workflow is active, each active one runs an approved version (a version with message or external effects needs the owner's approval of exactly that content) and has completed a run of its published version (a test run counts), and none of their latest runs failed.

### The final system check

`final_health` now aggregates the checks behind **required** steps only. Optional steps' checks (the two sender steps, or anything the agency made optional) still run and complete their own steps, but never hold the final check back. Every default step was required before 0056, so nothing changes for existing checklists. The `verify_integrations` preparation job follows the same rule: only the checks behind required steps decide it. It fails when a required check failed (naming it) or isn't verified (including one the engine couldn't run). A failing optional check (a sender, say) is reported in the job's result (`optionalFailures`, and a detail line naming it) but never fails the job, so it can't block activation.

### Reaching activation as a native client (CRM service only)

1. The client submits company onboarding: `company_info` and `organization_created` verify.
2. The agency applies an industry Blueprint (at client creation, or later from the library): `crm_snapshot` verifies.
3. The agency completes "Tags and custom fields prepared" and "Forms and lead capture prepared" (manual steps that need evidence): `crm_assets` verifies against the manifest.
4. `final_health` verifies, the agency marks the setup ready for final review, and a super admin activates (activation re-runs every check first).

`tests/crm-setup-native.test.ts` runs exactly this. Adding the calendar, email or automation services adds their native checks above.

### When evidence is picked up

Checks re-run on the existing triggers (onboarding submission, AI employee health checks, agency "Verify now" and "Run all checks", activation), when an owner or admin presses **Check again** in the guide, and every 15 minutes through the scheduler (`setupEvidence` in `src/server/ops/tick.ts`, which runs `reconcileAllSetupInstances`: recorded evidence only, no provider calls). A Blueprint applied, a calendar activated or a sender tested is therefore reflected within 15 minutes, or at once after **Check again**.

## 2. The CRM setup guide

`/crm/setup` (navigation: CRM → Setup guide). Pure model: `src/lib/onboarding/crm-setup.ts`. Service: `src/server/setup/crm-guide.ts`. Screen: `src/components/setup/crm-setup-guide.tsx`. Actions: `src/app/actions/crm-setup.ts`.

### Steps

| # | Step | Shown when | Status comes from |
|---|---|---|---|
| 1 | CRM provider | always | Workspace mode; for GoHighLevel, the location mapping and its `ghl_location` check |
| 2 | Industry Blueprint | pipelines are native | The `crm_snapshot` evidence, plus the Blueprint's own setup checklist (`getBlueprintChecklistInTx`, the list CRM → Settings → Blueprints & setup shows): Verified only when no required item there is pending; otherwise Needs client action, naming up to three open items (labels only) |
| 3 | Contact fields | pipelines are native | Contact custom fields, and the manifest (Verified "matching your Blueprint" only when it matches and the Blueprint had contact fields) |
| 4 | Pipelines | pipelines are native | Native pipelines and stages, and the manifest (Verified only when the Blueprint had a pipeline and stages) |
| 5 | Tags | pipelines are native | Tags, and the manifest (Verified only when the Blueprint had tags) |
| 6 | Calendar connection | calendars are native | The client's answers (appointments yes/no, which calendar) and the calendar connections: Verified only after a successful busy read in the last day; Needs client action when the connection has conflict checking off |
| 7 | Scheduling | calendars are native and the business takes appointments | Active and draft calendars, `verifyCalendarInTx`, a public booking page with a public type |
| 8 | Communication providers | conversations are native | The channels the client chose, and each channel's capability-test evidence: Verified when each passed its live test and sending is on (the Blueprint checklist's rule); Configured when they passed with sending still off |
| 9 | Approved workflows | workflows are native | Native workflows: drafts, approval, completed runs, failed runs |
| 10 | AI roles | always | Enabled AI employees and their recorded live health checks |
| 11 | Verify integrations | always | The Setup Center's applicable checks |
| 12 | Review & activate | always | The checklist state and open client requests |

Statuses are exactly: Not started, In progress, Needs client action, Needs agency action, Configured, Verified, Failed. Verified always needs a passed capability test or connector evidence (a live provider test, a real open time, a Blueprint manifest that matches, a completed workflow run, a fresh calendar sync, a live AI health check). Entering a key, a number or an answer never verifies anything. Configured means set up and in use but with nothing that proves it end to end (for example an active, approved workflow that hasn't completed a run yet, or "we use the iAcquire calendar only").

Adaptive behaviour: a business that says it doesn't take appointments doesn't get the scheduling step (the calendar step then reads Configured, and the answer can be changed back). Steps for capabilities GoHighLevel owns are left out: they are managed there. Unanswered questions fall back to the client's company onboarding answers (`b.appointments`, `c.channels`).

### Autosave and exact-step resume

`crm_setup_guides` keeps one row per client workspace: the step the person was on, their answers (validated, merged so answering one question never clears another), a revision, when the provider was chosen and when the client said it was ready. Statuses are never stored. The screen saves a step change at once and answers after a short pause; it shows "Saving…", "All changes saved" or "Couldn't save" with a retry. If another tab saved in between, the save still goes through and the screen says so. Saves run one at a time (`src/lib/onboarding/crm-setup-autosave.ts`), each sending the revision the previous save returned, and the guide's own actions that move the revision (the provider choice, the review hand-off) run in the same queue and hand their revision on. So only a real change from another tab or person is reported as one; quick clicks and the guide's own buttons never are. On reopening, the guide resumes at the saved step, or, if that step no longer applies, at the next step that does.

### Who may do what

| Action | Who |
|---|---|
| See the guide | Anyone who can open the CRM (`crm.view`); the agency through a support session |
| Answer questions, move through it, **Check again** | Owners and admins (`setup.respond`); an agency super admin in a write support session |
| Initial CRM provider choice | The owner (`crm.provider.manage`); a super admin's write session |
| **Tell iAcquire we're ready** | Owners and admins of the client only |
| Activate | Nobody here: a super admin approves activation in the Setup Center |

The initial provider choice (iAcquire CRM, the default, or GoHighLevel) is allowed only while the workspace has no CRM records (contacts, companies, native opportunities or bookings, import jobs) and no provider switch has run (no hybrid mode, no recorded capability owners, no audited `crm.provider.switch*` action, no switch in progress). After that the guide links to Settings → CRM Provider. Choosing GoHighLevel connects nothing: iAcquire then maps and verifies the location. The choice is audited (`crm.provider_initial_choice`).

"Tell iAcquire we're ready" notifies the agency (at most once an hour), records the time and is audited (`crm.setup_review_requested`). It changes no setup status.

### Tenant isolation

The service reads with trusted code after authorizing the actor, and every query names the actor's workspace. `crm_setup_guides` has row-level security (`crm.view` on the row's organization) and the application role may only read it; all writes go through the service.

## Files

- `supabase/migrations/0056_crm_setup_native.sql`, `supabase/rollbacks/0056_crm_setup_native.down.sql`
- `src/lib/setup.ts` (check keys `sms_sender`, `whatsapp_sender`; labels; `SetupCrmProvider`; `AgencyTaskView.crmProvider`)
- `src/server/setup/native-evidence.ts` (new), `connectors.ts`, `automation.ts`, `core.ts`, `agency.ts`, `snapshots.ts`, `jobs.ts`, `provisioning-contract.ts`, `templates.ts`, `crm-guide.ts` (new)
- `src/lib/onboarding/crm-setup.ts` (new), `src/lib/onboarding/crm-setup-autosave.ts` (new: the screen's save queue), `src/lib/onboarding/engine.ts` and `src/server/onboarding/service.ts` (native wording and facts in the onboarding review)
- `src/app/actions/crm-setup.ts`, `src/app/(portal)/crm/setup/page.tsx`, `src/components/setup/crm-setup-guide.tsx`, `src/components/setup/crm-setup-view.tsx`
- Shared, additive: `src/lib/crm/nav.ts`, `src/components/crm/crm-shell.tsx`, the agency CRM mirror page, `src/server/ops/tick.ts`
- Tests: `tests/crm-setup-native.test.ts` (new), `tests/setup-center.test.ts` (now runs in GoHighLevel mode, which proves that flow is unchanged)

## Known limitations

- A blank native CRM (no Blueprint) can't verify the Blueprint and asset steps; the agency marks them optional. The portal doesn't infer a manifest from hand-built records.
- The sender steps are optional by default. A Blueprint that requires SMS or WhatsApp doesn't make them required yet (the Blueprint checklist on CRM → Settings → Blueprints & setup still lists the requirement).
- `email_domain`, `sms_sender` and `whatsapp_sender` read the latest recorded capability test; a live Setup Center run doesn't re-run the provider test (it is run from Communication settings).
- The Blueprint checklist's own channel items (`email_provider`, `sms_provider`, `whatsapp_provider` in `src/server/crm/blueprints/checklist.ts`, not this package's file) still count a channel as done whenever it is enabled, even when its last passed test is more than 30 days old. The guide then says In progress (the test must be run again) while the checklist says done. Moving the checklist onto `channelEvidence` is with the lead.
- Native clients do not get the `manual_ghl_mapping` preparation job; onboarding queues the three
  native preparation jobs (`tests/provisioning.test.ts`). The GoHighLevel mapping job remains
  available only for a client that keeps GoHighLevel.
- "A provider switch has run" is detected from hybrid mode, recorded capability owners, an in-progress switch, or an audit action starting with `crm.provider.switch` (or `crm.provider_switch`). Provider switching (package B) should record its switches that way.
