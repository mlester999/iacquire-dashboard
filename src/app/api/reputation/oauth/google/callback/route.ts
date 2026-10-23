import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { getCurrentUser } from "@/server/auth/session";
import { completeGoogleConnect, DEFAULT_RETURN } from "@/server/reputation/connections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What the Reviews settings screen can say about a sign-in that did not finish. A fixed set of codes, never text from the address. */
type SignInNotice = "denied" | "expired" | "not_enabled" | "forbidden" | "failed";

const noticeFor = (err: unknown): SignInNotice => {
  if (!(err instanceof AppError)) return "failed";
  return err.code === "forbidden" ? "forbidden" : err.code === "not_enabled" ? "not_enabled" : err.code === "invalid_input" ? "expired" : "failed";
};

/**
 * Where Google sends the browser back after sign-in. The state must be one this signed-in person started in the last ten minutes and not used before; then the code is exchanged
 * and the locations the person manages are read for them to choose from. Nothing is connected here. The code and tokens are never shown or logged, and the response is never
 * cached or passed on as a referrer.
 */
export async function GET(req: NextRequest) {
  const base = env().APP_URL.replace(/\/+$/, "");
  const q = req.nextUrl.searchParams;
  const finish = (path: string, params: Record<string, string>) => {
    const u = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = NextResponse.redirect(u.toString(), { status: 303 });
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(DEFAULT_RETURN)}`, { status: 303 });
  try {
    const out = await completeGoogleConnect(user, { state: q.get("state"), code: q.get("code"), error: q.get("error") });
    if (out.outcome === "denied") return finish(out.returnPath, { site: "denied" });
    return finish(out.returnPath, { choose: out.stateId as string });
  } catch (err) {
    return finish(DEFAULT_RETURN, { site: noticeFor(err) });
  }
}
