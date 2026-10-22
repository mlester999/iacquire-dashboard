import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { crmRead, systemActor, type CrmActor } from "@/server/crm/actor";
import { emitEvent } from "@/server/crm/events";
import { classifyTouch, type ClassifiedTouch, type Confidence, type Evidence, type TouchFacts, type TouchKind } from "@/lib/attribution/model";
import type { OrgContext } from "@/server/tenancy/context";

type RefType = "form_submission" | "website_submission" | "web_chat_session" | "call" | "booking" | "manual";

export interface TouchRecord {
  id: number;
  occurredAt: string;
  kind: TouchKind;
  source: string;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  landingPath: string | null;
  referrer: string | null;
  confidence: Confidence;
  evidence: Evidence;
}

/**
 * Records one touch for a contact. Idempotent on the record it came from (a redelivered webhook records nothing new), append-only (a later touch
 * never edits an earlier one), and it re-points the contact's first and latest touch from the history, so a touch that arrives late but happened
 * earlier becomes the first touch rather than being ignored. Announces `lead.source_recorded` once per touch.
 */
export async function recordTouch(
  db: Queryable,
  input: { orgId: string; contactId: string; facts: TouchFacts; occurredAt?: Date; ref?: { type: RefType; id: string }; createdBy?: string | null },
): Promise<{ id: number | null; duplicate: boolean; touch: ClassifiedTouch }> {
  const touch = classifyTouch(input.facts);
  const { rows } = await db.query<{ id: string }>(
    `insert into lead_touches (org_id, contact_id, occurred_at, kind, source, medium, campaign, content, term, click_ids, landing_path, referrer, confidence, evidence, ref_type, ref_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     on conflict (org_id, ref_type, ref_id) do nothing returning id`,
    [input.orgId, input.contactId, input.occurredAt ?? new Date(), input.facts.kind, touch.source, touch.medium, touch.campaign, touch.content, touch.term, JSON.stringify(touch.clickIds),
      touch.landingPath, touch.referrer, touch.confidence, touch.evidence, input.ref?.type ?? null, input.ref?.id.slice(0, 80) ?? null, input.createdBy ?? null],
  );
  if (!rows[0]) return { id: null, duplicate: true, touch };
  const id = Number(rows[0].id);
  await db.query(
    `update contacts c set first_touch_id = f.id, latest_touch_id = l.id
     from (select id from lead_touches where org_id = $1 and contact_id = $2 order by occurred_at asc, id asc limit 1) f,
          (select id from lead_touches where org_id = $1 and contact_id = $2 order by occurred_at desc, id desc limit 1) l
     where c.org_id = $1 and c.id = $2`,
    [input.orgId, input.contactId],
  );
  await emitEvent(db, systemActor({ id: input.orgId }), {
    type: "lead.source_recorded", entityType: "contact", entityId: input.contactId, contactId: input.contactId, byContact: input.facts.kind !== "manual",
    payload: { touchId: id, kind: input.facts.kind, source: touch.source, medium: touch.medium, campaign: touch.campaign, confidence: touch.confidence },
    dedupeKey: `lead.source_recorded:${id}`,
  });
  return { id, duplicate: false, touch };
}

/** The attribution a form stored with a submission, in either shape it was saved in (flat UTM keys, or nested under "utm"). */
export function factsFromStoredAttribution(stored: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return out;
  const flat = stored as Record<string, unknown>;
  const nested = typeof flat.utm === "object" && flat.utm !== null && !Array.isArray(flat.utm) ? (flat.utm as Record<string, unknown>) : {};
  const put = (key: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 300);
  };
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid", "landing_page", "referrer"]) {
    put(k, flat[k]);
    if (!out[k]) put(k, nested[k]);
  }
  for (const [short, key] of [["source", "utm_source"], ["medium", "utm_medium"], ["campaign", "utm_campaign"], ["term", "utm_term"], ["content", "utm_content"]] as const) {
    if (!out[key]) put(key, nested[short]);
  }
  return out;
}

/** A form submission that created or matched a contact. */
export async function recordFormTouch(
  db: Queryable,
  input: { orgId: string; contactId: string; kind: "website_form" | "crm_form"; submissionId: string; attribution: unknown; occurredAt?: Date },
) {
  return recordTouch(db, {
    orgId: input.orgId, contactId: input.contactId, occurredAt: input.occurredAt,
    facts: { kind: input.kind, attribution: factsFromStoredAttribution(input.attribution) },
    ref: { type: input.kind === "website_form" ? "website_submission" : "form_submission", id: input.submissionId },
  });
}

