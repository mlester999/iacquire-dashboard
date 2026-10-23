import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { isUuid } from "@/lib/social/address";
import { CLOSE_RULE_LABELS } from "@/lib/invoices/close-rule";
import type { ActionFacts } from "@/lib/invoices/screens";
import { getInvoiceDetail } from "@/server/invoices/invoices";
import { getInvoiceSettings } from "@/server/invoices/settings";
import { testPaymentPossible } from "@/server/invoices/test-payment";
import { InvoiceActions } from "@/components/invoices/invoice-actions";
import { InvoiceSummary, LinesTable, RemindersList, Timeline } from "@/components/invoices/invoice-sections";
import { PaymentsPanel } from "@/components/invoices/payments-panel";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgContext("invoices.view");
  const { id } = await params;
  // The column is a uuid: an address that only looks like one would make the database raise instead of the page saying "not found".
  if (!isUuid(id)) notFound();
  let detail;
  try {
    detail = await getInvoiceDetail(ctx, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
  const i = detail.invoice;
  const tz = ctx.org.timezone || "UTC";
  const [settings, testPossible] = await Promise.all([getInvoiceSettings(ctx), testPaymentPossible(ctx, i.currency)]);
  const facts: ActionFacts = {
    status: i.status, paymentStatus: i.paymentStatus, writtenOff: i.writtenOffAt !== null, balanceMinor: i.balanceMinor, paidMinor: i.paidMinor, createdVia: i.createdVia,
    isAuthor: i.createdBy === ctx.user.id, approvalRequiredForCreators: settings.approvalRequiredForCreators, hasTestConnection: testPossible,
    can: { create: ctx.can("invoices.create"), approve: ctx.can("invoices.approve"), send: ctx.can("invoices.send"), recordPayment: ctx.can("invoices.record_payment"), void: ctx.can("invoices.void"), refund: ctx.can("invoices.refund"), connect: ctx.can("invoices.connect_payments") },
  };
  const closeRuleNote = i.opportunityId && detail.closeRule !== "none" && i.status !== "void"
    ? `Rule for the linked deal: ${CLOSE_RULE_LABELS[detail.closeRule]}.${detail.closeRule === "auto_won" && !i.closesDeal ? " This invoice is not marked to close the deal, so nothing will change it." : ""}`
    : null;
  return (
    <div className="space-y-5">
      <div>
        <Link href="/invoices" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Invoices</Link>
        <h1 className="mt-1 break-words text-[22px] font-semibold tracking-tight text-ink">{i.number ? <span className="tabular-nums">{i.number}</span> : "Draft invoice"}{i.contactName ? <span className="font-normal text-ink-2"> · {i.contactName}</span> : null}</h1>
      </div>
      <InvoiceSummary detail={detail} tz={tz} />
      <InvoiceActions
        invoiceId={i.id} version={i.version} number={i.number} status={i.status} currency={i.currency} balanceMinor={i.balanceMinor} totalMinor={i.totalMinor} facts={facts} tz={tz}
        hasCustomer={i.contactId !== null} closeRuleNote={closeRuleNote}
      />
      <LinesTable detail={detail} />
      {(detail.payments.length > 0 || i.status === "issued") && <PaymentsPanel payments={detail.payments} refunds={detail.refunds} currency={i.currency} canRefund={ctx.can("invoices.refund")} tz={tz} />}
      <RemindersList detail={detail} tz={tz} />
      <Timeline detail={detail} tz={tz} />
    </div>
  );
}
