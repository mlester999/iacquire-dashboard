import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { PlatformRole } from "@/lib/permissions";
import { NO_CAPS, type Caps, type ChannelVisibility, type ConversationFacts, type ConversationKind, type MemberRole, type Standing } from "@/lib/staff-messages/conversations";
import { isUserId } from "@/lib/staff-messages/direct";

// Every staff Messages request starts here. Nothing the browser sent is trusted and nothing from the session is trusted beyond who it names: the person's standing (still
// active, still the same agency role, holding the permission, the module switched on) is read from the database on every request, and so is their membership of the
// conversation. A person who is demoted, disabled or denied the permission is therefore out on their very next request, whatever their session or an open page says.

export type AgencyRole = "agency_staff" | "agency_manager" | "agency_super_admin";

/** The part of a session this module needs. */
export interface StaffUser {
  id: string;
  platformRole: PlatformRole;
}

export interface StaffActor {
  userId: string;
  role: AgencyRole;
  /** The name other people see for them. */
  name: string;
  caps: Caps;
  /** The one agency workspace every row of staff Messages belongs to. */
  agencyOrgId: string;
}

export const NOT_ENABLED_MESSAGE = "Staff Messages is not switched on yet. A Super Admin can switch it on.";
export const AUTHORIZATION_CHANGED_MESSAGE = "Agency access is required; authorization has changed.";
const NOT_FOUND = "That conversation was not found.";

interface StandingRow {
  active: boolean;
  platform_role: string;
  name: string;
  can_use: boolean;
  can_channels: boolean;
  can_moderate: boolean;
  agency_org: string | null;
  enabled: boolean;
}

/**
 * The person's current standing, read in one statement. Throws forbidden when they are not an active agency account of the role their session says (the session is stale),
 * not_enabled when the module is off, unavailable when the agency workspace does not exist, and forbidden when they may not use Messages.
 */
export async function loadStaffActor(user: StaffUser, db?: Queryable): Promise<StaffActor> {
  if (!isUserId(user.id)) throw new AppError("forbidden", AUTHORIZATION_CHANGED_MESSAGE);
  const run = (q: Queryable) =>
    q.query<StandingRow>(
      `select u.status = 'active' as active, u.platform_role,
              coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) as name,
              coalesce(app.user_has_agency_permission(u.id, 'agency.messages.use'), false) as can_use,
              coalesce(app.user_has_agency_permission(u.id, 'agency.messages.channels'), false) as can_channels,
              coalesce(app.user_has_agency_permission(u.id, 'agency.messages.moderate'), false) as can_moderate,
              (select o.id from organizations o where o.kind = 'agency') as agency_org,
              exists (select 1 from org_features f join organizations o on o.id = f.org_id where o.kind = 'agency' and f.feature = 'staff_messages' and f.enabled) as enabled
         from users u where u.id = $1`,
      [user.id],
    );
  const { rows } = db ? await run(db) : await withSystem(run);
  const row = rows[0];
  if (!row?.active || row.platform_role === "none" || row.platform_role !== user.platformRole) throw new AppError("forbidden", AUTHORIZATION_CHANGED_MESSAGE);
  if (!row.enabled) throw new AppError("not_enabled", NOT_ENABLED_MESSAGE);
  if (!row.agency_org) throw new AppError("unavailable", "The agency workspace does not exist yet, so there is nowhere to keep messages.");
  if (!row.can_use) throw new AppError("forbidden", "Your agency role does not allow Messages.");
  return {
    userId: user.id,
    role: row.platform_role as AgencyRole,
    name: row.name,
    caps: { use: true, channels: row.can_channels, moderate: row.can_moderate },
    agencyOrgId: row.agency_org,
  };
}

/** Like loadStaffActor, and the person must also hold the permission named. A missing one reads as forbidden in words that say which. */
export async function requireStaffCap(user: StaffUser, cap: "channels" | "moderate", db?: Queryable): Promise<StaffActor> {
  const actor = await loadStaffActor(user, db);
  if (!actor.caps[cap]) throw new AppError("forbidden", cap === "channels" ? "Creating and running channels needs the Messages channels permission." : "Moderating channels needs the Messages moderation permission.");
  return actor;
}

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  visibility: ChannelVisibility;
  archived: boolean;
  name: string | null;
  topic: string | null;
  directKey: string | null;
  createdBy: string | null;
  lastSeq: number;
  lastMessageAt: string | null;
  memberRole: MemberRole | null;
  lastReadSeq: number;
  muted: boolean;
  notify: "all" | "mentions" | "none";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

interface RawConversation {
  id: string;
  kind: ConversationKind;
  visibility: ChannelVisibility;
  archived: boolean;
  name: string | null;
  topic: string | null;
  direct_key: string | null;
  created_by: string | null;
  last_seq: string;
  last_message_at: Date | string | null;
  member_role: MemberRole | null;
  last_read_seq: string | null;
  muted: boolean | null;
  notify: "all" | "mentions" | "none" | null;
}

