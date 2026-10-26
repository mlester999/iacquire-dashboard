"use client";

import * as React from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/actions/crm-developer";
import { formatDate } from "@/lib/utils";
import { RelativeTime } from "@/components/crm/relative-time";
import type { CrmScope } from "@/server/crm/page";
import type { ApiKeyView } from "@/server/crm/api-keys";
import { OneTimeSecret } from "./shared";

export interface ScopeInfo {
  scope: string;
  label: string;
  description: string;
}

const STATE: Record<ApiKeyView["state"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "warning" },
  revoked: { label: "Revoked", tone: "neutral" },
};

export function ApiKeysSection({ scope, keys, scopes, expiryChoices, maxKeys, canManage }: { scope: CrmScope; keys: ApiKeyView[]; scopes: ScopeInfo[]; expiryChoices: number[]; maxKeys: number; canManage: boolean }) {
  const [creating, setCreating] = React.useState(false);
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<ApiKeyView | null>(null);
  const { run, busy } = useCrmAction();
  const labelFor = (s: string) => scopes.find((x) => x.scope === s)?.label ?? s;
  const active = keys.filter((k) => k.state === "active").length;

  return (
    <section aria-labelledby="dev-keys" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="dev-keys" className="text-[15px] font-semibold text-ink">API keys</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">
            A key lets one of your apps use the CRM API with only the permissions you give it. Each key belongs to this workspace; it can never reach another.
          </p>
        </div>
        {canManage && <Button variant="secondary" onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />Create key</Button>}
      </div>

      {keys.length ? (
        <Card className="divide-y divide-line overflow-hidden p-0">
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-start gap-3 px-4 py-3.5">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1 basis-60">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-[14px] font-medium text-ink">{k.name}</p>
                  <Badge tone={STATE[k.state].tone}>{STATE[k.state].label}</Badge>
                </div>
                <p className="mt-0.5 font-mono text-[12px] text-muted">{k.prefix}_…</p>
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Permissions">
                  {k.scopes.map((s) => (
                    <li key={s}><Badge tone="outline" className="h-auto min-h-6 whitespace-normal py-0.5">{labelFor(s)}</Badge></li>
                  ))}
                </ul>
                <p className="mt-2 text-[12px] text-muted">
                  Created {formatDate(k.createdAt, scope.timezone)} · Last used {k.lastUsedAt ? <RelativeTime iso={k.lastUsedAt} timezone={scope.timezone} /> : "never"}
                  {k.revokedAt ? ` · Revoked ${formatDate(k.revokedAt, scope.timezone)}` : k.expiresAt ? ` · ${k.state === "expired" ? "Expired" : "Expires"} ${formatDate(k.expiresAt, scope.timezone)}` : " · Doesn't expire"}
                </p>
              </div>
              {canManage && k.state === "active" && (
                <Button variant="ghost" size="sm" onClick={() => setRevoking(k)} aria-label={`Revoke key ${k.name}`}>
                  <Trash2 className="size-3.5" aria-hidden />Revoke
                </Button>
              )}
            </div>
          ))}
        </Card>
      ) : (
        <Card className="p-0">
          <EmptyState
            compact
            icon={<KeyRound className="size-5" aria-hidden />}
            title="No API keys yet"
            description={canManage ? "Create a key for each app you connect, so you can revoke one without affecting the others." : "Owners and managers can create keys."}
          />
        </Card>
      )}
      {canManage && keys.length > 0 && <p className="text-[12px] text-muted">{active} of {maxKeys} active keys in use.</p>}

      {creating && (
        <CreateKeyDialog
          scope={scope}
          scopes={scopes}
          expiryChoices={expiryChoices}
          onClose={() => setCreating(false)}
          onCreated={(secret) => {
            setCreating(false);
            setRevealed(secret);
          }}
        />
      )}
      {revealed && (
        <OneTimeSecret
          open
          title="Copy your new API key"
          description="Use it as a bearer token: Authorization: Bearer <key>."
          note="This is the only time the key is shown. iAcquire keeps only a fingerprint of it, so a lost key can't be recovered, only revoked and replaced."
          secret={revealed}
          onClose={() => setRevealed(null)}
        />
      )}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={revoking ? `Revoke “${revoking.name}”?` : "Revoke key?"}
        description={revoking ? `Apps using ${revoking.prefix}_… stop working with the next request. This can't be undone; create a new key to reconnect them.` : undefined}
        confirmLabel="Revoke key"
        danger
        loading={busy("revoke")}
        onConfirm={async () => {
          if (revoking && (await run("revoke", () => revokeApiKeyAction(scope.orgId, revoking.id), "Key revoked."))) setRevoking(null);
        }}
      />
    </section>
  );
}

function CreateKeyDialog({ scope, scopes, expiryChoices, onClose, onCreated }: { scope: CrmScope; scopes: ScopeInfo[]; expiryChoices: number[]; onClose: () => void; onCreated: (secret: string) => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [expiry, setExpiry] = React.useState<string>("90");
  const toggle = (s: string, on: boolean) => setPicked((p) => (on ? [...new Set([...p, s])] : p.filter((x) => x !== s)));
  const expiryLabel = (d: number) => (d === 365 ? "In 1 year" : `In ${d} days`);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Create an API key"
      description="Give the key only the permissions the app needs. You can revoke it at any time."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            loading={busy("create")}
            disabled={!name.trim() || !picked.length}
            onClick={async () => {
              const res = await run("create", () => createApiKeyAction(scope.orgId, { name, scopes: picked, expiresInDays: expiry === "never" ? null : Number(expiry) }), "Key created.");
              if (res && typeof res === "object") onCreated(res.secret);
            }}
          >
            Create key
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="key-name" hint="For example the app or integration that will use it.">
          <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <fieldset>
          <legend className="text-[14px] font-medium text-ink-2">Permissions</legend>
          <div className="mt-2 space-y-2">
            {scopes.map((s) => (
              <label key={s.scope} className="flex items-start gap-2.5 rounded-xl border border-line p-3 text-[14px] leading-relaxed has-[:checked]:border-primary/50 has-[:checked]:bg-primary-soft/40">
                <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={picked.includes(s.scope)} onChange={(e) => toggle(s.scope, e.target.checked)} />
                <span className="min-w-0">
                  <span className="font-medium text-ink">{s.label}</span>
                  <span className="ml-1.5 font-mono text-[12px] text-muted">{s.scope}</span>
                  <span className="block text-[13px] text-muted">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Expires" htmlFor="key-expiry">
          <Select id="key-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {expiryChoices.map((d) => <option key={d} value={String(d)}>{expiryLabel(d)}</option>)}
            <option value="never">Never (until revoked)</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
