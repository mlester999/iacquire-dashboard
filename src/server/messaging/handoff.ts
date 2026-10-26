import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { appUrl, sendEmail, type OutgoingEmail } from "@/server/email";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { cancelPendingAiMessages } from "@/server/messaging/send";
import { cancelFollowUps } from "@/server/messaging/followups";
import { recordConversationEvent } from "@/server/messaging/events";
import { inboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { eligibleStaff, getOwnerProfile, type EligibleStaff } from "@/server/staff/service";
import { DEFAULT_URGENCY, ESCALATION_LABELS, type EscalationCategory, type EscalationUrgency } from "@/lib/escalation";
import type { OrgContext } from "@/server/tenancy/context";
import { isRuntimeOnline } from "@/lib/employee-runtime";

export type OwnerKind = "ai" | "human" | "unassigned";

export interface EscalationInput {
  orgId: string;
  conversationId: string;
  category: EscalationCategory;
  urgency?: EscalationUrgency;
  /** The AI's private summary for staff. It must come from the real conversation; it is never shown to the customer. */
  summary: string;
  sourceMessageId?: string | null;
  agentId?: string | null;
  now?: Date;
}

export interface EscalationResult {
  escalationId: string;
  created: boolean;
  status: "awaiting_owner" | "open" | "claimed";
  unclaimedAlert: boolean;
  /** Send these after the surrounding transaction commits. */
  emails: OutgoingEmail[];
}

interface EscalationRow {
  id: string;
  org_id: string;
  conversation_id: string;
  contact_id: string;
  category: EscalationCategory;
  urgency: EscalationUrgency;
  status: "awaiting_owner" | "open" | "claimed" | "resolved" | "cancelled";
  owner_user_id: string | null;
  owner_response: string;
  owner_deadline_at: Date | null;
  claimed_by: string | null;
}

const link = (conversationId: string, escalationId?: string) => `/inbox?conversation=${conversationId}${escalationId ? `&escalation=${escalationId}` : ""}`;

async function addRecipients(
  db: Queryable,
  esc: { id: string; orgId: string; conversationId: string; category: EscalationCategory; urgency: EscalationUrgency },
  people: EligibleStaff[],
  kind: "action_required" | "fyi",
  emails: OutgoingEmail[],
) {
  const label = ESCALATION_LABELS[esc.category];
  for (const person of people) {
    const optional = person.notifySms || person.notifyWhatsapp ? "not_sent" : "not_requested";
    const inserted = await db.query(
      `insert into escalation_recipients (org_id, escalation_id, user_id, kind, email_status, optional_alert_status) values ($1, $2, $3, $4, $5, $6)
       on conflict (escalation_id, user_id, kind) do nothing returning id`,
      [esc.orgId, esc.id, person.userId, kind, person.notifyEmail ? "queued" : "skipped", optional],
    );
    if (!inserted.rows[0]) continue;
    await notifyUser(db, person.userId, esc.orgId, {
      kind: kind === "action_required" ? "escalation_action_required" : "escalation_fyi",
      severity: esc.urgency === "urgent" && kind === "action_required" ? "critical" : kind === "action_required" ? "warning" : "info",
      title: kind === "action_required" ? `${esc.urgency === "urgent" ? "Urgent: " : ""}${label}: a customer needs a person` : `FYI: ${label}`,
      body: kind === "action_required" ? "Open the conversation to take it. The first person to accept it owns it." : "Another teammate has first priority. You will be asked if it is not picked up.",
      link: link(esc.conversationId, esc.id),
      dedupeKey: `esc:${esc.id}:${person.userId}:${kind}`,
    });
    // Email carries the category and a link only: no customer message content leaves the app.
    if (person.notifyEmail) {
      const urgent = kind === "action_required" && esc.urgency === "urgent";
      emails.push({
        to: person.email,
        template: "escalation_alert",
        subject: kind === "action_required" ? `${urgent ? "[Urgent] " : ""}${label}: customer needs a person` : `FYI: ${label}: a teammate has first priority`,
        text: `${kind === "action_required" ? "Open the conversation to take it. The first person to accept it owns it." : "Another teammate has first priority. You will be asked if it is not picked up."}\n\nPriority: ${esc.urgency === "urgent" ? "Urgent" : "Normal"}\nType: ${label}\nOpen it: ${appUrl(link(esc.conversationId, esc.id))}\n\nSign in to see the conversation.`,
        tone: urgent ? "critical" : kind === "action_required" ? "warning" : "info",
        tag: urgent ? "Urgent" : kind === "action_required" ? "Needs a person" : "For your information",
      });
    }
  }
}

/**
 * Hands a conversation to people. The business owner gets first priority for a configurable window (2 minutes if urgent,
 * 5 otherwise by default); Away, Busy, a decline or the timeout makes it available to every eligible teammate. Only staff
 * authorized for this kind of escalation are told about it. One unresolved escalation per conversation: repeats return the existing one.
 */
export async function createEscalation(db: Queryable, input: EscalationInput): Promise<EscalationResult> {
  const now = input.now ?? new Date();
  const { rows: conv } = await db.query<{ contact_id: string; channel: string }>("select contact_id, channel from conversations where id = $1 and org_id = $2", [input.conversationId, input.orgId]);
  if (!conv[0]) throw new AppError("not_found", "Conversation not found.");
  const existing = await db.query<{ id: string; status: "awaiting_owner" | "open" | "claimed" }>("select id, status from human_escalations where conversation_id = $1 and status in ('awaiting_owner', 'open', 'claimed')", [input.conversationId]);
  if (existing.rows[0]) return { escalationId: existing.rows[0].id, created: false, status: existing.rows[0].status, unclaimedAlert: false, emails: [] };

  const urgency = input.urgency ?? DEFAULT_URGENCY[input.category];
  const { rows: s } = await db.query<{ owner_timeout_urgent_seconds: number; owner_timeout_normal_seconds: number }>("select owner_timeout_urgent_seconds, owner_timeout_normal_seconds from messaging_settings where org_id = $1", [input.orgId]);
  const timeout = urgency === "urgent" ? (s[0]?.owner_timeout_urgent_seconds ?? 120) : (s[0]?.owner_timeout_normal_seconds ?? 300);
  const owner = await getOwnerProfile(db, input.orgId);
  const eligible = await eligibleStaff(db, input.orgId, input.category);

  // Decide how the owner's priority applies.
  let status: "awaiting_owner" | "open" = "open";
  let ownerResponse = "not_applicable";
  let deadline: Date | null = null;
  let notifyOwner = false;
  if (owner) {
    if (owner.ownerPriorityMode === "notify_only") {
      status = "awaiting_owner";
      ownerResponse = "pending";
      notifyOwner = true;
    } else if (owner.ownerPriorityMode === "urgent_only" && urgency !== "urgent") {
      ownerResponse = "not_applicable";
    } else if (owner.availability !== "available") {
      // Away and Busy owners are skipped so customers are not left waiting on someone who is not there.
      ownerResponse = owner.availability;
      notifyOwner = true;
    } else {
      status = "awaiting_owner";
      ownerResponse = "pending";
      deadline = new Date(now.getTime() + timeout * 1000);
      notifyOwner = true;
    }
  }

  const { rows } = await db.query<{ id: string }>(
    `insert into human_escalations (org_id, conversation_id, contact_id, category, urgency, summary, status, owner_user_id, owner_response, owner_deadline_at, opened_to_staff_at,
       source_message_id, ai_agent_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [input.orgId, input.conversationId, conv[0].contact_id, input.category, urgency, input.summary.slice(0, 600), status, owner?.userId ?? null, ownerResponse, deadline,
      status === "open" ? now : null, input.sourceMessageId ?? null, input.agentId ?? null],
  );
  const esc = { id: rows[0].id, orgId: input.orgId, conversationId: input.conversationId, category: input.category, urgency };
  const emails: OutgoingEmail[] = [];
  const staff = eligible.filter((p) => p.userId !== owner?.userId);

  if (status === "awaiting_owner") {
    if (owner) await addRecipients(db, esc, [owner], "action_required", emails);
    // Notify-only owners handle everything themselves, so teammates are not asked.
    if (owner?.ownerPriorityMode !== "notify_only") await addRecipients(db, esc, staff, "fyi", emails);
  } else {
    if (owner && notifyOwner) await addRecipients(db, esc, [owner], "action_required", emails);
    await addRecipients(db, esc, staff, "action_required", emails);
  }

  // If nobody who could act is available, say so loudly to the owner and managers.
  const reachable = [...(owner && notifyOwner ? [owner] : []), ...staff].filter((p) => p.availability === "available");
  const unclaimedAlert = reachable.length === 0;
  if (unclaimedAlert) {
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
      kind: "escalation_unclaimed",
      severity: "critical",
      title: "A customer needs a person and nobody is available",
      body: `${ESCALATION_LABELS[input.category]}. It is waiting in the urgent queue. The customer has not been promised an immediate human reply.`,
      link: link(input.conversationId, esc.id),
      dedupeKey: `esc_unclaimed:${esc.id}`,
    });
  }

  const priority = urgency === "urgent" ? "urgent" : "high";
  const raised = await db.query("update conversations set priority = $2 where id = $1 and priority <> 'urgent' and priority <> $2 returning id", [input.conversationId, priority]);
  // The request for a person goes on the conversation's trail (and starts "handoff requested" automations). Only a short category and urgency
  // are recorded: the AI's summary stays on the escalation, which has its own visibility rules.
  await recordConversationEvent(db, { orgId: input.orgId, conversationId: input.conversationId, kind: "handoff_requested", actor: input.agentId ? { kind: "ai", agentId: input.agentId } : { kind: "system" }, detail: { category: input.category, urgency, escalationId: esc.id } });
  if (raised.rowCount) await recordConversationEvent(db, { orgId: input.orgId, conversationId: input.conversationId, kind: "priority_changed", actor: input.agentId ? { kind: "ai", agentId: input.agentId } : { kind: "system" }, detail: { to: priority, reason: "handoff" } });
  await recordAudit({ orgId: input.orgId, actorKind: "agent", agentInstanceId: input.agentId ?? null, action: "escalation.created", targetType: "conversation", targetId: input.conversationId, result: "success", metadata: { category: input.category, urgency, status, ownerResponse } }, db);
  return { escalationId: esc.id, created: true, status, unclaimedAlert, emails };
}

async function openToStaff(db: Queryable, esc: EscalationRow, response: "timed_out" | "declined", emails: OutgoingEmail[], now: Date) {
  const res = await db.query("update human_escalations set status = 'open', owner_response = $2, opened_to_staff_at = $3 where id = $1 and status = 'awaiting_owner'", [esc.id, response, now]);
  if (!res.rowCount) return false;
  const staff = (await eligibleStaff(db, esc.org_id, esc.category)).filter((p) => p.userId !== esc.owner_user_id);
  await addRecipients(db, { id: esc.id, orgId: esc.org_id, conversationId: esc.conversation_id, category: esc.category, urgency: esc.urgency }, staff, "action_required", emails);
  if (!staff.some((p) => p.availability === "available")) {
    await notifyOrgRoles(db, esc.org_id, ["owner", "admin"], {
      kind: "escalation_unclaimed",
      severity: "critical",
      title: "A customer still needs a person and nobody is available",
      body: ESCALATION_LABELS[esc.category],
      link: link(esc.conversation_id, esc.id),
      dedupeKey: `esc_unclaimed_open:${esc.id}`,
    });
  }
  await recordAudit({ orgId: esc.org_id, actorKind: "system", action: "escalation.opened_to_staff", targetType: "escalation", targetId: esc.id, result: "success", metadata: { response } }, db);
  return true;
}

/** Opens escalations whose owner window ran out. Safe to call repeatedly; a worker and every claim attempt both call it. */
export async function advanceEscalations(now = new Date()): Promise<number> {
  const emails: OutgoingEmail[] = [];
  const opened = await withSystem(async (db) => {
    const { rows } = await db.query<EscalationRow>(
      "select id, org_id, conversation_id, contact_id, category, urgency, status, owner_user_id, owner_response, owner_deadline_at, claimed_by from human_escalations where status = 'awaiting_owner' and owner_deadline_at is not null and owner_deadline_at <= $1 for update skip locked",
      [now.toISOString()],
    );
    let n = 0;
    for (const esc of rows) if (await openToStaff(db, esc, "timed_out", emails, now)) n += 1;
    return n;
  });
  await Promise.all(emails.map((e) => sendEmail(e)));
  return opened;
}

export async function recordOwnership(db: Queryable, e: { orgId: string; conversationId: string; from: { kind: OwnerKind; userId: string | null }; to: { kind: OwnerKind; userId: string | null }; actorKind: "user" | "ai" | "system" | "agency"; actorUserId: string | null; reason: string; escalationId?: string | null }) {
  await db.query(
    `insert into conversation_ownership_events (org_id, conversation_id, from_kind, from_user_id, to_kind, to_user_id, actor_kind, actor_user_id, reason, escalation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [e.orgId, e.conversationId, e.from.kind, e.from.userId, e.to.kind, e.to.userId, e.actorKind, e.actorUserId, e.reason.slice(0, 300), e.escalationId ?? null],
  );
}

/** Moves a conversation to a person: the AI stops, queued AI messages and follow-ups are cancelled, and the transition is recorded. */
async function giveToHuman(db: Queryable, input: { orgId: string; conversationId: string; userId: string; reason: string; escalationId?: string | null }) {
  const { rows } = await db.query<{ owner_kind: OwnerKind; owner_user_id: string | null; contact_id: string }>("select owner_kind, owner_user_id, contact_id from conversations where id = $1 and org_id = $2 for update", [input.conversationId, input.orgId]);
  const conv = rows[0];
  if (!conv) throw new AppError("not_found", "Conversation not found.");
  if (conv.owner_kind === "human" && conv.owner_user_id && conv.owner_user_id !== input.userId) {
    const { rows: who } = await db.query<{ full_name: string }>("select full_name from users where id = $1", [conv.owner_user_id]);
    throw new AppError("conflict", `${who[0]?.full_name || "A teammate"} already owns this conversation.`);
  }
  if (!(conv.owner_kind === "human" && conv.owner_user_id === input.userId)) {
    // A person owning it ends any AI pause too: the pause only means something while the AI is the owner.
    await db.query("update conversations set owner_kind = 'human', owner_user_id = $2, assigned_user_id = $2, ownership_version = ownership_version + 1, ai_paused_at = null, ai_paused_by = null, ai_pause_reason = null where id = $1", [input.conversationId, input.userId]);
    await recordOwnership(db, { orgId: input.orgId, conversationId: input.conversationId, from: { kind: conv.owner_kind, userId: conv.owner_user_id }, to: { kind: "human", userId: input.userId }, actorKind: "user", actorUserId: input.userId, reason: input.reason, escalationId: input.escalationId });
  }
  const stopped = await cancelPendingAiMessages(db, input.orgId, input.conversationId, "human_owner");
  await cancelFollowUps(db, { orgId: input.orgId, contactId: conv.contact_id, reason: "human_took_over" });
  return { stoppedMessages: stopped };
}

async function loadEscalation(db: Queryable, orgId: string, id: string): Promise<EscalationRow> {
  const { rows } = await db.query<EscalationRow>(
    "select id, org_id, conversation_id, contact_id, category, urgency, status, owner_user_id, owner_response, owner_deadline_at, claimed_by from human_escalations where id = $1 and org_id = $2 for update",
    [id, orgId],
  );
  if (!rows[0]) throw new AppError("not_found", "Escalation not found.");
  return rows[0];
}

/**
 * Accepts an escalation. The row is locked, so when two people try at once exactly one wins and the other is told who did.
 * During the owner's priority window only the owner can accept. Winning moves the conversation to that person and stops the AI.
 */
export async function claimEscalation(ctx: OrgContext, escalationId: string, now = new Date()) {
  if (!ctx.can("escalations.respond")) throw new AppError("forbidden", "Your role can't take customer escalations.");
  const emails: OutgoingEmail[] = [];
  const result = await withSystem(async (db) => {
    const esc = await loadEscalation(db, ctx.org.orgId, escalationId);
    if (esc.status === "awaiting_owner" && esc.owner_deadline_at && new Date(esc.owner_deadline_at).getTime() <= now.getTime()) {
      await openToStaff(db, esc, "timed_out", emails, now);
      esc.status = "open";
    }
    if (esc.status === "claimed") {
      if (esc.claimed_by === ctx.user.id) return { escalationId, conversationId: esc.conversation_id, alreadyYours: true };
      const { rows } = await db.query<{ full_name: string }>("select full_name from users where id = $1", [esc.claimed_by]);
      throw new AppError("conflict", `${rows[0]?.full_name || "A teammate"} already took this one.`);
    }
    if (esc.status === "resolved" || esc.status === "cancelled") throw new AppError("conflict", "This escalation is already closed.");

    const isOwner = esc.owner_user_id === ctx.user.id;
    if (esc.status === "awaiting_owner" && !isOwner) {
      throw new AppError("conflict", "The business owner has first priority on this one for a few minutes. You will be asked if they don't take it.");
    }
    if (!isOwner) {
      const eligible = await eligibleStaff(db, ctx.org.orgId, esc.category);
      if (!eligible.some((p) => p.userId === ctx.user.id)) throw new AppError("forbidden", "You are not authorized for this kind of escalation.");
    }
    const claim = await db.query(
      "update human_escalations set status = 'claimed', claimed_by = $2, claimed_at = $3, owner_response = case when $4 then 'accepted' else owner_response end where id = $1 and status in ('awaiting_owner', 'open')",
      [esc.id, ctx.user.id, now, isOwner],
    );
    if (!claim.rowCount) throw new AppError("conflict", "Someone just took this one.");
    await giveToHuman(db, { orgId: ctx.org.orgId, conversationId: esc.conversation_id, userId: ctx.user.id, reason: `Accepted escalation: ${ESCALATION_LABELS[esc.category]}`, escalationId: esc.id });
    await db.query("update escalation_recipients set responded_at = $3, response = case when user_id = $2 then 'claimed' else 'seen' end where escalation_id = $1 and responded_at is null", [esc.id, ctx.user.id, now]);
    const others = await db.query<{ user_id: string }>("select user_id from escalation_recipients where escalation_id = $1 and user_id <> $2", [esc.id, ctx.user.id]);
    for (const o of others.rows) {
      await notifyUser(db, o.user_id, ctx.org.orgId, { kind: "escalation_claimed", title: `${ctx.user.fullName || "A teammate"} took the ${ESCALATION_LABELS[esc.category].toLowerCase()} conversation`, body: "No action needed.", link: link(esc.conversation_id, esc.id), dedupeKey: `esc_claimed:${esc.id}:${o.user_id}` });
    }
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "escalation.claimed", targetType: "escalation", targetId: esc.id, result: "success", metadata: { category: esc.category, viaOwnerPriority: isOwner } }, db);
    return { escalationId: esc.id, conversationId: esc.conversation_id, alreadyYours: false };
  });
  await Promise.all(emails.map((e) => sendEmail(e)));
  return result;
}

