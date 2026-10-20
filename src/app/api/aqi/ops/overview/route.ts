import { getOpsOverview } from "@/server/aqi/ops/overview";
import { opsError, opsJson, requireOpsAdmin } from "@/server/aqi/ops/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Super Admin only. Requested when the page opens and on an explicit Refresh: never polled. */
export async function GET() {
  try {
    await requireOpsAdmin();
    return opsJson(await getOpsOverview());
  } catch (err) {
    return opsError(err);
  }
}
