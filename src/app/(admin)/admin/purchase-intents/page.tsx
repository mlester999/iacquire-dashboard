import Link from "next/link";
import { ArrowRight, ShoppingBag } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { getCheckoutSwitch, listPurchaseIntents } from "@/server/purchase-intents/service";
import { AdminPageHeader } from "@/components/admin/admin-shell";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { CreatePurchaseIntentForm } from "@/components/purchase-intents/create-form";
import { CheckoutSwitch } from "@/components/purchase-intents/checkout-switch";
import { formatUsdCents, PURCHASE_STATUS_TONE } from "@/lib/purchase-intents/rules";

export const metadata = { title: "Purchase intents" };
export const dynamic = "force-dynamic";

export default async function PurchaseIntentsPage() {
  const user = await requireAgency();
  let intents;
  let checkoutSwitch;
  try {
    [intents, checkoutSwitch] = await Promise.all([listPurchaseIntents(user), getCheckoutSwitch(user)]);
  } catch (error) {
    if (error instanceof AppError && error.code === "forbidden") {
      return (
        <div>
          <AdminPageHeader title="Purchase intents" description="The verified path from an invited buyer to a client workspace." />
          <EmptyState headingLevel={2} icon={<ShoppingBag className="size-5" />} title="Purchase intents are for managers" description="Your agency role does not hold the prospects view permission. Ask a manager or Super Admin." />
        </div>
      );
    }
    throw error;
  }
  return (
    <div>
      <AdminPageHeader title="Purchase intents" description="Invite a buyer, freeze the approved price, then the payment is verified (by PayMongo's signed confirmation, or by you from the bank) and the client workspace is created. No card is charged and no email is sent from this page." />
      <div className="mb-5"><CheckoutSwitch initial={checkoutSwitch} canManage={user.platformRole === "agency_super_admin"} /></div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <CreatePurchaseIntentForm />
        <Card className="min-w-0">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-[15px]">
              <span className="flex items-center gap-2"><ShoppingBag className="size-4 text-primary" aria-hidden /> Invitations</span>
              <Badge tone="outline">{intents.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {intents.length ? (
              <ul className="divide-y divide-line">
                {intents.map((intent) => (
                  <li key={intent.id} className="py-3 first:pt-0 last:pb-0">
                    <Link href={`/admin/purchase-intents/${intent.id}`} className="group flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-[13.5px] font-medium text-ink group-hover:text-primary">{intent.company}</span>
                          <Badge tone={PURCHASE_STATUS_TONE[intent.status]}>{intent.statusText}</Badge>
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] text-muted">{intent.buyerName} · {intent.buyerEmail}</span>
                        <span className="mt-0.5 block text-[12px] text-muted">
                          {formatUsdCents(intent.setupFeeCents)} setup{intent.maintenanceSelected ? ` + ${formatUsdCents(intent.maintenanceMonthlyCents)}/mo` : " · no maintenance plan"} · {intent.reference}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
                        {new Date(intent.expiresAt).toLocaleDateString()}
                        <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" aria-hidden />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-[13px] leading-relaxed text-muted">No invitations yet. Create one on the left; it will appear here with its status and the next action.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
