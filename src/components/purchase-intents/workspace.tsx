"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ShoppingBag } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { CreatePurchaseIntentForm, type CreatePurchaseIntentDefaults, type EmailReadinessView } from "@/components/purchase-intents/create-form";
import { DeliveryBadge } from "@/components/purchase-intents/delivery-panel";
import { formatUsdCents } from "@/lib/purchase-intents/rules";
import type { PurchaseIntentView } from "@/server/purchase-intents/service";
import { formatDateTime } from "@/lib/utils";

// The invitation form and the list of invitations, side by side, as one piece. A new invitation joins the list the moment the server answers (no reload), and the page's own refresh
// then brings the server's copy, which takes over from this one. Nothing here is stored in the browser: the list is the server's, plus the invitations made since it was drawn.

export function PurchaseIntentsWorkspace({ intents, defaults, email, timeZone }: { intents: PurchaseIntentView[]; defaults?: CreatePurchaseIntentDefaults; email: EmailReadinessView; timeZone: string }) {
  const [made, setMade] = React.useState<PurchaseIntentView[]>([]);
  const [changed, setChanged] = React.useState<Record<string, PurchaseIntentView>>({});
  // The server's list wins for anything it already has; an invitation it has not drawn yet is shown from the answer that made it.
  const list = React.useMemo(() => {
    const known = new Set(intents.map((i) => i.id));
    return [...made.filter((m) => !known.has(m.id)), ...intents].map((i) => changed[i.id] ?? i);
  }, [intents, made, changed]);

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <CreatePurchaseIntentForm
        defaults={defaults}
        email={email}
        timeZone={timeZone}
        onCreated={(intent) => setMade((m) => [intent, ...m.filter((x) => x.id !== intent.id)])}
        onChanged={(intent) => setChanged((c) => ({ ...c, [intent.id]: intent }))}
      />
      <Card className="min-w-0" role="region" aria-labelledby="invitations-heading">
        <CardHeader className="pb-2">
          <CardTitle className="flex w-full items-center justify-between gap-2 text-[15px]">
            <span id="invitations-heading" className="flex items-center gap-2"><ShoppingBag className="size-4 text-primary" aria-hidden /> Invitations</span>
            <Badge tone="outline" aria-label={`${list.length} invitation${list.length === 1 ? "" : "s"}`}>{list.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {list.length ? (
            <ul className="divide-y divide-line" aria-live="polite">
              {list.map((intent) => (
                <li key={intent.id} className="py-3 first:pt-0 last:pb-0">
                  <Link href={`/admin/purchase-intents/${intent.id}`} className="group flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-medium text-ink group-hover:text-primary">{intent.company}</span>
                        <StatusPill tone={intent.statusTone} size="sm">{intent.statusText}</StatusPill>
                        <DeliveryBadge delivery={intent.delivery} />
                      </span>
                      <span className="mt-0.5 block text-[12px] text-muted [overflow-wrap:anywhere] sm:truncate sm:[overflow-wrap:normal]">{intent.buyerName} · {intent.buyerEmail}</span>
                      <span className="mt-0.5 block text-[12px] text-muted">
                        {formatUsdCents(intent.setupFeeCents)} setup{intent.maintenanceSelected ? ` + ${formatUsdCents(intent.maintenanceMonthlyCents)}/mo` : " · no maintenance plan"} · {intent.reference}
                      </span>
                      {/* On a phone the expiry sits under the details, so the buyer's name and address get the whole width; from sm up it sits at the right. */}
                      <span className="mt-0.5 block text-[12px] text-muted sm:hidden">Expires {formatDateTime(intent.expiresAt, timeZone)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-right text-[12px] text-muted sm:max-w-[9rem]">
                      <span className="hidden sm:inline">Expires<br />{formatDateTime(intent.expiresAt, timeZone)}</span>
                      <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" aria-hidden />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-[14px] leading-relaxed text-muted">No invitations yet. Create one on the left; it will appear here at once with its status and how the link reached the buyer.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
