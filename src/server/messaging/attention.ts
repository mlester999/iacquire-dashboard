import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { emitEvent } from "@/server/crm/events";
import { systemActor } from "@/server/crm/actor";
import { activeVersionsFor } from "@/server/crm/workflows/triggers";
import { customerUnreachable } from "@/server/messaging/inbox-list";
import { inboxEnabled } from "@/server/messaging/inbox-switch";
import { rolloutOnSql } from "@/server/messaging/inbox-rollout";
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
  /** How many customers are waiting in this workspace in all (the rows read are at most the notice cap of them). */
  org_total: number;
}

/**
 * Customers waiting for a reply for at least AWAITING_REPLY_MINUTES (and less than a day): the owner or assignee hears, else the owners and managers.
 * Each workspace contributes at most AWAITING_NOTICE_CAP rows, oldest first, and the rows are taken a workspace at a time (every workspace's oldest before
 * any workspace's second), so one workspace with a large backlog cannot use up the scan and leave the others unheard. `orgId` limits the scan to one workspace.
 */
export async function notifyAwaitingReplies(db: Queryable, now = new Date(), opts: { orgId?: string; limit?: number } = {}): Promise<number> {
  const { rows } = await db.query<WaitingRow>(
    `select w.id, w.org_id, w.owner_user_id, w.assigned_user_id, w.last_inbound_at, w.org_total
     from (
       select c.id, c.org_id, c.owner_user_id, c.assigned_user_id, c.last_inbound_at,
              row_number() over (partition by c.org_id order by c.last_inbound_at) as rn,
              (count(*) over (partition by c.org_id))::int as org_total
       from conversations c join organizations o on o.id = c.org_id and o.status not in ('suspended', 'archived')
       where c.status <> 'closed' and c.archived_at is null and c.unread_count > 0 and c.last_inbound_at is not null
         and c.last_inbound_at <= $1::timestamptz - ($2 || ' minutes')::interval and c.last_inbound_at > $1::timestamptz - ($3 || ' hours')::interval
         and (c.last_outbound_at is null or c.last_outbound_at < c.last_inbound_at)
         and not ${customerUnreachable("c")}
         and ${rolloutOnSql("c")}
         and ($4::uuid is null or c.org_id = $4::uuid)
     ) w
     where w.rn <= $5
     order by w.rn, w.last_inbound_at limit $6`,
    [now.toISOString(), String(AWAITING_REPLY_MINUTES), String(AWAITING_MAX_AGE_HOURS), opts.orgId ?? null, AWAITING_NOTICE_CAP, opts.limit ?? SCAN_LIMIT],
  );
  let sent = 0;
  const totals = new Map<string, number>();
  for (const c of rows) {
    const key = `awaiting:${c.id}:${new Date(c.last_inbound_at).getTime()}`;
    totals.set(c.org_id, c.org_total);
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
  for (const [orgId, n] of totals) {
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
export async function announceIdleConversations(db: Queryable, now = new Date(), orgId?: string): Promise<number> {
  const orgs = await db.query<{ id: string; name: string; timezone: string }>(
    `select distinct o.id, o.name, o.timezone from organizations o join crm_workflows w on w.org_id = o.id and w.status = 'active'
       join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
       join inbox_rollout ir on ir.org_id = o.id and ir.enabled
     where o.kind = 'client' and o.status not in ('suspended', 'archived') and v.trigger_config->>'type' = 'conversation.idle'
       and ($1::uuid is null or o.id = $1::uuid)`,
    [orgId ?? null],
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

/** Workspaces that have the new inbox, which are the only ones either scan reads. */
const rolloutOrgIds = (db: Queryable) =>
  db
    .query<{ org_id: string }>("select r.org_id from inbox_rollout r join organizations o on o.id = r.org_id and o.status not in ('suspended', 'archived') where r.enabled order by r.org_id")
    .then((r) => r.rows.map((x) => x.org_id));

/**
 * Runs one scan for every workspace in a single transaction, the cheap way. If that fails, one workspace's data is the likely cause and, because the
 * transaction rolled back whole, nobody was served: so it is redone one workspace at a time, each in its own transaction, so that the others still are.
 * The workspaces that still fail are added to `failed`.
 */
async function isolated(failed: string[], all: (db: Queryable) => Promise<number>, one: (db: Queryable, orgId: string) => Promise<number>): Promise<number> {
  try {
    return await withSystem(all);
  } catch {
    let served = 0;
    for (const orgId of await withSystem(rolloutOrgIds)) {
      try {
        served += await withSystem((db) => one(db, orgId));
      } catch {
        failed.push(orgId);
      }
    }
    return served;
  }
}

/**
 * The scheduled entry point: both scans. One workspace's trouble does not stop the others (see `isolated`); after everyone has been served the run
 * throws, naming the workspaces (ids only, never customer detail), so the scheduler records the failure and tries again, and everything already
 * done is kept and not repeated (every notice and event is keyed). Returns how many notices and events it produced.
 */
export async function scanInboxAttention(now = new Date()): Promise<{ notified: number; idle: number }> {
  const failed: string[] = [];
  // With the inbox switched off (INBOX_DISABLED) nobody can open the conversation a notice points to, so no notice is raised. "Went quiet" is an event for
  // workflows, not a screen, and keeps being announced.
  const notified = inboxEnabled() ? await isolated(failed, (db) => notifyAwaitingReplies(db, now), (db, orgId) => notifyAwaitingReplies(db, now, { orgId })) : 0;
  const idle = await isolated(failed, (db) => announceIdleConversations(db, now), (db, orgId) => announceIdleConversations(db, now, orgId));
  if (failed.length) {
    const ids = [...new Set(failed)];
    throw new Error(`The inbox attention scan failed for ${ids.length} workspace${ids.length === 1 ? "" : "s"} (${ids.join(", ")}); the others were served.`);
  }
  return { notified, idle };
}
