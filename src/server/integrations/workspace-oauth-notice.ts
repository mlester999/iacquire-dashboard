import "server-only";
import { workspaceOAuthProvider, type WorkspaceOAuthProvider } from "@/lib/integrations/workspace-oauth";
import { decryptSecret, encryptSecret, sha256 } from "@/server/security/crypto";
import type { OrgContext } from "@/server/tenancy/context";

export const WORKSPACE_OAUTH_NOTICE_MAX_AGE = 45;
type NoticeOutcome = "denied" | "error";

export function workspaceOAuthNotice(ctx: OrgContext, provider: WorkspaceOAuthProvider, outcome: NoticeOutcome): string {
  return encryptSecret(JSON.stringify({
    org: ctx.org.orgId, session: sha256(ctx.user.sessionId), provider, outcome,
    expiresAt: Date.now() + WORKSPACE_OAUTH_NOTICE_MAX_AGE * 1000,
  }));
}

export function readWorkspaceOAuthNotice(ctx: OrgContext, cookie: string | undefined) {
  if (!cookie || cookie.length > 1024) return null;
  try {
    const value = JSON.parse(decryptSecret(cookie)) as Partial<Record<"org" | "session" | "provider" | "outcome" | "expiresAt", unknown>>;
    const provider = workspaceOAuthProvider(value.provider);
    if (!provider || (value.outcome !== "denied" && value.outcome !== "error")) return null;
    if (value.org !== ctx.org.orgId || value.session !== sha256(ctx.user.sessionId)
      || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) return null;
    return { provider, outcome: value.outcome };
  } catch {
    return null;
  }
}
