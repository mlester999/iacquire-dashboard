import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireUserOrThrow } from "@/server/auth/session";
import { getOrgContext } from "@/server/tenancy/context";
import { askHelp, helpAiAvailable, recentHelpMessages } from "@/server/help/service";
import { toPublicError } from "@/server/errors";
import { firstName } from "@/lib/utils";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ question: z.string().max(1000) });

export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    const user = await requireUserOrThrow();
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const ctx = await getOrgContext();
    const answer = await askHelp(ctx, user.id, firstName(user.fullName), parsed.data.question);
    return NextResponse.json(answer);
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
}

export async function GET() {
  try {
    const user = await requireUserOrThrow();
    const [messages, aiAvailable] = await Promise.all([recentHelpMessages(user.id), helpAiAvailable()]);
    return NextResponse.json({ messages, aiAvailable });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
