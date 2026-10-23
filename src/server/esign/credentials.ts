import "server-only";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import type { EsignCredentials } from "@/server/esign/providers/types";

// A connection's keys, sealed (AES-GCM, the same key and format as every other stored credential) before they are written and opened only inside the server, for the length of one
// call. The column they live in is not readable by the application role, and nothing here is ever returned to a browser, put in an audit row or logged.

export const sealCredentials = (c: EsignCredentials): string => encryptSecret(JSON.stringify({ apiKey: c.apiKey, webhookKey: c.webhookKey }));

/** The keys, or null when there are none or they can no longer be opened (for example after an encryption key change): that connection must be connected again. */
export function openCredentials(sealed: string | null): EsignCredentials | null {
  if (!sealed) return null;
  try {
    const j = JSON.parse(decryptSecret(sealed)) as { apiKey?: unknown; webhookKey?: unknown };
    return typeof j.apiKey === "string" && j.apiKey && typeof j.webhookKey === "string" && j.webhookKey ? { apiKey: j.apiKey, webhookKey: j.webhookKey } : null;
  } catch {
    return null;
  }
}
