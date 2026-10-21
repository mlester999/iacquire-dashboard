# Automation Studio: connector audit (2026-10-21)

The founder's priority order is native CRM, webhooks / HTTP, Slack, Gmail, Google Sheets, and the instruction is to audit what exists before
building each. This is that audit. **Nothing new was built for Slack, Gmail, Google Sheets or a generic HTTP request in this round**; the
reasons are below, with what each needs.

## What exists and works today

| Connector | What is there | Where | Notes |
| --- | --- | --- | --- |
| Native CRM | Every CRM step: contacts, tags, tasks, notes, deals, stages, fields, assignment, messages from approved templates, review requests, notifications, appointments as triggers | `src/lib/crm/workflow/spec.ts`, `src/server/crm/workflows/executors.ts` | Core, not premium. The Studio builder and canvas use exactly these step kinds. |
| Outbound webhook (a step) | The `webhook` step posts a signed event for the workspace's own **registered** subscription (`subscriptionId`, `includeContact`) | `src/server/crm/webhooks.ts`, step `webhook` | Public https only, SSRF-guarded (`assertPublicHttps`, `pinnedHttps`), encrypted signing secret, 8 attempts with backoff, unknown outcomes are not auto-retried, auto-disable after 25 failures, delivery log with redeliver, one event id per attempt. Needs owner approval as an outside effect. |
| Inbound webhook (a trigger) | A private URL per published workflow starts a run; the plan lapse answers 409 before anything is created | `src/server/crm/workflows/inbound.ts` | Rate limited; the address is never set by the AI builder (strict mode refuses it). |
| n8n | A step calls a verified agency-registered n8n mapping | step `n8n`, `src/server/crm/workflows/executors.ts` | Core. Zapier and Make reach the platform through the same webhook and API paths. |
| AI employees | `ai_task` asks one of the six real roles | step `ai_task` | Live runs stay off until each role's tool inventory is verified. |
| Email, SMS, WhatsApp | `send_message` from approved templates, with consent, opt-out and quiet-hours checks | `src/server/messaging` | Not changed. Charged from usage credits as today. |

## What does not exist

| Wanted | Missing | What building it needs | Blocked on |
| --- | --- | --- | --- |
| **Generic HTTP request** step | A step that calls an address the person chooses (method, headers, JSON body, response mapping) | The SSRF guard and the three-phase call pattern exist and can be reused. New: a step kind and its zod schema; per-workspace allowed hosts; secrets by reference in headers (the vault is Supabase's, so on an embedded database it fails closed); response size and time limits; an owner-approval effect type and its wording in the publish dialog and Approvals; metering as `integration_calls`; builder catalog entry; step panel; tests including an SSRF matrix. | Nothing external, but it is a security-sensitive change touching approvals, effects and the executor: it deserves its own reviewed change, not a tail end. **Recommended next connector.** |
| **Slack** | Any per-workspace Slack | The only Slack in the code is `SLACK_SUPPORT_WEBHOOK_URL`, iAcquire's own support channel. A workspace needs its own destination: an incoming-webhook URL (simplest; a credential the person pastes, stored in the vault, never shown again) or an OAuth app (bot token, channel picker). | A decision between incoming webhook and OAuth app; for OAuth, a Slack app registered by the founder. Credential storage on the hosted vault. |
| **Gmail** | Reading or sending as the person's own Gmail | Google OAuth with Gmail scopes. The Google Calendar OAuth plumbing (`src/server/calendars/adapters/oauth.ts`, connections, token refresh) is reusable for the flow. Sending as the person would also have to go through the existing consent, opt-out and approval rules. | A Google Cloud OAuth app with the Gmail scopes. Gmail scopes are "restricted": Google requires an app verification and, for restricted scopes, a security assessment before production use. That is a founder-owned process with a lead time. |
| **Google Sheets** | Appending or reading rows | The same Google OAuth plumbing with a Sheets scope (sensitive, not restricted: verification still required). | The same OAuth app and verification. |

## Order I would build them in

1. **HTTP request step** (no external dependency; also covers Slack's incoming webhook and many other tools once the person can supply a header secret).
2. **Slack incoming webhook** as a thin, named wrapper over (1) so the person sees "Send a Slack message", not a URL.
3. **Google OAuth app** (founder action: create, request scopes, start verification) in parallel, then Sheets, then Gmail.

## Rules every new connector must follow (already enforced for the existing ones)

- An outside effect needs the business owner's approval of the exact published version, and a change makes a new version needing approval again.
- Premium connectors are checked against the plan at publish, switch-on, run and test time, and are paused (never failed) on a lapse.
- Every call is metered (`integration_calls`) and counted against the fair-use limit; refusals are recorded with the reason.
- Secrets are stored by reference in the vault and never returned to the browser, the AI builder or logs; the builder can only name a connection that exists in the workspace.
- Dry runs describe the call and send nothing.
