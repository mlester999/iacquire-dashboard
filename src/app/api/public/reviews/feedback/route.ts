import { submitReviewFeedback } from "@/server/crm/reviews";
import { reviewsPublicDisabled } from "@/server/reputation/entitlement";
import { formFields, NO_STORE, pagePath, seeOther } from "@/app/api/public/reviews/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The private feedback form on a customer's review page (/r/<token>). Works without JavaScript: the form posts here and the customer is
 * sent back to their page with the outcome. The token in the form is the only authorization; it can only add feedback to its own request,
 * once. Whatever is sent, the page keeps showing the same public review links.
 */
export async function POST(req: Request) {
  const fields = await formFields(req);
  if (!fields) return new Response(null, { status: 413, headers: NO_STORE });
  const token = fields.get("t");
  // The emergency switch (REVIEWS_PUBLIC_DISABLED): back to the page, which says it is unavailable. Nothing is read or recorded.
  if (reviewsPublicDisabled()) return seeOther(pagePath(token, "unavailable"));
  try {
    const { outcome } = await submitReviewFeedback(token ?? "", { rating: fields.get("rating"), comment: fields.get("comment") });
    return seeOther(pagePath(token, outcome));
  } catch (err) {
    console.error("[iacquire] review feedback failed", { type: err instanceof Error ? err.name : "unknown" });
    return seeOther(pagePath(token, "error"));
  }
}

/** Opening this address only goes back to the page: nothing is recorded by a GET. */
export async function GET(req: Request) {
  return seeOther(pagePath(new URL(req.url).searchParams.get("t")));
}
