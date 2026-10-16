# Native CRM feature-parity matrix

GoHighLevel is used only as a **functional benchmark** for the CRM capabilities iAcquire's offer needs. Nothing here is a
claim of literal 100% GoHighLevel parity, and no GoHighLevel code, design, branding, API shape or snapshot content was copied.

Status values: `Not implemented` · `In progress` · `Implemented locally` · `Integration verified` · `Production verified` · `Blocked`.
"Implemented locally" means built and covered by automated tests against an embedded PostgreSQL database. **Nothing in this
matrix is production verified**: no migration from this work has been applied to the hosted project and nothing was deployed.

Last updated: 2026-10-16 (Phase 1 and the first part of Phase 2: data model, contacts, companies, tags, fields, Smart Lists, pipelines, deals, tasks, imports/exports, permissions, agency workspace). See [native-crm-audit.md](native-crm-audit.md) for the evidence behind the "Before" column.

| # | Capability (GHL benchmark) | Before this work | Native CRM plan | Status | External dependency |
| --- | --- | --- | --- | --- | --- |
| 1 | Per-client CRM provider (Native / GHL / Hybrid) | GHL assumed | Workspace mode + per-capability ownership, enforced in services | Implemented locally | None |
| 2 | Contacts | Messaging working copy, GHL is record of truth | Full contact record on the existing `contacts` table | Implemented locally | None |
| 3 | Companies | None | `crm_companies` + contact relationships | Implemented locally | None |
| 4 | Tags | None | Tags, colors, folders, merge, bulk apply, usage counts | Implemented locally | None |
| 5 | Custom fields | None | Typed definitions and validated typed values | Implemented locally | None |
| 6 | Smart Lists / saved views | None | Dynamic filter AST compiled to parameterized SQL, folders, pins, sharing | Implemented locally | None |
| 7 | Notes, activity timeline | Notes for 4 record types | Notes on contacts/companies/opportunities; timeline from recorded events only | Implemented locally | None |
| 8 | Tasks and reminders | Basic `tasks` | Priority, links, comments, views, reminders | Implemented locally | None |
| 9 | Pipelines and opportunities | GHL read cache | Native pipelines, stages, transactional moves, idempotent stage events | Implemented locally | None |
| 10 | Calendars and appointment types | GHL calendar | Native calendars, types, availability, holidays, buffers | Not implemented | None |
| 11 | Conflict-proof booking | Per-slot unique index on GHL bookings | Exclusion constraint on host busy time | Not implemented | None |
| 12 | Round robin / collective / group | None | Native assignment strategies | Not implemented | None |
| 13 | Public booking pages | None | `/book/...` with reschedule/cancel links, spam limits | Not implemented | None |
| 14 | Google Calendar | Listed in schema only | OAuth, free/busy, event create/update/cancel, incremental sync | Not implemented | Google OAuth client |
| 15 | Microsoft 365 / Outlook | None | Graph OAuth, getSchedule, events, delta sync | Not implemented | Entra app registration |
| 16 | iCloud / CalDAV | None | CalDAV free/busy + event PUT where supported | Not implemented | App-specific password |
| 17 | ICS subscriptions | None | Read-only polling of busy times | Not implemented | Feed URL |
| 18 | Unified inbox | Built, GHL transport only | Same inbox, provider-agnostic transport | Not implemented | Per channel |
| 19 | Email | Resend for platform mail only | Resend transport with webhooks, bounces, complaints | Not implemented | Resend key + domain |
| 20 | SMS | GHL only | Twilio adapter with status callbacks, STOP handling | Not implemented | Twilio account |
| 21 | WhatsApp | GHL only | Meta Cloud API, templates, 24h window, signed webhooks | Not implemented | Meta WABA |
| 22 | Templates | WhatsApp template list | Versioned templates with tokens, preview, approval | Not implemented | None |
| 23 | Workflows | n8n mappings only | Native triggers/actions, versions, durable runs, logs | Not implemented | None (n8n optional) |
| 24 | Follow-up sequences | Built (presets, stop rules) | Reused on native transports | Not implemented | Per channel |
| 25 | Hermes AI CRM tools | None | Token-scoped tools, approval modes, logs | Not implemented | Hermes gateway |
| 26 | Lead assignment / round robin | None | Concurrency-safe assignment rules | Not implemented | None |
| 27 | Forms and lead capture | Website Studio forms → native contact | Native forms, mapping, tags, opportunities, workflow events | Not implemented | None |
| 28 | Campaigns | None | Consent-gated segment sends with estimates and approval | Not implemented | Per channel |
| 29 | Reputation / reviews | None | Review requests, feedback intake, reporting | Not implemented | Google Business Profile API (optional) |
| 30 | Call activity | None | Call records from voice provider events | Not implemented | Vapi/Retell |
| 31 | Reporting | GHL-based analytics | Reports on native data only | Not implemented | None |
| 32 | Snapshots → CRM Blueprints | Manual GHL snapshot | Versioned blueprints with dry-run apply and rollback | Not implemented | None |
| 33 | Import / export | None | CSV import with preview, dry run, rollback; permissioned export | Implemented locally | None |
| 34 | GHL migration | None | Read-only API import with ID mapping and gap report | Not implemented | Test GHL location token |
| 35 | Open API and webhooks | None | Scoped API keys, signed outbound webhooks | Not implemented | None |
| 36 | Team permissions | 6 client roles | Granular CRM permissions, Appointment Setter role | Implemented locally | None |
| 37 | Agency CRM workspace | None | Per-client CRM workspace with audited support access | Implemented locally | None |


## Notes on the rows marked "Implemented locally"

- **1 Provider:** the workspace mode and per-capability owner are enforced in every native write (`assertNativeOwner`), and screens owned by GoHighLevel show a notice instead of editing controls. Switching an existing workspace between providers (preview, backup, cutover, rollback) is Phase 6 and is **not** built yet.
- **2–8:** contacts (identities, dedupe, merge, archive, privacy erase, consent), companies, tags, typed custom fields, Smart Lists, notes, timeline and tasks, each with client screens in `/crm` and service tests.
- **9:** native pipelines and deals with a drag-and-drop and keyboard Kanban board, a table, a deal page, idempotent stage moves and metrics computed only from recorded deals.
- **33:** CSV import (mapping, dry run, chunked import, undo) and permissioned, recorded CSV export. GoHighLevel API migration (row 34) is separate and not built yet.
- **36:** granular per-person overrides for delegable permissions, mirrored in SQL and TypeScript, plus the Appointment Setter role.
- **37:** agency portfolio of counts only, and a client's CRM opened through a reasoned, time-limited, audited support session that the client can see.

Verified in a browser locally (Playwright screenshots at desktop and phone widths, light and dark) against seeded fictional demo data; not verified against the hosted Supabase project.
