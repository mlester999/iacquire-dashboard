import { NextResponse } from "next/server";
import { requestMeta } from "@/server/auth/session";
import { hashIp } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { listPublicPortfolio } from "@/server/portfolio/service";
import { FOUNDER_ATTRIBUTION } from "@/lib/projects";

export const dynamic = "force-dynamic";

/** Read-only "Selected Work from Our Founder" feed: reviewed projects with confirmed public disclosure only. */
export async function GET() {
  const meta = await requestMeta();
  const limit = await consumeRateLimit(RATE_LIMITS.publicContentByIp, hashIp(meta.ip) ?? "unknown");
  if (!limit.allowed) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  return NextResponse.json(
    {
      label: FOUNDER_ATTRIBUTION,
      disclaimer: "These projects were built by iAcquire's founder, Mark Lester Acak. They show what can be built; they are not results from iAcquire clients.",
      projects: await listPublicPortfolio(),
    },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600", "Access-Control-Allow-Origin": "*" } },
  );
}
