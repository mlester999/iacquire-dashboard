import { backToPage, handleCode, handleDecide, handleVerify, handleView, NO_STORE } from "@/server/proposals/public-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The customer's proposal page posts here: the "viewed" beacon, asking for the emailed code, entering it, and the answer. Each form works without JavaScript and is sent back to
// the page with the outcome. The token in the address is the only authorization; it reaches only its own proposal (see src/server/proposals/public.ts).
export async function POST(req: Request, { params }: { params: Promise<{ token: string; action: string }> }) {
  const { token, action } = await params;
  switch (action) {
    case "view":
      return handleView(req, token);
    case "code":
      return handleCode(req, token);
    case "verify":
      return handleVerify(req, token);
    case "decide":
      return handleDecide(req, token);
    default:
      return new Response("Not found.", { status: 404, headers: NO_STORE });
  }
}

/** Opening one of these addresses only goes back to the page: nothing is recorded by a GET. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string; action: string }> }) {
  const { token } = await params;
  return backToPage(token);
}
