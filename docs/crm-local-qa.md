# Native CRM local browser QA

This harness exercises the Native CRM with fictional accounts and records in an isolated local application. It does not use hosted Supabase, a real provider, or customer data.

## Run it

1. With the server stopped, seed the local database when needed: `npm run crm:qa:seed`.
2. Start the isolated app: `npm run crm:qa:server`. It uses Next development mode for the local synthetic sign-in and defaults to `http://127.0.0.1:3230`.
3. Run the browser sweep: `npm run crm:qa`.

If another worktree already uses port 3230, set `CRM_QA_PORT` to an available port before starting the server and set the same value before running the browser sweep. For example, use `$env:CRM_QA_PORT='3231'` in PowerShell for both commands. The browser remains restricted to that exact loopback port.

The local synthetic sign-in is intentionally refused by the app's production auth guard, so this harness uses development mode. The isolated QA server has a separate `.next-crm-qa` output directory and an 8 GiB Node heap cap. Its supervisor takes a per-worktree lock at `.data/crm-qa/server.lock`, refuses a second server using the same data directory, and restarts the Next process if its development worker exits. On Windows, orphan cleanup only targets a listener whose recorded parent PID and command line match this worktree's isolated Next server. Each route is considered ready only when its hydrated main landmark contains a level-one heading, the route-loading fallback is gone, and that state remains stable for 500 ms. Next restarts its development worker when it approaches the heap threshold; if that interrupts a route's JavaScript chunks, the browser runner waits for the local server and retries that route once. The retry's errors remain visible in the report.

Playwright is not a production dependency. If it is installed outside this repository, set `PLAYWRIGHT_MODULE` to its absolute `playwright/index.mjs` path before step 3. The QA runner uses Chromium and `axe-core` from the local dependencies.

The default run covers every listed client, agency, staff and public route for owner, GoHighLevel-owned owner, sales representative, public visitor, agency administrator and agency staff personas. It checks desktop and phone widths in light and dark themes. It also runs the scripted contact, tag, pipeline, inbox, setup, provider-preview, public booking/form, support-session, Blueprint dry-run and tenant-boundary interactions. The provider wizard is previewed only; the test never confirms a cutover or sends a message.

Each visit records its status and final URL, render and landmark checks, page and console errors, failed and external requests, server errors, phone-width overflow, axe violations, and a full-page screenshot. Interaction results include a screenshot. Routes and interaction names can be listed without opening a browser:

If a development navigation is interrupted by a connection reset, or a 200 response arrives with a failed JavaScript chunk, the runner waits for the isolated `/login` endpoint, stops the old document and retries that navigation once. It clears only errors tied to the confirmed server reset; other first-attempt errors and all retry errors remain in the report. Streamed App Router redirects are followed to their final same-origin destination, including when the browser reaches that destination before the checker starts waiting for the URL event. A measurement interrupted by a client navigation is also retried once after the new document settles.

```powershell
node scripts/crm-browser-qa.mjs --list
```

The run accepts repeatable `--only` patterns plus `--viewports`, `--themes`, and `--roles` for focused checks. Use the default invocation for the complete matrix. `--no-axe`, `--no-interactions`, and `--no-tick` are diagnostic options and should not be used for final acceptance.

## Isolation

- The app has its own PGlite database, uploads, credentials and Next output directory under the git-ignored `.data/crm-qa/` and `.next-crm-qa/` paths. Its sign-in users and seed records are fictional.
- The startup check requires every environment variable named by the repository environment files to be pinned by the QA configuration. It refuses unsafe database and upload paths, a non-QA build directory, enabled sends, real provider credentials, and a real GoHighLevel API host. The child process receives the fixed QA values over inherited environment values.
- Email, SMS, WhatsApp and provider sends are disabled. The GoHighLevel API URL points to a closed local port. The browser allows requests only to the QA server's exact loopback port, plus in-page `data:`, `blob:` and `about:` URLs; other localhost ports are blocked too.
- Next telemetry is disabled. The production build may fetch Google Fonts; development mode may also check npm's Next version metadata at startup. These requests carry no application data.
- Reports, screenshots, auth state and database files stay under `.data/crm-qa/`. They are ignored by Git and are not included in the production bundle.

