"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, History, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCcwDot, Send, Trash2, Webhook, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { deleteWebhookAction, rotateWebhookSecretAction, sendTestWebhookAction, setWebhookActiveAction } from "@/app/actions/crm-developer";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/crm/relative-time";
import type { CrmScope } from "@/server/crm/page";
import type { DeliveryOutcome, WebhookSubscriptionView } from "@/server/crm/webhooks";
import { OneTimeSecret } from "./shared";
import { WebhookDialog, type EventInfo } from "./webhook-dialog";
import { DeliveriesSheet } from "./deliveries-sheet";

const SECRET_NOTE = "This is the only time the signing secret is shown. It's stored encrypted for signing and can't be displayed again; if you lose it, roll a new one.";

function statusOf(s: WebhookSubscriptionView): { label: string; tone: "success" | "warning" | "danger" } {
  if (s.active) return { label: "Active", tone: "success" };
  if (s.disabledReason?.startsWith("Turned off automatically")) return { label: "Turned off", tone: "danger" };
  return { label: "Paused", tone: "warning" };
}

export function WebhooksSection({ scope, subscriptions, events, maxSubscriptions, autoDisableAfter, canManage }: { scope: CrmScope; subscriptions: WebhookSubscriptionView[]; events: EventInfo[]; maxSubscriptions: number; autoDisableAfter: number; canManage: boolean }) {
  const [dialog, setDialog] = React.useState<{ editing: WebhookSubscriptionView | null } | null>(null);
  const [secret, setSecret] = React.useState<{ title: string; value: string } | null>(null);
  const [deleting, setDeleting] = React.useState<WebhookSubscriptionView | null>(null);
  const [rolling, setRolling] = React.useState<WebhookSubscriptionView | null>(null);
  const [log, setLog] = React.useState<WebhookSubscriptionView | null>(null);
  const [results, setResults] = React.useState<Record<string, DeliveryOutcome>>({});
  const { run, busy } = useCrmAction();
  const labels = React.useMemo(() => new Map(events.map((e) => [e.type, e.label])), [events]);

  return (
    <section aria-labelledby="dev-webhooks" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="dev-webhooks" className="text-[15px] font-semibold text-ink">Webhooks</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">
            iAcquire tells your app the moment something happens, with a signed request it can verify. Failed deliveries are retried for about two days.
          </p>
        </div>
        {canManage && (
          <Button variant="secondary" onClick={() => setDialog({ editing: null })} disabled={subscriptions.length >= maxSubscriptions}>
            <Plus className="size-4" aria-hidden />Add webhook
          </Button>
        )}
      </div>

      {subscriptions.length ? (
        <ul className="grid gap-3 lg:grid-cols-2" aria-label="Webhooks">
          {subscriptions.map((s) => {
            const st = statusOf(s);
            const result = results[s.id];
            return (
              <li key={s.id}>
                <Card className="flex h-full flex-col p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><Webhook className="size-4.5" aria-hidden /></span>
                      <div className="min-w-0">
                        <h3 className="truncate text-[14.5px] font-semibold text-ink">{s.name}</h3>
                        <p className="truncate font-mono text-[12px] text-muted" title={s.url}>{s.url}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {canManage && (
                        <Menu>
                          <MenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${s.name}`}><MoreHorizontal className="size-4" /></Button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem onSelect={() => setDialog({ editing: s })}><Pencil className="size-4" aria-hidden />Edit</MenuItem>
                            <MenuItem onSelect={() => run(`active-${s.id}`, () => setWebhookActiveAction(scope.orgId, s.id, !s.active), s.active ? "Webhook paused." : "Webhook resumed.")}>
                              {s.active ? <><Pause className="size-4" aria-hidden />Pause</> : <><Play className="size-4" aria-hidden />Resume</>}
                            </MenuItem>
                            <MenuItem onSelect={() => setRolling(s)}><RefreshCcwDot className="size-4" aria-hidden />Roll signing secret</MenuItem>
                            <MenuSeparator />
                            <MenuItem destructive onSelect={() => setDeleting(s)}><Trash2 className="size-4" aria-hidden />Delete</MenuItem>
                          </MenuContent>
                        </Menu>
                      )}
                    </div>
                  </div>

                  {!s.active && s.disabledReason && (
                    <p className={cn("mt-3 flex items-start gap-2 rounded-xl p-2.5 text-[13px] leading-relaxed", st.tone === "danger" ? "bg-danger-soft text-danger-ink" : "bg-surface-2 text-ink-2")}>
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>{s.disabledReason}{st.tone === "danger" ? " Events that happen while it is off aren't queued." : ""}</span>
                    </p>
                  )}
                  {s.active && s.consecutiveFailures > 0 && (
                    <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-soft p-2.5 text-[13px] leading-relaxed text-warning-ink">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {s.consecutiveFailures} failed {s.consecutiveFailures === 1 ? "delivery" : "deliveries"} in a row. It is turned off automatically after {autoDisableAfter}.
                    </p>
                  )}

                  <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
                    <dt className="text-muted">Events</dt>
                    <dd className="min-w-0 text-ink-2">
                      {s.eventTypes.length <= 3 ? s.eventTypes.map((t) => labels.get(t) ?? t).join(", ") : `${s.eventTypes.slice(0, 2).map((t) => labels.get(t) ?? t).join(", ")} and ${s.eventTypes.length - 2} more`}
                    </dd>
                    <dt className="text-muted">Last 24 h</dt>
                    <dd className="text-ink-2">
                      {s.stats.delivered24h} delivered · <span className={s.stats.failed24h ? "text-danger-ink" : undefined}>{s.stats.failed24h} failed</span> · {s.stats.queued} waiting
                    </dd>
                    <dt className="text-muted">Last delivered</dt>
                    <dd className="text-ink-2">{s.stats.lastDeliveredAt ? <RelativeTime iso={s.stats.lastDeliveredAt} timezone={scope.timezone} /> : "Never"}</dd>
                    <dt className="text-muted">Signing secret</dt>
                    <dd className="font-mono text-ink-2">whsec_{s.secretHint}</dd>
                  </dl>

                  <div aria-live="polite">
                    {result && (
                      <p className={cn("mt-3 flex items-start gap-2 text-[13px] leading-relaxed", result.status === "delivered" ? "text-success-ink" : "text-danger-ink")}>
                        {result.status === "delivered" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
                        <span>Test {result.status === "delivered" ? "delivered" : "failed"}: {result.detail}</span>
                      </p>
                    )}
                  </div>

                  <div className="mt-auto flex flex-wrap gap-2 pt-4">
                    {canManage && (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busy(`test-${s.id}`)}
                        onClick={async () => {
                          const out = await run(`test-${s.id}`, () => sendTestWebhookAction(scope.orgId, s.id));
                          if (out && typeof out === "object") {
                            setResults((r) => ({ ...r, [s.id]: out }));
                            if (out.status === "delivered") toast.success("Test delivered.");
                            else toast.error("The test delivery failed. See the details on the card.");
                          }
                        }}
                      >
                        <Send className="size-3.5" aria-hidden />Send test
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setLog(s)}><History className="size-3.5" aria-hidden />Deliveries</Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : (
        <Card className="p-0">
          <EmptyState
            compact
            icon={<Webhook className="size-5" aria-hidden />}
            title="No webhooks yet"
            description={canManage ? "Add the address of an app that should hear about new contacts, booked appointments, won deals and more." : "Owners and managers can add webhooks."}
          />
        </Card>
      )}
      {canManage && subscriptions.length >= maxSubscriptions && <p className="text-[12px] text-muted">This workspace has the most webhooks it can have ({maxSubscriptions}). Delete one to add another.</p>}

      {dialog && (
        <WebhookDialog
          scope={scope}
          events={events}
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onCreated={(value) => {
            setDialog(null);
            setSecret({ title: "Copy the signing secret", value });
          }}
        />
      )}
      {secret && <OneTimeSecret open title={secret.title} description="Your endpoint uses it to check the iAcquire-Signature header of every delivery." note={SECRET_NOTE} secret={secret.value} onClose={() => setSecret(null)} />}
      {log && <DeliveriesSheet scope={scope} subscription={log} canManage={canManage} onClose={() => setLog(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? `Delete “${deleting.name}”?` : "Delete webhook?"}
        description="Its delivery log goes with it, and deliveries waiting to be sent are dropped. This can't be undone."
        confirmLabel="Delete webhook"
        danger
        loading={busy("delete")}
        onConfirm={async () => {
          if (deleting && (await run("delete", () => deleteWebhookAction(scope.orgId, deleting.id), "Webhook deleted."))) setDeleting(null);
        }}
      />
      <ConfirmDialog
        open={!!rolling}
        onOpenChange={(o) => !o && setRolling(null)}
        title="Roll the signing secret?"
        description="The current secret stops working immediately, so update your endpoint with the new one straight away. Deliveries sent until then fail verification."
        confirmLabel="Roll secret"
        loading={busy("roll")}
        onConfirm={async () => {
          if (!rolling) return;
          const out = await run("roll", () => rotateWebhookSecretAction(scope.orgId, rolling.id), "New secret created.");
          if (out && typeof out === "object") {
            setRolling(null);
            setSecret({ title: "Copy the new signing secret", value: out.secret });
          }
        }}
      />
    </section>
  );
}
