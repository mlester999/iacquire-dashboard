import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/server/env";
import type { MaintenanceOverview } from "@/server/maintenance/service";
import type { AgreementView } from "@/server/maintenance/agreement-read";
import type { CreditNoteView } from "@/server/invoices/credit-notes";
import type { ClientContentPolicy } from "@/server/admin/client-content-policy";
import { MaintenancePanel } from "@/components/projects/maintenance-panel";
import { MaintenanceAdmin } from "@/components/admin/maintenance-admin";
import { CreditNotesPanel } from "@/components/invoices/credit-notes-panel";
import { ClientContentPolicyCard } from "@/components/admin/client-content-policy-card";
import { HeldContentNotice } from "@/components/admin/client-detail";
import { PreviewTheme } from "@/components/projects/preview-theme";

export const dynamic = "force-dynamic";

// Development-only sample data for the screens of the optional automatic maintenance payment, credit notes, the staff-access policy and the admin review queue's withheld
// state, so they can be seen and driven in a browser without a login. Nothing here reads a database or contacts a provider, and every button that would act reaches a
// server action that refuses without a session. Hidden outside development.
const VIEWS = ["maintenance", "admin-maintenance", "credit-notes", "policy", "reviews"] as const;
type View = (typeof VIEWS)[number];
const AGREEMENTS = ["none", "approval", "active", "suspended", "held", "ended"] as const;
type AgreementKind = (typeof AGREEMENTS)[number];

const now = Date.now();
const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
const ahead = (days: number) => new Date(now + days * 86_400_000).toISOString();

