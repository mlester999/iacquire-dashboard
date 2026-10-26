# Who at iAcquire can read a client's content (founder decision D70, OPEN)

Status as of 2026-10-26: **the founder has not decided. Today's behaviour is unchanged.** A stricter rule is built, tested and switched **off**; migration `0112_client_content_policy.sql` (rollback beside it) is not applied to any hosted database. Nothing in this document is a promise to clients that the stricter rule is on.

**What changed in this pass.** The stricter rule now also covers the one reader it previously missed: the admin client-detail screen reads with trusted server access (`withSystem`), so row-level security could not answer for it, and it used to show a client's *held* knowledge text and its failed runs' error text to any agency person with `agency.workforce.view`, with no session and no review permission. It now asks the same question the database asks (`clientContentAccess()`: the switch, plus an active, unexpired, unended support session on that client). With the rule off — today — nothing changes. With it on, the screen says how many held entries are withheld and why instead of looking empty. Proven by `tests/client-content-policy.test.ts`. **The decision below is still the founder's**; nothing was switched on.

## The question

Assigned iAcquire staff can read a client's **approvals, activity log, shared knowledge and leads** without a support session. The client's **CRM, inbox, calls and analytics** already need one: a reason of at least five characters that the client can see, a time limit (60 minutes to read, 30 to write, never more than four hours), a mode, and an audit entry (`crm.support_session_started` / `_ended`). A write session also tells the client's owners and managers. Should the first four be behind the same rule?

## What anyone can read today, by role (switch OFF, as it is now)

Rows are limited by row-level security, which is driven by `app.permitted_orgs` / `app.has_permission`. "Assigned" means a row in `staff_assignments`; Agency Managers on `all_clients` scope reach every client; Super Admins reach every client.

| Content | Client owner, admin and members | Assigned Agency Staff / Manager (no session) | Agency Staff not assigned | Super Admin |
| --- | --- | --- | --- | --- |
| CRM, inbox, calls, analytics | By their client role | **Only inside a support session** | Never | **Only inside a support session** |
| Approvals (title, target, action details) | By their client role | **Yes** | Never | Yes |
| Activity log of the client's employees | Owner, admin | **Yes** | Never | Yes |
| Shared knowledge entries | By role | **Yes** | Never | Yes |
| Leads | By role | **Yes** | Never | Yes |
| Audit log of the workspace (what was done, by whom, with amounts and counts in its metadata) | Owner, admin | **Yes** | Never | **Yes, always, with the switch on or off** (see "What stays readable") |
| Invoices and payments | Owner, manager, sales rep | **None** (not delegable) | None | None |
| Aggregates (counts of pending approvals, health, usage) | n/a | Yes, from the admin screens (they read counts, not content) | n/a | Yes |

Read from `src/lib/permissions.ts` (the matrix) and the two functions; `tests/client-content-policy.test.ts` proves the behaviour in this table that concerns the four permissions.

## What the stricter rule does (switch ON)

`app.has_permission` and `app.permitted_orgs` treat `approvals.view`, `activity.view`, `knowledge.view` and `leads.view` in the agency branch exactly like the CRM permissions: an **active read or write support session on that client** is needed, for everyone on the agency side including Super Admins. An expired or ended session unlocks nothing. Client members are unaffected. The rule lives in the database, so it covers every read made under the signed-in person's row-level security (screens, exports and services that use `withUser`) rather than only the screens that remember to ask. **The database cannot answer for code that reads with trusted server access (`withSystem` / `readSystem`)**, so each such reader that shows content asks the same question itself (`clientContentAccess` and `contentSessionScope` in `src/server/admin/client-content-policy.ts`); the list of those readers, and what each does, is below. The change is in the function text only (the gate list and the session lists); the test compares the old and the new answers for every permission, every standing and every session state with the switch off and finds none different.

### What stays readable with the switch ON (found in the 2026-10-26 review)

