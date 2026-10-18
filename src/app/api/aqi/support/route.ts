import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { createAqiSupportTicket } from "@/server/aqi/support";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const parsed = z.object({
      conversationId: z.string().uuid(),
      subject: z.string().trim().max(160).optional(),
      consent: z.literal(true),
    }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Explicit consent and a valid conversation are required." }, { status: 400 });
    const result = await createAqiSupportTicket(viewer, parsed.data.conversationId, parsed.data.subject ?? "", true);
    return NextResponse.json(result, { status: result.existing ? 200 : 201 });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
