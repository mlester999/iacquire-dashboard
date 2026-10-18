# Row-level security once per statement: migration 0053

Status: **built and proven locally (PGlite in-memory). Not applied to the hosted project.** Apply only after a current backup restore has
been tested and the exact divergent migration lineage has been reviewed; see `workforce-migration-and-release.md`.

| File | What it is |
| --- | --- |
| `supabase/migrations/0053_rls_initplan.sql` | The migration: a 5 s lock timeout, checks of the 13 helper definitions and owners plus each proved column/FK chain, two helpers, then one checked `alter policy` per SELECT policy (166) |
| `supabase/rollbacks/0053_rls_initplan.down.sql` | The rollback: restores each of the 166 expressions exactly, then drops the helpers |
| `scripts/rls-initplan.ts` | The generator of both files, the equivalence proof checks it runs, and the staging verifier |
| `tests/rls-initplan-equivalence.test.ts` | Before / after / rolled back, every table and every persona, on a private database (about 130 s) |
| `tests/rls-initplan-guard.test.ts` | Guard on the fully migrated test database (seconds) |

## What changes

Every member read runs under row-level security. Before 0053, the SELECT policies called `SECURITY DEFINER` helpers with the row's own
columns, so PostgreSQL ran them once for every row it read:

```
app.has_permission(org_id, 'contacts.view')            -- 162 calls
app.can_access_org(org_id)                             -- 15 calls (one is app.can_access_org(id) on organizations)
app.can_view_conversation(org_id, owner_user_id, assigned_user_id)   -- 1 call (conversations)
```

0053 adds two helpers that return, once per statement, the organizations where the current user passes the same check:

- `app.permitted_orgs(permission text) returns uuid[]`
- `app.accessible_orgs() returns uuid[]`

Both are `STABLE SECURITY DEFINER`, with `search_path = public, pg_temp`, owned by the migration role, `revoke all ... from public` and
`grant execute ... to iaq_app_user`: the same posture as `app.has_permission` (the guard test compares the ACL, owner, volatility and
search path, and checks that `anon`, `authenticated` and `iaq_site_runtime` cannot execute them).

Each per-row call in a SELECT policy becomes a membership test against an uncorrelated sub-select, which PostgreSQL plans as an InitPlan
and evaluates once per statement:

```
app.has_permission(C, 'p')    ->  (C = ANY ((SELECT app.permitted_orgs('p'))::uuid[]))
app.can_access_org(C)         ->  (C = ANY ((SELECT app.accessible_orgs())::uuid[]))
app.can_view_conversation(C, OWNER, ASSIGNED)
  ->  ((C = ANY (permitted 'inbox.view')) AND ((C = ANY (permitted 'inbox.view_all'))
       OR (OWNER = (SELECT app.current_user_id())) OR (ASSIGNED = (SELECT app.current_user_id()))))
```

The `::uuid[]` is required: without it, `x = ANY ((SELECT ...))` means "any row of the sub-select". PostgreSQL prints the same cast when it
deparses the policy, so a dump and restore reads it back unchanged. The comparison is a leakproof `uuid` equality, so the planner can use it
as an index condition (the guard test checks a real plan: `Index Cond: ((c.org_id = ANY ((InitPlan 1).col1)) ...`).

166 SELECT policies on 166 tables change, everything else around the calls stays as it was (`deleted_at IS NULL`, visibility, owner checks, EXISTS on a
parent table, CASE on a record type). This includes package B's `crm_provider_switches_select` from 0039 and the later AQi policies.

### Not changed, on purpose

- **Policies for other commands (27).** INSERT/UPDATE/DELETE policies (26) run per written row, which is small, and their WITH CHECK runs
  before foreign key checks, so an invalid organization id would fail with a different error under the new form. The one ALL policy,
  `notification_preferences.notification_prefs_all`, also applies to reads but covers at most a few preference rows per person; it is
  listed in `LEFT_ALONE_ALL_POLICIES` and the guard fails if another ALL policy starts calling a per-row helper.
- **Other per-row helpers.** `app.staff_assigned(org_id)` (18 SELECT policies, usually after an AND with a rewritten call, so it only runs
  for rows that already passed), `app.file_permission(...)` (`org_files`), `app.shares_org_with(id)` (`users`) and the zero-argument
  `app.is_agency_admin()` / `app.is_agency_staff()`. They are outside this migration's proof; rewriting them is a possible follow-up.
- No table, column, index, grant or data changes.

