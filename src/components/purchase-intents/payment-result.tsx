import * as React from "react";
import { RoomShell } from "@/components/purchase-intents/room-shell";
import type { ReturnStage } from "@/lib/purchase-intents/rules";

// What the buyer reads after coming back from the payment provider, as plain presentation: the page (src/app/purchase/return/[reference]/page.tsx) reads the stored status, and this draws
// it. It never decides that a payment happened (only the words from checkoutReturnText, which follow the provider's own confirmation, say so); the glyph and the list of what happens next
// follow the same stage. Kept apart so a development preview can show every state without a payment.

export type ResultStage = ReturnStage | "limited";

type GlyphTone = "good" | "wait" | "warn" | "bad" | "test" | "left";
const TONE_OF: Record<ResultStage, GlyphTone> = { ready: "good", paid: "good", waiting: "wait", left: "left", test: "test", review: "warn", failed: "bad", limited: "warn" };
/** A short word above the title. It says how things stand and never repeats the title, which already says what happened. */
const KICKER_OF: Record<ResultStage, string> = {
  ready: "All set", paid: "Verified", waiting: "In progress", left: "Not finished", test: "Test mode", review: "Under review", failed: "Nothing charged", limited: "Try again soon",
};

interface Next {
  text: string;
  state: "done" | "current" | "todo";
}

/** What happens from here, in words that promise only what the stage already means: a refund or a failure promises nothing about a workspace. */
function nextSteps(stage: ResultStage): Next[] {
  switch (stage) {
    case "waiting":
      return [
        { text: "You came back from the payment page", state: "done" },
        { text: "The payment provider confirms your payment", state: "current" },
        { text: "iAcquire creates your workspace", state: "todo" },
        { text: "Your invitation arrives by email", state: "todo" },
      ];
    case "left":
      return [
        { text: "Nothing is charged until you finish paying", state: "current" },
        { text: "Open the purchase link from your email to try again", state: "todo" },
        { text: "If you did pay, this page changes once the provider confirms it", state: "todo" },
      ];
    case "test":
      return [
        { text: "A payment in the provider's sandbox was recorded", state: "done" },
        { text: "No real money moved", state: "done" },
        { text: "No workspace will be created from it", state: "done" },
      ];
    case "paid":
      return [
        { text: "The payment provider confirmed your payment", state: "done" },
        { text: "iAcquire is creating your workspace", state: "current" },
        { text: "Your invitation arrives by email", state: "todo" },
      ];
    case "ready":
      return [
        { text: "The payment provider confirmed your payment", state: "done" },
        { text: "Your workspace was created", state: "done" },
        { text: "Open the invitation in your email to set a password and start", state: "current" },
      ];
    case "review":
      return [
        { text: "A person at iAcquire is looking at your payment", state: "current" },
        { text: "iAcquire will contact you at the email address on your purchase", state: "todo" },
        { text: "Nothing more is charged", state: "todo" },
      ];
    case "failed":
      return [
        { text: "Nothing was charged", state: "done" },
        { text: "Open your purchase link from the email", state: "current" },
        { text: "Choose how to pay and try again", state: "todo" },
      ];
    case "limited":
      return [
        { text: "Wait a moment", state: "current" },
        { text: "Refresh this page", state: "todo" },
      ];
  }
}

const SPARK_COLORS = ["var(--rm-mint)", "var(--rm-blue)", "var(--rm-violet)"];

/** The big mark over the title. Each is drawn in SVG and animated in CSS; without animation (reduce motion) it is simply the finished picture. */
function Glyph({ tone }: { tone: GlyphTone }) {
  return (
    <div className="room-glyph" data-tone={tone} aria-hidden>
      <span className="room-glyph-halo" />
      <svg viewBox="0 0 120 120" fill="none">
        {tone === "wait" ? (
          <>
            <circle className="room-glyph-track" cx="60" cy="60" r="44" />
            <circle className="room-glyph-arc" cx="60" cy="60" r="44" pathLength={1} />
            <circle cx="60" cy="60" r="22" stroke="rgb(255 255 255 / 0.3)" strokeWidth="3" />
            <path className="room-glyph-hand" d="M60 47 V60 L69 66" />
          </>
        ) : (
          <>
            <circle className="room-glyph-track" cx="60" cy="60" r="44" />
            <circle className="room-glyph-ring" cx="60" cy="60" r="44" pathLength={1} />
            {tone === "good" && <path className="room-glyph-mark" d="M40 62 L54 76 L82 46" pathLength={1} />}
            {tone === "warn" && (
              <>
                <path className="room-glyph-mark" d="M60 38 V65" pathLength={1} />
                <circle className="room-glyph-dot" cx="60" cy="79" r="4" />
              </>
            )}
            {tone === "bad" && <path className="room-glyph-mark" d="M45 45 L75 75 M75 45 L45 75" pathLength={1} />}
            {tone === "left" && <path className="room-glyph-mark" d="M76 60 H46 M46 60 L58 48 M46 60 L58 72" pathLength={1} />}
            {tone === "test" && (
              <>
                <path className="room-glyph-mark" d="M53 38 H67 M55 38 V56 L43 78 Q41 84 47 84 H73 Q79 84 77 78 L65 56 V38" pathLength={1} />
                <circle className="room-glyph-dot" cx="57" cy="72" r="3" />
                <circle className="room-glyph-dot" cx="66" cy="68" r="2.2" />
              </>
            )}
          </>
        )}
      </svg>
      {tone === "good" && Array.from({ length: 12 }, (_, k) => <span key={k} className="room-spark" style={{ "--k": k, "--c": SPARK_COLORS[k % 3] } as React.CSSProperties} />)}
    </div>
  );
}

export function PaymentResultView({ stage, title, body, reference, live }: { stage: ResultStage; title: string; body: string; reference: string | null; live: boolean }) {
  const steps = nextSteps(stage);
  return (
    <RoomShell chip="Payment status" narrow>
      <div className="room-ticket room-in mx-auto max-w-[620px]">
        <div className="room-ticket-top">
          <div className="room-result">
            <Glyph tone={TONE_OF[stage]} />
            <p className="room-label">{KICKER_OF[stage]}</p>
            <h1>{title}</h1>
            <p role="status">{body}</p>
            {reference && <span className="room-ref"><span className="room-ref-k">Payment reference</span> <span className="room-ref-v">{reference}</span></span>}
            {live && (
              <span className="room-live">
                <span className="room-eyebrow-dot" aria-hidden /> Checking again every few seconds
              </span>
            )}
          </div>
        </div>
        <div className="room-ticket-bottom">
          <p className="room-label">What happens next</p>
          <ol className="room-next">
            {steps.map((s, i) => (
              <li key={s.text} data-state={s.state}>
                <span className="room-next-dot" aria-hidden>{s.state === "done" ? "✓" : i + 1}</span>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </RoomShell>
  );
}
