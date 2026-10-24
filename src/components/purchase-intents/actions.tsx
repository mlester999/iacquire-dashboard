"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, KeyRound, Link2, Loader2, RefreshCcw, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/primitives";
import { CopyTextButton } from "@/components/ui/copy-button";
import { cancelPurchaseIntentAction, provisionPurchaseIntentAction, rotatePurchaseLinkAction, verifyPurchasePaymentAction } from "@/app/actions/purchase-intents";
import { MANUAL_METHOD_LABEL, MANUAL_PAYMENT_METHODS, centsToDollarText, type ManualPaymentMethod } from "@/lib/billing-clearance";
import type { PurchaseIntentView } from "@/server/purchase-intents/service";

// What a Super Admin can do on one purchase intent. Every button calls a server action that re-reads the payment evidence and permissions; this component only
// chooses which controls to show.

export function PurchaseIntentActions({ intent }: { intent: PurchaseIntentView }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [rotated, setRotated] = React.useState<string | null>(null);
  const [provisioned, setProvisioned] = React.useState<{ orgId: string; inviteLink: string | null } | null>(null);
  const [showPayment, setShowPayment] = React.useState(false);
  const [showCancel, setShowCancel] = React.useState(false);
  const [amount, setAmount] = React.useState(centsToDollarText(intent.setupFeeCents));
  const [method, setMethod] = React.useState<ManualPaymentMethod>("bank_transfer");
  const [externalReference, setExternalReference] = React.useState("");
  const [paidOn, setPaidOn] = React.useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = React.useState("");
  const [reason, setReason] = React.useState("");

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) => {
    setBusy(key);
    setError(null);
    const result = await fn();
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? "That did not work.");
      return false;
    }
    return true;
  };

  const rotate = async () => {
    setBusy("rotate");
    setError(null);
    const result = await rotatePurchaseLinkAction(intent.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRotated(`${window.location.origin}${result.data.path}`);
    toast.success("A new link was issued. The old link no longer works.");
    router.refresh();
  };

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await run("verify", () => verifyPurchasePaymentAction({ id: intent.id, amount, method, externalReference, paidOn, note }));
    if (!ok) return;
    toast.success("Payment verified. Create the client workspace next.");
    setShowPayment(false);
    router.refresh();
  };

  const provision = async () => {
    const result = await provisionPurchaseIntentAction(intent.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setProvisioned({ orgId: result.data.clientOrgId, inviteLink: result.data.inviteLink });
    toast.success("Client workspace created and setup payment recorded.");
    router.refresh();
  };

  const cancel = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await run("cancel", () => cancelPurchaseIntentAction({ id: intent.id, reason }));
    if (!ok) return;
    toast.success("Purchase cancelled.");
    setShowCancel(false);
    router.refresh();
  };

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink">{error}</p>}
      {rotated && (
        <div className="rounded-xl border border-primary/30 bg-primary-soft p-3">
          <p className="text-[12.5px] font-medium text-primary-ink">New public link (shown once):</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-surface px-2.5 py-1.5">
            <code className="min-w-0 flex-1 break-all text-[11.5px] text-ink">{rotated}</code>
            <CopyTextButton text={rotated} label="Copy" />
          </div>
        </div>
      )}
      {provisioned && (
        <div className="rounded-xl border border-success/30 bg-success-soft p-3">
          <p className="flex items-center gap-2 text-[12.5px] font-medium text-success-ink">
            <CheckCircle2 className="size-4" aria-hidden /> Workspace created
          </p>
          <p className="mt-1 text-[12px] text-success-ink">The client invitation and the setup-payment audit belong to the new workspace. {provisioned.inviteLink ? "Copy the client invitation link below." : "The invitation email was handed to the configured provider."}</p>
          {provisioned.inviteLink && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-success/30 bg-surface px-2.5 py-1.5">
              <code className="min-w-0 flex-1 break-all text-[11.5px] text-ink">{provisioned.inviteLink}</code>
              <CopyTextButton text={provisioned.inviteLink} label="Copy invite" />
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {intent.can.verify && (
          <Button type="button" size="sm" onClick={() => setShowPayment((v) => !v)} disabled={busy !== null}>
            <KeyRound className="size-3.5" aria-hidden /> Record verified payment
          </Button>
        )}
        {intent.can.provision && (
          <Button type="button" size="sm" variant="brand" onClick={() => void provision()} loading={busy === "provision"} disabled={busy !== null}>
            <UserPlus className="size-3.5" aria-hidden /> Create client workspace
          </Button>
        )}
        {intent.can.rotate && (
          <Button type="button" size="sm" variant="secondary" onClick={() => void rotate()} loading={busy === "rotate"} disabled={busy !== null}>
            <RefreshCcw className="size-3.5" aria-hidden /> Issue a new link
          </Button>
        )}
        {intent.can.cancel && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowCancel((v) => !v)} disabled={busy !== null}>
            <AlertTriangle className="size-3.5" aria-hidden /> Cancel
          </Button>
        )}
        {intent.clientOrgId && (
          <a href={`/admin/clients/${intent.clientOrgId}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-line px-3 text-[12.5px] text-ink-2 hover:bg-surface-2">
            <Link2 className="size-3.5" aria-hidden /> Open the client workspace
          </a>
        )}
      </div>

      {showPayment && (
        <form onSubmit={verify} className="space-y-3 rounded-xl border border-line bg-surface-2 p-3">
          <p className="text-[12.5px] leading-relaxed text-ink-2">Record the setup payment you checked in the bank, PayPal or PayMongo account. The amount must equal the frozen fee; the note is private to the team.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="pi-amount">Amount (USD)</Label>
              <Input id="pi-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="mt-1" required />
            </div>
            <div>
              <Label htmlFor="pi-method">How it arrived</Label>
              <select id="pi-method" value={method} onChange={(e) => setMethod(e.target.value as ManualPaymentMethod)} className="mt-1 h-10 w-full rounded-xl border border-line-strong bg-surface px-3 text-[13px] text-ink">
                {MANUAL_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{MANUAL_METHOD_LABEL[m]}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="pi-reference">External reference</Label>
              <Input id="pi-reference" value={externalReference} onChange={(e) => setExternalReference(e.target.value)} className="mt-1" placeholder="Bank reference or transaction id" required />
            </div>
            <div>
              <Label htmlFor="pi-paid-on">Day the money arrived</Label>
              <Input id="pi-paid-on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="mt-1" required />
            </div>
          </div>
          <div>
            <Label htmlFor="pi-note">What you checked</Label>
            <Textarea id="pi-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} className="mt-1" placeholder="Statement line, dashboard entry or receipt number" required />
          </div>
          <Button type="submit" size="sm" loading={busy === "verify"} disabled={busy !== null}>Verify and record</Button>
        </form>
      )}

      {showCancel && (
        <form onSubmit={cancel} className="space-y-2 rounded-xl border border-danger/30 bg-danger-soft p-3">
          <Label htmlFor="pi-cancel-reason">Why is it being cancelled?</Label>
          <Textarea id="pi-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} minLength={10} maxLength={500} className="mt-1" required />
          <Button type="submit" size="sm" variant="danger" loading={busy === "cancel"} disabled={busy !== null}>Cancel the purchase</Button>
        </form>
      )}
      {busy && busy !== "verify" && busy !== "cancel" && busy !== "rotate" && busy !== "provision" && (
        <p className="flex items-center gap-2 text-[12px] text-muted" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Working…</p>
      )}
    </div>
  );
}
