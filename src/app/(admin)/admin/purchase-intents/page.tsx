import { ShoppingBag } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { getCheckoutSwitch, listPurchaseIntents } from "@/server/purchase-intents/service";
import { getProspect } from "@/server/demo/admin";
import { emailReadiness } from "@/server/email";
import { AdminPageHeader } from "@/components/admin/admin-shell";
import { EmptyState } from "@/components/ui/primitives";
import { CheckoutSwitch } from "@/components/purchase-intents/checkout-switch";
import { PurchaseIntentsWorkspace } from "@/components/purchase-intents/workspace";

export const metadata = { title: "Purchase intents" };
export const dynamic = "force-dynamic";

export default async function PurchaseIntentsPage({ searchParams }: { searchParams: Promise<{ prospect?: string | string[] }> }) {
  const user = await requireAgency();
  const query = await searchParams;
  // A demo prospect's "Create purchase invitation" link arrives here with its id. The form is only pre-filled; creating the invitation is still the existing
  // Super Admin action below, with the same frozen price and the same public /purchase/<token> page. A missing or unreadable prospect leaves an empty form.
  const prospectId = typeof query.prospect === "string" ? query.prospect : null;
  let fromProspect: Awaited<ReturnType<typeof getProspect>> | null = null;
  if (prospectId) {
    try {
      const found = await getProspect(user, prospectId);
      if (!found.prospect.erased) fromProspect = found;
    } catch {
      fromProspect = null;
    }
  }
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
  const email = emailReadiness();
  return (
    <div>
      <AdminPageHeader title="Purchase intents" description="Invite a buyer: the invitation freezes the approved price and is emailed to them with a private link. The buyer confirms, pays on the payment provider's own page, and only the provider's verified confirmation (or your own check of the bank) creates the client workspace. Creating an invitation charges nobody." />
      <div className="mb-5"><CheckoutSwitch initial={checkoutSwitch} canManage={user.platformRole === "agency_super_admin"} /></div>
      {fromProspect && (
        <p className="mb-4 rounded-xl border border-primary/20 bg-primary-soft px-4 py-3 text-[13px] leading-relaxed text-primary-ink">
          Pre-filled from {fromProspect.prospect.name ?? "a demo prospect"}&apos;s demo. Creating the invitation here uses the existing purchase-intent service; the demo
          itself never creates a workspace or takes a payment.
        </p>
      )}
      <PurchaseIntentsWorkspace
        intents={intents}
        timeZone={user.timezone}
        email={{ ready: email.ready, sender: email.sender, problems: email.problems, warnings: email.warnings }}
        defaults={
          fromProspect
            ? {
                prospectId: fromProspect.prospect.id,
                buyerName: fromProspect.prospect.name ?? undefined,
                buyerEmail: fromProspect.prospect.email ?? undefined,
                company: fromProspect.prospect.business ?? undefined,
                industry: fromProspect.prospect.industryLabel ?? undefined,
              }
            : undefined
        }
      />
    </div>
  );
}
