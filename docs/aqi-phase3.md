# AQi Phase 3 — intelligent visual guidance

Status: **implemented and locally verified; no hosted migration, staging deployment or production
deployment was made.**

Phase 3 turns AQi from an assistant that explains where to click into an assistant that can show the
real, authorized interface and walk a person through a workflow. It reuses the Phase 2 conversation,
knowledge, provider, permission and design systems; it does not replace them.

## What was built

| Area | Implementation | Evidence |
| --- | --- | --- |
| Approved target registry | `src/lib/aqi/targets.ts`; every highlight target is a stable id with route, permission and agency scope. Selectors are generated only from that id. | `tests/aqi-tutorial-engine.test.ts`; all seeded targets resolve |
| Visual spotlight engine | `tutorial-stage.tsx`, `target-observer.ts`; spotlight, dimming, tooltip placement, scroll-into-view, `MutationObserver`/`ResizeObserver`, no polling, reduced motion, mobile bottom sheet | Real Chromium: spotlight aligned on nav, buttons, an input inside a modal and an admin target |
| Interactive tutorial engine | Start, Next, Previous, optional Skip, Pause, Resume, Exit, Finish, Replay; progress is independent of chat state | `tests/aqi-tutorial-engine.test.ts` (9) |
| Cross-page navigation | A step may require a route; the overlay explains it, offers an approved `router.push`, waits for the destination, and resumes at the same step | Browser: Contacts → New contact → contact detail; server tests cover route matching |
| Persisted progress | `aqi_tutorial_progress` keyed by person, organization and tutorial with attempt/version/step/status/timestamps | Refresh and resume verified in Chromium; server tests cover isolation |
| Version safety | Only one published version per tutorial; editing creates a new draft; publishing marks in-progress older versions unavailable instead of switching silently; rollback validates first | `tests/aqi-tutorial-admin.test.ts` (6) |
| Verified completion | A route-completion tutorial completes only when the real destination matches. The overlay shows “Walkthrough complete” with a verified badge. A submit button is never pressed by AQi. | Browser: contact created, detail route matched, completion badge shown; server tests prove an unverified finish is `exited`, not completed |
| Chat guide actions | Server matches a genuine how-to request to one eligible published tutorial, persists a structured `guide` on the assistant message and exposes `Show me how` | `tests/aqi-guide-chat.test.ts`; greeting and unrelated questions receive no guide |
| First-time onboarding | Server-backed `not_seen`/`deferred`/`dismissed`/`completed`; Start, Maybe later, Don't show again; quiet routes | Browser: card appears, dismissal survives refresh; tests cover every preference |
| Contextual tips | Six configured tips matched by authorized route, role and permission; dismissible, can be switched off, at most one tip and a 12-hour impression dedupe | `tests/aqi-onboarding-tips.test.ts`; browser: Contacts tip launched the walkthrough |
| Tutorial management | Super Admin Tutorials tab: create, edit, validate, preview, publish, duplicate, archive, version history and restore | Browser: library, structural validation and in-browser draft preview |
| Knowledge document ingestion | PDF/DOCX/TXT/Markdown/CSV upload, real signature checks, 10 MB limit, existing extraction pipeline, private storage, draft only, risk flags | `tests/aqi-knowledge-documents.test.ts` (5) |
| Knowledge freshness | Review date, next review, configured interval, owner/editor and real `up_to_date` / `review_due` / `needs_attention` / `archived` state | Tests cover publish, review and stale detection |
| AQi Insights | Super Admin dashboard over real usage, provider, knowledge, tutorial, feedback and guidance events; date, organization and role filters; honest empty states | `tests/aqi-insights.test.ts` (4); browser desktop and axe run |
| Privacy | No conversation text in analytics; no comments displayed; server-side Super Admin checks; Super Admin-only knowledge tables; tenant-scoped progress | Insights test asserts seeded secret text never appears in the payload |
| Security | Server-side role, route, target, tutorial-version and completion checks; no model-supplied selectors or executable commands | `tests/aqi-tutorial-engine.test.ts`, `tests/aqi-tutorial-admin.test.ts`, `tests/aqi-guide-chat.test.ts` |
| Accessibility | Keyboard controls, dialog semantics, focus return, Escape pause, live step announcements, reduced motion, visible focus, no serious/critical axe findings in tested states | Axe run on tutorial step, mobile tutorial, admin preview and Insights |

