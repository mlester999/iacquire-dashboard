import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { PreviewTheme } from "@/components/projects/preview-theme";
import { PublicPurchaseBody, PublicPurchaseInvalid, PublicPurchaseShell, PublicPurchaseTooMany } from "@/components/purchase-intents/public-purchase";
import type { PublicPurchaseView } from "@/server/purchase-intents/service";

export const dynamic = "force-dynamic";

// Development-only sample data for the page a buyer opens from the invitation email (/purchase/<link>), so each state can be seen and measured in a browser without a database or a real
// link. Nothing here reads a database or calls anything; the confirm button reaches a server action that refuses a link it does not know. Hidden outside development.
//
//   state=invited|long|pay|retry|manual|expired|cancelled|verified|provisioned|invalid|limited|nomaint
const STATES = ["invited", "nomaint", "long", "pay", "retry", "manual", "expired", "cancelled", "verified", "provisioned", "invalid", "limited"] as const;
type State = (typeof STATES)[number];

const SAMPLE: PublicPurchaseView = {
  reference: "PUR-SAMPLE2345", buyerName: "Bailey Buyer", buyerEmail: "bailey@harborview.example", company: "Harborview Realty Group", industry: "Real estate", setupFeeCents: 149900,
  maintenanceMonthlyCents: 29900, maintenanceSelected: true, currency: "USD", status: "invited", statusText: "Invitation created", expiresAt: "2026-11-16T15:35:00.000Z", timezone: "America/Chicago",
  canConfirm: true, problem: null, checkout: { offered: false, status: null, reference: null, providers: [] },
};

const PROVIDERS = [{ id: "paymongo" as const, label: "PayMongo" }, { id: "paypal" as const, label: "PayPal" }];

function purchase(state: State): PublicPurchaseView | null {
  switch (state) {
    case "invalid":
    case "limited":
      return null;
    case "nomaint":
      return { ...SAMPLE, maintenanceSelected: false };
    case "long":
      return { ...SAMPLE, buyerName: "Bartholomew-Alexander Montgomery-Featherstonehaugh", company: "The Extraordinarily Long Named Harborview Realty and Property Management Group of the Greater Pacific Northwest Region LLC" };
    case "pay":
      return { ...SAMPLE, status: "started", statusText: "Buyer confirmed", canConfirm: false, checkout: { offered: true, status: null, reference: null, providers: PROVIDERS } };
    case "retry":
      return { ...SAMPLE, status: "started", statusText: "Buyer confirmed", canConfirm: false, checkout: { offered: true, status: "failed", reference: "CHK-SAMPLE0001", providers: PROVIDERS } };
    case "manual":
      return { ...SAMPLE, status: "started", statusText: "Buyer confirmed", canConfirm: false, problem: "Your purchase is confirmed. iAcquire will verify the payment and send your workspace invitation." };
    case "expired":
      return { ...SAMPLE, status: "expired", statusText: "Link expired", canConfirm: false, problem: "This purchase link has expired. Ask iAcquire for a new one." };
    case "cancelled":
      return { ...SAMPLE, status: "cancelled", statusText: "Cancelled", canConfirm: false, problem: "This purchase was cancelled." };
    case "verified":
      return { ...SAMPLE, status: "payment_verified", statusText: "Payment verified", canConfirm: false, problem: "Your payment is confirmed. iAcquire is creating your workspace and will email your invitation." };
    case "provisioned":
      return { ...SAMPLE, status: "provisioned", statusText: "Workspace created", canConfirm: false, problem: "Your workspace is ready. Check the email address on this purchase for your invitation." };
    default:
      return SAMPLE;
  }
}

export default async function PurchasePreview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const raw = typeof q.state === "string" ? q.state : "invited";
  const state = (STATES as readonly string[]).includes(raw) ? (raw as State) : "invited";
  const view = purchase(state);
  return (
    <>
      <nav aria-label="Samples" className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-[12px]">
        <PreviewTheme />
        {STATES.map((s) => <Link key={s} href={`/dev/purchase-preview?state=${s}`} className="rounded-lg border border-line px-2.5 py-1 text-ink-2 hover:bg-surface-2">{s}</Link>)}
      </nav>
      <PublicPurchaseShell>
        {state === "limited" ? <PublicPurchaseTooMany /> : view ? <PublicPurchaseBody purchase={view} token="sample-token-not-a-real-link" /> : <PublicPurchaseInvalid />}
      </PublicPurchaseShell>
    </>
  );
}
