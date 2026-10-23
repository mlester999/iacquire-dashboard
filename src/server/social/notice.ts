import "server-only";

// A short message handed from the sign-in routes to the accounts page: what happened when the person came back from the platform. A cookie that lives a minute
// and is not readable by scripts; never anything secret, never more than a sentence.

export const SOCIAL_NOTICE_COOKIE = "iaq_social_notice";
export const SOCIAL_NOTICE_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax" as const, path: "/social", maxAge: 60, secure: process.env.NODE_ENV === "production" };

export interface SocialNotice {
  kind: "success" | "error" | "info";
  message: string;
}

export const encodeSocialNotice = (n: SocialNotice): string => Buffer.from(JSON.stringify({ kind: n.kind, message: n.message.slice(0, 300) })).toString("base64url");

export function decodeSocialNotice(raw: string | undefined | null): SocialNotice | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<SocialNotice>;
    return (j.kind === "success" || j.kind === "error" || j.kind === "info") && typeof j.message === "string" ? { kind: j.kind, message: j.message.slice(0, 300) } : null;
  } catch {
    return null;
  }
}
