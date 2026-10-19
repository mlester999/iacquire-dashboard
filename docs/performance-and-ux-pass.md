# Performance and UX pass: measured findings

Status: **local diagnosis and implementation; production verification is pending.** Nothing in this
pass was pushed or deployed. The only production interaction was read-only: HTTP requests to the
public login/health endpoints and `SELECT 1` / `SELECT count(*)` against the production database.

## 1. What was measured, and how

- **Production region and cold start:** `Invoke-WebRequest` against `https://www.iacquire.online`,
  checking `X-Vercel-Id`, `X-Vercel-Cache` and elapsed time. No session cookie or customer data was
  used.
- **Production database latency:** direct `pg` connection from this workstation (Singapore) to the
  Supabase pooler in `ap-northeast-1` (Tokyo), then twelve `select 1` round trips. Read-only.
- **Server transaction and statement counts:** `IAQ_DB_TRACE=1` prints one line per database
  transaction (`[db-trace] <label> driver=... statements=N ms=...`). The statement count includes the
  transaction's identity/settings statements. This is off unless the variable is set.
- **Local browser runs:** isolated QA database (`.data/crm-qa/database`), fictional personas, real
  migrations and RLS. Chromium via the installed Playwright build, 1440x900. Dev-server timings are
  inflated by compilation and are used only for before/after comparison, never as production
  numbers.
- **AQi streaming:** a local OpenAI-compatible mock provider (not a real model) emitted a stream
  with an 80 ms first-token delay. This isolates server, database, stream parsing and UI delivery
  from model speed. It does not claim what DeepSeek's latency will be.

## 2. Baseline: the five biggest verified bottlenecks

### 1. Every production function shipped the 17.2 MB PGlite database engine

The old production build trace for `/login` contained **22.0 MB** of files, of which **17.2 MB** was
`@electric-sql/pglite` (`pglite.wasm` 9.6 MB, `pglite.data` 6.0 MB, plus runtime files). PGlite is a
local-development fallback; hosted production always uses Postgres. It was traced into every
serverless function because it is a `serverExternalPackages` dependency.

Measured cold starts from Singapore:

| Endpoint | First request (cold) | Warm requests |
| --- | ---: | ---: |
| `/login` | 26.8 s | 350-446 ms |
| `/api/health` | 18.7 s | 478-497 ms |

`X-Vercel-Id` showed `sin1::iad1`, i.e. the function executed in **iad1 (US East)** while Supabase is
in Tokyo. The earlier project closeout recorded the same routing.

### 2. The dashboard sent 23 independent statements, one after another

`getDashboard` called `await one(...)` for almost every KPI, then fetched activity, tasks, agents,
integration status and recent audit rows in more separate statements. `[db-trace]` measured
`withUser statements=26` (one identity statement plus 23 application statements and two transaction
commands) and **442-947 ms of PGlite time** for `/overview`. PGlite is local and has no network hop;
on iad1 each statement to Tokyo adds a full round trip.

### 3. The Contacts screen opened six separate member transactions

`ContactsView` loaded the directory, then five supporting lists (saved lists, tags, custom fields,
members, pipelines), then a touch/audit write. Each supporting service opened its own `crmRead`
transaction. The old trace showed six `withUser` transactions and **29 statements**, plus four
`withSystem` transactions for the CRM shell and workspace. Warm `/crm/contacts` took **4.35 s**
end-to-end in the dev server (4.22 s TTFB), and its first compile took 137 s.

### 4. AQi did its preflight one database wait at a time, then opened a second transaction for history

Before this pass, an AQi turn awaited the published config, knowledge retrieval, tutorial match,
provider config and attachment context serially, then wrote the conversation and both messages in
five statements, then opened a second `withUser` transaction for history, then reserved spend.
On iad1 that sequence is roughly 15 application statements and 10 sequential transaction boundaries
before the model is even called.

Warm local stream with the mock provider **after** this pass: first byte 157-242 ms, first delta
340-430 ms (median 369 ms), complete answer 1.02-1.10 s. The mock's own first token is 80 ms, so the
server/database/stream overhead is about 260-350 ms locally.

### 5. Navigation had no pending feedback and no intent prefetch

`<Link>` did viewport prefetching (production only) but the sidebar gave no visible indication
between a click and the new page. The portal's root `loading.tsx` kept the shell alive, but the chat
surface had no loading boundary at all. The first navigation to each heavy route therefore looked
like a frozen screen, particularly on a cold dev compile or a hosted round trip.

Secondary finding: `listConversations` ran the retention cleanup transaction on every AI-employee
chat load, even when no retention policy was configured.

## 3. Changes implemented

### Database transaction setup

