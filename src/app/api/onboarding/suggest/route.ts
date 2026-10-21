import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { suggestOnboardingAnswer } from "@/server/onboarding/service";
import { assistanceRequestSchema } from "@/lib/onboarding/assistance";
import { toPublicError } from "@/server/errors";

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    if (Number(request.headers.get("content-length")) > 4096) return NextResponse.json({ ok: false, error: "Please keep these details brief." }, { status: 413 });
    const raw = await request.text();
    if (raw.length > 4096) return NextResponse.json({ ok: false, error: "Please keep these details brief." }, { status: 413 });
    const parsed = assistanceRequestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return NextResponse.json({ ok: false, error: "Check the question and optional details, then try again." }, { status: 400 });
    const { questionId, ...options } = parsed.data;
    const data = await suggestOnboardingAnswer(ctx, questionId, options, request.signal);
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof SyntaxError) return NextResponse.json({ ok: false, error: "Check the request and try again." }, { status: 400 });
    const error = toPublicError(err);
    return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "private, no-store", ...(error.status === 429 ? { "Retry-After": "60" } : {}) } });
  }
}
