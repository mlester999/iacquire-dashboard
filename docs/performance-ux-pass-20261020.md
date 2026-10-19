# Performance and UX pass, 2026-10-20: navigation round trips, prefetch fan-out and the walkthrough

Status: **implementation and local production-build verification complete; no database migration was
added or applied.** Production measurements were read-only public HTTP requests. Hosted
authenticated QA and hosted AQi provider timing were not available in this session.

This pass continues [performance-and-ux-pass.md](performance-and-ux-pass.md). That document covers
the earlier statement-count and bundle-trace work (PGlite removed from function traces, dashboard
26→3 statements, contacts 6→1 member transaction). This document covers what was still slow on the
tree at `f1a7aea` and what changed.

## 1. What was measured

- **Production, read-only:** `Invoke-WebRequest` to `https://www.iacquire.online` for `/login` and
  `/api/health`, reading status, elapsed time and `X-Vercel-Id`. No session cookie or customer data.
- **Production build, local database:** `next build --turbopack` + `next start` against the isolated
  `.data/perf-prod` PGlite database (fictional demo workspace). `NODE_ENV=test` only unlocks the
  local synthetic auth path; production still rejects local auth. This measures compilation,
  rendering, streaming and the client, **not** network latency to Tokyo.
- **Database round trips:** `IAQ_DB_TRACE=1` prints one line per transaction with its statement
  count. `withSystem` costs BEGIN+query+COMMIT and `withUser` adds the identity `set_config`; a
  single `readSystem` query costs one round trip.
- **Browser:** Playwright Chromium 1243, 1440x900 and 390x844, desktop/mobile, warm and cold
  document loads, client-side sidebar navigation, and the real walkthrough UI.
- **AQi streaming:** the local OpenAI-compatible mock provider with an 80 ms first-token delay. The
  mock isolates server/database/stream delivery from model speed; it does not claim DeepSeek's TTFT.

## 2. Verified bottlenecks on the starting tree

### 1. Every server render paid three session transactions

`getCurrentUser` looked the profile up in a `withSystem` transaction. `getOrgContext` then ran
`listMemberships` (a `withUser` transaction) and, for anyone who is not an owner,
`loadPermissionOverrides` (another `withSystem`). That is 3 transactions / 7-10 sequential round
trips on **every page, route handler and server action** before any page data. At an estimated
150 ms between `iad1` and Tokyo, the shell alone could wait ~1.0-1.5 s.

### 2. Sidebar viewport prefetch fired a server render for every visible link

`<Link>` had no `prefetch` prop, so production prefetched every visible dynamic route. One
dashboard load produced **40 RSC prefetch requests** in 5 s (measured). Each request resolves the
session and renders the layout down to the loading boundary, so the prefetches competed with the
page's real data for the 4-connection pool. The manual hover warm call was dead work: the route had
already been prefetched.

### 3. AI-employee chat re-fetched the conversation list the server had just rendered

`chat-workspace.tsx` called `searchConversationsAction` on mount even when `initialConversations`
was present. That action resolves the viewer (3 transactions), the agent (1) and the list (1-2):
5-6 transactions, ~15-21 round trips, immediately after hydration.

### 4. AQi serialized independent gates and tail writes

Before this pass an AQi turn awaited rate limit (1 transaction), usage limit (1), then published
config (1) one at a time. After the last token it ran finish, context update, analytics and usage
record one at a time before `done`. Both groups are independent except that the provider needs the
config.

### 5. Production cold start was blocked by server-boot maintenance

Measured on 2026-10-20 from Singapore:

| Request | Cold | Warm |
| --- | ---: | ---: |
| `/login` | 986 ms / 27,424 ms on a later cold instance | 450 ms |
| `/api/health` | **17,399 / 18,519 ms** | 510 ms |

`X-Vercel-Id` reported `sin1::iad1`: the edge is Singapore, the function executes in **iad1 (US
East)**, and the database is `aws-0-ap-northeast-1` (Tokyo).

