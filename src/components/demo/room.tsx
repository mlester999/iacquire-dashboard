import * as React from "react";
import { Hourglass, Info, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { DemoActions } from "@/components/demo/actions";
import { DemoChat } from "@/components/demo/chat";
import { LocalTime } from "@/components/demo/local-time";
import { PricingPanel } from "@/components/demo/pricing";
import { DemoNotice } from "@/components/demo/shell";
import { DemoTour } from "@/components/demo/tour";
import { ROOM_COPY, type Notice } from "@/lib/demo/outcomes";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import { TOUR } from "@/lib/demo/tour";
import type { RoomView } from "@/server/demo/public";

// The demo room, rendered from the service's view only: the prospect's own window, their message count and their stored conversation, plus the same static tour, prices and buttons
// for everyone. Nothing in the view names an email address, an id or any other prospect. Everything on the page that states a condition (open until, messages left, chat not open)
// is read from the view, which is read from the record.

export function DemoRoom({
  room,
  messageNotice,
  ctaNotice,
  fallbackMessageId,
}: {
  room: RoomView;
  /** The result of a form without scripts, only where the record agrees with it (src/lib/demo/outcomes.ts). */
  messageNotice: Notice | null;
  ctaNotice: Notice | null;
  fallbackMessageId: string;
}) {
  const open = room.access === "open";
  const roles = TOUR.map((s) => ({ key: s.role, name: s.meta.name }));
  const showChat = room.chat.aiEnabled || room.transcript.length > 0;
  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="break-words text-[24px] font-semibold leading-tight tracking-[-0.04em] text-ink sm:text-[28px]">Welcome, {room.firstName}</h1>
        {room.business && (
          <p className="break-words text-[14px] text-muted">
            {room.business}
            {room.industryLabel ? `, ${room.industryLabel}` : ""}
          </p>
        )}
        <p className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft px-3 py-2 text-[14px] leading-relaxed text-warning-ink">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{ROOM_COPY.sampleBanner}</span>
        </p>
      </header>

      <section aria-label="Your demo window" className="card-surface rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={open ? "success" : "neutral"}>{open ? "Open" : "Ended"}</Badge>
          {room.extended && <Badge tone="primary">Extended</Badge>}
        </div>
        {open && room.windowEndsAt ? (
          <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
            Your demo is open until <LocalTime iso={room.windowEndsAt} />.
            {room.chat.aiEnabled && (
              <>
                {" "}
                You have {room.messagesLeft} of {room.messageAllowance} messages left.
              </>
            )}
          </p>
        ) : (
          <p className="mt-2 flex items-start gap-2 text-[14px] leading-relaxed text-ink-2">
            <Hourglass className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span>
              {REFUSAL_COPY.window_ended}
              {room.windowEndsAt ? (
                <>
                  {" "}
                  It ended <LocalTime iso={room.windowEndsAt} />.
                </>
              ) : null}
            </span>
          </p>
        )}
      </section>

      <DemoTour />

      <section id="chat" aria-labelledby="chat-heading" className="card-surface scroll-mt-4 space-y-3 rounded-2xl p-4 sm:p-5">
        <div>
          <h2 id="chat-heading" className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.02em] text-ink">
            <MessageSquareText className="size-5 text-primary" aria-hidden />
            {room.chat.aiEnabled ? ROOM_COPY.chatHeading : ROOM_COPY.chatOffHeading}
          </h2>
          {room.chat.aiEnabled && <p className="mt-1 text-[14px] leading-relaxed text-muted">{ROOM_COPY.chatIntro}</p>}
        </div>
        {showChat ? (
          <DemoChat
            initial={{ transcript: room.transcript, messagesLeft: room.messagesLeft, messageAllowance: room.messageAllowance, canSend: room.chat.canSend, refusalMessage: room.chat.refusalMessage }}
            roles={roles}
            fallbackMessageId={fallbackMessageId}
            pageNotice={messageNotice}
          />
        ) : (
          <>
            <DemoNotice notice={messageNotice} />
            <p role="status" className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
              {room.chat.refusalMessage ?? REFUSAL_COPY.ai_off}
            </p>
          </>
        )}
      </section>

      <PricingPanel pricing={room.pricing} />
      <DemoActions consultationRequested={room.consultationRequested} purchaseStarted={room.purchaseStarted} consultationUrl={room.consultationUrl} notice={ctaNotice} />

      <footer className="space-y-3 border-t border-line pt-4 text-[14px] leading-relaxed text-muted">
        <form method="post" action="/api/public/demo/leave">
          <Button type="submit" variant="ghost" size="sm">
            {ROOM_COPY.leaveButton}
          </Button>
        </form>
        <p>{ROOM_COPY.erasure}</p>
      </footer>
    </div>
  );
}