## Starter library

Sixteen published, validated walkthroughs are seeded by migration 0061:

- Getting started with iAcquireOS
- Navigating your dashboard
- Adding your first contact (verified by the real contact detail route)
- Managing your leads
- Using pipelines and deals
- Managing appointments (native CRM)
- Managing connected appointments (external provider)
- Viewing your AI employees
- Finding your integrations
- Contacting support
- Inviting a team member
- Navigating agency tools
- Navigating AQi Management
- Managing AQi knowledge
- Managing tutorials
- Using AQi Insights

Every step references a target in the registry. Workflows that do not have a real, working UI are not
offered; the library contains fewer, complete walkthroughs rather than fabricated ones.

## Database

Migration `supabase/migrations/0061_aqi_phase3_guidance.sql` adds:

- `aqi_tutorials`, `aqi_tutorial_versions` (one published version per tutorial), `aqi_tutorial_progress`
  and append-only, idempotent `aqi_tutorial_events`;
- `aqi_user_preferences` and `aqi_contextual_tips`;
- knowledge review columns on `aqi_knowledge_entries`;
- `aqi_knowledge_documents` (management only; no browser role receives a grant);
- extra `aqi_usage_events` kinds and `metadata`/`intent`.

RLS uses the existing `app.current_user_id()` / `app.has_permission()` helpers. Progress and
preferences are owner-scoped; tutorial rows are readable only when published; knowledge documents
are readable only through Super-Admin-checked server code.

Rollback: `supabase/rollbacks/0061_aqi_phase3_guidance.down.sql`. It refuses to destroy progress,
tutorial events or uploaded documents; tests prove both the guard and the clean transactional drop.

The next migration in the repository after this one is `0062_agency_manager_blueprint_permissions`.
Phase 3 requires `0047`, `0048` and `0052` to be applied first; the repository migration runner enforces
these prerequisites. Progress and tutorial-event RLS is owner-only (`user_id = app.current_user_id()`),
so it needs no statement-level permission helper and remains independent of `0060`. Hosted Supabase is
recorded through `0058`; `0059`, `0060`, `0061` and `0062` are **not applied**.

## Verification

Local, automated:

```
npm test -- --maxWorkers=2        # 2,964 tests in 173 files passed
npx vitest run tests/aqi-…        # focused Phase 3 suite
npm run typecheck                 # passed
npm run lint                      # passed
npm run build                     # passed, all new routes emitted
```

Browser QA (`scripts/aqi-guidance-browser-qa.mjs`) against the isolated CRM QA server, real Chromium,
fictional data: **33/33 checks passed**, 0 console errors, 0 page errors, 0 failed requests, 0 5xx,
0 serious/critical axe violations in the tested tutorial, mobile, admin preview and Insights states.
It verified spotlight alignment against real elements, tooltip placement that does not cover the
target, a modal target, creation of a contact and verified completion, onboarding dismissal that
survives refresh, pause/reload/resume at the saved step, 390 px layout, Super Admin validation and
preview, and the Insights empty state.

Not verified here:

- a live chat `Show me how` acceptance with a real provider (server tests cover the stored guide
  action; the QA provider is disabled);
- tablet widths other than desktop/390 px;
- a manual screen-reader session;
- hosted `0061` application, staging or production;
- a real production analytics dataset.

## Release requirements

1. Apply `0059`, `0060`, `0061` and `0062` to a staging copy in order, after a verified backup; do not
   apply them to production directly.
2. Confirm RLS, the seeded tutorial library and the absence of browser grants on
   `aqi_knowledge_documents` in staging.
3. Run the browser QA against staging with a real provider and a test tenant.
4. Confirm the `company-documents` private bucket is available for platform knowledge, and test one
   PDF/DOCX upload, extraction, review and publishing.
5. Confirm Insights against real staging events and that an empty period shows an empty state.
6. Only then promote through the normal controlled release process. No push, deploy or hosted
   migration was performed by this work.
