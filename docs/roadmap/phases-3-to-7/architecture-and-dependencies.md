# Architecture and dependencies

Audited on `origin/master` `36bf78c` (2026-10-22). "Existing" means found in this tree by reading it; it does not mean verified against a real provider.

## 1. Implementation matrix

| Area | State | Evidence in the tree | What it means for Phases 3 to 7 |
| --- | --- | --- | --- |
| Website Studio (builder, templates, publishing, domains, forms) | Existing | `src/server/websites/*` (17 files), `src/components/website/*` (71), `src/server/sites/*`, `src/app/site-runtime/*`, `src/lib/website/*`; domains with DNS verification, SSL probe, live check (`websites/domains.ts`); built-in enquiry form (`website_form_submissions`) | Reuse. Published sites are served from their own host with a strict CSP (`lib/site-routing.ts`): same-origin special paths (`/__iaq/form`, `/__iaq/book`) are the pattern for chat. |
| Form attribution capture | Existing, partial | `lib/crm/forms/visit.ts` (UTM, click ids, landing page, referrer, "never inferred"); `crm_form_submissions.attribution`, `website_form_submissions.utm`; `server/crm/reports/leads.ts` counts UTM per submission | Per-submission only. No per-contact first/latest touch, no source history, nothing linking a source to appointments, deals or revenue. Phase 3D builds that. |
| Native CRM (contacts, deals, tasks, forms, workflows, reports) | Existing | `src/server/crm/*`; `contacts.created_via` check list (needs `website_chat`) | Reuse. Duplicates are allowed (no unique email or phone), so a chat visitor never needs to be merged into an existing contact. |
| Unified Inbox (Phase 1) | Existing, deployed, off for every workspace | `conversations.channel` is `sms / whatsapp / email` only; 124 source files mention WhatsApp | Website chat needs a new conversation channel. Chosen: add `web_chat` to the conversation and message rows only, not to the provider-send configuration (see decisions D1). |
| AI reply path | Existing | `server/messaging/responder.ts` (`respondToConversation`, `ReplyGenerator`, escalation protocol, booking from real availability, disclosure, ownership fence); the default generator runs the employee's Hermes profile | Reuse for website chat. Hermes is not provisioned in production, so the widget must have an honest "AI not connected, a person will follow up" state. |
| AI Workforce (six roles) | Existing | `src/lib/agents.ts`, `workforce-capabilities.ts` (all read-only capabilities) | No new employee. Website chat is answered by the conversation's AI employee (default `sales_assistant`). |
| Phase 2 missed-call recovery and lead scoring | Existing, released dormant | migrations 0085/0086 applied to production | Website chat events feed lead scoring through the existing CRM event dispatcher. |
| Automation Studio | Existing | `lib/crm/workflow/spec.ts`, `server/crm/workflows/*` | Add triggers (chat started, lead captured, qualification completed, booking requested, handoff requested, source recorded). |
| Security helpers | Existing | `server/security/rate-limit.ts` (Postgres fixed window), `outbound-http.ts`, `credentials.ts`, `crypto.ts`; `proxy.ts` exempts `/api/public/*` | Reuse. |
| Social media (Facebook, Instagram) | **Missing** | no `social_*` tables; no Meta publishing code; OAuth exists only for calendars (`app/api/crm/calendar-oauth`) | Greenfield (Phase 4). Live publishing needs a Meta app, review and permissions: external blocker. |
| Media storage on Google Drive / OneDrive | **Missing** | no reference anywhere | Phase 4D can only build the tenant-isolated, entitlement-aware local part. |
| Proposals, e-signature | **Missing / unclear** | "proposal" appears in custom-projects and website code; no PandaDoc or other signing integration | Greenfield (Phase 5). Provider-based signing is blocked on a provider account. |
| Client invoices and payments | **Missing** | `invoice` appears in agency billing; PayMongo webhook is for iAcquire's own billing; no PayPal | Greenfield (Phase 5), kept separate from agency billing. |
| Reviews | Existing, partial | `crm_review*` tables (0033), review pages (`/r/*`), review lists | Phase 5F completes (AI reply drafts, escalation, analytics). |
| Requests and support | Existing | `0065_support_requests`, `server/support/*` | Phase 6 is an audit and completion, not a rebuild. |
| Internal staff Messages | **Missing** | no direct-message or channel tables | Greenfield (Phase 6D). |
| Demo and sales funnel | **Not found in this tree** | no demo code; "prospect" appears in admin operations only | Phase 7D must report that it is absent (it may live on another branch). |
| Scheduler | Existing | `server/ops/tick.ts` registry, `SCHEDULER_JOBS_ONLY`, never run in production | Reuse. No second scheduler. |

## 2. Dependency map

```
3 Website chat  ->  Unified Inbox (conversation channel)  ->  AI reply path  ->  Phase 2 scoring (via CRM events)
3 Attribution   ->  CRM contacts, opportunities, appointments  ->  verified revenue (needs 5C/5D for real payments)
4 Social        ->  Attribution (campaign links)  ->  Media storage policy (entitlements)  ->  AI content (existing LLM client)
5 Closing       ->  CRM deals  ->  Attribution revenue  ->  Reviews / retention
6 Operations    ->  Requests (0065)  ->  Phase 5 proposals/billing (change requests)
7 Launch        ->  everything above
```

Phase 3 attribution reports must not claim revenue until Phase 5 supplies verified payments; until then "won deal value" is shown as deal value, labelled as such, never as revenue.

## 3. Phase 3 architecture (chosen)

* **Channel:** `conversations.channel` and `conversation_messages` accept `web_chat`. The provider-send configuration (`messaging_channels`, templates, consent events, suppressions) is untouched. A reply to a web visitor is stored as a message the widget collects; nothing leaves through a provider.
* **Identity:** the tenant comes from the widget's public key plus the browser's Origin allowlist, never from the request body. A visitor is an opaque session; a typed email or phone number is unverified and never merges into an existing contact.
* **Surfaces:** every site, external or Website Studio, loads `/widget/chat.js` from the portal and calls `/api/public/webchat/*` with CORS limited to the widget's allowlist. A published Website Studio site gets the script injected (nonce'd) and its CSP `connect-src` extended by the portal origin only; its restricted database role can only call `app.site_chat_widget(host)` (see decision D3).
* **Attribution:** an append-only `lead_touches` history per contact (form, chat, call, manual, import) with known versus inferred marked, first-touch and latest-touch pointers on the contact, a manual cost table, and reports that show revenue and ROI only when verified inputs exist.
