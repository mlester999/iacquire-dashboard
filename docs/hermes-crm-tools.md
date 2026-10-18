# CRM tools for a client's own AI employees (Hermes)

Status: **implemented locally, not live.** The tool endpoint, tokens, approval path and settings screen are built and covered by
`tests/crm-agent-tools.test.ts` against an embedded PostgreSQL database. Nothing has been deployed, no migration has been applied to the
hosted project, and **no Hermes profile calls these tools today**: live employee runs stay hard-blocked by the complete tool-inventory
gate in `src/server/integrations/hermes/inventory.ts` (see [hermes-tool-inventory.md](hermes-tool-inventory.md)).

## What it is

A client's own AI employees (the six Hermes roles in `src/lib/agents.ts`) can read and change that client's Native CRM through a small set
of server-hosted tools. Every call is authorised by the server, never by what the model or the request says:

1. A short-lived bearer **token** is issued for one AI employee and one run (`issueAgentToolToken`).
2. The employee calls `POST /api/agent-tools/<tool>` with `Authorization: Bearer <token>` and the tool's arguments as JSON.
3. The server looks the token up by its sha256, takes the **organization and the employee from the token row only**, and builds an
   `agent` CRM actor whose permissions are the **role allowlist ∩ the token's scopes**.
4. Rate limit (counted before the tool is even looked up, so refused or unknown calls are bounded too) → strict argument validation →
   the employee's **operating mode and every pause, read from the database now** → the tool.
5. Every call is logged.

Code: `src/server/crm/agent-tools/` (`catalog.ts`, `tokens.ts`, `service.ts`, `handlers.ts`, `http.ts`, `tasks.ts`, `overview.ts`),
`src/app/api/agent-tools/[tool]/route.ts`, `agentActor()` in `src/server/crm/actor.ts`, and the `crm_update` branch of `runExecutor` in
`src/server/approvals/service.ts`. Schema: `crm_agent_tokens` and the `crm_tool` agent-run purpose in
`supabase/migrations/0032_crm_automation.sql`.

## Tokens

| Property | Rule |
| --- | --- |
| Secret | `iaqat_` + 32 random bytes (base64url). Returned once by `issueAgentToolToken`; never stored, logged or shown. |
| Storage | `crm_agent_tokens.token_hash` = sha256 of the secret. The application role has no grant on the table. |
| Binding | One organization, one `agent_instances` row, optionally one `agent_runs` row, a set of scopes. |
| Scopes | Narrowed at issuance to the role's allowlist (`ROLE_SCOPES`); a request left with no allowed scope is refused. Narrowed again on every call. |
| Lifetime | Default 60 minutes, at most 24 hours (also a table check constraint). |
| Ends when | Revoked (`revokeAgentToolTokensForRun`, `revokeAgentToolAccess`), expired, **or as soon as its run is no longer `queued`/`running`** — verification refuses it and marks it revoked, so a run that ends without anyone calling the revoke function still ends its token. `revokeEndedRunTokens` sweeps the rest. |

Whoever starts a run calls `issueAgentToolToken(db, { orgId, agentInstanceId, runId, scopes })` in the transaction that inserts the
`agent_runs` row, and hands the secret to that run only. **Nothing calls it in production yet** (see "Not verified" below).

## Scopes and roles

| Scope | Lets the employee | CRM permissions it carries |
| --- | --- | --- |
| `contacts:read` | Look up contacts | `crm.view`, `contacts.view` |
| `contacts:write` | Update contact details | + `contacts.edit` |
| `tags:write` | Add and remove existing tags | + `contacts.edit` |
| `tasks:write` | Create tasks | `crm.view`, `tasks.manage` |
| `opportunities:read` | See deals | `crm.view`, `sales.view` |
| `opportunities:write` | Create and move deals | + `opportunities.edit` |
| `calendar:read` | Check native availability | `appointments.view` |
| `appointments:request` | Request appointments | + `appointments.book` |
| `conversations:read` | Read conversations it handles | `inbox.view` |
| `messages:draft` | Draft messages and ask for approval to send | + `inbox.reply` |
| `reports:read` | Read CRM summary counts | `crm.view`, `analytics.view` |