### How the files are made

`scripts/rls-initplan.ts` builds a throwaway in-memory database (local Supabase emulation plus every migration numbered below 0053), reads
`pg_policies`, and writes one block per policy:

```sql
-- contacts / contacts_select
select app.rls_initplan_expect('contacts', 'contacts_select', $was$(app.has_permission(org_id, 'contacts.view'::text) AND (deleted_at IS NULL))$was$);
alter policy contacts_select on public.contacts using (((org_id = ANY ((SELECT app.permitted_orgs('contacts.view'::text))::uuid[])) AND (deleted_at IS NULL)));
```

The first line is a precondition: if the database's current expression is not the one the file was generated from (drift, a later edit,
or another PostgreSQL version printing it differently), the migration raises an error and, since the runner applies a file in one
transaction, nothing changes. The rollback has the same check against the post-migration expression. The check function is created and
dropped inside each file.

Policy text alone does not pin down what the rewrite means: the proof below reads the owners and bodies of thirteen helpers (`has_permission`,
`org_role`, `staff_assigned`, `is_agency_admin`, `is_agency_staff`, `platform_role`, `can_access_org`, `can_view_conversation`,
`current_user_id`, `profile_id_for_auth_user`, `auth_uid`, `user_can_access_org`, and `user_has_agency_permission`; `PROOF_HELPERS` in the script). A hotfix applied with `create or replace`, or an
out-of-order migration, could change one while every policy text stays the same; for example a stricter `has_permission` for agency super
admins would make the rewritten policies show them rows the old ones hid. So, before the two new helpers are created, the migration checks
each of the thirteen on the target: exactly one `app.<name>` exists, with the same identity arguments, owner, `SECURITY DEFINER` flag,
volatility, settings (`search_path`) and source (whitespace collapsed; these functions keep their source verbatim, and a dump and restore
keeps it too). The two new helpers are then explicitly owned by the same role as `app.has_permission`, so the `SECURITY DEFINER`
execution context is preserved. Any difference raises `rls initplan: app.<name> differs from the definition this file was proven against; nothing was changed`. The
generator applies the same check first, against fingerprints of the reviewed definitions (`PINNED` in the script, which the guard test
also uses): it refuses a missing helper, a second overload or a changed fingerprint, including with `--from-database`. The rollback does
not need the check: restoring the original expressions does not depend on the helper bodies.

The migration also repeats the column proof on its target **before it changes any policy**. Each rewritten column must still exist in
`public`, must be `NOT NULL` if any call using it has no explicit null guard, and must still reach `public.organizations(id)` through a
validated foreign-key chain. The check follows referenced schemas and composite-key null behavior; a same-named table in another schema,
an unvalidated or dropped FK, or a nullable unguarded column stops the migration. The generator records the exact columns and whether each
requires `NOT NULL`; exact policy-expression checks preserve the guards the proof relied on.

The generator refuses to write anything when a call has an unexpected shape (a non-column argument, a non-literal permission, a nested
call), when `app.can_view_conversation` no longer has the body it expands, when a helper above differs from its reviewed fingerprint, or
when the proof's precondition fails (below). To find which table a qualified column belongs to, it reads only the FROM clauses of the
sub-selects that enclose the call, innermost first (sibling sub-selects may reuse an alias), and it refuses a FROM clause that is not a
plain list of tables (a join, a function, a set operation) instead of guessing. It then applies its own output and its own rollback and
refuses unless the rollback restores every policy byte for byte.

```
node --import tsx scripts/rls-initplan.ts            # (re)writes both files
node --import tsx scripts/rls-initplan.ts --check    # exits 1 if the committed files differ from what it would write
```

It never reads `.env` and never connects to any server. Re-run it whenever a migration before 0053 adds or changes a SELECT policy; the
guard test fails until you do.

## Why it is equivalent

### What the per-row helpers depend on

Read in full from the migrated catalog (`pg_get_functiondef`), not from the proposal's argument:

- `app.has_permission(X, p)` = the membership grant (`coalesce(A, B)`) OR the scoped agency grant, where
  - `A` = the effect of a `member_permission_overrides` row for (X, current user, p), counted only when `app.org_role(X)` is not null
    (primary key `(org_id, user_id, permission)`, so at most one row);
  - `B` = `role_permissions` has (`app.org_role(X)`, p);
  - the agency grant requires `app.staff_assigned(X)`, `app.user_can_access_org(current_user, X)`, an active client organization,
    `app.user_has_agency_permission(current_user, p)`, and, for CRM-sensitive permissions, an active `crm_support_sessions` row whose
    mode allows that permission. The exact allowlists are in migration `0039_agency_team_permission_overrides.sql`.
