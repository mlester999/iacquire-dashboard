import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyUser } from "@/server/notifications";
import { recordConversationEvent } from "@/server/messaging/events";
import { pauseAiInTx } from "@/server/messaging/ai-control";
import { OUTCOME_LABELS } from "@/lib/inbox";
import type { ConversationActionConfig } from "@/lib/crm/workflow/spec";

// What the "Update conversation" workflow step does to a conversation. It runs inside the step's own transaction (the runner opens it) and
// follows the same rules a person does: a conversation a person was asked to take over is not resolved from under them, a customer who wrote
// after the workflow started is not ignored, and a teammate can only be given a conversation they could reply to. Every change leaves a
// lifecycle event whose actor is "workflow" (shown as "An automation"), and the event carries the run's loop depth so a chain of workflows
// reacting to each other stops at the same limit as every other CRM automation.
//
// Nothing here can message a customer or switch AI replies on.

export type ConversationActionResult =
  /** `did` is what happened, `would` what a test run says it would do. */
  | { result: "changed"; did: string; would: string; data?: Record<string, unknown> }
  /** Already as asked: nothing to do, not a problem. */
  | { result: "unchanged"; detail: string }
  /** Something about the conversation or the person means it must not be done now. The run carries on. */
  | { result: "blocked"; reason: string; detail: string };

export interface ConversationActionInput {
  orgId: string;
  conversationId: string;
  config: ConversationActionConfig;
  /** When the run started. A customer message after this means the conversation is not the one the workflow looked at. */
  since: Date;
  causedBy: { eventId: number; depth: number } | null;
  /** Reads only: the same checks, nothing written. */
  dryRun: boolean;
}

interface Row {
  status: "open" | "snoozed" | "closed";
  priority: string;
  assigned_user_id: string | null;
  contact_id: string;
  owner_kind: "ai" | "human" | "none";
  ai_paused_at: Date | null;
  last_inbound_at: Date | null;
}

const actor = { kind: "workflow" } as const;
const link = (id: string) => `/inbox?conversation=${id}`;

/** A teammate who may be given conversations: active on the team, with a role that can reply to customers. */
async function assigneeProblem(db: Queryable, orgId: string, userId: string): Promise<string | null> {
  const m = await db.query<{ role: string; name: string | null }>(
    `select m.role, nullif(u.full_name, '') as name from organization_memberships m join users u on u.id = m.user_id
     where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and u.status = 'active'`,
    [orgId, userId],
  );
  if (!m.rows[0]) return "That person is no longer on the team.";
  const can = await db.query("select 1 from role_permissions where role = $1 and permission = 'inbox.reply'", [m.rows[0].role]);
  return can.rows[0] ? null : "That person's role can't reply to customers.";
}

async function nameOf(db: Queryable, userId: string): Promise<string> {
  const { rows } = await db.query<{ name: string | null }>("select coalesce(nullif(full_name, ''), 'a teammate') as name from users where id = $1", [userId]);
  return rows[0]?.name ?? "a teammate";
}

