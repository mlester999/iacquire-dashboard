"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Info, KeyRound, XCircle } from "lucide-react";
import { Badge, Field, Input, ProgressBar, Select } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { INTEGRATION_NAMES, INTEGRATION_STATE_LABEL, type IntegrationProvider, type IntegrationState, type IntegrationView } from "@/lib/integrations";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS } from "@/lib/agents";
import { cn, formatDateTime } from "@/lib/utils";
import { useLogoutUnsavedChanges } from "@/components/auth/logout-confirmation";
import type { HermesSetupDraftConfig, HermesSetupSummary } from "@/server/integrations/hermes/setup";

export type WizardProvider = Extract<IntegrationProvider, "hermes" | "ghl" | "n8n">;
export interface WizardResult {
  status: string;
  detail: string;
  capabilities: Record<string, unknown>;
  syncedAt?: string | null;
}
export interface WizardApi {
  save(input: unknown): Promise<{ gatewayId?: string; gatewayRevision?: number } | void>;
  saveHermesDraft(input: { gatewayId: string | null; expectedDraftRevision: number; expectedGatewayRevision: number | null; config: HermesSetupDraftConfig }): Promise<{ revision: number; updatedAt: string | null }>;
  saveHermesProgress(stepIndex: number, gatewayId: string | null): Promise<void>;
  test(provider: WizardProvider, gatewayId?: string): Promise<WizardResult>;
  syncMetadata(): Promise<WizardResult>;
  mapGhlAssets(input: { pipelineId: string | null; calendarIds: string[] }): Promise<void>;
}

type StepKey = "endpoint" | "auth" | "test" | "capabilities" | "routing" | "health" | "client" | "location" | "metadata" | "mapping" | "instance" | "inventory" | "approve" | "agencyWorkforce" | "provisioning";
const FLOWS: Record<WizardProvider, Array<{ key: StepKey; label: string }>> = {
  hermes: [
    { key: "endpoint", label: "Gateway endpoint" },
    { key: "auth", label: "Secure authentication" },
    { key: "test", label: "Test connection" },
    { key: "capabilities", label: "Verify capabilities" },
    { key: "routing", label: "Confirm profile routing" },
    { key: "health", label: "Connection health" },
  ],
  ghl: [
    { key: "client", label: "Select client" },
    { key: "location", label: "Enter Location ID" },
    { key: "auth", label: "Scoped token" },
    { key: "test", label: "Test read-only access" },
    { key: "metadata", label: "Discover CRM metadata" },
    { key: "mapping", label: "Save verified mapping" },
  ],
  n8n: [
    { key: "instance", label: "Instance URL" },
    { key: "auth", label: "Secure API key" },
    { key: "test", label: "Test authentication" },
    { key: "inventory", label: "Workflow inventory" },
    { key: "approve", label: "Map approved workflows" },
    { key: "health", label: "Connection health" },
  ],
};
const HERMES_GATEWAY_FLOW: Array<{ key: StepKey; label: string }> = [
  { key: "endpoint", label: "Gateway" },
  { key: "auth", label: "Secure authentication" },
  { key: "test", label: "Gateway test" },
  { key: "agencyWorkforce", label: "Agency workforce" },
  { key: "provisioning", label: "Client provisioning" },
  { key: "health", label: "Final health" },
];
export interface WizardGateway {
  id: string;
  label: string;
  environment: string;
  baseUrl: string;
  host: string;
  gatewayType: "multiplexed_profiles" | "single_profile";
  reportedGatewayId: string | null;
  declaredVersion: string | null;
  status: string;
  hasAccessCredential: boolean;
  profileCreationStatus: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastHealthCheckAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  revision: number;
  mappedProfileCount: number;
  clientMappedProfileCount: number;
  capabilities: Record<string, unknown>;
  updatedAt: string | null;
  lastChangedBy: string | null;
}
export const GHL_SCOPE_CHOICES = [
  "locations.readonly",
  "opportunities.readonly",
  "calendars.readonly",
  "calendars/events.readonly",
  "locations/tags.readonly",
  "locations/customFields.readonly",
  "locations/customValues.readonly",
  "forms.readonly",
  "workflows.readonly",
  // Read by the GoHighLevel live-record migration (Settings → Imports & Exports).
  "contacts.readonly",
  "businesses.readonly",
  "users.readonly",
];

const text = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const OK_STATES = ["connected", "permission_limited"];
const tone = (s: string) => (s === "connected" ? "success" : s === "error" ? "danger" : s === "permission_limited" || s === "needs_attention" ? "warning" : "neutral") as "success" | "danger" | "warning" | "neutral";
const stateLabel = (s: string) => INTEGRATION_STATE_LABEL[s as IntegrationState] ?? s.replaceAll("_", " ");

function Row({ ok, title, children }: { ok: boolean | null; title: string; children?: React.ReactNode }) {
  const Icon = ok === null ? CircleDashed : ok ? CheckCircle2 : XCircle;
  return (
    <li className="flex gap-3 rounded-xl bg-surface-2 p-3">
      <Icon className={cn("mt-0.5 size-4 shrink-0", ok === null ? "text-muted" : ok ? "text-success" : "text-danger")} aria-hidden />
      <div className="min-w-0 text-[13px] leading-relaxed">
        <p className="font-medium text-ink">
          {title}
          <span className="sr-only">{ok === null ? " — informational" : ok ? " — verified" : " — not verified"}</span>
        </p>
        {children && <div className="mt-0.5 break-words text-xs text-muted">{children}</div>}
      </div>
    </li>
  );
}

