import { AppError } from "@/server/errors";
import { sameSite } from "@/server/invoices/public-http";
import { completeSimulatedCheckout, type SimulatedChoice } from "@/server/customer-payments/dev-checkout";
import { simulatedAllowed } from "@/server/customer-payments/switches";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } as const;
const CHOICES: readonly SimulatedChoice[] = ["pay", "decline", "cancel"];

/** Development only. The testing checkout's buttons post here; the answer sends the customer to the page a real provider would. Returns 404 in production. */
export async function POST(req: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  if (!simulatedAllowed()) return new Response("Not found", { status: 404, headers: NO_STORE });
  if (!sameSite(req)) return new Response("Not allowed", { status: 403, headers: NO_STORE });
  const { attemptId } = await params;
  const form = await req.formData().catch(() => null);
  const choice = form?.get("choice");
  if (typeof choice !== "string" || !(CHOICES as readonly string[]).includes(choice)) return new Response("Choose pay, decline or cancel.", { status: 400, headers: NO_STORE });
  try {
    const origin = new URL(req.url).origin;
    const done = await completeSimulatedCheckout(attemptId, choice as SimulatedChoice, { origin });
    const back = `/pay/return/${done.reference}${done.cancelled ? "?result=cancelled" : ""}`;
    return new Response(null, { status: 303, headers: { ...NO_STORE, Location: back } });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.status, headers: NO_STORE });
    throw e;
  }
}
