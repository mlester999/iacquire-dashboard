# Phase 4 checkpoint report: AI social media manager

Date: 2026-10-23. Branch `feat/phases-3-7` (local commits only), Phase 4 spans `76289ce` to `edd66ed`. Nothing pushed, deployed or applied to any hosted database. No post was ever sent to a real platform.

## 1. What was built

* **Accounts.** Facebook Pages and Instagram professional accounts through one adapter interface. Connection is the Facebook login flow (single-use hashed state, Page chooser, sealed credentials the application database role cannot read), with health checks, revocation, disconnection and Meta's deauthorize and data-deletion callbacks (signature verified). A simulated platform stands in for tests and browser QA and is refused in production. Connecting a real account is not possible until a Meta app exists (blocker).
* **Posts and approval.** Drafts, a version-bound approval (any edit voids it), request changes, reject, duplicate, cancel, retry, and a way for a person to settle a post whose outcome is unknown. AI-written drafts always need a person's approval; the agency never approves what a client publishes. Every action is an event with its actor.
* **Durable publisher.** One live job per post, leased and resumable, with an idempotency key and step checkpoints; a lost answer is reconciled with the platform before anything is re-sent; retries with back-off; an overdue post (more than six hours late) is not sent; jobs for a suspended, paused or shut-down workspace wait; a failing job cannot strand the others; failure notices and Automation Studio events are per failed job.
* **AI help.** Ideas and captions from approved company knowledge only, in the owner's tone, with industry as context; common unsupported claims, prices, percentages and contact details are dropped; every result is an editable draft; per-person and per-workspace rate limits and usage records.
* **Media.** Managed library on the private-file service (managed plan only, with a per-workspace storage cap and a visible usage bar), per-platform validation (Instagram: JPEG, 4:5 to 1.91:1, EXIF orientation read), Drive and OneDrive honestly shown as "not available yet".
* **Calendar and screens.** Month, week and list views in the client's time zone, composer with live platform checks and preview, approvals, post page, accounts, media, analytics, settings; calendar keeps its history when accounts are disconnected; only buttons the server will accept are offered.
* **Analytics.** Only numbers the platform returned (absent, never zero); leads tied to a post only when their own recorded visit carried that post's tracking code and only counting outcomes that happened after the visit; per-post and per-campaign tables with "Not tracked" where a post cannot carry a code.
* **Integrations.** Three Automation Studio triggers; a read-only Performance Analyst review (failed or unconfirmed posts, approval backlog, accounts needing reconnection, campaign and engagement patterns only with enough returned numbers); four scheduler jobs (`socialPublisher`, `socialAccountHealth`, `socialMetrics`, `socialCleanup`); offboarding shutdown disconnects accounts; the client export includes social data and media files without credentials.

Migration: `0089_social_media_manager` with a rollback that refuses while data exists. Next free number: 0090 (reserved in the plan for the shared document buckets).

## 2. How it was verified

Exact output is in `verification-evidence.md`. In short:

