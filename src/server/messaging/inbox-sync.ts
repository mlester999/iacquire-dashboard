import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { inboxViewCounts, type ViewCounts } from "@/server/messaging/inbox-list";
import { getConversationDetail, withDeliveryDetail, type ConversationDetail, type DeliveredMessageView } from "@/server/messaging/inbox";
import type { OrgContext } from "@/server/tenancy/context";

// Near-real-time sync by polling, on purpose. The browser asks "what changed since I last looked?"; the answer is a list of conversation ids with
// their revisions, read as the person (so a conversation they cannot see never shows up, not even as an id). The client then re-reads what it
// shows. Correctness does not depend on delivery: a missed poll, a duplicate, an out-of-order response or a tab that slept for an hour all end
// with the same state, because the client keeps the highest revision it has seen and a stale `since` simply falls back to a full refresh.

/** A client's `since` older than this is not trusted to be complete: it gets a full refresh instead. */
export const SYNC_WINDOW_MS = 24 * 3600_000;
/** More changes than this in one answer means "refresh everything" (the client would have to re-read most of its list anyway). */
export const SYNC_MAX_CHANGES = 300;

export interface SyncChange {
  id: string;
  revision: number;
}

export interface SyncResult {
  /** Database time at the start of the read. The next poll sends it back (minus the client's overlap) as `since`. */
  serverTime: string;
  /** True when the client must re-read its list: no usable `since`, too old, or too many changes. Then `changes` is empty. */
  full: boolean;
  changes: SyncChange[];
  counts?: ViewCounts;
}

export async function inboxSync(ctx: OrgContext, sinceIso: string | null, opts: { counts?: boolean } = {}): Promise<SyncResult> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  const parsed = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const since = Number.isNaN(parsed) || Date.now() - parsed > SYNC_WINDOW_MS || parsed > Date.now() + 60_000 ? null : new Date(parsed);
  const { serverTime, rows } = await withUser(ctx.user.id, async (db) => {
    const now = await db.query<{ t: Date }>("select now() as t");
    if (!since) return { serverTime: now.rows[0].t, rows: [] as Array<{ id: string; revision: string }> };
    // Two cheap indexed range reads: conversation rows touched, and messages inserted or moved to a new delivery status.
    const changed = await db.query<{ id: string; revision: string }>(
      `with touched as (
         select id from conversations where org_id = $1 and updated_at > $2
         union
         select conversation_id as id from conversation_messages where org_id = $1 and status_changed_at > $2
       )
       select c.id, c.revision::text as revision from conversations c join touched t on t.id = c.id where c.org_id = $1 limit $3`,
      [ctx.org.orgId, since.toISOString(), SYNC_MAX_CHANGES + 1],
    );
    return { serverTime: now.rows[0].t, rows: changed.rows };
  });
  const tooMany = rows.length > SYNC_MAX_CHANGES;
  const full = !since || tooMany;
  const changes = full ? [] : rows.map((r) => ({ id: r.id, revision: Number(r.revision) }));
  const wantCounts = opts.counts === true || full || changes.length > 0;
  return { serverTime: new Date(serverTime).toISOString(), full, changes, ...(wantCounts ? { counts: await inboxViewCounts(ctx) } : {}) };
}

/** What the thread view shows for one conversation: its detail with each message's provider and delivery events. Null when it cannot be opened. */
export type InboxThread = Omit<ConversationDetail, "messages"> & { messages: DeliveredMessageView[] };

export async function loadInboxThread(ctx: OrgContext, conversationId: string): Promise<InboxThread | null> {
  const detail = await getConversationDetail(ctx, conversationId).catch((err) => {
    // A conversation the person cannot see simply is not found; anything else is a real error and must not look like "not found".
    if (err instanceof AppError && (err.code === "not_found" || err.code === "forbidden")) return null;
    throw err;
  });
  if (!detail) return null;
  return { ...detail, messages: await withDeliveryDetail(ctx.user.id, detail.messages) };
}
