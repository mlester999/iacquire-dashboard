import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Clock3, CreditCard, Mail, MapPin, ReceiptText, ShoppingBag, UserRound } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { withSystem } from "@/server/db";
import { getPurchaseIntent, listPurchaseIntentEvents } from "@/server/purchase-intents/service";
import { listIntentCheckouts } from "@/server/purchase-intents/checkout";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { PurchaseIntentActions } from "@/components/purchase-intents/actions";
import { CHECKOUT_STATUS_TEXT, formatUsdCents, PURCHASE_EVENT_TEXT, PURCHASE_STATUS_TONE } from "@/lib/purchase-intents/rules";
import { cn } from "@/lib/utils";

export const metadata = { title: "Purchase intent" };
export const dynamic = "force-dynamic";

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");

export default async function PurchaseIntentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAgency();
  let intent;
  try {
    intent = await getPurchaseIntent(user, id);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    if (error instanceof AppError && error.code === "forbidden") notFound();
    throw error;
  }
  const [events, checkouts] = await Promise.all([listPurchaseIntentEvents(user, id).catch(() => []), withSystem((db) => listIntentCheckouts(db, intent.id)).catch(() => [])]);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/admin/purchase-intents" className="inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" aria-hidden /> Purchase intents
        </Link>
        <Badge tone={PURCHASE_STATUS_TONE[intent.status]} className="h-7 px-3">{intent.statusText}</Badge>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Purchase intent · {intent.reference}</p>
          <h1 className="mt-1 flex items-center gap-2 text-[26px] font-semibold tracking-[-0.04em] text-ink"><ShoppingBag className="size-6 text-primary" aria-hidden /> {intent.company}</h1>
          <p className="mt-1 text-[14px] text-muted">Created {when(intent.createdAt)}. The link expires {when(intent.expiresAt)}.</p>
        </div>
        <div className="rounded-xl border border-line bg-surface px-4 py-3 text-right shadow-soft">
          <p className="text-[18px] font-semibold tabular-nums text-ink">{formatUsdCents(intent.setupFeeCents)}</p>
          <p className="text-[12px] text-muted">setup fee{intent.maintenanceSelected ? ` + ${formatUsdCents(intent.maintenanceMonthlyCents)}/mo` : " · maintenance not selected"}</p>
        </div>
      </div>

      {intent.holdText && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-[14px] leading-relaxed text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <strong>On hold.</strong> {intent.holdText}
            {(intent.can.release || intent.can.cancel) && <span className="mt-1 block text-[13px]">Check it in PayMongo, then release the hold if the payment stands{intent.can.cancel && intent.status === "payment_verified" ? ", or close the purchase if the money is gone" : ""}.</span>}
          </span>
        </p>
      )}
      {intent.lastProvisionError && intent.status === "payment_verified" && (
        <p role="status" className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-[14px] leading-relaxed text-warning-ink">
          Creating the workspace did not finish ({intent.provisionAttempts} {intent.provisionAttempts === 1 ? "try" : "tries"}): {intent.lastProvisionError} Use &ldquo;Create the workspace&rdquo; below to try again; it finishes the same workspace and never makes a second one.
        </p>
      )}
      {/* grid-cols-1 is minmax(0, 1fr): without it the single column grows to its longest unbroken string (an email, a provider reference) and the cards run off a phone's edge. */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-[15px]">Buyer and product</CardTitle></CardHeader>
            <CardContent className="grid gap-3 text-[14px] sm:grid-cols-2">
              <p className="flex min-w-0 items-start gap-2"><UserRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0 break-words"><span className="block text-[12px] text-muted">Buyer</span>{intent.buyerName}</span></p>
              <p className="flex min-w-0 items-start gap-2"><Mail className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0 break-all"><span className="block text-[12px] text-muted">Email</span>{intent.buyerEmail}</span></p>
              <p className="flex min-w-0 items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0 break-words"><span className="block text-[12px] text-muted">Industry and time zone</span>{intent.industry || "Not given"} · {intent.timezone}</span></p>
              <p className="flex min-w-0 items-start gap-2"><ReceiptText className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0 break-words"><span className="block text-[12px] text-muted">Frozen product</span>{intent.productVersion} · {intent.currency}</span></p>
              {intent.website && <p className="min-w-0 break-all sm:col-span-2"><span className="block text-[12px] text-muted">Website</span><a href={intent.website} target="_blank" rel="noreferrer" className="text-primary hover:underline">{intent.website}</a></p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-[15px]">Verify the payment</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {intent.paymentReference ? (
                <dl className="grid grid-cols-1 gap-2 text-[14px] sm:grid-cols-2">
                  <div className="min-w-0"><dt className="text-[12px] text-muted">Amount</dt><dd className="font-medium text-ink">{formatUsdCents(intent.paymentAmountCents ?? intent.setupFeeCents)}</dd></div>
                  <div className="min-w-0"><dt className="text-[12px] text-muted">Method</dt><dd>{intent.paymentMethod?.replaceAll("_", " ")}</dd></div>
                  <div className="min-w-0"><dt className="text-[12px] text-muted">Evidence</dt><dd>{intent.paymentSource === "provider" ? "Confirmed by the payment provider's signed notice" : "Recorded by a Super Admin from the bank or a dashboard"}</dd></div>
                  <div className="min-w-0"><dt className="text-[12px] text-muted">Workspace</dt><dd>{intent.clientOrgId ? (intent.autoProvision ? "Created automatically after the verified payment" : "Created by a Super Admin") : intent.status === "cancelled" ? "Not created: the purchase was closed" : intent.autoProvision ? "Will be created automatically once nothing holds the payment" : "A Super Admin creates it"}</dd></div>
                  <div className="min-w-0"><dt className="text-[12px] text-muted">Reference</dt><dd className="break-all">{intent.paymentReference}</dd></div>
                  <div className="min-w-0"><dt className="text-[12px] text-muted">Paid on</dt><dd>{intent.paymentPaidOn}</dd></div>
                  <div className="min-w-0 sm:col-span-2"><dt className="text-[12px] text-muted">What was checked</dt><dd className="break-words leading-relaxed">{intent.paymentNote}</dd></div>
                </dl>
              ) : (
                <p className="text-[14px] leading-relaxed text-muted">The buyer has not confirmed, or the payment has not been verified. Record the payment only after you have checked the money in the bank, PayPal or PayMongo account.</p>
              )}
              <PurchaseIntentActions intent={intent} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-[15px]"><CreditCard className="size-4 text-primary" aria-hidden /> Online checkouts</CardTitle></CardHeader>
            <CardContent>
              {checkouts.length ? (
                <ul className="divide-y divide-line">
                  {checkouts.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0 text-[14px]">
                      <span className="min-w-0">
                        <span className="block break-all font-medium text-ink">{c.reference}</span>
                        <span className="block text-[12px] text-muted">{formatUsdCents(c.usdAmountCents)} asked as {c.chargedCurrency} {(c.chargedAmountMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} · {c.livemode ? "live" : "test mode"} · opened {when(c.createdAt)}</span>
                        {c.failureReason && <span className="block text-[12px] text-muted">{c.failureReason}</span>}
                      </span>
                      <Badge tone={c.status === "paid" ? "success" : c.status === "pending" || c.status === "creating" ? "primary" : c.status === "failed" || c.status === "cancelled" || c.status === "expired" ? "neutral" : "warning"}>{CHECKOUT_STATUS_TEXT[c.status]}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[14px] leading-relaxed text-muted">No online checkout was opened. The buyer sees a Pay button only when online checkout is switched on and the provider is connected.</p>
              )}
              <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-muted">A checkout becomes paid only when PayMongo&apos;s signed notice matches the reference, mode, currency and amount stored here. The buyer returning to the site proves nothing.</p>
            </CardContent>
          </Card>
        </div>

        <Card className="min-w-0">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-[15px]"><Clock3 className="size-4 text-primary" aria-hidden /> Timeline</CardTitle></CardHeader>
          <CardContent>
            {events.length ? (
              <ol className="space-y-3">
                {events.map((event, i) => (
                  <li key={event.id} className="flex gap-3">
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", i === events.length - 1 ? "bg-primary" : "bg-line-strong")} aria-hidden />
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium text-ink">{event.kind === "cancelled" && event.detail.afterPayment === true ? "Purchase closed without a workspace after its payment" : PURCHASE_EVENT_TEXT[event.kind] ?? event.kind}</p>
                      <p className="text-[12px] text-muted">{when(event.createdAt)} · {event.actorKind}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[14px] text-muted">No timeline entries yet.</p>
            )}
            <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-muted">
              The public link is stored only as a hash. The buyer confirming it creates no account and takes no payment; the workspace is created only after the payment is verified, by the provider&apos;s signed confirmation or by a Super Admin from the bank.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