The runner exits nonzero if a request leaves the QA origin, a server returns 5xx, the run is interrupted, an interaction fails, or any route has a render, browser, layout, screenshot or axe failure. The full machine-readable and Markdown reports are `.data/crm-qa/report.json` and `.data/crm-qa/report.md`; screenshots are under `.data/crm-qa/screens/`.

## Acceptance evidence

### Focused redirect recheck (2026-10-19)

The owner calendar shortcut (`/appointments`) reached `/crm/calendar`, the owner CRM settings shortcut (`/crm/settings`) reached `/crm/settings/provider`, and a sales representative opening `/crm/workflows` reached the denied overview at `/overview?denied=1`. The final provider-settings replay passed after the redirect check was changed to poll the current URL, preventing a streamed navigation from being missed between a URL check and event-listener registration. Each focused replay had 0 external requests, 5xx responses, console errors, page errors, failed requests, and axe violations. Screenshots are `owner-appointments-1280-light.png`, `owner-crm-settings-1280-light.png`, and `sales_rep-crm-workflows-1280-light.png` under the ignored `.data/crm-qa/screens/` folder. These focused replays supplement the broader matrix below; they are not a replacement for it.

### Post-merge check (2026-10-19)

The post-merge sweep used the final integrated code and the isolated fictional CRM seed. It visited **114 routes across all six personas at desktop/light**, then **62 focused CRM, agency, booking and form routes at phone/dark**. The full route pass had **14/14 scripted interactions** pass, including contact creation, tag and deal changes, inbox navigation, setup, read-only provider preview, public booking and form submission, a support session, a Blueprint dry run and the tenant boundary check. The browser reported 0 axe violations, 0 external requests and 0 5xx responses; the phone/dark pass had 0 horizontal overflow.

The long development run logged transient chunk resets on `/workforce`, an agency client page and one denied sales-rep campaigns navigation. Focused replays of the affected pages passed with 0 page/console errors or failed requests. The two mobile retry captures also passed. No provider switch was confirmed and no message was sent. Reports are saved as `post-merge-desktop-light.*`, `post-merge-sales-campaign-replay.*`, `post-merge-chunk-replays.*`, `post-merge-mobile-dark.*` and `post-merge-mobile-replay.*` under git-ignored `.data/crm-qa/reports/`.

The 2026-10-18 route matrix completed across two browser sessions: **456 page loads** for six personas at desktop and phone widths in light and dark themes. The scripted journeys passed **13/13 interactions** (8 in the first session and 5 in the continuation). The first reports included interrupted routes and streamed loading fallbacks: 4 incomplete renders and 4 page errors in the owner/sales run, then 23 admin loading states and 20 associated missing-heading axe findings in the remaining personas. The screenshots showed the streamed admin skeleton; the readiness gate above was added and the affected pages were replayed.

The 47 focused replays passed with 0 render failures, axe violations, page or console errors, failed requests, external requests, 5xx responses, horizontal overflow, or screenshot failures: 38 agency CRM mirror pages, 1 Blueprint versions page, 6 owner mobile pages, and 2 sales-rep pages. The campaign page correctly redirected the sales representative to the denied overview. The initial reports recorded 0 external requests and 0 5xx responses. The browser produced 469 PNGs in `.data/crm-qa/screens/`; reports and screenshots stay in the git-ignored `.data/crm-qa/` directory.

The full matrix reports are `.data/crm-qa/reports/initial-owner-sales.md` and `.data/crm-qa/reports/remaining-personas.md`; focused replay reports are saved alongside them. This is local-only evidence and does not verify hosted migrations, provider integrations, deployment, or production identity.