The bundle was not the cause: the `/api/health` function trace is ~2.5 MB after the earlier PGlite
exclusion. The cause was `src/instrumentation-node.ts`, which Next awaits before handling the first
request. On every cold instance it ran `backfillSetupInstances` and
`reconcileAllSetupInstances` across every unfinished client workspace. With no request at all, a
fresh server logged **25 database transactions** before it could serve; at four round trips per
transaction to Tokyo that is ~100 round trips (~15 s at 150 ms), which matches the observed 17-18 s.
Setup reconciliation is already a scheduler job (`setupEvidence`, every 15 minutes in
`src/server/ops/tick.ts`).

## 3. Changes implemented

### Session and tenancy reads

- `src/server/db/index.ts`: added `readSystem`, a select-only read helper that skips BEGIN/COMMIT.
  It refuses nested use inside an open transaction and refuses non-`select`/`with` statements.
- `src/server/auth/supabase.ts`: profile lookups by auth id and email use `readSystem` when the
  caller does not already hold a transaction (same queries, same scoping).
- `src/server/tenancy/context.ts`: added `loadTenancy`, one statement returning the user's active
  memberships and every per-person permission override for those workspaces. `getOrgContext` uses
  it and selects the overrides for the active tenant from that result. Permission rules, role
  handling and RLS-backed data are unchanged; the query is filtered by the verified session user id.

Result: profile and tenancy now cost **2 round trips instead of 7-10** per render.

### Sidebar prefetching

- `src/components/shell/sidebar.tsx`: sidebar and AI-employee links set `prefetch={false}`. Intent
  warming stays on hover/focus/pointerdown through one `router.prefetch` per destination per
  session (a Set guard prevents the duplicate request mouseenter+pointerdown produced).
- Measured: **40 → 22** background RSC requests on a dashboard load (the remaining 22 come from
  page content and topbar links, not the sidebar). A hovered destination warms on intent only.

### Dashboard

- `src/server/queries/dashboard.ts`: the availability columns are a shared SQL fragment; `getDashboard`
  folds them into its single statement and interprets them with `interpretSourceAvailability`.
  `sourceAvailability` keeps its public shape for reports/scheduling. One fewer sequential round
  trip on the landing page.

### AQi

- `src/server/aqi/service.ts`: rate limit, usage gate and published config now start together; the
  rate limit still wins if it rejects. The attachment claim runs in parallel with the final message
  write, and the knowledge-analytics insert runs in parallel with the billable usage record. This
  removes 2 serial transactions before the provider and 2 from the tail before `done`.
- `src/components/aqi/aqi-widget.tsx`: streamed deltas are coalesced into one state update per
  animation frame instead of re-rendering (and re-parsing markdown) per provider chunk; while
  streaming the transcript jumps with `scrollTop` instead of restarting a smooth scroll each token.
  The welcome/health warm-up runs once per mounted shell rather than on every route change; opening
  the panel still refreshes both.

### AI-employee chat

- `src/components/chat/chat-workspace.tsx`: the server-rendered conversation list is used on mount;
  only a changed search term re-queries it.
- `src/app/(chat)/chat/[slug]/page.tsx` + `src/server/workforce/service.ts`: when the agent's
  connection check is older than 10 minutes, `after()` refreshes it after the page response. The
  send path keeps its freshness check, so a genuinely stale or offline agent is still refused; the
  first message no longer pays six provider round trips when the page could warm them.

### Server boot

- `src/instrumentation-node.ts`: orphaned-run reconciliation stays on the boot path (one bounded
  transaction, ~4 round trips) because its guarantee matters. Setup-checklist backfill and evidence
  reconciliation are now started without awaiting them, so Next can serve the first request while
  they run. They are idempotent, and the scheduler already repeats the reconciliation every 15
  minutes. A serverless pause can defer background work; the next instance or tick retries, and no
  user-facing request depends on it.

### Walkthrough

- `src/components/aqi/tutorial/tutorial-stage.tsx`: a missing target always offers **Skip step**
  (previously only optional steps did, which trapped users on conditional targets); and on a phone,
  a `nav.*` step asks the shell to open the real navigation drawer as the step starts, so the link
  can be highlighted instead of timing out.
