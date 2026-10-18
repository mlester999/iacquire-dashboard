import { NextResponse } from "next/server";
import { requireAgency } from "@/server/tenancy/context";
import { ensureAgencyPortalAccess } from "@/server/workforce/agency-portal";
import { AGENT_BY_SLUG } from "@/lib/agents";

/** Switch a Super Admin into the internal agency workspace and open the normal chat backend. */
export async function GET(request: Request) {
  const user = await requireAgency("super_admin");
  await ensureAgencyPortalAccess(user);
  const requested = new URL(request.url).searchParams.get("role") ?? "operations-manager";
  const slug = requested in AGENT_BY_SLUG ? requested : "operations-manager";
  return NextResponse.redirect(new URL(`/chat/${slug}`, request.url));
}
