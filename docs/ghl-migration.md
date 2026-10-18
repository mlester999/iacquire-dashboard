# GoHighLevel live-record migration

Moves a client's live GoHighLevel (GHL) records into iAcquire Native CRM: custom fields, tags, pipelines and stages, companies (GHL
"businesses"), contacts (with tags and custom field values) and opportunities. It is separate from CRM Blueprints, which copy
*configuration* from an agency template sub-account; this copies a client's *own records* from the client's own mapped location.

Status: implemented and tested locally (PGlite, mocked GHL). Never run against a live GHL account. Migration `0055_crm_ghl_migration.sql`
is not applied to the hosted database (it needs explicit approval with the other hosted migrations).

## Rules it keeps

- **Read-only, official API only.** Every request is a `GET` to `https://services.leadconnectorhq.com` with the documented `Version`
  header (`2021-07-28`, calendars `2021-04-15`), `redirect: "error"`, no cache, a 15 s timeout. No POST, PUT or DELETE is ever sent, so
  source records are never changed. The token is only ever placed in the `Authorization` header.
- **Only the client's own location.** The location and token come from `ghl_location_mappings` + the vault credential
  (`loadGhlMigrationMapping`), never from a request. `u69CVh0ZlAofUmRoj1zF` (Aster Homes) and `SQvVnld5MBHdMQ1qnSfw` (iAcquire's agency
  location) are refused before any request, in code (`ghlMigrationGet`, `loadGhlMigrationMapping`) and in the database
  (`crm_import_jobs.source_location` check). Agency organizations are never a migration source. Each worker step first re-verifies
  `GET /locations/{id}` names exactly the mapped location; every list row naming another location fails the page (`scopeGhlRows`).
- **Through the import pipeline.** Each step is an ordinary `crm_import_jobs` row with `source = 'ghl_api'`: rows are staged, the dry run
  validates them, the import writes them, and the existing undo reverses them. Nothing bypasses `assertNativeOwner`.
- **Dry run first.** A step's records are staged and checked before anything is written; the import is refused unless that dry run finished
  (`status = 'validated'`). When an earlier step was imported after a step's dry run, starting the import re-runs the dry run first and the
  person starts it again (explicit authorization on up-to-date results).
- **Never duplicates.** `crm_external_ids (org_id, provider 'ghl', entity, external_id)` maps every GHL id to the native record it became;
  opportunities also carry the idempotency key `ghl:<id>`. A re-run links instead of creating. Undo releases the keys so a later run can
  create again.
- **The GHL cache is never touched.** `crm_pipelines` / `crm_opportunities` rows with `provider = 'ghl'` (the read-through cache) are
  separate from the native rows a migration creates.
- **Never both systems acting.** The import phase writes only while iAcquire owns the capability (`assertNativeOwner`); job creation and the
  dry run are allowed while GHL owns it. If ownership moves back mid-import the step stops (`cancelled`, with the reason) and what was
  imported can be undone. Events the import writes for migrated records are marked delivered with the reason
  `Migrated from GoHighLevel: not dispatched (it already happened there).`, so no workflow, assignment rule, follow-up or webhook fires for
  history; owners are set without "assigned to you" notifications.
- **Nothing silently discarded.** A value iAcquire can't store (an invalid email, a phone without a country code, an unknown country or time
  zone, a custom field value that doesn't fit) is left out of that record and the row carries a flag; the step's summary counts every flag
  and the comparison lists them. Unsupported field types are listed, not created. Records that can't be imported faithfully are held for
  review, never dropped. A contact whose full record couldn't be read (`detail_unavailable`), or that came across with neither a name nor a
  phone (`name_phone_missing`), is flagged too.

## Verified endpoints (official OpenAPI specs, `GoHighLevel/highlevel-api-docs`, `apps/*.json`)

