"use client";

import * as React from "react";
import { Link2, Loader2, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { CopyTextButton } from "@/components/ui/copy-button";
import { createPurchaseIntentAction } from "@/app/actions/purchase-intents";

// The invitation form. It shows the public link once, in this answer: the server stores only its hash and cannot show it again. A lost link is rotated from the
// intent's page.

export function CreatePurchaseIntentForm() {
  const [buyerName, setBuyerName] = React.useState("");
  const [buyerEmail, setBuyerEmail] = React.useState("");
  const [company, setCompany] = React.useState("");
  const [industry, setIndustry] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const [timezone, setTimezone] = React.useState("America/Chicago");
  const [maintenanceSelected, setMaintenanceSelected] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<{ id: string; reference: string; path: string; expiresAt: string } | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await createPurchaseIntentAction({ buyerName, buyerEmail, company, industry, website, timezone, maintenanceSelected });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreated(result.data);
    toast.success("Purchase invitation created.");
  };

  if (created) {
    const url = typeof window === "undefined" ? created.path : `${window.location.origin}${created.path}`;
    return (
      <div className="rounded-2xl border border-success/30 bg-success-soft p-4 sm:p-5">
        <p className="flex items-center gap-2 text-[14px] font-semibold text-success-ink">
          <Link2 className="size-4" aria-hidden /> Invitation {created.reference} is ready
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-success-ink">Send this link to {buyerEmail}. It expires on {new Date(created.expiresAt).toLocaleDateString()}. The link is shown only now; if it is lost, rotate it from the intent&apos;s page.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-success/30 bg-surface px-3 py-2">
          <code className="min-w-0 flex-1 break-all text-[12px] text-ink">{url}</code>
          <CopyTextButton text={url} label="Copy link" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <ButtonLink href={`/admin/purchase-intents/${created.id}`} variant="secondary" size="sm">
            Open the intent
          </ButtonLink>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setCreated(null); setBuyerName(""); setBuyerEmail(""); setCompany(""); setIndustry(""); setWebsite(""); }}>
            <Plus className="size-3.5" aria-hidden /> Create another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex items-center gap-2">
        <Send className="size-4 text-primary" aria-hidden />
        <h2 className="text-[15px] font-semibold text-ink">Invite a buyer</h2>
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted">The link freezes the approved price: US$1,499 setup, plus the optional US$299/month Managed Maintenance + Automation Studio plan. Nothing is sent to the buyer by iAcquire; copy the link into your own email until an email provider is approved.</p>
      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink">{error}</p>}
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
      <label className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">
        <input type="checkbox" checked={maintenanceSelected} onChange={(e) => setMaintenanceSelected(e.target.checked)} className="mt-0.5" />
        <span>
          Include the optional Managed Maintenance + Automation Studio plan at <strong>US$299/month</strong>. This records the buyer&apos;s choice in the price snapshot; it does not charge the plan on this page.
        </span>
      </label>
      <Button type="submit" loading={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />} Create invitation
      </Button>
    </form>
  );
}
