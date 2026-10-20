# Notification authorization after client-access revocation

Status: implemented and verified locally on `release/ai-workforce-notif-security`; **not pushed, deployed or applied to any hosted database**.

Integration base: current `master` (`27fe4f7`) plus the configuration-review hardening and notification-centre integration (`b4dc4fe`, with conflicts resolved in favour of the hardened review flow and the current master support/sidebar work).

## 1. Root cause

Agency notifications were selected at write time from `staff_assignments`/`agency_user_client_scopes`, but every agency row was stored with `org_id = null`. Read authorization was therefore only `user_id = current_user` plus RLS on the same column. When an Agency Manager or Staff member lost a client, the old row remained in their feed, unread count, mark-read set and email delivery path.

`notifyAgency()`, the Support & Requests producer and direct `notifyUser()` calls all created agency rows. Fixing only `notifyAgency()` would have left the support and direct paths open.

## 2. Model

`notifications.audience` is one of:

| Audience | Meaning | Read rule |
| --- | --- | --- |
| `client` | A client or account-level notification | Recipient, and the client org is null or the recipient can currently access it |
| `agency` | Agency mail about a client, or agency-wide mail | Recipient; client rows require current access to that org; `org_id is null` requires `agency.security.manage` |
| `direct` | Internal mail addressed explicitly to one person | Recipient only |

`app.notification_visible(user, audience, org)` is the single predicate. It is used by:

- the notification RLS select policy;
- the notification RLS update policy;
- `listNotifications()` (bell dropdown and full inbox);
- `unreadCount()` (agency shell badge);
- `markNotificationsRead()` (single and all);
- the notification email delivery query;
- the client shell unread count.

The feed mode is derived from the authenticated account's current `users.platform_role`, not from the route. A role change therefore switches the same account between the agency and client models; it cannot keep a stale agency feed open after the person becomes a client account.

## 3. Producers

- `notifyAgency(orgId, …)` writes `audience = 'agency'` and `org_id = orgId`. It still selects only current recipients.
- `notifyUser(userId, orgId, …)` writes `agency` for an agency recipient with a client org, `direct` for an agency recipient without an org, `client` for a client recipient with an org, and `direct` for an account-level client notice.
- `notifyOrgRoles()` writes `audience = 'client'`.
- `dispatchSupportNotice()` writes the ticket's `org_id` for both client and agency recipients and the matching audience.
- Agency project assignment now passes the project's client org instead of `null`.
- Direct `insert into notifications` statements were audited; the only remaining one is the client-role CRM form notifier, which relies on the `client` default.

## 4. Historical backfill

Migration `0066_notification_authorization`:

1. adds `audience` with a safe `client` default;
2. marks historical rows addressed to agency accounts as `agency`;
3. associates historical agency rows with a client only where the stored destination proves it — an exact `/admin/clients/<uuid>`, `/admin/projects/<id>` or `/admin/support/<id>` link;
4. leaves every other historical agency row as agency-wide (`org_id = null`), visible only to `agency.security.manage`.

No notification row is deleted. The conservative default can hide an unresolvable historical row from Agency Manager/Staff, but it cannot leave a client-specific row visible after revocation. The production table currently contains one notification, addressed to an agency Super Admin with a non-null org; there are no null-org rows to backfill there.

The migration is prepared locally and **not applied**. Production remains at `0065_support_requests`.

## 5. Verification

Focused authorization suite (`tests/notification-authorization.test.ts`, 4 tests):

- Agency Staff assigned to clients A and B sees both; after A is revoked, A's agency alert and A's direct staff mail disappear, B and internal direct mail remain.
- The unread count and feed agree; a hidden id cannot be read or updated under RLS; mark-read by guessed id is a no-op; "mark all" only marks visible rows; restoring access restores the same history without re-inserting it.
- Agency Manager `all_clients` sees both; switching to `assigned_clients` and removing the assignment removes the feed.
- An account changing from `agency_staff` to a client owner moves from the agency feed to the client feed; changing back restores only agency mail.
- Client Admin sees their client mail; losing membership hides it.
- Agency-wide mail disappears when the account loses `agency.security.manage`.
- The bell and full inbox return the same rows and unread count at different limits.
- The Support & Requests producer stores `audience = 'agency'` and the ticket's `org_id`; revocation hides it.

Existing regression: `config-review-notifications`, `config-review-hardening`, `config-version-history`, `workforce-config`, `agency-team-permissions`, `shell-query`, `support-notifications`, `support-lifecycle`, `notification-center`, `operations` (email delivery) and `tenant-isolation` all pass.

Repository-wide `npm run lint` is clean (0 errors, 0 warnings) on the merged worktree. `npx tsc --noEmit --incremental false` is clean. The full integration suite is recorded in the final release report.

## 6. Known limits

- The migration is not applied; the production code at `5c93fc1`/`27fe4f7` still has the old null-org behavior until this branch is deployed and `0066` is applied.
- Historical agency rows that cannot be associated from their stored link stay agency-wide and are hidden from Manager/Staff. This is intentional and is not deletion.
- A future producer that inserts into `notifications` directly must set `audience`/`org_id` deliberately; the `client` default will not make an agency row scope-aware.
- The notification email path is covered by the shared predicate and the existing operations tests, not by a live email provider.