- `src/components/shell/portal-shell.tsx`: listens for that request and opens the mobile drawer.
- `src/components/settings/settings-forms.tsx`: "Restart tour" reports a failure instead of silently
  doing nothing when the tour is not available to the role.

## 4. Before and after

Production build, isolated local database, desktop 1440x900. Medians over 14 routes, three sidebar
passes over 11 routes (33 transitions).

| Measure | Before | After |
| --- | ---: | ---: |
| Cold document load, p50 / p95 | 415 / 831 ms | **314 / 678 ms** |
| Warm document reload, p50 / p95 | 303 / 607 ms | **286 / 582 ms** |
| Sidebar click → URL change, p50 | 34 ms | 33 ms |
| Sidebar click → heading visible, p50 / p95 | 345 / 365 ms | 346 / 367 ms |
| AQi panel first open | 198 ms | **145 ms** |
| AQi panel reopen | 329 ms | 346 ms (noise) |
| RSC prefetch requests, first sidebar pass | 1,295 | **974** |
| Background RSC requests on one dashboard load | 40 | **22** |
| `/overview` render transactions (`IAQ_DB_TRACE`) | 7 | 6 |
| Session/tenancy round trips per render | 7-10 | **2** |
| Dashboard availability round trips | 1 extra statement | 0 extra (same statement) |
| Transactions awaited before the first request (cold boot) | 25 | **1** (setup jobs run after the response) |

AQi turn against the 80 ms mock, final production build:

| Run | First byte | First visible delta | Done |
| --- | ---: | ---: | ---: |
| 1 | 140 ms | 331 ms | 995 ms |
| 2 | 79 ms | 263 ms | 928 ms |
| 3 | 86 ms | 262 ms | 915 ms |

The local database has no network hop, so these wall-clock numbers cannot show the round-trip
savings. The projected hosted effect, using the repo's 150 ms iad1→Tokyo estimate (the measured
Singapore→Tokyo round trip was 83-84 ms), is:

- per page render: 5 fewer round trips for an owner, 8 for a member with overrides (~0.75-1.2 s);
- `/overview`: one additional round trip saved (~0.15 s);
- AI-employee chat open: the removed duplicate list fetch was 5-6 transactions (~15-21 round trips);
- AQi turn: ~6 fewer round trips before the provider and ~6 fewer after the last token (~0.9 s each).

These are projections from measured transaction counts, not hosted measurements.

## 5. Walkthrough audit

Inventory confirmed from the seed SQL, not from documentation:

- `supabase/migrations/0061_aqi_phase3_guidance.sql` seeds 16 tours / 60 steps.
- `0063_aqi_phase3_hardening.sql` republishes `create-contact` v2.
- `supabase/migrations/0064_aqi_feature_tours.sql` adds 6 tours / 14 steps (setup, AQi usage, CRM
  tasks, workflows, Website Studio, analytics).
- **Repository total: 22 tours / 74 steps. Live total until 0064 is applied: 16 / 60.**

Role gating is server-side in `src/server/aqi/tutorials.ts` (`isEligible`): role list, every route's
permission, every target's permission/agency scope, and CRM capability ownership. Hidden slugs 404.
Progress persists in `aqi_tutorial_progress` per user+workspace+tutorial, with an append-only event
log; replay exists in Settings and on the completion card.

Browser QA on the final build:

- Desktop: tour started from Settings, step 1 of 6, "Open Overview" navigated, Next reached step 3
  in ~530-540 ms per transition; `nav.workforce` was highlighted, Next enabled.
- Phone 390x844: same six-step tour; at step 3 the navigation drawer opened automatically, the
  `nav.workforce` target was visible, the card stayed inside the viewport (`scrollWidth === 390`),
  and no page errors occurred.
- Exit/Done released the page. A separate, pre-existing onboarding nudge can appear after exit; it
  is dismissible and was already part of the product.
- The conditional-target tours (`setup-workspace` before onboarding, `manage-leads` with no leads,
  `navigate-dashboard` with no next actions) are now recoverable through Skip step instead of a
  dead end.

