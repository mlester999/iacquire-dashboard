import "server-only";
import { looksLikeReviewToken } from "@/server/crm/reviews";

// Shared by the customer review page's two form endpoints. The token is the only authorization; nothing here reads a session.

export const MAX_BODY_BYTES = 16_384;
export const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };

/** A 303 to a path on this site (relative, so the request's own host serves it) or to a review site's own address. */
export const seeOther = (location: string) => new Response(null, { status: 303, headers: { ...NO_STORE, Location: location } });

/** The customer's page for a token, or the generic invalid page when the value isn't token-shaped. */
export const pagePath = (token: string | null | undefined, result?: string) => `/r/${looksLikeReviewToken(token) ? token : "invalid"}${result ? `?r=${encodeURIComponent(result)}` : ""}`;

/** The posted form fields (urlencoded or multipart), each value cut to `max` characters. */
export async function formFields(req: Request, max = 4000): Promise<URLSearchParams | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (type.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const out = new URLSearchParams();
      for (const [k, v] of form.entries()) if (typeof v === "string") out.append(k, v.slice(0, max));
      return out;
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    return new URLSearchParams(text);
  } catch {
    return new URLSearchParams();
  }
}
