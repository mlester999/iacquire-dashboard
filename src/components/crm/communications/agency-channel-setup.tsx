"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Copy, KeyRound, Mail, MessageCircle, MessageSquareText, Power, PowerOff, RotateCcw, ShieldCheck, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { configureChannelAction, runChannelTestAction, setChannelOnAction, switchChannelToGhlAction, type ChannelSetupInput } from "@/app/actions/crm-communications";
import { cn, formatDateTime } from "@/lib/utils";
import { normalizeEmail, normalizePhone, type Channel } from "@/lib/messaging";
import type { ChannelStatus } from "@/server/messaging/channels";

const ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { email: Mail, sms: MessageSquareText, whatsapp: MessageCircle };
const ORDER: Channel[] = ["email", "sms", "whatsapp"];
type NativeName = "resend" | "twilio" | "meta_whatsapp";
const NATIVE: Record<Channel, { provider: NativeName; label: string }> = {
  email: { provider: "resend", label: "Resend" },
  sms: { provider: "twilio", label: "Twilio" },
  whatsapp: { provider: "meta_whatsapp", label: "WhatsApp Business (Meta)" },
};
const REGISTRATION: Record<string, string> = { not_required: "Not required", not_started: "Not started", pending: "Pending", approved: "Approved", rejected: "Rejected" };

/**
 * Resend webhooks are verified with one agency secret (RESEND_WEBHOOK_SECRET), and Resend generates every webhook's secret itself, so only
 * iAcquire's own Resend account can deliver events this deployment accepts. Shown where the key is entered and next to the webhook.
 */
export const RESEND_ACCOUNT_NOTE =
  "Use an API key from iAcquire's own Resend account. Client-owned Resend accounts aren't supported: their webhooks are signed with a different secret, so bounces, complaints and replies would be refused. The capability test checks this.";

/**
 * Everything a capability test result is about. A run shown on the card belongs to the setup it was run against: once the provider,
 * credential, sender, account or receiving address changes, or a newer result is stored, the card shows the stored result instead.
 */
export function setupSignature(c: Pick<ChannelStatus, "channel" | "provider" | "credentialSavedAt" | "senderId" | "accountId" | "inboundAddress" | "testedAt" | "lastTest">): string {
  return [c.channel, c.provider, c.credentialSavedAt ?? "", c.senderId ?? "", c.accountId ?? "", c.inboundAddress ?? "", c.testedAt ?? "", c.lastTest?.checkedAt ?? ""].join("|");
}

export type TestRun = { setup: string; ok: boolean; checks: Array<{ label: string; ok: boolean; detail: string }> };

/** The test result the card shows: the run just made on this exact setup, or else what is stored. */
export function shownTestResult(c: ChannelStatus, run: TestRun | null): { ok: boolean | null; checks: TestRun["checks"]; fresh: boolean } {
  if (run && run.setup === setupSignature(c)) return { ok: run.ok, checks: run.checks, fresh: true };
  return { ok: c.lastTest ? c.lastTest.ok : null, checks: c.lastTest?.checks ?? [], fresh: false };
}

/** The address or number customers see, without an email's display name. */
function senderAddress(channel: Channel, identity: string | null | undefined): string | null {
  if (!identity?.trim()) return null;
  if (channel !== "email") return normalizePhone(identity);
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(identity.trim());
  return normalizeEmail(named ? named[2] : identity);
}

export interface SetupForm {
  provider: NativeName;
  /** A new secret was typed (any secret field). */
  secretTyped: boolean;
  senderIdentity: string;
  senderId: string;
  accountId: string;
  inboundAddress: string;
}

/**
 * Whether saving this form keeps the channel as it is (on or off, with its test result): the same rule configureNativeChannel applies. Only
 * when nothing the provider test checked changes (same provider and stored credential, sender id, account, receiving address, and the
 * address or number customers see) does it; a new display name alone is fine. Anything else switches a live channel off until it is tested.
 */
