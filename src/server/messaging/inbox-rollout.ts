import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertInboxEnabled, inboxEnabled as inboxSwitchedOn } from "@/server/messaging/inbox-switch";
import { INBOX_NOT_ENABLED_MESSAGE } from "@/lib/inbox";
import type { SessionUser } from "@/server/auth/service";

// The Unified Inbox's per-workspace rollout. A workspace has the new inbox only when a Super Admin switched it on (table inbox_rollout, migration 0083);
// no row means off, and off is the default. The global emergency switch INBOX_DISABLED (inbox-switch.ts) overrides everything: with it on, no workspace has the new inbox.
//
// What the rollout controls, and what it never touches (docs/unified-inbox/workspace-rollout.md):
//   * It chooses which SCREEN a workspace gets: the new inbox, or the legacy one it had before (src/components/inbox/legacy-inbox-workspace.tsx).
//   * It gates what only the new inbox uses: /api/inbox/*, the new-only server actions, the inbox's notices and its scheduled scan, and publishing workflows
//     that use the conversation triggers and step.
//   * It does NOT gate receiving, storing, deduplicating or sending messages, the AI employees, the ownership fence or AI pause, consent and opt-outs, or any
//     provider write switch. Those behave the same for every workspace, so no rollout state can interrupt customer messaging, and switching a workspace
//     on never switches a provider on.

const TTL_MS = 3000;
const cache = new Map<string, { on: boolean; at: number }>();

/** Forgets what was read about a workspace (all of them without an id). A change made by this process is visible at once; another instance sees it within a few seconds. */
export function clearInboxRolloutCache(orgId?: string) {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

/** Whether a Super Admin switched the new inbox on for this workspace. Ignores the global switch. Pass `db` from inside a transaction (no nested connection, no cache). */
export async function workspaceInboxOn(orgId: string, db?: Queryable): Promise<boolean> {
  const read = async (q: Queryable) => (await q.query<{ enabled: boolean }>("select enabled from inbox_rollout where org_id = $1", [orgId])).rows[0]?.enabled === true;
  if (db) return read(db);
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
  const on = await withSystem(read);
  cache.set(orgId, { on, at: Date.now() });
  return on;
}

/** True when the new inbox is available to this workspace: not switched off globally, and switched on for the workspace. */
export async function inboxEnabledFor(orgId: string, db?: Queryable): Promise<boolean> {
  return inboxSwitchedOn() && (await workspaceInboxOn(orgId, db));
}

/** Which screen /inbox shows this workspace. The legacy screen is the fallback for both "not switched on" and "switched off globally". */
export async function inboxModeFor(orgId: string): Promise<"new" | "legacy"> {
  return (await inboxEnabledFor(orgId)) ? "new" : "legacy";
}

/**
 * Throws unless the new inbox is available to this workspace: 503 "unavailable" when it is switched off globally, 403 "not_enabled" when the workspace is
 * not part of the rollout. For the APIs and actions only the new inbox uses; the actions the legacy screen shares never call this.
 */
export async function assertInboxEnabledFor(orgId: string, db?: Queryable): Promise<void> {
  assertInboxEnabled();
  if (!(await workspaceInboxOn(orgId, db))) throw new AppError("not_enabled", INBOX_NOT_ENABLED_MESSAGE);
}

/** SQL for "this conversation's workspace has the new inbox": for the scheduled jobs that scan every workspace. `alias` is the conversations alias. */
export const rolloutOnSql = (alias: string) => `exists (select 1 from inbox_rollout ir where ir.org_id = ${alias}.org_id and ir.enabled)`;

// ---------------------------------------------------------------------------
// Super Admin controls
// ---------------------------------------------------------------------------

const BULK_ENABLE_MAX = 25;

function assertSuperAdmin(user: SessionUser) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can change the inbox rollout.");
}

export interface RolloutRow {
  orgId: string;
  name: string;
  kind: "agency" | "client";
  status: string;
  enabled: boolean;
  note: string | null;
  enabledAt: string | null;
  enabledByName: string | null;
  disabledAt: string | null;
  disabledByName: string | null;
  openConversations: number;
  liveChannels: number;
}