- `app.org_role(X)` = the role of a membership with `org_id = X`, `user_id = current user`, `status = 'active'`, joined to an active user
  (`users.status = 'active'`) and an organization whose status is not `suspended` or `archived`.
- `app.staff_assigned(X)` = `app.is_agency_admin()`, or a manager with `all_clients` scope and an active client organization, or an
  agency staff/manager assignment to an active client organization.
- `app.user_can_access_org(user, X)` requires an active user and either an active membership, the Super Admin role, or an active
  client organization allowed by Super Admin, manager `all_clients` scope, or an agency staff/manager assignment.
- `app.user_has_agency_permission(user, p)` reads the active user's agency permission override first and otherwise checks the
  user's platform role in `role_permissions`.
- `app.is_agency_admin()` / `app.is_agency_staff()` read `users.platform_role` of the current user, only when `users.status = 'active'`.
- `app.can_access_org(X)` = `app.org_role(X) is not null or app.staff_assigned(X)`.
- `app.can_view_conversation(X, owner, assigned)` = `has_permission(X, 'inbox.view') and (has_permission(X, 'inbox.view_all') or owner = current user or assigned = current user)`.
- `app.current_user_id()` (plain SQL, not `SECURITY DEFINER`) = the `app.user_id` setting, or for the Supabase `authenticated`/`anon`
  roles, the active profile of `auth.uid()`.
- Also not consulted: feature flags, invitations and anything else outside the helper definitions above.

The inputs are therefore: user status and platform role, memberships and roles, organization status and kind, staff assignments and scope
mode, role permissions and agency permission overrides, member overrides, CRM support sessions, and the session settings `app.user_id`
and `role`.

### The two helpers return exactly the organizations where the per-row helper is true

```
permitted_orgs(p) = { X in M : has_permission(X, p) }
                    ∪ { active client X : agency scope permits X, user_has_agency_permission(user, p),
                        and p is not CRM-sensitive or an active support session allows p }
accessible_orgs() = every organization if is_agency_admin()
                  = { X in M : org_role(X) is not null } ∪ { active client X : manager all_clients scope or assignment }
M = organizations referenced by the user's organization_memberships
```

For `permitted_orgs`, the membership branch evaluates the original helper on every membership organization, so it includes exactly the
membership grants. The agency branch mirrors each agency predicate in `has_permission`: Super Admin reaches active client organizations;
a manager reaches active clients in `all_clients` scope or assigned clients; agency staff reaches assigned active clients. It also checks
the active user's agency permission and the same permission-specific support-session allowlist as the original helper. Conversely, every
true agency branch in `has_permission` satisfies those same scope, permission and session predicates and is therefore included.

For `accessible_orgs`, `app.is_agency_admin()` makes `staff_assigned(X)` true for every organization, including suspended, archived and
agency organizations, so the first branch lists every organization. Otherwise `can_access_org(X)` is the union of active memberships and
the manager/staff client scope encoded by `staff_assigned(X)`. For an inactive or unknown user, `staff_assigned` can propagate SQL NULL
for an active client while the set helper returns an empty array; both are non-true in a SELECT policy and therefore hide the row. For an
active Super Admin, `can_access_org` can return true for a null or orphan id while the array includes only existing organizations; the
foreign-key/nullability proof below rules out those rows from rewritten policies.
`can_view_conversation` is expanded from its own body with its two `has_permission` calls rewritten the same way.

The helper-set test checks that both sides are TRUE for exactly the same organizations. It treats FALSE and NULL as equivalent for this
purpose because a SELECT policy hides a row for either value. The separate before/after/rollback test compares visible primary keys for
every persona and table, so it verifies the actual policy result directly.

(Two earlier versions were equally exact but slower. The first filtered M ∪ S ∪ every organization with `has_permission`, which cost an
agency super admin about 0.3 ms per organization per statement in PGlite, 300 ms at 1,000 organizations. The second read the super admin
case from the definition, but still ran `has_permission` / `can_access_org` once per staff assignment, so agency staff paid about 0.13 ms
per assigned client for every InitPlan of every statement: 64 ms at 500 assignments, even to read an empty table. Assignments are now
taken from the definition too.)

### The precondition: the column always names an existing organization

