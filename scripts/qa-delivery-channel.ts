/**
 * What the browser-QA worlds share for trying "Send it to the customer" (a proposal's Delivery tab, an invoice's page): a workspace whose email goes through a native Resend channel
 * with a made-up credential, a published email rate and some credits. It contacts NO ONE: the QA environment keeps RESEND_WRITES_ENABLED off, so a message that is confirmed is
 * queued and then blocked by the dispatcher ("Sending through this channel's provider is not switched on") instead of leaving.
 *
 * It replaces the workspace's email channel with the native one (one email channel per workspace), so it is never part of a default seed: each world runs it only when asked for.
 * It is a plain module (no vitest, no database setup), like the worlds that use it.
 */
import crypto from "node:crypto";
import { withSystem } from "../src/server/db/index";
import { saveCredential } from "../src/server/security/credentials";
import { adjustCredits, getBalance } from "../src/server/billing/ledger";

export async function connectQaEmail(orgId: string, ownerId: string): Promise<void> {
  await withSystem(async (db) => {
    // Only an agency Super Admin may store a credential. The throwaway QA database has one from the other seeds, or gets one here.
    const admin = (await db.query<{ id: string }>("select id from users where platform_role = 'agency_super_admin' order by created_at limit 1")).rows[0]
      ?? (await db.query<{ id: string }>("insert into users (email, full_name, email_verified_at, platform_role) values ('qa-delivery-admin@example.test', 'QA Super Admin', now(), 'agency_super_admin') returning id")).rows[0];
    const saved = await saveCredential(db, { orgId, provider: "resend", label: "Resend (made up, for QA)", secret: `qa-made-up-${crypto.randomBytes(12).toString("hex")}`, actorId: admin.id });
    await db.query(
      `insert into messaging_channels (org_id, channel, provider, enabled, sender_identity, sender_verified_at, registration_status, provider_sender_id, credential_id, capability_test, capability_tested_at)
       values ($1, 'email', 'resend', true, 'Harbor Home Services <hello@harbor.example.test>', now(), 'not_required', $2, $3, $4::jsonb, now())
       on conflict (org_id, channel) do update set provider = 'resend', enabled = true, sender_identity = excluded.sender_identity, sender_verified_at = now(), registration_status = 'not_required',
         provider_sender_id = excluded.provider_sender_id, provider_account_id = null, credential_id = excluded.credential_id, capability_test = excluded.capability_test, capability_tested_at = now()`,
      [orgId, crypto.randomUUID(), saved.id, JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), checks: [{ label: "Made up for QA", ok: true, detail: "Nothing was checked with the provider." }] })],
    );
    const version = (await db.query<{ id: string }>("select id from usage_rate_versions order by version desc limit 1")).rows[0];
    if (!version) throw new Error("No usage rate version exists, so an email cannot be priced.");
    await db.query(
      "insert into usage_unit_rates (rate_version_id, provider, unit_type, unit_label, wholesale_micros_per_unit, client_micros_per_unit) values ($1, 'resend', 'email_send', 'email_send', 900, 1170) on conflict do nothing",
      [version.id],
    );
  });
  const balance = await withSystem((db) => getBalance(db, orgId));
  if (balance.availableMicros < 5_000_000) {
    await withSystem((db) => adjustCredits(db, { orgId, deltaMicros: 5_000_000, reason: "QA credit for sending messages (isolated QA database)", userId: ownerId }));
  }
}
