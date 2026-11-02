import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";
import type { Queryable } from "@/server/db";
import type { ProviderId } from "@/lib/payment-providers/readiness";

// The memory of "Check connection": what the last read-only, authorized call to a payment provider found, and a fingerprint of the exact configuration it was made with. A check is
// true only for that configuration: change a key, the mode, the payment methods, the webhook secret or the site's address and the fingerprint changes, so the connection must be checked
// again. The fingerprint is a hash of hashes: it cannot be turned back into a key, and the table that holds it holds no key, secret or token (migration 0119).

export type CheckOutcome = "verified" | "webhook_not_registered" | "credentials_rejected" | "unreachable" | "unexpected_response" | "not_configured";

export interface StoredCheck {
  ok: boolean;
  livemode: boolean;
  outcome: CheckOutcome;
  fingerprint: string;
  facts: Record<string, unknown>;
  checkedAt: Date;
  checkedBy: string | null;
}

const digest = (value: string | undefined | null) => (value ? crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12) : "-");

/** A hash of the shape of the configuration in use now for a provider. Same configuration, same fingerprint; any change to what the provider is called with, a different one. */
export function configFingerprint(provider: ProviderId): string {
  const e = env();
  const parts = provider === "paymongo"
    ? ["paymongo", digest(e.PAYMONGO_SECRET_KEY), digest(e.PAYMONGO_WEBHOOK_SECRET), e.PAYMONGO_PAYMENT_METHODS.split(",").map((m) => m.trim()).filter(Boolean).sort().join("+"), e.PAYMONGO_API_BASE ?? "", e.APP_URL]
    : ["paypal", digest(e.PAYPAL_CLIENT_ID), digest(e.PAYPAL_CLIENT_SECRET), digest(e.PAYPAL_WEBHOOK_ID), e.PAYPAL_ENVIRONMENT, e.PAYPAL_API_BASE ?? "", e.APP_URL];
  return crypto.createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16);
}

let tableKnown = false;
/** A release that reaches a database before migration 0119 must not take payments down: with no table there is simply no check on record. */
export async function checksAvailable(db: Queryable): Promise<boolean> {
  return tableExists(db);
}

async function tableExists(db: Queryable): Promise<boolean> {
  if (tableKnown) return true;
  const ok = (await db.query<{ ok: boolean }>("select to_regclass('public.payment_provider_checks') is not null as ok")).rows[0]?.ok === true;
  if (ok) tableKnown = true;
  return ok;
}

interface CheckRow {
  ok: boolean;
  livemode: boolean;
  outcome: CheckOutcome;
  fingerprint: string;
  facts: Record<string, unknown>;
  checked_at: Date;
  checked_by: string | null;
}

/** The newest check of a provider, whatever configuration it was made with. */
export async function latestCheck(db: Queryable, provider: ProviderId): Promise<StoredCheck | null> {
  if (!(await tableExists(db))) return null;
  const row = (await db.query<CheckRow>(
    "select ok, livemode, outcome, fingerprint, facts, checked_at, checked_by from payment_provider_checks where provider = $1 order by checked_at desc, id desc limit 1",
    [provider],
  )).rows[0];
  return row ? { ok: row.ok, livemode: row.livemode, outcome: row.outcome, fingerprint: row.fingerprint, facts: row.facts ?? {}, checkedAt: new Date(row.checked_at), checkedBy: row.checked_by } : null;
}

/** True only when the newest check passed AND was made with exactly the configuration in use now. */
export async function verifiedForCurrentConfig(db: Queryable, provider: ProviderId): Promise<boolean> {
  const check = await latestCheck(db, provider);
  return check !== null && check.ok && check.fingerprint === configFingerprint(provider);
}

export async function recordCheck(db: Queryable, input: { provider: ProviderId; livemode: boolean; outcome: CheckOutcome; facts: Record<string, unknown>; checkedBy: string | null; at: Date }): Promise<void> {
  if (!(await tableExists(db))) return;
  await db.query(
    "insert into payment_provider_checks (provider, livemode, outcome, ok, fingerprint, facts, checked_by, checked_at) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)",
    [input.provider, input.livemode, input.outcome, input.outcome === "verified", configFingerprint(input.provider), JSON.stringify(input.facts), input.checkedBy, input.at.toISOString()],
  );
}
