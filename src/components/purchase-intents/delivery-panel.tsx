"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Link2, Loader2, Mail, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { CopyTextButton } from "@/components/ui/copy-button";
import { resendPurchaseInvitationAction } from "@/app/actions/purchase-intents";
import { RESEND_COOLDOWN_SECONDS, type DeliveryView } from "@/lib/purchase-intents/delivery";
import type { PurchaseIntentView } from "@/server/purchase-intents/service";
import { formatDateTime } from "@/lib/utils";

// How the purchase link reached (or did not reach) the buyer, and what a Super Admin can do about it. The same pieces appear on the invitation form's answer and on the purchase's
// page, so the two cannot disagree. A link is a bearer credential that is shown only here, in the answer that made it: it is never stored and cannot be shown again.

/** A key a browser makes once per press: the same press retried is one request, a new press is a new one. */
export function newRequestKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through to the plain generator */
  }
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 40);
}

export function DeliveryBadge({ delivery }: { delivery: DeliveryView | null }) {
  if (!delivery) return <StatusPill tone="neutral" size="sm">No delivery recorded</StatusPill>;
  return <StatusPill tone={delivery.tone} size="sm">{delivery.statusText}</StatusPill>;
}

/** The latest delivery in one honest paragraph, with its status. */
export function DeliveryStatusBlock({ delivery, timeZone }: { delivery: DeliveryView | null; timeZone?: string }) {
  if (!delivery) {
    return <p className="text-[13px] leading-relaxed text-muted">No delivery was recorded for this invitation. It was made before delivery records existed: share its link by hand, or send a new one.</p>;
  }
  const bad = delivery.status === "failed" || delivery.status === "bounced" || delivery.status === "manual" || delivery.stale;
  return (
    <div className="space-y-1.5" role="status">
      <p className="flex flex-wrap items-center gap-2 text-[13px]">
        <DeliveryBadge delivery={delivery} />
        <span className="text-muted">{delivery.kindText} · {formatDateTime(delivery.createdAt, timeZone)}</span>
      </p>
      <p className={`text-[13px] leading-relaxed ${bad ? "text-warning-ink" : "text-ink-2"}`}>{delivery.sentence}</p>
    </div>
  );
}

/** The link that was just made, behind a button when the email went out and open when it did not. */
export function RevealedLink({ path, delivery }: { path: string; delivery: DeliveryView | null }) {
  const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;
  const needed = !delivery || delivery.status !== "sent";
  return (
    <details open={needed} className="group rounded-xl border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium text-ink">
        <Link2 className="size-4 text-primary" aria-hidden />
        {needed ? "Share this link with the buyer yourself" : "Show the link (to share it another way as well)"}
        <ChevronDown className="ml-auto size-4 transition group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-2 border-t border-line px-3 py-3">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
          <code className="min-w-0 flex-1 break-all text-[12px] text-ink">{url}</code>
          <CopyTextButton text={url} label="Copy link" />
        </div>
        <p className="text-[12px] leading-relaxed text-muted">Shown only now: iAcquire keeps only a hash of it and cannot show it again. Making another link replaces this one.</p>
      </div>
    </details>
  );
}

export interface DeliveryChange {
  intent: PurchaseIntentView;
  delivery: DeliveryView | null;
  path: string | null;
}

/**
 * "Send the invitation again" makes a NEW link and emails it; "Make a new link to share by hand" makes one and shows it here. Either replaces the link the buyer has, which is also
 * the answer to a lost, expired or leaked link. A double press is one request (the key), and the server allows one new link a minute.
 */
export function DeliveryActions({ intent, onChanged, emailReady, timeZone }: { intent: PurchaseIntentView; onChanged?: (change: DeliveryChange) => void; emailReady: boolean; timeZone?: string }) {
  const [busy, setBusy] = React.useState<"email" | "hand" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fresh, setFresh] = React.useState<{ path: string; delivery: DeliveryView | null } | null>(null);
  const keys = React.useRef<{ email: string | null; hand: string | null }>({ email: null, hand: null });
  if (!intent.can.rotate) return null;
  const go = async (mode: "email" | "hand") => {
    if (busy) return;
    setBusy(mode);
    setError(null);
    keys.current[mode] ??= newRequestKey();
    try {
      const res = await resendPurchaseInvitationAction({ id: intent.id, email: mode === "email", idempotencyKey: keys.current[mode] as string });
      if (!res.ok) {
        setError(res.error);
        toast.error(res.error);
        return;
      }
      keys.current[mode] = null;
      setFresh(res.data.path ? { path: res.data.path, delivery: res.data.delivery } : null);
      onChanged?.({ intent: res.data.intent, delivery: res.data.delivery, path: res.data.path });
      const d = res.data.delivery;
      if (mode === "hand") toast.success("A new link was made. The old link no longer works.");
      else if (d?.status === "sent") toast.success("A new link was emailed. The old link no longer works.");
      else toast.warning("A new link was made, but no email went out. Share the link yourself.");
    } catch {
      setError("That did not go through. Try again: pressing it again will not send a second email.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => void go("email")} disabled={busy !== null} aria-describedby="delivery-actions-note">
          {busy === "email" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Mail className="size-3.5" aria-hidden />} Send the invitation again
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void go("hand")} disabled={busy !== null} aria-describedby="delivery-actions-note">
          {busy === "hand" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCcw className="size-3.5" aria-hidden />} Make a new link to share by hand
        </Button>
      </div>
      <p id="delivery-actions-note" className="text-[12px] leading-relaxed text-muted">
        Either one makes a new link and the earlier link stops working at once. {emailReady ? "Sending emails the new link to the buyer." : "Email is not set up here, so sending again will only make the link for you to share."} One new link a minute ({RESEND_COOLDOWN_SECONDS}s pause).
      </p>
      {fresh && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-[13px] font-medium text-success-ink"><CheckCircle2 className="size-4" aria-hidden /> New link made</p>
          <DeliveryStatusBlock delivery={fresh.delivery} timeZone={timeZone} />
          <RevealedLink path={fresh.path} delivery={fresh.delivery} />
        </div>
      )}
    </div>
  );
}
