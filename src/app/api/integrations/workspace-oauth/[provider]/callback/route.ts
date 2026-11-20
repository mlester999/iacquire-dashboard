import { NextResponse, type NextRequest } from "next/server";
import {
  WORKSPACE_OAUTH_NOTICE, WORKSPACE_OAUTH_RETURN_PATH, workspaceOAuthProvider,
} from "@/lib/integrations/workspace-oauth";
import { requireFreshUserOrThrow } from "@/server/auth/session";
import { env } from "@/server/env";
import { workspaceOAuthNotice, WORKSPACE_OAUTH_NOTICE_MAX_AGE } from "@/server/integrations/workspace-oauth-notice";
import { canManageWorkspaceOAuth, completeWorkspaceOAuth } from "@/server/integrations/workspace-oauth";
import { getOrgContext } from "@/server/tenancy/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = workspaceOAuthProvider((await params).provider);
  const response = (path: string) => NextResponse.redirect(new URL(path, env().APP_URL), {
    status: 303, headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" },
  });
  if (!provider) return response(WORKSPACE_OAUTH_RETURN_PATH);
  const ctx = await getOrgContext().catch(() => null);
  if (!ctx) return response(`/login?next=${encodeURIComponent(WORKSPACE_OAUTH_RETURN_PATH)}`);
  const finish = (outcome?: "denied" | "error") => {
    const res = response(WORKSPACE_OAUTH_RETURN_PATH);
    const cookie = { httpOnly: true, sameSite: "lax" as const, secure: env().NODE_ENV === "production", path: WORKSPACE_OAUTH_RETURN_PATH };
    res.cookies.set(WORKSPACE_OAUTH_NOTICE, outcome ? workspaceOAuthNotice(ctx, provider, outcome) : "", {
      ...cookie, maxAge: outcome ? WORKSPACE_OAUTH_NOTICE_MAX_AGE : 0,
    });
    return res;
  };
  if (!canManageWorkspaceOAuth(ctx)) return finish("error");
  const query = req.nextUrl.searchParams;
  const states = query.getAll("state");
  const codes = query.getAll("code");
  const errors = query.getAll("error");
  if (states.length !== 1 || codes.length + errors.length !== 1) return finish("error");
  try {
    const user = await requireFreshUserOrThrow({ requireSessionId: true });
    if (user.id !== ctx.user.id || user.sessionId !== ctx.user.sessionId) return finish("error");
    const outcome = await completeWorkspaceOAuth(ctx, provider, { state: states[0], code: codes[0] ?? null, denied: errors[0] === "access_denied" });
    return outcome === "denied" ? finish("denied") : finish();
  } catch {
    return finish("error");
  }
}
