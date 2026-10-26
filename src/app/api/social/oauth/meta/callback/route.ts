import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { toPublicError } from "@/server/errors";
import { getCurrentUser } from "@/server/auth/session";
import { completeMetaConnect, DEFAULT_RETURN } from "@/server/social/accounts";
import { encodeSocialNotice, SOCIAL_NOTICE_COOKIE, SOCIAL_NOTICE_COOKIE_OPTIONS, type SocialNotice } from "@/server/social/notice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Where Meta sends the browser back after sign-in. The state must be one this signed-in person started in the last ten minutes and not used before; then the
 * code is exchanged and the Pages the person manages are read for them to choose from. Nothing is connected here. The code and tokens are never shown or logged.
 */
export async function GET(req: NextRequest) {
  const base = env().APP_URL.replace(/\/+$/, "");
  const q = req.nextUrl.searchParams;
  const finish = (path: string, notice: SocialNotice | null) => {
    const res = NextResponse.redirect(`${base}${path}`, { status: 303 });
    if (notice) res.cookies.set(SOCIAL_NOTICE_COOKIE, encodeSocialNotice(notice), SOCIAL_NOTICE_COOKIE_OPTIONS);
    // The sign-in code is in this URL: never let it travel on as a referrer, and never cache the response.
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(DEFAULT_RETURN)}`, { status: 303 });
  try {
    const out = await completeMetaConnect(user, { state: q.get("state"), code: q.get("code"), error: q.get("error") });
    if (out.outcome === "denied") return finish(out.returnPath, { kind: "info", message: "Nothing was connected because the sign-in was cancelled." });
    return finish(`${out.returnPath}?choose=${encodeURIComponent(out.stateId as string)}`, null);
  } catch (err) {
    return finish(DEFAULT_RETURN, { kind: "error", message: toPublicError(err).message });
  }
}