| Role | Allowed scopes |
| --- | --- |
| Operations Manager | contacts:read, tasks:write, opportunities:read, calendar:read, reports:read |
| Lead Hunter | contacts:read, tags:write, tasks:write |
| Appointment Setter | contacts:read, contacts:write, tags:write, tasks:write, calendar:read, appointments:request, conversations:read, messages:draft |
| Sales Assistant | contacts:read, contacts:write, tags:write, tasks:write, opportunities:read, opportunities:write, calendar:read, conversations:read, messages:draft |
| CRM Manager | contacts:read, contacts:write, tags:write, tasks:write, opportunities:read, opportunities:write, reports:read |
| Performance Analyst | opportunities:read, reports:read |

No role can delete, merge, export, import, reassign owners, change consent, edit email addresses or phone numbers, reopen a closed deal,
create tags, run campaigns or change permissions through these tools.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `find_contacts` | read | Search by name, email or phone; up to 25 matches with id, name, email, phone, lead status. |
| `get_contact` | read | One contact with owner, tags, open deals (with `opportunities:read`), open tasks, upcoming appointments. |
| `update_contact` | write | Name, lead status/score, language, preferred channel, time zone, city/region/country/postal code, source. |
| `apply_tag` / `remove_tag` | write | Existing tags by name on 1–25 contacts. **More than one contact always needs approval.** |
| `create_task` | write | A task, optionally linked to a contact or deal and assigned to a teammate who can see contacts. |
| `create_opportunity` | write | A deal in an open stage; idempotent per run and call. |
| `move_opportunity_stage` | write | Move an open deal. **Marking it won or lost always needs approval**; reopening is refused. |
| `check_availability` | read | Free times on native calendars only (never asks GoHighLevel). |
| `request_appointment` | proposal | Goes through `requestBooking` (native only), so the hold, the re-check, the employee's mode and the owner's AI-booking rule apply exactly as for the Appointment Setter. No customer message is sent by this tool. |
| `get_conversation_history` | read | Up to 50 recent messages of a conversation **this employee handles** (`conversations.ai_agent_id`); internal notes, drafts and blocked messages excluded; booking links masked. |
| `prepare_message` | proposal | Saves a draft in a conversation this employee handles. Never sends. Refused once a person has taken the conversation over. |
| `request_send_approval` | proposal | Creates a `follow_up_message` approval for the employee's own draft. **Never sends**; after approval the existing executor re-runs the full send rule chain (consent, opt-outs, quiet hours, pauses, credits). |
| `crm_summary_report` | read | Counts only: contacts, new contacts, open/won/lost deals, open/overdue tasks, appointments in the next 7 days, open conversations. |

Argument schemas are strict (`TOOL_INPUTS` in `catalog.ts`): an unknown field, such as an `orgId`, is refused, not ignored. An id from
another workspace is "not found", because every query names the organization from the token.

## Modes, pauses and approvals

The decision is made per call by `automationGate(..., scope: "job")`, read from the database at that moment:

| Situation | Reads | Writes | Proposals |
| --- | --- | --- | --- |
| Employee paused, not included, not ready; workspace suspended; iAcquire pause | refused | refused | refused |
| Approval required | run | become a `crm_update` approval (`pending_approval`, HTTP 202) | run (they only create drafts or requests) |
| Autonomous | run | run now, **except high-impact ones**, which become an approval | run |

High-impact (always approval, whatever the mode): bulk changes (more than one record), closing a deal as won or lost, and anything that
would reach a customer (sending is only ever requested, never done by a tool).

The client's "Pause customer-facing AI messaging" and "Pause all outbound AI actions" switches stop messages (an approved draft is held by
the send rule chain), not CRM lookups or record changes. To stop an employee's CRM tool use, pause the employee (Workforce → employee →
operating mode) or use **Stop tool access** on CRM → Settings → AI Employee Tools, which ends its live tokens.

