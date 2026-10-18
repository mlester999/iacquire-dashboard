"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCircle2, CircleDashed, Clock, LifeBuoy, Mail, MessageCircle, MessageSquareText, Plus, Power, Trash2, XCircle } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { ConfirmDialog, PageTitle, useCrmAction } from "@/components/crm/ui";
import { addTestDestinationAction, removeTestDestinationAction, requestChannelSetupAction } from "@/app/actions/crm-communications";
import { cn, formatDateTime } from "@/lib/utils";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import type { CrmScope } from "@/server/crm/page";
import type { ChannelSettingsView, TestDestinationView } from "@/server/crm/message-templates";

const ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { email: Mail, sms: MessageSquareText, whatsapp: MessageCircle };
const ORDER: Channel[] = ["email", "sms", "whatsapp"];
const REGISTRATION: Record<string, string> = { not_required: "Not required", not_started: "Not started", pending: "Pending review", approved: "Approved", rejected: "Rejected" };
const NATIVE_OPTION: Record<Channel, string> = { email: "Resend", sms: "Twilio", whatsapp: "WhatsApp Business (Meta)" };

export interface CommunicationSettingsProps {
  scope: CrmScope;
  channels: ChannelSettingsView[];
  destinations: TestDestinationView[];
  openRequests: Array<{ ref: string; status: string; createdAt: string }>;
  canConfigure: boolean;
  canRequestSetup: boolean;
  /** In an agency support session: where the agency connects providers. */
  agencySetupHref: string | null;
}

function StatusBadge({ c }: { c: ChannelSettingsView }) {
  if (c.enabled) return <Badge tone="success"><Power className="size-3" aria-hidden />On</Badge>;
  if (!c.configured) return <Badge>Not set up</Badge>;
  return <Badge tone="warning">Off</Badge>;
}

