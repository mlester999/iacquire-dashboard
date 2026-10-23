import { Badge } from "@/components/ui/primitives";
import { PAYMENT_STATUS_LABELS, STATUS_EXPLAIN, STATUS_LABELS, type InvoicePaymentStatus, type InvoiceStatus } from "@/lib/invoices/state";
import { PAYMENT_ROW_LABELS } from "@/lib/invoices/labels";

type Tone = NonNullable<React.ComponentProps<typeof Badge>["tone"]>;

const STATUS_TONE: Record<InvoiceStatus, Tone> = { draft: "neutral", pending_approval: "warning", issued: "primary", void: "outline" };
const PAYMENT_TONE: Record<InvoicePaymentStatus, Tone> = { unpaid: "neutral", partially_paid: "warning", paid: "success", disputed: "danger" };

/** Colour is never the only signal: every status also has its words, and the tooltip is the sentence the invoice page prints. */
export function StatusBadge({ status, className }: { status: InvoiceStatus; className?: string }) {
  return <Badge tone={STATUS_TONE[status]} className={className} title={STATUS_EXPLAIN[status]}>{STATUS_LABELS[status]}</Badge>;
}

/** What has been received. "Paid" is shown only for an invoice the database says is paid. */
export function PaymentBadge({ status, className }: { status: InvoicePaymentStatus; className?: string }) {
  return <Badge tone={PAYMENT_TONE[status]} className={className}>{PAYMENT_STATUS_LABELS[status]}</Badge>;
}

export function OverdueBadge({ days, className }: { days: number; className?: string }) {
  return <Badge tone="danger" className={className}>{days > 0 ? `${days} ${days === 1 ? "day" : "days"} overdue` : "Overdue"}</Badge>;
}

const ROW_TONE: Record<string, Tone> = { succeeded: "success", pending: "warning", failed: "danger", needs_review: "warning", partially_refunded: "neutral", refunded: "neutral", disputed: "danger" };

export function PaymentRowBadge({ status, testMode, className }: { status: string; testMode?: boolean; className?: string }) {
  return (
    <>
      <Badge tone={ROW_TONE[status] ?? "neutral"} className={className}>{PAYMENT_ROW_LABELS[status] ?? status}</Badge>
      {testMode && <Badge tone="violet" className={className} title="The payment provider ran this in test mode. No real money moved.">Test mode</Badge>}
    </>
  );
}
