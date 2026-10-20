# Version History and Notification Centre

Status: implemented locally on `design/version-history-notifications`; not deployed.

## 1. Root cause: why Super Admin had no notifications

The backend was already writing agency notifications:

- `notifyAgency()` in `src/server/notifications.ts` inserts rows for active agency users whose current client scope includes the tenant (or who hold `agency.security.manage` for agency-wide events).
- Support, onboarding/provisioning, setup, incidents, payments, maintenance and other producers already call it.

The missing piece was entirely in the agency presentation layer:

1. `src/components/admin/admin-shell.tsx` rendered search, theme and account controls but **no notification bell at all**.
2. `src/app/(admin)/admin/layout.tsx` fetched memberships but **never queried an unread count**, so it had nothing to pass to a bell.
3. The only full notification page, `src/app/(portal)/notifications/page.tsx`, lives inside the `(portal)` group and requires an organisation context. An agency-only account has no safe portal destination for "View all".

So the correct classification is: **already implemented on the server, restricted by no role, using the same backend query, but missing from the agency layout and without an agency route.** The fix is a shared centre rendered in both shells plus `/admin/notifications`.

## 2. What changed

### Shared notification architecture

- `src/lib/notification-presentation.ts` — one vocabulary for categories, compact relative time, group labels, version provenance, version status and safety-flag labels. The category mapping only uses notification kinds that already exist in the database.
- `src/components/notifications/notification-visuals.tsx` — type icon/tint, category chip, timestamp pill and severity mark.
- `src/components/notifications/notification-row.tsx` — one row used by the bell and the full inbox, with `compact` and `full` variants.
- `src/components/notifications/notification-center.tsx` — the bell, popover, unread badge, mark-all, open-and-mark-read, loading/error/empty states, keyboard/screen-reader labels and 30-second timestamp ticks.
- `src/components/notifications/notification-list.tsx` — the full inbox with All/Unread/Needs-attention filters, category filter, search, day grouping, cursor pagination and mark-all.

### Super Admin

- `src/app/(admin)/admin/layout.tsx` now queries `unreadCount(user.id)` and passes the signed-in person's time zone.
- `src/components/admin/admin-shell.tsx` now renders the shared bell and "View all" points at `/admin/notifications`.
- `src/app/(admin)/admin/notifications/page.tsx` is the agency inbox. It uses the same RLS-backed query as the client bell and does not accept a user or organisation id from the browser.
- `src/lib/admin-breadcrumb.ts` names the new page.

### Version history

- `src/server/workforce/service.ts` now returns the stored settings snapshot, `policy_version`, `created_by`/`decided_by` ids and joined names, plus decision timestamps. It parses snapshots defensively; a version that predates the current schema still renders its metadata and summary, but is never fed to the diff renderer.
- `src/components/workforce/config-version-history.tsx` is the new timeline/cards experience:
  - prominent version tile, status and recorded-source badges;
  - author/creator line, relative timestamp with absolute time on hover and in details;
  - concise list of real field differences against the previous recorded snapshot;
  - a collapsed disclosure with the version record, policy version, version id, safety review, field-by-field before/after values and the recorded summary;
  - status-specific surfaces for active, awaiting review, not approved, superseded and draft;
  - restore remains a real server action with its existing permission check.
- `src/components/workforce/employee-detail.tsx` keeps its existing tab structure and delegates the history tab to the shared component.
- `src/app/(portal)/workforce/[slug]/page.tsx` serialises the new decision date and passes one request-stable `now`.

No compiled instructions, hidden policy, credentials or secrets are selected by the history query. Only the client-facing settings snapshot, version metadata, decision metadata and stored risk flags are returned.

### Recipients of held configuration versions

Verified bug: `createConfigVersion()` held a risky version and called `notifyOrgRoles(db, orgId, ["owner","admin"], …)` only. The agency reviewer received nothing.

Now, for a held **client** configuration:

- the client owner/admin receives the confirmation that the change is waiting for review and a link to the employee's history;
- agency users whose current scope includes that client receive an actionable `approval_requested` notification linking to `/admin/clients/{orgId}?tab=reviews`;
- users outside that client scope are excluded by `app.user_can_access_org()` inside `notifyAgency()`.

When an agency reviewer decides the version:

