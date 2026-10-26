import { handlePay, methodNotAllowed } from "@/server/invoices/public-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The customer pressed "Pay online". The invoice's link is in the x-invoice-token header and is the only thing read: the amount is always the invoice's balance as the
// server works it out. The answer is the address of the provider's own payment page, which the page then navigates to (a form post could not follow it: the site's
// policy only lets forms post to itself).
export async function POST(req: Request) {
  return handlePay(req);
}

export async function GET() {
  return methodNotAllowed("POST");
}
