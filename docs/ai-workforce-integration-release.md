# AI Workforce guided configuration, review and notification integration

Status: local integration complete and verified; not pushed, not deployed, no production data changed.
Branch: `release/ai-workforce-integration` (isolated worktree `.data/wt-ai-workforce-integration`).
Final local commit: reported in the delivery response.

## 1. Base and integrated work

| Item | Commit / status |
| --- | --- |
| Confirmed production release / current `origin/master` | `466c96ed256af5cbb974440bd97aab39ed330f5c` — “Redesign the AI workforce profile, configuration, and chat experience” |
| Configuration review hardening | Branch `codex/config-review-hardening`; implementation `5d334c786b99e424c3a1b4acd97323ad858504cc`; documentation `9d05363`; merge `7eca09b` |
| Premium version history and notification centre | Branch `design/version-history-notifications`; committed locally as `8bacef0` from the completed working tree; merge `b4dc4fe` |
| Guided configuration, review UX and integration fixes | Final commit on the integration branch |

The notification/version-history work was complete but uncommitted on `design/version-history-notifications`. It was preserved as `8bacef0` before any integration work, without changing working files.

A parallel worktree, `.data/wt-notif-security` (`release/ai-workforce-notif-security`), was active during reconnaissance. Its commits later landed on `origin/master` and are included through the merge; it was never overwritten or forced.

## 2. Reconciliation with current master

The confirmed base at task start was `466c96ed256af5cbb974440bd97aab39ed330f5c`. While this integration was in progress, `origin/master` advanced to `03de0bf` (24 commits), including the AI Employees rename with `/employees` URLs and redirects, Support & Requests, the notification-authorization migration `0067`, and the serverless DB fix. The guided release was therefore merged with `origin/master` (`03de0bf`) before release, not shipped from the stale base.

The merge kept the master chat/navigation rewrite, adopted `/employees` routes throughout, preserved the guided configuration/review flow, and re-applied the version-history recovery affordances and role labels on top of master's legacy-attribution fix. The branch is now a fast-forward candidate from `03de0bf`.

## 3. Conflict resolution

- `src/components/workforce/employee-detail.tsx` — configuration-review-hardening conflicted with the premium profile rewrite. Resolution kept the premium hero/tabs/publishing layout and ported the hardening semantics: read-only approval policy, draft notice, reason-aware outcomes, truthful status labels, and the selected-draft entry point.
- `src/server/workforce/service.ts` — hardening added classification, decision guards, stale checks and audit metadata; the notification branch added routing, dedupe keys and version metadata. Resolution kept the hardening guard/decision/audit path, used the scoped notification routing, added the review reason to the notices, and sent decisions as `approval_decided`. Internal-agency saves remain silent so iAcquire does not tell itself it is reviewing its own configuration.
- `src/components/workforce/employee-detail.tsx` (notification merge) — the premium tabs were retained and the History tab was delegated to `ConfigVersionHistory` with the widened version shape and request-stable clock.
- `src/components/chat/chat-rail.tsx` / `chat-workspace.tsx` — adopted master's premium chat navigation and `/employees` manage target, then re-applied the `chat.rail`, `chat.employee` and `chat.composer` AQi anchors.
- `src/components/workforce/config-version-history.tsx` — adopted master's legacy internal-attribution fix, then re-applied role labels, draft recovery, the older-rejected guard and the pending-restore warning.
- `src/server/workforce/service.ts` — kept the hardened review flow and changed the held-review notification link to `/employees/<slug>?tab=history`.
- `tests/config-review-notifications.test.ts` — fixtures were changed from blocked instruction-override text to review-level approval-bypass text, matching the hardened classifier. Internal agency saves use `apply: true` so a held version is pending rather than a draft.

No conflict was resolved by blindly choosing “ours” or “theirs”; every security-relevant hunk was rebuilt from both sides.

## 4. Authoritative configuration decision

Server-side `classifyConfigChange` remains the only classifier. The UI preview (`previewConfigAction`) uses the same previous applied settings, company context, attributions and classifier, and performs no writes and no provider call. The save path remains authoritative. If the preview is unavailable, the form says so and lets the server decide.

| Outcome | Server behaviour | Client copy and UX |
| --- | --- | --- |
| `AUTO_APPLY` | Validate, apply, create an applied version | “Changes saved and applied successfully.”, actual version shown |
| `REVIEW_REQUIRED` | Save a pending version, leave the active version unchanged, notify scoped reviewers | “Your changes were saved and submitted for review. Your current configuration remains active.” |
| `BLOCKED` | Reject, create no version, keep editable values | “This change can't be saved because it conflicts with platform security rules.” |

