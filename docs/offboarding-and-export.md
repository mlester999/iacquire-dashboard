# Offboarding, data export and deletion

Migration `0025_commercial_operations.sql`. Code: `src/server/offboarding/{export,zip,service}.ts`, `src/app/api/data-export/route.ts`,
`src/app/actions/offboarding.ts`, `src/app/(admin)/admin/commercial-actions.ts`, `src/components/offboarding/*`,
`src/components/admin/offboarding-panel.tsx`, pages `/settings/data` (client) and `/admin/clients/[id]/offboarding` (agency).
Tests: `tests/offboarding.test.ts` (23). Status: **Implemented locally, tested with mocks and local PostgreSQL.** Nothing has been deleted anywhere
real, and permanent deletion is **off** (`OFFBOARDING_PURGE_ENABLED=false`).

## Principles

Leaving is a process, not a switch. The client keeps their data and their domains; automation stops safely; billing is settled; deletion only follows
the agreed retention period; and every step is recorded (`offboarding_events`, audit log). Deletion is never automatic.

## Data export (any time, not only when leaving)

`GET /api/data-export` (owner only, rate-limited, never cached) builds a ZIP **on demand** and does not store it. The workspace comes from the verified
session, never the request. It contains readable JSON/CSV and files for: business profile, knowledge, onboarding answers and documents; team (without
invitation tokens or alert phone numbers); contacts, consent history and suppressions; every conversation, message and delivery event; leads, CRM,
notes and tasks; appointments, bookings, reminders; retention programs and history; the website (content, the latest 20 versions and publications, domains, enquiries and images);
the AI team's setup and approvals; social media (the connected Facebook and Instagram accounts by name and status, posts and their history, campaigns, media library records, AI
suggestions, settings, the engagement numbers the platforms returned, and the pictures and videos in `files/social-media/`); support conversations (not internal notes);
custom-project records; and billing history. Files over a size cap are listed in the README
rather than silently dropped. It **omits** passwords, connection secrets (a social account's sign-in token, the platform's id for the person who connected it, the permissions
granted and the token's dates are never exported; neither are publishing jobs or sign-in states), internal dedupe keys and anything belonging to other
clients. It also includes a guide for moving each domain. Each download is audited and recorded against any open closing request.

## The process

| Step | Who | What happens |
| --- | --- | --- |
| 1. Request | Owner (typed workspace name) or agency | Opens a request. **Nothing is switched off.** The owner can cancel any time before shutdown |
| 2. Shutdown | Super admin | Pauses agency, messaging and outbound; sets every AI employee to Paused; cancels queued messages, follow-ups, reminders, bookings, program messages and pending approvals (releasing credit holds); disconnects messaging channels and connected services; disconnects the client's Facebook Pages and Instagram accounts (their tokens are deleted and posts waiting to publish are stopped); removes team access (the owner keeps theirs); keeps or unpublishes the website as agreed; records the remaining prepaid balance; starts the retention clock (default 90 days, minimum 30). **Each step reports its own result**: a service that could not be disconnected is shown as failed with instructions to revoke it by hand |
| 3. Billing | Super admin | Records how remaining credit and charges were settled (refund through PayMongo, waived, or none owed). A precondition for deletion |
| 4. Reminders | Scheduler | The owner is reminded before deletion (`offboardingReminders`) |
| 5. Plan | Super admin | "Show the deletion plan" counts rows per table, files, and what is kept |
| 6. Delete | Super admin | Only if **all** guards hold (below) |
| Restore | Super admin | "Bring the workspace back" cancels the request and lifts the pauses. Employees stay Paused, channels stay off and staff access stays removed until the owner turns them back on, so nothing starts messaging customers by surprise |

## Deletion guards

`executeDeletion` refuses unless: `OFFBOARDING_PURGE_ENABLED` is on for this environment; the request is in retention and past its date; billing is
closed; the client downloaded their data (or the super admin records why not); and the typed confirmation equals the workspace name. The database
purge runs in **one transaction** (everything or nothing). Stored files are removed **after** it commits, and any that could not be removed are
reported as orphans rather than hidden.

**Kept** as financial and audit records (`PURGE_RETAINS`): audit log, payments, credit accounts and ledger, metered usage and reservations, provider
fees, billing settings, offboarding records, finance entries, incidents, activity reviews, and membership/assignment history. Everything else with an
`org_id` is deleted, including customers, conversations, files and the website; new tenant tables are purged by default.

## Before turning deletion on

1. Restore a backup of the database and storage once, successfully, into a scratch project.
2. Have counsel confirm the retention period and what must be kept for tax and audit.
3. Decide what happens to custom domains registered through the agency (they are the client's).
