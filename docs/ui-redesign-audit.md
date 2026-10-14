# Product UI audit and design direction

The new goal is the complete existing application redesign. Backend, database, permission,
provider and publication behavior are preserved. The verified starting point is 310 passing
tests in 23 suites. Source and private local data were backed up before design changes to
`../iAcquire-backups/iacquire-before-redesign-20261014-155318.tar.gz`.

## Direction

Create an electric-blue command workspace with a charcoal navigation rail, restrained indigo
accents, readable neutrals and intentionally designed light/dark surfaces. Give modules their
own composition: role maps for people, editorial galleries for work, phases for provisioning,
queues for decisions and focused split panes for conversations. Compact metrics should help
decisions; unsupported services and empty datasets receive specific next steps instead of
invented charts. Preserve the six existing employee mascots and the real iAcquire logo.

## Audit findings

- Admin navigation is a single undifferentiated long list; desktop has no contextual toolbar.
- Team is a plain list without useful role structure or client coverage.
- Integration cards do not clearly distinguish saved credentials from verified connections.
- Portfolio renders text records even when visual previews would be the right presentation.
- Catalog exposes repeated management buttons and poorly grouped service rows.
- Maintenance has large empty panels rather than a purposeful subscription state.
- Setup master template renders repeated task cards with weak workflow hierarchy.
- Dashboard metrics and empty support panels dominate the composition without operational focus.
- Client workforce cards, settings and data modules repeat similar white-card structures.
- Onboarding currently renders five large sections; the requested question-by-question flow
  needs a UI adaptation while preserving persisted data, autosave and resume behavior.
- Existing tokens already improve text contrast and reduced motion. Retain those protections.

## Actual visual evidence

Visual QA uses an isolated local database with explicitly synthetic accounts and records on
port 3200. All external provider variables are disabled. Before/after JPEGs are stored under
`docs/design-qa`; they never contain real credentials. Local seed data are not business telemetry.
Each major module receives rendered review, a refinement pass, responsive checks and keyboard
interaction checks. Source inventory is tracked separately from visual verification.

## Scope ownership and verification

| Area | Required change | Current state |
| --- | --- | --- |
| Foundation | Shared hero/metrics/surfaces/motion, both shells, navigation, accessible controls | In progress |
| Agency team | Accurate role map, coverage, directory, staff drawers, invitation access preview | In progress |
| Integrations | Semantic provider cards, real health overview, topology, polished wizards | In progress |
| Portfolio | Editorial project gallery, media states, detail galleries, review controls | In progress |
| Service catalog | Category navigation, rich cards, filters, grid/list and contextual actions | In progress |
| Maintenance | Honest zero state, plan narrative, real active/request/defect queues | In progress |
| Setup templates | Collapsible phases, compact tasks, dependencies, edit drawer, accessible order | In progress |
| Admin operations | Dashboard, client directory/details, workforce, support, health, usage, requests, audit | In progress |
| Custom projects | Delivery workspace, milestones, requests and handover presentation | In progress |
| Client everyday work | Dashboard, workforce, chat, onboarding, setup and every existing client module | In progress |
| QA | Every requested breakpoint, themes, accessibility and regression gates | Pending |

No route is considered redesigned merely because it inherits new colors. This document and the
route inventory will be updated with exact completed work and remaining visual weaknesses.
