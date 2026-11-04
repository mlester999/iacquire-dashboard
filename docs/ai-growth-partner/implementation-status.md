# AI Growth Partner implementation and acceptance status

**Updated:** 2026-11-04
**Code state:** local worktree on `codex/ai-growth-partner`; not pushed or deployed.

## Implemented and verified locally

- New client workspaces provision one `growth_partner` runtime and one linked Growth Partner identity. Legacy employee records, history, schedules, and credentials are preserved; no existing tenant is silently migrated.
- The Growth Partner has one permanent conversation and a versioned Business Brain generated from approved setup information. The chat, Business Brain, onboarding, and migration protections have synthetic tenant and isolation coverage.
- Chat actions use existing workspace services. Coverage includes duplicate-safe CRM contact creation, private calendar and appointment-type creation, booking-rule updates, scheduled-job changes reflected on the Work Board, calendar availability, and approval-gated appointment booking.
- Opportunity-stage changes use the shared CRM tool service. A Growth Partner-specific test verifies the stage stays unchanged while approval is pending, then changes with an audit record after approval. The client tool policy exposes CRM writes only in its proposals phase.
- First-party attribution stores website form/chat UTM and referrer data, distinguishes first and latest touch, and reports recorded appointments, deals, and verified invoice revenue. Tests keep unknown or missing attribution and revenue explicit.
- Product language and entry points were updated across onboarding, calendar, leads, chat, Work Board, demo, purchase pages, CRM workflow summaries, and legacy-profile navigation. The purchase experience presents one Growth Partner with six capabilities.
- A final terminology pass removed stale Lead Hunter-only guidance from shared chat safety copy, removed role-specific copy from the AQi research and calendar tips, and labeled retained legacy profiles as pre-cutover records requiring separate runtime checks and owner approval.
- Growth Partner onboarding now uses the unified questionnaire scope and Partner-specific readiness facts. Its control center links to existing workspace controls, filtered by the signed-in member's permissions.

## Local verification

- Focused regression after the latest changes: **18 files passed; 540 tests passed** across onboarding, CRM setup, navigation, Automation Studio, billing, maintenance, support and notifications.
- Lead-research and Growth Partner regression: **5 files passed; 27 tests passed** after the source review update, using synthetic provider/runtime fixtures.
- Latest lead-signal and Growth Partner regression: **4 files passed; 42 tests passed**, covering evidence-linked signal detail, citation validation, server timestamps, confidence labeling, qualification and legacy signal handling.
- TypeScript: `npm run typecheck` passed.
- Production build: `npm run build` passed locally on Next.js 16.4.2 after the latest changes, including TypeScript and generation of all 16 static pages.
- Lint: repository-wide lint passed with no errors and four unused-import warnings in AQI service, Hermes client, and setup connectors. Targeted lint for the latest changes passed cleanly.
- Full regression: `npm test -- --reporter=dot` completed with **864 test files passed, 2 skipped; 13,674 tests passed, 103 skipped** (21m 48s). The skipped cases are included in those totals and were not counted as passes.
- Latest terminology/accessibility follow-up: **4 focused test files passed; 118 tests passed**, plus TypeScript and targeted lint. The full regression above preceded this copy-only follow-up; the production build was repeated afterward.
- Migration rehearsal: `npm run rehearse:migrations -- --sections D` passed after the latest rollback changes. The populated fixture retained all 7,198 original rows through rollback and replay. The 0123 research-role rollback refuses non-legacy request provenance; 0124 refuses customized setup copy; 0126 refuses removal of persisted signal or qualification data. The rehearsal's generic data warning counts non-empty seeded values and does not inspect those guards. It changes only embedded local rehearsal databases.
- The branch-scoped offline test/build workflow now includes `codex/ai-growth-partner`; its CI result is pending the preview-branch push. Base commit `f0ddb190346a7e296acc03eceec668f446204c16` has a successful Vercel status check, which does not cover this worktree.

## Acceptance still requiring provider or environment evidence

- Acquisition research has evidence validation, qualification, duplicate checks, and CRM handoff code. The source review now records published and account-specific rate limits, current public pricing where available, and terms for X, LinkedIn, Reddit, Meta, Indeed, SEEK, public company pages, Google/Bing search, DataForSEO, Yelp, licensed data, ATS feeds, and tenant CRM. The research runtime still has no per-provider adapter or cost meter, and no discovery provider has completed an authorized runtime acceptance. Provider choice, access terms, tenant credentials, source quotas, and spend limits remain prerequisites; paid or unsupported sources stay disabled.
- No real Hermes runtime, external CRM/calendar provider, customer-approved schedule cutover, or source-to-booking conversion was exercised. The local database and provider transports in the test suites are synthetic.
- The migration strategy covers staged inventory, tenant-specific provisioning, schedule reconciliation, rollback, and retirement approval. No staging or production tenant was migrated, no profile was revoked, and no production database or deployment was changed.

See [acquisition-source-research.md](./acquisition-source-research.md) for source decisions and [migration-strategy.md](./migration-strategy.md) for cutover and rollback requirements.