const agreement = (kind: AgreementKind): AgreementView | null => {
  const base: AgreementView = {
    id: "ag-1", reference: "IAQ-SAMPLE000001", status: "active", provider: "paypal", livemode: false, amountMinor: 29900, currency: "USD", nextBillingAt: ahead(24), failedPayments: 0, hold: null, holdSince: null,
    approvalUrl: null, heldCharges: 0, createdAt: ago(300),
  };
  switch (kind) {
    case "none": return null;
    case "approval": return { ...base, status: "approval_pending", nextBillingAt: null, approvalUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-SAMPLE" };
    case "suspended": return { ...base, status: "suspended", failedPayments: 3 };
    case "held": return { ...base, hold: "disputed", holdSince: ago(30), heldCharges: 1 };
    case "ended": return { ...base, status: "cancelled", nextBillingAt: null };
    default: return base;
  }
};

const overview = (kind: AgreementKind): MaintenanceOverview => ({
  eligible: true,
  eligibilityNote: null,
  plan: {
    id: "p", slug: "managed-maintenance", kind: "maintenance_plan", categoryId: "c", categoryCode: "managed_maintenance", categoryName: "Managed Maintenance", name: "Fully Managed Maintenance",
    tagline: "Optional hands-on upkeep for your iAcquire system: monitoring, troubleshooting, reasonable configuration adjustments and AI optimization.", description: "", problemSolved: "", accomplishes: [],
    deliverables: ["Monitoring of your connected integrations and AI employee health, with alerts to our team", "Troubleshooting when an integration, workflow or AI employee stops working as configured"],
    exclusions: ["New automations, AI agents, websites, funnels or software: quoted separately, even with an active plan", "Third-party platform subscriptions and usage or API costs"],
    optionalUpgrades: [], platforms: [], useCases: [], tags: [], keywords: [], deliveryMinDays: null, deliveryMaxDays: null, availability: "available", featured: false, requiresQuote: false, visible: true, sortOrder: 900,
    monthlyRequestAllowance: 4, coreOverlapNote: null, sourceNote: null, price: { type: "monthly", minCents: 29900, maxCents: null, currency: "USD", note: "Optional monthly plan. Billing starts only after you accept the plan and your system is activated." },
    portfolio: [],
  } as unknown as MaintenanceOverview["plan"],
  subscription: {
    id: "s", status: "active", monthlyPriceCents: 29900, currency: "USD", monthlyRequestAllowance: 4, termsVersion: "2026-10", acceptedAt: ago(900), activatedAt: ago(880), billingStartOn: "2026-10-01", renewalOn: null,
    paidThroughOn: new Date(now + 9 * 86_400_000).toISOString().slice(0, 10), cancelRequestedAt: null,
  },
  allowance: { total: 4, used: 1, remaining: 3, month: "2026-10" },
  requests: [],
  payOnline: { offered: true },
  agreement: agreement(kind),
  recurring: { offered: kind === "none" || kind === "ended" },
});

const sampleSubscriptions = (kind: AgreementKind) => [
  {
    id: "s2", status: "active" as const, monthlyPriceCents: 29900, currency: "USD", monthlyRequestAllowance: 4, termsVersion: "2026-10", acceptedAt: ago(900), activatedAt: ago(880), billingStartOn: "2026-10-01", renewalOn: "2026-11-01",
    cancelRequestedAt: null, orgId: "o2", orgName: "Sample Roofing Co", used: 2, requestNote: null, cancelNote: null, eligible: true, blockedBy: null, agreement: agreement(kind),
    lifecycle: { pastDueSince: null, graceEndsAt: null, expiredAt: null, paidThroughOn: "2026-11-05", lastPaymentVerifiedAt: ago(100), lastPaymentVerifiedBy: null, studioWorkflows: 3, studioPaused: 0, periodEndedDaysAgo: null },
  },
  {
    id: "s3", status: "past_due" as const, monthlyPriceCents: 29900, currency: "USD", monthlyRequestAllowance: 4, termsVersion: "2026-10", acceptedAt: ago(1500), activatedAt: ago(1400), billingStartOn: "2026-08-01", renewalOn: null,
    cancelRequestedAt: null, orgId: "o3", orgName: "Sample Dental Group", used: 0, requestNote: null, cancelNote: null, eligible: true, blockedBy: null, agreement: kind === "none" ? null : agreement("suspended"),
    lifecycle: { pastDueSince: ago(48), graceEndsAt: ahead(5), expiredAt: null, paidThroughOn: "2026-10-20", lastPaymentVerifiedAt: ago(700), lastPaymentVerifiedBy: null, studioWorkflows: 2, studioPaused: 0, periodEndedDaysAgo: 2 },
  },
];

const note = (over: Partial<CreditNoteView>): CreditNoteView => ({
  id: "cn", invoiceId: "inv-1", invoiceNumber: "INV-0007", status: "draft", number: null, currency: "PHP", amountMinor: 50000, taxPortionMinor: 0, reason: "Goodwill for a late visit", version: 1, approvedVersion: null,
  createdBy: "u-mia", createdByName: "Mia Manager", approvedByName: null, issuedByName: null, approvedAt: null, issuedAt: null, cancelledAt: null, cancelReason: null, billTo: {}, billFrom: {}, createdAt: ago(5), ...over,
});

const policy = (on: boolean): ClientContentPolicy => ({ sessionRequired: on, changedAt: on ? ago(3) : null, changedByName: on ? "Sam Super" : null, note: on ? "Counsel asked for the stricter rule." : null });

export default async function BillingPreview({ searchParams }: { searchParams: Promise<{ view?: string; agreement?: string; blocked?: string; policy?: string; as?: string }> }) {
  // The same guard the other dev previews use: absent outside development, which includes a hosted staging deploy (Next sets NODE_ENV=production for `next start`).
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(q.view ?? "") ? (q.view as View) : "maintenance";
  const kind: AgreementKind = (AGREEMENTS as readonly string[]).includes(q.agreement ?? "") ? (q.agreement as AgreementKind) : "none";
  const as = q.as === "manager" ? "manager" : "owner";
  const link = (v: string, extra = "") => `/dev/billing-preview?view=${v}${extra}`;
  return (
    <main className="app-backdrop min-h-dvh p-4 sm:p-8">
      <div className="mx-auto max-w-[1100px] space-y-6">
        <p className="rounded-xl bg-warning-soft p-3 text-xs text-warning-ink">
          Development UI preview · Sample data only. Actions do nothing here because there is no signed-in session. Views:{" "}
          {VIEWS.map((v) => <Link key={v} href={link(v)} className={`mr-2 underline ${v === view ? "font-bold" : ""}`}>{v}</Link>)}
          {(view === "maintenance" || view === "admin-maintenance") && <>· Agreement:{" "}{AGREEMENTS.map((a) => <Link key={a} href={link(view, `&agreement=${a}`)} className={`mr-2 underline ${a === kind ? "font-bold" : ""}`}>{a}</Link>)}</>}
          {view === "credit-notes" && <>· Viewing as:{" "}{(["owner", "manager"] as const).map((a) => <Link key={a} href={link(view, `&as=${a}${q.blocked ? "&blocked=1" : ""}`)} className={`mr-2 underline ${a === as ? "font-bold" : ""}`}>{a}</Link>)}<Link href={link(view, `&as=${as}&blocked=1`)} className="mr-2 underline">blocked invoice</Link></>}
          {view === "policy" && <>· <Link href={link("policy", "&policy=off")} className="mr-2 underline">off</Link><Link href={link("policy", "&policy=on")} className="mr-2 underline">on</Link></>}
        </p>
        <PreviewTheme />
        {view === "maintenance" && <MaintenancePanel overview={overview(kind)} timeZone="UTC" canManagePlan canRequest />}
        {view === "admin-maintenance" && (
          <MaintenanceAdmin
            subscriptions={sampleSubscriptions(kind)} requests={[]}
            recurring={{ state: { enabled: true, available: kind !== "none", reason: kind === "none" ? "The PayPal billing plan for maintenance (PAYPAL_MAINTENANCE_PLAN_ID) is not set." : null, livemode: false }, canManage: true }}
          />
        )}
        {view === "credit-notes" && (
          <CreditNotesPanel
            invoiceId="inv-1" currency="PHP" tz="UTC" currentUserId={as === "owner" ? "u-olive" : "u-mia"} isOwner={as === "owner"} canCredit canApprove owedMinor={q.blocked ? 0 : 100000}
            blockedReason={q.blocked ? "Nothing is owed on this invoice, so there is nothing to credit. If money was received that should go back, record a refund instead." : null}
            notes={[
              note({ id: "cn-4", status: "draft", amountMinor: 20000, reason: "Corrected the call-out fee after a phone call", createdBy: as === "owner" ? "u-olive" : "u-mia", createdByName: as === "owner" ? "Olive Owner" : "Mia Manager" }),
              note({ id: "cn-3", status: "pending_approval", amountMinor: 50000, reason: "Goodwill for a late visit", createdBy: "u-mia", createdByName: "Mia Manager", version: 2 }),
              note({ id: "cn-2", status: "issued", number: "CN-0001", amountMinor: 50000, reason: "Part of the job was not done", approvedByName: "Olive Owner", approvedAt: ago(70), issuedAt: ago(70), approvedVersion: 1, createdAt: ago(80) }),
              note({ id: "cn-1", status: "cancelled", amountMinor: 10000, reason: "Raised on the wrong invoice", cancelReason: "Raised twice by mistake", cancelledAt: ago(90), createdAt: ago(100) }),
            ]}
          />
        )}
        {view === "policy" && <ClientContentPolicyCard initial={policy(q.policy === "on")} timeZone="UTC" />}
        {view === "reviews" && <HeldContentNotice count={q.blocked ? 3 : 1} />}
      </div>
    </main>
  );
}