/** An inbound call that created or matched a contact. A call carries no campaign, so it is recorded as the phone channel (inferred), not as an unknown. */
export async function recordCallTouch(db: Queryable, input: { orgId: string; contactId: string; callId: string; occurredAt?: Date }) {
  return recordTouch(db, { orgId: input.orgId, contactId: input.contactId, occurredAt: input.occurredAt, facts: { kind: "call" }, ref: { type: "call", id: input.callId } });
}

/**
 * recordCallTouch in its own savepoint: a problem recording where a caller came from must never lose the call record it is part of.
 * Only an inbound call that is matched to a contact is a touch (an outbound call is the business reaching out, not the lead arriving).
 */
export async function recordCallTouchSafely(db: Queryable, input: { orgId: string; contactId: string; callId: string; occurredAt?: Date }): Promise<void> {
  await db.query("savepoint call_touch");
  try {
    await recordCallTouch(db, input);
    await db.query("release savepoint call_touch");
  } catch {
    await db.query("rollback to savepoint call_touch");
    await db.query("release savepoint call_touch");
  }
}

/** The first message of a website chat session: what the visit carried when the widget started. */
export async function recordChatTouch(db: Queryable, input: { orgId: string; contactId: string; sessionId: string; surface: "site" | "embed"; originHost: string }) {
  const { rows } = await db.query<{ landing_path: string | null; referrer: string | null; attribution: Record<string, string>; created_at: Date }>(
    "select landing_path, referrer, attribution, created_at from web_chat_sessions where id = $1 and org_id = $2",
    [input.sessionId, input.orgId],
  );
  const s = rows[0];
  return recordTouch(db, {
    orgId: input.orgId, contactId: input.contactId, occurredAt: s?.created_at,
    facts: { kind: "website_chat", attribution: { ...(s?.attribution ?? {}), landing_page: s?.landing_path ?? undefined, referrer: s?.referrer ?? undefined } },
    ref: { type: "web_chat_session", id: input.sessionId },
  });
}

/** A person's own choice of source for a contact ("they told us at the trade show"). Known, attributed to them, and it never replaces an earlier touch. */
export async function recordManualTouch(ctx: OrgContext, input: { contactId: string; source: string; medium?: string | null; campaign?: string | null }) {
  if (!ctx.can("contacts.edit")) throw new AppError("forbidden", "Your role can't change a contact's source.");
  return withSystem(async (db) => {
    const exists = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [input.contactId, ctx.org.orgId]);
    if (!exists.rows[0]) throw new AppError("not_found", "Contact not found.");
    const r = await recordTouch(db, {
      orgId: ctx.org.orgId, contactId: input.contactId, createdBy: ctx.user.id,
      facts: { kind: "manual", manual: { source: input.source, medium: input.medium ?? null, campaign: input.campaign ?? null } },
      ref: { type: "manual", id: crypto.randomUUID() },
    });
    if (r.touch.evidence !== "manual") throw new AppError("invalid_input", "Enter a source, for example Referral or Trade show.");
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "attribution.manual_touch", targetType: "contact", targetId: input.contactId, result: "success", metadata: { source: r.touch.source } }, db);
    return r;
  });
}

type Row = {
  id: string; occurred_at: Date; kind: TouchKind; source: string; medium: string | null; campaign: string | null; content: string | null; term: string | null; landing_path: string | null;
  referrer: string | null; confidence: Confidence; evidence: Evidence;
};
const map = (r: Row): TouchRecord => ({
  id: Number(r.id), occurredAt: new Date(r.occurred_at).toISOString(), kind: r.kind, source: r.source, medium: r.medium, campaign: r.campaign, content: r.content, term: r.term,
  landingPath: r.landing_path, referrer: r.referrer, confidence: r.confidence, evidence: r.evidence,
});

/** A contact's source history for the contact page: first touch, latest touch and every touch in between, oldest first. */
export async function getContactAttribution(actor: CrmActor, contactId: string): Promise<{ first: TouchRecord | null; latest: TouchRecord | null; history: TouchRecord[] }> {
  if (!actor.can("contacts.view")) throw new AppError("forbidden", "Your role can't see contacts.");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<Row>(
      `select t.id, t.occurred_at, t.kind, t.source, t.medium, t.campaign, t.content, t.term, t.landing_path, t.referrer, t.confidence, t.evidence
       from lead_touches t where t.org_id = $1 and t.contact_id = $2 order by t.occurred_at, t.id limit 100`,
      [actor.orgId, contactId],
    );
    const history = rows.map(map);
    return { first: history[0] ?? null, latest: history[history.length - 1] ?? null, history };
  });
}
