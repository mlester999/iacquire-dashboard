# AQi Phase 3 — intelligent visual guidance

Status: **Phase 3 hardening is merged to `master` and deployed in production on 2026-10-19. Migration
`0061` was applied earlier and the hardening migration `0063` was applied on 2026-10-19 after a fresh
backup. The work is automated-test and browser verified locally; staging acceptance has not run.** The
staging procedure is [aqi-phase3-staging-acceptance.md](aqi-phase3-staging-acceptance.md).

Phase 3 turns AQi from an assistant that explains where to click into an assistant that can show the
real, authorized interface and walk a person through a workflow. It reuses the Phase 2 conversation,
knowledge, provider, permission and design systems; it does not replace them.

## What was built

| Area | Implementation | Evidence |
| --- | --- | --- |
| Approved target registry | `src/lib/aqi/targets.ts`; every highlight target is a stable id with route, permission and agency scope. Selectors are generated only from that id. | Seeded targets resolve; no model-supplied selectors |
| Visual spotlight engine | `tutorial-stage.tsx`, `target-observer.ts`; spotlight, dimming, tooltip placement, scroll-into-view, `MutationObserver`/`ResizeObserver`, no polling, reduced motion, mobile bottom sheet | Chromium: alignment on nav, KPI tile, button, modal input and admin target at 1440/1024/768/390 px |
| Interactive tutorial engine | Start, Next, Previous, optional Skip, Pause, Resume, Exit, Finish, Replay; progress independent of chat | `tests/aqi-tutorial-engine.test.ts` |
| Click-to-advance | A step can use the real navigation or button itself; AQi attaches a capture listener and advances immediately without preventing the control's action | Browser: Contacts nav → New contact → real modal |
| Persisted progress | `aqi_tutorial_progress` keyed by person, organization and tutorial with attempt/version/step/status/timestamps | Refresh/resume verified in Chromium; isolation tests |
| Version safety | One published version per tutorial; editing creates a draft; publishing marks older in-progress attempts unavailable; rollback validates | `tests/aqi-tutorial-admin.test.ts` |
| **Completion accuracy** | Three distinct outcomes: `finish` = walkthrough finished; `route` = navigation verified only; `contact_created` = server found the CRM contact created during the attempt. Only the last sets `verified` and says “Contact created — confirmed by the CRM”. Merely opening Contacts or an old contact detail never completes it. | `tests/aqi-tutorial-engine.test.ts` (wrong page, no record, real record, finish); `tests/aqi-tutorial-admin.test.ts` (navigation wording); browser contact run |
| Chat guide actions | Server matches a genuine how-to request to one eligible published tutorial, persists structured `guide`, exposes a consent-based `Show me how` | `tests/aqi-guide-chat.test.ts`; greeting/unrelated turns get no guide |
| First-time onboarding | Server-backed `not_seen`/`deferred`/`dismissed`/`completed`; Start, Maybe later, Don't show again; quiet routes | Browser: card appears, dismissal survives refresh |
| Contextual tips | Six configured tips matched by route, role and permission; dismissible, switchable, 12-hour impression dedupe | Tests and browser Contacts tip |
| Tutorial management | Super Admin create, edit, validate, preview, publish, duplicate, archive, version history and restore; completion rule can require a CRM-confirmed contact | Browser: library, validation, draft preview; admin tests |
| **Knowledge document security** | PDF/DOCX/TXT/Markdown/CSV, signature checks, 10 MB limit, existing extractor, private `platform/aqi/` storage, draft only, risk flags. Platform documents are never inserted into tenant `private_files` or `knowledge_documents`. | `tests/aqi-knowledge-documents.test.ts` incl. client-owner refusal and tenant isolation |
| **Knowledge version history** | Migration 0063 adds `aqi_knowledge_versions`; every edit snapshots the prior real content before it is overwritten; Super Admin can list, compare, restore as a draft, then review/publish. Existing pre-migration history is not fabricated. | `tests/aqi-knowledge-history.test.ts` (3), `tests/aqi-migration-0063.test.ts` |
| Knowledge freshness | Review date, next review, interval, owner/editor, real `up_to_date` / `review_due` / `needs_attention` / `archived` | Publishing no longer increments the content version, so history stays contiguous |
| AQi Insights | Real usage, provider, knowledge, tutorial, feedback and guidance events; 7/30/90-day presets plus validated **custom UTC From/To** with Apply/Reset; organization/role filters; honest empty states | `tests/aqi-insights.test.ts`; browser custom range, invalid range, reset and axe |
| **Tutorial event retention** | `purgeExpiredAqiTutorialEvents` deletes at most 500 events per run (configurable 30–3650 days, max 2,000 per call), never deletes progress, keeps events for active attempts, supports an organization scope and writes an audit row. Registered as a daily job in the existing authenticated tick scheduler; no cron is created by the code. | `tests/aqi-tutorial-retention.test.ts` (2) |
| Privacy | No conversation text in analytics, no comments displayed, server-side Super Admin checks, management-only knowledge tables, tenant-scoped progress | Insights test asserts secret text never appears |
| Error recovery | Friendly walkthrough error, Try again, Exit; version-change restart; missing target fallback; insights retry; knowledge upload errors. No raw internal error text for normal users. | Browser: aborted progress POST shows friendly error and Retry completes the step |
| Accessibility | Keyboard Enter/Back/Pause/Exit, Escape pause, focus restoration to AQi after close, live step announcements, dialog semantics, reduced motion, visible focus, no serious/critical axe findings in tested states | Chromium keyboard/reduced-motion run; axe on tutorial, tablet, mobile, admin preview and Insights |

