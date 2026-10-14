import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { CHANNELS, identityKind, type Channel } from "@/lib/messaging";
import type { OrgContext } from "@/server/tenancy/context";

export type ConsentPurpose = "service" | "marketing";
export type ConsentState = "granted" | "revoked" | "unknown";

export interface ResolveContactInput {
  orgId: string;
  channel: Channel;
  /** Already normalized: E.164 for phone channels, lower-case for email. */
  address: string;
  name?: string;
  source?: string;
  ghlContactId?: string | null;
  verifiedVia?: "provider_inbound" | "customer_confirmed" | "staff_confirmed" | "crm_import";
}

/**
 * Finds the contact that owns this exact identifier, or creates one. Names are never used to match, so two people
 * called "Maria Santos" stay separate until a person merges them.
 */
export async function resolveContact(db: Queryable, input: ResolveContactInput): Promise<{ contactId: string; created: boolean }> {
  const kind = identityKind(input.channel);
  const found = await db.query<{ contact_id: string }>(
    `select i.contact_id from contact_identities i join contacts c on c.id = i.contact_id and c.org_id = i.org_id
     where i.org_id = $1 and i.kind = $2 and i.value = $3 and c.deleted_at is null`,
    [input.orgId, kind, input.address],
  );
  if (found.rows[0]) return { contactId: found.rows[0].contact_id, created: false };
  const { rows } = await db.query<{ id: string }>(
    `insert into contacts (org_id, display_name, email, phone, source, ghl_contact_id)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [input.orgId, (input.name ?? "").trim().slice(0, 200), kind === "email" ? input.address : null, kind === "phone" ? input.address : null, input.source ?? "inbound_message", input.ghlContactId ?? null],
  );
  // A number that texted us is proven by the carrier. An email's sender is easy to forge, so inbound email starts unverified;
  // only the customer or a person confirming it, or a CRM import, verifies it.
  const via = input.verifiedVia;
  const verified = Boolean(via) && !(kind === "email" && via === "provider_inbound");
  await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified, verified_via) values ($1, $2, $3, $4, $5, $6)", [
    input.orgId,
    rows[0].id,
    kind,
    input.address,
    verified,
    verified ? via : null,
  ]);
  return { contactId: rows[0].id, created: true };
}

export async function getConsent(db: Queryable, orgId: string, contactId: string, channel: Channel, purpose: ConsentPurpose): Promise<ConsentState> {
  const { rows } = await db.query<{ status: "granted" | "revoked" }>(
    "select status from contact_consent_events where org_id = $1 and contact_id = $2 and channel = $3 and purpose = $4 order by id desc limit 1",
    [orgId, contactId, channel, purpose],
  );
  return rows[0]?.status ?? "unknown";
}

export async function recordConsent(
  db: Queryable,
  e: { orgId: string; contactId: string; channel: Channel; purpose: ConsentPurpose; status: "granted" | "revoked"; source: string; evidence?: string; recordedBy?: string | null },
) {
  await db.query(
    "insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source, evidence, recorded_by) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [e.orgId, e.contactId, e.channel, e.purpose, e.status, e.source.slice(0, 60), e.evidence?.slice(0, 500) ?? null, e.recordedBy ?? null],
  );
}

export async function suppressAddress(db: Queryable, e: { orgId: string; channel: Channel; address: string; reason: "opt_out" | "bounce" | "complaint" | "invalid" | "manual"; source: string; createdBy?: string | null }) {
  await db.query(
    `insert into suppressions (org_id, channel, address, reason, source, created_by) values ($1, $2, $3, $4, $5, $6)
     on conflict (org_id, channel, address) do update set reason = excluded.reason, source = excluded.source, created_by = excluded.created_by, created_at = now(), lifted_at = null, lifted_by = null`,
    [e.orgId, e.channel, e.address, e.reason, e.source.slice(0, 60), e.createdBy ?? null],
  );
}

export async function liftSuppression(db: Queryable, e: { orgId: string; channel: Channel; address: string; liftedBy?: string | null }) {
  await db.query("update suppressions set lifted_at = now(), lifted_by = $4 where org_id = $1 and channel = $2 and address = $3 and lifted_at is null", [e.orgId, e.channel, e.address, e.liftedBy ?? null]);
}

export async function isSuppressed(db: Queryable, orgId: string, channel: Channel, address: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from suppressions where org_id = $1 and channel = $2 and address = $3 and lifted_at is null", [orgId, channel, address]);
  return rows.length > 0;
}

/** The address a message on this channel would go to, from the contact's identities. */
export async function contactAddress(db: Queryable, orgId: string, contactId: string, channel: Channel): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>("select value from contact_identities where org_id = $1 and contact_id = $2 and kind = $3 order by verified desc, created_at limit 1", [orgId, contactId, identityKind(channel)]);
  return rows[0]?.value ?? null;
}

/**
 * Merges two contacts into one. A person decides and the reason is recorded. Everything moves to the kept contact, consent
 * keeps the most restrictive answer for each channel, and the merged record is soft-deleted with a snapshot so it can be audited.
 */
export async function mergeContacts(ctx: OrgContext, input: { keptId: string; mergedId: string; reason: string }) {
  if (!ctx.can("contacts.merge")) throw new AppError("forbidden", "Only owners and managers can merge contacts.");
  if (input.keptId === input.mergedId) throw new AppError("invalid_input", "Choose two different contacts.");
  if (input.reason.trim().length < 5) throw new AppError("invalid_input", "Record why these are the same person.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; display_name: string; email: string | null; phone: string | null; deleted_at: Date | null }>(
      "select id, display_name, email::text as email, phone, deleted_at from contacts where org_id = $1 and id = any($2::uuid[]) for update",
      [ctx.org.orgId, [input.keptId, input.mergedId]],
    );
    const kept = rows.find((r) => r.id === input.keptId);
    const merged = rows.find((r) => r.id === input.mergedId);
    if (!kept || !merged || kept.deleted_at || merged.deleted_at) throw new AppError("not_found", "Contact not found.");

    const identities = await db.query<{ kind: string; value: string; verified: boolean }>("select kind, value, verified from contact_identities where org_id = $1 and contact_id = $2", [ctx.org.orgId, merged.id]);
    const conversations = await db.query<{ id: string; channel: Channel; thread_key: string }>("select id, channel, thread_key from conversations where org_id = $1 and contact_id = $2", [ctx.org.orgId, merged.id]);
    await db.query(
      "insert into contact_merges (org_id, kept_contact_id, merged_contact_id, merged_by, reason, snapshot) values ($1, $2, $3, $4, $5, $6)",
      [ctx.org.orgId, kept.id, merged.id, ctx.user.id, input.reason.trim().slice(0, 500), JSON.stringify({ merged: { displayName: merged.display_name, email: merged.email, phone: merged.phone }, identities: identities.rows.length, conversations: conversations.rows.length })],
    );

    // Consent: the most restrictive answer wins per channel and purpose.
    for (const channel of CHANNELS) {
      for (const purpose of ["service", "marketing"] as const) {
        const [a, b] = await Promise.all([getConsent(db, ctx.org.orgId, kept.id, channel, purpose), getConsent(db, ctx.org.orgId, merged.id, channel, purpose)]);
        if (b === "revoked" && a !== "revoked") await recordConsent(db, { orgId: ctx.org.orgId, contactId: kept.id, channel, purpose, status: "revoked", source: "contact_merge", evidence: "Merged record had opted out", recordedBy: ctx.user.id });
        else if (b === "granted" && a === "unknown") await recordConsent(db, { orgId: ctx.org.orgId, contactId: kept.id, channel, purpose, status: "granted", source: "contact_merge", recordedBy: ctx.user.id });
      }
    }

    await db.query("update contact_identities set contact_id = $3 where org_id = $1 and contact_id = $2", [ctx.org.orgId, merged.id, kept.id]);
    await db.query("update contact_memories set contact_id = $3 where org_id = $1 and contact_id = $2", [ctx.org.orgId, merged.id, kept.id]);
    await db.query("update follow_up_plans set status = 'cancelled', cancel_reason = 'contact_merged', closed_at = now() where org_id = $1 and contact_id = $2 and status = 'active'", [ctx.org.orgId, merged.id]);
    for (const conv of conversations.rows) {
      const twin = await db.query<{ id: string }>("select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and thread_key = $4", [ctx.org.orgId, kept.id, conv.channel, conv.thread_key]);
      if (twin.rows[0]) {
        // Same channel thread on both: fold the messages into the kept conversation.
        await db.query("update conversation_messages set conversation_id = $3 where org_id = $1 and conversation_id = $2", [ctx.org.orgId, conv.id, twin.rows[0].id]);
        await db.query("update human_escalations set conversation_id = $3, contact_id = $4 where org_id = $1 and conversation_id = $2", [ctx.org.orgId, conv.id, twin.rows[0].id, kept.id]);
        await db.query("update follow_up_plans set conversation_id = $3, contact_id = $4 where org_id = $1 and conversation_id = $2", [ctx.org.orgId, conv.id, twin.rows[0].id, kept.id]);
        await db.query("delete from conversations where org_id = $1 and id = $2", [ctx.org.orgId, conv.id]);
        await db.query(
          `update conversations c set last_message_at = s.last_at, last_inbound_at = s.last_in, last_outbound_at = s.last_out
           from (select max(created_at) as last_at, max(created_at) filter (where direction = 'inbound') as last_in,
                        max(created_at) filter (where direction = 'outbound') as last_out
                 from conversation_messages where conversation_id = $1) s where c.id = $1`,
          [twin.rows[0].id],
        );
      } else {
        await db.query("update conversations set contact_id = $3 where org_id = $1 and id = $2", [ctx.org.orgId, conv.id, kept.id]);
        await db.query("update human_escalations set contact_id = $3 where org_id = $1 and conversation_id = $2", [ctx.org.orgId, conv.id, kept.id]);
        await db.query("update follow_up_plans set contact_id = $3 where org_id = $1 and conversation_id = $2", [ctx.org.orgId, conv.id, kept.id]);
      }
    }
    await db.query(
      `update contacts set email = coalesce(email, $3::citext), phone = coalesce(phone, $4), display_name = case when display_name = '' then $5 else display_name end where org_id = $1 and id = $2`,
      [ctx.org.orgId, kept.id, merged.email, merged.phone, merged.display_name],
    );
    await db.query("update contacts set deleted_at = now(), email = null, phone = null, ghl_contact_id = null where org_id = $1 and id = $2", [ctx.org.orgId, merged.id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "contact.merged", targetType: "contact", targetId: kept.id, result: "success", metadata: { mergedContactId: merged.id } }, db);
    return { keptId: kept.id };
  });
}

/** Privacy request: removes personal details and identifiers, keeps non-identifying counts and the audit trail. */
export async function redactContact(ctx: OrgContext, contactId: string, reason: string) {
  if (!ctx.can("consent.manage")) throw new AppError("forbidden", "Only owners and managers can process privacy requests.");
  if (reason.trim().length < 5) throw new AppError("invalid_input", "Record the request this is fulfilling.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from contacts where org_id = $1 and id = $2 and deleted_at is null for update", [ctx.org.orgId, contactId]);
    if (!rows[0]) throw new AppError("not_found", "Contact not found.");
    const ids = await db.query<{ kind: string; value: string }>("select kind, value from contact_identities where org_id = $1 and contact_id = $2", [ctx.org.orgId, contactId]);
    // Keep the opt-out so a deleted person is never contacted again on an address they opted out of.
    await db.query("update follow_up_plans set status = 'cancelled', cancel_reason = 'privacy_request', closed_at = now() where org_id = $1 and contact_id = $2 and status = 'active'", [ctx.org.orgId, contactId]);
    await db.query("update conversation_messages set body = '[removed on request]', attachments = '[]'::jsonb where org_id = $1 and conversation_id in (select id from conversations where org_id = $1 and contact_id = $2)", [ctx.org.orgId, contactId]);
    await db.query("update conversations set last_message_preview = null, status = 'closed' where org_id = $1 and contact_id = $2", [ctx.org.orgId, contactId]);
    await db.query("delete from contact_identities where org_id = $1 and contact_id = $2", [ctx.org.orgId, contactId]);
    await db.query("update contact_memories set deleted_at = now() where org_id = $1 and contact_id = $2 and deleted_at is null", [ctx.org.orgId, contactId]);
    await db.query("update contacts set display_name = 'Removed contact', email = null, phone = null, ghl_contact_id = null, deleted_at = now() where org_id = $1 and id = $2", [ctx.org.orgId, contactId]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "contact.redacted", targetType: "contact", targetId: contactId, result: "success", metadata: { identifiers: ids.rows.length, reason } }, db);
    return { removedIdentifiers: ids.rows.length };
  });
}

export async function addMemory(ctx: OrgContext, input: { contactId: string; kind: "confirmed_fact" | "ai_summary"; content: string; sourceMessageId?: string | null }) {
  if (!ctx.can("contacts.edit")) throw new AppError("forbidden", "Your role can't edit contact records.");
  const content = input.content.trim();
  if (!content || content.length > 1000) throw new AppError("invalid_input", "Write between 1 and 1000 characters.");
  return withSystem(async (db) => {
    const owner = await db.query("select 1 from contacts where org_id = $1 and id = $2 and deleted_at is null", [ctx.org.orgId, input.contactId]);
    if (!owner.rows[0]) throw new AppError("not_found", "Contact not found.");
    const confirmed = input.kind === "confirmed_fact";
    // A confirmed fact is always attributed to the person who confirmed it.
    const { rows } = await db.query<{ id: string }>(
      `insert into contact_memories (org_id, contact_id, kind, content, source_message_id, created_by_kind, created_by, confirmed_by, confirmed_at)
       values ($1, $2, $3, $4, $5, 'human', $6, $7, $8) returning id`,
      [ctx.org.orgId, input.contactId, input.kind, content, input.sourceMessageId ?? null, ctx.user.id, confirmed ? ctx.user.id : null, confirmed ? new Date() : null],
    );
    return rows[0].id;
  });
}

export async function deleteMemory(ctx: OrgContext, memoryId: string) {
  if (!ctx.can("contacts.edit")) throw new AppError("forbidden", "Your role can't edit contact records.");
  const res = await withSystem((db) => db.query("update contact_memories set deleted_at = now() where org_id = $1 and id = $2 and deleted_at is null", [ctx.org.orgId, memoryId]));
  if (!res.rowCount) throw new AppError("not_found", "Note not found.");
}
