import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Hourglass, Link2Off } from "lucide-react";
import Link from "next/link";
import { requestMeta } from "@/server/auth/session";
import { getRoom } from "@/server/demo/public";
import { demoModelState } from "@/server/demo/generator";
import { DEMO_COOKIE } from "@/server/demo/tokens";
import { DemoRoom } from "@/components/demo/room";
import { DemoMessage, linkClass } from "@/components/demo/shell";
import { ctaNotice, messageNotice } from "@/lib/demo/outcomes";
import { newClientMessageId } from "@/lib/demo/room-types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your demo", robots: { index: false, follow: false }, referrer: "no-referrer" };

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The demo room for the browser's own demo session. A browser with no session (or an ended one) is sent to the request page, which says what to do; a stopped demo says so here.
 * What the page states about the prospect's window and messages is the record's, and the words in the address (`m`, `c`) are shown only where the record agrees with them.
 */
export default async function DemoRoomPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const meta = await requestMeta();
  const jar = await cookies();
  const result = await getRoom({
    ip: meta.ip,
    userAgent: meta.userAgent,
    sessionToken: jar.get(DEMO_COOKIE)?.value ?? null,
    modelReady: async () => (await demoModelState()).ready,
  });
  if (!result.ok) {
    if (result.reason === "no_session") redirect("/demo?r=no_session");
    return (
      <DemoMessage icon={result.reason === "rate_limited" ? Hourglass : Link2Off} title={result.reason === "not_available" ? "The demo is not open" : "The demo is not available"}>
        <p>{result.message}</p>
        <p>
          <Link href="/demo" className={linkClass}>
            Back to the demo page
          </Link>
        </p>
      </DemoMessage>
    );
  }
  const room = result.room;
  const facts = { access: room.access, messagesLeft: room.messagesLeft, chatRefusal: room.chat.refusal, consultationRequested: room.consultationRequested, purchaseStarted: room.purchaseStarted };
  return <DemoRoom room={room} messageNotice={messageNotice(one(q.m), facts)} ctaNotice={ctaNotice(one(q.c), facts)} fallbackMessageId={newClientMessageId()} />;
}
