"use client";

import { AnimatedNumber } from "@/components/brand";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** The frozen price, counting up once when it scrolls into view. Without scripts, or with "reduce motion", it is simply the price. The function lives here because a server component cannot hand one to a client component. */
export function PriceFigure({ cents, className }: { cents: number; className?: string }) {
  return <AnimatedNumber value={cents / 100} format={(n) => USD.format(Math.round(n * 100) / 100)} className={className} />;
}
