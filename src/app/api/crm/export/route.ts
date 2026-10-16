import { NextResponse } from "next/server";
import { toPublicError } from "@/server/errors";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { resolveCrmActor } from "@/server/crm/request";
import { exportContactsCsv } from "@/server/crm/exports";
import { decodeFilter } from "@/lib/crm/filter-codec";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Downloads contacts as CSV: all contacts, a saved Smart List, or a search. The workspace comes from the verified session (an agency person
 * names the client and needs a support session, which never includes export rights). Needs the export permission; each export is recorded.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgParam = url.searchParams.get("org");
    const list = url.searchParams.get("list");
    const actor = await resolveCrmActor(orgParam && UUID.test(orgParam) ? orgParam : null, "contacts.export");
    const limit = await consumeRateLimit({ name: "crm-export", limit: 10, windowSeconds: 600 }, actor.userId ?? actor.orgId);
    if (!limit.allowed) return NextResponse.json({ error: "Too many exports in a short time. Please wait a few minutes." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 600) } });
    const query = {
      smartListId: list && UUID.test(list) ? list : null,
      filter: decodeFilter(url.searchParams.get("f") ?? undefined) ?? undefined,
      search: url.searchParams.get("q")?.slice(0, 120) || undefined,
      archived: (["only", "include"].includes(url.searchParams.get("archived") ?? "") ? url.searchParams.get("archived") : "exclude") as "exclude" | "only" | "include",
    };
    const iterator = exportContactsCsv(actor, query);
    // Pull the first chunk before answering, so a permission or filter problem is a clean error rather than a broken download.
    const first = await iterator.next();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("﻿"));
        if (!first.done) controller.enqueue(encoder.encode(first.value));
      },
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="contacts-${day}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const e = toPublicError(err);
    return NextResponse.json({ error: e.message }, { status: e.status, headers: { "Cache-Control": "no-store" } });
  }
}