Mixed safe/sensitive submissions are held as a whole and say so. The server never partially applies a mixed submission.

The approval preference is pinned server-side to the applied value (or the conservative default), rejected if changed, and rendered read-only with an explanation that the runtime approval gate does not currently read it.

## 5. Guided field architecture

- `src/lib/employee-field-guidance.ts` — role-aware field metadata: visible description, realistic example, deeper explanation, tool behaviour, company/knowledge guidance and plain-English fixes for every authoritative review code.
- `src/components/ui/guided-field.tsx` — one accessible field anatomy for the whole product:
  - human label, Required/Optional badge, visible description;
  - realistic placeholder/example and an optional info popover (click, keyboard and touch);
  - itemised error, warning and review notices with “How to fix”;
  - character guidance;
  - `aria-describedby`, `aria-invalid`, live error announcement and a keyboard-operable switch/choice group.
- `src/lib/agents.ts` — every role question now has real help text beside its example.
- Guided fields are wired into the employee configuration, the natural-language change request, employee knowledge entries/uploads, the company profile, AI preferences, and the company Knowledge Center. Onboarding already had visible help/required/example metadata; the company description, services, ideal customer and FAQ wording was aligned to the same standard.

## 6. Fields receiving guidance

Employee configuration (all roles):
`displayName`, `tone` (with per-option meaning and example), `replyLength`, `language`, both role questions per role, `responsibilities`, `goals`, `targetCustomers`, `companyRules`, `neverPromise`, `escalateWhen`, `escalationContact`, `customInstruction`, every granted tool toggle, and the locked `approvalPreference`.

Company and knowledge:
`companyName`, `industry`, `website`, `operatingArea`, `description`, `services`, `idealCustomers`, `brandColor`, workspace time zone, company-wide `language`, `companyRules`, `neverPromise`, `escalateWhen`, conversation retention, knowledge entry title/content, knowledge upload, company Knowledge Center sections (business description, products and services, FAQ, approved prices) and reference documents.

Change request:
the request itself, with visible guidance, example, info and a review/blocked preview before applying.

## 7. Role-specific examples

| Role | Main responsibilities example | Goals example |
| --- | --- | --- |
| Operations Manager | Monitor operational tasks, identify blockers, coordinate internal work, and prepare progress reports. | Help the agency meet deadlines and reduce unresolved operational issues. |
| Lead Hunter | Research businesses that match our ideal customer profile and prepare qualified lead records. | Identify relevant prospects with accurate business information. |
| Appointment Setter | Help qualified customers find available appointment times and manage booking requests. | Improve scheduling efficiency and reduce missed appointments. |
| Sales Assistant | Answer approved sales questions, explain services, and prepare follow-up drafts. | Help qualified prospects move through the sales process. |
| CRM Manager | Maintain accurate CRM records, identify incomplete data, and organize pipeline information. | Improve CRM data quality and visibility. |
| Performance Analyst | Analyze authorized business metrics and create performance reports. | Identify trends, operational improvements, and opportunities. |

Role questions additionally explain what each answer changes for that role, and the examples describe only work the role is permitted to do.

## 8. Version history, recovery and conflicts

- Premium timeline with real version number, truthful status and source, author/role, relative and absolute timestamps, concise real diffs, decision metadata, safety reasons, review evidence and restore.
- Internal agency legacy `client_edit` rows are correctly labelled “Internal edit”; client attribution is not relabelled.
- “Continue editing” for the current pending version and “Revise” for a rejected version when nothing newer is pending. Rejected versions older than a newer pending version show “A newer version is awaiting review” instead of offering a path that would discard it.
- `editableSettings(..., versionId)` reopens only the employee's own pending/rejected/draft versions. Applied versions are restored only through the audited rollback path.
- New submissions supersede older pending versions in the same transaction; the old row keeps its settings and flags as `superseded` and cannot be approved in parallel.
- `createConfigVersion` locks the employee row and `decideHeldVersion` locks it before the stale-version check, serialising saves and decisions.
- Restoring while a version is pending explicitly warns that the pending request will be superseded.
- The production Operations Manager v1 was not loaded, approved, rejected, deleted, reclassified or applied. No production database was contacted.

## 9. Review queue and notifications