The remaining gap is `app.can_access_org(X)`: an active Super Admin reaches **any** X, including null and an id with no organization,
while the array contains real organizations only. `app.has_permission` now requires an active client organization for its agency branch,
so it denies null and orphan ids. The equivalence test probes both behaviors directly. The generator proves, for each rewritten call,
that the column

1. is `NOT NULL`, or the call is protected by `(<column> IS NOT NULL) AND ...` or `(<column> IS NULL) OR ...` (the latter covers the
   two AQi policies whose workspace id is optional), and
2. is backed by a **validated** foreign key chain to `organizations(id)`: directly, or through a composite key such as
   `(request_id, org_id) -> client_project_requests (id, org_id)` whose other columns are `NOT NULL` (with `MATCH SIMPLE`, a null in any
   column skips the check), and whose referenced column is itself guaranteed.

Both hold for every rewritten call today; the guard test re-checks them on every run, so a later migration that makes a rewritten column nullable
or drops its foreign key fails the suite. (A superuser can still bypass foreign keys, for example with `session_replication_role =
replica`; that is outside the threat model of the application role.)

### The rest of the argument

- **Three-valued logic.** No policy applies `NOT`, `IS FALSE` or `coalesce` to a call. Where the old call returned false the new test
  returns false or null, and a policy treats both as "hidden", through any combination of AND, OR and CASE.
- **Security context.** The sub-select `(SELECT app.current_user_id())` runs as the invoker, where the old call ran it inside a
  `SECURITY DEFINER` function. `current_user_id()` reads only the `app.user_id` and `role` settings, which `SECURITY DEFINER` does not
  change, and `iaq_app_user` may execute it and `app.profile_id_for_auth_user()`.
- **Snapshot.** All of these functions are `STABLE`, so within one statement they see the statement's snapshot, whether called once or
  per row.
- **No new errors.** The new helpers evaluate `has_permission` (or `org_role`) for every membership, not only for those whose rows are
  read. That cannot fail where the old form succeeded: the override lookup is limited to one row by its primary key, and `org_role`
  returns the first row.
- **Cached plans.** InitPlans are evaluated per execution, so a prepared statement reused for another user still computes that user's
  set.
- **Cost.** Per InitPlan (one per distinct permission in the statement), instead of once per row: a member pays `has_permission` (or
  `org_role`) once per membership; manager/staff scope is computed from assignments and agency permission grants without a per-row
  helper call. The equivalence test pins this down with call counts: for every persona, `permitted_orgs` makes at most one
  `has_permission` call per membership and `accessible_orgs` none of `can_access_org`, `staff_assigned` or `has_permission`, also for
  agency staff with 60 more assignments. Timing figures from the earlier agency helper model are not carried forward: merged permissions
  now include support-session checks and manager scopes, so use the current CRM scale benchmark before making a latency claim.

## How it was verified (locally)

`tests/rls-initplan-equivalence.test.ts`, on a private in-memory database with every migration before 0053 (including AQi and workforce):

- **Rows.** Every public table gets rows in five organizations (two active, one suspended, one archived, the agency), plus null
  organization rows where the column allows it, inserted generically from the catalog with triggers off and CHECK constraints dropped, so
  row states the application would never write are covered too. Foreign keys inside a row point at real parents in the same organization;
  user columns cycle through that organization's members and the agency users; conversations are owned by, assigned to, or unrelated to
  the sales rep. The test asserts at least three organizations for every table with a read policy.
- **Personas.** Every client role (owner, admin, member, sales rep, support, viewer, appointment setter; the fixtures call admin
  "manager", there is no separate manager role); a member with every overridable permission revoked; a viewer with granted overrides; one
  user who is a viewer in A and an admin in B; a revoked membership; a disabled user with an active membership; owners of the second,
  suspended, archived and agency organizations; a viewer with a grant override in the suspended organization; an agency super admin, a
  disabled one, one with a write support session; agency super admins who also have memberships or assignments, so the second branch of
  `permitted_orgs` runs for them with candidates (owner of the agency organization and a member of A with a `contacts.view` revoke and a
  `calls.view` grant, the state `scripts/seed.ts` creates plus overrides; owner of the suspended organization; assigned to B with no
  membership), for the permissions their agency role lacks such as `contacts.view`, `companies.view` and `calls.view`; agency staff and
  managers with default, all-clients and assigned-clients scope, permission overrides, and read/write/no support sessions; staff
  assigned to active and suspended clients, unassigned, disabled,
  assigned with a read session, with a session but no assignment, assigned in B and a viewer in A; a client user with a stray
  `staff_assignments` row; a user with no memberships; an id with no user; a request with no user id. The second organization's owner
  also has a revoke override, a state the guard trigger forbids. The inbox.view-only member is the sales rep (and support, member, viewer, appointment setter).
