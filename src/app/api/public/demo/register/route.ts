import { handleDemoRegistration } from "@/server/demo/registration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The existing service sends the verification email before it answers, so the ceiling is the email provider's timeout plus the database work.
export const maxDuration = 30;

// The marketing website's server-to-server way into the existing demo funnel. Signed with a shared secret (HMAC-SHA256) over the exact body, a short clock window, a request id
// kept by the database, a body bound and its own rate limits. The full contract is docs/demo-external-registration.md.
//
// This route deliberately does NOT use the demo's browser API (src/server/demo/http.ts): that one refuses cross-site POSTs and answers a form, while this one is for another
// server and answers JSON only. There is no CORS header: a browser on another site can neither read the answer nor get permission to make the request.
export async function POST(req: Request): Promise<Response> {
  return handleDemoRegistration(req);
}

export async function GET(): Promise<Response> {
  return Response.json(
    { ok: false, error: { code: "bad_request", message: "Use POST." } },
    { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

export const HEAD = GET;
