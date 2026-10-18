import { withSystem } from "@/server/db";
import { moveOpportunity } from "@/server/crm/opportunities";
import { apiHandler, readJson, uuidParam } from "../../../_lib/http";
import { opportunityOr404 } from "../../../_lib/resources";
import { stageMoveSchema } from "../../../_lib/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/crm/opportunities/{id}/stage: { "stageId", "lostReason"?, "version"? }. A won or lost stage closes the deal (lost needs a
 * reason). Moving to the stage the deal is already in changes nothing, so a retried request is harmless. Reopening a closed deal isn't
 * available to API keys.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiHandler(req, ["opportunities.write"], async ({ actor }) => {
    const dealId = uuidParam(id, "Deal");
    const body = await readJson(req, stageMoveSchema);
    const moved = await moveOpportunity(actor, dealId, { stageId: body.stageId, lostReason: body.lostReason ?? null, expectedVersion: body.version });
    const deal = await withSystem((db) => opportunityOr404(db, actor.orgId, dealId));
    return { body: { data: deal, changed: moved.changed } };
  });
}