| Step | Endpoint (all GET) | Scope | Paging | Spec notes |
|---|---|---|---|---|
| Identity | `/locations/{locationId}` | `locations.readonly` | none | Response `location.id` must equal the mapped location. `location.companyId` is used for users. |
| Custom fields | `/locations/{locationId}/customFields?model=all` | `locations/customFields.readonly` | none | `id, name, fieldKey, dataType, picklistOptions, model, position`. |
| Tags | `/locations/{locationId}/tags` | `locations/tags.readonly` | none | `id, name, locationId`. |
| Pipelines | `/opportunities/pipelines?locationId` | `opportunities.readonly` | none | `stages` is untyped in the spec; `id`, `name`, `position` are read defensively. |
| Companies | `/businesses/?locationId&limit&skip` | `businesses.readonly` | skip/limit (100) | The CRM's companies are GHL **businesses**. `GET /companies/{id}` (companies.json) is the *agency* company (Agency-Access, SaaS fields), not a CRM record, so it is not used. Contacts carry `businessId`. |
| Contacts | `/contacts/?locationId&limit&startAfterId&startAfter` | `contacts.readonly` | cursor (100) | **Marked deprecated** but documented. The only non-deprecated listing is `POST /contacts/search`, which is never sent (GET-only rule). The documented list item schema (`ContactsSearchSchema`) has no name or phone; fields are read with the names of the documented `GetContectByIdSchema`. A listed contact is read again with `GET /contacts/{contactId}` unless the list carried a name key (`firstName`, `lastName`, `contactName` or `name`) **and** the `phone` key: the rule is by key presence (an empty or null value counts as sent), so a list in the documented shape costs one extra GET per contact and a fuller list costs none. A re-read that GoHighLevel answers 404 keeps the listed values and flags the row (`detail_unavailable`). Cursor: `meta.startAfterId/startAfter` when present, else the last contact's `id` + `dateAdded`. |
| Opportunities | `/opportunities/search?location_id&status=all&limit&startAfterId&startAfter` | `opportunities.readonly` | cursor (100) | `meta.total`, `meta.nextPageUrl`, `meta.startAfterId/startAfter`. `status=all` includes won, lost and abandoned. |
| Users (owners) | `/users/search?companyId&locationId&limit&skip` | `users.readonly` | skip/limit | `companyId` is required even with a location token. `GET /users/` is deprecated and not used. Without the scope, records come across unassigned. |
| Calendars (preview only) | `/calendars/?locationId` (Version `2021-04-15`) | `calendars.readonly` | none | Counted in the preview; appointments are not migrated. |