1. **The audit log, for a Super Admin.** The audit table's policy has a branch of its own, `app.is_agency_admin()`, besides `activity.view`. It is kept on purpose: the audit log is the record of what staff did, including every support session, so reading it cannot depend on a session that a staff member opens for themselves. Assigned staff and managers lose it with the switch on (it rides on `activity.view`); a Super Admin does not. Audit metadata holds amounts, counts, references and short reasons, not message bodies or lead details, but the founder should know it can name a lead or an invoice number. `tests/client-content-policy.test.ts` pins this: the list of policies guarded by the four permissions is fixed, and `audit_logs` is the only one with a branch around the permission.
2. **Trusted server code that reads without the person's row-level security** (`withSystem` / `readSystem`). These read operational facts, not the content the four permissions guard, but they would show some of it to staff without a session, so each is a decision under option B:
   * `src/server/admin/queries.ts` (client detail): the knowledge a client submitted that is **held for agency review** (the review queue exists so an agency person can read it before AI employees may use it), and the last ten failed runs with their error text. **Closed on 2026-10-26**: this reader now asks `clientContentAccess()` and withholds both while the switch is on and no session exists (`tests/client-content-policy.test.ts`). With the switch off it behaves exactly as before.
   * `src/app/(admin)/admin/employees/[slug]/page.tsx`: the **agency's own** AI employees (its own workspace, not a client's), so the rule does not apply: nothing of a client is read.
   * `src/server/aqi/ops/tools/workforce.ts` (AQi Operations copilot, Super Admin only, scoped through `app.user_can_access_org`, every call audited): pending approvals with title, kind and risk, and recent runs with error text. **Closed on 2026-10-26**: with the switch on, an approval's **title** and a run's **error text** are withheld for every client this person has no active support session on (the kind, risk, age, count, error class, status, tools and timings are not content and stay); the result says how many titles were withheld. With the switch off it behaves exactly as before. `tests/aqi-ops-tools.test.ts` covers no session, a session on another client, a session on this client, an expired and an ended one, the platform-wide list, and the switch off.
   * `src/server/admin/health.ts`, `src/server/aqi/ops/briefing.ts`, `overview.ts`: counts only.
   None reads a lead's name, a knowledge entry that has already been approved, or an approval's action details. After this pass every trusted reader that shows a client's content is under the switch; what remains outside it, on purpose, is the audit log for a Super Admin (item 1) and counts.

What the founder should know before choosing ON:

* A dashboard count of approvals, activity or leads read **under row-level security** shows nothing to staff who have no session. (Counts the admin screens read with trusted server code, such as an employee's pending approvals on the employee card, are unchanged: they are aggregates, not content.)
* Staff must open a session (with a reason the client can see) to help with a held approval or a lead question. That is the intent.
* Read sessions still do **not** notify the client; only write sessions do. That is a separate open question (below).

## The switch

`agency_policy_switches` (key `client_content_needs_support_session`; a row exists only after a change, no row means off). A **Super Admin** changes it on **Admin → Agency team** with a written reason (at least ten characters). The change is in the audit log (`agency_policy.client_content_session_required` / `_not_required`, with from, to, the reason and the four permissions) and staff are told. Asking for the state it already has writes nothing. The table has no grant for any signed-in role. The rollback is refused while the switch is on.

## Least privilege that is already true, and what is not claimed

* Agency staff have **no** invoice or payment-record access, ever (the matrix); sealed credentials have no grant for the application role; a support session is the only audited route into the CRM.
* Not claimed: that read sessions notify the client, that the audit log is reviewed by anyone on a schedule, or that Agency Managers should default to `all_clients` scope (they do today).
* Hermes memory and `session_search` are keyed by workspace and role, but whether one person's content can surface in another's session is **unverified** and needs a live two-session canary before any customer-facing launch (see the AI employee readiness docs).

## Decision memo for the founder

| Option | What changes | Cost | Recommendation |
| --- | --- | --- | --- |
| A. Keep today | Nothing. Assigned staff read the four without a session | The CRM rule and this rule disagree; a client's approvals and leads are readable without a recorded reason | Acceptable for a small trusted team and the first clients; disclose it |
| B. Require a support session for the four | Switch on (this migration). Staff open a session with a reason | A few more clicks for staff; some dashboards show nothing for staff without a session | **Recommended before real customer data is loaded**, because it closes the gap with one audited mechanism and can be switched off again. The trusted reader in the admin client detail now follows the switch, so option B no longer has a known hole in the admin screens |
| C. B plus notify the client when a read session opens | B and a client notice for read sessions | More notices for clients | Decide together with B; not built (only write sessions notify) |

Nothing is switched on, and no client has been told anything, until the founder decides. **The decision that is still open is not technical:** whether a read session should be required at all (A versus B), and whether it should tell the client (C). The enforcement for A and B is built and tested; C is not built.

## Tests

`tests/client-content-policy.test.ts` (15, embedded Postgres): off by default; assigned staff and managers read as before; the old and new functions agree for every permission/standing/session state with the switch off; with it on the four need a read or write session, an expired or ended one unlocks nothing, members are unaffected, exactly the four permissions change; only a Super Admin changes it, with a reason, audited; a no-op writes nothing; the table is server-only; the rollback is refused while on and restores the old functions; **and the admin client detail withholds a held entry's text (saying how many it withheld) when the rule is on and the reader has no session, shows it with the rule off, and shows it again inside a session.**
