import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { completeHermesProvisionerJob, constantTimeProvisionerTokenMatches } from "@/server/workforce/hermes-provisioner";
import { provisionerAuthorized, provisionerErrorResponse, readProvisionerJson } from "@/server/workforce/provisioner-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

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
    const body = await readProvisionerJson(req, 256_000);
    const result = await completeHermesProvisionerJob(body, config.HERMES_PROVISIONER_GATEWAY_ID);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const result = provisionerErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  }
}