/** The owner declines: teammates who are authorized are asked right away instead of waiting out the timer. */
export async function declineEscalation(ctx: OrgContext, escalationId: string, now = new Date()) {
  const emails: OutgoingEmail[] = [];
  await withSystem(async (db) => {
    const esc = await loadEscalation(db, ctx.org.orgId, escalationId);
    if (esc.owner_user_id !== ctx.user.id) throw new AppError("forbidden", "Only the business owner can decline an owner-priority escalation.");
    if (esc.status !== "awaiting_owner") throw new AppError("conflict", "This escalation is no longer waiting on you.");
    await db.query("update escalation_recipients set responded_at = $3, response = 'declined' where escalation_id = $1 and user_id = $2 and kind = 'action_required'", [esc.id, ctx.user.id, now]);
    await openToStaff(db, esc, "declined", emails, now);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "escalation.declined", targetType: "escalation", targetId: esc.id, result: "success" }, db);
  });
  await Promise.all(emails.map((e) => sendEmail(e)));
}

export async function resolveEscalation(ctx: OrgContext, escalationId: string, resolution: string) {
  if (!ctx.can("escalations.respond")) throw new AppError("forbidden", "Your role can't take customer escalations.");
  await withSystem(async (db) => {
    const esc = await loadEscalation(db, ctx.org.orgId, escalationId);
    if (esc.status !== "claimed") throw new AppError("conflict", "Only an escalation someone has taken can be resolved.");
    if (esc.claimed_by !== ctx.user.id && !ctx.can("inbox.assign")) throw new AppError("forbidden", "Only the person handling it, or a manager, can close this.");
    await db.query("update human_escalations set status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = nullif($3, '') where id = $1", [esc.id, ctx.user.id, resolution.trim().slice(0, 500)]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "escalation.resolved", targetType: "escalation", targetId: esc.id, result: "success" }, db);
  });
}

