# Client Setup Center and Agency Setup Manager

One checklist per client workspace, stored once in the database and shown two ways: a calm, simple
view for the client and a full management view for iAcquire staff. Both read the same rows, so a
change saved by the agency is the change the client sees.

## Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `/setup` (`/dashboard/setup` redirects here) | Client owner, admin, member | The Setup Center |
| `/admin/clients` | Agency | Client list with setup %, state, client actions, blockers, owner, integration health, last activity; search, filters, sorting |
| `/admin/clients/[id]/setup` | Agency (assigned staff, or any super admin) | The Setup Manager |
| `/admin/setup-templates` | Agency Super Admin | Edit and reorder master instructions, requirements, client actions and dependencies for new checklists |
| `/admin/clients/[id]/provisioning` | Agency | Preparation jobs, retries, audited retirement and attempt history |
| `/admin/clients/[id]/activation` | Agency | Final readiness and agency approval |
| `/admin/clients/[id]/integrations` | Agency | Client connections and verified diagnostics |
| `GET /api/setup`, `GET /api/setup/stream` | Client | Snapshot and change stream for the signed-in workspace (never takes a workspace from the request) |
| `GET /api/admin/setup/[orgId]`, `.../stream` | Agency | Same, for one client the caller may manage |
| `/dev/setup-preview` | Development only (404 in production) | Both screens rendered from clearly labelled sample data, with no network |

## How a change reaches the client

1. An agency user saves a task change (a server action).
2. The server verifies the person is agency staff **and** assigned to that client (or a super admin), loads the task by `id` **and** `org_id`, applies the rules below, writes the change, an event row and an audit row, and bumps `client_setup_instances.revision`, all in one transaction that locks the client's instance row.
3. After commit it notifies open browsers and creates any in-app notification.
4. The client page receives a revision signal, refetches its authorized snapshot and animates the change in (progress ring, status, note, "just updated" highlight). Two independent signal channels exist: a private Supabase Realtime topic `setup:<organization>` (when Supabase is configured; carries only a revision number, authorized by Row Level Security, with current membership or assignment rechecked at least every 60 seconds through the token endpoint) and a Server-Sent Events stream. Either one is enough, and polling backs both up.

If the stream is unavailable the page falls back to polling (15 s while disconnected, 60 s as a safety net while connected) and refetches when the tab regains focus or the network returns. Each stream reads the database revision under current RLS permissions every 5 s and on each push. It closes immediately when access is withdrawn and reconnects every minute to revalidate the session. A change committed by another app instance still arrives; Redis is not required. The revision in the database is the source of truth.

## Rules the server enforces

- **Progress** = completed ÷ applicable, required tasks, excluding the final activation step. Hidden optional tasks and tasks outside the client's purchased services are not applicable, so they never penalize the percentage. With no applicable tasks the percentage is `null` (shown as "—"), never 0% or 100%.
- **Setup tasks completed ≠ ready for production.** Approval also needs every integration check behind a required task to be verified, none failing, and the setup in final review. Agency evidence cannot replace verification. A failing or unavailable required connector keeps approval blocked.
- **Three kinds of task**
  - `manual`: staff can mark it Completed (optionally requiring an evidence link).
  - `verified`: only a passing system check completes it. Status edits cannot. An assigned staff member may record **agency evidence** (what they confirmed, how, optional evidence); this leaves the step ready for review and approval blocked until technical verification succeeds.
  - `activation`: completed only by approving activation.
  The same table is enforced by database CHECK constraints, so even a bug in application code cannot produce a falsely completed step.
