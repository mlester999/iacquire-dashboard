import { listPipelines } from "@/server/crm/pipelines";
import { apiHandler } from "../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/crm/pipelines: every active pipeline with its stages in order, so callers can create deals in and move them to a stage. */
export async function GET(req: Request) {
  return apiHandler(req, ["opportunities.read", "opportunities.write"], async ({ actor }) => {
    const pipelines = await listPipelines(actor);
    return {
      body: {
        data: pipelines.map((p) => ({
          id: p.id, name: p.name, isDefault: p.isDefault,
          stages: p.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind, position: s.position, probability: s.probability })),
        })),
      },
    };
  });
}
