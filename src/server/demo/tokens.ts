import "server-only";
import { env } from "@/server/env";
import { randomToken, sha256 } from "@/server/security/crypto";
import { isDemoToken } from "@/lib/demo/rules";

// The two secrets a prospect holds: the link in their email (works once) and the session cookie that follows it. Both are 32 random bytes; the database keeps only the sha256 of each,
// so a read of the tables never yields a way in. They are the prospect's own and share nothing with the portal's sign-in (no users, auth_sessions or auth_tokens row).

/** The session cookie's name. */
export const DEMO_COOKIE = "iaq_demo";

export const newDemoToken = (): string => randomToken(32);
export const hashDemoToken = (token: string): string => sha256(token);
export const looksLikeDemoToken = isDemoToken;

export interface DemoCookie {
  name: string;
  value: string;
  options: { httpOnly: true; sameSite: "lax"; secure: boolean; path: "/"; expires: Date };
}

/**
 * What to set when a session starts. HttpOnly (no script reads it), SameSite Lax (a page on another site cannot post with it), Secure outside development. The path is "/" because
 * the room's pages and the public API both need it; the cookie means nothing to any other part of the portal, which never looks for it.
 */
export function demoCookie(token: string, expires: Date): DemoCookie {
  return { name: DEMO_COOKIE, value: token, options: { httpOnly: true, sameSite: "lax", secure: env().NODE_ENV === "production", path: "/", expires } };
}
