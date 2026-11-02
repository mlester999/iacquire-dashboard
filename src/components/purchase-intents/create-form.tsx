"use client";

import * as React from "react";
import { CheckCircle2, Info, Loader2, Mail, MailWarning, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { createPurchaseIntentAction } from "@/app/actions/purchase-intents";
import { DeliveryActions, DeliveryStatusBlock, newRequestKey, RevealedLink, type DeliveryChange } from "@/components/purchase-intents/delivery-panel";
import { InvitationFacts } from "@/components/purchase-intents/invitation-summary";
import { EmailSetupChecker } from "@/components/purchase-intents/email-setup-check";
import type { DeliveryView } from "@/lib/purchase-intents/delivery";
import type { PurchaseIntentView } from "@/server/purchase-intents/service";

// The invitation form. Creating an invitation EMAILS the buyer by default, because that is what an invitation is for; the Super Admin confirms first, and the answer says what really
// happened to the email (never "delivered" for a message the email provider only accepted). If email is not set up, or the Super Admin unticks it, the invitation is still made and
// the link is handed over to share by hand. The link is shown once, in this answer: the server stores only its hash and cannot show it again.
//
// `defaults` comes from a demo prospect when a Super Admin follows "Create purchase invitation" on that prospect: the same existing service, the same frozen price and the same public
// /purchase/<token> page. Nothing is created by the demo itself.

export interface CreatePurchaseIntentDefaults {
  /** The demo prospect the form was opened from. It is sent with the invitation so the two records say where it came from. */
  prospectId?: string;
  buyerName?: string;
  buyerEmail?: string;
  company?: string;
  industry?: string;
  timezone?: string;
}

export interface EmailReadinessView {
  ready: boolean;
  sender: string;
  problems: string[];
  warnings: string[];
}

export interface InvitationResult {
  replayed: boolean;
  intent: PurchaseIntentView;
  path: string | null;
  delivery: DeliveryView | null;
}

/**
 * The answer to creating an invitation: what was made, how the link reached the buyer (or that it did not), the link to share by hand when it did not, and the same actions the
 * invitation's own page offers. A separate component so the form and a design preview draw exactly the same thing.
 */
export function InvitationCreated({ result, emailReady, timeZone, onChanged, onReset }: { result: InvitationResult; emailReady: boolean; timeZone?: string; onChanged?: (change: DeliveryChange) => void; onReset?: () => void }) {
  const { intent, delivery, path, replayed } = result;
  const emailed = delivery?.status === "sent";
  return (
    <div className={`rounded-2xl border p-4 sm:p-5 ${emailed ? "border-success/30 bg-success-soft" : "border-warning/40 bg-warning-soft"}`} role="status">
      <p className={`flex items-start gap-2 text-[15px] font-semibold ${emailed ? "text-success-ink" : "text-warning-ink"}`}>
        {emailed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <MailWarning className="mt-0.5 size-4 shrink-0" aria-hidden />}
        <span>{replayed ? `Invitation ${intent.reference} was already made` : emailed ? `Invitation ${intent.reference} was created and emailed` : `Invitation ${intent.reference} was created, but nothing was emailed`}</span>
      </p>
      <div className="mt-3 space-y-3 rounded-xl border border-line bg-surface p-3.5 text-ink">
        <InvitationFacts intent={intent} timeZone={timeZone} />
        <DeliveryStatusBlock delivery={delivery} timeZone={timeZone} />
        {replayed && <p className="text-[13px] leading-relaxed text-ink-2">This is the invitation your earlier request already made. Nothing new was created and no second email was sent. Its link was shown once and cannot be shown again: use &ldquo;Make a new link&rdquo; below if you need one.</p>}
        {path && <RevealedLink path={path} delivery={delivery} />}
      </div>
      <div className="mt-3 rounded-xl border border-line bg-surface p-3.5">
        <DeliveryActions intent={intent} emailReady={emailReady} onChanged={onChanged} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <ButtonLink href={`/admin/purchase-intents/${intent.id}`} variant="secondary" size="sm">Open the invitation</ButtonLink>
        {onReset && <Button type="button" variant="ghost" size="sm" onClick={onReset}><Plus className="size-3.5" aria-hidden /> Create another</Button>}
      </div>
    </div>
  );
}

export function CreatePurchaseIntentForm({ defaults, email, timeZone, onCreated, onChanged }: {
  defaults?: CreatePurchaseIntentDefaults;
  email: EmailReadinessView;
  timeZone?: string;
  onCreated?: (intent: PurchaseIntentView) => void;
  onChanged?: (intent: PurchaseIntentView) => void;
}) {
  const [buyerName, setBuyerName] = React.useState(defaults?.buyerName ?? "");
  const [buyerEmail, setBuyerEmail] = React.useState(defaults?.buyerEmail ?? "");
  const [company, setCompany] = React.useState(defaults?.company ?? "");
  const [industry, setIndustry] = React.useState(defaults?.industry ?? "");
  const [website, setWebsite] = React.useState("");
  const [timezone, setTimezone] = React.useState(defaults?.timezone ?? "America/Chicago");
  const [maintenanceSelected, setMaintenanceSelected] = React.useState(false);
  const [autoProvision, setAutoProvision] = React.useState(false);
  const [sendEmail, setSendEmail] = React.useState(true);
  const [confirming, setConfirming] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<InvitationResult | null>(null);
  // One key per invitation being made: a retry of the same request (a double press, a dropped connection) is the same invitation and the same email. It changes only after a success.
  const [requestKey, setRequestKey] = React.useState(() => newRequestKey());

  const willEmail = sendEmail && email.ready;
  const reset = () => {
    setResult(null);
    setBuyerName("");
    setBuyerEmail("");
    setCompany("");
    setIndustry("");
    setWebsite("");
    setSendEmail(true);
    setRequestKey(newRequestKey());
  };

  const create = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await createPurchaseIntentAction({ buyerName, buyerEmail, company, industry, website, timezone, maintenanceSelected, autoProvision, sendEmail, idempotencyKey: requestKey, prospectId: defaults?.prospectId });
      if (!res.ok) {
        setError(res.error);
        setConfirming(false);
        return;
      }
      setConfirming(false);
      setResult(res.data);
      setRequestKey(newRequestKey());
      onCreated?.(res.data.intent);
      const status = res.data.delivery?.status;
      if (res.data.replayed) toast.info("That invitation was already made. Nothing new was created or sent.");
      else if (status === "sent") toast.success("Invitation created and emailed to the buyer.");
      else toast.warning("Invitation created, but no email went out. Share the link yourself.");
    } catch {
      setError("That did not go through. Press the button again: it will not make a second invitation or send a second email.");
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (willEmail) setConfirming(true);
    else void create();
  };

  if (result) {
    return (
      <InvitationCreated
        result={result}
        emailReady={email.ready}
        timeZone={timeZone}
        onChanged={(change) => {
          setResult({ replayed: false, intent: change.intent, path: change.path ?? null, delivery: change.delivery });
          onChanged?.(change.intent);
        }}
        onReset={reset}
      />
    );
  }

  return (
    <>
      <form onSubmit={submit} className="space-y-3 rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5" aria-label="Invite a buyer">
        <div className="flex items-center gap-2">
          <Send className="size-4 text-primary" aria-hidden />
          <h2 className="text-[15px] font-semibold text-ink">Invite a buyer</h2>
        </div>
        <p className="text-[13px] leading-relaxed text-muted">The link freezes the approved price: US$1,499 setup, plus the optional US$299/month Managed Maintenance + Automation Studio plan. Nothing is charged by creating an invitation.</p>
        {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="pi-name">Buyer name</Label>
            <Input id="pi-name" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} required maxLength={120} className="mt-1" autoComplete="name" />
          </div>
          <div>
            <Label htmlFor="pi-email">Buyer email</Label>
            <Input id="pi-email" type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} required maxLength={254} className="mt-1" autoComplete="email" />
          </div>
          <div>
            <Label htmlFor="pi-company">Company</Label>
            <Input id="pi-company" value={company} onChange={(e) => setCompany(e.target.value)} required maxLength={120} className="mt-1" autoComplete="organization" />
          </div>
          <div>
            <Label htmlFor="pi-industry">Industry (optional)</Label>
            <Input id="pi-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={120} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="pi-website">Website (optional)</Label>
            <Input id="pi-website" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={300} className="mt-1" placeholder="https://" />
          </div>
          <div>
            <Label htmlFor="pi-timezone">Business time zone</Label>
            <Select id="pi-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} className="mt-1">
              <option value="America/Chicago">America/Chicago</option>
              <option value="America/New_York">America/New_York</option>
              <option value="America/Denver">America/Denver</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
              <option value="Asia/Manila">Asia/Manila</option>
              <option value="Asia/Singapore">Asia/Singapore</option>
              <option value="UTC">UTC</option>
            </Select>
          </div>
        </div>
        <label className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink-2">
          <input type="checkbox" checked={maintenanceSelected} onChange={(e) => setMaintenanceSelected(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
          <span>
            Include the optional Managed Maintenance + Automation Studio plan at <strong>US$299/month</strong>. This records the buyer&apos;s choice in the price snapshot; it does not charge the plan on this page.
          </span>
        </label>
        <label className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink-2">
          <input type="checkbox" checked={autoProvision} onChange={(e) => setAutoProvision(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
          <span>
            Create the workspace by itself once the payment provider confirms the payment online. <span className="text-muted">It runs with your permissions, checked again at that moment, and only after the provider&apos;s signed confirmation of the exact fee; a refund, dispute or mismatch always waits for a person. Leave this off to create the workspace yourself.</span>
          </span>
        </label>
        <div className={`rounded-xl border px-3 py-2.5 text-[13px] leading-relaxed ${email.ready ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-warning/40 bg-warning-soft text-warning-ink"}`}>
          <label className="flex min-h-6 items-start gap-2 max-sm:min-h-11">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} className="mt-0.5 size-4 shrink-0" aria-describedby="pi-email-note" />
            <span><strong className="font-semibold">Email the invitation to the buyer now.</strong> Creating the invitation will send them a branded email with their secure purchase link{buyerEmail ? <> at <span className="break-all">{buyerEmail}</span></> : null}.</span>
          </label>
          <div id="pi-email-note" className="mt-1.5 flex items-start gap-2 pl-6 text-[12.5px]">
            {email.ready ? <Mail className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
            <span>
              {email.ready
                ? `Sent from ${email.sender}. The email says the link is private and nothing is charged until they pay.`
                : "Email is not set up in this environment, so nothing can be sent yet. The invitation will still be created and you will be given the link to share yourself."}
              {!email.ready && email.problems.length > 0 && <span className="mt-1 block">{email.problems.join(" ")}</span>}
              {email.warnings.map((w) => <span key={w} className="mt-1 block text-muted">{w}</span>)}
              {!sendEmail && <span className="mt-1 block">Unticked: no email will be sent. You will be given the link to share yourself.</span>}
            </span>
          </div>
          <EmailSetupChecker />
        </div>
        <Button type="submit" loading={saving && !confirming}>
          {saving && !confirming ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />} {willEmail ? "Create and email invitation" : "Create invitation"}
        </Button>
      </form>
      <Dialog
        open={confirming}
        onOpenChange={(open) => { if (!open && !saving) setConfirming(false); }}
        title="Create the invitation and email the buyer?"
        description="This sends a real email to the address below. You can send it again later, but each new link replaces the last one."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={saving}>Not yet</Button>
            <Button type="button" variant="brand" onClick={() => void create()} loading={saving}>{saving ? "Creating…" : "Create and email"}</Button>
          </>
        }
      >
        <dl className="grid gap-2 text-[14px]">
          <div><dt className="text-[12px] text-muted">To</dt><dd className="break-all font-medium text-ink">{buyerName} &lt;{buyerEmail}&gt;</dd></div>
          <div><dt className="text-[12px] text-muted">Company</dt><dd className="text-ink">{company}</dd></div>
          <div><dt className="text-[12px] text-muted">Offer</dt><dd className="text-ink">US$1,499 setup{maintenanceSelected ? " + US$299/month maintenance" : ", no maintenance plan"}</dd></div>
          <div><dt className="text-[12px] text-muted">From</dt><dd className="break-all text-ink">{email.sender}</dd></div>
        </dl>
      </Dialog>
    </>
  );
}
