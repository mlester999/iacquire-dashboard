import "server-only";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import type { Credentials } from "@/server/social/providers/types";

// An account's token, sealed (AES-GCM, the same key and format as every other stored credential) before it is written and opened only inside the server, for
// the length of one call. The column it lives in is not readable by the application role, and nothing here is ever returned to a browser or logged.

export const sealCredentials = (c: Credentials): string => encryptSecret(JSON.stringify({ accessToken: c.accessToken }));

/** The credentials, or null when there are none or they can no longer be opened (for example after an encryption key change): that account must be reconnected. */
export function openCredentials(sealed: string | null): Credentials | null {
  if (!sealed) return null;
  try {
    const j = JSON.parse(decryptSecret(sealed)) as { accessToken?: unknown };
    return typeof j.accessToken === "string" && j.accessToken ? { accessToken: j.accessToken } : null;
  } catch {
    return null;
  }
}
