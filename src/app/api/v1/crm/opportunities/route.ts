import { withSystem } from "@/server/db";
import { assertCan } from "@/server/crm/actor";
import { createOpportunityInTx } from "@/server/crm/opportunities";
import { ApiError, apiHandler, createOnce, dateParam, decodeCursor, pageLimit, readJson } from "../_lib/http";
import { listOpportunitiesPage, opportunityOr404 } from "../_lib/resources";
import { OPPORTUNITY_STATUSES, opportunityCreateSchema, toOpportunityInput } from "../_lib/schemas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idParam(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  if (!v) return null;
  if (!UUID.test(v)) throw new ApiError(400, "invalid_request", `${name} must be an id the API returned.`);
  return v;
}

/** GET /api/v1/crm/opportunities: newest first. ?pipeline_id= ?stage_id= ?status=open|won|lost ?contact_id= ?updated_since= ?limit= ?cursor= */
export async function GET(req: Request) {
  return apiHandler(req, ["opportunities.read", "opportunities.write"], async ({ actor }) => {
    assertCan(actor, "sales.view");
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    if (status && !(OPPORTUNITY_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "invalid_request", "status must be open, won or lost.");
    const page = await withSystem((db) =>
      listOpportunitiesPage(db, actor.orgId, {
        limit: pageLimit(url), cursor: decodeCursor(url), pipelineId: idParam(url, "pipeline_id"), stageId: idParam(url, "stage_id"), status, contactId: idParam(url, "contact_id"),
        updatedSince: dateParam(url, "updated_since"),
      }),
    );
    return { body: page };
  });
}

/**
 * POST /api/v1/crm/opportunities: creates a deal in an open stage (the pipeline's first stage, or the default pipeline, when not given),
 * validated like a deal created in the CRM. Supports Idempotency-Key.
 */
export async function POST(req: Request) {
  return apiHandler(req, ["opportunities.write"], async (ctx) => {
    assertCan(ctx.actor, "opportunities.edit");
    const body = await readJson(req, opportunityCreateSchema);
    const created = await createOnce(ctx, {
      auditAction: "crm.opportunity_created",
      targetType: "crm_opportunity",
      body,
      create: (db) => createOpportunityInTx(db, ctx.actor, toOpportunityInput(body), { via: "api" }),
    });
    const deal = await withSystem((db) => opportunityOr404(db, ctx.actor.orgId, created.id));
    return { status: 201, body: { data: deal }, headers: created.replayed ? { "Idempotent-Replayed": "true" } : undefined };
  });
}