- the client receives `approval_decided` with the real decision (applied or not approved) and a link to the version history;
- the notification is deduplicated by version id.

An internal agency workspace no longer sends the client-facing "waiting for iAcquire review" message to its own Super Admin. The held version stays visible in version history and the audit log. This does not change the pending/rejected transitions or the risk validator.

## 3. Permission and tenant boundaries

- `listNotifications()` now has an explicit `user_id = $n` predicate in addition to RLS, and the shell unread count does too.
- `markNotificationsRead()` has the same explicit user predicate for both single and "all" operations, and a client's read action is scoped to the active workspace so it cannot silently clear another workspace's badge. Agency read actions remain cross-client because the admin feed is intentionally agency-wide.
- A client account's feed is also filtered to the active workspace (unscoped account-level notices remain visible). The shell unread count uses the same workspace predicate. An agency feed remains cross-client by design because the reviewer's scope is enforced by the client-access helper, not by hiding their assigned work.
- Cursor pagination is ordered by `(created_at desc, id desc)` and uses both values, so repeated timestamps cannot skip or repeat rows.
- The browser sends only a limit and an opaque cursor; it never sends a user or organisation id.
- Notification links are still internal paths sanitised by `safeLink()` on write. Destinations re-check access: client pages use `requireOrgContext`, and `/admin/clients/[id]` uses `getTenantDetail`, which enforces agency client scope.
- The bell is rendered in the agency shell only for authenticated agency users; the full agency page uses `requireAgency()`.
- The shared component is data-agnostic: client space, agency space and Super Admin space each pass only their own already-authorised feed.

### Known pre-existing limitation

`notifyAgency()` still stores agency notifications with `org_id = null`. The row is user-scoped, but if an agency user later loses that client assignment, an older client-specific notification can remain visible in their inbox. Fixing this properly means persisting the client org on agency rows and adding a scope-aware read policy/backfill. That is a backend/migration decision outside this UI task and should be coordinated with the configuration-review hardening work; no migration was added here.

## 4. Provenance dependency (configuration-review hardening)

The current portal actions still persist an internal agency save as `source = "client_edit"` (`src/app/actions/workforce.ts` and `src/app/actions/chat.ts` hardcode it). The parallel `codex/config-review-hardening` work introduces `configAttribution()` and `configSourceLabel()` to derive `source`/`actorKind` from trusted server context.

This UI deliberately does **not** guess an actor type. It renders the persisted source:

- `client_edit` → "Client edit"
- `agency` → "Internal agency edit"
- `onboarding` → "Onboarding configuration"
- `change_request` → "Change request"
- `rollback` → "Restored version"
- unknown/null → "Source not recorded"

The details panel also shows the raw persisted source key for auditability. Until the hardening branch lands, legacy internal edits will therefore still read "Client edit"; that is faithful to the stored data and is preferable to masking it. After the hardening change, new internal saves persist `agency` and render as "Internal agency edit".

The hardening branch also adds review reasons, blocked-content handling, decision notes and a dedicated internal review queue. Its `createConfigVersion`/`decideHeldVersion` rewrites own the same notification block touched here. See "Merge coordination" below.

## 5. Merge coordination

Two other worktrees were active while this was built:

- `C:\Users\ZEPHY\AppData\Local\Temp\iacquire-ui-premium` (`design/ai-workforce-premium`) — uncommitted premium AI Workforce UI, including `employee-detail.tsx` and `src/server/workforce/service.ts`.
- `C:\Users\ZEPHY\.codex\worktrees\config-review-hardening\iAcquire-dashboard` (`codex/config-review-hardening`) — uncommitted review/approval hardening, including `src/server/workforce/service.ts`, `src/app/(portal)/workforce/[slug]/page.tsx`, `src/components/workforce/employee-detail.tsx` and the notification block.

This branch was created from `master` in the main checkout and does not modify either worktree.

Expected conflicts:

