import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { toPublicError } from "@/server/errors";
import { getCurrentUser } from "@/server/auth/session";
import { CALENDAR_NOTICE_COOKIE, CALENDAR_NOTICE_COOKIE_OPTIONS, completeCalendarOAuth, DEFAULT_RETURN_PATH, encodeCalendarNotice, PROVIDER_LABELS, type CalendarNotice } from "@/server/calendars/connections";
import { syncConnectionBusy } from "@/server/calendars/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Where Google or Microsoft send the browser back after sign-in. The state must be one this signed-in person started in the last ten
 * minutes and not used before; then the code is exchanged, the calendar is tested, and only a working connection is saved. The first busy
 * sync runs straight away so the screen shows real results. The code and tokens are never shown or logged; a failure is reported as a
 * short message (at most the provider's error code, never its response).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "google" && provider !== "microsoft") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const base = env().APP_URL.replace(/\/+$/, "");
  const q = req.nextUrl.searchParams;
  const finish = (path: string, notice: CalendarNotice) => {
    const res = NextResponse.redirect(`${base}${path}`, { status: 303 });
    res.cookies.set(CALENDAR_NOTICE_COOKIE, encodeCalendarNotice(notice), CALENDAR_NOTICE_COOKIE_OPTIONS);
    // The sign-in code is in this URL: never let it travel on as a referrer, and never cache the response.
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(DEFAULT_RETURN_PATH)}`, { status: 303 });
  try {
    const out = await completeCalendarOAuth(user, provider, { state: q.get("state"), code: q.get("code"), error: q.get("error") });
    if (out.outcome === "denied") return finish(out.returnPath, { kind: "info", provider, message: `${PROVIDER_LABELS[provider]} wasn't connected because the sign-in was cancelled.` });
    if (out.connectionId) await syncConnectionBusy(out.connectionId).catch(() => undefined);
    return finish(out.returnPath, { kind: "success", provider, message: `${PROVIDER_LABELS[provider]} is connected.` });
  } catch (err) {
    return finish(DEFAULT_RETURN_PATH, { kind: "error", provider, message: toPublicError(err).message });
  }
}
