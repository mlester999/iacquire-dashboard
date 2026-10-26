import { handleCapture, methodNotAllowed } from "@/server/invoices/public-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The customer came back from a provider where approving does not take the money by itself (PayPal). The page asks the server to take the payment they approved. The
// server checks the approved checkout against the one it stored, and what the provider answers becomes a receipt like any other: nothing is counted by this request.
export async function POST(req: Request) {
  return handleCapture(req);
}

export async function GET() {
  return methodNotAllowed("POST");
}
