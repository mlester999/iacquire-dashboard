import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { aqiSupportSubmitSchema, createAqiSupportTicket, submitAqiSupportRequest } from "@/server/aqi/support";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/**
 * Creates the support request the person reviewed in AQi. The browser can send only what the person typed and chose; the conversation
 * excerpt is rebuilt on the server from the stored conversation, and is included only when `consent` is true. The earlier body
 * ({ conversationId, subject, consent: true }) still works and always shares the excerpt, so it still requires consent.
 */
export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const body = await request.json().catch(() => null);
    if (body && typeof body === "object" && "description" in body) {
      const result = await submitAqiSupportRequest(viewer, body as z.input<typeof aqiSupportSubmitSchema>);
      return NextResponse.json(result, { status: result.existing ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
    }
    const parsed = z.object({ conversationId: z.string().uuid(), subject: z.string().trim().max(160).optional(), consent: z.literal(true) }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Explicit consent and a valid conversation are required." }, { status: 400 });
    const result = await createAqiSupportTicket(viewer, parsed.data.conversationId, parsed.data.subject ?? "", true);
    return NextResponse.json(result, { status: result.existing ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
