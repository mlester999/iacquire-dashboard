import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";
import { derivedKeys } from "@/server/proposals/link-token";

// The secret in a connection's webhook address. The address is a credential: anyone who has it can knock on the webhook route (a delivery is still refused unless it is signed
// with the connection's own key). Like a proposal link it is derived from a server key and the connection's id, so the business can be shown it again without it being stored;
// only the sha256 of the token is kept. Nothing here is ever logged, put in an audit row, an export or an AI prompt.

/** 32 bytes, base64url: 43 characters. */
export const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const looksLikeWebhookToken = (t: unknown): t is string => typeof t === "string" && WEBHOOK_TOKEN_RE.test(t);

const LABEL = "esign-webhook-v1";
const tokenWith = (key: Buffer, connectionId: string): string => crypto.createHmac("sha256", key).update(`esign-webhook:${connectionId}`).digest("base64url");

export const hashWebhookToken = (token: string): string => crypto.createHash("sha256").update(token, "utf8").digest("hex");

/** A connection's token, derived from its id. */
export const webhookTokenFor = (connectionId: string): string => tokenWith(derivedKeys(LABEL)[0], connectionId);

/** The token a stored connection was made with, found by deriving it again and checking it against the stored hash. Null when no key in use makes it (the key was lost). */
export function tokenForStoredConnection(connectionId: string, tokenHash: string): string | null {
  for (const key of derivedKeys(LABEL)) {
    const token = tokenWith(key, connectionId);
    if (hashWebhookToken(token) === tokenHash) return token;
  }
  return null;
}

/** The address the business gives its signing service. */
export const webhookUrl = (token: string): string => new URL(`/api/webhooks/esign/${token}`, env().APP_URL).toString();