`src/server/db/index.ts`

- `withUser` now applies `app.user_id`, the `iaq_app_user` role and the transaction-local
  `statement_timeout` in **one** statement (verified against both PGlite and the production Postgres
  pooler). It removes one round trip from every member transaction.
- `crmRead` passes its 30 s statement timeout into that one statement instead of issuing a separate
  `set_config` query.
- Added opt-in `IAQ_DB_TRACE=1` profiling. Off by default.

### Dashboard

`src/server/queries/dashboard.ts`

- `sourceAvailability` now reads integration status, cached-row counts, workspace mode and
  capability owners in one statement (was three).
- `getDashboard` collects all independent KPI counts, activity, tasks, agents, integration errors and
  recent audit rows in one statement. Permission-gated counts are `NULL` when the person lacks the
  permission; nothing is fetched for a capability they cannot see.
- Result: `/overview` trace went from `withUser statements=26` to `withUser statements=3` (identity
  statement + `sourceAvailability` + the dashboard statement). PGlite transaction time went from
  442-947 ms to roughly 130-280 ms in the same warm runs.

### CRM workspace and contacts

`src/server/crm/workspace.ts`, `src/server/crm/page.ts`, `src/server/crm/actor.ts`,
`src/server/crm/directory.ts`, `src/server/crm/tags.ts`, `src/server/crm/fields.ts`,
`src/server/crm/contacts.ts`, `src/server/crm/pipelines.ts`, `src/server/crm/smart-lists.ts`,
`src/components/crm/views/contacts-view.tsx`

- `loadWorkspace` reads the workspace, capabilities and GHL connection in one statement (was three)
  and is cached with React's request-scoped `cache`, so the CRM layout and the page reuse it.
- `scopeFor` reuses that workspace instead of querying the default currency again.
- The Contacts directory and its five supporting menus now run in **one** member transaction.
- The list loaders accept the existing transaction handle; standalone callers are unchanged.
- `workspaceCounts` collects seven counts in one statement.
- Result: Contacts went from six member transactions / 29 statements plus four shell transactions to
  one member transaction / 12 statements (identity + 11 queries) plus one workspace statement.
  Warm dev-server `/crm/contacts` dropped from **4.35 s** to **2.08 s** (1.68 s TTFB) on the next
  measured run, and the resolved content settles around **0.2-0.5 s** on subsequent local client
  navigations.

### AQi

`src/server/aqi/service.ts`

- Published config is read once, then provider resolution, knowledge retrieval, tutorial matching and
  attachment context run together.
- Conversation ownership, both message inserts and the conversation summary are one CTE statement.
- The history read is in the same transaction as the turn instead of opening a second one.
- Price and budget are read in one statement.
- The guidance-offer analytics insert is fire-and-forget, so a metrics write never delays the model.
- Measured local warm stream with the mock provider: first byte 157-242 ms, first delta 340-430 ms,
  complete answer 1.02-1.10 s. The trace shows the prepared turn at three application statements
  plus identity, instead of five statements plus a separate history transaction.

### AI-employee chat

`src/server/chat/service.ts`

- Retention cleanup is attempted at most once per workspace per ten minutes instead of on every
  conversation-list load. A failure clears the timestamp so the next load retries; retention itself
  is still the same server routine.

### Navigation and loading

`src/components/shell/sidebar.tsx`, `src/app/(chat)/loading.tsx`, `src/app/(portal)/crm/loading.tsx`,
`src/app/(portal)/settings/loading.tsx`

- Sidebar links show a fixed-height pending bar via Next's `useLinkStatus` (no layout shift), and
  prefetch the full route on hover/focus only, not for every visible link.
- The chat surface gets a dedicated skeleton so opening an AI employee shows the real chat layout
  immediately.
- CRM and settings get content-column skeletons that preserve their section navigation instead of
  flashing the generic dashboard skeleton.

### Production bundle

`next.config.ts`

- Hosted builds (not configured for PGlite) exclude `node_modules/@electric-sql/pglite/**` from the
  output file trace. Local PGlite development and local QA builds keep it.

## 4. Before and after

All local numbers are the isolated development server on PGlite, so they are conservative in the
opposite direction from production: the database is local and has no 150 ms network hop.