export function setupKeepsState(c: ChannelStatus, f: SetupForm): boolean {
  if (!c.native || c.provider !== f.provider || !c.credentialStored || f.secretTyped) return false;
  const account = f.provider === "resend" ? null : f.accountId.trim() || null;
  const inbound = f.provider === "resend" ? normalizeEmail(f.inboundAddress.trim()) ?? (f.inboundAddress.trim() || null) : null;
  return (
    (c.senderId ?? "") === f.senderId.trim() &&
    (c.accountId ?? null) === account &&
    (c.inboundAddress?.toLowerCase() ?? null) === (inbound?.toLowerCase() ?? null) &&
    senderAddress(c.channel, c.senderIdentity) === senderAddress(c.channel, f.senderIdentity)
  );
}

/** The confirmation a save needs, or null: whenever the channel is on now and this save would switch it off. */
export function liveChannelWarning(c: ChannelStatus, f: SetupForm): string | null {
  if (!c.enabled || setupKeepsState(c, f)) return null;
  const target = NATIVE[c.channel].label;
  return c.native && c.provider === f.provider
    ? `${c.channelLabel} is live through ${c.providerLabel}. I understand saving this change switches it off until ${target} passes its test again and it's switched back on.`
    : `${c.channelLabel} is live through ${c.providerLabel}. I understand it stops sending until ${target} passes its test and is switched on.`;
}

export interface WebhookInfo {
  url: string;
  /** The agency-level secret that authenticates this provider's webhooks is configured in this deployment. */
  ready: boolean;
  note: string;
}

interface Props {
  orgId: string;
  channels: ChannelStatus[];
  webhooks: Record<Channel, WebhookInfo>;
  superAdmin: boolean;
  timeZone: string;
}