- **Captures.** For each persona, the primary keys it can see in every application-readable public table (every public table has
  row-level security; granted columns stand in when a table's key is not granted). Before 0053, with the committed 0053, and after the committed rollback: identical for every
  table and persona. Every table is visible to someone, and every rewritten table is hidden from someone, so no comparison is trivially
  empty or everything.
- **Helpers.** For every persona, organization and permission, the statement-level helpers agree with the per-row ones (above), and the
  call counts in "Cost" hold.
- **Files.** The committed migration and rollback are byte-for-byte what the generator produces from that schema. A changed helper owner,
  nullable target column, missing or unvalidated organization FK, or FK to a same-named `private.organizations` is refused before policy
  changes. After the rollback every
  policy (all commands) is byte-for-byte the original and the helpers are gone; a drifted policy makes the migration fail and change
  nothing; so does a hotfixed `has_permission` (super admins needing an assignment) or a second `has_permission` overload, which the
  generator refuses as well, while a whitespace-only change (CRLF, re-indentation) applies and rolls back cleanly; the staging verifier
  (below) finds no difference on the same data, and with a sample of 5 it still takes users from 5 different strata, client members
  included.
- **Boundary.** The probe above: `has_permission` denies null/orphan ids; `can_access_org` lets an active Super Admin pass them while
  `accessible_orgs` can list only real organizations. For inactive or unknown users, a per-row NULL becomes an empty-set FALSE, which is
  still a row rejection under RLS. Column nullability/guards and validated foreign keys close the active-admin gap in policies.

`tests/rls-initplan-guard.test.ts`, on the fully migrated shared test database: no SELECT policy calls a per-row helper; the ALL-policy
exemption list is exact; the helpers' posture; the definitions the proof reads, and the two new helpers, each exist once with the
fingerprint `PINNED` in the script (change one and the test tells you to re-check the candidate set), and the migration checks each of the
thirteen owners/definitions and every target column/FK before it changes anything; both files start with `set local lock_timeout = '5s'`; the committed migration is the generator's
rewrite of each original expression and the rollback restores exactly those; the precondition still holds; the proof checker resolves a
reused alias in the sub-select that binds it (two sibling `EXISTS` both aliasing `c`) and refuses a join; a real member query plans the
check as an InitPlan used as an index condition.

`tests/tenant-isolation-generic.test.ts` now also recognises `app.permitted_orgs` and `app.accessible_orgs` as organization-scoping helpers
(an additive change to its regular expression; without it every rewritten policy would be reported as unscoped).

## Verify on a staging copy before the hosted run

The hosted database must not be touched for this. Use a **restored copy** of the proposed target schema after its exact earlier migration
filenames have been reconciled through 0049, with the same PostgreSQL major version as production:

1. Check the files against the repository: `node --import tsx scripts/rls-initplan.ts --check`.
2. Run the verifier against the copy, passing its connection URL on the command line (the script never reads `.env`):

   ```
   node --import tsx scripts/rls-initplan.ts --verify-staging "postgresql://...restored-copy...?sslmode=require" --personas 40 --per-stratum 3 --yes-this-is-a-restored-copy
   ```

   In **one transaction that is always rolled back**, it picks up to `--personas` real users (default 25) plus an unknown id, records for
   each a count and an md5 of the primary keys it can see in every row-level-security table, applies the committed 0053, records again,
   applies the committed rollback, checks every policy is back byte for byte, and records a third time.

   The users are not simply the first ones. They are grouped into strata by everything the helpers read: platform role and account
   status; each membership's role and status and its organization's status; the full permission-override signature (organization,
   permission and grant/revoke effect, represented by a hash); whether the user has staff
   assignments, or several memberships; plus one stratum of members who own or are assigned a conversation where they lack
   `inbox.view_all`. It takes up to `--per-stratum` users from each (oldest first, default 3), round-robin: each pass takes the next user of
   every stratum, alternating between client users, agency staff and agency super admins, until `--personas` is reached. So a large agency
   cannot crowd out the clients, and the edge cases (overrides, revoked or suspended memberships, multi-organization users, inbox reps)
   are compared whenever the copy has them.

   It prints one line per stratum with how many users it took from it, then any difference, and exits 1 if there is one. It also exits 1,
   with a warning, if no client member (platform role `none`, active account, active membership in an active organization) was compared:
   such a run proves nothing for client users. Because it applies DDL, it holds table locks until it finishes (`lock_timeout` 5 s), which
   is why it must never run against production. It also proves the migration's preconditions pass on that database: if the copy prints an
   expression differently, or a helper the proof reads differs from the reviewed definition, the migration's own checks stop it and the
   verifier reports the error.
3. Only if step 2 stopped on a precondition because that PostgreSQL version prints an expression differently from PGlite 18: generate
   the two files from the copy's own catalog, review the diff, and run step 2 again:

   ```
   node --import tsx scripts/rls-initplan.ts --from-database "postgresql://...restored-copy..." --yes-this-is-a-restored-copy
   ```

   This runs the same generator, proof and rollback check inside one transaction that is rolled back, and rewrites the two files. Then
   re-run `tests/rls-initplan-guard.test.ts`; the equivalence test compares against PGlite's printing, so it would need the PGlite form
   back (keep both only if they differ, and say so in the review).
4. Optionally, apply 0053 for real on the copy (`npm run db:migrate -- --only 0053_rls_initplan` with the copy's `DATABASE_URL`, never the hosted one) and exercise
   the app against it; then run the rollback file on the copy to rehearse the undo.

The equivalence test itself always builds its own in-memory database from the migration files, and seeds and alters it freely; it cannot
be pointed at a real database, by design.

## Hosted rollout

Do not apply 0053 to the current hosted schema as-is: its missing CRM chain and duplicate numeric prefixes must first be reconciled and
tested on a restored copy. After that gate is met:

1. Confirm the exact full filenames through 0049 are present and the staging verifier passed on that exact schema.
2. Pick a quiet time and check for sessions that would block it: in `pg_stat_activity`, look for long-running queries and sessions
   `idle in transaction`, and let them finish or end them first.
3. Apply `0053_rls_initplan` with the exact-version runner (`npm run db:migrate -- --only 0053_rls_initplan`). Each `alter policy` takes an
   **ACCESS EXCLUSIVE** lock on its table until the transaction commits. The file starts with `set local lock_timeout = '5s'`, so a busy
   table rolls back the migration after five seconds; nothing changes. If any precondition fails, stop and return to staging with a fresh
   restored copy.
4. If a run hangs, cancel its backend with `select pg_cancel_backend(<pid>)` after finding it in `pg_stat_activity`.
5. Watch member reads (Contacts, the pipeline board, reports, the inbox) and agency views.

## Rollback

`supabase/rollbacks/0053_rls_initplan.down.sql`: checks each of the 166 policies still has the expression 0053 gave it (if a later migration
changed one, roll that back first), restores the original expression exactly, then drops `app.permitted_orgs` and `app.accessible_orgs`
(without CASCADE, so it fails if anything else started using them). No data is read or changed. It is part of the rollback chain
`tests/crm-migrations.test.ts` runs newest first.

The file has no `begin` / `commit` of its own, so run it as one transaction, for example
`psql "<url>" --single-transaction -v ON_ERROR_STOP=1 -f supabase/rollbacks/0053_rls_initplan.down.sql`. It takes the same locks as the
migration (ACCESS EXCLUSIVE on affected tables until it commits) and starts with the same `set local lock_timeout = '5s'`, which only takes
effect inside a transaction; the same pre-checks (step 2) and the same `pg_cancel_backend` remedy (step 4) apply.

## Measured effect (PGlite in-memory, indicative only)

A reduced run of the performance suite with the committed migration (a tenth of the data: 5,000 contacts in the target workspace) took
member reads from hundreds of milliseconds, or seconds for searches and reports, to tens of milliseconds: for example the first contact
page 408 ms to 38 ms, a phone-digits search 2.5 s to 64 ms, every report section over 90 days 2.9 s to 291 ms, the inbox list 152 ms to
12 ms. Permission lookups per call fell from tens of thousands to tens (24,964 to 51 for the first page). Every compared call returned the
same result in both phases. The earlier full-scale experiment with the same rewrite (50,000 contacts) measured tens to a hundred times.
These figures belong to the earlier helper model and are historical, not a benchmark of the final 0053 migration. Re-run the CRM scale
suite against the exact final schema before using timings as a release claim. The historical table is in `docs/crm-performance.md`.