/**
 * A conversation and the person's place in it, read from the database for an action (not under the person's row-level security: the caller has just checked who they are).
 * A conversation the person is not in reads as not found, so a guessed id never confirms that it exists, with one exception: an open channel, which anyone who may use
 * Messages can already find in the directory and join. `lock` takes the conversation's row for the rest of the transaction (writers to one conversation take turns).
 */
export async function loadConversation(db: Queryable, actor: Pick<StaffActor, "userId">, conversationId: unknown, opts: { lock?: boolean } = {}): Promise<ConversationRow> {
  if (!isId(conversationId)) throw new AppError("not_found", NOT_FOUND);
  const { rows } = await db.query<RawConversation>(
    `select c.id, c.kind, c.visibility, c.archived_at is not null as archived, c.name, c.topic, c.direct_key, c.created_by, c.last_seq::text as last_seq, c.last_message_at,
            m.role as member_role, m.last_read_seq::text as last_read_seq, m.muted, m.notify
       from staff_conversations c
       left join staff_conversation_members m on m.conversation_id = c.id and m.user_id = $2 and m.left_at is null
      where c.id = $1 ${opts.lock ? "for update of c" : ""}`,
    [conversationId, actor.userId],
  );
  const c = rows[0];
  if (!c) throw new AppError("not_found", NOT_FOUND);
  const open = c.kind === "channel" && c.visibility === "staff" && !c.archived;
  if (!c.member_role && !open) throw new AppError("not_found", NOT_FOUND);
  return {
    id: c.id,
    kind: c.kind,
    visibility: c.visibility,
    archived: c.archived,
    name: c.name,
    topic: c.topic,
    directKey: c.direct_key,
    createdBy: c.created_by,
    lastSeq: Number(c.last_seq),
    lastMessageAt: c.last_message_at ? new Date(c.last_message_at).toISOString() : null,
    memberRole: c.member_role,
    lastReadSeq: Number(c.last_read_seq ?? 0),
    muted: c.muted === true,
    notify: c.notify ?? "all",
  };
}

export const factsOf = (c: Pick<ConversationRow, "kind" | "visibility" | "archived">): ConversationFacts => ({ kind: c.kind, visibility: c.visibility, archived: c.archived });
export const standingOf = (actor: Pick<StaffActor, "caps">, c: Pick<ConversationRow, "memberRole">): Standing => ({ caps: actor.caps ?? NO_CAPS, memberRole: c.memberRole });

/** For a conversation the person must be able to read right now (not merely find). */
export async function loadReadableConversation(db: Queryable, actor: StaffActor, conversationId: unknown, opts: { lock?: boolean } = {}): Promise<ConversationRow> {
  const c = await loadConversation(db, actor, conversationId, opts);
  if (!c.memberRole) throw new AppError("not_found", NOT_FOUND);
  return c;
}

/** People who could be added to a conversation: active agency accounts that hold the permission. Anyone else is refused. */
export async function assertEligible(db: Queryable, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const { rows } = await db.query<{ id: string }>(
    `select u.id from users u
      where u.id = any($1::uuid[]) and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
        and coalesce(app.user_has_agency_permission(u.id, 'agency.messages.use'), false)`,
    [ids],
  );
  if (rows.length !== new Set(ids).size) throw new AppError("invalid_input", "Someone you chose is not on the agency team or cannot use Messages.");
}

export interface PersonName {
  name: string;
  /** True for a person who is no longer an active agency account: the screens say "Former team member". */
  former: boolean;
}

export const FORMER_NAME = "Former team member";

/**
 * Names for people who appear in conversations the caller has already been allowed to read (authors, members, people who reacted). Only a name and whether the person is
 * still on the team: never an address. A person who left (or whose account stopped being agency staff) is shown as a former team member, not by name.
 */
export async function namesFor(db: Queryable, ids: readonly (string | null)[]): Promise<Map<string, PersonName>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && isUserId(id)))];
  const out = new Map<string, PersonName>();
  if (!wanted.length) return out;
  const { rows } = await db.query<{ id: string; name: string; current: boolean }>(
    `select u.id, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) as name,
            (u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')) as current
       from users u where u.id = any($1::uuid[])`,
    [wanted],
  );
  for (const r of rows) out.set(r.id, r.current ? { name: r.name, former: false } : { name: FORMER_NAME, former: true });
  return out;
}

export const nameOrFormer = (names: Map<string, PersonName>, id: string | null): PersonName => (id ? (names.get(id) ?? { name: FORMER_NAME, former: true }) : { name: FORMER_NAME, former: true });
