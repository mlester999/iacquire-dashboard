import { NextResponse } from "next/server";
import { requestMeta } from "@/server/auth/session";
import { hashIp } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { getPublicMaintenancePlan, listPublicServices } from "@/server/catalog/service";
import { CORE_OFFER } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * Read-only catalog feed for the public iAcquire marketing site. It carries only what the agency has
 * published, keeps the core offer, optional maintenance and optional add-ons apart, and exposes no internal fields.
 */
export async function GET() {
  const meta = await requestMeta();
  const limit = await consumeRateLimit(RATE_LIMITS.publicContentByIp, hashIp(meta.ip) ?? "unknown");
  if (!limit.allowed) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  const [services, maintenance] = await Promise.all([listPublicServices(), getPublicMaintenancePlan()]);
  return NextResponse.json(
    {
      core: { ...CORE_OFFER, optionalAddOns: false },
      maintenance,
      addOns: {
        note: "Optional. Never required to use the core system. Starting prices and typical ranges; every custom project is quoted after review.",
        services: services.filter((s) => s.kind !== "maintenance_plan"),
      },
    },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600", "Access-Control-Allow-Origin": "*" } },
  );
}
