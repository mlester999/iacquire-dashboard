import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { resolveCredential } from "@/server/security/credentials";
import { hashIp } from "@/server/security/crypto";
import { consumeRateLimitInTx, rateLimitReachedInTx, RATE_LIMITS } from "@/server/security/rate-limit";
import { recordVoiceEvent } from "@/server/crm/calls";
import { parseRetellEvent, parseRetellSecret, verifyRetellSignature } from "@/server/integrations/voice/retell";
import { parseVapiEvent, parseVapiSecret, verifyVapiRequest } from "@/server/integrations/voice/vapi";
import type { HeaderSource, VerifyResult, VoiceProvider } from "@/server/integrations/voice/types";

// One webhook request from a voice provider, end to end. In order:
//
//  1. The body is parsed and turned into a call event (only call activity is recorded; anything else is acknowledged and ignored).
//  2. The workspace is found through crm_voice_connections.external_ids (the assistant / agent / phone-number ids on the call) and
//     nothing else. No match, or a match in more than one workspace, is refused.
//  3. The request is authenticated with that workspace's own credential from the vault: Vapi's Bearer / X-Vapi-Secret token or HMAC
//     signature, Retell's X-Retell-Signature, each compared in constant time. Failed attempts are counted per connection and hashed client
//     address; past the limit (RATE_LIMITS.voiceWebhookAuthFailure) that address is refused for that connection before the vault is read,
//     so forged requests can't keep decrypting credentials and writing credential audit rows. Requests that authenticate never count.
//  4. In one transaction: the event's receipt is recorded in webhook_receipts (provider, call id and event), so a redelivery or a replay
//     records nothing new, and the call record is created or merged (src/server/crm/calls.ts recordVoiceEvent).
//
// Nothing about the caller is logged, and the response only says what happened in one word.

export type VoiceWebhookOutcome = "processed" | "duplicate" | "ignored" | "unknown_workspace" | "unauthorized" | "invalid" | "rejected" | "rate_limited";

export interface VoiceWebhookResult {
  status: number;
  outcome: VoiceWebhookOutcome;
  /** For tests and the receipts ledger; never returned to the provider. */
  detail?: string;
  orgId?: string;
  recordId?: string;
  /** With 429: when the address may try again (the Retry-After header). */
  retryAfterSeconds?: number;
}

/** Behind the trusted reverse proxy the first X-Forwarded-For entry is the client address (as everywhere else in the app). */
const clientAddress = (headers: HeaderSource) => headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || null;

/** webhook_receipts.external_id holds at most 200 characters: a longer key is replaced by its hash. */
const receiptId = (key: string) => (key.length <= 200 ? key : `sha256:${crypto.createHash("sha256").update(key).digest("hex")}`);

export async function handleVoiceWebhook(provider: VoiceProvider, rawBody: string, headers: HeaderSource, opts: { now?: Date } = {}): Promise<VoiceWebhookResult> {
  const now = opts.now ?? new Date();
  const ipHash = hashIp(clientAddress(headers)) ?? "unknown";
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, outcome: "invalid", detail: "The body isn't JSON." };
  }
  const parsed = provider === "vapi" ? parseVapiEvent(payload) : parseRetellEvent(payload);
  if (parsed.kind === "ignored") return { status: 200, outcome: "ignored", detail: parsed.reason };
  const event = parsed.event;
  if (!event.externalIds.length) return { status: 404, outcome: "unknown_workspace", detail: "The call names no assistant, agent or phone number." };

  return withSystem(async (db) => {
    const conns = (await db.query<{ id: string; org_id: string; credential_id: string | null; store_recordings: boolean }>(
      "select id, org_id, credential_id, store_recordings from crm_voice_connections where provider = $1 and status <> 'disconnected' and external_ids && $2::text[] limit 2",
      [provider, event.externalIds],
    )).rows;
    if (!conns.length) return { status: 404, outcome: "unknown_workspace" as const, detail: "No workspace is connected to this assistant." };
    if (conns.length > 1) return { status: 409, outcome: "unknown_workspace" as const, detail: "More than one workspace lists this assistant, so the call isn't recorded." };
    const conn = conns[0];
    const gateKey = `${conn.id}:${ipHash}`;
    const gate = await rateLimitReachedInTx(db, RATE_LIMITS.voiceWebhookAuthFailure, gateKey);
    if (!gate.allowed) {
      return { status: 429, outcome: "rate_limited" as const, detail: "Too many requests from this address failed authentication.", orgId: conn.org_id, retryAfterSeconds: gate.retryAfterSeconds };
    }
    if (!conn.credential_id) return { status: 401, outcome: "unauthorized" as const, detail: "The connection has no credential.", orgId: conn.org_id };
    const raw = await resolveCredential(db, conn.credential_id, conn.org_id, provider).catch(() => null);
    let verdict: VerifyResult;
    if (provider === "vapi") {
      const secret = parseVapiSecret(raw);
      verdict = secret ? verifyVapiRequest({ headers, rawBody, secret, now: now.getTime() }) : { ok: false, reason: "missing" };
    } else {
      const secret = parseRetellSecret(raw);
      verdict = secret ? verifyRetellSignature({ rawBody, apiKey: secret.apiKey, header: headers.get("x-retell-signature"), now: now.getTime() }) : { ok: false, reason: "missing" };
    }
    if (!verdict.ok) {
      await consumeRateLimitInTx(db, RATE_LIMITS.voiceWebhookAuthFailure, gateKey);
      return { status: 401, outcome: "unauthorized" as const, detail: `Authentication failed (${verdict.reason}).`, orgId: conn.org_id };
    }

    // Scoped to the workspace, so another workspace's event can never use up (or pre-empt) this one's receipt for the same call id.
    const key = receiptId(`${conn.org_id}:${event.receiptKey}`);
    const receipt = await db.query("insert into webhook_receipts (provider, external_id, kind, org_id) values ($1, $2, $3, $4) on conflict do nothing returning external_id", [provider, key, event.eventType.slice(0, 80), conn.org_id]);
    if (!receipt.rows.length) return { status: 200, outcome: "duplicate" as const, detail: "Already processed.", orgId: conn.org_id };

    const result = await recordVoiceEvent(db, { orgId: conn.org_id, storeRecordings: conn.store_recordings }, event, now);
    if (result.outcome === "rejected") {
      await db.query("update webhook_receipts set outcome = 'rejected', detail = $3 where provider = $1 and external_id = $2", [provider, key, result.detail.slice(0, 300)]);
      return { status: 409, outcome: "rejected" as const, detail: result.detail, orgId: conn.org_id };
    }
    await db.query("update webhook_receipts set outcome = 'processed', detail = $3 where provider = $1 and external_id = $2", [provider, key, `${result.outcome}${result.completed ? ", completed" : ""}`]);
    await db.query("update crm_voice_connections set status = 'connected', last_event_at = $2 where id = $1", [conn.id, now.toISOString()]);
    return { status: 200, outcome: "processed" as const, orgId: conn.org_id, recordId: result.recordId, detail: result.outcome };
  });
}