/** Manager-visible queue of escalations nobody has taken. Calling it also applies any timers that have run out. */
export async function listOpenEscalations(ctx: OrgContext) {
  await advanceEscalations();
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; conversation_id: string; category: EscalationCategory; urgency: EscalationUrgency; status: string; summary: string; owner_response: string; owner_deadline_at: Date | null; created_at: Date; claimed_by: string | null; claimed_name: string | null }>(
      `select e.id, e.conversation_id, e.category, e.urgency, e.status, e.summary, e.owner_response, e.owner_deadline_at, e.created_at, e.claimed_by, u.full_name as claimed_name
       from human_escalations e left join users u on u.id = e.claimed_by
       where e.org_id = $1 and e.status in ('awaiting_owner', 'open', 'claimed')
         and ($2::boolean or exists (select 1 from escalation_recipients r where r.escalation_id = e.id and r.user_id = $3))
       order by case e.urgency when 'urgent' then 0 else 1 end, e.created_at`,
      [ctx.org.orgId, ctx.can("inbox.view_all"), ctx.user.id],
    );
    return rows;
  });
}

/**
 * Makes the signed-in person the conversation's owner inside the caller's transaction. They must be able to see it, and during
 * the owner's priority window only the owner can take an escalated conversation.
 */
export async function ensureHumanOwner(db: Queryable, ctx: OrgContext, conversationId: string, reason = "Taken over from the inbox") {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role can't reply to customers.");
  const { rows } = await db.query<{ assigned_user_id: string | null; owner_user_id: string | null }>("select assigned_user_id, owner_user_id from conversations where id = $1 and org_id = $2", [conversationId, ctx.org.orgId]);
  if (!rows[0]) throw new AppError("not_found", "Conversation not found.");
  if (!ctx.can("inbox.view_all") && rows[0].assigned_user_id !== ctx.user.id && rows[0].owner_user_id !== ctx.user.id) throw new AppError("not_found", "Conversation not found.");
  const pending = await db.query<{ owner_user_id: string | null }>("select owner_user_id from human_escalations where conversation_id = $1 and status = 'awaiting_owner'", [conversationId]);
  if (pending.rows[0] && pending.rows[0].owner_user_id !== ctx.user.id) throw new AppError("conflict", "The business owner has first priority on this conversation right now.");
  return giveToHuman(db, { orgId: ctx.org.orgId, conversationId, userId: ctx.user.id, reason });
}

