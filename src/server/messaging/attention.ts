import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { emitEvent } from "@/server/crm/events";
import { systemActor } from "@/server/crm/actor";
import { activeVersionsFor } from "@/server/crm/workflows/triggers";
import { customerUnreachable } from "@/server/messaging/inbox-list";
import { inboxEnabled } from "@/server/messaging/inbox-switch";
import { AWAITING_REPLY_MINUTES } from "@/lib/inbox";
import { CONVERSATION_IDLE_HOURS } from "@/lib/crm/workflow/spec";

// The inbox's attention scan, run by the scheduler every few minutes (src/server/ops/tick.ts). Two jobs, both idempotent and both keyed so a
// repeat run says nothing new:
//
//  1. Tell people when a customer has been waiting for a reply (once per customer message, not once per run), with a cap per workspace per run
//     so a bad hour cannot bury a person in notifications. Nothing in a notice repeats what the customer wrote.
//  2. Announce "this conversation went quiet" to the workflows that asked for it, at the times they chose (conversation.idle). Nothing is
//     recorded for a workspace with no such workflow.

/** At most this many individual "customer is waiting" notices per workspace per run; the rest become one summary. */
export const AWAITING_NOTICE_CAP = 10;
/** A customer message unanswered for longer than this is no longer news: it was announced when it crossed the threshold. */
const AWAITING_MAX_AGE_HOURS = 24;
const SCAN_LIMIT = 500;

interface WaitingRow {
  id: string;
  org_id: string;
  owner_user_id: string | null;
  assigned_user_id: string | null;
  last_inbound_at: Date;
}

/** Customers waiting for a reply for at least AWAITING_REPLY_MINUTES (and less than a day): the owner or assignee hears, else the owners and managers. */
export async function notifyAwaitingReplies(db: Queryable, now = new Date()): Promise<number> {
  const { rows } = await db.query<WaitingRow>(
    `select c.id, c.org_id, c.owner_user_id, c.assigned_user_id, c.last_inbound_at
     from conversations c join organizations o on o.id = c.org_id and o.status not in ('suspended', 'archived')
     where c.status <> 'closed' and c.archived_at is null and c.unread_count > 0 and c.last_inbound_at is not null
       and c.last_inbound_at <= $1::timestamptz - ($2 || ' minutes')::interval and c.last_inbound_at > $1::timestamptz - ($3 || ' hours')::interval
       and (c.last_outbound_at is null or c.last_outbound_at < c.last_inbound_at)
       and not ${customerUnreachable("c")}
     order by c.last_inbound_at limit $4`,
    [now.toISOString(), String(AWAITING_REPLY_MINUTES), String(AWAITING_MAX_AGE_HOURS), SCAN_LIMIT],
  );
  let sent = 0;
  const perOrg = new Map<string, number>();
  for (const c of rows) {
    const key = `awaiting:${c.id}:${new Date(c.last_inbound_at).getTime()}`;
    const done = (perOrg.get(c.org_id) ?? 0) + 1;
    perOrg.set(c.org_id, done);
    if (done > AWAITING_NOTICE_CAP) continue;
    const link = `/inbox?conversation=${c.id}`;
    const n = { kind: "conversation_awaiting_reply" as const, severity: "warning" as const, title: "A customer is waiting for a reply", body: "Open the conversation to answer, or let the AI employee handle it.", link, dedupeKey: key };
    const personal = c.owner_user_id ?? c.assigned_user_id;
    if (personal) {
      if (await notifyUser(db, personal, c.org_id, n)) sent += 1;
    } else {
      // notifyOrgRoles has no return value; the per-person dedupe key keeps a repeat run quiet.
      await notifyOrgRoles(db, c.org_id, ["owner", "admin"], n);
      sent += 1;
    }
  }
  // Past the cap: one summary per workspace and hour instead of a flood.
  for (const [orgId, n] of perOrg) {
    if (n <= AWAITING_NOTICE_CAP) continue;
    await notifyOrgRoles(db, orgId, ["owner", "admin"], {
      kind: "conversation_awaiting_reply",
      severity: "warning",
      title: `${n} customers are waiting for a reply`,
      body: "Open the inbox and choose Needs attention.",
      link: "/inbox?view=attention",
      dedupeKey: `awaiting-digest:${orgId}:${now.toISOString().slice(0, 13)}`,
    });
    sent += 1;
  }
  return sent;
}

/** The window in which a conversation that has been quiet for `hours` is announced: from that long, to a quarter longer (at least two hours). */
export const idleWindowHours = (hours: number) => Math.max(2, hours / 4);

/**
 * Announces "conversation.idle" for conversations that have been quiet for one of the chosen times, to workspaces whose active workflows listen
 * for it. One event per conversation, last message and time (the dedupe key), so a later message starts the count again and nothing repeats.
 */
export async function announceIdleConversations(db: Queryable, now = new Date()): Promise<number> {
  const orgs = await db.query<{ id: string; name: string; timezone: string }>(
    `select distinct o.id, o.name, o.timezone from organizations o join crm_workflows w on w.org_id = o.id and w.status = 'active'
       join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
     where o.kind = 'client' and o.status not in ('suspended', 'archived') and v.trigger_config->>'type' = 'conversation.idle'`,
  );
  let announced = 0;
  for (const org of orgs.rows) {
    const wanted = new Set<number>();
    for (const v of await activeVersionsFor(db, org.id, "conversation.idle")) for (const h of v.trigger_config.filters?.idleHours ?? []) wanted.add(h);
    for (const hours of CONVERSATION_IDLE_HOURS.filter((h) => wanted.has(h))) {
      const { rows } = await db.query<{ id: string; contact_id: string; channel: string; last_message_at: Date }>(
        `select id, contact_id, channel, last_message_at from conversations
         where org_id = $1 and status <> 'closed' and archived_at is null and last_message_at is not null
           and last_message_at <= $2::timestamptz - ($3 || ' hours')::interval and last_message_at > $2::timestamptz - ($4 || ' hours')::interval
         order by last_message_at limit $5`,
        [org.id, now.toISOString(), String(hours), String(hours + idleWindowHours(hours)), SCAN_LIMIT],
      );
      for (const c of rows) {
        const r = await emitEvent(db, systemActor(org), {
          type: "conversation.idle",
          entityType: "conversation",
          entityId: c.id,
          contactId: c.contact_id,
          payload: { conversationId: c.id, channel: c.channel, idleHours: hours },
          dedupeKey: `conversation.idle:${c.id}:${hours}:${new Date(c.last_message_at).getTime()}`,
        });
        if (r.id !== null) announced += 1;
      }
    }
  }
  return announced;
}

/** The scheduled entry point: both scans, each isolated by its own transaction. Returns how many notices and events it produced. */
export async function scanInboxAttention(now = new Date()): Promise<{ notified: number; idle: number }> {
  // With the inbox switched off (INBOX_DISABLED) nobody can open the conversation a notice points to, so no notice is raised. "Went quiet" is an event for
  // workflows, not a screen, and keeps being announced.
  const notified = inboxEnabled() ? await withSystem((db) => notifyAwaitingReplies(db, now)) : 0;
  const idle = await withSystem((db) => announceIdleConversations(db, now));
  return { notified, idle };
}
