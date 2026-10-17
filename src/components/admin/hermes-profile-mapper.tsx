"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Clipboard, KeyRound, Stethoscope } from "lucide-react";
import { connectAgencyHermesProfileAction, testAgencyHermesProfileAction } from "@/app/(admin)/admin/actions";
import { useLogoutUnsavedChanges } from "@/components/auth/logout-confirmation";
import type { WizardGateway } from "@/components/admin/integration-wizard";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
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
  const mappedCorrectly = currentProfile === expectedProfile;
  const hasSavedMapping = mappedCorrectly && Boolean(currentGatewayId);
  const [gatewayId, setGatewayId] = React.useState(currentGatewayId ?? choices[0]?.id ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [confirmProfile, setConfirmProfile] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(!hasSavedMapping || !hasCredential);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<AgencyProfileVerification | null>(null);
  const [copied, setCopied] = React.useState(false);
  useLogoutUnsavedChanges("Hermes profile credential", apiKey.length > 0, true, "/admin/workforce", "Hermes profile API key", `agency-hermes:${agentId}`);

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
      setConfirmProfile(false);
      setTestResult(result.data);
      setFormOpen(false);
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

  const formTitle = hasSavedMapping && hasCredential
    ? "Replace API key"
    : hasSavedMapping
      ? "Add profile credential"
      : "Set up existing Hermes profile";
  const replaceSavedCredential = hasSavedMapping && hasCredential;
  const mappingNeedsConfirmation = !hasSavedMapping || gatewayId !== currentGatewayId;

  function closeEditor() {
    setFormOpen(false);
    setApiKey("");
    setConfirmProfile(false);
    setError(null);
  }

  const editorForm = <form onSubmit={(event) => void submit(event)} className="space-y-3">
    <Field label="Approved gateway" htmlFor={`gateway-${agentId}`}>
      <Select id={`gateway-${agentId}`} value={gatewayId} onChange={(event) => setGatewayId(event.target.value)} disabled={!choices.length}>
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
    {replaceSavedCredential && <p className="rounded-xl bg-warning-soft p-3 text-xs leading-relaxed text-warning-ink">The new key is checked against this existing profile before it is saved. If verification fails, the current Vault credential stays active.</p>}
    <Field label="This profile&apos;s API_SERVER_KEY" htmlFor={`key-${agentId}`} hint={hasCredential ? "Enter this profile's replacement key. It is written to Supabase Vault and cannot be viewed again." : "Each employee uses its own Hermes profile key. It is saved in Supabase Vault and never shown again."}>
      <Input id={`key-${agentId}`} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={4096} required />
    </Field>
    {mappingNeedsConfirmation && <label className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-xs leading-relaxed text-ink-2">
      <input className="mt-0.5" type="checkbox" checked={confirmProfile} onChange={(event) => setConfirmProfile(event.target.checked)} />
      <span>I checked this ID against the existing Hermes inventory. Keep this identity and its current model, memories, tools, channels and schedules unchanged.</span>
    </label>}
    {error && <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger-ink">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
      <p className="max-w-md text-[11px] leading-relaxed text-muted">The wizard does not create, edit, or delete Hermes profiles.</p>
      <Button type="submit" size="sm" loading={busy} disabled={!choices.length || !gatewayId || (mappingNeedsConfirmation && !confirmProfile) || apiKey.trim().length < 24}>
        <KeyRound className="size-3.5" />{replaceSavedCredential ? "Verify and replace key" : "Save mapping and verify"}
      </Button>
    </div>
  </form>;

  return (
    <section className="space-y-3 rounded-2xl border border-line p-4" aria-label={`${expectedProfile} connection management`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><KeyRound className="size-4 text-primary" />Profile connection</h3>
          <p className="mt-1 break-all font-mono text-[11px] text-muted">{currentProfile ?? expectedProfile}{currentGatewayId ? ` · ${choices.find((gateway) => gateway.id === currentGatewayId)?.label ?? "approved gateway"}` : " · no gateway mapped"}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">Maps to the existing Hermes identity. The profile key stays in Supabase Vault and is never shown again.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && hasSavedMapping && hasCredential && <Button type="button" size="sm" variant="soft" onClick={() => void testSavedProfile()} loading={busy}>
            <Stethoscope className="size-3.5" />Test saved profile
          </Button>}
          {canManage && <Button type="button" size="sm" variant="secondary" onClick={() => {
            if (formOpen) closeEditor();
            else {
              setFormOpen(true);
              setError(null);
              setMessage(null);
            }
          }} aria-expanded={formOpen}>
            {formOpen ? "Close setup" : formTitle}
          </Button>}
        </div>
      </div>

      {!formOpen && error && <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger-ink">{error}</p>}
      {!formOpen && message && <p role="status" className="rounded-lg bg-success-soft p-2.5 text-xs text-success-ink">{message}</p>}
      {!formOpen && testResult && <p className="text-xs leading-relaxed text-muted">Latest saved check: {testResult.status} · {testResult.detail}</p>}

      {formOpen && canManage && !replaceSavedCredential && <div className="border-t border-line pt-3">{editorForm}</div>}
      {replaceSavedCredential && <Dialog
        open={formOpen && canManage}
        onOpenChange={(open) => open ? setFormOpen(true) : closeEditor()}
        title="Replace Hermes profile key"
        description={`Replace the saved API key for ${expectedProfile}. The current key stays active if the new one cannot verify this profile.`}
        icon={<KeyRound />}
        size="md"
      >{editorForm}</Dialog>}
    </section>
  );
}
