import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { toPublicError } from "@/server/errors";
import { resolveCrmActor } from "@/server/crm/request";
import { CALENDAR_NOTICE_COOKIE, CALENDAR_NOTICE_COOKIE_OPTIONS, DEFAULT_RETURN_PATH, encodeCalendarNotice, safeReturnPath, startCalendarOAuth } from "@/server/calendars/connections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Starts connecting the signed-in person's own Google or Microsoft calendar: records a single-use sign-in state and sends the browser to
 * the provider. Only a top-level navigation from the portal itself (or typed into the address bar) can start one, so another site can't
 * start a sign-in in someone's name.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "google" && provider !== "microsoft") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const base = env().APP_URL.replace(/\/+$/, "");
  const returnPath = safeReturnPath(req.nextUrl.searchParams.get("return"));
  const back = (message: string) => {
    const res = NextResponse.redirect(`${base}${returnPath}`, { status: 303 });
    res.cookies.set(CALENDAR_NOTICE_COOKIE, encodeCalendarNotice({ kind: "error", provider, message }), CALENDAR_NOTICE_COOKIE_OPTIONS);
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return back("That sign-in didn't start from iAcquire, so it was ignored. Use the Connect button on this page.");
  try {
    const actor = await resolveCrmActor(null, "calendars.connect");
    const { url } = await startCalendarOAuth(actor, provider, { returnPath });
    const res = NextResponse.redirect(url, { status: 302 });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (err) {
    const e = toPublicError(err);
    if (e.code === "unauthenticated") return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(DEFAULT_RETURN_PATH)}`, { status: 303 });
    return back(e.message);
  }
}
