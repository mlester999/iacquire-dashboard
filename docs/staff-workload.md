# Staff workload

The agency team's own workload: who is carrying what, from the work already recorded in iAcquire. It shows a label and the facts behind it; it is not a performance score and it never changes an assignment by itself.

## What is counted

Four places only, read live from their own tables:

* support requests (`support_tickets`, with the response target and escalation in `support_ticket_ops`);
* client setup steps (`client_setup_tasks`);
* custom projects (`client_project_requests`, with their milestones and review tasks);
* maintenance requests (`maintenance_requests`).

Unified Inbox conversations, client CRM tasks and AI work jobs are deliberately excluded: they belong to the client or to nobody. A closed row leaves the load on the next read.

The pure rules are in `src/lib/staff-workload/rules.ts`. Every number there — point weights, the five label thresholds, the overdue floors, the five-day horizon, the team default capacity and the project-health limits — is a proposal from the audit, not a founder-approved business rule. A Super Admin can inspect what is in force on `/admin/workload/settings`; editing is deliberately not exposed yet. A person with no capacity and no team default has **no label**; the counts are still shown.

## Labels

`Available`, `Balanced`, `Busy`, `Overloaded`, `Critical`, from open points against the capacity that is left in the horizon. Overdue work and an escalated request set a floor, so a person with five overdue items cannot read as Available. The exact comparison is integer-only (`src/lib/staff-workload/labels.ts`), and capacity is never inferred from a person's activity or sign-in.

## Privacy and permissions

Migration `0097_staff_workload.sql` adds six tables, all row-level-security enabled and readable by the application role only through one select policy each, scoped to the agency workspace and the caller's standing. No browser role has any grant.

* `agency.workload.view` — your own label, your own work, your own time off. Every agency role has it by default.
* `agency.workload.team` — everyone's labels, the board, the calendar, project health and escalations. Managers and Super Admins.
* `agency.workload.assign` — give work from the board or a suggestion. Managers and Super Admins.
* `agency.workload.manage` — set another person's capacity, working days, skills and time off. Managers and Super Admins.
* `agency.workload.settings` — change the rules. Super Admin only, and not exposed for editing yet.

An item's title and client are shown only when the viewer can open that client and holds the permission for that kind of work; otherwise the item still counts in the person's points and is shown as a hidden count. Time-off kind and note are visible to the person and to the manage permission, never to a colleague who only holds the team permission. Client-facing pages never read these tables.

## Screens

* `/admin/workload` — team overview: summary, everyone's load, what needs attention, how work is shared, project health and the unassigned lane; for a person without the team permission, their own load.
* `/admin/workload/me` — the signed-in person's own load, open items and the reasons behind the label.
* `/admin/workload/board` — the full unassigned lane and who has room. Assignment goes through the module that owns the item (Support, setup, projects or maintenance), so that module's permission, history, notice and audit all still happen.
* `/admin/workload/calendar` — the planning horizon's dated work and project milestones, what is already overdue and what has no date.
* `/admin/workload/people/<id>` — one person: load, open work, capacity, working days, skills and time off. `/edit` holds the manage-permission forms.
* `/admin/workload/settings` — the module switch (Super Admin) and the rules in force.

The overview, board, calendar and person pages use the same services as the background job, so a screen and the history cannot disagree about a rule.

## The scheduled job

`staffWorkloadSnapshots` (every 15 minutes) is registered in `src/server/ops/tick.ts` but does nothing while the module is off. When on, for each active agency person it writes history when the label or points changed and once a day, opens and follows one alert when they become Overloaded or Critical, tells the people who hold the team permission once per person, label and day, tells a person once a day about their overdue items, tidies after people who left, and removes history older than 400 days. It has a 30-second budget and leaves the rest for the next run. The notices are in-app only; it calls no provider and sends no email.

The job is exercised through the real service in `tests/staff-workload-jobs.test.ts`, including the dormant case and an unchanged second run.

## Migration and rollback

* Apply `0097_staff_workload.sql` after `0096_staff_messages.sql`. It adds permissions, six tables, guards, policies and notification kinds; it seeds only `role_permissions` and no workload data.
* Roll back `0097_staff_workload.down.sql` **before** `0096_staff_messages.down.sql`. It refuses while a profile, time off, snapshot, alert, board assignment or changed rules exist; export those deliberately first. It removes the module switch and the two workload notification kinds, and rewrites the two permission-override lists without the workload permissions.
* The migration is additive and has been rehearsed with the combined chain on embedded Postgres. It has not been applied to a hosted database.

Nothing here has run against a real provider, a hosted database or a real customer.

## Tests

* `tests/staff-workload-rules.test.ts` — pure weighted rules, thresholds and boundaries.
* `tests/staff-workload-labels.test.ts` — the reference rational comparison and random combinations.
* `tests/staff-workload-migration.test.ts` — schema, grants, RLS, guards, permissions and rollback.
* `tests/staff-workload-jobs.test.ts` — the scheduled job through the real service.
* `tests/staff-workload-screens.test.ts` — the presentation rules (labels, links, capacity text).
* `tests/tenant-isolation-generic.test.ts` — the schema-wide policy guard that includes these tables.
