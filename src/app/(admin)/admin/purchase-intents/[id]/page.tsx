import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Clock3, Mail, MapPin, ReceiptText, ShoppingBag, UserRound } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { getPurchaseIntent, listPurchaseIntentEvents } from "@/server/purchase-intents/service";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { PurchaseIntentActions } from "@/components/purchase-intents/actions";
import { formatUsdCents, PURCHASE_EVENT_TEXT, PURCHASE_STATUS_TONE } from "@/lib/purchase-intents/rules";
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
  const events = await listPurchaseIntentEvents(user, id).catch(() => []);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/admin/purchase-intents" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" aria-hidden /> Purchase intents
        </Link>
        <Badge tone={PURCHASE_STATUS_TONE[intent.status]} className="h-7 px-3">{intent.statusText}</Badge>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Purchase intent · {intent.reference}</p>
          <h1 className="mt-1 flex items-center gap-2 text-[26px] font-semibold tracking-[-0.04em] text-ink"><ShoppingBag className="size-6 text-primary" aria-hidden /> {intent.company}</h1>
          <p className="mt-1 text-[13px] text-muted">Created {when(intent.createdAt)}. The link expires {when(intent.expiresAt)}.</p>
        </div>
        <div className="rounded-xl border border-line bg-surface px-4 py-3 text-right shadow-soft">
          <p className="text-[18px] font-semibold tabular-nums text-ink">{formatUsdCents(intent.setupFeeCents)}</p>
          <p className="text-[11.5px] text-muted">setup fee{intent.maintenanceSelected ? ` + ${formatUsdCents(intent.maintenanceMonthlyCents)}/mo` : " · maintenance not selected"}</p>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-[15px]">Buyer and product</CardTitle></CardHeader>
            <CardContent className="grid gap-3 text-[13px] sm:grid-cols-2">
              <p className="flex items-start gap-2"><UserRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span><span className="block text-[11.5px] text-muted">Buyer</span>{intent.buyerName}</span></p>
              <p className="flex items-start gap-2"><Mail className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span><span className="block text-[11.5px] text-muted">Email</span>{intent.buyerEmail}</span></p>
              <p className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span><span className="block text-[11.5px] text-muted">Industry and time zone</span>{intent.industry || "Not given"} · {intent.timezone}</span></p>
              <p className="flex items-start gap-2"><ReceiptText className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /><span><span className="block text-[11.5px] text-muted">Frozen product</span>{intent.productVersion} · {intent.currency}</span></p>
              {intent.website && <p className="sm:col-span-2"><span className="block text-[11.5px] text-muted">Website</span><a href={intent.website} target="_blank" rel="noreferrer" className="text-primary hover:underline">{intent.website}</a></p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-[15px]">Verify the payment</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {intent.paymentReference ? (
                <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
                  <div><dt className="text-[11.5px] text-muted">Amount</dt><dd className="font-medium text-ink">{formatUsdCents(intent.paymentAmountCents ?? intent.setupFeeCents)}</dd></div>
                  <div><dt className="text-[11.5px] text-muted">Method</dt><dd>{intent.paymentMethod?.replaceAll("_", " ")}</dd></div>
                  <div><dt className="text-[11.5px] text-muted">Reference</dt><dd className="break-all">{intent.paymentReference}</dd></div>
                  <div><dt className="text-[11.5px] text-muted">Paid on</dt><dd>{intent.paymentPaidOn}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-[11.5px] text-muted">What was checked</dt><dd className="leading-relaxed">{intent.paymentNote}</dd></div>
                </dl>
              ) : (
                <p className="text-[13px] leading-relaxed text-muted">The buyer has not confirmed, or the payment has not been verified. Record the payment only after you have checked the money in the bank, PayPal or PayMongo account.</p>
              )}
              <PurchaseIntentActions intent={intent} />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-[15px]"><Clock3 className="size-4 text-primary" aria-hidden /> Timeline</CardTitle></CardHeader>
          <CardContent>
            {events.length ? (
              <ol className="space-y-3">
                {events.map((event, i) => (
                  <li key={event.id} className="flex gap-3">
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", i === events.length - 1 ? "bg-primary" : "bg-line-strong")} aria-hidden />
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-ink">{PURCHASE_EVENT_TEXT[event.kind] ?? event.kind}</p>
                      <p className="text-[11.5px] text-muted">{when(event.createdAt)} · {event.actorKind}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-muted">No timeline entries yet.</p>
            )}
            <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-muted">
              The public link is stored only as a hash. The buyer confirming it creates no account and takes no payment; the workspace is created only after the verified payment is recorded here.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
