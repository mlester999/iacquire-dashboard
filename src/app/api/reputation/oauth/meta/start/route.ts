import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { toPublicError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { startMetaConnect } from "@/server/social/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Reconnect with review access" (CRM → Reviews → Settings): the Social media sign-in for a Facebook Page, asking Meta for the extra permissions to read the Page's recommendations
 * (and to reply to them, when that is switched on). Everything after Meta sends the person back is the ordinary Social media flow: they choose the Page there, and come back to
 * Reviews to connect it. Only a top-level navigation from the portal itself (or typed into the address bar) can start one. Nothing here is offered while reading recommendations is
 * switched off for iAcquire.
 */
export async function GET(req: NextRequest) {
  const base = env().APP_URL.replace(/\/+$/, "");
  const back = (code: string) => {
    const res = NextResponse.redirect(`${base}/crm/reviews?tab=settings&site=${code}`, { status: 303 });
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return back("facebook_expired");
  try {
    const ctx = await requireOrgContextOrThrow();
    const { url } = await startMetaConnect(ctx, "facebook", "/social/accounts", { reviews: true });
    const res = NextResponse.redirect(url, { status: 302 });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (err) {
    const e = toPublicError(err);
    if (e.code === "unauthenticated") return NextResponse.redirect(`${base}/login?next=${encodeURIComponent("/crm/reviews?tab=settings")}`, { status: 303 });
    return back(e.code === "unavailable" ? "facebook_unavailable" : e.code === "forbidden" ? "forbidden" : "facebook_failed");
  }
}