export async function applyConversationAction(db: Queryable, a: ConversationActionInput): Promise<ConversationActionResult> {
  const { rows } = await db.query<Row>(
    `select status, priority, assigned_user_id, contact_id, owner_kind, ai_paused_at, last_inbound_at from conversations where id = $1 and org_id = $2${a.dryRun ? "" : " for update"}`,
    [a.conversationId, a.orgId],
  );
  const conv = rows[0];
  if (!conv) return { result: "blocked", reason: "conversation_missing", detail: "This conversation no longer exists." };
  const c = a.config;
  const record = (kind: Parameters<typeof recordConversationEvent>[1]["kind"], detail: Record<string, unknown>) =>
    recordConversationEvent(db, { orgId: a.orgId, conversationId: a.conversationId, kind, actor, detail, causedBy: a.causedBy });

  switch (c.action) {
    case "resolve": {
      if (conv.status === "closed") return { result: "unchanged", detail: "The conversation was already resolved." };
      if (conv.last_inbound_at && new Date(conv.last_inbound_at).getTime() > a.since.getTime()) {
        return { result: "blocked", reason: "customer_replied", detail: "The customer wrote after this workflow started, so the conversation was left open." };
      }
      const open = await db.query("select 1 from human_escalations where conversation_id = $1 and status in ('awaiting_owner', 'open')", [a.conversationId]);
      if (open.rows[0]) return { result: "blocked", reason: "person_requested", detail: "A person was asked to take over this conversation, so it was left open." };
      const outcome = c.outcome ? ` (${OUTCOME_LABELS[c.outcome]})` : "";
      if (!a.dryRun) {
        await db.query("update conversations set status = 'closed', resolved_by = null, outcome = $3 where id = $1 and org_id = $2", [a.conversationId, a.orgId, c.outcome ?? null]);
        await record("status_changed", { from: conv.status, to: "closed", via: "workflow", ...(c.outcome ? { outcome: c.outcome } : {}) });
      }
      return { result: "changed", did: `Resolved the conversation${outcome}.`, would: `Would resolve the conversation${outcome}.` };
    }
    case "reopen": {
      if (conv.status !== "closed") return { result: "unchanged", detail: "The conversation was already open." };
      if (!a.dryRun) {
        await db.query("update conversations set status = 'open' where id = $1 and org_id = $2", [a.conversationId, a.orgId]);
        await record("status_changed", { from: "closed", to: "open", via: "workflow" });
      }
      return { result: "changed", did: "Reopened the conversation.", would: "Would reopen the conversation." };
    }
    case "set_priority": {
      if (!c.priority) throw new AppError("invalid_input", "Choose the priority.");
      if (conv.priority === c.priority) return { result: "unchanged", detail: `The priority was already ${c.priority}.` };
      if (!a.dryRun) {
        await db.query("update conversations set priority = $3 where id = $1 and org_id = $2", [a.conversationId, a.orgId, c.priority]);
        await record("priority_changed", { from: conv.priority, to: c.priority, via: "workflow" });
      }
      return { result: "changed", did: `Set the priority to ${c.priority}.`, would: `Would set the priority to ${c.priority}.` };
    }
    case "assign_person":
    case "assign_contact_owner": {
      let userId: string | null;
      if (c.action === "assign_person") {
        if (!c.userId) throw new AppError("invalid_input", "Choose who gets it.");
        userId = c.userId;
        // The person was chosen when the workflow was built: if they are gone, that is a mistake in the workflow to show, not data to skip over.
        const problem = await assigneeProblem(db, a.orgId, userId);
        if (problem) throw new AppError("invalid_input", problem);
      } else {
        const owner = await db.query<{ assigned_user_id: string | null }>("select assigned_user_id from contacts where id = $1 and org_id = $2 and deleted_at is null", [conv.contact_id, a.orgId]);
        userId = owner.rows[0]?.assigned_user_id ?? null;
        if (!userId) return { result: "blocked", reason: "no_owner", detail: "The contact has no owner, so the conversation was not assigned." };
        // The owner is data, not a choice made in the workflow, so a role that can't reply skips the step instead of failing the run.
        const problem = await assigneeProblem(db, a.orgId, userId);
        if (problem) return { result: "blocked", reason: "owner_unavailable", detail: `The contact's owner can't be given this conversation. ${problem}` };
      }
      if (conv.assigned_user_id === userId) return { result: "unchanged", detail: "The conversation was already assigned to them." };
      const who = await nameOf(db, userId);
      if (!a.dryRun) {
        await db.query("update conversations set assigned_user_id = $3 where id = $1 and org_id = $2", [a.conversationId, a.orgId, userId]);
        const ev = await record("assigned", { to: userId, from: conv.assigned_user_id, via: "workflow" });
        await notifyUser(db, userId, a.orgId, { kind: "conversation_assigned", title: "An automation assigned you a conversation", body: "Open it to see the customer's message.", link: link(a.conversationId), dedupeKey: `conv_assigned:${a.conversationId}:a${ev.id}` });
      }
      return { result: "changed", did: `Assigned the conversation to ${who}.`, would: `Would assign the conversation to ${who}.`, data: { assignedTo: userId } };
    }
    case "pause_ai": {
      if (a.dryRun) {
        if (conv.owner_kind !== "ai") return { result: "unchanged", detail: conv.owner_kind === "human" ? "A person is handling this conversation, so the AI isn't replying." : "No AI employee is on this conversation." };
        if (conv.ai_paused_at) return { result: "unchanged", detail: "AI replies were already paused." };
        return { result: "changed", did: "Paused AI replies.", would: "Would pause AI replies on the conversation." };
      }
      const r = await pauseAiInTx(db, { orgId: a.orgId, conversationId: a.conversationId, actor, userId: null, reason: "Paused by an automation", causedBy: a.causedBy });
      if (r.changed) return { result: "changed", did: "Paused AI replies.", would: "Would pause AI replies on the conversation." };
      if (r.why === "already_paused") return { result: "unchanged", detail: "AI replies were already paused." };
      return { result: "unchanged", detail: r.why === "human_owner" ? "A person is handling this conversation, so the AI isn't replying." : "No AI employee is on this conversation." };
    }
  }
}
