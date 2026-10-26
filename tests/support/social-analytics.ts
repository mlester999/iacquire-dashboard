// Fixtures for the social analytics tests: published posts written straight into the tables (the publisher has its own tests), the numbers a platform
// returned for them, and contacts whose visit carried a post's tracking code. Synthetic data only.
import crypto from "node:crypto";
import { rows, type SocialOrg } from "./social";

export const DAY = 86_400_000;
export const daysAgo = (n: number, hourUtc = 10) => {
  const d = new Date(Date.now() - n * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

/** A tracking code as the product writes it: eight lower-case letters and digits. */
export const newCode = () => crypto.randomBytes(4).toString("hex");

export interface SeededPost {
  caption?: string;
  kind?: "text" | "link" | "image" | "video";
  publishedAt: Date;
  /** What the platform returned. Omit for a post it returned nothing for. */
  metrics?: Record<string, number>;
  trackingCode?: string | null;
  linkUrl?: string | null;
  campaignId?: string | null;
}

/** One published post, with its returned numbers read an hour after it went out. Returns its id. */
export async function seedPublished(s: SocialOrg, accountId: string, over: SeededPost): Promise<string> {
  const id = (await rows<{ id: string }>(
    `insert into social_posts (org_id, account_id, campaign_id, kind, caption, link_url, tracking_code, status, provider_post_id, published_at, origin)
     values ($1, $2, $3, $4, $5, $6, $7, 'published', $8, $9, 'human') returning id`,
    [s.m.org.id, accountId, over.campaignId ?? null, over.kind ?? "text", over.caption ?? "A seeded post", over.linkUrl ?? null, over.trackingCode ?? null, `seed_${crypto.randomUUID()}`, over.publishedAt],
  ))[0].id;
  if (over.metrics) {
    await rows("insert into social_post_metrics (org_id, post_id, fetched_at, metrics, source) values ($1, $2, $3, $4::jsonb, 'simulated')", [s.m.org.id, id, new Date(over.publishedAt.getTime() + 3_600_000), JSON.stringify(over.metrics)]);
  }
  return id;
}

/** A published link post with its own tracking code. Returns the post id and the code. */
export async function seedTracked(s: SocialOrg, accountId: string, over: Omit<SeededPost, "trackingCode" | "linkUrl" | "kind"> = { publishedAt: new Date() }): Promise<{ id: string; code: string }> {
  const code = newCode();
  const id = await seedPublished(s, accountId, { ...over, kind: "link", trackingCode: code, linkUrl: "https://www.client-site.test/offer" });
  return { id, code };
}

/** A contact whose recorded visit carried the code. `visitAt` defaults to a moment ago; the contact is created at the same time unless told otherwise. */
export async function leadWith(s: SocialOrg, code: string, over: { status?: string; visitAt?: Date; createdAt?: Date; name?: string } = {}): Promise<string> {
  const visitAt = over.visitAt ?? new Date(Date.now() - 60_000);
  const id = (await rows<{ id: string }>("insert into contacts (org_id, display_name, lead_status, created_at) values ($1, $2, $3, $4) returning id", [s.m.org.id, over.name ?? "Lead", over.status ?? "new", over.createdAt ?? visitAt]))[0].id;
  await touch(s, id, code, visitAt);
  return id;
}

/** One more visit by an existing contact. */
export async function touch(s: SocialOrg, contactId: string, code: string | null, at: Date): Promise<void> {
  await rows(
    "insert into lead_touches (org_id, contact_id, occurred_at, kind, source, medium, content, confidence, evidence, ref_type, ref_id) values ($1, $2, $3, 'website_form', 'facebook', 'social', $4, 'known', 'utm', 'website_submission', $5)",
    [s.m.org.id, contactId, at, code, `ref-${crypto.randomUUID()}`],
  );
}

export async function bookAppointment(s: SocialOrg, contactId: string, createdAt: Date, status = "confirmed"): Promise<void> {
  await rows(
    "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, created_at) values ($1, $2, 'cal', 'Visit', $3, now() + interval '2 days', now() + interval '2 days 1 hour', $4, $5)",
    [s.m.org.id, `appt-${crypto.randomUUID()}`, status, contactId, createdAt],
  );
}

export async function openDeal(s: SocialOrg, contactId: string, createdAt: Date, status: "open" | "won" | "lost" = "open"): Promise<void> {
  await rows(
    "insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, provider, monetary_value, contact_id, created_at, closed_at) values ($1, $2, 'Deal', $3, 'ghl', 500, $4, $5, $6)",
    [s.m.org.id, `deal-${crypto.randomUUID()}`, status, contactId, createdAt, status === "open" ? null : createdAt],
  );
}
