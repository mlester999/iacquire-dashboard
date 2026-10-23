import "server-only";
import { eraseRecoveryAndScoring } from "@/server/missed-calls/erasure";
import { eraseWebChatAndAttribution } from "@/server/webchat/retention";
import { eraseReputationRecords } from "@/server/reputation/erasure";
import { eraseInvoiceCustomerDetails } from "@/server/invoices/erasure";
import { eraseProposalsForContact } from "@/server/proposals/erase";
import { cancelRetention } from "@/server/retention/cancel";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { CHANNELS, identityKind, type Channel } from "@/lib/messaging";
import type { OrgContext } from "@/server/tenancy/context";
import type { CrmActor } from "@/server/crm/actor";
import type { Permission } from "@/lib/permissions";

/** Who is acting: a signed-in request context or a CRM actor (member, agency support session, system). */
interface Principal {
  orgId: string;
  userId: string | null;
  can: (p: Permission) => boolean;
  auditKind: "user" | "agency" | "agent" | "system";
}

function principalOf(who: OrgContext | CrmActor): Principal {
  if ("org" in who) return { orgId: who.org.orgId, userId: who.user.id, can: who.can, auditKind: "user" };
  return { orgId: who.orgId, userId: who.userId, can: who.can, auditKind: who.kind === "member" ? "user" : who.kind === "api" ? "system" : who.kind };
}

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
  /** How the record first arrived (contacts.created_via). Defaults from the source. */
  createdVia?: "inbound_message" | "website_form" | "form" | "booking" | "api" | "agent" | "workflow" | "call" | "import" | "ghl_migration";
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
  const createdVia = input.createdVia ?? (input.source === "website_form" ? "website_form" : "inbound_message");
  const { rows } = await db.query<{ id: string }>(
    `insert into contacts (org_id, display_name, email, phone, source, ghl_contact_id, created_via)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [input.orgId, (input.name ?? "").trim().slice(0, 200), kind === "email" ? input.address : null, kind === "phone" ? input.address : null, input.source ?? "inbound_message", input.ghlContactId ?? null, createdVia],
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

/**
 * The suppressions a customer's own opt-in keyword (START, UNSTOP …) may lift: their earlier opt-out, and a number the provider called invalid
 * that has now written to us. A bounce, a spam complaint or a person's do-not-contact entry ("manual") is never lifted by a keyword.
 */
export const KEYWORD_LIFTABLE_SUPPRESSIONS = ["opt_out", "invalid"] as const;

/** Lifts an address's suppression. With `reasons`, only a suppression recorded for one of those reasons is lifted. */
export async function liftSuppression(db: Queryable, e: { orgId: string; channel: Channel; address: string; liftedBy?: string | null; reasons?: readonly string[] }) {
  await db.query(
    "update suppressions set lifted_at = now(), lifted_by = $4 where org_id = $1 and channel = $2 and address = $3 and lifted_at is null and ($5::text[] is null or reason = any($5::text[]))",
    [e.orgId, e.channel, e.address, e.liftedBy ?? null, e.reasons ? [...e.reasons] : null],
  );
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
export async function mergeContacts(who: OrgContext | CrmActor, input: { keptId: string; mergedId: string; reason: string }) {
  const p = principalOf(who);
  if (!p.can("contacts.merge")) throw new AppError("forbidden", "Only owners and managers can merge contacts.");
  if (input.keptId === input.mergedId) throw new AppError("invalid_input", "Choose two different contacts.");
  if (input.reason.trim().length < 5) throw new AppError("invalid_input", "Record why these are the same person.");
  return withSystem((db) => mergeContactsInTx(db, p, input));
}

/** The merge itself, inside the caller's transaction (the CRM records its event in the same one). */
export async function mergeContactsInTx(db: Queryable, who: Principal | OrgContext | CrmActor, input: { keptId: string; mergedId: string; reason: string }) {
  const p = "auditKind" in who ? who : principalOf(who);
  const orgId = p.orgId;
  if (input.keptId === input.mergedId) throw new AppError("invalid_input", "Choose two different contacts.");
  const { rows } = await db.query<{ id: string; display_name: string; email: string | null; phone: string | null; deleted_at: Date | null }>(
    "select id, display_name, email::text as email, phone, deleted_at from contacts where org_id = $1 and id = any($2::uuid[]) for update",
    [orgId, [input.keptId, input.mergedId]],
  );
  const kept = rows.find((r) => r.id === input.keptId);
  const merged = rows.find((r) => r.id === input.mergedId);
  if (!kept || !merged || kept.deleted_at || merged.deleted_at) throw new AppError("not_found", "Contact not found.");

  const identities = await db.query<{ kind: string; value: string; verified: boolean }>("select kind, value, verified from contact_identities where org_id = $1 and contact_id = $2", [orgId, merged.id]);
  const conversations = await db.query<{ id: string; channel: Channel; thread_key: string }>("select id, channel, thread_key from conversations where org_id = $1 and contact_id = $2", [orgId, merged.id]);
  await db.query(
    "insert into contact_merges (org_id, kept_contact_id, merged_contact_id, merged_by, reason, snapshot) values ($1, $2, $3, $4, $5, $6)",
    [orgId, kept.id, merged.id, p.userId, input.reason.trim().slice(0, 500), JSON.stringify({ merged: { displayName: merged.display_name, email: merged.email, phone: merged.phone }, identities: identities.rows.length, conversations: conversations.rows.length })],
  );

  // Consent: the most restrictive answer wins per channel and purpose.
  for (const channel of CHANNELS) {
    for (const purpose of ["service", "marketing"] as const) {
      const [a, b] = await Promise.all([getConsent(db, orgId, kept.id, channel, purpose), getConsent(db, orgId, merged.id, channel, purpose)]);
      if (b === "revoked" && a !== "revoked") await recordConsent(db, { orgId, contactId: kept.id, channel, purpose, status: "revoked", source: "contact_merge", evidence: "Merged record had opted out", recordedBy: p.userId });
      else if (b === "granted" && a === "unknown") await recordConsent(db, { orgId, contactId: kept.id, channel, purpose, status: "granted", source: "contact_merge", recordedBy: p.userId });
    }
  }

  await db.query("update contact_identities set contact_id = $3 where org_id = $1 and contact_id = $2", [orgId, merged.id, kept.id]);
  await db.query("update contact_memories set contact_id = $3 where org_id = $1 and contact_id = $2", [orgId, merged.id, kept.id]);
  await db.query("update follow_up_plans set status = 'cancelled', cancel_reason = 'contact_merged', closed_at = now() where org_id = $1 and contact_id = $2 and status = 'active'", [orgId, merged.id]);
  for (const conv of conversations.rows) {
    const twin = await db.query<{ id: string }>("select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and thread_key = $4", [orgId, kept.id, conv.channel, conv.thread_key]);
    if (twin.rows[0]) {
      // Same channel thread on both: fold the messages into the kept conversation.
      await db.query("update conversation_messages set conversation_id = $3 where org_id = $1 and conversation_id = $2", [orgId, conv.id, twin.rows[0].id]);
      await db.query("update human_escalations set conversation_id = $3, contact_id = $4 where org_id = $1 and conversation_id = $2", [orgId, conv.id, twin.rows[0].id, kept.id]);
      await db.query("update follow_up_plans set conversation_id = $3, contact_id = $4 where org_id = $1 and conversation_id = $2", [orgId, conv.id, twin.rows[0].id, kept.id]);
      await db.query("delete from conversations where org_id = $1 and id = $2", [orgId, conv.id]);
      await db.query(
        `update conversations c set last_message_at = s.last_at, last_inbound_at = s.last_in, last_outbound_at = s.last_out
         from (select max(created_at) as last_at, max(created_at) filter (where direction = 'inbound') as last_in,
                      max(created_at) filter (where direction = 'outbound') as last_out
               from conversation_messages where conversation_id = $1) s where c.id = $1`,
        [twin.rows[0].id],
      );
    } else {
      await db.query("update conversations set contact_id = $3 where org_id = $1 and id = $2", [orgId, conv.id, kept.id]);
      await db.query("update human_escalations set contact_id = $3 where org_id = $1 and conversation_id = $2", [orgId, conv.id, kept.id]);
      await db.query("update follow_up_plans set contact_id = $3 where org_id = $1 and conversation_id = $2", [orgId, conv.id, kept.id]);
    }
  }

  // CRM records follow the person. The kept contact's own values win; the merged one only fills gaps. History stays where it was
  // recorded (the timeline of the kept contact includes the merged contact's activity through contact_merges).
  await db.query(
    `insert into crm_contact_tags (org_id, contact_id, tag_id, source, added_by, added_at)
     select org_id, $3, tag_id, 'merge', $4, added_at from crm_contact_tags where org_id = $1 and contact_id = $2 on conflict (contact_id, tag_id) do nothing`,
    [orgId, merged.id, kept.id, p.userId],
  );
  await db.query("delete from crm_contact_tags where org_id = $1 and contact_id = $2", [orgId, merged.id]);
  await db.query(
    `insert into crm_field_values (org_id, field_id, entity, entity_id, value_text, value_number, value_date, value_ts, value_bool, value_list, updated_by)
     select org_id, field_id, entity, $3, value_text, value_number, value_date, value_ts, value_bool, value_list, $4 from crm_field_values
     where org_id = $1 and entity = 'contact' and entity_id = $2 on conflict (field_id, entity_id) do nothing`,
    [orgId, merged.id, kept.id, p.userId],
  );
  await db.query("delete from crm_field_values where org_id = $1 and entity = 'contact' and entity_id = $2", [orgId, merged.id]);
  const keptHasPrimary = (await db.query("select 1 from crm_contact_companies where contact_id = $1 and is_primary", [kept.id])).rows.length > 0;
  await db.query(
    `insert into crm_contact_companies (org_id, contact_id, company_id, title, is_primary, created_by)
     select org_id, $3, company_id, title, is_primary and not $4, $5 from crm_contact_companies where org_id = $1 and contact_id = $2
     on conflict (contact_id, company_id) do nothing`,
    [orgId, merged.id, kept.id, keptHasPrimary, p.userId],
  );
  await db.query("delete from crm_contact_companies where org_id = $1 and contact_id = $2", [orgId, merged.id]);
  await db.query("update record_notes set record_id = $3 where org_id = $1 and record_type = 'contact' and record_id = $2", [orgId, merged.id, kept.id]);
  await db.query("update appointment_refs set contact_id = $3 where org_id = $1 and contact_id = $2", [orgId, merged.id, kept.id]);
  await moveContactReferences(db, orgId, merged.id, kept.id);

  await db.query(
    `update contacts set email = coalesce(email, $3::citext), phone = coalesce(phone, $4), display_name = case when display_name = '' then $5 else display_name end, version = version + 1 where org_id = $1 and id = $2`,
    [orgId, kept.id, merged.email, merged.phone, merged.display_name],
  );
  await db.query("update contacts set deleted_at = now(), email = null, phone = null, ghl_contact_id = null where org_id = $1 and id = $2", [orgId, merged.id]);
  await recordAudit({ orgId, actorUserId: p.userId, actorKind: p.auditKind, action: "contact.merged", targetType: "contact", targetId: kept.id, result: "success", metadata: { mergedContactId: merged.id } }, db);
  return { keptId: kept.id };
}

/**
 * References to a contact from records added by later CRM phases (opportunities, tasks, review requests, private feedback, call records). Each statement only runs when
 * its column exists, so this stays correct as the schema grows. Every name below is a real table with a contact_id column (tests/reputation-contacts.test.ts keeps it so).
 */
export const MOVED_CONTACT_TABLES = ["crm_opportunities", "tasks", "crm_review_requests", "customer_feedback", "crm_form_submissions", "crm_call_records", "crm_campaign_recipients", "customer_invoices", "external_reviews"] as const;

async function moveContactReferences(db: Queryable, orgId: string, fromId: string, toId: string) {
  const { rows } = await db.query<{ table_name: string }>(
    `select table_name from information_schema.columns
     where table_schema = 'public' and column_name = 'contact_id' and table_name = any($1::text[])`,
    [[...MOVED_CONTACT_TABLES]],
  );
  for (const r of rows) await db.query(`update "${r.table_name}" set contact_id = $3 where org_id = $1 and contact_id = $2`, [orgId, fromId, toId]);
  await moveRetentionEnrollments(db, orgId, fromId, toId);
}

/**
 * Retention program enrollments follow the person, with two guards. The merged record's still-running programs are cancelled (the kept record keeps its own), so the same
 * customer never gets a program twice; and an enrollment the kept record already has for the same program and cause (an enrollment is unique per program, contact and cause)
 * stays behind on the merged record instead of colliding. What moves is history the kept record's activity list should show.
 */
async function moveRetentionEnrollments(db: Queryable, orgId: string, fromId: string, toId: string) {
  await cancelRetention(db, orgId, fromId, "contact_merged");
  await db.query(
    `update retention_enrollments e set contact_id = $3 where e.org_id = $1 and e.contact_id = $2
       and not exists (select 1 from retention_enrollments k where k.program_id = e.program_id and k.contact_id = $3 and k.trigger_ref = e.trigger_ref)`,
    [orgId, fromId, toId],
  );
}

/** Privacy request: removes personal details and identifiers, keeps non-identifying counts and the audit trail. */
export async function redactContact(who: OrgContext | CrmActor, contactId: string, reason: string) {
  const p = principalOf(who);
  if (!p.can("consent.manage")) throw new AppError("forbidden", "Only owners and managers can process privacy requests.");
  if (reason.trim().length < 5) throw new AppError("invalid_input", "Record the request this is fulfilling.");
  const ctx = { org: { orgId: p.orgId }, user: { id: p.userId } };
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from contacts where org_id = $1 and id = $2 and deleted_at is null for update", [ctx.org.orgId, contactId]);
    if (!rows[0]) throw new AppError("not_found", "Contact not found.");
    const ids = await db.query<{ kind: string; value: string }>("select kind, value from contact_identities where org_id = $1 and contact_id = $2", [ctx.org.orgId, contactId]);
    // Keep the opt-out so a deleted person is never contacted again on an address they opted out of.
    await db.query("update follow_up_plans set status = 'cancelled', cancel_reason = 'privacy_request', closed_at = now() where org_id = $1 and contact_id = $2 and status = 'active'", [ctx.org.orgId, contactId]);
    await db.query("update conversation_messages set body = '[removed on request]', attachments = '[]'::jsonb where org_id = $1 and conversation_id in (select id from conversations where org_id = $1 and contact_id = $2)", [ctx.org.orgId, contactId]);
    // The subject line (an email's) is customer-written text too, and the inbox search matches it: it goes with the preview.
    await db.query("update conversations set last_message_preview = null, subject = null, status = 'closed' where org_id = $1 and contact_id = $2", [ctx.org.orgId, contactId]);
    // Missed-call cases (the caller's number, drafted texts) and lead scores about this person go with them.
    await eraseRecoveryAndScoring(db, ctx.org.orgId, contactId);
    await eraseWebChatAndAttribution(db, ctx.org.orgId, contactId);
    // Private feedback comments, survey answers, review requests still waiting and customer programs still running go with them (the scores stay, with no person attached).
    await eraseReputationRecords(db, ctx.org.orgId, contactId);
    // Invoices that were never issued go; issued ones keep their numbers and amounts but lose the customer's details and the link to the contact.
    await eraseInvoiceCustomerDetails(db, ctx.org.orgId, contactId);
    // Proposals still open are withdrawn and their links stop working; the person's name and address leave the working copies. Frozen versions and recorded answers are records and
    // stay until the retention policy is decided (src/server/proposals/erase.ts).
    await eraseProposalsForContact(db, ctx.org.orgId, contactId);
    await db.query("delete from contact_identities where org_id = $1 and contact_id = $2", [ctx.org.orgId, contactId]);
    await db.query("update contact_memories set deleted_at = now() where org_id = $1 and contact_id = $2 and deleted_at is null", [ctx.org.orgId, contactId]);
    // CRM details about the person go too: custom field values, tags, company links, and the text of notes about them.
    await db.query("delete from crm_field_values where org_id = $1 and entity = 'contact' and entity_id = $2", [ctx.org.orgId, contactId]);
    await db.query("delete from crm_contact_tags where org_id = $1 and contact_id = $2", [ctx.org.orgId, contactId]);
    await db.query("delete from crm_contact_companies where org_id = $1 and contact_id = $2", [ctx.org.orgId, contactId]);
    await db.query("update record_notes set body = '[removed on request]', deleted_at = now() where org_id = $1 and record_type = 'contact' and record_id = $2", [ctx.org.orgId, contactId]);
    await db.query(
      `update contacts set display_name = 'Removed contact', first_name = null, last_name = null, email = null, phone = null, ghl_contact_id = null,
         address_line1 = null, address_line2 = null, city = null, region = null, postal_code = null, deleted_at = now() where org_id = $1 and id = $2`,
      [ctx.org.orgId, contactId],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: p.auditKind, action: "contact.redacted", targetType: "contact", targetId: contactId, result: "success", metadata: { identifiers: ids.rows.length, reason } }, db);
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
