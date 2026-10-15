# Migration 0026 — review and apply plan

`supabase/migrations/0026_website_studio_admin.sql` · rollback `supabase/rollbacks/0026_website_studio_admin.down.sql`

**Status: NOT applied to the hosted Supabase project, and it must not be applied without your explicit approval.** It was run only against the local
in-memory PostgreSQL that the test suite builds from all 26 migrations. This document is the reviewed plan to apply it; nothing in it has been done.

## Ordering: this is not a stand-alone step

The hosted project does not yet have `0016`–`0025` (operating controls, staff roles, credits, messaging, adaptive onboarding and brand assets, websites,
operations, appointments, retention, commercial operations). `0026` alters tables and functions created by `0021_websites.sql`, so it can only be applied
**after** `0021`, and in practice after the whole `0016`–`0025` chain. Apply them in order in one planned window; do not cherry-pick `0026`.

## What it changes

Additive, with three kinds of alteration to existing objects.

| Kind | Object | Notes |
| --- | --- | --- |
| New table | `website_templates` | The agency's template library. Built-in designs live in code; a row exists for one only after the agency makes a choice about it (featured, hidden, archived, tags). Custom templates hold `draft_content` (working copy, revision-checked) and `content` (the last published copy, never edited in place). Checks: kind, status, size caps (300 KB), key shape, `kind = 'builtin' or draft_content is not null`, `status <> 'published' or kind = 'builtin' or content is not null` |
| New table | `website_template_versions` | Immutable published versions of a template (an `app.block_update` trigger refuses updates) |
| New table | `website_patterns` | Sections the agency shares with every client's editor. Copied in when used, never linked |
| New table | `website_components` | A client's own saved sections (has `org_id`) |
| New table | `website_comments` | Review notes between a client's team and the agency (has `org_id`; composite foreign key to `websites (id, org_id)`) |
| New columns | `websites.archived_at`, `edit_lock_user`, `edit_lock_name`, `edit_lock_expires` | Archiving and a courtesy edit lock. The revision check is still what prevents overwrites |
| New columns | `website_form_submissions.purpose`, `form_id` | Which kind of form was sent (contact, consultation, lead, appointment), and which one |
| New column | `org_assets.folder` | Reserved for organising a media library; the editor does not use it yet |
| Altered | `template_key` checks on `websites`, `website_versions`, `website_publications` | From `^[a-z]+\.[a-z]+$` to `^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$` so agency designs (`custom.my-template`) are valid. **Strictly wider**: every existing row still passes |
| Altered | `website_versions.source` check | Adds `checkpoint`, `ai`, `restore`, `template`. Strictly wider |
| Replaced function | `app.submit_site_form` | Gains `p_purpose` and `p_form_id` (defaults keep old callers working). The 14-argument version is dropped and the 16-argument one created in the same transaction, so there is no moment without a function. `iaq_site_runtime` keeps execute on the new signature only |
| Permissions | `role_permissions` | `website.templates.design` (staff, super admin), `website.templates.publish` (super admin), `website.review` (staff, super admin). Mirrored in `src/lib/permissions.ts`; a test fails if the two drift |

## Security review

- **Row level security is enabled on all five new tables.** Privileges are revoked from `public`, `anon`, `authenticated` and `iaq_site_runtime`, then granted narrowly to
  `iaq_app_user`:
  - `website_templates`: column-level select (`id, key, kind, name, description, family, industries, tags, status, featured, version, based_on, published_at,
    updated_at, preview_mime`), only rows that are `published` (or any, for agency staff). **`content`, `draft_content` and `preview_image` are not granted**:
    template content is read by trusted server code only, so a client's browser never receives another design's content.
  - `website_patterns`: only `id, name, category, status, updated_at`, published rows (or any, for agency staff).
  - `website_components`, `website_comments`: select only, gated by `app.has_permission(org_id, 'website.view')`. Writes happen only in trusted server code.
  - `website_template_versions`: select for agency staff only.
- The public sites runtime gains **no** table privileges. Its one new capability is the wider `submit_site_form` signature.
- Tenant isolation: every table with an `org_id` is covered by `tests/tenant-isolation-generic.test.ts`, which fails the build if an `org_id` table lacks RLS or a
  scoping helper. `website_templates` and `website_patterns` deliberately have no `org_id`: they are agency-wide and never contain a client's data (the server
  refuses uploaded-image references in templates and shared sections).
- Audit: template creation, status changes, updates and version restores, saved-section changes, comments, archives and agency edits all write audit events.

## Data impact and risk

- No existing row is rewritten. The widened constraints are checked against existing data when added, and every existing value satisfies them.
- Lock time: `ALTER TABLE ... ADD COLUMN` without a volatile default and `ADD CONSTRAINT` on small website tables are quick. `website_form_submissions` gains
  columns with constant defaults (cheap). Run during a quiet period anyway.
- The function replacement is atomic inside the migration transaction. Sites already published keep serving; an enquiry in flight at the instant of commit is
  retried by the visitor's browser like any other failed POST.
- `pg_column_size` caps (60 KB sections, 300 KB templates) are enforced by the database, not just the application.

## Before applying (checklist)

1. Your written approval to apply migrations to the hosted project, and the maintenance window.
2. A **logical backup** of the hosted database and a tested restore (see `supabase-setup.md`). The filesystem archive from the earlier work is not a database backup.
3. `0016`–`0025` applied and verified first, in order.
4. Run the full suite against the migrated schema (it already runs every migration locally).
5. Stop writes to the website screens (or run in a quiet window); the sites runtime may stay up.

## Apply

Through the Supabase CLI or the SQL editor, as already planned for the earlier migrations: one transaction per file, in numeric order, stopping on the first
error. Then verify: the five tables exist with RLS enabled (`select relname, relrowsecurity from pg_class where relname like 'website_%'`), the three
permissions exist, `app.submit_site_form` has 16 arguments, and `iaq_site_runtime` can execute it but has no table privileges.

## Roll back

`supabase/rollbacks/0026_website_studio_admin.down.sql`, run in one transaction with the sites runtime and website screens stopped. It **refuses to run** if data exists
that the older schema cannot hold (a site, version or publication using a hyphenated or custom template key; checkpoint, `ai`, `restore` or `template`
versions), and tells you what to do first. It then drops the five tables, the new columns and the 16-argument function, restores the 14-argument function
and the original constraints, and removes the three permissions. `tests/website-migration-0026.test.ts` runs the script against a fully migrated local
database inside a transaction that is always rolled back, checks every object it should remove or restore, and checks that it refuses when it should.
**Rolling back after clients have used templates, saved sections or comments discards that data**, so take a backup first. It has never been run against
the hosted project.
