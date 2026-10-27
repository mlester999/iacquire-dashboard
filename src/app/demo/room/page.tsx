import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Hourglass, Link2Off } from "lucide-react";
import Link from "next/link";
import { requestMeta } from "@/server/auth/session";
import { getRoom } from "@/server/demo/public";
import { demoModelState } from "@/server/demo/generator";
import { DEMO_COOKIE } from "@/server/demo/tokens";
import { getPublicMaintenancePlan } from "@/server/catalog/service";
import { Workspace } from "@/components/demo/showroom/workspace";
import { DemoMessage, PublicFrame, linkClass } from "@/components/demo/shell";
import { ctaNotice, messageNotice } from "@/lib/demo/outcomes";
import { newClientMessageId } from "@/lib/demo/room-types";
import { isViewId } from "@/lib/demo/showroom/content";
import { isConfirmKind } from "@/lib/demo/showroom/confirm-copy";
import { scenarioFor } from "@/lib/demo/showroom/industry";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your demo", robots: { index: false, follow: false }, referrer: "no-referrer" };

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** The published plan's own list, for the pricing view. A catalog that cannot be read only makes that view use its fixed wording; it never stops the room. */
async function planFacts() {
  try {
    const plan = await getPublicMaintenancePlan();
    return { included: plan && plan.included.length > 0 ? plan.included : null, monthlyRequestAllowance: plan?.monthlyRequestAllowance ?? null };
  } catch {
    return { included: null, monthlyRequestAllowance: null };
  }
}

/**
 * The demo room for the browser's own demo session. A browser with no session (or an ended one) is sent to the request page, which says what to do; a stopped demo says so here.
 * What the page states about the prospect's window and messages is the record's, and the words in the address (`m`, `c`) are shown only where the record agrees with them. The view
 * (`view`) only chooses which part of the showroom opens first; it grants and changes nothing.
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
      <PublicFrame>
        <DemoMessage icon={result.reason === "rate_limited" ? Hourglass : Link2Off} title={result.reason === "not_available" ? "The demo is not open" : "The demo is not available"}>
          <p>{result.message}</p>
          <p>
            <Link href="/demo" className={linkClass}>
              Back to the demo page
            </Link>
          </p>
        </DemoMessage>
      </PublicFrame>
    );
  }
  const room = result.room;
  const facts = { access: room.access, messagesLeft: room.messagesLeft, chatRefusal: room.chat.refusal, consultationRequested: room.consultationRequested, purchaseStarted: room.purchaseStarted };
  const view = one(q.view);
  const asked = one(q.confirm);
  // A confirmation the address asks for opens only while that request has not been recorded.
  const initialConfirm = isConfirmKind(asked) && !(asked === "consultation" ? room.consultationRequested : room.purchaseStarted) ? asked : null;
  return (
    <Workspace
      initialView={isViewId(view) ? view : "overview"}
      state={{
        firstName: room.firstName,
        business: room.business,
        industryLabel: room.industryLabel,
        scenario: scenarioFor(room.industry),
        access: room.access,
        windowEndsAt: room.windowEndsAt,
        extended: room.extended,
        messagesLeft: room.messagesLeft,
        messageAllowance: room.messageAllowance,
        aiEnabled: room.chat.aiEnabled,
        consultationRequested: room.consultationRequested,
        consultationUrl: room.consultationUrl,
        purchaseStarted: room.purchaseStarted,
        setupFeeUsd: room.pricing.setupFeeUsd,
        monthlyPlanUsd: room.pricing.monthlyPlanUsd,
        plan: await planFacts(),
        ctaNotice: ctaNotice(one(q.c), facts),
        initialConfirm,
      }}
      chat={{
        initial: { transcript: room.transcript, messagesLeft: room.messagesLeft, messageAllowance: room.messageAllowance, canSend: room.chat.canSend, refusalMessage: room.chat.refusalMessage },
        fallbackMessageId: newClientMessageId(),
        pageNotice: messageNotice(one(q.m), facts),
        show: room.chat.aiEnabled || room.transcript.length > 0,
      }}
    />
  );
}
