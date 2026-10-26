import { handleStatus, methodNotAllowed } from "@/server/invoices/public-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Where a payment stands, asked by a page that stays open after the customer comes back from the provider. Never cached. "Paid" and "received" are the database's words.
export async function GET(req: Request) {
  return handleStatus(req);
}

export async function POST() {
  return methodNotAllowed("GET");
}
