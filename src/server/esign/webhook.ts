import "server-only";
import { withSystem } from "@/server/db";
import { hashIp } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { featureOn, ESIGN_FEATURE, proposalsPublicDisabled } from "@/server/proposals/features";
import { applyProviderFact } from "@/server/esign/apply";
import { addSigEvent, CONNECTION_COLUMNS, orgTakesNoAnswers, type ConnectionRow } from "@/server/esign/core";
import { openCredentials } from "@/server/esign/credentials";
import { providerFor, type Adapter } from "@/server/esign/providers";
import type { EsignProvider } from "@/server/esign/providers/types";
import { hashWebhookToken, looksLikeWebhookToken } from "@/server/esign/webhook-token";

// A signing service tells iAcquire what happened to a document. There is no session: a delivery is trusted only by its signature, over the exact bytes received, checked with the
// key of the ONE connection whose secret address it came to. The workspace, the connection and the request are always read from our own rows (the address's secret, then the
// service's document id within that connection), never from anything the body claims. A body is read as bytes before anything is parsed, because parsing first would change what
// was signed. Answering 200 acknowledges a delivery; any 5xx makes the service send it again, which is safe because applying an event is idempotent.
//
// Every entry point checks, in this order: the platform switch (before any database read), a rate limit per address (before the secret is looked up, so guessing addresses costs
// the guesser), the shape of the secret, and only then the database.

/** The largest delivery read. A notice is a few hundred bytes; this is a ceiling for a bug or an attack, and the route stops reading the moment it is passed. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface WebhookInput {
  token: string;
  rawBody: Buffer;
  headers: Headers;
  query: URLSearchParams;
  /** The caller's network address; used only through a keyed hash. */
  ip?: string | null;
  now?: Date;
}

export interface WebhookResult {
  status: 200 | 400 | 401 | 404 | 429 | 503;
  body: { received: boolean; events?: number; reason?: string };
}

const refuse = (status: WebhookResult["status"], reason: string): WebhookResult => ({ status, body: { received: false, reason } });

export async function handleEsignWebhook(input: WebhookInput, deps: { provider?: (adapter: Adapter) => EsignProvider } = {}): Promise<WebhookResult> {
  if (proposalsPublicDisabled()) return refuse(503, "unavailable");
  if (!(await consumeRateLimit(RATE_LIMITS.esignWebhookByIp, hashIp(input.ip) ?? "unknown")).allowed) return refuse(429, "rate_limited");
  if (!looksLikeWebhookToken(input.token)) return refuse(404, "not_found");
  const now = input.now ?? new Date();
  const connection = await withSystem(async (db) => (await db.query<ConnectionRow>(`select ${CONNECTION_COLUMNS} from esign_connections where webhook_token_hash = $1 and status not in ('revoked', 'disconnected')`, [hashWebhookToken(input.token)])).rows[0] ?? null);
  if (!connection) return refuse(404, "not_found");
  // A workspace that takes no answers right now (switched off, suspended, archived, paused) answers "try again later", so the service delivers again once it is back.
  const stopped = await withSystem(async (db) => !(await featureOn(connection.org_id, ESIGN_FEATURE, db)) || (await orgTakesNoAnswers(db, connection.org_id)));
  if (stopped) return refuse(503, "unavailable");
  const creds = openCredentials(connection.credentials);
  if (!creds) return refuse(503, "unavailable");
  const provider = deps.provider ? deps.provider(connection.provider) : providerFor(connection.provider);
  const verified = provider.verifyWebhook({ rawBody: input.rawBody, headers: input.headers, query: input.query }, creds);
  if (!verified.ok) return refuse(verified.reason === "bad_signature" ? 401 : 400, verified.reason);

  let failed = false;
  let handled = 0;
  for (const event of verified.events) {
    try {
      await withSystem(async (db) => {
        // The request is found within THIS connection by the service's own document id. A delivery for any other document is acknowledged and ignored.
        const req = (await db.query<{ id: string }>("select id from signature_requests where connection_id = $1 and org_id = $2 and provider_document_id = $3", [connection.id, connection.org_id, event.documentId])).rows[0];
        if (!req) return;
        handled += 1;
        if (event.fact === null) {
          // Not a statement about the document's state: written down once (a replay finds the row) and nothing else.
          await addSigEvent(db, connection.org_id, req.id, "delivery_noted", "provider_webhook", { name: event.name, status: event.status }, event.eventId);
          return;
        }
        await applyProviderFact(db, connection.org_id, req.id, event.fact, { source: "provider_webhook", eventId: event.eventId, now });
      });
    } catch (e) {
      failed = true;
      // Nothing about the body, the workspace or the service is logged.
      if (process.env.NODE_ENV !== "test") console.error("[iacquire] a signing delivery could not be applied", { type: e instanceof Error ? e.name : "unknown" });
    }
  }
  if (failed) throw new Error("a signing delivery could not be applied");
  return { status: 200, body: { received: true, events: handled } };
}
