# Unified Conversations Inbox

One inbox for every customer conversation (SMS, WhatsApp, email), shared by the team and the AI employees, built on the existing
messaging core and native CRM. Nothing here replaces those: the inbox is the working surface over them.

Related: [audit.md](./audit.md) (what existed before and why the design is what it is), [readiness.md](./readiness.md) (what is
proven, what is not, and the release verdict), [rollout-plan.md](./rollout-plan.md) (the staged path to production and the approval each stage needs).

## What was reused, what was added

| Area | Reused as it was | Added |
| --- | --- | --- |
| Conversations and messages | `conversations`, `conversation_messages`, `ingestInbound` (idempotent), delivery events, `human_escalations`, `conversation_ownership_events` | Lifecycle columns, change tracking, `conversation_events` trail |
| Sending | `evaluateSend` / `queueOutbound` / `dispatchMessage`, consent, suppression, quiet hours, the `*_WRITES_ENABLED` kill switches | An ownership **fence** and an **AI pause** checked at queue time and again at dispatch |
| Contacts and CRM | Native contacts, deals, tasks, notes, lead status | One side panel that reads them, and four actions that call the existing CRM services (task, deal, note, lead status) |
| AI employees | Real roles, readiness checks, `llmComplete`, usage limits, redaction | Choosing/pausing/resuming the employee per conversation; summaries and reply suggestions (never sent) |
| Automation | CRM event outbox, workflow engine, Automation Studio plan checks | Five conversation triggers, one conversation step, a scheduled attention scan |

## Data model (`supabase/migrations/0082_unified_inbox.sql`, additive)

* `conversations`: `archived_at/by`, `resolved_at/by`, `outcome`, `ai_paused_at/by/reason`, `revision` (bumped by a row-local BEFORE trigger).
* `conversation_messages`: `status_changed_at` (trigger), `ownership_fence`, `failure_kind` (`rejected` or `unconfirmed`), `retry_of`.
* `conversation_events`: append-only lifecycle trail (assigned, AI assigned/paused/resumed, status, priority, archive, handoff, task/deal links, retry).
  Ids and short enums only, never message text. Actor is a person, an AI employee, the system, an agency member or `workflow`.
* Three notification kinds. `notifications_kind_check` is rebuilt from the **live** constraint plus the new kinds, so another branch's kinds survive.
* Optional trigram index for message search, created inside a guarded `DO` block (skipped when the extension is unavailable).
* Rollback: `supabase/rollbacks/0082_unified_inbox.down.sql`. It refuses to run if lifecycle events or conversation notifications exist, so it can never silently discard history.

## Rules the inbox enforces

* **Ownership fence.** `ownership_version` moves on every takeover, pause, resume and employee change. A reply an AI employee prepared under an earlier
  version is refused (`stale_ownership`) at queue time and again when it is about to leave. This closes the window where a person takes over while a
  reply is still being written.
* **AI pause.** A pause keeps the employee attached and stops its replies (`ai_paused`); queued AI replies and follow-ups are cancelled; drafts waiting for
  approval stay, and a person approving one is allowed to send it. Resume re-runs the same safety checks as handing a conversation back.
* **Only reply-capable employees.** The Sales Assistant and the Appointment Setter can be attached to a conversation. The other four roles have no
  customer-facing capability and the server refuses them (it is not just hidden in the interface).
* **Derived state.** "Waiting on customer", "awaiting reply" and "needs attention" are computed from timestamps and escalations, never stored, so they cannot go stale.
* **Resolve guards.** Resolving is refused while a person is still being asked to take over, and when the customer wrote after the page was loaded
  (`seenInboundAt`). Archiving requires a resolved conversation; a new customer message brings an archived or resolved conversation back.
* **Failed sends.** A refused send can be retried. A send that was never confirmed may already have reached the customer, so retrying needs an explicit
  acknowledgement. A retry goes through the whole rule chain again and is linked to the message it replaces. Only conversation replies can be retried by hand.
* **No bulk send.** Bulk actions (mark read/unread, resolve, reopen, archive, priority, assign; at most 50) call the same single-conversation functions
  a person would, with per-item permission and visibility checks. There is no bulk message action.

## Views, search, sync

Ten views (All, Unread, Assigned to me, Assigned to AI, Unassigned, Needs attention, Open, Waiting, Resolved, Archived) with the definitions the
interface shows (`INBOX_VIEW_HELP` in `src/lib/inbox.ts`; the SQL applies exactly those). Sorts: Priority, Newest, Longest waiting. Keyset pagination
on `(rank, key, id)`. Counts come from one grouped query.

