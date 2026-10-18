"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Select } from "@/components/ui/primitives";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { approveTemplateAction, testSendTemplateAction, type TestSendOutcome } from "@/app/actions/crm-templates";
import { cn } from "@/lib/utils";
import { CHANNEL_LABELS } from "@/lib/messaging";
import { emptyRequiredValues } from "@/lib/messaging/tokens";
import { useCustomValueTokens } from "@/components/crm/custom-values/token-catalog";
import type { CrmScope } from "@/server/crm/page";
import type { TemplateDetail, WhatsappTemplateView } from "@/server/crm/message-templates";
import { ChannelLabel, TokenHighlight } from "@/components/crm/templates/parts";
import { whatsappTemplateState, whatsappTemplateWhyNot } from "@/components/crm/templates/whatsapp-templates";
import type { ChannelState, TestDestination } from "@/components/crm/templates/types";

/**
 * Approving binds exactly the saved version shown here (its number and content fingerprint). If anyone saves a newer version meanwhile, the
 * server refuses and nothing is approved.
 */
export function ApproveDialog({ scope, template, whatsapp, open, onOpenChange }: { scope: CrmScope; template: TemplateDetail; whatsapp: WhatsappTemplateView | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { run, busy } = useCrmAction();
  const marketing = template.purpose === "marketing";
  // Required configuration values this wording uses that are empty: it can be approved, but every send waits until they're filled in.
  const empty = emptyRequiredValues(useCustomValueTokens(), template.channel === "email" ? template.subject : null, template.body);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Approve version ${template.currentVersion} of "${template.name}"`}
      description="Automations and scheduled messages will send exactly this wording. Editing it later creates a new version that needs approving again."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={busy("approve")}
            onClick={async () => {
              const ok = await run("approve", () => approveTemplateAction(scope.orgId, template.id, { version: template.currentVersion, contentHash: template.contentHash }), `Version ${template.currentVersion} approved.`);
              if (ok) onOpenChange(false);
            }}
          >
            <ShieldCheck className="size-4" aria-hidden />Approve v{template.currentVersion}
          </Button>
        </>
      }
    >
      <dl className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[140px_minmax(0,1fr)]">
        <dt className="text-muted">Channel</dt>
        <dd><ChannelLabel channel={template.channel} /></dd>
        <dt className="text-muted">Purpose</dt>
        <dd>{marketing ? <Badge tone="violet">Marketing</Badge> : <Badge>Service</Badge>}</dd>
        {template.channel === "whatsapp" && (
          <>
            <dt className="text-muted">WhatsApp template</dt>
            <dd>
              {whatsapp ? (
                <>
                  {`${whatsapp.name} (${whatsapp.language}) · ${whatsappTemplateState(whatsapp).label}`}
                  {whatsappTemplateWhyNot(whatsapp) && <span className="mt-0.5 block text-[12px] text-muted">{whatsappTemplateWhyNot(whatsapp)}</span>}
                  {whatsapp.provider === "meta_whatsapp" && <span className="mt-0.5 block text-[12px] text-muted">WhatsApp delivers the linked template&apos;s own wording, so this text must follow it exactly, with each value in its place.</span>}
                </>
              ) : "None linked: this wording is only delivered within 24 hours of the customer's last message."}
            </dd>
          </>
        )}
        <dt className="text-muted">Version</dt>
        <dd>v{template.currentVersion} · <span className="font-mono text-[12px]" title={template.contentHash}>#{template.contentHash.slice(0, 12)}</span></dd>
        {template.channel === "email" && (
          <>
            <dt className="text-muted">Subject</dt>
            <dd className="font-medium"><TokenHighlight text={template.subject ?? ""} /></dd>
          </>
        )}
      </dl>
      <div className="mt-3 rounded-xl border border-line bg-surface-2/60 p-3.5 text-[13.5px] leading-relaxed">
        <TokenHighlight text={template.body} />
      </div>
      {empty.length > 0 && (
        <p role="status" className="mt-3 flex gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-warning-ink">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {empty.map((d) => `“${d.label}”`).join(", ")} {empty.length === 1 ? "is a required configuration value and is empty" : "are required configuration values and are empty"}, so every message
            using this template is held until {empty.length === 1 ? "it is" : "they are"} filled in. You can approve it now and fill {empty.length === 1 ? "it" : "them"} in under{" "}
            <Link href={`${scope.base}/settings/values`} className="font-medium underline">CRM Settings → Configuration Values</Link>.
          </span>
        </p>
      )}
      <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
        {marketing
          ? "Marketing messages only go to people who agreed to marketing on this channel, and a send to anyone else is refused."
          : "Service messages go to people who contacted you or agreed to messages on this channel. Opt-outs are always respected."}{" "}
        A message is never sent with a token left unfilled: if a value is missing for someone, that send is held with the reason.
      </p>
    </Dialog>
  );
}

/**
 * Sends the saved version to one of the workspace's approved test destinations, through the same rules as any message. When the channel
 * isn't ready the reason is shown first, and the server still decides: it sends nothing unless every check passes.
 */
export function TestSendDialog({
  scope, template, channelState, destinations, canConfigure, open, onOpenChange,
}: {
  scope: CrmScope;
  template: TemplateDetail;
  channelState: ChannelState | undefined;
  destinations: TestDestination[];
  canConfigure: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { run, busy } = useCrmAction();
  const mine = destinations.filter((d) => d.channel === template.channel);
  const [destination, setDestination] = React.useState(mine[0]?.address ?? "");
  const [source, setSource] = React.useState<"sample" | "contact">("sample");
  const [contact, setContact] = React.useState<{ id: string; name: string } | null>(null);
  const [outcome, setOutcome] = React.useState<TestSendOutcome | null>(null);
  const search = React.useCallback(async (q: string) => {
    const res = await searchContactsAction(scope.orgId, q);
    return res.ok ? res.data.map((c) => ({ id: c.id, name: c.name || c.email || c.phone || "Unnamed contact" })) : [];
  }, [scope.orgId]);
  const label = template.channel ? CHANNEL_LABELS[template.channel] : "";
  const notReady = channelState && (!channelState.enabled ? channelState.whyOff ?? `${label} isn't enabled yet.` : !channelState.writesEnabled ? `Sending through ${channelState.providerLabel} is switched off in this environment.` : null);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Send a test of "${template.name}"`}
      description={`Sends saved version ${template.currentVersion} to an address your workspace approved for tests. It goes through the same consent, opt-out and credit checks as any message, and uses credits like one.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            loading={busy("test")}
            disabled={!destination || (source === "contact" && !contact)}
            onClick={async () => {
              setOutcome(null);
              const res = await run("test", () => testSendTemplateAction(scope.orgId, template.id, { destination, contactId: source === "contact" ? contact?.id ?? null : null }));
              if (res && typeof res === "object") setOutcome(res);
            }}
          >
            <Send className="size-4" aria-hidden />Send test
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {notReady && (
          <p role="status" className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-[12.5px] leading-relaxed text-warning-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{notReady} A test can&apos;t be delivered until that changes; sending now only confirms the reason.</span>
          </p>
        )}
        {mine.length ? (
          <Field label={`${label} test destination`} htmlFor="ts-dest">
            <Select id="ts-dest" value={destination} onChange={(e) => setDestination(e.target.value)}>
              {mine.map((d) => <option key={d.address} value={d.address}>{d.label ? `${d.label} · ${d.address}` : d.address}</option>)}
            </Select>
          </Field>
        ) : (
          <p className="rounded-xl border border-dashed border-line-strong p-3 text-[13px] leading-relaxed text-muted">
            No {label} test destinations are approved yet. Tests only ever go to your own addresses, never to customers.{" "}
            {canConfigure ? <Link href={`${scope.base}/settings/communications`} className="font-medium text-primary hover:underline">Approve one in Communication Settings</Link> : "Ask an owner or manager to approve one in Communication Settings."}
          </p>
        )}
        {scope.can["contacts.view"] && (
          <div className="space-y-2">
            <p className="text-[13px] font-medium text-ink-2">Fill the tokens with</p>
            <Segmented id="ts-src" size="sm" ariaLabel="Fill the tokens with" value={source} onChange={setSource} options={[{ value: "sample", label: "Sample values" }, { value: "contact", label: "A contact's details" }]} />
            {source === "contact" && (
              <RecordPicker id="ts-contact" label="Contact whose details to use" placeholder="Search your contacts" search={search} render={(c) => c.name} onPick={setContact} value={contact?.name} onClear={() => setContact(null)} />
            )}
            <p className="text-[12px] text-muted">The test still goes to the destination above, not to the contact.</p>
          </div>
        )}
        {outcome && (
          <div role="status" className={cn("flex items-start gap-2 rounded-xl p-3 text-[13px] leading-relaxed", outcome.ok && (outcome.status === "sent" || outcome.status === "delivered" || outcome.status === "read" || outcome.status === "queued") ? "bg-success-soft text-success-ink" : "bg-danger-soft text-danger-ink")}>
            {outcome.ok && outcome.status !== "failed" && outcome.status !== "blocked" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <span>{outcome.ok ? <><strong>{outcome.statusLabel}.</strong> {outcome.detail}</> : outcome.detail}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