**Approval requests** (`crm_update`): one per run and call (`idempotency_key = agent-tool:<run or token>:<call>`, where the call is the
`Idempotency-Key` header or a hash of the arguments), 72-hour expiry, medium risk (high for high-impact, which needs the owner), the
employee's reason shown to the approver, a timeline entry on the contact or deal, and a notification to owners and managers. Repeating
the same request after it was decided never runs it again and never pretends it is still waiting: the reply is `done` (approved and
carried out), or `unavailable` with the reason (declined, changes requested, expired, approved but couldn't be carried out). Once a
call became an approval request it is only ever carried out through that request: if the employee is switched to autonomous and repeats
the call, it gets the request's state, never a second, direct change beside it.

A write is planned against current records before anything else, so a person is never asked to approve something that can't be done:
records from another workspace, a closed deal, an unknown tag, an invalid value, or contacts/deals that this workspace manages in
GoHighLevel (`assertNativeOwner`) are refused straight away (404 / 400 / 409) and no approval is created.

**Executing an approved call** (`executeApprovedAgentToolCall`, from `runExecutor`): the approval service claims it exactly once; the
arguments are re-validated and must hash to what was approved; the employee must still exist and its role and the recorded scopes must
still allow the tool; the gate must allow it now with this approval (an approval satisfies "approval required" but never a pause); the
records are checked again; then the same handler runs as the employee. The outcome is recorded on the approval. Other `crm_update`
approvals (not from these tools) keep the old "no executor" result.

## Logging

- `audit_logs`: `crm.agent_tool.<tool>` for every call, with the employee, result (`success` / `denied` / `failure`), outcome, a short
  detail, the run, the token id (never the secret), the call reference, the duration and a hashed caller address. Token issue and revoke
  are audited too (`crm.agent_tool_access_issued`, `crm.agent_tool_access_revoked`), as are workflow task requests
  (`crm.agent_task_requested`).
- `tool_executions`: one row per call when the token belongs to a run (`crm.<tool>`, completed or failed).
- CRM timeline and events: the CRM services record their usual activity and outbox events with actor kind `agent` and the employee.
- Rate limit: `RATE_LIMITS.agentToolCallsByEmployee`, 60 calls per minute per employee (whatever token it holds), counted for every
  authenticated call including refused ones. Requests with a missing, unknown, expired or revoked credential are counted per hashed
  client address (`RATE_LIMITS.agentToolAuthFailureByIp`, 30 per 10 minutes, then 429); valid credentials never count against it.

## How Hermes would call these tools

> **Unverified:** how a per-run token reaches a Hermes run. The Hermes API server contract we verified (`POST /v1/runs` with `input`,
> `instructions`, `session_id`, `conversation_history`, `Idempotency-Key`, `X-Hermes-Session-Key`) has no field for per-run tool
> credentials, and we have not confirmed how Hermes passes credentials to an HTTP or MCP tool. The token must never be placed in
> model-visible instructions. Confirm this against the Hermes source before wiring it; the fallback is a per-profile tool key provisioned
> by the agency (like `API_SERVER_KEY`) combined with binding each call to an active `agent_runs` row.

Assuming a run holds a token, the HTTP contract is:

```http
GET /api/agent-tools/catalog
Authorization: Bearer iaqat_…
```

returns the employee, its effective scopes and the tools it may call, each with a JSON Schema of its arguments:

```json
{ "ok": true, "agent": { "name": "Sales Assistant", "role": "sales_assistant" },
  "scopes": [{ "scope": "contacts:read", "label": "Look up contacts" }],
  "tools": [{ "name": "find_contacts", "description": "…", "kind": "read", "input_schema": { "type": "object", "…": "…" } }] }
```

```http
POST /api/agent-tools/update_contact
Authorization: Bearer iaqat_…
Content-Type: application/json
Idempotency-Key: call_8f2c

{ "contactId": "…", "changes": { "leadStatus": "qualified" }, "reason": "They asked for a quote." }
```

| HTTP | Body | Meaning |
| --- | --- | --- |
| 200 | `{ ok: true, tool, status: "done" \| "draft" \| "unavailable", result }` | Done (or nothing possible, with the reason in `result`). |
| 202 | `{ ok: true, tool, status: "pending_approval", approvalId, detail }` | A person must approve it first. Nothing has changed. |
| 400 | `{ ok: false, code: "invalid_input", error, issues? }` | Arguments missing or invalid. |
| 401 | `{ ok: false, code: "unauthorized", error }` | Token missing, malformed, unknown, expired, revoked, or its run ended. |
| 403 | `{ ok: false, code: "forbidden", error }` | Role or token doesn't allow the tool, or the employee/workspace is paused or inactive. |
| 404 | `{ ok: false, code: "not_found", error }` | No such tool, or the record isn't in this workspace / not this employee's. |
| 409 | `{ ok: false, code: "conflict", error }` | Conflicts such as a conversation a person has taken over. |
| 429 | `{ ok: false, code: "rate_limited", error }` + `Retry-After` | Too many calls from this employee, or too many bad credentials from this address. |

A write repeated with the same `Idempotency-Key` within the token's life is answered from the log (`result.replayed: true`) instead of
being done again. Without the header, identical requests in one run share one approval request and a new deal or draft is not
duplicated, but a task created straight away by an autonomous employee is created again: send an `Idempotency-Key` for retries.

## Workflow AI step

`requestAgentTask(db, { orgId, roleKey, instruction, contactId, runId, stepKey })` (`tasks.ts`) is what the workflow engine's `ai_task`
step calls, inside its transaction (`src/server/crm/workflows/executors.ts`). It returns `{ status: "blocked", detail }` when the role
doesn't exist, the employee isn't included or is paused, the workspace paused its workflows, iAcquire paused automation, the workspace
isn't active, the contact is gone, the employee isn't connected, or **live runs are still switched off because the employee's complete
runtime tool inventory has not been verified (no fresh persisted attestation, or the gateway does not expose
`GET /v1/tools`)**. Every blocked answer is audited
(`crm.agent_task_requested`, result `denied`). Otherwise it records one `agent_runs` row (purpose `crm_tool`, status `queued`) per
workflow run and step and returns `{ status: "queued", detail, agentRunId }`. The instruction itself is not copied anywhere (the audit
keeps a short hash): it lives in the frozen workflow version's step config, and the workflow step's result records the `agentRunId`.

## Verified and not verified

Verified by `tests/crm-agent-tools.test.ts` (embedded PostgreSQL, no external calls): hash-only token storage, scope narrowing, expiry,
revocation and run-end revocation; organization taken from the token (foreign ids not found, an `orgId` argument refused, no approval
created for a foreign record); role ∩ scope enforcement and the catalog; paused / approval-required / autonomous behaviour, the iAcquire
pause and a suspended workspace; high-impact approvals; the approved-call executor running once, refusing tampered arguments, a pause
since the request and vanished records, and high-risk approvals needing the owner; repeated requests after a decision (declined, approved
and done, expired) answered honestly without running again; a call waiting for approval never also done directly after the employee became
autonomous; changes managed in GoHighLevel refused without an approval; the rate limit (per employee, counted before the tool is looked
up) and the bad-credential limit per address; audit and `tool_executions` logging and idempotent replays; conversation scoping, drafts and
send approvals that send nothing; native availability and booking requests through the approval flow; `requestAgentTask` blocked/queued
answers including the workflows pause; the HTTP mapping; the settings screen's data and markup (with active pauses) and the stop action.

Not verified or not built:

- **Token delivery to Hermes** (above). Nothing issues tokens in production: the chat, responder and research run starters were not
  changed, and live runs are blocked anyway.
- **Hermes tool registration.** The `crm.*` tools are not in `REVIEWED_CLIENT_TOOLS`; they should be added only once the inventory gate
  can verify a profile's complete tool list.
- **No dispatcher starts queued `crm_tool` runs.** In the test-only case where `requestAgentTask` queues one, nothing starts it, and
  `reconcileOrphanedRuns` (run at server start) marks it interrupted. Building one needs the token-delivery question answered first.
- `revokeEndedRunTokens` (a sweep that marks tokens of finished runs revoked) is not registered as a scheduler job; it isn't needed for
  safety, because verification already refuses and revokes a token whose run has ended, but the run starters should call
  `revokeAgentToolTokensForRun` when they finish a run once they issue tokens.
- `src/server/workforce/policy.ts` still tells employees that CRM changes need approval; with an autonomous employee the server now allows
  routine changes. The stricter text is safe, but it should be reconciled (and `POLICY_VERSION` bumped) by whoever owns that file.
- The settings screen (CRM → Settings → AI Employee Tools) was rendered to HTML in tests, not checked in a browser. There is no agency
  mirror: agency support sessions don't carry `activity.view`, so the agency CRM navigation doesn't list it.