/** A person starts handling a conversation without an escalation, for example after reading it in the inbox. */
export async function takeOverConversation(ctx: OrgContext, conversationId: string, reason = "Taken over from the inbox") {
  return withSystem(async (db) => {
    const out = await ensureHumanOwner(db, ctx, conversationId, reason);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "conversation.taken_over", targetType: "conversation", targetId: conversationId, result: "success" }, db);
    return out;
  });
}

/**
 * Everything that would make it unsafe to let the AI reply on a conversation right now, in plain words (empty when it is safe): the employee
 * is attached, enabled, connected and not paused, messaging is not paused, the channel works, and no escalation is still open.
 */
export async function aiResumeProblems(db: Queryable, orgId: string, conv: { ai_agent_id: string | null; channel: string }, conversationId: string): Promise<string[]> {
  const problems: string[] = [];
  if (!conv.ai_agent_id) problems.push("No AI employee is assigned to this conversation.");
  else {
    const { rows: agent } = await db.query<{ enabled: boolean; status: string; mode: string; display_name: string }>("select enabled, status, mode, display_name from agent_instances where id = $1 and org_id = $2", [conv.ai_agent_id, orgId]);
    const a = agent[0];
    if (!a || !a.enabled) problems.push("The AI employee is not included in this workspace.");
    else {
      if (!isRuntimeOnline(a.status)) problems.push(`${a.display_name} has not passed its connection check.`);
      if (a.mode === "paused") problems.push(`${a.display_name} is paused.`);
    }
  }
  const pauses = await db.query<{ scope: string }>("select p.scope from automation_pauses p join organizations o on o.id = p.org_id where p.active and (p.org_id = $1 or (o.kind = 'agency' and p.scope = 'agency'))", [orgId]);
  if (pauses.rows.some((p) => p.scope === "agency")) problems.push("iAcquire has paused automation for this workspace.");
  if (pauses.rows.some((p) => p.scope === "messaging")) problems.push("Customer-facing AI messaging is paused.");
  const ch = await db.query<{ enabled: boolean }>("select enabled from messaging_channels where org_id = $1 and channel = $2", [orgId, conv.channel]);
  if (!ch.rows[0]?.enabled) problems.push("This channel is not verified and enabled.");
  const open = await db.query("select 1 from human_escalations where conversation_id = $1 and status in ('awaiting_owner', 'open', 'claimed')", [conversationId]);
  if (open.rows[0]) problems.push("An escalation for this conversation is still open. Resolve it first.");
  return problems;
}

