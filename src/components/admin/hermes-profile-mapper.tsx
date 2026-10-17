"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Clipboard, KeyRound, Stethoscope } from "lucide-react";
import { connectAgencyHermesProfileAction, testAgencyHermesProfileAction } from "@/app/(admin)/admin/actions";
import type { WizardGateway } from "@/components/admin/integration-wizard";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/primitives";
import { AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import type { AgencyProfileVerification } from "@/server/workforce/agency";

export function HermesProfileMapper({
  agentId,
  roleKey,
  currentProfile,
  currentGatewayId,
  hasCredential,
  gateways,
  canManage,
}: {
  agentId: string;
  roleKey: AgentRoleKey;
  currentProfile: string | null;
  currentGatewayId: string | null;
  hasCredential: boolean;
  gateways: WizardGateway[];
  canManage: boolean;
}) {
  const router = useRouter();
  const expectedProfile = AGENCY_HERMES_PROFILE_IDS[roleKey];
  const choices = gateways.filter((gateway) => gateway.status !== "disconnected");
  const [gatewayId, setGatewayId] = React.useState(currentGatewayId ?? choices[0]?.id ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [confirmProfile, setConfirmProfile] = React.useState(false);
  const [replaceCredential, setReplaceCredential] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<AgencyProfileVerification | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await connectAgencyHermesProfileAction(agentId, {
        gatewayId,
        profile: expectedProfile,
        apiKey,
        confirmedExistingProfile: confirmProfile,
      });
      if (!result.ok) throw new Error(result.error);
      setApiKey("");
      setReplaceCredential(false);
      setConfirmProfile(false);
      setTestResult(result.data);
      setMessage(result.data.ok ? "Existing profile saved and verified." : `Mapping saved. ${result.data.detail}`);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The profile could not be mapped.");
    } finally {
      setBusy(false);
    }
  }

  async function testSavedProfile() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await testAgencyHermesProfileAction(agentId);
      if (!result.ok) throw new Error(result.error);
      setTestResult(result.data);
      setMessage(result.data.ok ? "Profile identity and safety checks passed." : result.data.detail);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The profile check could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  const mappedCorrectly = currentProfile === expectedProfile;
  const needsCredential = !hasCredential || replaceCredential || !mappedCorrectly;

  return (
    <div className="space-y-3 rounded-2xl border border-line p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="size-4 text-primary" />Map existing Hermes profile</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">This form maps this iAcquire role to its original Hermes identity. It never creates or changes a Hermes profile.</p>
      </div>
      <Field label="Approved gateway" htmlFor={`gateway-${agentId}`}>
        <Select id={`gateway-${agentId}`} value={gatewayId} onChange={(event) => setGatewayId(event.target.value)} disabled={!canManage || !choices.length}>
          {choices.length ? choices.map((gateway) => <option key={gateway.id} value={gateway.id}>{gateway.label} · {gateway.host}</option>) : <option value="">No active gateway</option>}
        </Select>
      </Field>
      <Field label="Verified Hermes profile ID" htmlFor={`profile-${agentId}`} hint="Compare this exact ID with the authorized Hermes profile inventory before confirming.">
        <div className="flex gap-2">
          <Input id={`profile-${agentId}`} value={expectedProfile} readOnly aria-readonly="true" className="font-mono" />
          <Button type="button" variant="secondary" size="icon" aria-label={copied ? "Profile ID copied" : "Copy profile ID"} onClick={() => {
            void navigator.clipboard.writeText(expectedProfile).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }).catch(() => {
              setError("Clipboard access is unavailable. Select and copy the read-only profile ID.");
            });
          }}><>{copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}</></Button>
        </div>
      </Field>
      {hasCredential && mappedCorrectly && !replaceCredential && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-success-soft/40 p-3 text-xs">
        <span className="text-success-ink">Profile API credential is stored in Vault. The value cannot be viewed here.</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => setReplaceCredential(true)}>Replace key</Button>
      </div>}
      {hasCredential && !mappedCorrectly && <p className="rounded-xl bg-warning-soft p-3 text-xs leading-relaxed text-warning-ink">The saved profile mapping does not match this employee&apos;s verified iAcquire identity. Map the existing profile shown above; the previous Vault credential will be revoked.</p>}
      {needsCredential && <Field label="This profile&apos;s API_SERVER_KEY" htmlFor={`key-${agentId}`} hint={hasCredential && mappedCorrectly ? "Enter the replacement key for this same existing profile. The old Vault credential is revoked after saving." : hasCredential ? "Enter this verified profile's own API_SERVER_KEY. The previous Vault credential will be revoked after saving." : "Each employee uses its own Hermes profile API key. It is saved in Supabase Vault and never shown again."}>
        <Input id={`key-${agentId}`} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={4096} required />
      </Field>}
      <label className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-xs leading-relaxed text-ink-2">
        <input className="mt-0.5" type="checkbox" checked={confirmProfile} disabled={!canManage} onChange={(event) => setConfirmProfile(event.target.checked)} />
        <span>I checked this ID against the existing Hermes profile inventory. Keep this identity and its current model, memories, tools, channels and schedules unchanged.</span>
      </label>
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger-ink">{error}</p>}
      {message && <p role="status" className="rounded-lg bg-success-soft p-2.5 text-xs text-success-ink">{message}</p>}
      {testResult && <p className="text-xs leading-relaxed text-muted">Latest saved result: {testResult.status} · {testResult.detail}</p>}
      {canManage && <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="soft" onClick={() => void testSavedProfile()} loading={busy} disabled={!mappedCorrectly || !hasCredential || !currentGatewayId}>
          <Stethoscope className="size-3.5" />Test profile
        </Button>
      </div>}
      {canManage && needsCredential && <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <input type="hidden" name="profile-confirmed" value={confirmProfile ? "yes" : "no"} />
        <Button type="submit" size="sm" loading={busy} disabled={!choices.length || !gatewayId || !confirmProfile || apiKey.trim().length < 24}>
          <KeyRound className="size-3.5" />Save mapping and verify
        </Button>
      </form>}
    </div>
  );
}
