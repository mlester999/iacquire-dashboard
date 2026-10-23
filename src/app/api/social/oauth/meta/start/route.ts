import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { toPublicError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { DEFAULT_RETURN, safeReturn, startMetaConnect } from "@/server/social/accounts";
import { encodeSocialNotice, SOCIAL_NOTICE_COOKIE, SOCIAL_NOTICE_COOKIE_OPTIONS } from "@/server/social/notice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Starts connecting a Facebook Page (and its Instagram account) for the signed-in owner or manager: records a single-use sign-in state and sends the browser to
 * Meta. Only a top-level navigation from the portal itself (or typed into the address bar) can start one, so another site cannot start a sign-in in someone's name.
 */
export async function GET(req: NextRequest) {
  const base = env().APP_URL.replace(/\/+$/, "");
  const platform = req.nextUrl.searchParams.get("platform") === "instagram" ? "instagram" : "facebook";
  const returnPath = safeReturn(req.nextUrl.searchParams.get("return"));
  const back = (message: string) => {
    const res = NextResponse.redirect(`${base}${returnPath}`, { status: 303 });
    res.cookies.set(SOCIAL_NOTICE_COOKIE, encodeSocialNotice({ kind: "error", message }), SOCIAL_NOTICE_COOKIE_OPTIONS);
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return back("That sign-in didn't start from iAcquire, so it was ignored. Use the Connect button on this page.");
  try {
    const ctx = await requireOrgContextOrThrow("social.connect");
    const { url } = await startMetaConnect(ctx, platform, returnPath);
    const res = NextResponse.redirect(url, { status: 302 });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (err) {
    const e = toPublicError(err);
    if (e.code === "unauthenticated") return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(DEFAULT_RETURN)}`, { status: 303 });
    return back(e.message);
  }
}
