import * as React from "react";
import { BadgeCheck, Layers, LockKeyhole, ShieldCheck, Workflow, Wrench } from "lucide-react";
import { ConfirmPurchase } from "@/components/purchase-intents/confirm";
import { JourneySteps } from "@/components/purchase-intents/journey-steps";
import { PriceFigure } from "@/components/purchase-intents/price-figure";
import { RoomShell } from "@/components/purchase-intents/room-shell";
import { TeamOrbit } from "@/components/purchase-intents/team-orbit";
import { formatExpiry } from "@/lib/purchase-intents/delivery";
import { buyerJourney, formatUsdCents, type PurchaseStatus } from "@/lib/purchase-intents/rules";
import type { PublicPurchaseView } from "@/server/purchase-intents/service";

// What the buyer sees at the secure link in their email, as plain presentation: the page (src/app/purchase/[token]/page.tsx) looks the purchase up and answers the rate limit, and this
// draws it. Kept apart so a development preview can show every state at every width without a database or a link. The look is the offer room (offer-room.css); the words are the same
// promises the page always made: the price is frozen, no card is entered here, and a workspace exists only after the payment is verified.

export function PublicPurchaseShell({ children }: { children: React.ReactNode }) {
  return <RoomShell>{children}</RoomShell>;
}

export function PublicPurchaseTooMany() {
  return (
    <div className="room-panel room-in">
      <span className="room-panel-icon" aria-hidden><LockKeyhole className="size-7" /></span>
      <h1>Too many attempts</h1>
      <p>Wait a moment and open the link again.</p>
    </div>
  );
}

export function PublicPurchaseInvalid() {
  return (
    <div className="room-panel room-in">
      <span className="room-panel-icon" aria-hidden><LockKeyhole className="size-7" /></span>
      <h1>This link is not valid</h1>
      <p>Check that you copied the whole link from your email, or ask iAcquire for a new one. No details were looked up.</p>
    </div>
  );
}

/** How the note under the order reads: a confirmed or paid purchase is good news, one that was closed or ran out is a warning, anything else is plain. */
const NOTE_TONE: Record<PurchaseStatus, "neutral" | "good" | "warn"> = { invited: "neutral", started: "good", payment_verified: "good", provisioned: "good", cancelled: "warn", expired: "warn" };

const step = (d: number) => ({ "--d": d }) as React.CSSProperties;

export function PublicPurchaseBody({ purchase, token }: { purchase: PublicPurchaseView; token: string }) {
  const first = purchase.buyerName.split(" ")[0];
  const journey = buyerJourney(purchase.status);
  return (
    <>
      <div className="room-layout">
        <section className="room-a-hero" aria-labelledby="room-welcome">
          <p className="room-eyebrow room-in" style={step(0)}><span className="room-eyebrow-dot" aria-hidden /> Launch offer &middot; {purchase.reference}</p>
          <h1 id="room-welcome" className="room-h1 room-in mt-5" style={step(1)}>Welcome, <em>{first}</em></h1>
          <p className="room-lede room-in mt-5 max-w-xl" style={step(2)}>This is the iAcquireOS launch offer prepared for {purchase.company}. Confirm the details below; your card is never entered on this page.</p>
        </section>

        <aside className="room-a-ticket room-in" style={step(3)} aria-label="Your order">
          <div className="room-ticket">
            <div className="room-ticket-top">
              <div className="flex items-center justify-between gap-3">
                <p className="room-label">Your order</p>
                <span className="room-chip room-chip-quiet"><LockKeyhole className="size-3.5" aria-hidden /> Price frozen</span>
              </div>
              <p className="room-company">{purchase.company}</p>
              <dl>
                <div>
                  <dt className="room-label mt-6">One-time setup</dt>
                  <dd className="room-price"><PriceFigure cents={purchase.setupFeeCents} /></dd>
                </div>
                <div className="room-line">
                  <dt>Managed Maintenance + Automation Studio</dt>
                  <dd>
                    <span>{formatUsdCents(purchase.maintenanceMonthlyCents)}<small>/month</small></span>
                    <span className={`room-chip ${purchase.maintenanceSelected ? "room-chip-good" : "room-chip-quiet"}`}>{purchase.maintenanceSelected ? "Selected" : "Not selected"}</span>
                  </dd>
                </div>
              </dl>
            </div>
            <div className="room-ticket-bottom">
              {journey && <JourneySteps steps={journey} />}
              <ConfirmPurchase token={token} canConfirm={purchase.canConfirm} problem={purchase.problem} setupFeeCents={purchase.setupFeeCents} checkout={purchase.checkout} tone={NOTE_TONE[purchase.status]} />
            </div>
          </div>
        </aside>

        <section className="room-a-orbit room-in" style={step(4)} aria-label="Your AI Growth Partner and six capabilities">
          <TeamOrbit company={purchase.company} />
        </section>

      </div>

      <section className="room-included room-in" style={step(5)} aria-labelledby="room-included">
        <h2 id="room-included" className="room-h2">What your setup includes</h2>
        <div className="room-bento">
          <article className="room-tile">
            <span className="room-tile-icon" aria-hidden><Layers className="size-5" /></span>
            <h3>Your own workspace</h3>
            <p>A dedicated iAcquireOS client workspace and onboarding.</p>
          </article>
          <article className="room-tile">
            <span className="room-tile-icon" aria-hidden><Workflow className="size-5" /></span>
            <h3>CRM, integrations and your AI Growth Partner</h3>
            <p>CRM setup, integrations and Growth Partner preparation follow payment verification and onboarding.</p>
          </article>
          <article className="room-tile">
            <span className="room-tile-icon" aria-hidden><Wrench className="size-5" /></span>
            <h3>Maintenance and Automation Studio</h3>
            <p>{purchase.maintenanceSelected ? "The optional maintenance plan is recorded with your purchase." : "The maintenance plan is optional and was not selected."}</p>
          </article>
        </div>
      </section>

      <div className="room-trust">
        <p><ShieldCheck className="size-4" aria-hidden /> <span>The price and product version are frozen when the invitation is created.</span></p>
        <p><LockKeyhole className="size-4" aria-hidden /> <span>Only a hash of this link is stored. It stops working on {formatExpiry(purchase.expiresAt, purchase.timezone)}.</span></p>
        <p><BadgeCheck className="size-4" aria-hidden /> <span>A workspace is created only after the payment is verified: by the payment provider&apos;s confirmation, or by iAcquire.</span></p>
      </div>
    </>
  );
}
