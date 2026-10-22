# Unified Inbox: per-workspace rollout

How the new inbox reaches workspaces one at a time, what that does and does not touch, and how to turn it back. Companion to
[rollout-plan.md](./rollout-plan.md) (the staged path and the approvals) and [README.md](./README.md) (how the inbox works).

Nothing here has run on a hosted system. Migration `0082` (which adds the rollout table) is **not applied anywhere** and nothing is pushed or deployed.

## 1. What it is

A workspace has the new inbox only when **both** are true:

1. the global emergency switch `INBOX_DISABLED` is not on (unset or `false`, the default), **and**
2. a Super Admin switched the new inbox on for that workspace (a row in `inbox_rollout` with `enabled = true`).

Off is the default: **no row means off**, so every existing workspace, and every workspace created later, keeps the inbox it has today until someone chooses otherwise.

| Global switch | Workspace row | `/inbox` shows | `/api/inbox/*` | New-only actions | Messaging core |
| --- | --- | --- | --- | --- | --- |
| off (default) | none or `enabled = false` | the **previous inbox** (unchanged) | 403 `not_enabled` | 403 `not_enabled` | normal |
| off (default) | `enabled = true` | the **new inbox** | normal | normal | normal |
| `INBOX_DISABLED=true` | any | the **previous inbox** | 503 `unavailable` | 503 `unavailable` | normal |

The previous inbox is the screen master had at `22c68c2`, kept as `src/components/inbox/legacy-inbox-workspace.tsx` and `src/app/(portal)/inbox/legacy-inbox.tsx`. It is retained on purpose, so
that **no workspace ever loses the only screen where a person can reply, take over, approve a draft or answer an escalation**. It is temporary: delete both files once every workspace is on the new inbox.

The decision is made on the server, after the sign-in and permission check and before a single new-inbox query. Hiding a sidebar item is not part of the mechanism and would not be enough.

## 2. What the rollout gates

Only what the **new inbox alone** uses:

| Surface | Where it is enforced | When the workspace is not on |
| --- | --- | --- |
| The `/inbox` screen | `src/app/(portal)/inbox/page.tsx` | previous screen |
| Six `/api/inbox/*` routes (sync, list, thread, context, assist, escalations) | `assertInboxEnabled()` (global) first, then, after the sign-in and permission check, `assertInboxEnabledFor(orgId)` | 503 / 403 |
| Ten new-only server actions: pause AI, choose the AI employee, transfer, retry a failed send, mark unread, bulk actions, task / deal / note / lead status from a conversation | `src/app/actions/inbox.ts` | refused; nothing is read or written |
| `setConversationStateAction` when it sets an outcome, archives, or records the seen marker (the status and priority changes the previous screen uses are not gated) | same | refused for those inputs only |
| The new inbox's notices: "customer is waiting", "new inquiry nobody is handling", "assigned to you" | `attention.ts` (SQL join on the rollout table), `ingest.ts`, `handoff.ts` | not raised |
| The "went quiet" announcements (`conversation.idle`) | `announceIdleConversations` joins the rollout table | not announced |
| Publishing or turning on a workflow that uses the five conversation triggers or the Update conversation step | `validateDefinition` (`inbox_not_enabled`), checked at publish and again at turn-on | refused with a plain message |
| The Update conversation step of a workflow that was already live | `executors.ts` | the step does nothing and records `blocked: inbox_not_enabled` |

Errors are explicit: `unavailable` (503, global switch, with `Retry-After: 60`) and `not_enabled` (403, workspace not in the rollout). A signed-out visitor still gets 401 first, so a rollout state is never revealed to someone who is not signed in.

## 3. What it never gates: the audit

**The question asked before building:** could the rollout interrupt any existing customer messaging? The answer rests on tracing every use of the three helpers (`inboxEnabled`, `inboxEnabledFor`, `assertInboxEnabledFor`) and on tests, not on the intent.

