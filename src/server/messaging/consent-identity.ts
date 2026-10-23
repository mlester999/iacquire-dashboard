import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { identityKind, type Channel } from "@/lib/messaging";
import type { OrgContext } from "@/server/tenancy/context";

// Whether a phone number or email address on a contact has been confirmed, and how it becomes confirmed. The rule that uses this (evaluateSend, src/lib/webchat/identity.ts)
// is about addresses a website visitor only typed. They become verified in two ways, both recorded on the identity (verified, verified_via):
//   * the address writes to the business and the sender is proven (a number reached through the carrier, or an email whose domain the receiving server authenticated):
//     verified_via = provider_inbound;
//   * a person of the business confirms it and says how they know: verified_via = staff_confirmed, with an audit row.

/** Whether the contact's identity for this channel and address is verified; null when there is no such identity. */
export async function identityVerified(db: Queryable, orgId: string, contactId: string, channel: Channel, address: string): Promise<boolean | null> {
  const { rows } = await db.query<{ verified: boolean }>("select verified from contact_identities where org_id = $1 and contact_id = $2 and kind = $3 and value = $4", [orgId, contactId, identityKind(channel), address]);
  return rows[0]?.verified ?? null;
}

/**
 * Whether this address is one a website visitor only typed (its contact came from the website chat and the address is not verified). For read-only previews that
 * say what a send would do; evaluateSend itself applies the whole rule.
 */
export async function typedByVisitorAddress(db: Queryable, orgId: string, contactId: string, channel: Channel, address: string): Promise<boolean> {
  const { rows } = await db.query<{ typed: boolean }>(
    `select (not i.verified and k.created_via = 'website_chat') as typed from contact_identities i join contacts k on k.id = i.contact_id and k.org_id = i.org_id
     where i.org_id = $1 and i.contact_id = $2 and i.kind = $3 and i.value = $4`,
    [orgId, contactId, identityKind(channel), address],
  );
  return rows[0]?.typed ?? false;
}

/** The source of the contact's latest consent event for this channel and purpose (for example "website_chat_form"), or null when there is none. */
export async function latestConsentSource(db: Queryable, orgId: string, contactId: string, channel: Channel, purpose: "service" | "marketing"): Promise<string | null> {
  const { rows } = await db.query<{ source: string }>(
    "select source from contact_consent_events where org_id = $1 and contact_id = $2 and channel = $3 and purpose = $4 order by id desc limit 1",
    [orgId, contactId, channel, purpose],
  );
  return rows[0]?.source ?? null;
}

/**
 * A message arrived from this address and the sender is proven, so whoever holds the address is the one who wrote: an identity that was only typed by a website
 * visitor becomes verified. Returns whether anything changed. Never touches another contact's identity (the pair kind and value is unique in a workspace).
 */
export async function verifyIdentityOnInbound(db: Queryable, input: { orgId: string; contactId: string; channel: Channel; address: string }): Promise<boolean> {
  const res = await db.query(
    "update contact_identities set verified = true, verified_via = 'provider_inbound' where org_id = $1 and contact_id = $2 and kind = $3 and value = $4 and not verified",
    [input.orgId, input.contactId, identityKind(input.channel), input.address],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * A person confirms that a number or address belongs to the customer (they called it, they saw the customer use it). It is recorded on the identity and in the audit
 * trail with the person's own words about how they know, and lets automatic messages go to it. It records no consent of any kind: that stays as it was.
 */
export async function confirmContactIdentity(ctx: OrgContext, input: { identityId: string; how: string }): Promise<{ identityId: string; alreadyVerified: boolean }> {
  if (!ctx.can("contacts.edit")) throw new AppError("forbidden", "Your role can't confirm a customer's contact details.");
  const how = input.how.replace(/\s+/g, " ").trim();
  if (how.length < 5) throw new AppError("invalid_input", "Say how you know it is theirs, for example: I called this number and they answered.");
  if (how.length > 300) throw new AppError("invalid_input", "Keep it under 300 characters.");
  return withSystem(async (db) => {
    // Looked up by the workspace too: an id from another workspace is simply not found.
    const { rows } = await db.query<{ id: string; contact_id: string; kind: string; verified: boolean }>(
      `select i.id, i.contact_id, i.kind, i.verified from contact_identities i join contacts k on k.id = i.contact_id and k.org_id = i.org_id
       where i.id = $1 and i.org_id = $2 and k.deleted_at is null for update of i`,
      [input.identityId, ctx.org.orgId],
    );
    const identity = rows[0];
    if (!identity) throw new AppError("not_found", "That number or address was not found.");
    if (identity.verified) return { identityId: identity.id, alreadyVerified: true };
    await db.query("update contact_identities set verified = true, verified_via = 'staff_confirmed' where id = $1 and org_id = $2", [identity.id, ctx.org.orgId]);
    // The address itself is not written to the audit trail, only which kind it was and what the person said.
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "contact.identity_confirmed", targetType: "contact", targetId: identity.contact_id, result: "success", metadata: { identityKind: identity.kind, how } }, db);
    return { identityId: identity.id, alreadyVerified: false };
  });
}
