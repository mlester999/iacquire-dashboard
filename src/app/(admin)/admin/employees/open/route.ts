import { NextResponse } from "next/server";
import { requireAgency } from "@/server/tenancy/context";
import { ensureAgencyPortalAccess } from "@/server/workforce/agency-portal";
import { AGENT_BY_SLUG } from "@/lib/agents";

/**
 * Switch a Super Admin into the internal agency workspace, then open the screen the caller asked for:
 * the normal chat backend, or (`to=manage`) the existing employee configuration screen. The target is
 * resolved from the allow-listed slug, never from a free-form URL.
 */
export async function GET(request: Request) {
  const user = await requireAgency("super_admin");
  await ensureAgencyPortalAccess(user);
  const url = new URL(request.url);
  const requested = url.searchParams.get("role") ?? "operations-manager";
  const slug = requested in AGENT_BY_SLUG ? requested : "operations-manager";
  const target = url.searchParams.get("to") === "manage" ? `/employees/${slug}?tab=configure` : `/chat/${slug}`;
  return NextResponse.redirect(new URL(target, request.url));
}