| Messaging path | Gated by the rollout? | Evidence |
| --- | --- | --- |
| Receiving an inbound message, storing it, de-duplicating a repeat | **No.** The only rollout read in `ingestInbound` is the *new-inquiry notice*, after the message is stored | `ingest.ts`; test "keeps receiving and storing the customer's messages" |
| Queueing and sending (`queueOutbound`, `dispatchMessage`, `dispatchDue`), retries, recovery of stuck sends | **No** | test "still delivers the queued AI reply while the new inbox is off" |
| AI employees: whether they reply, their rules, readiness, usage limits | **No** | same test; `agent_instances` untouched |
| The ownership fence, AI pause, takeover and resume, escalations, drafts and approvals | **No.** Protections that make a reply safer apply to every workspace | tests "leaves a person able to answer the escalation, take over and reply" |
| Consent, opt-outs, suppression, quiet hours | **No** | unchanged code path |
| **Provider write switches** (`GHL`, `RESEND`, `TWILIO`, `META_WHATSAPP`) and each channel's own on/off | **No.** The rollout service does not mention them (a test reads its source), and a channel is byte-for-byte the same after a rollout change. An approved draft is held back with `provider_not_enabled`, with no network call, in a workspace that has the new inbox | tests "never touches the provider write switches", "sends nothing to a provider while its write switch is off" |
| The previous screen's actions: reply, take over, resume, note, approve or discard a draft, claim / decline / resolve an escalation, assign, read, status and priority, memories, consent | **No** (test classifies every exported action; a new one fails until placed on purpose) | `unified-inbox-switch.test.ts` |
| Settings: messaging settings, channels, availability, notification preferences, escalation authorization | **No** | same |
| CRM contacts, deals, tasks, notes; Automation Studio entitlement; legacy workflow APIs | **No.** Only the five conversation triggers and one step are conditional | `unified-inbox-workflow-step.test.ts`, rollout test "workflows follow the rollout" |

### Findings of the audit (what could have interrupted messaging, and what was done)

1. **Replacing `/inbox` for everyone would remove the only reply and takeover screen** from a workspace that is not ready. *Done:* the previous screen is restored as the default and the new one is opt-in. The previous page was compiled and exercised against the current services (`LegacyInbox` renders `LegacyInboxWorkspace` in tests).
2. **The global kill switch, as first built, gated every inbox action**, including the ones the previous screen needs. With a rollout that would have blocked replies in workspaces that never had the new inbox. *Done:* the guard was removed from every shared action; 27 per-action global guards became ten per-workspace guards on actions only the new screen calls. Settings were never gated.
3. **Notices pointing at a screen that cannot be opened** (new-inquiry, waiting, assigned) would have been raised for workspaces without the new inbox. *Done:* raised only for workspaces on it.
4. **A live workflow that updates a conversation** could keep acting after the inbox goes off. *Done:* the step is a recorded no-op (`inbox_not_enabled`) while off, and works again when it is switched on.
5. **Backend behaviour that does reach every workspace at deploy time** (and is *not* rollout-gated, deliberately): the ownership fence and AI-pause check at queue and dispatch time; `status_changed_at` and `revision` triggers; `failure_kind`; lifecycle events. They are additive, row-local and safety-increasing (a reply prepared before a person took over is now refused instead of sent). Compatibility was checked both ways on an embedded database: old code on the 0082 schema (4,491 tests passed, the same 7 as before fail) and the merged tree (see [rollout-plan.md](./rollout-plan.md) section 6). **Not yet checked on a hosted database under real concurrency**; that is what staging is for.

### What the audit did not prove

