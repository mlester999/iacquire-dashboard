"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Copy, FlaskConical, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import {
  confirmLiveAction, connectProviderAction, disconnectConnectionAction, pauseConnectionAction, recentDeliveriesAction, recheckConnectionAction, replaceKeysAction, saveWebhookSecretAction,
} from "@/app/actions/invoices";
import { AUTHORIZATION_TEXTS, CURRENT_AUTHORIZATION_VERSION, PROVIDER_LABELS, type PaymentProviderId, type PaypalEnvironment } from "@/lib/invoices/connection-rules";
import { formatInstant } from "@/lib/invoices/labels";
import type { ConnectionView, DeliveryView } from "@/server/customer-payments/connections";

// The business's own payment account. The keys pasted here go straight into sealed storage on the server and are never shown again, logged or sent anywhere but to the
// provider. Connected means the provider accepted the key and the webhook secret is saved: it does not mean the provider can reach this product, and nothing is live until the
// owner has seen a test payment succeed and confirmed. iAcquire never holds the money; customers pay the provider, which pays the business.

const input16 = "text-[16px] sm:text-[14px]";
const ACTION = "w-full sm:w-auto";
const TONE: Record<ConnectionView["status"], React.ComponentProps<typeof Badge>["tone"]> = { pending_verification: "warning", connected: "success", needs_attention: "danger", disabled: "outline", revoked: "outline" };

export interface ConnectionsPanelProps {
  connections: ConnectionView[];
  /** Providers the owner can connect (the simulated one only outside production). */
  providers: PaymentProviderId[];
  callsEnabled: boolean;
  liveEnabled: boolean;
  tz: string;
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied.");
    } catch {
      toast.error("Could not copy. Select the text and copy it yourself.");
    }
  };
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id={id} readOnly value={value} className={input16} onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="secondary" onClick={copy}><Copy className="size-4" aria-hidden />Copy</Button>
      </div>
    </Field>
  );
}

function WebhookHelp({ provider }: { provider: PaymentProviderId }) {
  if (provider === "paypal") {
    return <p className="text-[13px] text-muted">In your PayPal app, add a webhook for the address above. Choose the events for a payment capture (completed, pending, denied, refunded, reversed) and for a dispute (created, resolved). Then paste the <span className="font-medium">Webhook ID</span> PayPal shows for it. Event names are from PayPal&apos;s documentation and have not been checked against a live app.</p>;
  }
  if (provider === "paymongo") {
    return <p className="text-[13px] text-muted">In your PayMongo dashboard, add a webhook for the address above (events for a paid checkout, a failed payment and a refund). PayMongo shows a signing secret for it; paste that here. Event names are from PayMongo&apos;s documentation and have not been checked against a live account.</p>;
  }
  return <p className="text-[13px] text-muted">The simulated provider makes its own secret and needs nothing to be set up. It exists only outside production.</p>;
}