Near-real-time updates are polling, not websockets: `GET /api/inbox/sync?since=…` returns what changed (by `conversations.revision` and
`conversation_messages.status_changed_at`), with a 24 h window, a 300-change cap, a per-user rate limit, and a back-off that stretches when the tab is
hidden. Tabs poke each other through a `BroadcastChannel` so one tab's action refreshes the others immediately. The sync route is tenant-scoped and uses
the same visibility rules as the list.

## AI assistance (suggest only)

`summarizeConversation` and `suggestReply` go through `llmComplete` with the customer's text fenced as data and redacted, the same usage limit as other AI help,
and a per-user rate limit. They **never persist, never send and never auto-insert**: a suggestion appears in a preview card and a person chooses to use it.
Warnings flag drafts that promise prices, times or outcomes.

## Channel health

`getChannelHealth` reports each channel as connected, needs attention, switched off, not connected or not available. "Connected" needs all of: a verified
sender, the channel switched on, the provider's environment write switch on, and no pattern of failures (more than half of at least three sends in the last
24 hours). Nothing calls a provider; it reads what channel setup and the send path already recorded, plus what the inbox actually received in the last 7 days.
In an environment where sending is switched off the bar says so. Web chat and phone are shown as not available rather than faked.

## Automation

* **Triggers:** `conversation.message_received` (existing), `conversation.assigned` (filter: people), `conversation.resolved`, `conversation.urgent`,
  `conversation.handoff_requested`, `conversation.idle` (filter: quiet for 1 h / 4 h / 1 d / 3 d / 7 d, required). All take a channel filter. Event payloads carry ids and enums, never message text.
* **Step: Update conversation** (`conversation_action`): resolve (optional outcome), reopen, set priority, assign to a person, assign to the contact's owner,
  pause the AI. It acts on the conversation that started the run. It **cannot** send a message and cannot turn AI replies on. It is an ordinary CRM step: no
  outside effect, no owner approval of the version, no Automation Studio plan. The publisher needs `inbox.reply` (or `inbox.assign` for assignment), so a workflow can't do more than the person who published it.
* **Anti-loop:** every change carries the run's event depth (`causedBy`), so workflows that react to each other stop at the CRM loop limit. A test hands a conversation back and forth between two workflows and checks it stops.
* **Idle scan and "customer is waiting" notices** run from the scheduler (`inboxAttention`, every 5 minutes). Each is idempotent by dedupe key. Waiting notices
  go to the owner/assignee (else owners and managers) once per customer message, capped per workspace per run, with one hourly summary beyond the cap.
  A customer who has opted out (or whose address bounced) on the conversation's channel is never "waiting": nothing can be sent to them, so neither Needs
  attention nor a notice fires for their STOP message (it stays visible as unread).
  Idle events are only recorded for workspaces that have an active workflow listening for them.
* **Premium boundary:** the inbox, its triggers and this step work for every workspace. Workflows built in Automation Studio (`origin = studio`) still need the plan, as before.

## Permissions

| Permission | Allows |
| --- | --- |
| `inbox.view` / `inbox.view_all` | See assigned / all conversations (Needs attention and counts follow this) |
| `inbox.reply` | Reply, resolve/reopen/archive, priority, pause AI, take over, retry a failed send, AI summaries and reply suggestions |
| `inbox.assign` | Assign, choose the AI employee, bulk assign |
| `inbox.notes` | Internal notes |
| `inbox.resume_ai` | Give a conversation back to the AI / lift a pause |

Every control is enforced on the server; hiding a button is a convenience.

## HTTP routes (all under `/api/inbox`)

`GET sync`, `GET conversations`, `GET conversations/[id]`, `GET conversations/[id]/context`, `POST conversations/[id]/assist` (same-origin check),
`GET escalations`. All require a signed-in member and re-check visibility per conversation.

## Rollout notes

* Do **not** run this migration in production without approval. Rehearse on a copy first (see readiness.md for what was rehearsed).
* Number: this branch uses `0082` because master already has an untracked `0081_ai_work_job_rls_hardening.sql`. If master's numbering changes, renumber together with the rollback file; the migration itself does not depend on its number.
* The trigram index is built inside the migration transaction. On a large `conversation_messages` table do it `CONCURRENTLY` by hand first (and let the guarded block find it present).
* Provider sending stays controlled by the existing `*_WRITES_ENABLED` switches. Nothing in this work enables a provider or sends a real message.
* The scheduler job `inboxAttention` is registered in `src/server/ops/tick.ts`; confirm the production scheduler runs it before relying on waiting notices or idle workflows.

## Not built (deliberately)

* Websocket push (polling is used; see Views, search, sync).
* Voice calls and web chat as inbox channels (shown as not available, not faked).
* An automation action that sends a message or resumes the AI (kept a person's decision).
* Assignment-by-rule for conversations, SLA timers and canned-reply libraries (out of this phase).
