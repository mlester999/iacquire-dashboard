import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/server/env";
import { claimHermesProvisionerWork, constantTimeProvisionerTokenMatches } from "@/server/workforce/hermes-provisioner";
import { recordProvisionerClaimSeen } from "@/server/workforce/provisioning-watchdog";
import { provisionerAuthorized, provisionerErrorResponse, readProvisionerJson } from "@/server/workforce/provisioner-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const claimSchema = z.object({ gatewayId: z.string().uuid() }).strict();
const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };

export async function POST(req: Request) {
  const config = env();
  if (!config.HERMES_PROVISIONER_ENABLED || !config.HERMES_PROVISIONER_TOKEN || !config.HERMES_PROVISIONER_GATEWAY_ID) {
    return NextResponse.json({ error: "The restricted Hermes provisioner is not enabled." }, { status: 503, headers: NO_STORE });
  }
  if (!provisionerAuthorized(req, config.HERMES_PROVISIONER_TOKEN, constantTimeProvisionerTokenMatches)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }
  try {
    const body = claimSchema.safeParse(await readProvisionerJson(req, 2048));
    if (!body.success) return NextResponse.json({ error: "The claim request is invalid." }, { status: 400, headers: NO_STORE });
    if (body.data.gatewayId !== config.HERMES_PROVISIONER_GATEWAY_ID) {
      return NextResponse.json({ error: "The worker is not assigned to this Hermes gateway." }, { status: 403, headers: NO_STORE });
    }
    // The worker is alive whether or not there is a job for it: the liveness row (at most one write a minute, best effort) is what lets the platform notice a silent worker.
    await recordProvisionerClaimSeen();
    const job = await claimHermesProvisionerWork(body.data.gatewayId);
    return NextResponse.json({ job }, { headers: NO_STORE });
  } catch (error) {
    const result = provisionerErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  }
}