Remaining walkthrough work: there is no user-facing guide **library** (tours are reachable from
contextual tips, the AQi assistant, the onboarding nudge and the Settings replay button); migration
0064 remains approval-gated.

## 6. Verification

- `npx tsc --noEmit`: pass.
- `npx eslint src tests --max-warnings=0`: pass.
- New test file `tests/tenancy-bundle.test.ts` (6 tests): one-read memberships+overrides, no
  cross-user leakage, archived workspace exclusion, and `readSystem` refusing writes/nesting.
- Targeted suites (`aqi`, `aqi-answer-pipeline`, `aqi-conversation-lifecycle`, `chat`,
  `aqi-tutorial-engine`, `shell-query`, `db-transactions`): 60/60 pass.
- Full unit suite: **3,052 / 3,052 tests across 186 files** (`vitest run --maxWorkers=2`, 631.75 s).
- Production build (`next build --turbopack`): pass.
- Browser: no page errors; every `ERR_ABORTED` entry was a prefetch cancelled by the next
  navigation. Mobile pages had no horizontal overflow.
- Security/tenant isolation: no schema, policy, RLS or permission-rule change. `readSystem` is
  select-only and gated by the verified session; the tenancy bundle is filtered by user id and was
  tested for cross-user isolation.

## 7. Release boundary

- Committed locally on `master` (17 files; the final report records the commit SHA). **Not pushed
  and not deployed:** this workstation has no cached git credential for `origin` (Git Credential
  Manager required an interactive prompt, which this session cannot show). Pushing is the remaining
  release step.
- No migration was added or applied. **0064 remains unapplied in production and needs approval.**
- A function-region change (for example moving functions nearer Tokyo) is a deployment change and
  needs approval; it was not made.
- The hosted cold start remains 9-27 s on the deployed build. The boot-path fix is in this commit
  and is validated locally (25 → 1 awaited transaction), but **it has not been deployed or measured
  on Vercel**, so no hosted cold-start improvement is claimed yet.
- Hosted authenticated QA and hosted AQi provider timing were not available; local production-build
  evidence is labelled as such.

## 8. Remaining issues, ranked by impact

1. **Verify the cold-start fix on Vercel.** The boot path now awaits only the orphaned-run
   reconciliation (25 → 1 transaction locally). Once deployed, `/api/health` cold should be measured
   again; if it is still slow, function region `iad1` vs database `ap-northeast-1` and the Supabase
   connection path are the next suspects (a region change needs approval). Setup evidence
   reconciliation is now best-effort background work on serverless; enabling the scheduler in
   production would make it deterministic (approval-gated).
2. **Hosted verification gap.** No production account or provider authorization was available, so
   hosted navigation p50/p95 and hosted AQi TTFT are unmeasured. The local production build proves
   compilation, rendering, streaming and the client; it does not prove Tokyo network latency.
3. **Migration 0064 is still unapplied.** Six feature tours (tasks, workflows, Website Studio,
   analytics, setup, AQi usage) and their contextual tips do not exist in production until it runs.
4. **22 content/topbar prefetches remain per landing.** The sidebar no longer fans out, but page
   cards and topbar links still viewport-prefetch dynamic routes. A shared intent-only link
   component for content cards is the next step.
5. **AQi first message still pre-creates the conversation** with a separate request, resolving auth
   twice. Removing it would make the chat appear in history before "Save", so it needs product
   sign-off on the temporary-chat lifecycle.
6. **AQi retry can insert a second user message** after a lost response; `aqi_messages` has no
   client idempotency key. Fixing it needs a migration (approval).
7. **AI employee first run still verifies the Hermes tool inventory with 4 sequential provider
   calls** before `POST /v1/runs`. Sharing the verification snapshot with the run-start call would
   remove them.
8. **No user-facing walkthrough library.** Tours are reachable from contextual tips, AQi, the
   onboarding nudge and the Settings replay button, but there is no Help → Guides list.
9. **AI-chat skeleton still sits under the chat layout.** Auth is now two round trips instead of
   seven to ten, but the skeleton cannot paint before the layout resolves.