export async function listRollout(user: SessionUser): Promise<RolloutRow[]> {
  assertSuperAdmin(user);
  const { rows } = await withSystem((db) =>
    db.query<{
      id: string; name: string; kind: "agency" | "client"; status: string; enabled: boolean | null; note: string | null; enabled_at: Date | null; disabled_at: Date | null;
      enabled_by_name: string | null; disabled_by_name: string | null; open_conversations: number; live_channels: number;
    }>(
      `select o.id, o.name, o.kind, o.status, r.enabled, r.note, r.enabled_at, r.disabled_at, eu.full_name as enabled_by_name, du.full_name as disabled_by_name,
         (select count(*)::int from conversations c where c.org_id = o.id and c.status <> 'closed' and c.archived_at is null) as open_conversations,
         (select count(*)::int from messaging_channels m where m.org_id = o.id and m.enabled) as live_channels
       from organizations o left join inbox_rollout r on r.org_id = o.id
         left join users eu on eu.id = r.enabled_by left join users du on du.id = r.disabled_by
       where o.status <> 'archived'
       order by (o.kind = 'agency') desc, coalesce(r.enabled, false) desc, lower(o.name)`,
    ),
  );
  return rows.map((r) => ({
    orgId: r.id, name: r.name, kind: r.kind, status: r.status, enabled: r.enabled === true, note: r.note,
    enabledAt: r.enabled_at ? new Date(r.enabled_at).toISOString() : null, enabledByName: r.enabled_by_name,
    disabledAt: r.disabled_at ? new Date(r.disabled_at).toISOString() : null, disabledByName: r.disabled_by_name,
    openConversations: r.open_conversations, liveChannels: r.live_channels,
  }));
}

/** What is in flight in a workspace, so switching the inbox off is done knowing it. None of it is changed by switching the inbox off. */
export interface RolloutImpact {
  openConversations: number;
  aiOwned: number;
  aiPaused: number;
  openEscalations: number;
  queuedAiReplies: number;
  draftsAwaitingApproval: number;
  liveChannels: number;
}

export async function rolloutImpact(user: SessionUser, orgId: string): Promise<RolloutImpact> {
  assertSuperAdmin(user);
  return withSystem((db) => impactOf(db, orgId));
}

async function impactOf(db: Queryable, orgId: string): Promise<RolloutImpact> {
  const { rows } = await db.query<Record<string, number>>(
    `select
       (select count(*)::int from conversations where org_id = $1 and status <> 'closed' and archived_at is null) as open_conversations,
       (select count(*)::int from conversations where org_id = $1 and status <> 'closed' and owner_kind = 'ai') as ai_owned,
       (select count(*)::int from conversations where org_id = $1 and status <> 'closed' and ai_paused_at is not null) as ai_paused,
       (select count(*)::int from human_escalations where org_id = $1 and status in ('awaiting_owner', 'open', 'claimed')) as open_escalations,
       (select count(*)::int from conversation_messages where org_id = $1 and direction = 'outbound' and author_kind = 'ai' and status in ('queued', 'sending')) as queued_ai,
       (select count(*)::int from conversation_messages where org_id = $1 and status = 'draft') as drafts,
       (select count(*)::int from messaging_channels where org_id = $1 and enabled) as live_channels`,
    [orgId],
  );
  const r = rows[0];
  return {
    openConversations: r.open_conversations, aiOwned: r.ai_owned, aiPaused: r.ai_paused, openEscalations: r.open_escalations,
    queuedAiReplies: r.queued_ai, draftsAwaitingApproval: r.drafts, liveChannels: r.live_channels,
  };
}

export interface RolloutChange {
  orgId: string;
  enabled: boolean;
  /** False when the workspace was already in that state: nothing was written. */
  changed: boolean;
}

type Via = "single" | "bulk" | "disable_all";

