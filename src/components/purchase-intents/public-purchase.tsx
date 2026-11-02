import { BadgeCheck, Check, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { Logo } from "@/components/brand";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { ConfirmPurchase } from "@/components/purchase-intents/confirm";
import { formatExpiry } from "@/lib/purchase-intents/delivery";
import { formatUsdCents } from "@/lib/purchase-intents/rules";
import type { PublicPurchaseView } from "@/server/purchase-intents/service";

// What the buyer sees at the secure link in their email, as plain presentation: the page (src/app/purchase/[token]/page.tsx) looks the purchase up and answers the rate limit, and this
// draws it. Kept apart so a development preview can show every state at every width without a database or a link.

export function PublicPurchaseShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-bg px-4 py-8 sm:px-6 sm:py-14">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <Logo />
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted"><Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden /> AI-powered client acquisition</span>
        </div>
        {children}
      </div>
    </main>
  );
}

export function PublicPurchaseTooMany() {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="text-[15px] font-semibold text-ink">Too many attempts</p>
        <p className="mt-1 text-[14px] text-muted">Wait a moment and open the link again.</p>
      </CardContent>
    </Card>
  );
}

export function PublicPurchaseInvalid() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <LockKeyhole className="mx-auto size-9 text-muted" aria-hidden />
        <h1 className="mt-3 text-[19px] font-semibold text-ink">This link is not valid</h1>
        <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-muted">Check that you copied the whole link from your email, or ask iAcquire for a new one. No details were looked up.</p>
      </CardContent>
    </Card>
  );
}

export function PublicPurchaseBody({ purchase, token }: { purchase: PublicPurchaseView; token: string }) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <Badge tone="outline" className="mb-3 h-7 px-3">Purchase · {purchase.reference}</Badge>
        <h1 className="text-[28px] font-semibold tracking-[-0.045em] text-ink [overflow-wrap:anywhere]">Welcome, {purchase.buyerName.split(" ")[0]}</h1>
        <p className="mx-auto mt-2 max-w-lg text-[14px] leading-relaxed text-muted [overflow-wrap:anywhere]">This is the iAcquireOS launch offer prepared for {purchase.company}. Confirm the details below; your card is never entered on this page.</p>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[15px] [overflow-wrap:anywhere]">{purchase.company}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-line bg-surface-2 p-3">
              <dt className="text-[12px] uppercase tracking-wide text-muted">One-time setup</dt>
              <dd className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{formatUsdCents(purchase.setupFeeCents)}</dd>
            </div>
            <div className="rounded-xl border border-line bg-surface-2 p-3">
              <dt className="text-[12px] uppercase tracking-wide text-muted">Managed Maintenance + Automation Studio</dt>
              <dd className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{formatUsdCents(purchase.maintenanceMonthlyCents)}<span className="text-[14px] font-normal text-muted">/month</span></dd>
              <dd className="text-[12px] text-muted">{purchase.maintenanceSelected ? "Selected" : "Not selected"}</dd>
            </div>
          </dl>
          <ul className="grid gap-2 text-[14px] leading-relaxed text-ink-2">
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> A dedicated iAcquireOS client workspace and onboarding.</li>
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> CRM setup, integrations and AI employee provisioning follow verification and onboarding.</li>
            <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> {purchase.maintenanceSelected ? "The optional maintenance plan is recorded with your purchase." : "The maintenance plan is optional and was not selected."}</li>
          </ul>
          <ConfirmPurchase token={token} canConfirm={purchase.canConfirm} problem={purchase.problem} setupFeeCents={purchase.setupFeeCents} checkout={purchase.checkout} />
        </CardContent>
      </Card>
      <div className="grid gap-3 text-[13px] leading-relaxed text-muted sm:grid-cols-3">
        <p className="flex gap-1.5"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden /> The price and product version are frozen when the invitation is created.</p>
        <p className="flex gap-1.5"><LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden /> Only a hash of this link is stored. It stops working on {formatExpiry(purchase.expiresAt, purchase.timezone)}.</p>
        <p className="flex gap-1.5"><BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden /> A workspace is created only after the payment is verified: by the payment provider&apos;s confirmation, or by iAcquire.</p>
      </div>
    </div>
  );
}
