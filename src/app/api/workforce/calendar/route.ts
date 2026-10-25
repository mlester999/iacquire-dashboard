import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkforceContextOrThrow } from "@/server/workforce/workspace-access";
import { toPublicError } from "@/server/errors";
import { getWorkforceCalendarData } from "@/server/workforce/calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isoInstant = z.iso.datetime({ offset: true });

function parseInstant(value: string | null): Date | null {
  if (!value) return null;
  const result = isoInstant.safeParse(value);
  return result.success ? new Date(result.data) : null;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const from = parseInstant(url.searchParams.get("from"));
    const to = parseInstant(url.searchParams.get("to"));
    if (!from || !to) {
      return NextResponse.json(
        { error: "Choose a valid start and end date for the workforce calendar.", code: "invalid_input" },
        { status: 400, headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const ctx = await requireWorkforceContextOrThrow();
    const calendar = await getWorkforceCalendarData(ctx, { from, to });
    return NextResponse.json({ calendar }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    const error = toPublicError(err);
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