async function applyChange(db: Queryable, user: SessionUser, input: { orgId: string; enabled: boolean; note?: string | null; via: Via }): Promise<RolloutChange> {
  const org = await db.query<{ id: string }>("select id from organizations where id = $1", [input.orgId]);
  if (!org.rows[0]) throw new AppError("not_found", "Workspace not found.");
  const before = (await db.query<{ enabled: boolean }>("select enabled from inbox_rollout where org_id = $1 for update", [input.orgId])).rows[0]?.enabled === true;
  if (before === input.enabled) return { orgId: input.orgId, enabled: input.enabled, changed: false };
  const note = input.note?.trim().slice(0, 200) || null;
  if (input.enabled) {
    await db.query(
      `insert into inbox_rollout (org_id, enabled, note, enabled_at, enabled_by) values ($1, true, $2, now(), $3)
       on conflict (org_id) do update set enabled = true, note = coalesce($2, inbox_rollout.note), enabled_at = now(), enabled_by = $3`,
      [input.orgId, note, user.id],
    );
  } else {
    await db.query("update inbox_rollout set enabled = false, note = coalesce($2, note), disabled_at = now(), disabled_by = $3 where org_id = $1", [input.orgId, note, user.id]);
  }
  // What was in flight when the inbox went off is written down with the change. It is read, not altered: queued replies, drafts and escalations carry on.
  const impact = input.enabled ? undefined : await impactOf(db, input.orgId);
  await recordAudit({
    orgId: input.orgId, actorUserId: user.id, actorKind: "agency", action: input.enabled ? "inbox.rollout_enabled" : "inbox.rollout_disabled",
    targetType: "workspace", targetId: input.orgId, result: "success", metadata: { via: input.via, note, ...(impact ? { inFlight: impact } : {}) },
  }, db);
  return { orgId: input.orgId, enabled: input.enabled, changed: true };
}

/** Switches the new inbox on or off for one workspace. Super Admin only; audited with who, when and (when switching off) what was in flight. */
export async function setWorkspaceRollout(user: SessionUser, input: { orgId: string; enabled: boolean; note?: string | null }): Promise<RolloutChange> {
  assertSuperAdmin(user);
  const out = await withSystem((db) => applyChange(db, user, { ...input, via: "single" }));
  clearInboxRolloutCache(input.orgId);
  return out;
}

/** The same for several workspaces at once, all in one transaction (all change or none do). At most 25 at a time when switching on; switching off has no limit. */
export async function setWorkspaceRolloutBulk(user: SessionUser, input: { orgIds: string[]; enabled: boolean; note?: string | null }): Promise<RolloutChange[]> {
  assertSuperAdmin(user);
  const ids = [...new Set(input.orgIds)];
  if (!ids.length) throw new AppError("invalid_input", "Choose at least one workspace.");
  if (input.enabled && ids.length > BULK_ENABLE_MAX) throw new AppError("invalid_input", `Switch on at most ${BULK_ENABLE_MAX} workspaces at a time, so a rollout stays gradual.`);
  const out = await withSystem(async (db) => {
    const changes: RolloutChange[] = [];
    for (const orgId of ids) changes.push(await applyChange(db, user, { orgId, enabled: input.enabled, note: input.note, via: "bulk" }));
    return changes;
  });
  for (const id of ids) clearInboxRolloutCache(id);
  return out;
}

/** The rollback control: switches the new inbox off for every workspace that has it, in one transaction. Nothing in flight is altered. */
export async function disableAllWorkspaces(user: SessionUser, note?: string | null): Promise<RolloutChange[]> {
  assertSuperAdmin(user);
  const out = await withSystem(async (db) => {
    const on = await db.query<{ org_id: string }>("select org_id from inbox_rollout where enabled for update");
    const changes: RolloutChange[] = [];
    for (const r of on.rows) changes.push(await applyChange(db, user, { orgId: r.org_id, enabled: false, note: note ?? "Rollout switched off for every workspace", via: "disable_all" }));
    return changes;
  });
  clearInboxRolloutCache();
  return out;
}
