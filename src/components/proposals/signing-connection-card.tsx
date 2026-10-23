"use client";

import * as React from "react";
import { Copy, FileSignature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import {
  checkSigningConnectionAction, connectPandaDocAction, connectSimulatedSigningAction, disconnectSigningAction, getSigningWebhookUrlAction,
} from "@/app/actions/proposals";
import { CONNECTION_STATUS_LABELS } from "@/lib/esign/activity";
import { ESIGN_NOT_ENABLED_MESSAGE } from "@/lib/esign/state";
import { whenIn } from "@/lib/proposals/format";
import type { ConnectionView } from "@/server/esign/connections";

// The business's own signing account (PandaDoc). The account, its cost and its keys are the business's: only the owner or a manager connects it, the keys are checked with the
// service and kept sealed on the server, and nothing here ever shows them again. Connecting sends nothing to anyone. Whether real requests may then be made is a separate switch
// in this environment, and the card says when it is off.

export interface SigningCardProps {
  /** Electronic signing is switched on for the workspace by a Super Admin. */
  enabled: boolean;
  connection: ConnectionView | null;
  canConnect: boolean;
  /** The stand-in service exists (never true in production). */
  simulatedAvailable: boolean;
  tz: string;
}

function Connected({ c, canConnect, tz }: { c: ConnectionView; canConnect: boolean; tz: string }) {
  const { run, busy } = useCrmAction();
  const [address, setAddress] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [ask, setAsk] = React.useState(false);
  async function show() {
    const r = await run("address", () => getSigningWebhookUrlAction());
    if (r && typeof r === "object" && "url" in r) setAddress((r as { url: string }).url);
  }
  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14.5px] font-medium text-ink">{c.providerLabel}{c.label ? `, ${c.label}` : ""}</span>
          <Badge tone={c.status === "connected" ? "success" : "warning"}>{CONNECTION_STATUS_LABELS[c.status] ?? c.status}</Badge>
          {c.mode === "sandbox" && <Badge tone="outline">Sandbox</Badge>}
          {c.mode === "simulated" && <Badge tone="violet">Simulated</Badge>}
        </div>
        {c.accountLabel && <p className="text-[13px] text-ink-2">Account: {c.accountLabel}</p>}
        {c.statusDetail && c.status !== "connected" && <p role="alert" className="text-[13px] text-warning-ink">{c.statusDetail}</p>}
        {c.notice && <p role="status" className="rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{c.notice}</p>}
        <p className="text-[12.5px] text-muted">
          {c.lastCheckedAt ? `The key was last checked ${whenIn(c.lastCheckedAt, tz)}.` : "The key has not been checked yet."} Connected {whenIn(c.connectedAt, tz)}. The saved keys cannot be shown again.
        </p>
      </div>
      {canConnect ? (
        <div className="space-y-4 border-t border-line pt-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy("check")} onClick={() => run("check", () => checkSigningConnectionAction(), "Checked.")}>Check the key now</Button>
            <Button variant="secondary" loading={busy("address")} onClick={show}>Show the notice address</Button>
            <Button variant="outline" onClick={() => setAsk(true)}>Disconnect</Button>
          </div>
          {address && (
            <div className="space-y-2">
              <label htmlFor="sc-address" className="text-[13px] font-medium text-ink-2">Notice address for {c.providerLabel}</label>
              <div className="flex flex-wrap gap-2">
                <Input id="sc-address" readOnly value={address} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 text-[16px] sm:text-[13px]" />
                <Button type="button" variant="secondary" onClick={copy}><Copy className="size-4" aria-hidden />Copy</Button>
              </div>
              <p role="status" className="text-[12.5px] leading-relaxed text-muted">
                {copied ? "Copied." : `Give this to ${c.providerLabel} as the address it sends notices to. Keep it private. A notice is accepted only if it is signed with your shared key, and iAcquire does not mark anything signed from a notice it cannot verify.`}
              </p>
            </div>
          )}
        </div>
      ) : <p className="text-[12.5px] text-muted">Only the business owner or a manager can change or disconnect it.</p>}
      <ConfirmDialog
        open={ask} onOpenChange={setAsk} title="Disconnect the signing service?" confirmLabel="Disconnect" danger loading={busy("disconnect")}
        description="The saved keys are deleted. Signing requests that are out are ended, and a signature that arrives for one afterwards is not applied to the proposal. Proposals themselves are not changed. If a document is still waiting at the signing service, withdraw it there."
        onConfirm={async () => { await run("disconnect", () => disconnectSigningAction(), "Disconnected."); setAsk(false); }}
      />
    </div>
  );
}