/** One channel: provider, sender, verification and registration, the last connection test check by check, and why it's off. */
function ChannelCard({ c, scope, canRequestSetup, onRequest }: { c: ChannelSettingsView; scope: CrmScope; canRequestSetup: boolean; onRequest: (ch: Channel) => void }) {
  const Icon = ICON[c.channel];
  const test = c.lastTest;
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><Icon className="size-5" aria-hidden /></span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-ink">{CHANNEL_LABELS[c.channel]}</h3>
            <p className="text-[12.5px] text-muted">{c.configured ? `Through ${c.providerLabel}` : `GoHighLevel or ${NATIVE_OPTION[c.channel]}`}</p>
          </div>
        </div>
        <StatusBadge c={c} />
      </div>

      {c.whyOff && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 p-2.5 text-[12.5px] leading-relaxed text-ink-2">
          <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />{c.whyOff}
        </p>
      )}
      {c.enabled && !c.writesEnabled && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-soft p-2.5 text-[12.5px] leading-relaxed text-warning-ink">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />Sending through {c.providerLabel} is switched off in this environment, so messages are held instead of sent.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12.5px]">
        <dt className="text-muted">Sender</dt>
        <dd className="min-w-0 truncate text-ink">{c.senderIdentity ?? <span className="text-muted">Not set</span>}</dd>
        {c.channel === "email" && c.inboundAddress && (
          <>
            <dt className="text-muted">Replies to</dt>
            <dd className="min-w-0 truncate text-ink">{c.inboundAddress}</dd>
          </>
        )}
        <dt className="text-muted">Verified</dt>
        <dd className={c.senderVerified ? "text-success-ink" : "text-muted"}>{c.senderVerified ? "Yes" : "Not yet"}</dd>
        {c.channel !== "email" && (
          <>
            <dt className="text-muted">Registration</dt>
            <dd className={c.registrationStatus === "rejected" ? "text-danger-ink" : "text-ink"}>{REGISTRATION[c.registrationStatus] ?? c.registrationStatus}</dd>
          </>
        )}
        {c.detail && (
          <>
            <dt className="text-muted">Note</dt>
            <dd className="text-ink-2">{c.detail}</dd>
          </>
        )}
      </dl>

      {test && (
        <div className="mt-4 rounded-xl border border-line p-3">
          <p className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className={cn("font-medium", test.ok ? "text-success-ink" : "text-danger-ink")}>{test.ok ? "Last connection test passed" : "Last connection test failed"}</span>
            {test.at && <span className="text-muted">{formatDateTime(test.at, scope.timezone)}</span>}
          </p>
          {test.checks.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {test.checks.map((k, i) => (
                <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
                  {k.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-label="Passed" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger-ink" aria-label="Failed" />}
                  <span><span className="font-medium text-ink">{k.label}</span>{k.detail ? <span className="text-muted"> · {k.detail}</span> : null}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canRequestSetup && !c.enabled && (
        <div className="mt-auto pt-4">
          <Button variant="secondary" size="sm" onClick={() => onRequest(c.channel)}><LifeBuoy className="size-3.5" aria-hidden />Ask iAcquire to set this up</Button>
        </div>
      )}
    </Card>
  );
}

/** Communication Settings for the client's CRM. Providers are connected by iAcquire; the client sees the state, never a credential. */
export function CommunicationSettings({ scope, channels, destinations, openRequests, canConfigure, canRequestSetup, agencySetupHref }: CommunicationSettingsProps) {
  const [requesting, setRequesting] = React.useState<Channel | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<TestDestinationView | null>(null);
  const { run, busy } = useCrmAction();
  const ordered = ORDER.map((ch) => channels.find((c) => c.channel === ch)).filter((c): c is ChannelSettingsView => Boolean(c));

  return (
    <div className="space-y-8">
      <PageTitle
        title="Communication settings"
        description="How your workspace sends and receives email, text messages and WhatsApp. iAcquire connects each channel to GoHighLevel or to its own provider and tests it before it can be switched on."
        actions={agencySetupHref ? <ButtonLink href={agencySetupHref} variant="secondary">Set up channels<ArrowUpRight className="size-4" aria-hidden /></ButtonLink> : undefined}
      />

      {openRequests.length > 0 && (
        <p role="status" className="flex items-start gap-2 rounded-2xl border border-line bg-surface-2/60 p-3 text-[13px] text-ink-2">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <span>You asked iAcquire for channel setup: {openRequests.map((r) => `${r.ref} (${formatDateTime(r.createdAt, scope.timezone)})`).join(", ")}. The team replies in Support.</span>
        </p>
      )}

      <section aria-labelledby="cs-channels">
        <h2 id="cs-channels" className="sr-only">Channels</h2>
        <ul className="grid gap-4 lg:grid-cols-3" aria-label="Channels">
          {ordered.map((c) => (
            <li key={c.channel}><ChannelCard c={c} scope={scope} canRequestSetup={canRequestSetup} onRequest={setRequesting} /></li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="cs-rules" className="grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <h2 id="cs-rules" className="text-[15px] font-semibold text-ink">Sending rules</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">Quiet hours, business hours, automatic replies and follow-up pacing apply to every channel and provider alike.</p>
          {scope.agency ? (
            <p className="mt-3 text-[12.5px] text-muted">The client manages these in their portal under Settings, Messaging.</p>
          ) : (
            <Link href="/settings/messaging" className="mt-3 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-primary hover:underline sm:min-h-0">Open messaging rules<ArrowUpRight className="size-3.5" aria-hidden /></Link>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="text-[15px] font-semibold text-ink">Templates and canned replies</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">Reusable wording for each channel. Automations only send a version someone in your team approved.</p>
          <Link href={`${scope.base}/templates`} className="mt-3 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-primary hover:underline sm:min-h-0">Open templates<ArrowUpRight className="size-3.5" aria-hidden /></Link>
        </Card>
      </section>

      <section aria-labelledby="cs-dest">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="cs-dest" className="text-[15px] font-semibold text-ink">Approved test destinations</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">Your own phone numbers and inboxes that templates may be test-sent to. Customers are never test recipients.</p>
          </div>
          {canConfigure && <Button variant="secondary" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />Add destination</Button>}
        </div>
        {destinations.length ? (
          <Card className="divide-y divide-line overflow-hidden p-0">
            {destinations.map((d) => {
              const I = ICON[d.channel];
              return (
                <div key={`${d.channel}:${d.address}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <I className="size-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-ink">{d.label || d.address}</p>
                    <p className="truncate text-[12px] text-muted">{d.label ? `${d.address} · ` : ""}{CHANNEL_LABELS[d.channel]} · approved{d.approvedByName ? ` by ${d.approvedByName}` : ""} {formatDateTime(d.approvedAt, scope.timezone)}</p>
                  </div>
                  {canConfigure && <Button variant="ghost" size="icon-sm" aria-label={`Remove ${d.address}`} onClick={() => setRemoving(d)}><Trash2 className="size-4" /></Button>}
                </div>
              );
            })}
          </Card>
        ) : (
          <p className="rounded-2xl border border-dashed border-line-strong p-5 text-center text-[13px] text-muted">
            {canConfigure ? "None yet. Add your own number or inbox to try templates before customers see them." : "None yet. Owners and managers can add them."}
          </p>
        )}
      </section>

      {adding && <AddDestinationDialog scope={scope} onClose={() => setAdding(false)} />}
      {requesting && <RequestSetupDialog channel={requesting} onClose={() => setRequesting(null)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this test destination?"
        description={removing ? `${removing.address} can no longer receive template tests.` : undefined}
        confirmLabel="Remove"
        danger
        loading={busy("remove")}
        onConfirm={async () => {
          if (removing && (await run("remove", () => removeTestDestinationAction(scope.orgId, { channel: removing.channel, address: removing.address }), "Removed."))) setRemoving(null);
        }}
      />
    </div>
  );
}

function AddDestinationDialog({ scope, onClose }: { scope: CrmScope; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [channel, setChannel] = React.useState<Channel>("sms");
  const [address, setAddress] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Add a test destination"
      description="Template tests can be sent here. Use an address that belongs to you or your business."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy("add")} disabled={!address.trim() || !confirm} onClick={async () => {
            if (await run("add", () => addTestDestinationAction(scope.orgId, { channel, address, label, confirmOwnAddress: confirm }), "Test destination approved.")) onClose();
          }}>Approve destination</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Channel" htmlFor="td-channel">
          <Select id="td-channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {ORDER.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
          </Select>
        </Field>
        <Field label={channel === "email" ? "Email address" : "Phone number"} htmlFor="td-address" hint={channel === "email" ? undefined : "International format, starting with + and the country code, for example +15555550123."}>
          <Input id="td-address" value={address} onChange={(e) => setAddress(e.target.value)} type={channel === "email" ? "email" : "tel"} autoComplete="off" inputMode={channel === "email" ? "email" : "tel"} maxLength={320} />
        </Field>
        <Field label="Label" htmlFor="td-label" optional hint="For example: Maria's phone.">
          <Input id="td-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </Field>
        <label className="flex items-start gap-2.5 rounded-xl border border-line p-3 text-[13px] leading-relaxed text-ink-2">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>This address belongs to me or my business, and I agree to receive test messages on it. It is not a customer&apos;s.</span>
        </label>
      </div>
    </Dialog>
  );
}

function RequestSetupDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [note, setNote] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Ask iAcquire to set up ${CHANNEL_LABELS[channel]}`}
      description="This opens a support request. The iAcquire team connects the provider, runs the connection test and tells you when it's ready."
      footer={
        sent ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button loading={busy("req")} onClick={async () => {
              const res = await run("req", () => requestChannelSetupAction({ channel, note: note.trim() || undefined }));
              if (res && typeof res === "object") setSent(res.ref);
            }}>Send request</Button>
          </>
        )
      }
    >
      {sent ? (
        <p role="status" className="flex items-start gap-2 text-[13.5px] leading-relaxed text-success-ink"><CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />Request {sent} sent. You can follow it in Support.</p>
      ) : (
        <Field label="Anything we should know?" htmlFor="rs-note" optional hint={channel === "email" ? "For example the address you'd like to send from." : channel === "sms" ? "For example the number you'd like customers to text." : "For example the WhatsApp number you'd like to use."}>
          <Textarea id="rs-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1500} />
        </Field>
      )}
    </Dialog>
  );
}
