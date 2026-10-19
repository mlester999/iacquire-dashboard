import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import {
  dismissAqiTip,
  getAqiContextualTip,
  recordAqiTipClick,
  recordAqiTipView,
  setAqiTipsEnabled,
} from "@/server/aqi/onboarding";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const viewer = await resolveAqiViewer();
    const path = new URL(request.url).searchParams.get("path");
    const result = await getAqiContextualTip(viewer, path);
    if (result.tip) await recordAqiTipView(viewer, result.tip.slug, path);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dismiss"), slug: z.string().min(3).max(80) }),
  z.object({ action: z.literal("enable"), enabled: z.boolean() }),
  z.object({ action: z.literal("click"), slug: z.string().min(3).max(80), pathname: z.string().max(300).nullable().optional() }),
]);

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "That tip action is not valid." }, { status: 400 });
    if (parsed.data.action === "dismiss") await dismissAqiTip(viewer, parsed.data.slug);
    else if (parsed.data.action === "enable") await setAqiTipsEnabled(viewer, parsed.data.enabled);
    else await recordAqiTipClick(viewer, parsed.data.slug, parsed.data.pathname ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
}
