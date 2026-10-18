"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { Segmented, Sheet } from "@/components/ui/overlays";
import { useCrmAction } from "@/components/crm/ui";
import { listWebhookDeliveriesAction, redeliverWebhookAction } from "@/app/actions/crm-developer";
import { formatDateTime } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { DeliveryStatus, WebhookDeliveryView, WebhookSubscriptionView } from "@/server/crm/webhooks";

type Filter = "all" | "failed" | "delivered";

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "primary" }> = {
  pending: { label: "Waiting", tone: "neutral" },
  delivering: { label: "Sending", tone: "primary" },
  delivered: { label: "Delivered", tone: "success" },
  failed: { label: "Will retry", tone: "warning" },
  dead: { label: "Failed", tone: "danger" },
};

/** The delivery log of one webhook: what was sent, what the endpoint answered, and Redeliver. Kept for 30 days. */
export function DeliveriesSheet({ scope, subscription, canManage, onClose }: { scope: CrmScope; subscription: WebhookSubscriptionView; canManage: boolean; onClose: () => void }) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [items, setItems] = React.useState<WebhookDeliveryView[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Bumped to reload the first page (Refresh, after Redeliver); the effect below does the loading.
  const [reload, setReload] = React.useState(0);
  const { run, busy } = useCrmAction();

  const fetchPage = React.useCallback(
    async (from: string | null): Promise<{ items: WebhookDeliveryView[]; nextCursor: string | null } | { error: string }> => {
      try {
        const res = await listWebhookDeliveriesAction(scope.orgId, subscription.id, { filter, cursor: from });
        return res.ok ? res.data : { error: res.error };
      } catch {
        return { error: "The delivery log couldn't be loaded. Check your connection and try again." };
      }
    },
    [filter, scope.orgId, subscription.id],
  );

  // The first page, whenever the filter changes or a reload is asked for. State is only set once the answer arrives.
  React.useEffect(() => {
    let current = true;
    void fetchPage(null).then((page) => {
      if (!current) return;
      if ("error" in page) setError(page.error);
      else {
        setError(null);
        setItems(page.items);
        setCursor(page.nextCursor);
      }
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [fetchPage, reload]);

  const refresh = () => {
    setLoading(true);
    setReload((n) => n + 1);
  };
  const changeFilter = (f: Filter) => {
    if (f === filter) return;
    setLoading(true);
    setItems([]);
    setCursor(null);
    setFilter(f);
  };
  const loadOlder = async () => {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    const page = await fetchPage(cursor);
    if ("error" in page) setError(page.error);
    else {
      setItems((cur) => [...cur, ...page.items]);
      setCursor(page.nextCursor);
    }
    setLoading(false);
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`Deliveries: ${subscription.name}`} description="The last 30 days. Every attempt for an event carries the same event id, so your endpoint can ignore repeats.">
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<Filter>
            id="wh-deliveries"
            ariaLabel="Show deliveries"
            size="sm"
            value={filter}
            onChange={changeFilter}
            options={[{ value: "all", label: "All" }, { value: "failed", label: "Failed" }, { value: "delivered", label: "Delivered" }]}
          />
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className="size-3.5" aria-hidden />Refresh
          </Button>
        </div>

        {error && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-[13px] text-danger-ink">{error}</p>}

        {!error && !loading && !items.length && (
          <p className="rounded-2xl border border-dashed border-line-strong p-5 text-center text-[13px] text-muted">
            {filter === "all" ? "Nothing sent yet. Use Send test, or wait for one of the chosen events." : filter === "failed" ? "No failed deliveries." : "No delivered events yet."}
          </p>
        )}

        <ul className="space-y-2" aria-label="Deliveries" aria-busy={loading || undefined}>
          {items.map((d) => {
            const s = DELIVERY_STATUS[d.status];
            const canRedeliver = canManage && d.status !== "delivering" && d.status !== "pending";
            return (
              <li key={d.id} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[12.5px] font-medium text-ink">{d.eventType}</p>
                    <p className="text-[12px] text-muted">{formatDateTime(d.createdAt, scope.timezone)} · <span className="font-mono">{d.eventId}</span></p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
                  <dt className="text-muted">Attempts</dt>
                  <dd className="text-ink-2">{d.attempts}</dd>
                  {d.responseStatus !== null && (
                    <>
                      <dt className="text-muted">Response</dt>
                      <dd className="text-ink-2">HTTP {d.responseStatus}</dd>
                    </>
                  )}
                  {d.deliveredAt && (
                    <>
                      <dt className="text-muted">Delivered</dt>
                      <dd className="text-ink-2">{formatDateTime(d.deliveredAt, scope.timezone)}</dd>
                    </>
                  )}
                  {d.nextAttemptAt && d.status === "failed" && (
                    <>
                      <dt className="text-muted">Next try</dt>
                      <dd className="text-ink-2">{formatDateTime(d.nextAttemptAt, scope.timezone)}</dd>
                    </>
                  )}
                  {d.lastError && (
                    <>
                      <dt className="text-muted">Error</dt>
                      <dd className="break-words text-danger-ink">{d.lastError}</dd>
                    </>
                  )}
                </dl>
                {canRedeliver && (
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy(`re-${d.id}`)}
                      onClick={async () => {
                        const out = await run(`re-${d.id}`, () => redeliverWebhookAction(scope.orgId, d.id), (o) => (o.status === "delivered" ? "Redelivered." : null));
                        if (out && typeof out === "object" && out.status !== "delivered") toast.error(out.detail);
                        refresh();
                      }}
                    >
                      <RotateCcw className="size-3.5" aria-hidden />Redeliver
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {loading && (
          <p className="flex items-center justify-center gap-2 py-2 text-[13px] text-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />Loading deliveries…
          </p>
        )}
        {cursor && !loading && (
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" onClick={loadOlder}>Load older</Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