/** Per-channel provider setup for one client. Read-only for staff; super admins store credentials, test, switch on and off, and move back to GoHighLevel. */
export function AgencyChannelSetup({ orgId, channels, webhooks, superAdmin, timeZone }: Props) {
  const [editing, setEditing] = React.useState<Channel | null>(null);
  const ordered = ORDER.map((c) => channels.find((x) => x.channel === c)).filter((c): c is ChannelStatus => Boolean(c));
  return (
    <div className="space-y-5">
      {!superAdmin && (
        <p className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-muted">You can see each channel&apos;s setup. Only agency super admins enter credentials, run tests and switch channels.</p>
      )}
      <ul className="grid gap-4 xl:grid-cols-3" aria-label="Channels">
        {ordered.map((c) => (
          <li key={c.channel}>
            <ChannelSetupCard orgId={orgId} c={c} webhook={webhooks[c.channel]} superAdmin={superAdmin} timeZone={timeZone} onEdit={() => setEditing(c.channel)} />
          </li>
        ))}
      </ul>
      {editing && <SetupDialog orgId={orgId} c={ordered.find((x) => x.channel === editing)!} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ChannelSetupCard({ orgId, c, webhook, superAdmin, timeZone, onEdit }: { orgId: string; c: ChannelStatus; webhook: WebhookInfo; superAdmin: boolean; timeZone: string; onEdit: () => void }) {
  const { run, busy } = useCrmAction();
  // The run just made, tied to the setup it tested: after "Edit setup", "Back to GoHighLevel" or a newer stored result it no longer shows.
  const [lastRun, setLastRun] = React.useState<TestRun | null>(null);
  const [confirmGhl, setConfirmGhl] = React.useState(false);
  const Icon = ICON[c.channel];
  const native = NATIVE[c.channel];
  const { ok: testOk, checks } = shownTestResult(c, lastRun);
  return (
    <Card className="flex h-full flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><Icon className="size-5" aria-hidden /></span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{c.channelLabel}</h2>
            <p className="text-[12.5px] text-muted">Through {c.providerLabel}</p>
          </div>
        </div>
        {c.enabled ? <Badge tone="success"><Power className="size-3" aria-hidden />On</Badge> : <Badge tone={c.native ? "warning" : "neutral"}>Off</Badge>}
      </div>

      {c.enabled && !c.sendingAllowedHere && (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-2.5 text-[12.5px] leading-relaxed text-warning-ink">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />This deployment&apos;s kill switch for {c.providerLabel} is off, so messages are held instead of sent.
        </p>
      )}

      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
        <dt className="text-muted">Sender</dt>
        <dd className="min-w-0 truncate">{c.senderIdentity ?? <span className="text-muted">Not set</span>}</dd>
        {c.native && (
          <>
            <dt className="text-muted">Sender id</dt>
            <dd className="min-w-0 truncate font-mono text-[12px]">{c.senderId ?? <span className="font-sans text-muted">Not set</span>}</dd>
            {c.channel !== "email" && (
              <>
                <dt className="text-muted">Account</dt>
                <dd className="min-w-0 truncate font-mono text-[12px]">{c.accountId ?? <span className="font-sans text-muted">Not set</span>}</dd>
              </>
            )}
            {c.channel === "email" && (
              <>
                <dt className="text-muted">Receiving address</dt>
                <dd className="min-w-0 truncate">{c.inboundAddress ?? <span className="text-muted">None</span>}</dd>
              </>
            )}
            <dt className="text-muted">Credential</dt>
            <dd className={c.credentialStored ? "text-success-ink" : "text-muted"}>
              {c.credentialStored ? <span className="inline-flex items-center gap-1"><KeyRound className="size-3" aria-hidden />Stored{c.credentialSavedAt ? ` ${formatDateTime(c.credentialSavedAt, timeZone)}` : ""}</span> : "None"}
            </dd>
          </>
        )}
        <dt className="text-muted">Verified</dt>
        <dd>{c.senderVerifiedAt ? formatDateTime(c.senderVerifiedAt, timeZone) : <span className="text-muted">Not yet</span>}</dd>
        {c.channel !== "email" && (
          <>
            <dt className="text-muted">Registration</dt>
            <dd className={c.registrationStatus === "rejected" ? "text-danger-ink" : undefined}>{REGISTRATION[c.registrationStatus] ?? c.registrationStatus}</dd>
          </>
        )}
        <dt className="text-muted">Sending here</dt>
        <dd className={c.sendingAllowedHere ? "text-success-ink" : "text-warning-ink"}>{c.sendingAllowedHere ? "Allowed" : "Kill switch off"}</dd>
      </dl>

      {(checks.length > 0 || c.testedAt) && (
        <section aria-label="Capability test" className="rounded-xl border border-line p-3">
          <p className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className={cn("font-medium", testOk ? "text-success-ink" : "text-danger-ink")}>{testOk ? "Capability test passed" : "Capability test didn't pass"}</span>
            {(c.lastTest?.checkedAt ?? c.testedAt) && <span className="text-muted">{formatDateTime(c.lastTest?.checkedAt ?? c.testedAt, timeZone)}</span>}
          </p>
          <ul className="mt-2 space-y-1.5" aria-live="polite">
            {checks.map((k, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
                {k.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-label="Passed" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger-ink" aria-label="Failed" />}
                <span><span className="font-medium text-ink">{k.label}</span>{k.detail ? <span className="text-muted"> · {k.detail}</span> : null}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {c.readinessIssues.length > 0 && (
        <ul className="space-y-1 text-[12.5px] text-muted" aria-label={c.enabled ? "Why sending is paused" : "Before it can be switched on"}>
          {c.readinessIssues.map((r) => <li key={r} className="flex items-start gap-1.5"><CircleDashed className="mt-0.5 size-3.5 shrink-0" aria-hidden />{r}</li>)}
        </ul>
      )}
      {c.detail && <p className="text-[12px] text-muted">{c.detail}</p>}

      {c.native && (
        <div className="rounded-xl bg-surface-2/70 p-3 text-[12px] leading-relaxed text-muted">
          <p className="mb-1 font-medium text-ink-2">Provider webhook</p>
          <p className="flex items-center gap-1.5">
            <code className="min-w-0 truncate rounded bg-surface px-1.5 py-0.5 font-mono text-[11.5px] text-ink">{webhook.url}</code>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Copy webhook address" onClick={() => void navigator.clipboard?.writeText(webhook.url)}><Copy className="size-3.5" /></Button>
          </p>
          <p className="mt-1">{webhook.note}</p>
          {c.provider === "resend" && <p className="mt-1 text-ink-2">{RESEND_ACCOUNT_NOTE}</p>}
          {!webhook.ready && <p className="mt-1 text-warning-ink">The signing secret for these webhooks isn&apos;t configured in this deployment yet, so they will be refused.</p>}
        </div>
      )}

      {superAdmin && (
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant={c.native ? "secondary" : "primary"} onClick={onEdit}><KeyRound className="size-3.5" aria-hidden />{c.native ? "Edit setup" : `Use ${native.label}`}</Button>
          {c.native && (
            <Button size="sm" variant="secondary" loading={busy("test")} onClick={async () => {
              const setup = setupSignature(c);
              const out = await run("test", () => runChannelTestAction(orgId, c.channel));
              if (out && typeof out === "object") setLastRun({ setup, ok: out.ok, checks: out.checks });
            }}><ShieldCheck className="size-3.5" aria-hidden />Run capability test</Button>
          )}
          {c.enabled ? (
            <Button size="sm" variant="ghost" loading={busy("off")} onClick={() => void run("off", () => setChannelOnAction(orgId, c.channel, false), `${c.channelLabel} switched off.`)}><PowerOff className="size-3.5" aria-hidden />Switch off</Button>
          ) : (
            (c.native || c.ready) && (
              <Button size="sm" disabled={!c.ready} title={c.ready ? undefined : c.readinessIssues.join(" ")} loading={busy("on")} onClick={() => void run("on", () => setChannelOnAction(orgId, c.channel, true), `${c.channelLabel} switched on.`)}>
                <Power className="size-3.5" aria-hidden />Switch on
              </Button>
            )
          )}
          {c.native && <Button size="sm" variant="ghost" onClick={() => setConfirmGhl(true)}><Undo2 className="size-3.5" aria-hidden />Back to GoHighLevel</Button>}
        </div>
      )}
      <ConfirmDialog
        open={confirmGhl}
        onOpenChange={setConfirmGhl}
        title={`Move ${c.channelLabel} back to GoHighLevel?`}
        description={`The ${c.providerLabel} setup is cleared and its stored credential revoked. ${c.channelLabel} stays off until its GoHighLevel sender is verified again.`}
        confirmLabel="Move back"
        danger
        loading={busy("ghl")}
        onConfirm={async () => {
          if (await run("ghl", () => switchChannelToGhlAction(orgId, c.channel), `${c.channelLabel} is on GoHighLevel again.`)) setConfirmGhl(false);
        }}
      />
    </Card>
  );
}

/** The provider form for one channel. Secret fields are password inputs that start empty and are never filled from the server. */
function SetupDialog({ orgId, c, onClose }: { orgId: string; c: ChannelStatus; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const native = NATIVE[c.channel];
  const same = c.native && c.provider === native.provider;
  const keepable = same && c.credentialStored;
  const [senderIdentity, setSenderIdentity] = React.useState(same ? c.senderIdentity ?? "" : "");
  const [senderId, setSenderId] = React.useState(same ? c.senderId ?? "" : "");
  const [accountId, setAccountId] = React.useState(same ? c.accountId ?? "" : "");
  const [inboundAddress, setInboundAddress] = React.useState(same ? c.inboundAddress ?? "" : "");
  const [secret, setSecret] = React.useState("");
  const [apiKeySid, setApiKeySid] = React.useState("");
  const [apiKeySecret, setApiKeySecret] = React.useState("");
  const [replaceLive, setReplaceLive] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const form: SetupForm = { provider: native.provider, secretTyped: Boolean(secret.trim() || apiKeySecret.trim()), senderIdentity, senderId, accountId, inboundAddress };
  // Shown whenever the channel is on now (through GoHighLevel or a native provider) and this save would switch it off.
  const liveWarning = liveChannelWarning(c, form);
  const accountChanged = same && native.provider === "twilio" && accountId.trim() !== (c.accountId ?? "");

  async function save() {
    setError(null);
    if (!keepable && !secret.trim()) return setError("Enter the credential: nothing is stored for this provider yet.");
    if (accountChanged && !secret.trim()) return setError("A different Account SID needs its Auth Token too.");
    if (liveWarning && !replaceLive) return setError(`Confirm that ${c.channelLabel} stops sending until ${native.label} passes its test and is switched on.`);
    const common = { senderIdentity, senderId, replaceLiveChannel: Boolean(liveWarning) && replaceLive };
    const input: ChannelSetupInput =
      native.provider === "resend"
        ? { provider: "resend", apiKey: secret || null, inboundAddress: inboundAddress || null, ...common }
        : native.provider === "twilio"
          ? { provider: "twilio", accountId, authToken: secret || null, apiKeySid: apiKeySid || null, apiKeySecret: apiKeySecret || null, ...common }
          : { provider: "meta_whatsapp", accessToken: secret || null, accountId, ...common };
    const wasOn = c.enabled;
    const ok = await run("save", () => configureChannelAction(orgId, input), (s) =>
      s.enabled
        ? `Saved. ${c.channelLabel} stays on: nothing the capability test checks changed.`
        : wasOn
          ? `Saved. ${c.channelLabel} is off until ${native.label} passes the capability test and it's switched on again.`
          : s.ready
            ? `Saved. ${c.channelLabel} is ready to switch on.`
            : "Saved. Run the capability test next.",
    );
    if (ok) onClose();
  }

  const secretHint = keepable ? "A credential is stored. Leave this empty to keep it; anything you type replaces it." : "Stored encrypted in the credential vault. It's never shown again.";
  const description = !c.enabled
    ? "Saving stores the sender and (if you typed one) the credential. A new or changed setup needs a passing capability test before it can be switched on."
    : same
      ? `${c.channelLabel} is on now. Changing the credential, sender, account or receiving address switches it off until the capability test passes and it's switched on again. Changing only the display name keeps it on.`
      : `${c.channelLabel} is live through ${c.providerLabel} now. Saving moves it to ${native.label}, and it stays off until the capability test passes and you switch it on.`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`${c.channelLabel} through ${native.label}`}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy("save")} onClick={save}><RotateCcw className="size-4" aria-hidden />Save setup</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off">
        {native.provider === "resend" && (
          <>
            <Field label="Resend API key" htmlFor="cs-secret" hint={`${secretHint} ${RESEND_ACCOUNT_NOTE}`}>
              <Input id="cs-secret" type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={keepable ? "Stored: leave empty to keep" : "re_…"} maxLength={4096} />
            </Field>
            <Field label="From address" htmlFor="cs-identity" hint="What customers see, for example Mango Clinic <hello@mangoclinic.com>. Its domain must be verified in Resend.">
              <Input id="cs-identity" value={senderIdentity} onChange={(e) => setSenderIdentity(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Resend domain id" htmlFor="cs-sender" hint="Resend, Domains, then the domain: its id.">
              <Input id="cs-sender" value={senderId} onChange={(e) => setSenderId(e.target.value.trim())} spellCheck={false} maxLength={200} className="font-mono" />
            </Field>
            <Field label="Receiving address" htmlFor="cs-inbound" optional hint="Where customers' email replies arrive, when inbound email is routed to iAcquire through Resend.">
              <Input id="cs-inbound" type="email" value={inboundAddress} onChange={(e) => setInboundAddress(e.target.value)} maxLength={320} />
            </Field>
          </>
        )}
        {native.provider === "twilio" && (
          <>
            <Field label="Account SID" htmlFor="cs-account" hint="Twilio Console, Account Info: AC followed by 32 characters.">
              <Input id="cs-account" value={accountId} onChange={(e) => setAccountId(e.target.value.trim())} spellCheck={false} maxLength={64} className="font-mono" />
            </Field>
            <Field label="Auth Token" htmlFor="cs-secret" hint={`${secretHint} It also verifies Twilio's webhooks.`}>
              <Input id="cs-secret" type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={keepable ? "Stored: leave empty to keep" : ""} maxLength={4096} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="API key SID" htmlFor="cs-keysid" optional hint="Use an API key for sending instead of the Auth Token.">
                <Input id="cs-keysid" value={apiKeySid} onChange={(e) => setApiKeySid(e.target.value.trim())} spellCheck={false} maxLength={64} className="font-mono" />
              </Field>
              <Field label="API key secret" htmlFor="cs-keysecret" optional>
                <Input id="cs-keysecret" type="password" autoComplete="new-password" value={apiKeySecret} onChange={(e) => setApiKeySecret(e.target.value)} maxLength={4096} />
              </Field>
            </div>
            <Field label="Messaging Service SID or number" htmlFor="cs-sender" hint="MG… for a Messaging Service, or the Twilio number in international format.">
              <Input id="cs-sender" value={senderId} onChange={(e) => setSenderId(e.target.value.trim())} spellCheck={false} maxLength={200} className="font-mono" />
            </Field>
            <Field label="Number customers see" htmlFor="cs-identity" hint="International format, for example +639171234567.">
              <Input id="cs-identity" type="tel" value={senderIdentity} onChange={(e) => setSenderIdentity(e.target.value)} maxLength={200} />
            </Field>
          </>
        )}
        {native.provider === "meta_whatsapp" && (
          <>
            <Field label="System User access token" htmlFor="cs-secret" hint={`${secretHint} Needs whatsapp_business_messaging and whatsapp_business_management on the account below.`}>
              <Input id="cs-secret" type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={keepable ? "Stored: leave empty to keep" : ""} maxLength={4096} />
            </Field>
            <Field label="WhatsApp Business Account ID" htmlFor="cs-account" hint="Digits only. Approved templates are read from this account.">
              <Input id="cs-account" value={accountId} onChange={(e) => setAccountId(e.target.value.trim())} inputMode="numeric" maxLength={64} className="font-mono" />
            </Field>
            <Field label="Phone number ID" htmlFor="cs-sender" hint="WhatsApp Manager, Phone numbers: the number's id (digits only), not the number itself.">
              <Input id="cs-sender" value={senderId} onChange={(e) => setSenderId(e.target.value.trim())} inputMode="numeric" maxLength={200} className="font-mono" />
            </Field>
            <Field label="WhatsApp number customers see" htmlFor="cs-identity" hint="International format.">
              <Input id="cs-identity" type="tel" value={senderIdentity} onChange={(e) => setSenderIdentity(e.target.value)} maxLength={200} />
            </Field>
          </>
        )}
        {liveWarning && (
          <label className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning-soft/50 p-3 text-[13px] leading-relaxed text-warning-ink">
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={replaceLive} onChange={(e) => setReplaceLive(e.target.checked)} />
            <span>{liveWarning}</span>
          </label>
        )}
        {error && <p role="alert" className="text-[12.5px] text-danger-ink">{error}</p>}
        <button type="submit" className="sr-only">Save setup</button>
      </form>
    </Dialog>
  );
}
