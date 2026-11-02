import * as React from "react";
import { StatusPill } from "@/components/ui/status";
import { DeliveryBadge } from "@/components/purchase-intents/delivery-panel";
import { formatUsdCents } from "@/lib/purchase-intents/rules";
import type { PurchaseIntentView } from "@/server/purchase-intents/service";
import { formatDateTime } from "@/lib/utils";

// One way to say what an invitation is: its reference, who it is for, when its link stops working, where it stands and how the link reached the buyer. The invitation form's answer, the
// list and the purchase's own page all use it, in the same words and with dates in the same zone (the signed-in person's), so what is shown on one is what is shown on the others.

export function InvitationFacts({ intent, timeZone, className }: { intent: PurchaseIntentView; timeZone?: string; className?: string }) {
  return (
    <dl className={`grid grid-cols-1 gap-x-6 gap-y-2.5 text-[13px] sm:grid-cols-2 ${className ?? ""}`}>
      <div className="min-w-0"><dt className="text-[12px] text-muted">Reference</dt><dd className="break-all font-medium text-ink">{intent.reference}</dd></div>
      <div className="min-w-0"><dt className="text-[12px] text-muted">Status</dt><dd><StatusPill tone={intent.statusTone} size="sm">{intent.statusText}</StatusPill></dd></div>
      <div className="min-w-0"><dt className="text-[12px] text-muted">Recipient</dt><dd className="break-words text-ink">{intent.buyerName}<span className="block break-all text-muted">{intent.buyerEmail}</span></dd></div>
      <div className="min-w-0"><dt className="text-[12px] text-muted">Link expires</dt><dd className="text-ink">{formatDateTime(intent.expiresAt, timeZone)}</dd></div>
      <div className="min-w-0"><dt className="text-[12px] text-muted">Offer</dt><dd className="text-ink">{formatUsdCents(intent.setupFeeCents)} setup{intent.maintenanceSelected ? ` + ${formatUsdCents(intent.maintenanceMonthlyCents)}/mo` : ", no maintenance plan"}</dd></div>
      <div className="min-w-0"><dt className="text-[12px] text-muted">Invitation email</dt><dd><DeliveryBadge delivery={intent.delivery} /></dd></div>
    </dl>
  );
}