## Starter library

Sixteen published, validated walkthroughs are seeded by migration 0061. Migration 0063 publishes a
second version of **Adding your first contact** whose completion is `contact_created`; v1 remains
archived and is not mutated. Every step references an approved target. Workflows without a real UI are
not offered.

## Database

Migration `supabase/migrations/0061_aqi_phase3_guidance.sql` adds:

- `aqi_tutorials`, `aqi_tutorial_versions` (one published version per tutorial), `aqi_tutorial_progress`
  and append-only, idempotent `aqi_tutorial_events`;
- `aqi_user_preferences` and `aqi_contextual_tips`;
- knowledge review columns on `aqi_knowledge_entries`;
- `aqi_knowledge_documents` (management only; no browser grant);
- extra `aqi_usage_events` kinds and `metadata`/`intent`.

Migration `supabase/migrations/0063_aqi_phase3_hardening.sql` adds:

- `aqi_knowledge_versions`, unique by entry+version, RLS enabled and **no** `iaq_app_user` grant;
- a new published `create-contact` v2 with `contact_created` completion, archiving seeded v1 and
  marking older in-progress attempts `version_changed`. It only acts when v1 is still the unmodified
  starter.

Progress and preferences are owner-scoped; tutorial rows are readable only when published; knowledge
documents and history are readable only through Super-Admin-checked server code. Existing 0061 RLS is
independent of `0060`.

Rollbacks: `0061` refuses to destroy progress, events or documents; `0063` drops history and restores
v1 only when v2 is still the hardening version. Both are tested transactionally.

**Hosted state (2026-10-19):** hosted Supabase records `0001`–`0063` with **no pending migrations**.
`0061` was applied after a custom-format `pg_dump` backup; `0063` was applied separately on
2026-10-19 after a second backup
(`.data/backups/pre-aqi-hardening-20261019T155059.dump`, 4,264 TOC entries). Read-only verification:
**259 public tables**, 16 published tutorials/versions, 6 tips, RLS on the tutorial and knowledge
history tables, no `iaq_app_user` grant on `aqi_knowledge_documents` or `aqi_knowledge_versions`,
review columns and new usage kinds present, `create-contact` v1 archived and v2 published with
`contact_created` completion.

## Verification

Local, automated (hardening branch):

```
npm test -- --maxWorkers=2        # 3,000 tests in 179 files passed (includes the native-first pass)
npx vitest run tests/aqi-…        # focused Phase 3 and hardening suite
npm run typecheck                 # passed
npm run lint                      # passed
npm run build                     # passed, all routes emitted
```

Browser QA (`scripts/aqi-guidance-browser-qa.mjs`) against the isolated CRM QA server, real Chromium,
fictional data. Because the dev server restarts under a long run, the suite is run in named scenario
groups against a fresh server; each group writes `report-<group>.json`/`.md`:

| Group | Checks | Result |
| --- | --- | --- |
| Desktop: onboarding, tip, click-through, modal, real contact completion | 14 | **14/14 pass**, 0 console/page errors, 0 failed requests, 0 5xx |
| Resume + 390 px mobile | 11 | **11/11 pass**, 0 errors |
| 1024 px and 768 px tutorial + 768 px modal | 20 | **20/20 pass**, 0 errors |
| Keyboard, live region, Escape, focus restoration, reduced motion | 5 | **5/5 pass**, 0 errors |
| Network failure, friendly error, Retry | 3 | **3/3 pass** (the aborted request is the scenario) |
| Super Admin library, validation, preview, Insights custom dates and axe | 12 | **12/12 pass**, 0 errors |
| **Total** | **65** | **65/65 pass** |

The tablet run found and fixed a real layout defect: the `overview.kpis` highlight covered the whole
KPI grid, so a 360 px tooltip at 768/1024 px necessarily covered it. The highlight now anchors the
first real KPI tile; alignment and non-overlap pass at both widths. The keyboard run found and fixed
focus restoration: the stage unmounts on close, so focus is now restored by the persistent guidance
host, with a launcher fallback when the opening control disappeared. The Insights run found and fixed
low-contrast metric labels on the tinted cards (`text-ink-2`).

Not verified here:

- a live chat `Show me how` acceptance with a real provider (server tests prove the stored guide
  action; the QA provider is disabled);
- a manual screen-reader session (axe is not a substitute);
- staging acceptance, and a post-deploy authenticated production smoke test (production is Vercel-SSO
  protected);
- a real production analytics dataset.

## Release requirements

1. Follow [aqi-phase3-staging-acceptance.md](aqi-phase3-staging-acceptance.md) in a separate staging
   project with test users.
2. Apply migrations through `0063`, verify RLS, seed library, history table and the absence of browser
   grants. (Production did this on 2026-10-19; staging still needs its own run.)
3. Run `0063` rollback in a scratch database and verify progress preservation.
4. Test the private `company-documents` bucket and one PDF/DOCX upload → draft → review → publish.
5. Run the browser groups against staging with a real DeepSeek connection and record the model,
   request id and outcome. Run a manual screen-reader session.
6. Confirm Insights against real staging events, including a custom date range and an empty period.
7. Only then request explicit authorization for another production migration or push. Production
   currently runs the hardening merge; staging acceptance is still outstanding.
