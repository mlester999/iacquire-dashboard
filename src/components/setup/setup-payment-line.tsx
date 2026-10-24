import Link from "next/link";
import { CheckCircle2, Clock } from "lucide-react";
import { setupPaymentLine } from "@/lib/onboarding/setup-payment-line";
import { cn } from "@/lib/utils";

/**
 * Whether the setup payment is confirmed, for the client, on the Setup Center. Shows what the database answered and nothing finer; with no answer it shows nothing.
 * `billingHref` is given only to someone who may see billing.
 */
export function SetupPaymentLine({ cleared, billingHref }: { cleared: boolean | null | undefined; billingHref?: string | null }) {
  const line = setupPaymentLine(cleared);
  if (!line) return null;
  const waiting = line.state === "waiting";
  return (
    <section aria-labelledby="setup-payment-title" data-state={line.state} className="mx-auto mb-4 flex max-w-6xl items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-sm sm:px-5">
      <span aria-hidden className={cn("mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl", waiting ? "bg-warning-soft text-warning-ink" : "bg-success-soft text-success-ink")}>
        {waiting ? <Clock className="size-4" /> : <CheckCircle2 className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="setup-payment-title" className="text-[14px] font-semibold text-ink">{line.title}</h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{line.detail}</p>
        {billingHref && (
          <Link href={billingHref} className="mt-1 inline-flex min-h-11 items-center text-[13px] font-semibold text-primary underline-offset-2 hover:underline">
            View billing
          </Link>
        )}
      </div>
    </section>
  );
}