function ConnectForm({ simulatedAvailable }: { simulatedAvailable: boolean }) {
  const { run, busy } = useCrmAction();
  const [apiKey, setApiKey] = React.useState("");
  const [webhookKey, setWebhookKey] = React.useState("");
  const [mode, setMode] = React.useState<"sandbox" | "live">("sandbox");
  const [label, setLabel] = React.useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run("connect", () => connectPandaDocAction({ apiKey, webhookKey, mode, label: label || undefined }), "Connected.");
    // The keys do not stay in the page once they are saved.
    if (ok) {
      setApiKey("");
      setWebhookKey("");
    }
  }
  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-4" aria-label="Connect PandaDoc" autoComplete="off">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Connect your own PandaDoc account. The customer signs in PandaDoc, which emails them the document, so any cost is on your PandaDoc plan. iAcquire checks the key with PandaDoc first and
          saves it only if PandaDoc accepts it. Connecting sends nothing to anyone.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PandaDoc API key" htmlFor="sc-key" hint="Paste the whole key, with no spaces.">
            <Input id="sc-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="Webhook shared key" htmlFor="sc-wh" hint="The key PandaDoc shows when you add the notice address. Without it iAcquire cannot tell a real notice from a forged one.">
            <Input id="sc-wh" type="password" autoComplete="off" spellCheck={false} value={webhookKey} onChange={(e) => setWebhookKey(e.target.value)} className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="Is this a test key?" htmlFor="sc-mode">
            <Select id="sc-mode" value={mode} onChange={(e) => setMode(e.target.value as "sandbox" | "live")}>
              <option value="sandbox">Sandbox (a test account)</option>
              <option value="live">Live</option>
            </Select>
          </Field>
          <Field label="Name for this connection" htmlFor="sc-label" optional>
            <Input id="sc-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} className="text-[16px] sm:text-[14px]" />
          </Field>
        </div>
        <Button type="submit" variant="brand" loading={busy("connect")} disabled={apiKey.trim().length < 16 || webhookKey.trim().length < 8}>Connect PandaDoc</Button>
        <p className="text-[12.5px] text-muted">After connecting, use &ldquo;Show the notice address&rdquo; and give that address to PandaDoc, so it can tell iAcquire when a document is opened or signed.</p>
      </form>
      {simulatedAvailable && (
        <div className="space-y-2 rounded-xl border border-dashed border-line p-3">
          <p className="text-[13px] font-medium text-ink-2">Simulated signing service (testing only)</p>
          <p className="text-[12.5px] text-muted">A stand-in that lives inside this server. It sends nothing to anyone, signs nothing for anyone and does not exist in production. It lets you click through asking for a signature.</p>
          <Button variant="secondary" size="sm" loading={busy("sim")} onClick={() => run("sim", () => connectSimulatedSigningAction(), "Connected to the simulated service.")}>Connect the simulated service</Button>
        </div>
      )}
    </div>
  );
}

export function SigningConnectionCard({ enabled, connection, canConnect, simulatedAvailable, tz }: SigningCardProps) {
  return (
    <section aria-label="Signing service" className="space-y-4 rounded-2xl border border-line bg-surface p-5">
      <div>
        <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink"><FileSignature className="size-4 text-muted" aria-hidden />Electronic signing</h2>
        <p className="mt-1 max-w-2xl text-[13px] text-muted">For proposals that need a signature. The signing happens at your own signing service; a signature is recorded only when that service reports it.</p>
      </div>
      {!enabled ? (
        <p className="text-[13.5px] text-ink-2">{ESIGN_NOT_ENABLED_MESSAGE}</p>
      ) : connection ? (
        <Connected c={connection} canConnect={canConnect} tz={tz} />
      ) : canConnect ? (
        <ConnectForm simulatedAvailable={simulatedAvailable} />
      ) : (
        <p className="text-[13.5px] text-ink-2">No signing service is connected. The business owner or a manager can connect one here.</p>
      )}
    </section>
  );
}
