import { recordReviewClick } from "@/server/crm/reviews";
import { formFields, NO_STORE, pagePath, seeOther } from "@/app/api/public/reviews/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A public review link chosen on a customer's review page. Records that the customer opened it, then sends them on to the review site.
 * The address always comes from the business's own list of links (by id), never from the request, so this can't be used to redirect
 * anyone anywhere else. The redirect carries no referrer, so the review site never sees the customer's private page address.
 */
export async function POST(req: Request) {
  const fields = await formFields(req, 200);
  if (!fields) return new Response(null, { status: 413, headers: NO_STORE });
  const token = fields.get("t");
  try {
    const hit = await recordReviewClick(token ?? "", fields.get("d") ?? "");
    return hit ? seeOther(hit.url) : seeOther(pagePath(token, "link_missing"));
  } catch (err) {
    console.error("[iacquire] review link click failed", { type: err instanceof Error ? err.name : "unknown" });
    return seeOther(pagePath(token, "error"));
  }
}

export async function GET(req: Request) {
  return seeOther(pagePath(new URL(req.url).searchParams.get("t")));
}