/**
 * Returns a conversation to the AI only if everything that would make that safe is true right now: the person handing it back
 * (or a manager) is doing it, the employee is ready and not paused, messaging is not paused, the channel works, and no
 * escalation is still open. It also lifts a pause a person put on the AI's replies (the AI already owns the conversation then).
 */
export async function resumeAi(ctx: OrgContext, conversationId: string) {
  if (!ctx.can("inbox.resume_ai")) throw new AppError("forbidden", "Your role can't hand conversations back to the AI.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ owner_kind: OwnerKind; owner_user_id: string | null; ai_agent_id: string | null; channel: string; ai_paused_at: Date | null }>(
      "select owner_kind, owner_user_id, ai_agent_id, channel, ai_paused_at from conversations where id = $1 and org_id = $2 for update",
      [conversationId, ctx.org.orgId],
    );
    const conv = rows[0];
    if (!conv) throw new AppError("not_found", "Conversation not found.");
    if (conv.owner_kind === "ai" && !conv.ai_paused_at) throw new AppError("conflict", "The AI already owns this conversation.");
    if (conv.owner_user_id && conv.owner_user_id !== ctx.user.id && !ctx.can("inbox.assign")) throw new AppError("forbidden", "Only the person handling this, or a manager, can hand it back.");

    const problems = await aiResumeProblems(db, ctx.org.orgId, conv, conversationId);
    if (problems.length) throw new AppError("conflict", `It isn't safe to hand this back yet. ${problems.join(" ")}`);

    // The version moves on every change of who may reply, so anything prepared before this (even by this same employee) is stale.
    await db.query("update conversations set owner_kind = 'ai', owner_user_id = null, ownership_version = ownership_version + 1, ai_paused_at = null, ai_paused_by = null, ai_pause_reason = null where id = $1", [conversationId]);
    if (conv.owner_kind !== "ai") {
      await recordOwnership(db, { orgId: ctx.org.orgId, conversationId, from: { kind: conv.owner_kind, userId: conv.owner_user_id }, to: { kind: "ai", userId: null }, actorKind: "user", actorUserId: ctx.user.id, reason: "Handed back to the AI" });
    } else {
      await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "ai_resumed", actor: { kind: "user", userId: ctx.user.id } });
    }
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "conversation.resumed_ai", targetType: "conversation", targetId: conversationId, result: "success" }, db);
    return { ownerKind: "ai" as const };
  });
}