* Behaviour on a hosted Postgres (locks, pool, RLS under the real role). Staging does not exist.
* A real provider, a real Hermes employee, or the scheduler in production. All are simulated or blocked pending approval.
* Other server instances see a change within **3 seconds** (each instance caches a workspace's state for 3 s; the instance that made the change forgets it at once). An open tab keeps the screen it rendered until its next navigation or refresh.

## 4. Switching a workspace off: what happens to what is in flight

Switching off changes only **which screen** the workspace's people see and which new-inbox-only surfaces are available. It writes one row and one audit entry; it does not touch a message, conversation, approval, escalation, notification or channel (a test compares every one of those tables before and after).

| In flight | What happens | Lost or leaked? |
| --- | --- | --- |
| A queued AI reply | Stays queued and is sent by the ordinary dispatcher when due (with writes on), or held with its reason (writes off) | No |
| A draft awaiting approval | Stays a draft; a person can approve or discard it from the previous screen | No |
| An open escalation | Stays open; it can be claimed, declined and resolved from the previous screen. Existing notices link to `/inbox`, which works for both screens | No |
| An AI pause | Stays paused (it is a property of the conversation). Lifting it needs the new inbox or a take-over / hand-back from the previous screen | No |
| A new inbound message | Received, stored, de-duplicated, answered by the AI under its settings. Only the new-inquiry notice is skipped | No |
| Notifications already delivered | Remain; they link to `/inbox` | No |
| Notifications the new inbox would raise | Not raised while off; raised again from the next scan after it is switched on | Skipped by design, not stored |
| A running workflow run | The conversation step records `inbox_not_enabled` and changes nothing; other steps run | No |
| Recovery of stuck sends | Unchanged | No |
| Data visible to the wrong people | The rollout table is invisible to the application role (RLS on, no grants); routes check the rollout only after the person is signed in and permitted, and answer 404 (not "not enabled") for another workspace's conversation | No |

The audit entry for a switch-off includes a snapshot of what was in flight (open conversations, AI-owned, paused, escalations, queued AI replies, drafts, live channels), read at that moment.

## 5. Super Admin controls

* **Page:** `/admin/inbox-rollout` (Platform group of the admin navigation). Super Admin only; anyone else is redirected. Lists every non-archived workspace, the internal workspace first, then those that are on, with open conversations, channels switched on, who switched it on or off and when, and the note.
* **Actions** (`src/app/(admin)/admin/inbox-rollout/actions.ts`): switch one workspace, switch several (**at most 25 on at a time**, all-or-nothing in one transaction; off has no limit), **switch off for every workspace** (the rollback control), and a read-only impact view shown before switching one off. Each action re-checks `requireAgencyOrThrow("super_admin")` and the service re-checks the role again.
* **Audit:** `inbox.rollout_enabled` / `inbox.rollout_disabled` in `audit_logs` (actor, workspace, `via` = single / bulk / disable_all, note, and the in-flight snapshot when switching off). Repeating a change that is already in effect writes nothing.
* **The page states** the global switch when it is on, because nothing in the list takes effect then.
* **Nothing here switches a provider on.** The page says so, and a test checks it.

## 6. Rollback ladder (fastest and least disruptive first)

1. **One workspace:** switch it off on the page. Effective for the instance that handled the click at once, for others within 3 s. Its people see the previous inbox on their next page load.
2. **Every workspace:** "Switch off for every workspace" on the same page. One transaction, one audit entry each.
3. **Global:** set `INBOX_DISABLED=true` and redeploy the same build. Every workspace is on the previous screen; the rollout list is preserved and takes effect again when the variable is removed. It is a deployment, not an instant toggle.
4. **Application:** redeploy the previous build. The schema stays (old code ignores the new columns).
5. **Database:** `supabase/rollbacks/0082_unified_inbox.down.sql` drops the rollout table (current state only; the history is in `audit_logs`) and everything else 0082 added. It still refuses while lifecycle events or conversation notifications exist, and needs separate approval from a verified backup.

## 7. Data

`inbox_rollout (org_id pk → organizations on delete cascade, enabled default false, note ≤ 200, enabled_at/by, disabled_at/by → users on delete set null, updated_at)`, row-level security on, `revoke all` from public, anon and authenticated, read and written by trusted server code only. It is part of `0082_unified_inbox.sql` (still unapplied). It needs no data migration: no row means off.

## 8. Tests

* `tests/unified-inbox-rollout.test.ts` (33): never-switched-on workspace (routes, page, actions, messaging core, notices), switched-on workspace, global override, independence of workspaces and cross-tenant access, Super Admin only (service, actions, source check), audit rows, caching, bulk limits, listing, in-flight safety (rows compared before and after, queued reply still sent, draft still waiting, escalation still answerable), rollback of every workspace, workflow publish / run-time / idle gates, table privileges.
* `tests/unified-inbox-switch.test.ts` (16): the global switch, including the action classification and the previous screen as fallback.
* `tests/unified-inbox-migration.test.ts`: the new table in the up / down / up rehearsal.
* The fixture `messagingOrg()` switches the rollout on by default (real workspaces start with it off); pass `inboxRollout: false` to test the previous screen.
* A mutation check removes each guard in turn (route, action, default-off, global override, scan, notice, workflow publish, workflow runtime, role checks, audit, bulk cap, cache clear, previous-screen fallback) and confirms the suite fails each time: 15 of 15 were caught.
* Browser QA in the isolated embedded database (`scripts/ui-qa-inbox-seed.qa.ts` now switches the QA workspace on, leaves "Other Tenant" off and adds a Super Admin; simulated data, every send switch off): the Super Admin page, switching a workspace off with the in-flight snapshot, the previous inbox for that workspace
  (the conversation opens, Take over works, the draft waiting for approval and the open escalation are still there, no `/api/inbox` call is made), the new inbox again after switching on, phone width, light and dark, and axe-core (0 violations on the page and with the dialog open). Not exercised in a browser: Viewer and Support roles on the new screens, the global switch, anything hosted.

## 9. Decisions this leaves with you

* **Which workspaces are in each wave and how long each soaks** ([rollout-plan.md](./rollout-plan.md), D6). Nothing is switched on by this work.
* **When to delete the previous screen**, after the last workspace has moved and held for an agreed period.