The location's Private Integration Token needs these read scopes: `locations.readonly`, `locations/customFields.readonly`,
`locations/tags.readonly`, `opportunities.readonly`, `businesses.readonly`, `contacts.readonly`, `users.readonly` (and `calendars.readonly`
for the preview's calendar count). A step whose scope is missing stops with "The GoHighLevel token can't read … (it needs the … scope)".

## Rate limits

GHL documents 100 requests per 10 seconds and 200,000 per day, per location. The migration:

- keeps an in-process budget of 90 requests per 10 s per location (`takeGhlBurstSlot`); when it is used up the step waits instead of
  sending (`lastWaitReason: "burst"`);
- on `429` reads `Retry-After` (seconds or an HTTP date; default the reported interval or 10 s; capped at one hour), records it
  (`fetch_state.rateLimited` counts only GoHighLevel's own 429s; `lastWaitMs`, `lastWaitReason: "retry_after"`), sets `fetch_not_before`,
  and resumes from the stored cursor afterwards. Neither the browser poll nor the scheduler asks again before then;
- reads `X-RateLimit-Remaining` (nearly empty → waits out `X-RateLimit-Interval-Milliseconds`, `"burst"`) and
  `X-RateLimit-Daily-Remaining` (below 2,000 → waits an hour, `"daily"`). The panel words each wait by its reason: only a 429 says
  "GoHighLevel asked us to wait";
- backs off from a **passing GoHighLevel error** (a 5xx or 408, a network failure, the 15 s timeout: `GhlReadError.transient`): 2 s, 4 s,
  8 s … at most 5 minutes plus up to a second of jitter (`transientDelayMs`), resuming from the stored cursor (`lastWaitReason: "error"`,
  `transientErrors`, `lastError`). The count starts again after every page staged. After `GHL_TRANSIENT_MAX_ERRORS` (8) waits in a row, or
  `GHL_TRANSIENT_BACKOFF_MS` (30 minutes) of waiting, the step fails; "Run this step again" then **resumes the same job** from its cursor
  (rows already staged stay) instead of reading from page 1. A part-read page of contacts is kept (cursor at the last staged contact) for
  rate limits and passing errors alike;
- makes at most 5 pages and about `REQUESTS_PER_ADVANCE` (40) requests per worker step: the budget is checked between pages and before
  every contact re-read, and a page always stages at least one contact so every step makes progress (a page whose cursor can't name a
  contact is read whole);
- holds a **lease**: `advanceImport` claims the job (`claimed_at`, to the millisecond) and `fetchGhlChunk(jobId, lease)` checks the claim and
  renews it in the same transaction before every write. A worker whose claim another worker took (a read that outlasted the two-minute
  claim) throws `ImportLeaseLost` and writes nothing more; a cancelled step stops before its next page.

The budget is per process: several server instances can together exceed it, and then the 429 handling takes over.

## Steps, order and what each one does

`GHL_MIGRATION_ENTITIES` = custom fields → tags → pipelines → companies → contacts → opportunities. Prerequisites for the **import** phase
(`GHL_PREREQUISITES`): contacts need custom fields and tags imported (and companies, when a companies step was started); opportunities need
custom fields, pipelines and contacts. Undo runs in reverse (`ghlDependentsOf`): a step can't be undone while a later step that points at
its records is still imported.

| Step | Created as | Matching (re-run / existing records) | Notes |
|---|---|---|---|
| Custom fields | `crm_custom_fields` (contact or opportunity), key from `fieldKey` | external id; then same entity + key → linked when the type is compatible, else held for review | Types: TEXT→text, LARGE_TEXT→textarea, NUMERICAL→number, MONETORY→currency, PHONE→phone, EMAIL→email, DATE→date, SINGLE_OPTIONS/RADIO→select, MULTIPLE_OPTIONS→multiselect, CHECKBOX→multiselect (boolean without options). FILE_UPLOAD, SIGNATURE, TEXTBOX_LIST, custom objects: listed as unsupported, not created. |
| Tags | `crm_tags` | external id; then same name (case-insensitive) → linked | Two GHL tags differing only in case are one tag here (the second is reported as repeated). |
| Pipelines | native `crm_pipelines` + open stages | external id (new stages are added); then same name → linked when every GHL stage matches an open stage, else held for review | GHL stages have no won/lost kind (the deal's status says that), so every stage is open. At most 25 pipelines, 30 stages. |
| Companies | `crm_companies` (`created_via 'ghl_migration'`) | external id; then domain | Name, phone, email, website, address, description. |
| Contacts | `contacts` (`created_via 'ghl_migration'`) | external id; then exact email/phone | Names, email(s), phone(s), address, country, time zone, source, owner (GHL user email → member), tags, custom field values, company (by `businessId`, else by `companyName`). Existing records are only filled in where empty, never overwritten. Two GHL contacts sharing an email/phone: the second is held for review. Do-not-disturb (`dnd`, or `dndSettings` active per channel) becomes suppressions (`reason 'manual'`, `source 'ghl_migration_dnd'`) on every address. |
| Opportunities | native `crm_opportunities` via `createOpportunityInTx(via 'ghl_migration', idempotencyKey 'ghl:<id>')` | external id (re-run → skipped) | Contact, pipeline and stage resolve through `crm_external_ids`; a deal whose contact didn't come across is held for review. Won/lost close in place at `lastStatusChangeAt`; abandoned → lost with the reason "Abandoned in GoHighLevel"; lost → "Lost in GoHighLevel". Value, source, owner, opportunity custom fields. `created_at` is GoHighLevel's `createdAt` and `stage_entered_at` its `lastStageChangeAt` (else `createdAt`), so reports don't count a history as new on migration day. |

The "When a record already exists here" choice (`duplicates`): `update` (default: link and fill in empty details), `review` (hold it),
`skip` (leave it alone, not linked).

### Re-runs, the bulk dry run, cancelling and undo

- **The bulk dry run** (`createGhlMigrationRun`, "Dry run the remaining steps") starts only the steps that still need one: never run, or
  whose latest run failed, was undone, or was cancelled before it imported anything (`GhlMigrationState.remaining`). Steps that are
  running, waiting to be imported, imported, or cancelled part way through an import keep their run and its Undo. Reading an imported step
  again is explicit: "Run this step again" (`createGhlImportJob` for that step). A step whose latest run failed while reading resumes that
  run from its cursor.
- **Cancel** (`cancelGhlStep`): a read stops before its next page, a dry run or a step waiting to be imported stops (and can then be read
  again); a running import ("Stop import") stops after its current rows, and only the owner may do that. The import's records stay and can
  be undone.
- **Undoing a re-run** removes only what that run did. Every link a run makes is recorded per row (`linkInserted`; pipelines
  `pipelineLinkInserted`, plus the stages it linked or added). A re-run that matched an earlier run's links leaves them, so the earlier run
  stays linked and can still be undone, and a later run links instead of duplicating. A company re-run that fills nothing in doesn't touch
  the company (its version stays, so undoing the run that created it still removes it). Runs of a step are undone newest first; when the
  latest run has nothing left to undo, the panel's Undo acts on the newest earlier run that does (`GhlMigrationState.undo`).
- **Records in use are kept.** Undoing the contacts step (and a CSV contact import) keeps a contact the team has worked on since the
  import (a live native deal, a task, a note added after the import, an appointment or a conversation), with its details and its
  GoHighLevel link, as "needs review". Companies still linked to live contacts or deals are kept the same way.

## What doesn't come across

Listed in the panel and `GHL_NOT_MIGRATED`: conversations and message history (never sent or re-sent), notes and tasks, appointments and
calendars (connect natively), workflows/campaigns/forms/surveys/funnels (names only in the API), smart lists (no API), file/signature
fields and custom objects, contact website / date of birth / attribution (no native field), lost-reason names (id only).

## Authorization

| Who | Preview (`planGhlMigration`) | Dry run (`createGhlImportJob`, check again, cancel a read or dry run) | Import / undo / stop an import (`startGhlImport`, `rollbackGhlImport`, `cancelGhlStep` while importing) | Comparison |
|---|---|---|---|---|
| Owner | yes | yes | yes (`crm.provider.manage`) | yes |
| Manager (admin) | yes | yes (`contacts.import`) | no | yes |
| Other client roles | yes (`crm.view`) | no | no | no |
| Agency read session | no (it would use the client's credential) | no | no | no |
| Agency super admin, write session | yes | yes | yes (write sessions carry `crm.provider.manage`) | yes |

CSV imports are unchanged: they keep `contacts.import` / `contacts.delete`. The CSV `startImport`/`startValidation`/`cancelImport` refuse GHL
jobs, so the GHL rules can't be bypassed through the CSV wizard.

Reaching the preview: `DataView` (Settings → Imports & Exports) renders for any role with `crm.view` (the import history and the CSV card
only with `contacts.import`), but the portal page, its nav entry and the agency mirror still require `contacts.import` until the lead
changes them (see the package report's NEEDS-LEAD). Until then only owners and managers reach the panel in the UI.

## Data model (0055)

- `crm_import_jobs.entity` adds `custom_field`, `tag`, `pipeline` (GHL only); `status` adds `fetching` (GHL only).
- `crm_import_jobs.source_location` (required for GHL jobs, never a protected location), `fetch_cursor` (≤4 KB, the next page),
  `fetch_state` (≤64 KB: requests, pages, rate-limit answers and wait reasons, passing errors, source total and where it came from,
  truncation, owners readable; the location's user list is kept only while reading: it is removed when reading finishes, fails or is
  cancelled), `fetch_not_before`, `fetched_at`, `switch_id` (no FK yet; provider switching adds it).
- `crm_import_rows.flags text[]` (≤20 codes, `IMPORT_FLAG_LABELS`).
- Indexes: work index includes `fetching`; latest job per step; switch lookup; staged GHL id lookup.
- No new table or permission. Rollback: `supabase/rollbacks/0055_crm_ghl_migration.down.sql` (refuses while GHL migration jobs exist).

## Gap report and comparison

`ghlMigrationComparison(actor, jobIds?)` returns per step: source count with its kind (`sourceCountKind`: `reported`, a total GHL gave in
`meta.total` or the documented `count`, ignored once it is smaller than what was read; `listed`, no total but the whole list was read;
`at_least`, no total and reading stopped early, failed or was cancelled; null while still reading), staged, destination
count (live native records linked to a GHL record of that kind), mapped (created + linked), created, linked, skipped, failed, needs review,
the dry-run forecast (create/update/skip/review/invalid), flag counts, unsupported fields, rolled back, and whether reading stopped early.
Every number is a count of rows. `getImportJob(actor, jobId).problems` lists up to 200 rows with errors, review reasons or flags.

## Contract (for provider switching and other callers)

From `src/server/crm/ghl-migration.ts`:

- `GHL_MIGRATION_ENTITIES` (also in `src/lib/crm/ghl-migration.ts` with labels, prerequisites, flag labels, not-migrated list)
- `planGhlMigration(actor): Promise<GhlMigrationPlan>`
- `createGhlImportJob(actor, { entity, switchId?, duplicates? }): Promise<ImportJobView>`
- `createGhlMigrationRun(actor, { switchId?, duplicates? }): Promise<ImportJobView[]>` (only the steps that still need a dry run)
- `cancelGhlStep(actor, jobId)`
- `startGhlImport(actor, jobId): Promise<{ started: boolean; recheck: boolean }>`
- `checkGhlImportAgain(actor, jobId)`, `rollbackGhlImport(actor, jobId)`, `advanceGhlMigration(actor, jobIds)`
- `ghlMigrationComparison(actor, jobIds?): Promise<GhlMigrationComparison>`
- `getGhlMigrationState(actor): Promise<GhlMigrationState>` (database only, no GHL request; `jobs`, `undo`, `remaining`, `comparison`)
- `fetchGhlChunk(jobId, lease?)` (worker; called by `advanceImport` for `fetching` jobs), `REQUESTS_PER_ADVANCE`, `GHL_TRANSIENT_MAX_ERRORS`,
  `GHL_TRANSIENT_BACKOFF_MS`, `transientDelayMs`

A provider switch: create the jobs with its `switchId`, wait for `validated`, flip the capability to native (`switching = true`), then
`startGhlImport` in `GHL_MIGRATION_ENTITIES` order (repeat when `recheck`), verify with `ghlMigrationComparison(actor, jobIds)`, and on
rollback call `rollbackGhlImport` in reverse order before restoring the capability owners.

## UI

Settings → Imports & Exports → "Migrate from GoHighLevel" (`src/components/crm/ghl-migration-panel.tsx`): not connected / preview table /
dry run of the steps that still need one / per-step progress (reading with the reason for any wait, then a live bar and "N of M" from the
server's row counts for the dry run, import and undo) / import buttons (owner, only when iAcquire owns the capability and earlier steps are
imported) / cancel, stop import (owner), run again / side-by-side comparison with honest source counts / rows to look at / undo with
confirmation (the latest run, or the earlier run that still has records). Screen readers hear each step's status and result once per
change (`role="status"`), not the counters every poll changes. Past imports list GHL steps by name.

## Tests

`tests/crm-ghl-migration.test.ts` (mocked GET-only fetch; every request asserted GET, official host, documented Version header): burst
budget and Retry-After parsing; protected locations refused in code and in the database with no request; preview counts with nothing stored;
250 contacts over 3 pages with a 429 + Retry-After, waiting without requests, resuming from the stored cursor, no duplicate staging; a full
ordered migration (tags, custom field values, companies by id and by name, owners mapped and unmapped, enrichment by contact id, DND
suppressions, quiet events, no notifications); opportunities resolved through external ids with won/lost/abandoned outcomes; comparison
counts and flags; an idempotent re-run (no new records, links reused); another workspace sees and touches nothing; reverse-order undo that
keeps an edited contact as needs review, keeps in-use tags/fields/companies, never lifts opt-outs, and a clean re-run afterwards; import
refused while GHL owns the capability, runs after the switch, stops if ownership moves back, GHL cache untouched; the permission matrix
including agency read and write sessions, and the audit trail. Review fixes: undoing a re-run keeps the first run's links (companies,
name-only contacts, pipelines with an added stage) and a later run duplicates nothing, then undoing back to the first run removes what it
created; cancel while reading / while checked / while importing (owner only) and for read sessions; contacts with a native deal or a
note survive undo with their link; the documented contact list shape is read again and a 404 is flagged; a 503 and a timeout back off and
resume from the cursor, 9 in a row fail the step and "Run this step again" resumes it; a 403 drops the user list; one worker step keeps to
its request budget when every contact needs a re-read; a lost lease writes nothing; the bulk dry run leaves imported steps alone; source
count kinds; opportunity creation dates; the audit names who authorized. `tests/crm-ghl-migration-ui.test.ts` renders the page and panel:
a viewer reaches the preview without the history, live progress, wait wording, quiet status updates, the bulk button, Stop and the right
Undo, and the comparison's count kinds.

## Known limitations

- Not verified against a live GHL account (rule: never call real GHL). Field names beyond the documented schemas (for example
  `additionalEmails`, `dndSettings` status values) are read defensively and may need adjusting after a supervised first run.
- Contacts are listed with a deprecated GET; if GHL removes it, only `POST /contacts/search` remains, which needs explicit approval.
- Appointments, notes, tasks and conversations are not migrated.
- Per-process burst budget (see Rate limits). Steps stop staging at 100,000 records and say so.
- A list in the documented contact shape costs one extra GET per contact (about 50,000 for 50,000 contacts, inside the daily allowance
  but slower).
- A run that matched another run's records keeps those links on undo by design; undoing the earlier run is then a separate step (the
  panel offers it).
- Validation of a very large contact step compares each chunk with all earlier rows (inherited from the CSV path); slow for 50k+.
