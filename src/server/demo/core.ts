import "server-only";
import type { Queryable } from "@/server/db";
import { hashIp } from "@/server/security/crypto";
import type { DemoActor, DemoEventKind } from "@/lib/demo/events";
import type { ProspectFacts, ProspectStatus } from "@/lib/demo/rules";

// What every part of the demo funnel shares: the shape of a prospect's row, how it becomes the facts the pure rules read, and how an entry is added to the timeline.
//
// A prospect is never a user. Nothing in src/server/demo writes users, organizations, memberships, invitations or sign-in rows; the one door out is convertProspect (admin.ts), which
// a Super Admin opens on purpose and which calls createClientTenant like any other creation of a client.

export interface ProspectRow {
  id: string;
  access_request_id: string | null;
  name: string | null;
  work_email: string | null;
  email_normalized: string | null;
  business_name: string | null;
  industry: string | null;
  status: ProspectStatus;
  verified_at: Date | null;
  window_ends_at: Date | null;
  extended_hours: number;
  extended_count: number;
  message_limit: number;
  extra_messages: number;
  messages_used: number;
  message_seq: number;
  last_seen_at: Date | null;
  ip_hash: string | null;
  utm: Record<string, string>;
  consent_at: Date | null;
  consent_version: string | null;
  marketing_opt_in: boolean;
  consultation_requested_at: Date | null;
  consultation_done_at: Date | null;
  purchase_started_at: Date | null;
  converted_org_id: string | null;
  converted_at: Date | null;
  conversion_claimed_at: Date | null;
  conversion_claimed_by: string | null;
  owner_user_id: string | null;
  erased_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const PROSPECT_COLUMNS = `p.id, p.access_request_id, p.name, p.work_email, p.email_normalized, p.business_name, p.industry, p.status, p.verified_at, p.window_ends_at, p.extended_hours,
  p.extended_count, p.message_limit, p.extra_messages, p.messages_used, p.message_seq, p.last_seen_at, p.ip_hash, p.utm, p.consent_at, p.consent_version, p.marketing_opt_in,
  p.consultation_requested_at, p.consultation_done_at, p.purchase_started_at, p.converted_org_id, p.converted_at, p.conversion_claimed_at, p.conversion_claimed_by, p.owner_user_id,
  p.erased_at, p.created_at, p.updated_at`;

const asDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

export function factsOf(p: ProspectRow): ProspectFacts {
  return {
    status: p.status,
    verifiedAt: asDate(p.verified_at),
    windowEndsAt: asDate(p.window_ends_at),
    messageLimit: p.message_limit,
    extraMessages: p.extra_messages,
    messagesUsed: p.messages_used,
    erasedAt: asDate(p.erased_at),
    consultationRequestedAt: asDate(p.consultation_requested_at),
    purchaseStartedAt: asDate(p.purchase_started_at),
  };
}

/** One prospect's row, locked until the transaction ends. Everything that changes a prospect starts here, so two changes to one prospect never interleave. */
export async function lockProspect(db: Queryable, id: string): Promise<ProspectRow | null> {
  return (await db.query<ProspectRow>(`select ${PROSPECT_COLUMNS} from demo_prospects p where p.id = $1 for update`, [id])).rows[0] ?? null;
}

export async function loadProspect(db: Queryable, id: string): Promise<ProspectRow | null> {
  return (await db.query<ProspectRow>(`select ${PROSPECT_COLUMNS} from demo_prospects p where p.id = $1`, [id])).rows[0] ?? null;
}

/**
 * Adds a line to the prospect's timeline. The detail holds numbers, switches and fixed words, plus text a staff member typed (a note, a reason) under the keys an erasure
 * removes; it never holds a prospect's name, address or message.
 */
export async function addEvent(db: Queryable, prospectId: string, kind: DemoEventKind, actor: DemoActor, detail: Record<string, unknown> = {}, at?: Date): Promise<void> {
  await db.query(
    "insert into demo_events (prospect_id, kind, actor_kind, actor_id, detail, at) values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()))",
    [prospectId, kind, actor.kind, actor.kind === "user" ? actor.id : null, JSON.stringify(detail), at ? at.toISOString() : null],
  );
}

/** The UTC day a moment belongs to, which is what the platform's daily counters are keyed by. */
export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** The keyed hash of a network address (or "unknown"), used for rate limits and abuse analysis only. */
export const addressKey = (ip: string | null | undefined): string => hashIp(ip) ?? "unknown";

/** A keyed hash of a mailbox, so a rate limit can count a mailbox without storing it. */
export const mailboxKey = (normalized: string): string => hashIp(`mailbox:${normalized}`) ?? "unknown";

/** "j***@example.com": enough for the person to recognise the address they typed, not enough for anyone else to learn it. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