- `src/server/workforce/service.ts` — the hardening branch rewrites `createConfigVersion` and `decideHeldVersion`. Resolution: keep its decision/blocking/attribution logic and use its notification routing, then retain the stronger points from this branch: dedupe keys, `?tab=history` on the client decision link and the explicit "no client-facing held message in an internal workspace" rule.
- `src/components/workforce/employee-detail.tsx` — the premium branch changes the whole detail screen and the hardening branch changes the old `HistoryTab`. Our change is intentionally tiny: one import plus a `HistoryTab` that renders `ConfigVersionHistory`. The new history component can be kept while the surrounding redesign is resolved by hand.
- `src/app/(portal)/workforce/[slug]/page.tsx` — both the premium and hardening worktrees change this page. Keep the extra `now` prop and the `decided_at` serialisation from this branch.
- `src/app/(chat)/chat/[slug]/page.tsx` — the premium branch edits it; our one-line null-safe `settings?.replyLength` change is compatible.

The final branch was merged forward onto the latest `master` twice before release: first `6ce1a7c` (premium AI Workforce redesign) and then `b196d96` (Support & Requests). The `employee-detail.tsx` conflict was resolved by keeping the premium screen and replacing only its `HistoryTab` body with `ConfigVersionHistory`, plus the `now` prop through the page. The support merge added its notification kinds to the shared vocabulary, so `support_assigned`, `support_status`, `support_escalated` and `support_sla` render as the Support category; the sidebar's new "Requests" label was kept alongside the new `/admin/notifications` breadcrumb. The hardening worktree was not merged or touched.

## 6. Verification evidence

Automated:

- `tests/notification-presentation.test.ts` — compact time, time-zone day boundaries, category mapping, source labels, statuses, risk labels.
- `tests/notification-center.test.tsx` — real saved rows, "5m ago" plus absolute title, unread row, open marks read before navigation, mark-all success/failure and unread rollback.
- `tests/config-version-history.test.tsx` — held version status/source, real field differences, expansion, safety flags, restore through the server action.
- `tests/config-review-notifications.test.ts` — client confirmation, scoped agency reviewer, out-of-scope exclusion, decision notification, internal-workspace suppression, settings/decision metadata.
- `tests/workforce-config.test.ts` and `tests/shell-query.test.ts` — existing versioning and shell behaviour, plus a new check that a two-workspace client sees only the active workspace's notifications while an unscoped agency-style feed still sees both.

Full suite after merging the latest premium AI Workforce and Support & Requests master: **212 test files / 3310 tests passed** (`npx vitest run --testTimeout=60000`). An earlier default-timeout run hit one 30-second timeout in `setup-center` while the machine was saturated by parallel work; that file passed 37/37 in isolation and in both later full runs.

Production build after the merge: `IAQ_DIST_DIR=.next-notif npm run build` completed successfully, including the new `/admin/notifications` route. TypeScript (`npm run typecheck`) and targeted ESLint over every changed source/test file pass. The repository-wide `npm run lint` still reports the pre-existing generated/untracked artefacts in this checkout (`tmp/`, build output and similar); it is not a clean-tree invocation and none of its findings are in the changed files.

Browser QA (real Chromium against an isolated local PGlite database; screenshots in `docs/design-qa/notifications-version-history/`):

- `client-version-history-light.png`, `client-version-history-details-light.png`, `client-version-history-dark.png`, `client-version-history-mobile.png`
- `client-notification-center-light.png`, `client-notification-center-dark.png`, `client-notification-center-mobile.png`
- `agency-notification-center-light.png`, `agency-notifications-light.png`

Checks performed: held version renders with its real status/source, details expand to real before/after values, bell opens, unread rows exist, popover stays inside desktop and 390px mobile viewports, mobile page has no horizontal overflow, agency header has the bell, the agency centre shows the held client review and the full agency inbox shows the same saved event.

## 7. Migrations

None. No schema change was needed for the bell, the inbox, the history data or the recipient notifications. The existing `notifications` kinds and columns were sufficient.

## 8. Commit and push

The branch was pushed to `origin/master` on 2026-10-20. Its history is the feature commit `c84874e`, the merge of the premium AI Workforce redesign (`6ce1a7c`), the merge of Support & Requests (`b196d96`), and the sidebar AI Employees label commit (`d5ea48a`). The final `master` SHA, including this documentation follow-up, is reported in the final response.

No migration was authored or applied by this work. The only newer migration now in `master` is `0065_support_requests` from the pre-existing Support & Requests merge; it remains unapplied and still requires its documented staging acceptance and separate approval. No manual deployment, email, AI provider or production data write was made by this work.