- **Automated steps never complete because a job started.** Completion needs evidence from a connector (`src/server/setup/connectors.ts`). A step that is Blocked is never auto-unblocked.
- **Writes recheck current authorization in the transaction.** Role and assignment rows are locked for agency writes. A cached owner page cannot respond after the user's current membership loses `setup.respond`. Verification results are discarded if another setup revision commits while the connector is running; explicit live verification withdraws obsolete successes that no current connector can verify.
- **Preparation job failures stay visible.** Expired leases become failed jobs with an interrupted attempt, including the final allowed attempt. Retirement requires an agency reason, preserves attempts and the previous error in the audit trail, and may reference a successful replacement for the same client and operation. A live worker lease cannot be retired. Retirement never changes task completion or provider checks; failed or running jobs remain activation blockers until reviewed, resolved or explicitly retired. Job changes publish the same authorized setup revision signal.
- **Dependencies:** a task can't be completed, or requested from the client, until its applicable prerequisites are completed. Cycles and cross-tenant prerequisites are rejected.
- **Blocked** needs a client-visible reason. **Reopening** a completed task needs an internal reason, clears its completion, withdraws an attestation, and clears a required client approval.
- **Client responses** (approve, review, provide information, confirm) are the only client writes. They move a step to *Ready for review* (or back to *In progress* for requested changes) and never complete it. They are accepted only for a step in the client's own workspace that is currently waiting for them, so a repeated click or a forged request fails.
- **Final review and activation:** staff mark ready for review; reopening or blocking a step while in review automatically sends it back. Only a super admin can approve activation. Approving re-runs every live check first, then records the decision, completes the activation step, marks billing activation `active`, and tells the client. **Activation records the decision; it does not switch on workflows, outbound messaging or any production system.**

## Data model (migration `0008_setup_center.sql`)

| Table | Purpose |
| --- | --- |
| `client_setup_templates`, `client_setup_template_tasks` | The configurable default 25-step master checklist; edit at `/admin/setup-templates` |
| `client_setup_instances` | One per client: state, purchased services, responsible person, revision |
| `client_setup_tasks` | The client's steps (status, mode, section, visibility, notes, client request and response) |
| `client_setup_task_dependencies` | Prerequisites (same-tenant composite foreign keys) |
| `client_setup_task_events` | Append-only history: who, from → to, when, client-visible text and staff-only reason |
| `client_setup_task_attachments` | HTTPS evidence links or private project document references, internal or client-visible |
| `client_setup_checks` | Integration readiness, kept apart from task progress: unverified / verified / attested / failed |

Client users can only `SELECT`, under row-level security, through column grants that omit staff-only data (assignee, who completed it, internal reasons and notes, verification detail). They have no grants on checks or templates and no write grants anywhere. New permissions: `setup.view` (everyone in the workspace and agency), `setup.respond` (owner, admin), `setup.manage` (agency), `setup.activate` (super admin).

## Connectors and provisioning (typed seams)

`connectors.ts` defines the verification side; `provisioning-contract.ts` defines the "doing" side. Implemented checks: company onboarding, GoHighLevel workspace connection, AI employees (live Hermes health plus restricted-tool checks) and the aggregate final check. Workflow inventory checks read saved client mappings, but cannot prove end-to-end workflow readiness and remain unverified. **Not implemented, and shown as such:** CRM snapshot, complete CRM asset verification, website and domain, email domain, Google Calendar, and remote provisioning adapters. Local preparation jobs create configuration drafts and manual runbooks without creating or activating remote resources. Tests reject any unbuilt adapter claiming availability.

## Notifications

In-app notifications are created for completed milestones, requests that need the client, blocked steps, a newly failing check, final review, and agency approval. The notification settings include a setup group; history stays persisted. Email is sent only when a real provider is configured **and** the person turned on "Email me setup updates"; the outbox records provider acceptance. No development action authorizes sending real customer messages.

## Known limits

- Upload PDF, DOCX, PNG, JPEG, text, Markdown or CSV files up to 10 MB from a task's Client tab. Uploaded files use the private `project-files` Storage bucket; only the assigned agency can upload, and clients see only files shared with them. Each download rechecks permissions and issues a short signed URL. The explicit local demo keeps files locally.
- New checklists include core services. Custom websites and standard lead-generation funnels are separate optional services; select purchased scope from Services before those tasks count. Existing package choices and completed client histories are preserved. Migration `0013_setup_experience.sql` adds detailed milestones to unfinished checklists.
- Migration `0102_onboarding_snapshot.sql` adds one optional step, `media_storage` ("Where your post pictures and videos are kept"), to unfinished checklists and the default template. It is not counted in the percentage, nothing depends on it and it connects nothing; the client sees text read from the storage policy each time (see `docs/onboarding.md`). The client's Setup Center also opens with a Setup payment line (confirmed or not confirmed yet, from `app.setup_payment_cleared`).
- Checklist templates have one default; per-package templates would be a new row set, not new code.
- Reordering uses move up/down controls rather than drag and drop.
