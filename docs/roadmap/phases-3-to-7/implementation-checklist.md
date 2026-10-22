# Implementation checklist

States: Not Started, In Progress, Implemented, Verified Locally (tests on embedded Postgres), Browser-QA'd (isolated QA app, simulated model), Blocked, Needs Founder Approval, Production Verified. Nothing here is Production Verified; nothing is tested with a real provider.

## Phase 3: AI website acquisition and lead attribution

| Id | Task | State |
| --- | --- | --- |
| 3.0 | Audit Website Studio and related modules; implementation matrix | Verified Locally (read of the tree; see architecture-and-dependencies.md) |
| 3.1 | Migration 0087: web chat widget and session tables; `web_chat` channel; `website_chat` created-via; `web_chat_lead` notification kind; `app.site_chat_widget` | Verified Locally (rehearsal A-E on embedded Postgres) |
| 3.2 | Pure rules: widget configuration, origin allowlist, tokens, visitor input, qualification questions, limits | Verified Locally |
| 3.3 | Server: widget configuration service (versioned saves, key rotation, install evidence) | Verified Locally, Browser-QA'd (settings save reaches the public config) |
| 3.4 | Server: visitor session, message ingest, AI reply, delivery to the visitor | Verified Locally, Browser-QA'd (simulated model) |
| 3.5 | Server: lead capture (contact create without merging, possible-match hint, consent wording), qualification | Verified Locally, Browser-QA'd |
| 3.6 | Handoff to a person, offline and fallback states, business hours | Verified Locally; handoff Browser-QA'd; offline and fallback by test only |
| 3.7 | Public API: CORS, Origin allowlist, rate limits, body cap (`/api/public/webchat/*`) | Verified Locally; Origin, preflight, bad key and oversize body checked with curl against the QA app |
| 3.8 | Embeddable widget script (Shadow DOM, accessible, responsive, no secrets) | Verified Locally (jsdom), Browser-QA'd at 375 and 1280, light and dark, axe 0 violations after fixes |
| 3.9 | Website Studio integration (portal-served widget, site CSP, `app.site_chat_widget`) | Verified Locally; **not exercised in a browser** (the QA run used an external test origin only) |
| 3.10 | Management UI: settings, installation, health checks, knowledge, employee, history, analytics | Browser-QA'd at 375 and 1280, light and dark |
| 3.11 | Inbox and CRM display of `web_chat` conversations (channel filter, thread, customer drawer, possible-match note) | Browser-QA'd |
| 3.12 | Attribution: migration 0088, touch recording (form, chat, call, manual), first and latest touch | Verified Locally (rehearsal A-E) |
| 3.13 | Attribution report: leads, qualified, appointments, deals, deal value, cost, cost per lead, ROI gating; manual costs | Verified Locally, Browser-QA'd at 375 and 1280, light and dark |
| 3.14 | Automation Studio triggers (five) and permissions | Verified Locally (events and trigger matching); **editor UI not browser-checked for the new triggers** |
| 3.15 | Phase 2 lead scoring integration (chat leads are scored) | Verified Locally |
| 3.16 | Tests per acceptance list; tenant-isolation and abuse tests | Verified Locally (see verification-evidence.md) |
| 3.17 | Browser QA (external test origin; mobile and desktop; accessibility) | Done for the external origin; Website Studio site path not done |
| 3.18 | Typecheck, lint, clean build, migration rehearsal | Done (see verification-evidence.md) |

## Phase 4: AI social media manager

| Id | Task | State |
| --- | --- | --- |
| 4.x | Everything (no social code exists in the tree) | Not Started |

## Phase 5: sales closing and customer retention

| Id | Task | State |
| --- | --- | --- |
| 5.x | Everything (proposals, signatures, invoices, payments are not in the tree; reviews partial) | Not Started |

## Phase 6: requests center, internal messages and client operations

| Id | Task | State |
| --- | --- | --- |
| 6.x | Audit of the requests center; internal staff messages (missing); workload; collaboration | Not Started |

## Phase 7: system-wide integration and launch readiness

| Id | Task | State |
| --- | --- | --- |
| 7.x | Integration audit, employee verification, onboarding, demo funnel (absent from this tree), billing, storage, super admin, scenarios, performance, security, UX, launch operations | Not Started |