* **Adversarial review:** eight risk lenses plus a requirement-coverage mapper, 82 agents, every finding checked by independent skeptics: 66 confirmed (about 40 distinct defects; one critical, a crash after the platform accepted a post could replay the job and post twice), 3 refuted. All were fixed or recorded; the fixes carry tests that fail without them (the durability suite fails 44 tests against the pre-fix source).
* **Gates:** full suite 352 files, 5,571 passed, 1 skipped, 0 failed; both typechecks clean; eslint clean on all 92 changed files; clean webpack build passes with all Social routes; migration rehearsal `scripts/rehearse-phase4-migrations.mjs` sections A to E ok (unique number across 65 branches and 20 trees, six apply orders identical, data and 98 file-permission answers unchanged, eight rollback refusals, exact return, row-level security and credential probes).
* **Browser QA** (isolated app, simulated platform and model): every Social screen at 375 and 1280 px, light and dark, owner and read-only roles, agency staff; approve, edit-voids-approval, schedule, disconnect failing a scheduled post honestly, AI helper, validation messages, storage bar, campaign table. Found and fixed one real contrast failure (today's date marker in dark mode). The only remaining axe finding is the sidebar AI-employee link names, which exist on every portal page and are not Phase 4.

## 3. Status by evidence class

| Capability | Built | Locally tested | Integration-tested (embedded Postgres, real internal services) | Browser-QA'd (isolated app, simulated platform) | Real provider | Deployed | Production-verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Accounts, OAuth flow, health, revoke | yes | yes | yes | yes (simulated accounts) | **no Meta app** | no | no |
| Posts, approval, audit | yes | yes | yes | yes | n/a | no | no |
| Durable publisher, idempotency, reconcile | yes | yes | yes | yes (scheduling, failure, disconnect) | **never sent to a real platform** | no | no |
| Meta Graph adapter | yes | yes (replaced HTTP layer) | partial | no | **no** | no | no |
| AI drafting and claim filter | yes | yes (stubs) | yes | yes (simulated model) | **no real model** | no | no |
| Media library, storage cap, validation | yes | yes | yes | yes | n/a (Drive and OneDrive blocked) | no | no |
| Calendar and screens | yes | yes | yes | yes (375/1280, light/dark, roles) | n/a | no | no |
| Analytics, campaign rollup, lead evidence | yes | yes | yes (end-to-end through the real form path) | yes | reach and impressions blocked | no | no |
| Automation triggers, analyst review | yes | yes | yes | **editor not opened** | n/a | no | no |
| Scheduler jobs | yes | yes (injected clocks) | yes | n/a | **never run live** | no | no |
| Offboarding and export | yes | yes | yes | no | n/a | no | no |
| Migration 0089 | yes | n/a | rehearsed up, down, up with data, six orders | n/a | n/a | **no** | no |

## 4. Status estimates

* **Feature completeness of Phase 4: about 85%.** Method: the coverage map's 4A to 4I rows (about 70 requirements) judged by the review's mapper, then re-counted after the fixes. Built and tested: everything in 4A to 4F and the analytics, campaign and approval parts of 4H. Not built: Inbox conversations from Messenger or Instagram messages, Drive and OneDrive media, reach and impressions (all need Meta or Google approvals and are blocked-external), an agency-side calendar screen (a decision), AI Employees preparing drafts or recommending posting times beyond the Performance Analyst's read-only review (a product decision, no seventh employee).
* **Production readiness of Phase 4: about 45%.** Method: fifteen gates, each counted only with evidence. Met (7): full suite green; typecheck and lint clean; clean build; migration rehearsal incl. RLS and credential probes; browser QA in three viewports, light and dark, with role views; adversarial review with every confirmed finding fixed or recorded; crash, replay and duplicate-publish tests. Not met (8): a Meta app with approved permissions and business verification; a founder-approved real publish to a Page the business owns; hosted migration applied; deployed; scheduler jobs run live; real model evaluated for drafting; load and latency measured; monitoring and alerting for the social jobs (no collector exists for stuck jobs or accounts needing reconnection) and no CI. The number is a count of gates, not a measurement.

## 5. Blockers and approvals

`blockers.md` lists them. The ones that decide whether Phase 4 reaches customers: the Meta app and App Review; founder approval to apply 0089 (and later 0090); `META_SOCIAL_WRITES_ENABLED` and the scheduler stage that includes the four jobs; confirmation of the 2,048 MB managed-storage default.

## 6. Risks to know about

* The Meta adapter has only run against a replaced HTTP layer. Field names, permission names, status values and the ambiguity rules of the lost-answer reconcile are unproven against the real API; a post that cannot be settled goes to a person and support will see these.
* A post held more than six hours (workspace paused, account blocked, scheduler off) is failed as "missed window" when released and a person must reschedule it. That is the intended rule, and it will surprise people after a long pause.
* Uploads are posted through the application, so a platform request-body limit (about 4.5 MB on some Vercel plans) will refuse large videos until uploads go straight to storage. Not done; listed for the hardening wave.
* Every `useCrmAction` caller (84 files) now refreshes on a conflict result. Three forms were audited by hand; the rest rely on the suites passing.
* The claim filter is an English pattern list; number grounding is whole-number but context-blind.

## 7. Next

Phases 5 to 7 are planned in `phase-5-7-plan.md` from eight audits: shared money library and shared document buckets first, then three parallel builds (proposals with the e-signature seam, customer invoices and payments, reputation) plus AI cost control, then staff messages, requests completion, payment gate and demo funnel, then hardening, end-to-end scenarios and the final report.