/** Managers assign who can see and work a conversation. Assignment is not ownership: a person still takes it over to reply. */
export async function assignConversation(ctx: OrgContext, conversationId: string, userId: string | null) {
  if (!ctx.can("inbox.assign")) throw new AppError("forbidden", "Only owners and managers can assign conversations.");
  await withSystem(async (db) => {
    if (userId) {
      const m = await db.query<{ role: string }>("select role from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [ctx.org.orgId, userId]);
      if (!m.rows[0]) throw new AppError("not_found", "That person is not on your team.");
      const can = await db.query("select 1 from role_permissions where role = $1 and permission = 'inbox.reply'", [m.rows[0].role]);
      if (!can.rows[0]) throw new AppError("invalid_input", "That person's role can't reply to customers.");
    }
    const before = await db.query<{ assigned_user_id: string | null }>("select assigned_user_id from conversations where id = $1 and org_id = $2 for update", [conversationId, ctx.org.orgId]);
    if (!before.rows[0]) throw new AppError("not_found", "Conversation not found.");
    if (before.rows[0].assigned_user_id === userId) return;
    await db.query("update conversations set assigned_user_id = $3 where id = $1 and org_id = $2", [conversationId, ctx.org.orgId, userId]);
    const ev = await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "assigned", actor: { kind: "user", userId: ctx.user.id }, detail: { to: userId, from: before.rows[0].assigned_user_id } });
    // The person is told once per assignment (the event id is the key) if the workspace has the new inbox, whose notice this is. Assigning to yourself needs no notice.
    if (userId && userId !== ctx.user.id && (await inboxEnabledFor(ctx.org.orgId, db))) {
      await notifyUser(db, userId, ctx.org.orgId, { kind: "conversation_assigned", title: `${ctx.user.fullName || "A teammate"} assigned you a conversation`, body: "Open it to see the customer's message.", link: link(conversationId), dedupeKey: `conv_assigned:${conversationId}:a${ev.id}` });
    }
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "conversation.assigned", targetType: "conversation", targetId: conversationId, result: "success", metadata: { assignedTo: userId } }, db);
  });
}
