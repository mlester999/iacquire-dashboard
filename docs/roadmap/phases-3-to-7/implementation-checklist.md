# Implementation checklist

States: Not Started, In Progress, Implemented, Verified Locally, Blocked, Needs Founder Approval, Production Verified.

## Phase 3: AI website acquisition and lead attribution

| Id | Task | State |
| --- | --- | --- |
| 3.0 | Audit Website Studio and related modules; implementation matrix | Verified Locally (read of the tree; see architecture-and-dependencies.md) |
| 3.1 | Migration 0087: web chat widget, session and rate tables; `web_chat` channel; `website_chat` created-via | Not Started |
| 3.2 | Pure rules: widget configuration, origin allowlist, tokens, visitor input, chat limits | Not Started |
| 3.3 | Server: widget configuration service | Not Started |
| 3.4 | Server: visitor session, message ingest, AI reply, outbound delivery to the visitor | Not Started |
| 3.5 | Server: lead capture (contact create or link without merging), consent notice, qualification | Not Started |
| 3.6 | Handoff to a person, offline and fallback states, business hours | Not Started |
| 3.7 | Public API with CORS, rate limits and abuse controls (`/api/public/webchat/*`) | Not Started |
| 3.8 | Embeddable widget script (accessible, responsive, no secrets) | Not Started |
| 3.9 | Website Studio integration (same-origin chat paths, automatic install) | Not Started |
| 3.10 | Management UI: settings, installation, domains, knowledge, employee, history, analytics | Not Started |
| 3.11 | Inbox and CRM display of `web_chat` conversations | Not Started |
| 3.12 | Attribution: migration, touch recording (form, chat, call, manual), first and latest touch | Not Started |
| 3.13 | Attribution reports: leads, qualified, appointments, conversion, deal value, verified revenue, cost, ROI gating | Not Started |
| 3.14 | Automation Studio triggers and permissions | Not Started |
| 3.15 | Phase 2 lead scoring integration | Not Started |
| 3.16 | Tests per acceptance list; tenant-isolation and abuse tests | Not Started |
| 3.17 | Browser QA (widget on an external test origin and a Website Studio site; mobile and desktop; accessibility) | Not Started |
| 3.18 | Typecheck, lint, clean build, migration rehearsal | Not Started |

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
