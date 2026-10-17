import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { reserveCredits, releaseReservation, BillingBlockedError } from "@/server/billing/ledger";
import { createApproval } from "@/server/approvals/service";
import { ensureHumanOwner } from "@/server/messaging/handoff";
import { evaluateSend, queueOutbound } from "@/server/messaging/send";
import { validateBusinessHours, type BusinessHours, type Channel, type CustomFollowUp, type FollowUpPreset, type MessageStatus } from "@/lib/messaging";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";

export interface ConversationListItem {
  id: string;
  contactId: string;
  contactName: string;
  channel: Channel;
  status: "open" | "snoozed" | "closed";
  ownerKind: "ai" | "human" | "unassigned";
  ownerName: string | null;
  ownerUserId: string | null;
  assignedUserId: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  unread: number;
  lastMessageAt: string | null;
  preview: string | null;
  escalation: { id: string; status: string; urgency: string } | null;
}

export interface ConversationFilters {
  q?: string;
  channel?: Channel;
  status?: "open" | "closed";
  owner?: "ai" | "human" | "unassigned" | "mine";
  unreadOnly?: boolean;
  priority?: "low" | "normal" | "high" | "urgent";
  limit?: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Conversations the signed-in person is allowed to see. Row-level security decides visibility, not this query. */
export async function listConversations(ctx: OrgContext, f: ConversationFilters = {}): Promise<ConversationListItem[]> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  const params: unknown[] = [ctx.org.orgId];
  const where: string[] = ["c.org_id = $1"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.channel) add("c.channel = ?", f.channel);
  if (f.status) add("c.status = ?", f.status);
  if (f.priority) add("c.priority = ?", f.priority);
  if (f.unreadOnly) where.push("c.unread_count > 0");
  if (f.owner === "mine") add("c.owner_user_id = ?", ctx.user.id);
  else if (f.owner) add("c.owner_kind = ?", f.owner);
  if (f.q?.trim()) {
    params.push(`%${escapeLike(f.q.trim().slice(0, 80))}%`);
    const p = `$${params.length}`;
    where.push(`(k.display_name ilike ${p} escape '\\' or c.last_message_preview ilike ${p} escape '\\' or exists (select 1 from contact_identities i where i.contact_id = k.id and i.value ilike ${p} escape '\\'))`);
  }
  params.push(Math.min(Math.max(f.limit ?? 60, 1), 200));
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; contact_id: string; display_name: string; channel: Channel; status: "open" | "snoozed" | "closed"; owner_kind: "ai" | "human" | "unassigned"; owner_name: string | null; owner_user_id: string | null;
      assigned_user_id: string | null; priority: "low" | "normal" | "high" | "urgent"; unread_count: number; last_message_at: Date | null; last_message_preview: string | null; esc_id: string | null; esc_status: string | null; esc_urgency: string | null;
    }>(
      `select c.id, c.contact_id, k.display_name, c.channel, c.status, c.owner_kind, u.full_name as owner_name, c.owner_user_id, c.assigned_user_id, c.priority, c.unread_count,
              c.last_message_at, c.last_message_preview, e.id as esc_id, e.status as esc_status, e.urgency as esc_urgency
       from conversations c join contacts k on k.id = c.contact_id and k.org_id = c.org_id and k.deleted_at is null
       left join users u on u.id = c.owner_user_id
       left join lateral (select id, status, urgency from human_escalations where conversation_id = c.id and status in ('awaiting_owner', 'open', 'claimed') limit 1) e on true
       where ${where.join(" and ")}
       order by (e.status in ('awaiting_owner', 'open')) desc nulls last, case c.priority when 'urgent' then 0 when 'high' then 1 else 2 end, c.last_message_at desc nulls last
       limit $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      contactName: r.display_name || "Unknown contact",
      channel: r.channel,
      status: r.status,
      ownerKind: r.owner_kind,
      ownerName: r.owner_name,
      ownerUserId: r.owner_user_id,
      assignedUserId: r.assigned_user_id,
      priority: r.priority,
      unread: r.unread_count,
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      preview: r.last_message_preview,
      escalation: r.esc_id ? { id: r.esc_id, status: r.esc_status as string, urgency: r.esc_urgency as string } : null,
    }));
  });
}

export interface MessageView {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  authorKind: "contact" | "ai" | "human" | "system";
  authorName: string | null;
  body: string;
  status: MessageStatus;
  statusDetail: string | null;
  blockedReason: string | null;
  scope: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

export interface ConversationDetail {
  conversation: ConversationListItem & { subject: string | null; lastInboundAt: string | null; whatsappWindowOpen: boolean | null };
  contact: { id: string; name: string; lifecycleStage: string; temperature: string | null; source: string; identities: Array<{ kind: string; value: string; verified: boolean }>; consent: Array<{ channel: string; purpose: string; status: string }> };
  messages: MessageView[];
  timeline: Array<{ at: string; text: string }>;
  memories: Array<{ id: string; kind: "confirmed_fact" | "ai_summary"; content: string; createdAt: string }>;
  followUp: { status: string; nextDueAt: string | null; remaining: number } | null;
  escalation: { id: string; category: string; urgency: string; status: string; summary: string; ownerResponse: string; ownerDeadlineAt: string | null; claimedByName: string | null } | null;
}

export async function getConversationDetail(ctx: OrgContext, conversationId: string): Promise<ConversationDetail> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  const list = await listConversations(ctx, { limit: 200 });
  const base = list.find((c) => c.id === conversationId);
  if (!base) throw new AppError("not_found", "Conversation not found.");
  return withUser(ctx.user.id, async (db) => {
    const conv = await db.query<{ subject: string | null; last_inbound_at: Date | null }>("select subject, last_inbound_at from conversations where id = $1", [conversationId]);
    const k = await db.query<{ id: string; display_name: string; lifecycle_stage: string; temperature: string | null; source: string }>("select id, display_name, lifecycle_stage, temperature, source from contacts where id = $1", [base.contactId]);
    const ids = await db.query<{ kind: string; value: string; verified: boolean }>("select kind, value, verified from contact_identities where contact_id = $1 order by kind", [base.contactId]);
    const consent = await db.query<{ channel: string; purpose: string; status: string }>(
      "select distinct on (channel, purpose) channel, purpose, status from contact_consent_events where contact_id = $1 order by channel, purpose, id desc",
      [base.contactId],
    );
    const msgs = await db.query<{ id: string; direction: MessageView["direction"]; author_kind: MessageView["authorKind"]; author_name: string | null; body: string; status: MessageStatus; status_detail: string | null; blocked_reason: string | null; scope: string | null; created_at: Date; sent_at: Date | null; delivered_at: Date | null }>(
      `select m.id, m.direction, m.author_kind, u.full_name as author_name, m.body, m.status, m.status_detail, m.blocked_reason, m.scope, m.created_at, m.sent_at, m.delivered_at
       from conversation_messages m left join users u on u.id = m.author_user_id where m.conversation_id = $1 order by m.created_at, m.id`,
      [conversationId],
    );
    const events = await db.query<{ created_at: Date; from_kind: string; to_kind: string; actor_kind: string; reason: string | null; to_name: string | null }>(
      `select e.created_at, e.from_kind, e.to_kind, e.actor_kind, e.reason, u.full_name as to_name from conversation_ownership_events e left join users u on u.id = e.to_user_id where e.conversation_id = $1 order by e.id`,
      [conversationId],
    );
    const mem = await db.query<{ id: string; kind: "confirmed_fact" | "ai_summary"; content: string; created_at: Date }>("select id, kind, content, created_at from contact_memories where contact_id = $1 order by created_at desc limit 30", [base.contactId]);
    const plan = await db.query<{ status: string }>("select status from follow_up_plans where contact_id = $1 and status = 'active'", [base.contactId]).catch(() => ({ rows: [] as Array<{ status: string }> }));
    const steps = plan.rows[0]
      ? await db.query<{ next: Date | null; remaining: string }>("select min(due_at) filter (where status = 'scheduled') as next, count(*) filter (where status in ('scheduled', 'queued'))::text as remaining from follow_up_steps where contact_id = $1 and plan_id in (select id from follow_up_plans where contact_id = $1 and status = 'active')", [base.contactId])
      : null;
    const esc = await db.query<{ id: string; category: string; urgency: string; status: string; summary: string; owner_response: string; owner_deadline_at: Date | null; claimed_name: string | null }>(
      `select e.id, e.category, e.urgency, e.status, e.summary, e.owner_response, e.owner_deadline_at, u.full_name as claimed_name
       from human_escalations e left join users u on u.id = e.claimed_by where e.conversation_id = $1 and e.status in ('awaiting_owner', 'open', 'claimed') limit 1`,
      [conversationId],
    ).catch(() => ({ rows: [] as never[] }));
    const policy = await db.query<{ whatsapp_window_hours: number }>("select whatsapp_window_hours from messaging_policy");
    const lastIn = conv.rows[0]?.last_inbound_at ? new Date(conv.rows[0].last_inbound_at) : null;
    const timeline: Array<{ at: string; text: string }> = [];
    for (const e of events.rows) timeline.push({ at: new Date(e.created_at).toISOString(), text: `${e.actor_kind === "ai" ? "AI" : e.actor_kind === "system" ? "System" : "A teammate"} moved this from ${e.from_kind} to ${e.to_kind}${e.to_name ? ` (${e.to_name})` : ""}${e.reason ? `: ${e.reason}` : ""}` });
    for (const m of msgs.rows) {
      if (m.direction === "outbound" && m.author_kind === "ai") timeline.push({ at: new Date(m.created_at).toISOString(), text: m.status === "draft" ? "AI drafted a reply for approval" : m.status === "blocked" ? `AI reply was blocked (${m.blocked_reason ?? "policy"})` : `AI ${m.status === "queued" ? "queued" : "sent"} a ${m.scope === "followup" ? "follow-up" : "reply"}` });
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at));
    return {
      conversation: { ...base, subject: conv.rows[0]?.subject ?? null, lastInboundAt: lastIn ? lastIn.toISOString() : null, whatsappWindowOpen: base.channel === "whatsapp" ? Boolean(lastIn && Date.now() - lastIn.getTime() <= policy.rows[0].whatsapp_window_hours * 3600_000) : null },
      contact: { id: k.rows[0].id, name: k.rows[0].display_name || "Unknown contact", lifecycleStage: k.rows[0].lifecycle_stage, temperature: k.rows[0].temperature, source: k.rows[0].source, identities: ids.rows, consent: consent.rows },
      messages: msgs.rows.map((m) => ({ id: m.id, direction: m.direction, authorKind: m.author_kind, authorName: m.author_name, body: m.body, status: m.status, statusDetail: m.status_detail, blockedReason: m.blocked_reason, scope: m.scope, createdAt: new Date(m.created_at).toISOString(), sentAt: m.sent_at ? new Date(m.sent_at).toISOString() : null, deliveredAt: m.delivered_at ? new Date(m.delivered_at).toISOString() : null })),
      timeline,
      memories: mem.rows.map((m) => ({ id: m.id, kind: m.kind, content: m.content, createdAt: new Date(m.created_at).toISOString() })),
      followUp: plan.rows[0] && steps ? { status: "active", nextDueAt: steps.rows[0].next ? new Date(steps.rows[0].next).toISOString() : null, remaining: Number(steps.rows[0].remaining) } : null,
      escalation: esc.rows[0] ? { id: esc.rows[0].id, category: esc.rows[0].category, urgency: esc.rows[0].urgency, status: esc.rows[0].status, summary: esc.rows[0].summary, ownerResponse: esc.rows[0].owner_response, ownerDeadlineAt: esc.rows[0].owner_deadline_at ? new Date(esc.rows[0].owner_deadline_at).toISOString() : null, claimedByName: esc.rows[0].claimed_name } : null,
    };
  });
}

/** Opening a conversation marks it read for everyone. Only people who can see it can do this. */
export async function markConversationRead(ctx: OrgContext, conversationId: string) {
  const visible = await withUser(ctx.user.id, (db) => db.query("select 1 from conversations where id = $1", [conversationId]));
  if (!visible.rows[0]) throw new AppError("not_found", "Conversation not found.");
  await withSystem((db) => db.query("update conversations set unread_count = 0 where id = $1 and org_id = $2", [conversationId, ctx.org.orgId]));
}

/**
 * A person's own reply. If the AI owns the conversation they take it over first (stopping the AI), then the message goes through
 * the same rule chain as any other. A reply that cannot be sent is refused with the reason instead of being left as a failed row.
 */
export async function sendHumanReply(ctx: OrgContext, conversationId: string, body: string, opts: { templateId?: string | null } = {}) {
  const text = body.trim();
  if (!text || text.length > 5000) throw new AppError("invalid_input", "Write a message of up to 5,000 characters.");
  return withSystem(async (db) => {
    await ensureHumanOwner(db, ctx, conversationId, "Replied from the inbox");
    const result = await queueOutbound(db, { orgId: ctx.org.orgId, conversationId, scope: "human", actor: { kind: "human", userId: ctx.user.id }, body: text, templateId: opts.templateId ?? null });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "message.queued", targetType: "conversation", targetId: conversationId, result: "success", metadata: { scope: "human" } }, db);
    return result;
  });
}

export async function addInternalNote(ctx: OrgContext, conversationId: string, body: string) {
  if (!ctx.can("inbox.notes")) throw new AppError("forbidden", "Your role can't add notes.");
  const text = body.trim();
  if (!text || text.length > 2000) throw new AppError("invalid_input", "Write a note of up to 2,000 characters.");
  const visible = await withUser(ctx.user.id, (db) => db.query("select 1 from conversations where id = $1", [conversationId]));
  if (!visible.rows[0]) throw new AppError("not_found", "Conversation not found.");
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      "insert into conversation_messages (org_id, conversation_id, direction, author_kind, author_user_id, body, status) values ($1, $2, 'internal', 'human', $3, $4, 'note') returning id",
      [ctx.org.orgId, conversationId, ctx.user.id, text],
    ),
  );
  return rows[0].id;
}

/**
 * Turns an approved AI draft into queued work. Both the inbox and the Approval Center end up here, and the draft goes through the
 * full rule chain again with that approval, so a pause, opt-out, takeover or lack of credit still stops it.
 */
export async function queueApprovedDraft(db: Queryable, input: { orgId: string; messageId: string; approvalId: string }): Promise<{ status: "succeeded" | "blocked"; detail: string }> {
  const { rows } = await db.query<{ id: string; conversation_id: string; body: string; agent_id: string | null; scope: "reply" | "followup" | "human" | null; status: string; template_id: string | null }>(
    "select id, conversation_id, body, agent_id, scope, status, template_id from conversation_messages where id = $1 and org_id = $2 and direction = 'outbound' and author_kind = 'ai' for update",
    [input.messageId, input.orgId],
  );
  const m = rows[0];
  if (!m) return { status: "blocked", detail: "The draft no longer exists." };
  if (m.status !== "draft") return { status: "blocked", detail: "The draft was already handled, so nothing more was sent." };
  const decision = await evaluateSend(db, { orgId: input.orgId, conversationId: m.conversation_id, scope: m.scope ?? "reply", actor: { kind: "ai", agentId: m.agent_id, approvalId: input.approvalId }, body: m.body, templateId: m.template_id });
  if (!decision.allow) {
    await db.query("update conversation_messages set status = 'blocked', blocked_reason = $2, status_detail = $3, approval_id = $4 where id = $1", [m.id, decision.reason, decision.detail.slice(0, 300), input.approvalId]);
    return { status: "blocked", detail: `Approved, but it cannot be sent right now. ${decision.detail}` };
  }
  try {
    const hold = await reserveCredits(db, { orgId: input.orgId, estimateMicros: Math.max(1, decision.estimateMicros), purpose: `${decision.channel} message`, jobReference: `msg:${m.id}`, ttlSeconds: 6 * 3600 });
    await db.query("update conversation_messages set status = 'queued', queued_at = now(), approval_id = $2, reservation_id = $3, blocked_reason = null, status_detail = null where id = $1", [m.id, input.approvalId, hold.id]);
  } catch (err) {
    if (err instanceof BillingBlockedError) return { status: "blocked", detail: err.message };
    throw err;
  }
  return { status: "succeeded", detail: "Queued for sending." };
}

/** A person approves an AI draft from the inbox. The approval is recorded in the Approval Center like any other. */
export async function approveDraft(ctx: OrgContext, messageId: string) {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role cannot approve messages to customers.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; conversation_id: string; agent_id: string | null; scope: string | null; status: string; approval_id: string | null }>(
      "select id, conversation_id, agent_id, scope, status, approval_id from conversation_messages where id = $1 and org_id = $2 and direction = 'outbound' and author_kind = 'ai' for update",
      [messageId, ctx.org.orgId],
    );
    const m = rows[0];
    if (!m) throw new AppError("not_found", "Draft not found.");
    if (m.status !== "draft") throw new AppError("conflict", "This message is not waiting for approval.");
    const visible = await db.query("select 1 from conversations c where c.id = $1 and c.org_id = $2 and ($3::boolean or c.assigned_user_id = $4 or c.owner_user_id = $4)", [m.conversation_id, ctx.org.orgId, ctx.can("inbox.view_all"), ctx.user.id]);
    if (!visible.rows[0]) throw new AppError("not_found", "Draft not found.");

    let approvalId = m.approval_id;
    let decided = false;
    if (approvalId) {
      // Compare-and-set so a second approver, or the Approval Center, cannot approve the same draft twice.
      const res = await db.query("update approval_requests set status = 'approved', decided_by = $2, decided_at = now(), execution_status = 'running' where id = $1 and org_id = $3 and status = 'pending' and (expires_at is null or expires_at > now())", [approvalId, ctx.user.id, ctx.org.orgId]);
      decided = res.rowCount > 0;
    }
    if (!approvalId || !decided) {
      approvalId = await createApproval(db, { orgId: ctx.org.orgId, agentId: m.agent_id, kind: "follow_up_message", title: "Send AI reply to a customer", action: { messageId: m.id }, targetType: "conversation", targetId: m.conversation_id, reason: "AI prepared a customer message for approval.", expectedEffect: "The message is sent to the customer.", risk: "medium", actorKind: "agent" });
      if (!approvalId) throw new AppError("conflict", "Could not record the approval.");
      await db.query("update approval_requests set status = 'approved', decided_by = $2, decided_at = now(), execution_status = 'running' where id = $1", [approvalId, ctx.user.id]);
    }
    await db.query("insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event) values ($1, $2, $3, 'user', 'approved')", [approvalId, ctx.org.orgId, ctx.user.id]);
    const outcome = await queueApprovedDraft(db, { orgId: ctx.org.orgId, messageId: m.id, approvalId });
    await db.query("update approval_requests set execution_status = $2, execution_detail = $3, executed_at = case when $2 = 'succeeded' then now() end where id = $1", [approvalId, outcome.status, outcome.detail]);
    if (outcome.status === "blocked") throw new AppError("conflict", outcome.detail);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "message.draft_approved", targetType: "message", targetId: m.id, approvalId, result: "success" }, db);
    return { messageId: m.id, approvalId };
  });
}

export async function discardDraft(ctx: OrgContext, messageId: string) {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role can't manage drafts.");
  await withSystem(async (db) => {
    const res = await db.query<{ reservation_id: string | null }>(
      "update conversation_messages set status = 'blocked', blocked_reason = 'discarded', status_detail = 'Discarded by a teammate.' where id = $1 and org_id = $2 and author_kind = 'ai' and status = 'draft' returning reservation_id",
      [messageId, ctx.org.orgId],
    );
    if (!res.rowCount) throw new AppError("not_found", "Draft not found.");
    if (res.rows[0].reservation_id) await releaseReservation(db, { orgId: ctx.org.orgId, reservationId: res.rows[0].reservation_id, reason: "Draft discarded" });
  });
}

export async function setConversationState(ctx: OrgContext, conversationId: string, input: { status?: "open" | "closed"; priority?: "low" | "normal" | "high" | "urgent" }) {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role can't change conversations.");
  const visible = await withUser(ctx.user.id, (db) => db.query("select 1 from conversations where id = $1", [conversationId]));
  if (!visible.rows[0]) throw new AppError("not_found", "Conversation not found.");
  await withSystem((db) => db.query("update conversations set status = coalesce($3, status), priority = coalesce($4, priority) where id = $1 and org_id = $2", [conversationId, ctx.org.orgId, input.status ?? null, input.priority ?? null]));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface MessagingSettingsView {
  autoReplyEnabled: boolean;
  replyBusinessHoursOnly: boolean;
  businessHours: BusinessHours;
  followUpPreset: FollowUpPreset;
  followUpCustom: CustomFollowUp | null;
  ownerTimeoutUrgentSeconds: number;
  ownerTimeoutNormalSeconds: number;
  channels: Array<{ channel: Channel; enabled: boolean; senderIdentity: string | null; verified: boolean; registrationStatus: string; detail: string | null }>;
  agencyLimits: { maxFollowupAttempts: number; maxFollowupsPer30Days: number; quietHoursStart: string; quietHoursEnd: string; whatsappWindowHours: number; minHoursBetweenFollowups: number };
}

export async function getMessagingSettings(ctx: OrgContext): Promise<MessagingSettingsView> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view messaging settings.");
  return withUser(ctx.user.id, async (db) => {
    const s = await db.query<{ auto_reply_enabled: boolean; reply_business_hours_only: boolean; business_hours: unknown; followup_preset: FollowUpPreset; followup_custom: CustomFollowUp | null; owner_timeout_urgent_seconds: number; owner_timeout_normal_seconds: number }>(
      "select auto_reply_enabled, reply_business_hours_only, business_hours, followup_preset, followup_custom, owner_timeout_urgent_seconds, owner_timeout_normal_seconds from messaging_settings where org_id = $1",
      [ctx.org.orgId],
    );
    const ch = await db.query<{ channel: Channel; enabled: boolean; sender_identity: string | null; sender_verified_at: Date | null; registration_status: string; detail: string | null }>(
      "select channel, enabled, sender_identity, sender_verified_at, registration_status, detail from messaging_channels where org_id = $1",
      [ctx.org.orgId],
    );
    const p = await db.query<{ max_followup_attempts: number; max_followups_per_contact_30d: number; quiet_hours_start: string; quiet_hours_end: string; whatsapp_window_hours: number; min_hours_between_followups: number }>("select * from messaging_policy");
    const row = s.rows[0];
    return {
      autoReplyEnabled: row?.auto_reply_enabled ?? false,
      replyBusinessHoursOnly: row?.reply_business_hours_only ?? false,
      businessHours: validateBusinessHours(row?.business_hours ?? {}) ?? {},
      followUpPreset: row?.followup_preset ?? "balanced",
      followUpCustom: row?.followup_custom ?? null,
      ownerTimeoutUrgentSeconds: row?.owner_timeout_urgent_seconds ?? 120,
      ownerTimeoutNormalSeconds: row?.owner_timeout_normal_seconds ?? 300,
      channels: (["sms", "whatsapp", "email"] as const).map((channel) => {
        const c = ch.rows.find((r) => r.channel === channel);
        return { channel, enabled: c?.enabled ?? false, senderIdentity: c?.sender_identity ?? null, verified: Boolean(c?.sender_verified_at), registrationStatus: c?.registration_status ?? "not_started", detail: c?.detail ?? null };
      }),
      agencyLimits: { maxFollowupAttempts: p.rows[0].max_followup_attempts, maxFollowupsPer30Days: p.rows[0].max_followups_per_contact_30d, quietHoursStart: String(p.rows[0].quiet_hours_start).slice(0, 5), quietHoursEnd: String(p.rows[0].quiet_hours_end).slice(0, 5), whatsappWindowHours: p.rows[0].whatsapp_window_hours, minHoursBetweenFollowups: p.rows[0].min_hours_between_followups },
    };
  });
}

export interface MessagingSettingsInput {
  autoReplyEnabled?: boolean;
  replyBusinessHoursOnly?: boolean;
  businessHours?: unknown;
  followUpPreset?: string;
  followUpCustom?: unknown;
  ownerTimeoutUrgentSeconds?: number;
  ownerTimeoutNormalSeconds?: number;
}

/** Clients tune these within the agency's safety limits; the limits themselves cannot be changed here. */
export async function updateMessagingSettings(ctx: OrgContext, input: MessagingSettingsInput) {
  if (!ctx.can("messaging.configure")) throw new AppError("forbidden", "Only owners and managers can change messaging settings.");
  if (input.autoReplyEnabled === true && ctx.role !== "owner") throw new AppError("forbidden", "Only the business owner can switch on automatic replies.");
  const hours = input.businessHours === undefined ? undefined : validateBusinessHours(input.businessHours);
  if (input.businessHours !== undefined && hours === null) throw new AppError("invalid_input", "Business hours look wrong. Use times like 09:00 to 17:00.");
  if (input.followUpPreset !== undefined && !["gentle", "balanced", "persistent", "off", "custom"].includes(input.followUpPreset)) throw new AppError("invalid_input", "Choose a follow-up style.");
  let custom: CustomFollowUp | null | undefined;
  if (input.followUpCustom !== undefined) {
    const c = input.followUpCustom as Partial<CustomFollowUp> | null;
    if (c === null) custom = null;
    else {
      if (!c || !Number.isInteger(c.attempts) || (c.attempts as number) < 1 || (c.attempts as number) > 10 || !Array.isArray(c.daysBetween) || c.daysBetween.length < 1 || c.daysBetween.length > 10 || c.daysBetween.some((d) => !Number.isInteger(d) || d < 1 || d > 30)) throw new AppError("invalid_input", "A custom schedule needs 1 to 10 attempts and 1 to 30 days between them.");
      custom = { attempts: c.attempts as number, daysBetween: c.daysBetween, channel: (["sms", "whatsapp", "email", "same"] as const).includes(c.channel as never) ? (c.channel as CustomFollowUp["channel"]) : "same", businessHoursOnly: c.businessHoursOnly !== false };
    }
  }
  for (const [label, v, lo, hi] of [["urgent", input.ownerTimeoutUrgentSeconds, 30, 3600], ["normal", input.ownerTimeoutNormalSeconds, 30, 7200]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < lo || v > hi)) throw new AppError("invalid_input", `The ${label} owner window must be between ${lo} and ${hi} seconds.`);
  }
  await withSystem(async (db) => {
    await db.query("insert into messaging_settings (org_id) values ($1) on conflict do nothing", [ctx.org.orgId]);
    await db.query(
      `update messaging_settings set auto_reply_enabled = coalesce($2, auto_reply_enabled), reply_business_hours_only = coalesce($3, reply_business_hours_only),
         business_hours = coalesce($4::jsonb, business_hours), followup_preset = coalesce($5, followup_preset),
         followup_custom = case when $6::boolean then $7::jsonb else followup_custom end,
         owner_timeout_urgent_seconds = coalesce($8, owner_timeout_urgent_seconds), owner_timeout_normal_seconds = coalesce($9, owner_timeout_normal_seconds), updated_by = $10
       where org_id = $1`,
      [ctx.org.orgId, input.autoReplyEnabled ?? null, input.replyBusinessHoursOnly ?? null, hours ? JSON.stringify(hours) : null, input.followUpPreset ?? null, input.followUpCustom !== undefined, custom ? JSON.stringify(custom) : null, input.ownerTimeoutUrgentSeconds ?? null, input.ownerTimeoutNormalSeconds ?? null, ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "messaging.settings_changed", targetType: "messaging_settings", targetId: ctx.org.orgId, result: "success", metadata: { autoReply: input.autoReplyEnabled, preset: input.followUpPreset } }, db);
  });
}

/** The owner or a manager switches a verified channel on or off. An unverified channel cannot be enabled (the database refuses it too). */
export async function setChannelEnabled(ctx: OrgContext, channel: Channel, enabled: boolean) {
  if (!ctx.can("messaging.configure")) throw new AppError("forbidden", "Only owners and managers can change channels.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ sender_verified_at: Date | null; registration_status: string }>("select sender_verified_at, registration_status from messaging_channels where org_id = $1 and channel = $2", [ctx.org.orgId, channel]);
    if (enabled && !rows[0]?.sender_verified_at) throw new AppError("conflict", "iAcquire has not verified this channel's sender yet.");
    if (enabled && channel !== "email" && !["not_required", "approved"].includes(rows[0].registration_status)) throw new AppError("conflict", "Sender registration for this channel is not approved yet.");
    await db.query("update messaging_channels set enabled = $3 where org_id = $1 and channel = $2", [ctx.org.orgId, channel, enabled]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: enabled ? "messaging.channel_enabled" : "messaging.channel_disabled", targetType: "messaging_channel", targetId: channel, result: "success" }, db);
  });
}

/**
 * Agency step: records that a sender (number, WhatsApp number or email domain) has been checked. Until a provider check exists
 * this is an attestation by named agency staff, and it says so; it never claims the provider confirmed anything.
 */
export async function attestChannelSender(user: Pick<SessionUser, "id" | "platformRole">, input: { orgId: string; channel: Channel; senderIdentity: string; registrationStatus: "not_required" | "pending" | "approved" | "rejected"; verified: boolean; evidence: string }) {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  if (input.evidence.trim().length < 5) throw new AppError("invalid_input", "Record what you checked, for example where you confirmed the sender.");
  await withSystem(async (db) => {
    const access = await db.query<{ allowed: boolean }>("select app.user_can_access_org($1,$2) as allowed", [user.id, input.orgId]);
    if (access.rows[0]?.allowed !== true) throw new AppError("forbidden", "You are not assigned to this client.");
    await db.query("insert into messaging_settings (org_id) values ($1) on conflict do nothing", [input.orgId]);
    await db.query(
      `insert into messaging_channels (org_id, channel, sender_identity, sender_verified_at, registration_status, last_checked_at, detail)
       values ($1, $2, $3, case when $4 then now() end, $5, now(), $6)
       on conflict (org_id, channel) do update set sender_identity = excluded.sender_identity, sender_verified_at = excluded.sender_verified_at,
         registration_status = excluded.registration_status, last_checked_at = now(), detail = excluded.detail,
         enabled = case when excluded.sender_verified_at is null or excluded.registration_status not in ('not_required', 'approved') and $2 <> 'email' then false else messaging_channels.enabled end`,
      [input.orgId, input.channel, input.senderIdentity.trim().slice(0, 200), input.verified, input.registrationStatus, `Attested by agency staff: ${input.evidence.trim().slice(0, 240)}`],
    );
    await recordAudit({ orgId: input.orgId, actorUserId: user.id, actorKind: "agency", action: "messaging.sender_attested", targetType: "messaging_channel", targetId: input.channel, result: "success", metadata: { verified: input.verified, registrationStatus: input.registrationStatus } }, db);
  });
}