function Notice({ tone: t = "info", children }: { tone?: "info" | "warning"; children: React.ReactNode }) {
  return (
    <p className={cn("flex gap-2 rounded-xl p-3 text-xs leading-relaxed", t === "warning" ? "bg-warning-soft text-warning-ink" : "bg-surface-2 text-muted")} role={t === "warning" ? "status" : undefined}>
      {t === "warning" ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Error monitoring: recent run outcomes (status only; execution data is never requested) for approved workflows. */
function ExecutionSummary({ caps }: { caps: Record<string, unknown> }) {
  const approved = list(caps.approvedWorkflows);
  const executions = (caps.executions ?? {}) as Record<string, unknown>;
  if (!approved.length) return <Notice>No workflows are approved yet, so there is nothing to monitor. Approve workflows in the previous step.</Notice>;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Recent executions of approved workflows</h3>
      <ul className="space-y-1.5">
        {approved.map((w) => {
          const runs = list(executions[text(w.id)]);
          const failed = runs.filter((r) => /error|fail|crash/i.test(text(r.status))).length;
          return (
            <li key={text(w.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
              <span className="min-w-0 break-words">{text(w.name) || text(w.id)}</span>
              <Badge tone={failed ? "danger" : "neutral"}>{runs.length} recent{failed ? ` · ${failed} failed` : ""}</Badge>
            </li>
          );
        })}
      </ul>
      {caps.executionReadVerified === false && <p className="mt-2 text-xs text-warning-ink">Execution summaries could not be read with this key, so failures are not being monitored.</p>}
    </div>
  );
}

function ResultBanner({ result }: { result: WizardResult }) {
  return (
    <div className="rounded-2xl border border-line p-4" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone(result.status)}>{stateLabel(result.status)}</Badge>
        <span className="text-xs text-muted">Verified with a real read-only request</span>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{result.detail}</p>
    </div>
  );
}

export function ConnectionWizard({
  connection,
  orgId,
  companyName,
  hermesGateways = [],
  setupState,
  storeReady,
  api,
  timeZone,
  onClose,
  onReload,
  initialStep = 0,
}: {
  /** Always the latest server view, so the final step reports the persisted status. */
  connection: IntegrationView;
  orgId: string | null;
  companyName?: string;
  hermesGateways?: WizardGateway[];
  setupState?: HermesSetupSummary;
  storeReady: boolean;
  api: WizardApi;
  timeZone: string;
  onClose: () => void;
  onReload?: () => void;
  /** Dev preview only: open at a later step so every screen can be reviewed without a live service. */
  initialStep?: number;
}) {
  const provider = connection.provider as WizardProvider;
  const pathname = usePathname();
  const isGatewayWizard = provider === "hermes" && !orgId;
  const flow = isGatewayWizard ? HERMES_GATEWAY_FLOW : FLOWS[provider];
  const reduce = useReducedMotion();
  const [index, setIndex] = React.useState(() => Math.max(0, Math.min(flow.length - 1, initialStep)));
  const [secret, setSecret] = React.useState("");
  const [busy, setBusy] = React.useState<null | "save" | "test" | "sync" | "map">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<WizardResult | null>(null);
  const [synced, setSynced] = React.useState<WizardResult | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [mapped, setMapped] = React.useState(false);
  const heading = React.useRef<HTMLHeadingElement>(null);
  const cfg = connection.config;
  const restoredDraft = setupState?.draft && !setupState.draft.stale ? setupState.draft.config : null;

  const [label, setLabel] = React.useState(restoredDraft?.label ?? connection.label);
  const [environment, setEnvironment] = React.useState<"development" | "staging" | "production">((restoredDraft?.environment ?? connection.environment) as "development" | "staging" | "production");
  const [baseUrl, setBaseUrl] = React.useState(restoredDraft?.baseUrl ?? text(cfg.baseUrl));
  const [gatewayId, setGatewayId] = React.useState(text(cfg.gatewayId));
  const selectedGateway = hermesGateways.find((item) => item.id === gatewayId) ?? null;
  const [gatewayType, setGatewayType] = React.useState(restoredDraft?.gatewayType ?? (text(cfg.gatewayType) === "single_profile" ? "single_profile" : "multiplexed_profiles"));
  const [reportedGatewayId, setReportedGatewayId] = React.useState(restoredDraft?.reportedGatewayId ?? text(cfg.reportedGatewayId));
  const [accessClientId, setAccessClientId] = React.useState("");
  const [accessClientSecret, setAccessClientSecret] = React.useState("");
  const [replacingCredentials, setReplacingCredentials] = React.useState(false);
  const [profile, setProfile] = React.useState(text(cfg.profile));
  const [roleKey, setRoleKey] = React.useState(text(cfg.roleKey) || AGENT_ROLE_KEYS[0]);
  const [declaredVersion, setDeclaredVersion] = React.useState(restoredDraft?.declaredVersion ?? text(cfg.declaredVersion));
  const [locationId, setLocationId] = React.useState(text(cfg.locationId));
  const [apiVersion, setApiVersion] = React.useState(text(cfg.apiVersion) || "2021-07-28");
  const [scopes, setScopes] = React.useState<string[]>(strings(cfg.scopes).length ? strings(cfg.scopes) : ["locations.readonly", "opportunities.readonly", "calendars.readonly", "calendars/events.readonly"]);
  const [approved, setApproved] = React.useState<string[]>(strings(cfg.approvedWorkflowIds));
  const [pipelineId, setPipelineId] = React.useState(text(cfg.pipelineId));
  const [calendarIds, setCalendarIds] = React.useState<string[]>(strings(cfg.calendarIds));

  const [draftStatus, setDraftStatus] = React.useState<"idle" | "saving" | "saved" | "failed">(restoredDraft ? "saved" : "idle");
  const [draftError, setDraftError] = React.useState<string | null>(null);
  const [closeWarningOpen, setCloseWarningOpen] = React.useState(false);
  const [progressError, setProgressError] = React.useState<string | null>(null);
  const gatewayIdRef = React.useRef(gatewayId);
  const gatewayRevisionRef = React.useRef<number | null>(setupState?.gatewayRevision ?? null);
  const draftRevisionRef = React.useRef(setupState?.draft?.revision ?? 0);
  const draftQueueRef = React.useRef<Promise<void>>(Promise.resolve());
  const draftTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiRef = React.useRef(api);
  const safeDraft = React.useMemo<HermesSetupDraftConfig>(() => ({ label, environment, baseUrl, gatewayType, reportedGatewayId, declaredVersion }), [label, environment, baseUrl, gatewayType, reportedGatewayId, declaredVersion]);
  const safeDraftSignature = JSON.stringify(safeDraft);
  const currentSignatureRef = React.useRef(safeDraftSignature);
  const [baselineSignature, setBaselineSignature] = React.useState(safeDraftSignature);
  React.useEffect(() => { currentSignatureRef.current = safeDraftSignature; }, [safeDraftSignature]);
  React.useEffect(() => { apiRef.current = api; }, [api]);
  React.useEffect(() => { gatewayIdRef.current = gatewayId; }, [gatewayId]);
  const hasUnsavedSecret = Boolean(secret || accessClientId || accessClientSecret);
  const nonSecretDirty = isGatewayWizard && safeDraftSignature !== baselineSignature;
  const hasUnsavedChanges = nonSecretDirty || (!isGatewayWizard && (hasUnsavedSecret || (!saved && (label !== connection.label || environment !== connection.environment || baseUrl !== text(cfg.baseUrl) || locationId !== text(cfg.locationId)))));
  useLogoutUnsavedChanges(
    isGatewayWizard ? "Hermes setup" : "integration setup",
    hasUnsavedChanges,
    hasUnsavedSecret,
    pathname,
    isGatewayWizard ? "Cloudflare Access or Hermes profile credentials" : "integration credentials",
    `integration-wizard:${pathname}`,
  );

  const persistDraft = React.useCallback((config: HermesSetupDraftConfig, signature: string) => {
    const task = draftQueueRef.current.catch(() => undefined).then(async () => {
      const result = await apiRef.current.saveHermesDraft({
        gatewayId: gatewayIdRef.current || null,
        expectedDraftRevision: draftRevisionRef.current,
        expectedGatewayRevision: gatewayRevisionRef.current,
        config,
      });
      draftRevisionRef.current = result.revision;
      if (currentSignatureRef.current === signature) {
        setBaselineSignature(signature);
        setDraftStatus("saved");
        setDraftError(null);
      }
    });
    draftQueueRef.current = task.then(() => undefined, () => undefined);
    setDraftStatus("saving");
    setDraftError(null);
    return task.then(() => true, (cause: unknown) => {
      if (currentSignatureRef.current === signature) {
        setDraftStatus("failed");
        setDraftError(cause instanceof Error ? cause.message : "The setup draft could not be saved.");
      }
      return false;
    });
  }, []);

  React.useEffect(() => {
    if (!isGatewayWizard || !nonSecretDirty) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    const config = safeDraft;
    const signature = safeDraftSignature;
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      void persistDraft(config, signature);
    }, 700);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [isGatewayWizard, nonSecretDirty, persistDraft, safeDraft, safeDraftSignature]);

  const step = flow[index].key;
  React.useEffect(() => {
    heading.current?.focus();
  }, [index]);

  // The newest verified data: a fresh sync, else the last test, else what the server already holds.
  const latest = synced ?? result;
  const caps = latest?.capabilities ?? connection.capabilities;
  const verified = !!latest && OK_STATES.includes(latest.status);

  function buildInput() {
    const config =
      provider === "ghl"
        ? { locationId, authMethod: "private_integration", apiVersion, scopes, ...(pipelineId ? { pipelineId } : {}), calendarIds }
        : provider === "hermes"
          ? isGatewayWizard
            ? { baseUrl, ...(gatewayId ? { gatewayId } : {}), authMethod: "bearer", gatewayType, ...(reportedGatewayId ? { reportedGatewayId } : {}), ...(declaredVersion ? { declaredVersion } : {}) }
            : { ...(gatewayId ? { gatewayId } : {}), profile, authMethod: "bearer", gatewayType: "multiplexed_profiles", roleKey, ...(declaredVersion ? { declaredVersion } : {}) }
          : { baseUrl, authMethod: "api_key", approvedWorkflowIds: approved, ...(declaredVersion ? { declaredVersion } : {}), declaredEdition: "unknown" };
    return {
      provider,
      label,
      environment,
      config,
      ...(isGatewayWizard && gatewayId && gatewayRevisionRef.current !== null ? { gatewayRevision: gatewayRevisionRef.current } : {}),
      ...(!isGatewayWizard && secret ? { secret } : {}),
      ...(isGatewayWizard && accessClientId.trim() ? { accessClientId: accessClientId.trim() } : {}),
      ...(isGatewayWizard && accessClientSecret.trim() ? { accessClientSecret: accessClientSecret.trim() } : {}),
    };
  }

  async function run(kind: "save" | "test" | "sync" | "map", work: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That request could not be completed.");
    } finally {
      setBusy(null);
    }
  }
  const go = (delta: number) => {
    setError(null);
    const next = Math.max(0, Math.min(flow.length - 1, index + delta));
    setIndex(next);
    setProgressError(null);
    if (isGatewayWizard) void apiRef.current.saveHermesProgress(next, gatewayIdRef.current || null).catch((cause: unknown) => {
      setProgressError(cause instanceof Error ? cause.message : "Wizard position could not be saved.");
    });
  };
  const saveAndContinue = () =>
    run("save", async () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
      await draftQueueRef.current.catch(() => undefined);
      const savedConnection = await api.save(buildInput());
      if (savedConnection && "gatewayId" in savedConnection && savedConnection.gatewayId) {
        gatewayIdRef.current = savedConnection.gatewayId;
        setGatewayId(savedConnection.gatewayId);
      }
      if (savedConnection && "gatewayRevision" in savedConnection && typeof savedConnection.gatewayRevision === "number") {
        gatewayRevisionRef.current = savedConnection.gatewayRevision;
      }
      setBaselineSignature(safeDraftSignature);
      draftRevisionRef.current = 0;
      setDraftStatus("saved");
      setDraftError(null);
      setSaved(true);
      setResult(null);
      setSynced(null);
      setSecret("");
      setAccessClientId("");
      setAccessClientSecret("");
      setReplacingCredentials(false);
      go(1);
    });
  const runTest = () =>
    run("test", async () => {
      const r = await api.test(provider, provider === "hermes" && !orgId ? gatewayId || connection.id || undefined : undefined);
      setResult(r);
      setSynced(null);
    });
  const sync = () =>
    run("sync", async () => {
      const r = await api.syncMetadata();
      if (OK_STATES.includes(r.status)) setSynced(r);
      else setResult(r);
    });
  const approveAndRetest = () =>
    run("save", async () => {
      await api.save(buildInput());
      setSaved(true);
      setBusy("test");
      setResult(await api.test("n8n"));
    });
  const saveMapping = () =>
    run("map", async () => {
      await api.mapGhlAssets({ pipelineId: pipelineId || null, calendarIds });
      setMapped(true);
    });

  async function requestClose() {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    if (nonSecretDirty) {
      const persisted = await persistDraft(safeDraft, safeDraftSignature);
      if (!persisted) {
        setError("Your latest settings could not be saved. Retry the save before closing this wizard.");
        return;
      }
    }
    if (hasUnsavedSecret || (!isGatewayWizard && hasUnsavedChanges)) {
      setCloseWarningOpen(true);
      return;
    }
    setSecret("");
    setAccessClientId("");
    setAccessClientSecret("");
    onClose();
  }

  function discardAndClose() {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
    setSecret("");
    setAccessClientId("");
    setAccessClientSecret("");
    setCloseWarningOpen(false);
    onClose();
  }

  const retryDraft = () => void persistDraft(safeDraft, safeDraftSignature);

  // ---- step bodies --------------------------------------------------------------------------
  const secretLabel = provider === "ghl" ? "Private Integration token" : provider === "n8n" ? "n8n API key" : "Profile API_SERVER_KEY";
  const gatewayLocal = isGatewayWizard && (baseUrl.startsWith("http://localhost") || baseUrl.startsWith("http://127.0.0.1") || baseUrl.startsWith("http://[::1]"));
  const needsSecret = isGatewayWizard ? (!connection.hasCredential && !saved && !gatewayLocal) || (connection.hasCredential && replacingCredentials) : !connection.hasCredential && !saved;

  function Body() {
    switch (step) {
      case "endpoint":
        return (
          <div className="space-y-4">
            <Field label="Connection label" htmlFor="w-label"><Input id="w-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} /></Field>
            <Field label="Environment" htmlFor="w-env">
              <Select id="w-env" value={environment} onChange={(e) => setEnvironment(e.target.value as "development" | "staging" | "production")}>
                <option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option>
              </Select>
            </Field>
            {isGatewayWizard ? <>
              <Field label="Approved HTTPS gateway URL" htmlFor="w-url" hint="The planned Hermes API host is pre-approved. Other hosts must be explicitly allowlisted in secure server settings. The public Hermes dashboard is not an API endpoint.">
                <Input id="w-url" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://hermes-api.iacquire.online" autoComplete="off" />
              </Field>
              <Field label="Gateway type" htmlFor="w-gateway-type">
                <Select id="w-gateway-type" value={gatewayType} onChange={(e) => setGatewayType(e.target.value as "multiplexed_profiles" | "single_profile")}>
                  <option value="multiplexed_profiles">One gateway with separate profiles</option>
                  <option value="single_profile">Single profile gateway</option>
                </Select>
              </Field>
              <Field label="Gateway identification" htmlFor="w-gateway-id" optional hint="An operator-supplied identifier is saved as an unverified note. It is not proof of gateway identity.">
                <Input id="w-gateway-id" value={reportedGatewayId} onChange={(e) => setReportedGatewayId(e.target.value)} autoComplete="off" maxLength={120} />
              </Field>
            </> : <>
              <Field label="Approved Hermes gateway" htmlFor="w-gateway-select" hint="Choose a gateway configured and controlled by iAcquire. This employee receives its own Hermes profile key.">
                <Select id="w-gateway-select" value={gatewayId} onChange={(e) => { const selected = hermesGateways.find((g) => g.id === e.target.value); setGatewayId(e.target.value); if (selected) setBaseUrl(selected.baseUrl); }}>
                  <option value="">Select an approved gateway…</option>
                  {hermesGateways.filter((g) => g.status !== "disconnected").map((gateway) => <option key={gateway.id} value={gateway.id}>{gateway.label} · {gateway.host}</option>)}
                </Select>
              </Field>
              {!hermesGateways.some((g) => g.status !== "disconnected") && <Notice tone="warning">No approved Hermes gateway is available. An agency super admin must register one in Admin → Integrations first.</Notice>}
              <Field label="Profile identifier" htmlFor="w-profile" hint="Enter the existing or separately provisioned profile ID. The backend will verify that it answers on the selected gateway.">
                <Input id="w-profile" value={profile} onChange={(e) => setProfile(e.target.value)} autoComplete="off" />
              </Field>
            </>}
            {!isGatewayWizard && (
              <Field label="AI employee" htmlFor="w-role">
                <Select id="w-role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
                  {AGENT_ROLE_KEYS.map((key) => <option key={key} value={key}>{AGENT_BY_KEY[key].name}</option>)}
                </Select>
              </Field>
            )}
            {isGatewayWizard && <Field label="Installed version, as told by the gateway administrator" htmlFor="w-version" optional hint="Saved as an unverified note. The API capability check does not identify the package version.">
              <Input id="w-version" value={declaredVersion} onChange={(e) => setDeclaredVersion(e.target.value)} maxLength={80} />
            </Field>}
          </div>
        );
      case "instance":
        return (
          <div className="space-y-4">
            <Field label="Connection label" htmlFor="w-label"><Input id="w-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} /></Field>
            <Field label="Environment" htmlFor="w-env">
              <Select id="w-env" value={environment} onChange={(e) => setEnvironment(e.target.value as "development" | "staging" | "production")}>
                <option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option>
              </Select>
            </Field>
            <Field label="n8n instance URL" htmlFor="w-url" hint="Use the instance's HTTPS address. Its exact host must be approved in secure server settings.">
              <Input id="w-url" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://n8n.example.com" autoComplete="off" />
            </Field>
            <Field label="Installed version, as told by the n8n administrator" htmlFor="w-version" optional hint="Saved as an unverified note.">
              <Input id="w-version" value={declaredVersion} onChange={(e) => setDeclaredVersion(e.target.value)} maxLength={80} />
            </Field>
            <Notice>Your existing Appointment Event Processor and its PostgreSQL event store are untouched. This connection only reads workflow information.</Notice>
          </div>
        );
      case "client":
        return (
          <div className="space-y-4">
            <div className="rounded-2xl border border-line p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Client</p>
              <p className="mt-1 text-[16px] font-semibold text-ink">{companyName ?? "Selected client"}</p>
            </div>
            <ol className="list-inside list-decimal space-y-1.5 text-[13px] leading-relaxed text-muted">
              <li>Create this client&apos;s GoHighLevel sub-account manually from the approved iAcquire Master Snapshot.</li>
              <li>Copy the new sub-account&apos;s Location ID.</li>
              <li>Create a Private Integration token for that one sub-account with read-only scopes.</li>
            </ol>
            <Notice>The portal never creates sub-accounts and never uses the agency location or the protected Aster Homes location for a client.</Notice>
          </div>
        );
      case "location":
        return (
          <div className="space-y-4">
            <Field label="Connection label" htmlFor="w-label"><Input id="w-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} /></Field>
            <Field label="GHL Location ID" htmlFor="w-location" hint="Letters and numbers only. The test confirms that the token really belongs to this location.">
              <Input id="w-location" value={locationId} onChange={(e) => setLocationId(e.target.value.trim())} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Environment" htmlFor="w-env">
              <Select id="w-env" value={environment} onChange={(e) => setEnvironment(e.target.value as "development" | "staging" | "production")}>
                <option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option>
              </Select>
            </Field>
            <Field label="API contract" htmlFor="w-api">
              <Select id="w-api" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)}>
                <option value="2021-07-28">2021-07-28 (current adapter)</option><option value="v3">v3</option>
              </Select>
            </Field>
          </div>
        );
      case "auth":
        return (
          <div className="space-y-4">
            {isGatewayWizard ? <>
              {connection.hasCredential && !replacingCredentials ? <div className="space-y-3 rounded-2xl border border-success/20 bg-success-soft/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold text-ink">Cloudflare Access — Credentials Saved</p><p className="mt-1 text-xs text-muted">Stored in Supabase Vault. The saved values are never returned to this screen.</p></div><Badge tone="success">Credentials Saved</Badge></div>
                <p className="text-xs text-muted">Last verified: {connection.lastSuccessAt ? formatDateTime(connection.lastSuccessAt, timeZone) : "Not yet verified"}</p>
                <p className="text-xs text-muted">Last rotated: {setupState?.credentialsRotatedAt ? formatDateTime(setupState.credentialsRotatedAt, timeZone) : "Not recorded"}</p>
                <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setReplacingCredentials(true)}>Replace Credentials</Button><Button variant="soft" loading={busy === "test"} onClick={() => void runTest()}>Test saved credentials</Button></div>
                {result && <ResultBanner result={result} />}
              </div> : <>
                <Field label="Cloudflare Access service token ID" htmlFor="w-access-id" hint={connection.hasCredential ? "Enter both new values to rotate the stored service token." : "Used by the server to pass Cloudflare Access. It is stored in Supabase Vault and never sent to the browser after saving."}>
                  <Input id="w-access-id" type="password" autoComplete="new-password" value={accessClientId} onChange={(e) => setAccessClientId(e.target.value)} placeholder={connection.hasCredential ? "New service token ID" : "Service token ID"} maxLength={512} />
                </Field>
                <Field label="Cloudflare Access service token secret" htmlFor="w-access-secret" hint="This is separate from every Hermes profile API_SERVER_KEY.">
                  <Input id="w-access-secret" type="password" autoComplete="new-password" value={accessClientSecret} onChange={(e) => setAccessClientSecret(e.target.value)} placeholder={connection.hasCredential ? "New service token secret" : "Service token secret"} maxLength={2048} />
                </Field>
              </>}
              <Notice>Cloudflare Access authenticates iAcquire to the protected hostname. Each employee will still use its own Hermes profile API key.</Notice>
            </> : <Field label={secretLabel} htmlFor="w-secret" hint={connection.hasCredential ? "Leave empty to keep the stored credential. Enter a new value to rotate it; the old portal credential is revoked." : "Enter it only here. Never paste private keys into chat, tickets or email."}>
              <Input id="w-secret" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={connection.hasCredential ? "Existing credential securely stored" : "Enter credential securely"} maxLength={4096} />
            </Field>}
            {provider === "ghl" && (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-semibold">Intended read-only permissions</legend>
                <p className="text-xs text-muted">The location read proves identity. Turn on other scopes only for setup checks you need. Write scopes are not offered.</p>
                {GHL_SCOPE_CHOICES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={scopes.includes(scope)} disabled={scope === "locations.readonly"} onChange={(e) => setScopes((s) => (e.target.checked ? [...s, scope] : s.filter((v) => v !== scope)))} />
                    {scope}
                  </label>
                ))}
              </fieldset>
            )}
            {provider === "n8n" && <Notice tone="warning">Scoped API keys depend on the installed n8n edition. Until your administrator verifies restrictions, treat this key as having broad instance privileges. Clients can never choose API operations or workflow IDs.</Notice>}
            <Notice>Supabase Vault encrypts the value with a managed key held outside application data. Only a reference and fingerprint are stored in portal tables, and nothing is returned after saving.</Notice>
            {!storeReady && <Notice tone="warning">Managed credential storage is not available yet. Enable Supabase Vault in the approved project before saving.</Notice>}
          </div>
        );
      case "test":
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed text-muted">
              {provider === "hermes" && (isGatewayWizard
                ? "The portal sends a Cloudflare-authenticated, read-only request to the Hermes health endpoint. This verifies gateway connectivity only; each agency profile is checked separately."
                : "The portal reaches the gateway, signs in with this employee's own key, and checks which profile answers. No AI run is started.")}
              {provider === "ghl" && "The portal reads only this location: it confirms the token belongs to it, then tests each read permission you selected. Nothing is written."}
              {provider === "n8n" && "The portal authenticates with the API key and reads the workflow list. It never edits, runs or activates a workflow."}
            </p>
            {!saved && connection.status === "not_configured" && <Notice tone="warning">Save the credential first.</Notice>}
            {busy === "test" && <p className="text-[13px] text-muted" role="status">Testing the live service…</p>}
            {result && <ResultBanner result={result} />}
            {result && !OK_STATES.includes(result.status) && <Notice tone="warning">Go back to correct the endpoint or credential, then test again. The connection stays unverified until a test succeeds.</Notice>}
          </div>
        );
      case "capabilities": {
        const restricted = strings(caps.restrictedTools);
        return (
          <ul className="space-y-2">
            <Row ok={caps.installedContractVerified === true} title="Gateway reached and signed in">The installed Hermes API answered with its capabilities for this profile key.</Row>
            <Row ok={caps.identityVerified === true} title="Profile identity verified">The gateway lists “{text(caps.profile) || profile}” for this key.</Row>
            <Row ok={caps.supportsRuns === true && caps.supportsEvents === true} title="Runs and live events supported" />
            <Row ok={null} title="Stop and approval support">Stop: {caps.supportsStop ? "yes" : "no"} · Approvals: {caps.supportsApproval ? "yes" : "no"}</Row>
            <Row ok={restricted.length === 0} title={restricted.length ? "Restricted tools are exposed" : "No restricted tools exposed"}>
              {restricted.length ? `Remove these before use: ${restricted.slice(0, 8).join(", ")}${restricted.length > 8 ? "…" : ""}` : "No terminal, file, code, browser, scheduling or delegation tools."}
            </Row>
            <Row ok={null} title="Gateway package version">Not reported by the gateway. Remote profile creation stays an agency-controlled task.</Row>
          </ul>
        );
      }
      case "routing":
        return (
          <div className="space-y-4">
            <dl className="grid gap-3 rounded-2xl border border-line p-4 text-[13px] sm:grid-cols-2">
              <div><dt className="text-xs text-muted">Gateway host</dt><dd className="break-all font-medium">{safeHost(baseUrl)}</dd></div>
              <div><dt className="text-xs text-muted">Profile</dt><dd className="break-all font-medium">{profile}</dd></div>
              <div><dt className="text-xs text-muted">Serves</dt><dd className="font-medium">{orgId ? `${companyName ?? "This client"} · ${AGENT_BY_KEY[roleKey as keyof typeof AGENT_BY_KEY]?.name ?? roleKey}` : "Agency gateway (not a client identity)"}</dd></div>
              <div><dt className="text-xs text-muted">Identity check</dt><dd className="font-medium">{caps.identityVerified === true ? "Verified" : "Not verified"}</dd></div>
            </dl>
            <Notice>{orgId ? "This profile can only serve this client's employee. The portal refuses to reuse it for another employee or client." : "Client employees use their own dedicated profiles, never agency profiles."} Employee “Online” also needs a separate employee health check.</Notice>
          </div>
        );
      case "agencyWorkforce": {
        const step = setupState?.steps.find((item) => item.index === 3);
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed text-muted">The six existing iAcquire identities have separate profile keys and individual read-only checks. The portal does not create profiles or use Hermes&apos; default profile as a substitute.</p>
            <Row ok={step?.complete === true} title={step?.complete ? "Agency profiles verified" : "Agency profile mapping and checks"}>{step?.detail ?? `${selectedGateway?.mappedProfileCount ?? 0} of 6 existing agency identities mapped to this gateway.`}</Row>
            <p className="text-xs text-muted">Client profile mappings on this gateway: {selectedGateway?.clientMappedProfileCount ?? 0}. Client identity checks stay in their own client workspaces.</p>
            <Link href="/admin/workforce?from=integrations" className="inline-flex min-h-10 items-center rounded-xl border border-line px-3 text-sm font-medium text-primary hover:bg-surface-2">Open Internal Workforce</Link>
            <Notice>Compare each prefilled profile ID with the authorized Hermes inventory before confirming. Profile keys are stored separately in Vault.</Notice>
          </div>
        );
      }
      case "provisioning": {
        const creation = caps.profileCreation && typeof caps.profileCreation === "object" ? caps.profileCreation as Record<string, unknown> : {};
        const creationStatus = text(creation.status) || "unverified";
        return (
          <div className="space-y-4">
            <Row ok={creationStatus === "restricted_service_verified"} title={creationStatus === "restricted_service_verified" ? "Restricted provisioning service verified" : "Automatic client profile creation not verified"}>
              {creationStatus === "restricted_service_verified" ? "The gateway's restricted provisioning service passed its capability and isolation checks." : "No installed-version-aware, restricted profile provisioning service is configured. Client workforces cannot be marked Ready or auto-created by this connection yet."}
            </Row>
            <Notice tone="warning">Do not use the Hermes dashboard or unrestricted shell tools as a substitute for a secure provisioning API. The current operator runbook creates blank profiles on the VPS and must be reviewed before each client rollout.</Notice>
            <p className="text-xs text-muted">Provisioning readiness stays unverified until the remote service proves isolated creation, unique credentials, idempotent retries and tenant routing.</p>
          </div>
        );
      }
      case "metadata": {
        const inventory = (caps.inventory ?? {}) as Record<string, unknown>;
        const proven = strings(caps.provenReadPermissions);
        const unavailable = strings(caps.unavailablePermissions);
        return (
          <div className="space-y-4">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Read permissions</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                <Row ok={caps.locationIdentityVerified === true} title="Location identity">The token belongs to {text(caps.locationId) || locationId}.</Row>
                {scopes.map((scope) => (
                  <Row key={scope} ok={proven.includes(scope) ? true : unavailable.includes(scope) ? false : null} title={scope}>
                    {proven.includes(scope) ? "Proven by a real read" : unavailable.includes(scope) ? "Not available to this token" : "Requested. Metadata discovery has no individual probe for this scope."}
                  </Row>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Discovered CRM metadata</h3>
              {Object.keys(inventory).length ? (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {Object.entries(inventory).map(([kind, items]) => (
                    <li key={kind} className="rounded-xl bg-surface-2 p-3 text-xs">
                      <p className="font-semibold capitalize text-ink">{kind.replace(/([A-Z])/g, " $1")}: {list(items).length}</p>
                      <p className="mt-0.5 break-words text-muted">{list(items).slice(0, 4).map((i) => text(i.name)).filter(Boolean).join(", ") || "—"}{list(items).length > 4 ? "…" : ""}</p>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-muted">No metadata discovered yet.</p>}
              {text(caps.metadataSyncedAt) && <p className="mt-2 text-xs text-muted">Synced {formatDateTime(text(caps.metadataSyncedAt), timeZone)}</p>}
            </div>
            <Notice>Snapshot installation is <strong>not verified</strong> by this check. Private Integration tokens also do not subscribe to Marketplace webhooks; that is a separate connection.</Notice>
            {busy === "sync" && <p className="text-xs text-muted" role="status">Re-reading the location&apos;s metadata…</p>}
          </div>
        );
      }
      case "mapping": {
        const inventory = (caps.inventory ?? {}) as Record<string, unknown>;
        const pipelines = list(inventory.pipelines);
        const calendars = list(inventory.calendars);
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed text-muted">Optionally choose the pipeline and calendars the system should be prepared to use. Only items found in this location&apos;s verified metadata can be selected. This is a preparation record; nothing is written to GoHighLevel.</p>
            <Field label="Pipeline" htmlFor="w-pipeline" optional>
              <Select id="w-pipeline" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} disabled={!pipelines.length}>
                <option value="">{pipelines.length ? "No pipeline mapping" : "Sync metadata to list pipelines"}</option>
                {pipelines.map((p) => <option key={text(p.id)} value={text(p.id)}>{text(p.name) || text(p.id)}</option>)}
              </Select>
            </Field>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">Calendars <span className="font-normal text-muted">(optional)</span></legend>
              {calendars.length ? calendars.map((c) => (
                <label key={text(c.id)} className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
                  <input type="checkbox" checked={calendarIds.includes(text(c.id))} onChange={(e) => setCalendarIds((ids) => (e.target.checked ? [...ids, text(c.id)] : ids.filter((id) => id !== text(c.id))))} />
                  <span className="min-w-0 break-words">{text(c.name) || text(c.id)}</span>
                </label>
              )) : <p className="text-xs text-muted">No calendars were discovered. The token may lack calendar read access.</p>}
            </fieldset>
            {mapped && <p className="rounded-xl bg-success-soft p-3 text-xs text-success-ink" role="status">Mapping saved from verified metadata. Nothing was written to GoHighLevel.</p>}
          </div>
        );
      }
      case "inventory": {
        const workflows = list(caps.workflows);
        return (
          <div className="space-y-4">
            {result ? <ResultBanner result={result} /> : <Notice tone="warning">Run the authentication test first.</Notice>}
            <div>
              <h3 className="mb-2 text-sm font-semibold">Workflow inventory ({workflows.length})</h3>
              {workflows.length ? (
                <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                  {workflows.map((w) => (
                    <li key={text(w.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
                      <span className="min-w-0 break-words">{text(w.name) || text(w.id)} <span className="text-xs text-muted">({text(w.id)})</span></span>
                      <Badge tone={w.active ? "warning" : "neutral"}>{w.active ? "Active" : "Inactive"}</Badge>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-muted">No workflows were returned.</p>}
              {caps.inventoryTruncated === true && <p className="mt-2 text-xs text-warning-ink">The list was truncated. Narrow the key&apos;s access or review the instance directly.</p>}
            </div>
            <Notice>Only names, IDs and active state are kept. Execution data and workflow contents are never requested.</Notice>
          </div>
        );
      }
      case "approve": {
        const workflows = list(caps.workflows);
        const processor = workflows.find((w) => /iacquire.*appointment.*event.*processor/i.test(text(w.name)));
        return (
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed text-muted">Choose which workflows the portal may read execution summaries for. You can then associate them with a client on that client&apos;s integrations page. Clients never choose workflows.</p>
            {workflows.length ? (
              <fieldset className="space-y-2">
                <legend className="sr-only">Approved workflows</legend>
                {workflows.map((w) => (
                  <label key={text(w.id)} className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
                    <input type="checkbox" checked={approved.includes(text(w.id))} onChange={(e) => setApproved((ids) => (e.target.checked ? [...ids, text(w.id)] : ids.filter((id) => id !== text(w.id))))} />
                    <span className="min-w-0 break-words">{text(w.name) || text(w.id)} <span className="text-xs text-muted">({text(w.id)})</span></span>
                  </label>
                ))}
              </fieldset>
            ) : <Notice tone="warning">No workflows are available to approve. Run the test first.</Notice>}
            {processor && <Notice>“{text(processor.name)}” is {processor.active ? "active" : "inactive"} in n8n. The portal only reads it and never activates, edits or restarts it.</Notice>}
            {result && <ResultBanner result={result} />}
          </div>
        );
      }
      case "health": {
        const mode = latest ? "Verified in this session" : "Last recorded status";
        return (
          <div className="space-y-4">
            <div className="rounded-2xl border border-line p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={tone(connection.status)}>{isGatewayWizard ? connection.status === "connected" ? "Gateway connected" : "Gateway needs attention" : stateLabel(connection.status)}</Badge>
                <span className="text-xs text-muted">{mode}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
                <div><dt className="text-xs text-muted">{isGatewayWizard ? "Last gateway health check" : "Last successful test"}</dt><dd>{connection.lastSuccessAt ? formatDateTime(connection.lastSuccessAt, timeZone) : "Not yet verified"}</dd></div>
                <div><dt className="text-xs text-muted">Last failed test</dt><dd>{connection.lastFailureAt ? formatDateTime(connection.lastFailureAt, timeZone) : "None recorded"}</dd></div>
              </dl>
              {connection.lastError && <p className="mt-3 rounded-xl bg-warning-soft p-3 text-xs text-warning-ink">{connection.lastError}</p>}
            </div>
            {isGatewayWizard && <div className="space-y-2 rounded-2xl border border-line p-4">
              <h3 className="text-sm font-semibold">Combined readiness</h3>
              <Row ok={caps.gatewayHealthVerified === true} title="Protected Hermes gateway">Cloudflare-authenticated health endpoint; does not imply any employee profile is connected.</Row>
              <Row ok={setupState?.steps.find((item) => item.index === 3)?.complete === true} title="Six iAcquire employee profiles">{setupState?.steps.find((item) => item.index === 3)?.detail ?? "Run the profile checks from Internal Workforce."}</Row>
              <Row ok={setupState?.steps.find((item) => item.index === 4)?.complete === true} title="Client profile provisioning">{setupState?.steps.find((item) => item.index === 4)?.detail ?? "No restricted client provisioning service is verified."}</Row>
            </div>}
            {provider === "n8n" && <ExecutionSummary caps={caps} />}
            {connection.status !== "connected" && <Notice tone="warning">This connection is not fully verified. Open diagnostics from its card, correct the issue and test again.</Notice>}
            <Notice>{isGatewayWizard ? "Gateway Connected reflects the protected health endpoint only. Profile checks and client provisioning have separate readiness states." : "Connected only appears after a real test succeeds. This does not activate workflows, messaging or client outreach."}</Notice>
          </div>
        );
      }
    }
  }

  // ---- footer -------------------------------------------------------------------------------
  const last = index === flow.length - 1;
  const primary = (() => {
    switch (step) {
      case "auth":
        return <Button loading={busy === "save"} disabled={(!storeReady && !gatewayLocal) || (needsSecret && (isGatewayWizard ? (!accessClientId.trim() || !accessClientSecret.trim()) : secret.trim().length < 16))} onClick={() => void saveAndContinue()}><KeyRound className="size-4" /> Save securely &amp; continue</Button>;
      case "test":
        return isGatewayWizard
                ? <><Button variant="secondary" loading={busy === "test"} disabled={!saved && connection.status === "not_configured"} onClick={() => void runTest()}>{result ? "Test gateway again" : "Test gateway"}</Button><Button onClick={() => go(1)} disabled={!saved && connection.status === "not_configured"}>Continue <ArrowRight className="size-4" /></Button></>
          : result && OK_STATES.includes(result.status)
          ? <><Button variant="secondary" loading={busy === "test"} onClick={() => void runTest()}>Test again</Button><Button onClick={() => go(1)}>Continue <ArrowRight className="size-4" /></Button></>
          : <Button loading={busy === "test"} disabled={!saved && connection.status === "not_configured"} onClick={() => void runTest()}>{result ? "Test again" : "Run live test"}</Button>;
      case "metadata":
        return <><Button variant="secondary" loading={busy === "sync"} disabled={!verified && !OK_STATES.includes(connection.status)} onClick={() => void sync()}>Sync metadata</Button><Button onClick={() => go(1)} disabled={!verified && !OK_STATES.includes(connection.status)}>Continue <ArrowRight className="size-4" /></Button></>;
      case "mapping":
        return <><Button variant="secondary" loading={busy === "map"} disabled={!pipelineId && !calendarIds.length && !text(cfg.pipelineId) && !strings(cfg.calendarIds).length} onClick={() => void saveMapping()}>Save mapping</Button><Button onClick={() => void requestClose()}>Finish</Button></>;
      case "approve":
        return <><Button variant="secondary" loading={busy === "save" || busy === "test"} disabled={!(caps.workflows as unknown[] | undefined)?.length} onClick={() => void approveAndRetest()}>Save approvals &amp; re-test</Button><Button onClick={() => go(1)}>Continue <ArrowRight className="size-4" /></Button></>;
      case "inventory":
        return <Button onClick={() => go(1)} disabled={!result || !OK_STATES.includes(result.status)}>Continue <ArrowRight className="size-4" /></Button>;
      case "capabilities":
        return <Button onClick={() => go(1)}>Continue <ArrowRight className="size-4" /></Button>;
      default:
        return last ? <Button onClick={() => void requestClose()}>Done</Button> : <Button onClick={() => go(1)} disabled={(step === "endpoint" && (isGatewayWizard ? !baseUrl : (!gatewayId || !profile))) || (step === "instance" && !baseUrl) || (step === "location" && locationId.length < 10)}>Continue <ArrowRight className="size-4" /></Button>;
    }
  })();

  return (
    <>
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void requestClose();
      }}
      title={`Connect ${INTEGRATION_NAMES[provider]}`}
      description="Configuration is saved first. A separate live test must succeed before this connection can show Connected."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => (index > 0 ? go(-1) : void requestClose())}>{index > 0 ? "Back" : "Cancel"}</Button>
          {primary}
        </>
      }
    >
      <div className="space-y-5">
        {isGatewayWizard && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs" role="status" aria-live="polite">
          <span className={cn(draftStatus === "failed" ? "text-danger-ink" : draftStatus === "saving" || nonSecretDirty ? "text-warning-ink" : "text-muted")}>
            {draftStatus === "failed" ? "Save failed" : draftStatus === "saving" ? "Saving…" : nonSecretDirty ? "Unsaved changes" : draftStatus === "saved" || gatewayId ? "Saved to this agency" : "Not saved yet"}
          </span>
          {draftStatus === "failed" && <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={retryDraft}>Retry save</Button>{onReload&&draftError?.includes("changed in another session")&&!hasUnsavedSecret&&<Button size="sm" variant="secondary" onClick={onReload}>Reload current settings</Button>}</div>}
        </div>}
        {setupState?.draft?.stale && <Notice tone="warning">Another administrator saved newer gateway settings after this draft was started. The current saved configuration is loaded; edit and save it to replace this older draft.</Notice>}
        {progressError && <p className="rounded-xl bg-warning-soft p-3 text-xs text-warning-ink" role="status">{progressError}</p>}
        {draftError && <p className="rounded-xl bg-danger-soft p-3 text-xs text-danger-ink" role="alert">{draftError}</p>}
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>Step {index + 1} of {flow.length}</span>
            <span className="sm:hidden">{flow[index].label}</span>
          </div>
          <ProgressBar value={((index + 1) / flow.length) * 100} label={`Step ${index + 1} of ${flow.length}`} />
          <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Connection steps">
            {flow.map((s, i) => (
              <li key={s.key} aria-current={i === index ? "step" : undefined} className={cn("flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 text-[10.5px] leading-tight transition-colors", i === index ? "border-primary/30 bg-primary-soft font-semibold text-primary-ink shadow-soft" : i < index ? "border-success/20 bg-success-soft/50 text-success-ink" : "border-line bg-surface-2/50 text-muted")}>
                <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold",i===index?"bg-primary text-white":i<index?"bg-success text-white":"bg-surface-3 text-muted")} aria-hidden>{i<index?<CheckCircle2 className="size-3"/>:i+1}</span><span><span className="sr-only">{i < index ? "Completed: " : i === index ? "Current: " : "Upcoming: "}</span>{s.label}</span>
              </li>
            ))}
          </ol>
        </div>
        <h2 ref={heading} tabIndex={-1} className="border-t border-line pt-5 text-[20px] font-semibold tracking-tight text-ink outline-none">{flow[index].label}</h2>
        {error && <p className="rounded-xl bg-danger-soft p-3 text-xs leading-relaxed text-danger-ink" role="alert">{error}</p>}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} initial={reduce ? false : { opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={reduce ? undefined : { opacity: 0, x: -10 }} transition={{ duration: 0.16 }}>
            {Body()}
          </motion.div>
        </AnimatePresence>
      </div>
    </Dialog>
    <Dialog
      open={closeWarningOpen}
      onOpenChange={setCloseWarningOpen}
      title="Close this setup?"
      description={hasUnsavedSecret ? "Cloudflare values entered on this screen have not been saved. Closing clears them; they are not kept in the draft." : "Some integration settings have not been saved yet. Closing this wizard will discard those edits."}
      icon={<AlertTriangle />}
      size="sm"
      footer={<><Button variant="secondary" onClick={() => setCloseWarningOpen(false)}>Return to setup</Button><Button variant="danger" onClick={discardAndClose}>Close without saving</Button></>}
    >
      <p className="text-xs leading-relaxed text-muted">Saved gateway drafts remain available to agency administrators. Unsaved credentials and other unsaved edits will be cleared.</p>
    </Dialog>
    </>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "Not set";
  }
}