| Measure | Before | After | Evidence |
| --- | ---: | ---: | --- |
| `/overview` dashboard statements | 26 | 3 | `IAQ_DB_TRACE` |
| `/overview` PGlite transaction time | 442-947 ms | 130-280 ms | `IAQ_DB_TRACE` |
| `/crm/contacts` member transactions | 6 | 1 | `IAQ_DB_TRACE` |
| `/crm/contacts` statements | 29 | 12 | `IAQ_DB_TRACE` |
| Warm `/crm/contacts` end-to-end | 4.35 s | 2.08 s | browser timing |
| Warm sidebar navigation, second pass | 0.4-1.1 s to heading (one sample) | 0.2-1.1 s to heading (7 routes) | browser timing |
| AQi warm first delta (80 ms mock) | not measured on the old tree | 340-430 ms (median 369) | dev stream timestamps |
| AQi first delta, final production build (80 ms mock) | not measured on the old tree | **265-276 ms** (median 276) | production stream timestamps |
| AQi complete answer, final production build | not measured on the old tree | **931-942 ms** | production stream timestamps |
| AQi warm complete answer | not measured on the old tree | 1.02-1.10 s | stream timestamps |
| AQi panel open | 44-46 ms (previous pass) | 59-63 ms warm | browser timing |
| AQi suggestions visible | 44-46 ms (previous pass) | 66-70 ms warm | browser timing |
| Cold `/login` | 26.8 s | **pending deployment** | production HTTP |
| Cold `/api/health` | 18.7 s | **pending deployment** | production HTTP |
| Function trace size (`/login`) | 22.0 MB (17.2 MB PGlite) | **3.4 MB (0 MB PGlite)** | production build trace |
| Function trace size (`/overview`) | not measured separately | **5.1 MB (0 MB PGlite)** | production build trace |
| Function trace size (`/crm/contacts`) | not measured separately | **6.3 MB (0 MB PGlite)** | production build trace |
| Function trace size (`/api/aqi/chat`) | not measured separately | **12.6 MB (0 MB PGlite)** | production build trace |

The direct database measurement was **83-84 ms per round trip** from Singapore to Tokyo, with 523 ms
for the first TLS connection. The production function is in iad1, which makes each of those round
trips more expensive. This explains why the statement-count reductions matter more in production
than the local milliseconds suggest.

### Production-build runtime timings

The actual `next build --turbopack` output was served with `next start` against the local demo
database. The build is production output; `NODE_ENV=test` was used only at runtime to unlock the
local synthetic-auth path (production rejects local auth by design). No hosted data was touched.
The database is still local, so network latency to Tokyo is **not** included.

Desktop 1440x900, owner persona:

| Route | Cold document (fresh context) | Warm reload | Usable |
| --- | ---: | ---: | --- |
| `/overview` | 696 ms | 446 ms | yes |
| `/crm/contacts` | 715 ms | 571 ms | yes |
| `/crm/pipelines` | 638 ms | 428 ms | yes |
| `/inbox` | 461 ms | 291 ms | yes |
| `/settings` | 465 ms | 222 ms | yes |
| `/workforce` | 321 ms | 278 ms | yes |
| `/website` | 865 ms | 276 ms | yes |

Cold median **638 ms**, p95 **865 ms**; warm median **291 ms**, p95 **571 ms**.

Warm client-side sidebar navigation (two passes, nine routes per pass):

| Pass | URL change median / p95 | Heading visible median / p95 |
| --- | ---: | ---: |
| First | 34 / 142 ms | 347 / 388 ms |
| Second | 32 / 38 ms | 342 / 358 ms |

All 18 transitions reached a usable heading in under **0.4 s**; the slowest was 388 ms. This is
the production build, not the dev server.

Other checks on the same production build:

- AQi panel visible in **148 ms** (first open) / **325 ms** (second open); suggestions at
  157 / 328 ms.
- **AQi streaming on the final production build** (80 ms mock first token): first response byte
  **79-88 ms**, first text delta **265-276 ms**, complete answer **931-942 ms** on warm requests
  (cold route: 431 / 638 / 1,298 ms). Three requests, no page errors. Panel reopen on the same
  build: **73 ms** first / **323 ms** second.
- Agency admin routes: `/admin` 453 ms, `/admin/clients` 468 ms, `/admin/aqi` 457 ms;
  `/admin/workforce` 435 ms, `/admin/health` 371 ms; all usable, no page errors.
- Client staff routes: `/overview` 364 ms, `/crm/contacts` 386 ms, `/crm/pipelines` 471 ms,
  `/inbox` 307 ms; all usable, no page errors.
- Phone 390x844: all seven checked routes usable with `scrollWidth === innerWidth` (no horizontal
  overflow).
- All `ERR_ABORTED` request entries were Next prefetch requests cancelled by the next navigation;
  there were **no page errors and no non-abort failures**.
- Initial JavaScript was 383-455 KB transferred per measured route in this local build.

## 5. Walkthrough audit

The walkthrough is no longer the six-step tour described in the brief. After migration `0064` the
repository contains **22 published starter tours / 74 steps**:

