"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Clipboard, Eye, EyeOff, History, KeyRound, Stethoscope, Wrench } from "lucide-react";
import {
  connectAgencyHermesProfileAction,
  getAgencyProfileHistoryAction,
  reviewAgencyHermesToolsAction,
  testAgencyHermesProfileAction,
} from "@/app/(admin)/admin/actions";
import { useLogoutUnsavedChanges } from "@/components/auth/logout-confirmation";
import type { WizardGateway } from "@/components/admin/integration-wizard";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select } from "@/components/ui/primitives";
import { AGENT_BY_KEY, AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import type { AgencyHermesToolReview, AgencyProfileHistoryEvent, AgencyProfileVerification } from "@/server/workforce/agency";
import { formatDateTime } from "@/lib/utils";

export function HermesProfileMapper({
  agentId,
  roleKey,
  currentProfile,
  currentGatewayId,
  hasCredential,
  gateways,
  canManage,
  canReviewTools,
  timeZone,
}: {
  agentId: string;
  roleKey: AgentRoleKey;
  currentProfile: string | null;
  currentGatewayId: string | null;
  hasCredential: boolean;
  gateways: WizardGateway[];
  canManage: boolean;
  canReviewTools: boolean;
  timeZone: string;
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
  const [showApiKey, setShowApiKey] = React.useState(false);
  const [toolReview, setToolReview] = React.useState<AgencyHermesToolReview | null>(null);
  const [toolReviewError, setToolReviewError] = React.useState<string | null>(null);
  const [reviewingTools, setReviewingTools] = React.useState(false);
  const [history, setHistory] = React.useState<AgencyProfileHistoryEvent[] | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  useLogoutUnsavedChanges("Hermes profile credential", apiKey.length > 0, true, "/admin/employees", "Hermes profile API key", `agency-hermes:${agentId}`);

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
      setShowApiKey(false);
      setConfirmProfile(false);
      setTestResult(result.data);
      setToolReview(null);
      setHistory(null);
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
      setToolReview(null);
      setHistory(null);
      setMessage(result.data.ok ? "Profile identity and safety checks passed." : result.data.detail);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The profile check could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewTools() {
    setReviewingTools(true);
    setToolReviewError(null);
    try {
      const result = await reviewAgencyHermesToolsAction(agentId);
      if (!result.ok) throw new Error(result.error);
      setToolReview(result.data);
    } catch (reason) {
      setToolReviewError(reason instanceof Error ? reason.message : "The tool inventory could not be reviewed.");
    } finally {
      setReviewingTools(false);
    }
  }

  async function toggleHistory() {
    const open = !historyOpen;
    setHistoryOpen(open);
    if (!open || history !== null) return;
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const result = await getAgencyProfileHistoryAction(agentId);
      if (!result.ok) throw new Error(result.error);
      setHistory(result.data);
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : "Connection history could not be loaded.");
    } finally {
      setLoadingHistory(false);
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
    setShowApiKey(false);
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
    {replaceSavedCredential && <p className="rounded-xl bg-warning-soft p-3 text-xs leading-relaxed text-warning-ink">This replaces only the API key iAcquire stores in Vault; it does not change the key configured in Hermes. Enter the existing profile&apos;s current API_SERVER_KEY. The saved key remains active if the candidate fails verification.</p>}
    <Field label="This profile&apos;s API_SERVER_KEY" htmlFor={`key-${agentId}`} hint={hasCredential ? "Enter this profile's replacement key. It is written to Supabase Vault and cannot be viewed again." : "Each employee uses its own Hermes profile key. It is saved in Supabase Vault and never shown again."}>
      <div className="flex gap-2">
        <Input id={`key-${agentId}`} type={showApiKey ? "text" : "password"} autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={4096} required />
        <Button type="button" variant="secondary" size="icon-sm" aria-label={showApiKey ? "Hide profile API key" : "Show profile API key"} aria-pressed={showApiKey} onClick={() => setShowApiKey((visible) => !visible)}>
          {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>
    </Field>
    {mappingNeedsConfirmation && <label className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-xs leading-relaxed text-ink-2">
      <input className="mt-0.5" type="checkbox" checked={confirmProfile} onChange={(event) => setConfirmProfile(event.target.checked)} />
      <span>I checked this ID against the existing Hermes inventory. Keep this identity and its current model, memories, tools, channels and schedules unchanged.</span>
    </label>}
    {error && <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger-ink">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
      <p className="max-w-md text-[12px] leading-relaxed text-muted">The wizard does not create, edit, or delete Hermes profiles.</p>
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
          <p className="mt-1 break-all font-mono text-[12px] text-muted">{currentProfile ?? expectedProfile}{currentGatewayId ? ` · ${choices.find((gateway) => gateway.id === currentGatewayId)?.label ?? "approved gateway"}` : " · no gateway mapped"}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">Maps to the existing Hermes identity. The profile key stays in Supabase Vault and is never shown again.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && hasSavedMapping && hasCredential && <Button type="button" size="sm" variant="soft" onClick={() => void testSavedProfile()} loading={busy}>
            <Stethoscope className="size-3.5" />Test saved profile
          </Button>}
          {canManage && canReviewTools && <Button type="button" size="sm" variant="secondary" onClick={() => void reviewTools()} loading={reviewingTools}>
            <Wrench className="size-3.5" />Review tool permissions
          </Button>}
          {canManage && <Button type="button" size="sm" variant="ghost" onClick={() => void toggleHistory()} loading={loadingHistory} aria-expanded={historyOpen}>
            <History className="size-3.5" />Connection history
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

      {toolReviewError && <p role="alert" className="rounded-lg bg-danger-soft p-2.5 text-xs text-danger-ink">{toolReviewError}</p>}
      {toolReview && <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3" aria-live="polite">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h4 className="text-xs font-semibold text-ink">Live tool inventory</h4><p className="mt-1 text-[12px] text-muted">Read from Hermes at {formatDateTime(toolReview.checkedAt, timeZone)}. This review does not change tool permissions.</p></div>
          <span className="rounded-full bg-surface px-2 py-1 text-[12px] font-medium text-ink-2">{toolReview.inventoryComplete ? "Complete inventory" : "Completeness not proven"}</span>
        </div>
        {!toolReview.inventoryComplete && <p className="text-xs leading-relaxed text-warning-ink">Hermes returned its visible toolsets, but this API does not prove the full effective permission inventory. Active use remains blocked until completeness can be verified.</p>}
        {toolReview.restrictedTools.length > 0
          ? <p className="text-xs leading-relaxed text-warning-ink">Review these unapproved or restricted tools: <span className="font-mono">{toolReview.restrictedTools.join(", ")}</span></p>
          : <p className="text-xs text-muted">No unapproved tools appeared in the returned inventory.</p>}
        <ul className="grid gap-2 sm:grid-cols-2">
          {toolReview.toolsets.map((toolset) => <li key={toolset.name} className="rounded-lg border border-line bg-surface p-2.5 text-[12px]">
            <p className="font-medium text-ink">{toolset.name} · {toolset.enabled ? "enabled" : "disabled"}</p>
            <p className="mt-1 break-words font-mono leading-relaxed text-muted">{toolset.tools.length ? toolset.tools.join(", ") : "No tools listed"}</p>
          </li>)}
        </ul>
        {toolReview.truncated && <p className="text-[12px] text-muted">The displayed inventory was shortened to keep the review readable.</p>}
      </div>}

      {historyOpen && <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3" aria-live="polite">
        <h4 className="text-xs font-semibold text-ink">Recorded connection history</h4>
        {historyError && <p role="alert" className="text-xs text-danger-ink">{historyError}</p>}
        {history?.length === 0 && <p className="text-xs text-muted">No recorded connection or profile-check events yet.</p>}
        {history && history.length > 0 && <ol className="space-y-2">{history.map((event, index) => <li key={`${event.action}:${event.occurredAt}:${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-2.5 text-[12px]">
          <span className="font-medium text-ink">{event.action === "connected" ? "Profile connection saved" : `Profile check${event.status ? ` · ${event.status.replaceAll("_", " ")}` : ""}`}</span>
          <span className="text-muted">{event.result} · {event.actorKind === "agency" ? "iAcquire admin" : event.actorKind}</span>
          <time dateTime={event.occurredAt} className="text-muted">{formatDateTime(event.occurredAt, timeZone)}</time>
        </li>)}</ol>}
      </div>}

      {formOpen && canManage && !replaceSavedCredential && <div className="border-t border-line pt-3">{editorForm}</div>}
      {replaceSavedCredential && <Dialog
        open={formOpen && canManage}
        onOpenChange={(open) => open ? setFormOpen(true) : closeEditor()}
        title={`Replace ${AGENT_BY_KEY[roleKey].shortName} API key`}
        description={`Replace only the API key iAcquire stores for ${AGENT_BY_KEY[roleKey].shortName}. This does not change the key configured in Hermes. The saved key stays active if the candidate cannot verify this profile.`}
        icon={<KeyRound />}
        size="md"
      >{editorForm}</Dialog>}
    </section>
  );
}
