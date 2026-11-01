import { after, NextResponse } from "next/server";
import { env } from "@/server/env";
import { completeHermesProvisionerJob, constantTimeProvisionerTokenMatches } from "@/server/workforce/hermes-provisioner";
import { runPostProvisionCheck } from "@/server/workforce/first-health-check";
import { provisionerAuthorized, provisionerErrorResponse, readProvisionerJson } from "@/server/workforce/provisioner-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job id of a body the completion has already accepted (it was validated as a UUID there); anything else yields null and no check is scheduled. */
function jobIdOf(body: unknown): string | null {
  const id = typeof body === "object" && body !== null ? (body as { jobId?: unknown }).jobId : null;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

/**
 * Starts the portal's first health check for the employee this completion just handed over, after the response has gone, so the worker never waits for it. Best effort and
 * never a part of the answer: if after() cannot be used here (outside a request scope, or a platform without it) the provisioning watchdog follows up within minutes, and a check
 * that fails is recorded by the check itself and leaves the job open.
 */
function startFirstHealthCheck(jobId: string) {
  try {
    after(async () => {
      try {
        await runPostProvisionCheck(jobId);
      } catch {
        console.error("[iacquire] the first health check after provisioning could not run");
      }
    });
  } catch {
    // No request scope: the watchdog's follow-up covers it.
  }
}

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
    // Only a first, accepted success starts a check: a replayed completion (duplicate) and a reported failure start nothing.
    if ("duplicate" in result && result.duplicate === false && result.awaitingHealthCheck) {
      const jobId = jobIdOf(body);
      if (jobId) startFirstHealthCheck(jobId);
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const result = provisionerErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  }
}