- Internal `/admin/employees/reviews` queue with client, employee, version, submitter/role, applied version, reasons, before/after diff, compiled-instruction evidence for authorized reviewers, required decision note and audited approve/reject.
- Client detail review tab uses the same card; view-only agency teammates do not receive compiled prompts.
- Decision notes are required (minimum 5 characters) in both the dialog and the server action.
- Held versions notify the client with a truthful non-actionable confirmation and the scoped agency reviewers with `approval_requested`. Notifications are deduplicated per version.
- Decisions notify the client with `approval_decided`; the original review request is marked read so a decided item cannot linger as unread.
- Shared notification bell in client, agency and Super Admin shells; `/notifications` and `/admin/notifications`; filters, grouping, cursor pagination, read/unread, mark-all, relative time and absolute time title.
- No notification is fabricated; all use persisted events and existing recipients/scopes.

## 10. Chat and shell

- Shared chat rail uses master's premium navigation: readable on-dark branding via the shared `Logo`/workspace-nav tokens, workspace identity, Back to AI Employees, specialists, conversation history, search and New.
- Accurate readiness from the backend; connection-required state is shown honestly rather than as “Online”.
- “Manage employee” is a real authorized action; selecting an employee only navigates and does not start a model run.
- Quick reply-length changes use the draft-aware settings so they cannot discard a pending version; if the combined change needs review, the active value is restored and the person is told.
- AQi anchors added for employee profile, guided configuration, version history, chat rail, chat employee, chat composer and notification bell.

## 11. Verification

- Focused tests after the merge: 45 tests across guided configuration, version history, review recovery, review notifications, notification centre, workforce navigation and chat rail; all passed.
- Full automated suite on the reconciled code: **218 files, 3,359 tests passed**, exit 0.
- `npm run typecheck`: passed (`tsc --noEmit` and the scripts project).
- `npm run lint`: passed with 0 errors and 0 warnings after removing four imports that master's rewrite had made unused.
- Production build: passed with `next build --webpack` on the reconciled code. Turbopack cannot resolve the worktree's junctioned `node_modules`; webpack is the same mode used by local dev.
- Merged-route browser smoke: **9/9 checks**, 0 page errors — client `/employees/operations-manager?tab=configure`, `/employees/operations-manager?tab=history`, `/notifications`, `/chat/lead-hunter`; agency `/admin/employees/reviews`, `/admin/notifications`; guided field and AQi anchors present.
- Pre-merge visual QA (same guided UI, before the `/workforce` → `/employees` rename): client 53 checks / 23 screenshots and Super Admin 11 checks / 6 screenshots, both 0 failures and 0 console errors, including 1440/1024/768/390 widths, light/dark, info popover, review-required, blocked, safe auto-apply, version history, notification centre/bell, chat and axe WCAG A/AA. The merged-route smoke covers the rename; the screenshots were not recaptured under the new URLs.

## 12. Migrations

**No new migration is introduced by this release.** The guided fields, review hardening, decision metadata, version history and notification read-state changes use existing tables and columns.

Production state was verified read-only through the linked Supabase project (`lkkiavjwxaeoqgsbjyso`):

| Migration | Production ledger |
| --- | --- |
| `0065_support_requests` | Applied |
| `0066_rename_workforce_routes` | Applied |
| `0067_notification_authorization` | Applied (latest) |

The local QA database ledger also ends at `0067`; `npm run db:migrate:local` reports “No new migrations to apply.” No production migration write was needed or performed.

## 13. Remaining limitations

- The “Ask before any business action” preference is still not consulted by the runtime approval gate. The UI and server pin it and say so; full runtime enforcement remains a separate project.
- Tool switches change the compiled instructions; the provider profile and connection check remain the enforced boundary.
- Visual QA screenshots were captured before the master rename and were not recaptured under `/employees`; the merged-route smoke and full UI test suite cover the renamed routes.
- `next start` refuses local non-Supabase auth, so production-mode browser QA was not run locally.
- The isolated chat fixture has no Hermes profile, so the captured chat state is the honest “connection check required” state, not a live composer. The ready-state chat composer and run gate are covered by tests.

## 14. Recommendation

**GO for push/deploy of the reconciled commit.** The branch now contains current `origin/master` (`03de0bf`), the full suite and build passed, production migration `0067` is applied, and the merged-route smoke test is green.

No production migration, activation, Hermes run, VPS or Cloudflare change is required by this work. Rollback for the application is redeploying `03de0bf`; no new schema rollback is involved.
