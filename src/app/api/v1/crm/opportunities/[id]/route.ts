import { withSystem } from "@/server/db";
import { assertCan } from "@/server/crm/actor";
import { apiHandler, uuidParam } from "../../_lib/http";
import { opportunityOr404 } from "../../_lib/resources";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/crm/opportunities/{id} */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiHandler(req, ["opportunities.read", "opportunities.write"], async ({ actor }) => {
    assertCan(actor, "sales.view");
    const dealId = uuidParam(id, "Deal");
    return { body: { data: await withSystem((db) => opportunityOr404(db, actor.orgId, dealId)) } };
  });
}
