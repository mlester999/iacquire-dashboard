"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Link2 } from "lucide-react";
import { connectHermesAction } from "@/app/(admin)/admin/actions";
import type { WizardGateway } from "@/components/admin/integration-wizard";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/primitives";

export function HermesProfileMapper({
  agentId,
  employeeName,
  currentProfile,
  gateways,
}: {
  agentId: string;
  employeeName: string;
  currentProfile: string | null;
  gateways: WizardGateway[];
}) {
  const router = useRouter();
  const choices = gateways.filter((gateway) => gateway.status !== "disconnected");
  const [gatewayId, setGatewayId] = React.useState(choices[0]?.id ?? "");
  const [profile, setProfile] = React.useState(currentProfile ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await connectHermesAction(agentId, { gatewayId, profile, apiKey });
      if (!result.ok) throw new Error(result.error);
      setApiKey("");
      const health = result.data;
      setMessage(health?.ok ? `${employeeName} passed its profile health check.` : `${employeeName} is mapped. Health check: ${health?.detail ?? "not verified"}`);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The profile could not be mapped.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-2xl border border-line p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="size-4 text-primary" />Map Hermes profile</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">Use this employee&apos;s existing profile and its own API key. The portal will run a read-only identity and safety check after saving.</p>
      </div>
      <Field label="Approved gateway" htmlFor={`gateway-${agentId}`}>
        <Select id={`gateway-${agentId}`} value={gatewayId} onChange={(event) => setGatewayId(event.target.value)} disabled={!choices.length}>
          {choices.length ? choices.map((gateway) => <option key={gateway.id} value={gateway.id}>{gateway.label} · {gateway.host}</option>) : <option value="">No active gateway</option>}
        </Select>
      </Field>
      <Field label="Existing Hermes profile ID" htmlFor={`profile-${agentId}`} hint="Copy the exact identifier from the Hermes administrator's profile list. Do not guess or reuse a client profile.">
        <Input id={`profile-${agentId}`} value={profile} onChange={(event) => setProfile(event.target.value)} autoComplete="off" maxLength={63} required />
      </Field>
      <Field label="This profile&apos;s API_SERVER_KEY" htmlFor={`key-${agentId}`} hint="The API key belongs only to this profile. It is stored in Supabase Vault and never shown again.">
        <Input id={`key-${agentId}`} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={4096} required />
      </Field>
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger-ink">{error}</p>}
      {message && <p role="status" className="rounded-lg bg-success-soft p-2.5 text-xs text-success-ink">{message}</p>}
      <Button type="submit" size="sm" loading={busy} disabled={!choices.length || !gatewayId || !profile.trim() || apiKey.trim().length < 24}>
        <KeyRound className="size-3.5" /> Save and verify profile
      </Button>
    </form>
  );
}
