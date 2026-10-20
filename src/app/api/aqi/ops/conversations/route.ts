import { listOpsConversations } from "@/server/aqi/ops/conversations";
import { opsError, opsJson, requireOpsAdmin } from "@/server/aqi/ops/http";

export const dynamic = "force-dynamic";

/** The administrator's investigation history. Never shared with the Client assistant's history. */
export async function GET(request: Request) {
  try {
    const user = await requireOpsAdmin();
    const params = new URL(request.url).searchParams;
    const before = params.get("before");
    return opsJson(await listOpsConversations(user, {
      query: params.get("q"),
      before: before && !Number.isNaN(Date.parse(before)) ? before : null,
      limit: Number(params.get("limit")) || undefined,
    }));
  } catch (err) {
    return opsError(err);
  }
}