- General: `getting-started` (6), `navigate-dashboard` (3), `setup-workspace` (2), `ask-aqi` (1).
- CRM: `create-contact` (4), `manage-leads` (3), `use-pipelines` (3), `manage-tasks` (4).
- Automation: `build-workflow` (3).
- Calendar: `manage-appointments-native` (3), `manage-appointments-external` (3).
- AI workforce: `view-ai-employees` (3).
- Website: `manage-website` (2).
- Analytics: `read-analytics` (2).
- Account: `find-integrations` (4), `contact-support` (3), `invite-team-member` (5).
- Agency: `agency-tools` (4), `aqi-management` (4), `aqi-knowledge` (3), `aqi-tutorials` (5),
  `aqi-insights` (4).

The six new tours cover every feature area the brief listed that was previously missing: setup and
onboarding, AQi itself, CRM tasks, workflows/automations, Website Studio and analytics. Each has
contextual tips on its real page, so a user can start it without hunting through a library.

Browser QA for the new tours:

- Owner sees all six new tours; a read-only viewer sees `setup-workspace`, `ask-aqi` and
  `read-analytics` but **not** tasks, workflows or Website Studio. The server refuses the hidden
  slugs by name too.
- All **14 target ids** across the six tours were present and visible on their declared routes.
- `manage-tasks` completed through the real UI: 4 steps, ending on “Walkthrough finished” with
  Replay and Done.
- `manage-website` completed through the real UI in 2 steps.
- Mobile 390×844: the analytics tour card was placed at x=12, width=366, inside the 390 px viewport,
  with zero horizontal overflow.
- No page errors during the tour run.

The 0064 migration only inserts tours and tips. It changes no table, policy or existing progress.
The rollback refuses to delete a tour that a person has started, and only removes the six new rows.
**Migration 0064 is not applied to production; applying it requires approval.**

The previous pass added the card/spotlight/placement fixes and the browser QA described in
[aqi-ux-polish.md](aqi-ux-polish.md).

## 6. Verification and limits

- `npm run typecheck`: pass.
- `eslint src tests scripts --max-warnings=0`: pass.
- Full unit suite: **3,046 / 3,046 tests passed across 185 files** (`vitest run --maxWorkers=2`,
  664.17 s on the merged release tree), exit 0.
- Browser: real login, dashboard, contacts, sidebar transitions and a real streamed AQi answer
  against the local mock provider; the six new tours were started through the real resume/tour UI;
  AQi streaming was re-measured on the final production build.
- New migration test: `tests/aqi-migration-0064.test.ts` verifies all six published definitions,
  their target coverage and the six contextual tips on a fresh migrated database.
- Production build: `next build --turbopack` completed with **TypeScript passing** on the merged
  release tree; trace exclusion still holds (`/login` 3.4 MB, 0 MB PGlite).
- **Not completed in this pass:** the deployed cold start and hosted-AQi TTFT cannot be measured
  until this commit is released. The production build run used placeholder Supabase configuration,
  so it validates compilation and tracing, not hosted runtime.
- Migration `0064_aqi_feature_tours.sql` was added: data only (six tours + six tips), no schema,
  policy or existing-progress changes. It is applied to the local test/dev database and covered by
  `tests/aqi-migration-0064.test.ts`. **It is not applied to production; applying it requires approval.**
- Hosted production was not deployed. Region routing remains **iad1 functions → Tokyo database**.
  Moving functions to `hnd1` is a plausible next step but is a deployment change and needs approval;
  it was not made here.

## 7. Release boundary

As of 2026-10-19, the verified release tree is the current `master` head, which contains the
performance work (`2a4ebbb`), the build/test evidence (`9799672`, `95816a9`) and the six feature
tours (`ed7a07d`), merged with the remote sign-out confirmation. It is **ahead of `origin/master`
and has not been pushed**.

Ordered release steps, each requiring the stated approval:

1. **Apply migration `0064`** to the approved hosted project after a backup/restore check. It is
   data-only, but production customer data is involved.
2. **Merge/push the release tree** through the normal branch and deployment process.
3. **Verify the deployment:** `/login` and `/api/health` cold and warm TTFB, `/overview` and
   `/crm/contacts` authenticated timings, AQi panel open, one real streamed answer's first token and
   total time, and the function trace size. Compare with the local production-build numbers in
   Section 4.
4. **Decide the function region** only after that measurement. `hnd1` would put the function next to
   the Tokyo database; `sin1` would be nearer to Singapore users. Neither was applied.

Do not deploy the code before deciding how to handle `0064`: the application works without it, but
the six new tours and their tips remain absent until the data migration is applied.