function Deliveries({ id, tz }: { id: string; tz: string }) {
  // `rows` stays null until the server has answered with a list (possibly an empty one): "nothing has arrived" is said only then, never because the load failed.
  const [rows, setRows] = React.useState<DeliveryView[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setProblem(null);
    try {
      const r = await recentDeliveriesAction(id);
      if (r.ok) setRows(r.data as DeliveryView[]);
      else setProblem(r.error);
    } catch {
      setProblem("Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <details className="rounded-xl border border-line px-3 py-2" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open && rows === null && !loading) void load(); }}>
      <summary className="min-h-11 cursor-pointer text-[14px] font-medium text-ink-2 sm:min-h-8">What the provider has sent</summary>
      {loading && <p className="mt-2 text-[13px] text-muted">Loading…</p>}
      {problem && (
        <div role="alert" className="mt-2 space-y-2 rounded-xl bg-warning-soft px-3 py-2.5 text-[13px] text-warning-ink">
          <p><span className="font-medium">Could not load what the provider has sent.</span> {problem}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>Try again</Button>
        </div>
      )}
      {rows && rows.length === 0 && <p className="mt-2 text-[13px] text-muted">Nothing has arrived from this provider yet. After you set up the webhook, run a test payment and it should appear here.</p>}
      {rows && rows.length > 0 && (
        <ul className="mt-2 divide-y divide-line text-[13px]" aria-label="Recent deliveries">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap gap-x-3 gap-y-0.5 py-1.5">
              <span className="font-mono text-ink-2">{d.type}</span>
              <Badge tone={d.outcome === "processed" ? "success" : d.outcome === "error" || d.outcome === "rejected" ? "danger" : "neutral"}>{d.outcome}</Badge>
              <span className="text-muted">{formatInstant(d.at, tz)}</span>
              {d.note && <span className="basis-full text-ink-2">{d.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ConnectionCard({ c, tz, callsEnabled, liveEnabled }: { c: ConnectionView; tz: string; callsEnabled: boolean; liveEnabled: boolean }) {
  const { run, busy } = useCrmAction();
  const [dialog, setDialog] = React.useState<null | "keys" | "disconnect" | "live">(null);
  const [secret, setSecret] = React.useState("");
  const [keys, setKeys] = React.useState({ apiKey: "", apiSecret: "", environment: (c.environment ?? "sandbox") as PaypalEnvironment, webhookSecret: "", accept: false });
  const isPaypal = c.provider === "paypal";
  const secretLabel = isPaypal ? "Webhook ID" : "Webhook signing secret";
  return (
    <li className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[16px] font-semibold text-ink">{c.providerLabel}</h3>
        <Badge tone={c.mode === "live" ? "primary" : "violet"}>{c.mode === "live" ? "Live mode" : "Test mode"}</Badge>
        <Badge tone={TONE[c.status]}>{c.statusLabel}</Badge>
        {c.liveConfirmedAt && <Badge tone="success">Live confirmed</Badge>}
      </div>
      <p className="text-[14px] text-ink-2">{c.statusExplain}</p>
      <p className="text-[13px] text-muted">{c.providerNote}</p>
      {!c.credentialsReadable && <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-[14px] text-danger-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />The saved keys can no longer be read. Replace them to use this account.</p>}
      {c.lastError && <p role="alert" className="rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink">{c.lastError}</p>}
      <dl className="grid gap-x-6 gap-y-1 text-[14px] sm:grid-cols-2">
        <div><dt className="inline text-muted">Takes: </dt><dd className="inline text-ink-2">{c.supportedCurrencies.join(", ") || "nothing yet"}</dd></div>
        {c.environment && <div><dt className="inline text-muted">PayPal app: </dt><dd className="inline text-ink-2">{c.environment === "live" ? "live" : "sandbox (testing)"}</dd></div>}
        <div><dt className="inline text-muted">Last checked with the provider: </dt><dd className="inline text-ink-2">{c.lastCheckedAt ? formatInstant(c.lastCheckedAt, tz) : "not yet"}</dd></div>
        <div><dt className="inline text-muted">Last message from the provider: </dt><dd className="inline text-ink-2">{c.lastEventAt ? formatInstant(c.lastEventAt, tz) : "none yet"}</dd></div>
        <div><dt className="inline text-muted">Authorized by the owner: </dt><dd className="inline text-ink-2">{c.authorizedAt ? formatInstant(c.authorizedAt, tz) : "not recorded"}</dd></div>
        <div><dt className="inline text-muted">A test payment confirmed by the provider: </dt><dd className="inline text-ink-2">{c.hasConfirmedTestPayment ? "yes" : "not yet"}</dd></div>
      </dl>

      {c.provider !== "simulated" && <CopyField id={`wh-${c.id}`} label="Webhook address (give this to the provider)" value={c.webhookUrl} />}
      <WebhookHelp provider={c.provider} />
      {c.provider !== "simulated" && !c.webhookSecretSaved && (
        <div className="space-y-2">
          <Field label={secretLabel} htmlFor={`sec-${c.id}`} hint="Until this is saved, messages from the provider are refused and payments cannot be confirmed."><Input id={`sec-${c.id}`} type="password" autoComplete="off" spellCheck={false} className={input16} value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
          <Button className={ACTION} variant="secondary" loading={busy("secret")} disabled={!secret.trim()} onClick={async () => { const r = await run("secret", () => saveWebhookSecretAction(c.id, { webhookSecret: secret }), `${secretLabel} saved.`); if (r) setSecret(""); }}>Save {secretLabel.toLowerCase()}</Button>
        </div>
      )}
      {c.webhookSecretSaved && c.provider !== "simulated" && <p className="flex items-center gap-1.5 text-[14px] text-success-ink"><CheckCircle2 className="size-4" aria-hidden />{secretLabel} saved. It is not shown again.</p>}

      <div className="rounded-xl bg-surface-2/60 px-3 py-2.5 text-[14px] text-ink-2">
        <p className="flex items-center gap-1.5 font-medium text-ink"><FlaskConical className="size-4" aria-hidden />Run a test payment</p>
        <p className="mt-1">Make a <span className="font-medium">test invoice</span>, issue it, and press <span className="font-medium">Pay as a test</span> on it. The provider reports the payment in test mode; no real money moves. Only a test invoice can be paid this way: it is marked as a test everywhere, is never reminded about, is left out of what you are owed and your revenue, and can be voided or deleted afterwards. A real invoice is never marked paid by a test.</p>
        {c.mode === "test"
          ? <Link href="/invoices/new?test=1" className="mt-1 inline-flex min-h-11 items-center font-medium text-primary-ink underline">Start a test invoice</Link>
          : <p className="mt-1 text-[13px] text-muted">This account is live, so it takes real invoices only. A test needs an account in test mode.</p>}
      </div>

      {c.mode === "live" && (
        <div className="space-y-1 text-[14px]">
          <p className="font-medium text-ink">Going live</p>
          {c.liveConfirmedAt ? <p className="text-success-ink">You confirmed on {formatInstant(c.liveConfirmedAt, tz)}. Customers can be sent to pay.</p> : <p className="text-ink-2">{c.liveConfirmBlock ?? "Everything needed is in place. Confirm when you are ready for customers to pay with real money."}</p>}
          {!liveEnabled && <p className="text-muted">Live payments are switched off for the whole service until iAcquire turns them on. That is a separate step from your confirmation.</p>}
          {!c.liveConfirmedAt && <Button className={ACTION} variant="brand" disabled={Boolean(c.liveConfirmBlock)} loading={busy("live")} onClick={() => setDialog("live")}>Confirm going live</Button>}
        </div>
      )}
      {c.mode === "test" && c.provider !== "simulated" && <p className="text-[13px] text-muted">This account is in test mode, so customers are not sent to it and it takes test invoices only. To take real payments, run a test payment first, then replace the keys with your live ones and confirm going live.</p>}
      {!callsEnabled && c.provider !== "simulated" && <p className="text-[13px] text-muted">Calls to real payment providers are switched off in this environment, so keys cannot be checked and checkouts cannot be started until iAcquire turns them on.</p>}

      {/* One full-width 44 px button per row on a phone; side by side from the small breakpoint up. */}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        {c.provider !== "simulated" && <Button className={ACTION} variant="secondary" loading={busy("recheck")} onClick={() => run("recheck", () => recheckConnectionAction(c.id), "Checked.")}>Check the keys now</Button>}
        {c.provider !== "simulated" && <Button className={ACTION} variant="secondary" onClick={() => setDialog("keys")}>Replace the keys</Button>}
        {c.status === "disabled"
          ? <Button className={ACTION} variant="secondary" loading={busy("resume")} onClick={() => run("resume", () => pauseConnectionAction(c.id, false), "Online payments resumed.")}>Resume online payments</Button>
          : c.status === "needs_attention" ? null
            : <Button className={ACTION} variant="outline" loading={busy("pause")} onClick={() => run("pause", () => pauseConnectionAction(c.id, true), "Online payments paused.")}>Pause online payments</Button>}
        <Button className={ACTION} variant="ghost" onClick={() => setDialog("disconnect")}>Disconnect</Button>
      </div>
      <Deliveries id={c.id} tz={tz} />

      <ConfirmDialog
        open={dialog === "disconnect"} onOpenChange={(o) => !o && setDialog(null)} title={`Disconnect ${c.providerLabel}?`} confirmLabel="Disconnect" danger loading={busy("disconnect")}
        description="The saved keys are deleted here and any payment page waiting to be paid is cancelled on this side. A customer who already has the provider's page open can still pay there, but this product could no longer confirm it: record it by hand. Also revoke the keys at the provider."
        onConfirm={async () => { const r = await run("disconnect", () => disconnectConnectionAction(c.id), "Disconnected."); if (r) setDialog(null); }}
      />
      <ConfirmDialog
        open={dialog === "live"} onOpenChange={(o) => !o && setDialog(null)} title="Let customers pay with real money?" confirmLabel="Confirm going live" loading={busy("live")}
        description="You have seen a test payment succeed and your live keys are connected. From now on a customer who opens an invoice can pay it through this account, and the money goes straight to your own account at the provider. iAcquire never holds it."
        onConfirm={async () => { const r = await run("live", () => confirmLiveAction(c.id), "Confirmed. Customers can now be sent to pay."); if (r) setDialog(null); }}
      />
      <ConfirmDialog
        open={dialog === "keys"} onOpenChange={(o) => !o && setDialog(null)} title="Replace the keys" confirmLabel="Check and save" loading={busy("keys")}
        confirmDisabled={!keys.apiKey.trim() || (isPaypal && !keys.apiSecret.trim()) || !keys.accept}
        description="The new keys are checked with the provider before anything is saved. Replacing keys can mean another account, so a live confirmation never carries over: you confirm again."
        onConfirm={async () => {
          const r = await run("keys", () => replaceKeysAction(c.id, { apiKey: keys.apiKey, ...(isPaypal ? { apiSecret: keys.apiSecret, environment: keys.environment } : {}), webhookSecret: keys.webhookSecret || null, authorization: { accepted: true, version: CURRENT_AUTHORIZATION_VERSION } }), "Keys replaced.");
          if (r) { setDialog(null); setKeys({ apiKey: "", apiSecret: "", environment: keys.environment, webhookSecret: "", accept: false }); }
        }}
      >
        <div className="space-y-3">
          {isPaypal && <Field label="PayPal app" htmlFor="rk-env"><Select id="rk-env" className={input16} value={keys.environment} onChange={(e) => setKeys({ ...keys, environment: e.target.value as PaypalEnvironment })}><option value="sandbox">Sandbox (testing)</option><option value="live">Live</option></Select></Field>}
          <Field label={isPaypal ? "Client ID" : "Secret key"} htmlFor="rk-key"><Input id="rk-key" type={isPaypal ? "text" : "password"} autoComplete="off" spellCheck={false} className={input16} value={keys.apiKey} onChange={(e) => setKeys({ ...keys, apiKey: e.target.value })} /></Field>
          {isPaypal && <Field label="Client secret" htmlFor="rk-secret"><Input id="rk-secret" type="password" autoComplete="off" spellCheck={false} className={input16} value={keys.apiSecret} onChange={(e) => setKeys({ ...keys, apiSecret: e.target.value })} /></Field>}
          <Field label={`${secretLabel} (only if it changed)`} htmlFor="rk-wh" optional hint="Needed when you switch between test and live keys: the test webhook and the live webhook have different ones, so the old one is not kept for the other mode."><Input id="rk-wh" type="password" autoComplete="off" spellCheck={false} className={input16} value={keys.webhookSecret} onChange={(e) => setKeys({ ...keys, webhookSecret: e.target.value })} /></Field>
          <label className="flex min-h-11 items-start gap-3 text-[13px] text-ink-2"><input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={keys.accept} onChange={(e) => setKeys({ ...keys, accept: e.target.checked })} /><span>{AUTHORIZATION_TEXTS[CURRENT_AUTHORIZATION_VERSION]}</span></label>
        </div>
      </ConfirmDialog>
    </li>
  );
}

export function ConnectionsPanel({ connections, providers, callsEnabled, liveEnabled, tz }: ConnectionsPanelProps) {
  const { run, busy } = useCrmAction();
  const connected = new Set(connections.map((c) => c.provider));
  const available = providers.filter((p) => !connected.has(p));
  const [picked, setPicked] = React.useState<PaymentProviderId>(available[0] ?? "paymongo");
  // Once a provider is connected it leaves the list; the form then moves to the next one rather than keeping a choice that is no longer on offer.
  const provider = available.includes(picked) ? picked : available[0] ?? picked;
  const blankForm = { apiKey: "", apiSecret: "", environment: "sandbox" as PaypalEnvironment, webhookSecret: "", label: "", accept: false };
  const [f, setF] = React.useState(blankForm);
  const isPaypal = provider === "paypal";
  const simulated = provider === "simulated";
  const ready = simulated ? f.accept : f.accept && f.apiKey.trim() !== "" && (!isPaypal || f.apiSecret.trim() !== "");

  return (
    <div className="space-y-6">
      {!callsEnabled && (
        <p role="status" className="flex items-start gap-2.5 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <span>Calls to real payment providers are switched off in this environment. You cannot connect PayMongo or PayPal here until iAcquire turns them on; nothing is lost by waiting. Invoices, recording payments by hand, and the customer&apos;s invoice page all work now.</span>
        </p>
      )}
      <p className="max-w-3xl text-[14px] text-ink-2">Customers pay <span className="font-medium">your own</span> payment provider account, and the money is paid out to you by the provider. iAcquire does not hold your customers&apos; money, takes no cut of it and never writes to your provider account except to open a payment page for an invoice you issued.</p>

      {connections.length > 0 && <ul className="space-y-4" aria-label="Connected payment accounts">{connections.map((c) => <ConnectionCard key={c.id} c={c} tz={tz} callsEnabled={callsEnabled} liveEnabled={liveEnabled} />)}</ul>}

      {available.length > 0 && (
        <section aria-labelledby="conn-add" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <h2 id="conn-add" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Plug className="size-4 text-muted" aria-hidden />Connect a payment account</h2>
          <Field label="Provider" htmlFor="cn-provider" hint={provider === "paymongo" ? "PayMongo takes Philippine pesos only." : provider === "paypal" ? "PayPal can take the currencies your account is set up for." : "For trying the whole path with no provider. It does not exist in production."}>
            <Select id="cn-provider" className={input16} value={provider} onChange={(e) => { setPicked(e.target.value as PaymentProviderId); setF(blankForm); }}>{available.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}</Select>
          </Field>
          {!simulated && (
            <div className="grid gap-4 sm:grid-cols-2">
              {isPaypal && <Field label="PayPal app" htmlFor="cn-env" hint="Say which kind of app these details belong to."><Select id="cn-env" className={input16} value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value as PaypalEnvironment })}><option value="sandbox">Sandbox (testing)</option><option value="live">Live</option></Select></Field>}
              <Field label={isPaypal ? "Client ID" : "Secret key"} htmlFor="cn-key" hint={isPaypal ? "From your PayPal app's page in the developer dashboard." : "Starts with sk_test_ (test mode) or sk_live_ (live mode). Never the public key."}><Input id="cn-key" type={isPaypal ? "text" : "password"} autoComplete="off" spellCheck={false} className={input16} value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></Field>
              {isPaypal && <Field label="Client secret" htmlFor="cn-secret"><Input id="cn-secret" type="password" autoComplete="off" spellCheck={false} className={input16} value={f.apiSecret} onChange={(e) => setF({ ...f, apiSecret: e.target.value })} /></Field>}
              <Field label={isPaypal ? "Webhook ID" : "Webhook signing secret"} htmlFor="cn-wh" optional hint="You can add this after connecting, once you have given the provider the webhook address."><Input id="cn-wh" type="password" autoComplete="off" spellCheck={false} className={input16} value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} /></Field>
              <Field label="A name for it" htmlFor="cn-label" optional><Input id="cn-label" className={input16} maxLength={120} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
            </div>
          )}
          <div className="space-y-2 rounded-xl border border-line bg-surface-2/50 p-3">
            <p className="text-[12px] font-semibold uppercase tracking-[.08em] text-muted">What you are agreeing to</p>
            <p className="rounded-lg bg-warning-soft px-2.5 py-1.5 text-[12px] text-warning-ink">This wording is proposed and has not been reviewed by a lawyer.</p>
            <label className="flex min-h-11 items-start gap-3 text-[14px] text-ink-2"><input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={f.accept} onChange={(e) => setF({ ...f, accept: e.target.checked })} /><span>{AUTHORIZATION_TEXTS[CURRENT_AUTHORIZATION_VERSION]}</span></label>
          </div>
          <div>
            <Button
              className={ACTION} variant="brand" loading={busy("connect")} disabled={!ready}
              onClick={async () => {
                const done = await run("connect", () => connectProviderAction({ provider, ...(simulated ? {} : { apiKey: f.apiKey, webhookSecret: f.webhookSecret || null }), ...(isPaypal ? { apiSecret: f.apiSecret, environment: f.environment } : {}), accountLabel: f.label || null, authorization: { accepted: true, version: CURRENT_AUTHORIZATION_VERSION } }), "Connected. The keys are saved and are not shown again.");
                // What was typed (a key that can move money) does not stay in the page once it has been saved.
                if (done) setF(blankForm);
              }}
            >Check the keys and connect</Button>
            <p className="mt-2 text-[13px] text-muted">The provider is asked to accept the keys first, in a read-only call. Nothing is saved if it does not.</p>
          </div>
        </section>
      )}
    </div>
  );
}
