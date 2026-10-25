import * as React from "react";
import { CORE_OFFER } from "@/lib/projects";
import { ROOM_COPY } from "@/lib/demo/outcomes";

// The published prices, shown plainly: the one-time setup, and the monthly plan as optional. The numbers come from the one place they live (src/lib/billing.ts, through the room's
// view); nothing here is typed in. The sentence under them is the offer's own summary.

const dollars = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

export function PricingPanel({ pricing }: { pricing: { setupFeeUsd: number; monthlyPlanUsd: number; monthlyPlanOptional: true } }) {
  return (
    <section aria-labelledby="price-heading" className="card-surface rounded-2xl p-4 sm:p-5">
      <h2 id="price-heading" className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
        {ROOM_COPY.priceHeading}
      </h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-3">
          <dt className="text-[14px] font-medium text-muted">{ROOM_COPY.setupLabel}</dt>
          <dd className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-ink">{dollars(pricing.setupFeeUsd)}</dd>
          <dd className="text-[13px] text-muted">paid once</dd>
        </div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <dt className="text-[14px] font-medium text-muted">{ROOM_COPY.planLabel}</dt>
          <dd className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-ink">{dollars(pricing.monthlyPlanUsd)}</dd>
          <dd className="text-[13px] text-muted">per month, only if you choose it</dd>
        </div>
      </dl>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{CORE_OFFER.summary}</p>
      <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{ROOM_COPY.planNote}</p>
    </section>
  );
}
