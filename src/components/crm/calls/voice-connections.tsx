"use client";

import * as React from "react";
import { AudioLines, KeyRound, PlugZap, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { ConfirmDialog, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { Toggle } from "@/components/crm/workflows/pickers";
import { CopyField } from "@/components/crm/developer/shared";
import { disconnectVoiceConnectionAction, saveVoiceConnectionAction } from "@/app/actions/crm-calls";
import { formatDateTime } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { VoiceConnectionView } from "@/server/crm/calls";

const STATUS: Record<VoiceConnectionView["status"], { label: string; tone: "success" | "neutral" | "warning" | "danger" }> = {
  connected: { label: "Receiving calls", tone: "success" },
  credentials_saved: { label: "Waiting for the first call", tone: "warning" },
  error: { label: "Error", tone: "danger" },
  disconnected: { label: "Disconnected", tone: "neutral" },
  not_set_up: { label: "Not set up", tone: "neutral" },
};

const SETUP: Record<VoiceConnectionView["provider"], { ids: string; secret: string; steps: string[] }> = {
  vapi: {
    ids: "Assistant ids and phone-number ids (from the Vapi dashboard), one per line. Only calls on these report to this workspace.",
    secret: "The token (or HMAC secret key) of the Vapi credential attached to the server URL.",
    steps: [
      "In Vapi, open the assistant (or phone number) and set its Server URL to the address below.",
      "Attach a credential to it: Bearer Token (Authorization header with the Bearer prefix), the legacy X-Vapi-Secret header, or HMAC (SHA-256, hex, x-signature and x-timestamp headers, payload {timestamp}.{body}).",
      "Set its server messages to status-update and end-of-call-report. A server URL sent with an API request (a transient assistant) carries no credential, so those calls are refused.",
    ],
  },
  retell: {
    ids: "Agent ids (from the Retell dashboard), one per line. Only calls handled by these agents report to this workspace.",
    secret: "The Retell API key that has the webhook badge. Retell signs every webhook with it (X-Retell-Signature).",
    steps: [
      "In Retell, set the agent's webhook URL (or the account's) to the address below.",
      "Keep the events call_started, call_ended and call_analyzed switched on.",
      "Use the API key with the webhook badge here: it's the only key Retell signs webhooks with.",
    ],
  },
};

interface Draft {
  provider: VoiceConnectionView["provider"];
  ids: string;
  mode: string;
  secret: string;
  storeRecordings: boolean;
  announced: boolean;
}

/**
 * The workspace's Vapi and Retell connections: which assistants/agents report calls here, whether the credential is saved (never the
 * secret itself), whether recording and transcript references are kept, and the webhook address to give the provider. Changes are made
 * by an agency super admin in a write support session.
 */
export function VoiceConnections({ scope, connections, canConnect, vapiAuthModes }: { scope: CrmScope; connections: VoiceConnectionView[]; canConnect: boolean; vapiAuthModes: Array<{ value: string; label: string }> }) {
  const { run, busy } = useCrmAction();
  const ids = React.useId();
  const [editing, setEditing] = React.useState<Draft | null>(null);
  const [disconnecting, setDisconnecting] = React.useState<VoiceConnectionView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const current = editing ? connections.find((c) => c.provider === editing.provider) ?? null : null;

  const open = (c: VoiceConnectionView) => {
    setError(null);
    setEditing({ provider: c.provider, ids: c.externalIds.join("\n"), mode: c.vapiAuthMode ?? "bearer", secret: "", storeRecordings: c.storeRecordings, announced: c.storeRecordings });
  };
  const save = async () => {
    if (!editing) return;
    setError(null);
    if (!editing.ids.trim()) return setError("Add at least one id.");
    const needSecret = !current?.credentialSaved || (editing.provider === "vapi" && current.vapiAuthMode !== editing.mode);
    if (needSecret && !editing.secret.trim()) return setError(editing.provider === "vapi" ? "Enter the secret from the Vapi credential." : "Enter the Retell API key with the webhook badge.");
    if (editing.storeRecordings && !editing.announced) return setError("Confirm that callers are told the call is recorded, or switch recordings off.");
    const ok = await run("save-voice", () => saveVoiceConnectionAction(scope.orgId, {
      provider: editing.provider, externalIds: editing.ids, vapiAuthMode: editing.provider === "vapi" ? editing.mode : null, secret: editing.secret.trim() || null,
      storeRecordings: editing.storeRecordings, recordingAnnounced: editing.announced,
    }), "Connection saved.");
    if (ok) setEditing(null);
  };

  return (
    <div className="space-y-4">
      {!canConnect && (
        <ReadOnlyNotice>
          Voice connections hold a provider credential, so an iAcquire agency super admin sets them up in a write support session. Ask your agency to connect your Vapi or Retell assistant.
        </ReadOnlyNotice>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {connections.map((c) => {
          const st = STATUS[c.status];
          return (
            <Card key={c.provider} className="flex flex-col p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><AudioLines className="size-4.5" aria-hidden /></span>
                  <div className="min-w-0">
                    <h3 className="text-[14.5px] font-semibold text-ink">{c.providerLabel}</h3>
                    <p className="text-[13px] text-muted">{c.lastEventAt ? `Last call event ${formatDateTime(c.lastEventAt, scope.timezone)}` : "No call events yet"}</p>
                  </div>
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
                <dt className="text-muted">{c.provider === "vapi" ? "Assistants / numbers" : "Agents"}</dt>
                <dd className="min-w-0 break-all font-mono text-[12px] text-ink-2">{c.externalIds.length ? c.externalIds.join(", ") : "None"}</dd>
                <dt className="text-muted">Credential</dt>
                <dd className="text-ink-2">{c.credentialSaved ? `Saved ${c.credentialSavedAt ? formatDateTime(c.credentialSavedAt, scope.timezone) : ""}` : "Not saved"}{c.vapiAuthMode ? ` · ${vapiAuthModes.find((m) => m.value === c.vapiAuthMode)?.label ?? c.vapiAuthMode}` : ""}</dd>
                <dt className="text-muted">Recordings</dt>
                <dd className="text-ink-2">{c.storeRecordings ? "Links to recordings and transcripts, and the provider's summary, are kept" : "Not kept: only call details are recorded (no recording, transcript or summary)"}</dd>
              </dl>
              <div className="mt-4">
                <p className="mb-1.5 text-[13px] font-medium text-ink-2">Webhook address</p>
                <CopyField id={`${ids}-${c.provider}-url`} value={c.webhookUrl} label={`${c.providerLabel} webhook address`} />
              </div>
              <details className="group mt-3 rounded-xl border border-line">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-[14px] font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary sm:min-h-10">
                  <PlugZap className="size-4 text-muted" aria-hidden />How to connect {c.providerLabel}
                </summary>
                <ol className="list-decimal space-y-1.5 border-t border-line py-3 pl-8 pr-3 text-[13px] leading-relaxed text-ink-2">
                  {SETUP[c.provider].steps.map((s) => <li key={s}>{s}</li>)}
                </ol>
              </details>
              {canConnect && (
                <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
                  {c.configured && c.status !== "disconnected" && (
                    <Button variant="ghost" size="sm" onClick={() => setDisconnecting(c)}><Unplug className="size-4" aria-hidden />Disconnect</Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => open(c)}><KeyRound className="size-4" aria-hidden />{c.configured && c.status !== "disconnected" ? "Edit" : "Set up"}</Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(o) => !o && setEditing(null)}
        size="lg"
        title={editing ? `${editing.provider === "vapi" ? "Vapi" : "Retell AI"} connection` : "Connection"}
        description="The secret goes straight into the vault and is never shown again. Leave it empty to keep the saved one."
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button loading={busy("save-voice")} onClick={save}>Save connection</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label={editing.provider === "vapi" ? "Assistant and phone-number ids" : "Agent ids"} htmlFor={`${ids}-ids`} hint={SETUP[editing.provider].ids}>
              <Textarea id={`${ids}-ids`} rows={3} spellCheck={false} className="font-mono text-[14px]" value={editing.ids} onChange={(e) => setEditing({ ...editing, ids: e.target.value })} />
            </Field>
            {editing.provider === "vapi" && (
              <Field label="How Vapi authenticates" htmlFor={`${ids}-mode`}>
                <Select id={`${ids}-mode`} value={editing.mode} onChange={(e) => setEditing({ ...editing, mode: e.target.value })}>
                  {vapiAuthModes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
              </Field>
            )}
            <Field label={editing.provider === "vapi" ? "Secret" : "Retell API key"} htmlFor={`${ids}-secret`} optional={Boolean(current?.credentialSaved)} hint={SETUP[editing.provider].secret}>
              <Input id={`${ids}-secret`} type="password" autoComplete="off" spellCheck={false} value={editing.secret} placeholder={current?.credentialSaved ? "Saved. Enter a new one to replace it." : ""} onChange={(e) => setEditing({ ...editing, secret: e.target.value })} />
            </Field>
            <div className="space-y-3 rounded-2xl border border-line p-3">
              <Toggle
                id={`${ids}-rec`}
                label="Keep links to recordings and transcripts"
                hint="Only a link to the provider's copy and a transcript reference are kept, never the audio or the text. The provider's call summary is kept only when this is on."
                checked={editing.storeRecordings}
                onChange={(v) => setEditing({ ...editing, storeRecordings: v, announced: v ? editing.announced : false })}
              />
              {editing.storeRecordings && (
                <label className="flex cursor-pointer items-start gap-2 text-[14px] leading-relaxed text-ink-2">
                  <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={editing.announced} onChange={(e) => setEditing({ ...editing, announced: e.target.checked })} />
                  The assistant tells every caller at the start of the call that it is recorded. Check what the law requires where the business and its callers are.
                </label>
              )}
            </div>
            {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-[14px] text-danger-ink">{error}</p>}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(disconnecting)}
        onOpenChange={(o) => !o && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.providerLabel ?? "this provider"}?`}
        description="Its calls stop reaching this workspace and the saved credential is revoked. Calls already recorded stay."
        confirmLabel="Disconnect"
        danger
        loading={busy("disconnect-voice")}
        onConfirm={async () => {
          if (!disconnecting) return;
          if (await run("disconnect-voice", () => disconnectVoiceConnectionAction(scope.orgId, disconnecting.provider), "Disconnected.")) setDisconnecting(null);
        }}
      />
    </div>
  );
}
