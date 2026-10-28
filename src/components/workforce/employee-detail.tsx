"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  CircleCheck,
  ClipboardCheck,
  FileText,
  History,
  Info,
  LayoutDashboard,
  Lock,
  MessageSquare,
  Radar,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  XCircle,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Select, Textarea } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlays";
import { InfoChip } from "@/components/ui/status";
import { GuidedChoiceField, GuidedField, GuidedSwitch, ChangeDecisionNotice, type FieldIssue } from "@/components/ui/guided-field";
import { ConfigVersionHistory, type ConfigVersion } from "@/components/workforce/config-version-history";
import { applyChangeAction, previewConfigAction, proposeChangeAction, regenerateEmployeeSettingsAction, saveAgentSettingsAction } from "@/app/actions/workforce";
import { LANGUAGES, LENGTH_COPY, TONE_COPY, TONES, type AgentSettings, type Tone } from "@/lib/agent-settings";
import { EMPLOYEE_GENERATED_FIELDS, mergeGeneratedEmployeeFields, type EmployeeGeneratedFields } from "@/lib/employee-generated-fields";
import { changeFixForReason, configFieldElementId, employeeFieldGuidance, ROLE_TOOL_GUIDANCE, TOOL_BOUNDARY_NOTE } from "@/lib/employee-field-guidance";
import type { ReviewReasonView } from "@/lib/config-review";
import type { ConfigPreviewSummary } from "@/lib/workforce-types";
import { canChat, type AgentRoleMeta, type AgentStatus } from "@/lib/agents";
import { agentToolLabel } from "@/lib/agent-tools";
import { cn, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
import { operationsManagerRuntimeNotice } from "@/lib/operations-manager-runtime";
import { auditRoleConfiguration, recommendedSettings } from "@/lib/role-playbooks";
import { deriveEmployeeReadiness, type ReadinessExtras } from "@/lib/workforce-readiness";
import { capabilityChecksFor, type CapabilityActivity } from "@/lib/employee-capability-status";
import { CapabilityChecklist } from "@/components/workforce/capability-checklist";
import { EmployeeProfileHero, ReadinessChecklist } from "@/components/workforce/employee-summary";
import { OperatingModeCard, type AgentMode } from "@/components/workforce/operating-controls";
import { ConfigTestDialog } from "@/components/workforce/config-test-dialog";
import { EmployeeInstructions } from "@/components/workforce/employee-instructions";
import { EmployeeKnowledge } from "@/components/workforce/employee-knowledge";
import type { EmployeeInstructionOverview } from "@/server/workforce/instructions";
import type { EmployeeKnowledgeView } from "@/server/workforce/knowledge";
import type { MonitoringStatus, ProactiveReportView } from "@/server/workforce/reports";
import { PROACTIVE_SEVERITY_LABELS, proactiveDutyForRole } from "@/lib/proactive";

type Version = ConfigVersion;

interface Props {
  meta: AgentRoleMeta;
  agent: {
    id: string;
    displayName: string;
    enabled: boolean;
    status: AgentStatus;
    lastHealthCheckAt: string | null;
    lastHealthOk: boolean | null;
    lastHealthDetail: string | null;
    summary: string | null;
    configVersion: number | null;
    configAppliedAt: string | null;
    defaultTools: string[];
    mode: AgentMode;
    providerRuntime: string;
    assignedOrganization: string;
    lastActivityAt: string | null;
    inventoryContract: string | null;
    inventoryDigest: string | null;
    inventoryVerifiedAt: string | null;
    inventoryExpiresAt: string | null;
    inventoryToolCount: number | null;
    credentialReady: boolean;
    taskExecuting: boolean;
    readinessExtras?: ReadinessExtras;
    /** Recorded evidence of what the employee has actually done, for the "what it can do right now" list. */
    capabilityActivity?: CapabilityActivity | null;
  };
  canPause: boolean;
  canGoAutonomous: boolean;
  autonomousBlockedReason: string | null;
  agencyPaused: boolean;
  settings: AgentSettings | null;
  /** Company profile facts used by the role configuration audit. Never invented by the employee. */
  companyContext: { description: string; services: string; idealCustomers: string; operatingArea: string; industry: string };
  /** Version number when the Configure screen is editing a saved but unapplied version. */
  draftVersion: number | null;
  /** Storage status of the version being edited: pending_agency_review, rejected or draft. */
  draftStatus: string | null;
  isInternalWorkspace: boolean;
  versions: Version[];
  canConfigure: boolean;
  canChat: boolean;
  canViewKnowledge: boolean;
  canEditKnowledge: boolean;
  acknowledgementCurrent: boolean | null;
  identityCurrent: boolean | null;
  isAgencyEmployee: boolean;
  /** Whether the client's setup payment is confirmed; absent for an internal employee, where it does not apply. */
  paymentCleared?: boolean;
  adminManageHref: string | null;
  initialTab: string;
  timeZone: string;
  /** The server's instant, so relative timestamps hydrate deterministically and then tick. */
  now: number;
  capabilities: string[];
  description: string;
  knowledgeAppliedAt: string | null;
  runs: Array<{ id: string; purpose: string; status: string; started_at: string; finished_at: string | null; total_tokens: number | null; tools: number; error_message: string | null }>;
  pendingApprovals: number;
  instructionOverview: EmployeeInstructionOverview | null;
  knowledgeView: EmployeeKnowledgeView | null;
  uploadAccept: string;
  /** Verified proactive reports for this employee's role. Empty unless the viewer has activity.view. */
  proactiveReports: ProactiveReportView[];
  /** Real monitoring state; null means the server could not read it and the UI must not imply coverage. */
  proactiveMonitoring: MonitoringStatus | null;
}

export function EmployeeDetail(props: Props) {
  const { meta, agent } = props;
  const router = useRouter();
  const reduced = useReducedMotion();
  const [tab, setTab] = React.useState(props.initialTab);
  const hasPendingReview = props.versions.some((v) => v.status === "pending_agency_review");
  const readiness = deriveEmployeeReadiness({
    displayName: agent.displayName,
    enabled: agent.enabled,
    status: agent.status,
    configVersion: agent.configVersion,
    hasPendingReview,
    lastHealthCheckAt: agent.lastHealthCheckAt,
    lastHealthOk: agent.lastHealthOk,
    lastHealthDetail: agent.lastHealthDetail,
    inventoryContract: agent.inventoryContract,
    inventoryDigest: agent.inventoryDigest,
    inventoryVerifiedAt: agent.inventoryVerifiedAt,
    inventoryExpiresAt: agent.inventoryExpiresAt,
    inventoryToolCount: agent.inventoryToolCount,
    credentialCurrent: agent.credentialReady,
    identityCurrent: props.identityCurrent,
    acknowledgementCurrent: props.acknowledgementCurrent,
    isAgencyEmployee: props.isAgencyEmployee,
    taskExecuting: agent.taskExecuting,
    extras: agent.readinessExtras,
    evaluatedAt: props.now,
    paymentCleared: props.paymentCleared,
  });
  const goConfigure = () => setTab("configure");
  const showRequirements = () => {
    setTab("overview");
    window.setTimeout(() => document.getElementById("employee-readiness")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" }), 60);
  };
  const primary =
    !agent.enabled ? (
      props.adminManageHref ? <ButtonLink href={props.adminManageHref} variant="secondary">Open admin controls</ButtonLink> : null
    ) : readiness.cta === "chat" && props.canChat ? (
      <ButtonLink href={`/chat/${meta.slug}`} variant="brand"><MessageSquare className="size-4" /> Start a chat</ButtonLink>
    ) : readiness.cta === "history" ? (
      <Button variant="brand" onClick={() => setTab("history")}><History className="size-4" /> Review status</Button>
    ) : readiness.cta === "connection" && props.adminManageHref ? (
      <ButtonLink href={props.adminManageHref} variant="brand"><SlidersHorizontal className="size-4" /> Open connection controls</ButtonLink>
    ) : props.canConfigure ? (
      <Button variant="brand" onClick={goConfigure}><Settings2 className="size-4" /> {readiness.stage === "setup" ? "Complete setup" : "Review configuration"}</Button>
    ) : null;

  const secondary =
    readiness.cta === "chat" && props.canConfigure ? (
      <Button variant="secondary" onClick={goConfigure}><Settings2 className="size-4" /> Manage employee</Button>
    ) : (
      <Button variant="secondary" onClick={showRequirements}><ClipboardCheck className="size-4" /> View setup requirements</Button>
    );

  return (
    <div className="space-y-6">
      <Link href="/employees" className="inline-flex items-center gap-1.5 text-[14px] text-muted transition hover:text-ink">
        <ArrowLeft className="size-3.5" /> AI Employees
      </Link>

      <EmployeeProfileHero
        meta={meta}
        displayName={agent.displayName}
        description={props.description}
        readiness={readiness}
        target="workforce.employee.hero"
        eyebrow={props.isAgencyEmployee ? "iAcquire internal employee" : "Your AI employee"}
        actions={<>{primary}{secondary}{props.adminManageHref && primary && readiness.cta !== "connection" ? <ButtonLink href={props.adminManageHref} variant="ghost">Admin controls <ArrowUpRight className="size-3.5" /></ButtonLink> : null}</>}
        footer={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <InfoChip icon={<Sparkles />}>{agent.configVersion ? `Configuration v${agent.configVersion}` : "Not configured"}</InfoChip>
            <InfoChip icon={<ShieldCheck />}>{agent.inventoryDigest ? `${agent.inventoryToolCount ?? 0} tools${readiness.inventoryAttestationCurrent ? " · attested" : readiness.chatAvailable ? " · refresh before chat" : " · verification needed"}` : "Inventory not recorded"}</InfoChip>
            <InfoChip icon={<History />}><span suppressHydrationWarning>{agent.lastHealthCheckAt ? `Checked ${relativeTime(agent.lastHealthCheckAt)}` : "Never checked"}</span></InfoChip>
            <span className="text-[12px] text-muted">{agent.assignedOrganization}</span>
          </div>
        }
      />

      <Tabs id="employee-tabs" value={tab} onValueChange={setTab} items={[
        { value: "overview", label: <span className="flex items-center gap-1.5"><LayoutDashboard className="size-3.5" /> Overview</span> },
        ...(props.canConfigure ? [
          { value: "configure", label: <span className="flex items-center gap-1.5"><Settings2 className="size-3.5" /> Configure</span> },
          { value: "change", label: <span className="flex items-center gap-1.5"><Wand2 className="size-3.5" /> Request a change</span> },
          ...(props.instructionOverview ? [{ value: "instructions", label: <span className="flex items-center gap-1.5"><FileText className="size-3.5" /> Instructions &amp; SOUL</span> }] : []),
        ] : []),
        ...(props.canViewKnowledge && props.knowledgeView ? [{ value: "knowledge", label: <span className="flex items-center gap-1.5"><BookOpen className="size-3.5" /> Knowledge</span> }] : []),
        ...(props.canConfigure ? [{ value: "history", label: <span className="flex items-center gap-1.5"><History className="size-3.5" /> Version history</span>, count: props.versions.length || undefined }] : []),
        { value: "activity", label: <span className="flex items-center gap-1.5"><Activity className="size-3.5" /> Activity</span> },
      ]}>
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: reduced ? 0 : 0.2 }}>
            {tab === "overview" && (
              <OverviewTab {...props} readiness={readiness} onConfigure={goConfigure} />
            )}
            {tab === "configure" && props.settings && (
              <ConfigureTab {...props} settings={props.settings} hasPendingReview={hasPendingReview} onSaved={() => setTab("overview")} onOpenHistory={() => setTab("history")} />
            )}
            {tab === "change" && <ChangeTab {...props} onApplied={() => setTab("history")} />}
            {tab === "instructions" && props.instructionOverview && (
              <EmployeeInstructions overview={props.instructionOverview} agentName={agent.displayName} role={meta.key} timeZone={props.timeZone} onOpenKnowledge={() => setTab("knowledge")} />
            )}
            {tab === "knowledge" && props.knowledgeView && (
              <EmployeeKnowledge agentId={agent.id} agentName={agent.displayName} data={props.knowledgeView} canEdit={props.canEditKnowledge} accept={props.uploadAccept} timeZone={props.timeZone} />
            )}
            {tab === "history" && <HistoryTab {...props} onEdit={(versionId) => router.push(`/employees/${meta.slug}?tab=configure&version=${versionId}`)} />}
            {tab === "activity" && <ActivityTab {...props} />}
          </motion.div>
        </AnimatePresence>
      </Tabs>
    </div>
  );
}

function OverviewTab({ agent, capabilities, knowledgeAppliedAt, pendingApprovals, timeZone, meta, readiness, onConfigure, runs, canConfigure, adminManageHref, canPause, canGoAutonomous, autonomousBlockedReason, agencyPaused, isInternalWorkspace, now }: Props & { readiness: ReturnType<typeof deriveEmployeeReadiness>; onConfigure: () => void }) {
  const operationsNotice = operationsManagerRuntimeNotice(meta.key, isInternalWorkspace ? "agency" : "client");
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_365px]">
      <div className="space-y-6">
        <ReadinessChecklist readiness={readiness} action={canConfigure && readiness.cta !== "chat" ? <Button size="sm" variant="brand" onClick={onConfigure}>Continue setup <ArrowUpRight className="size-3.5" /></Button> : undefined} />
        <CapabilityChecklist
          audience={adminManageHref ? "admin" : "customer"}
          checks={capabilityChecksFor({ readiness, configVersion: agent.configVersion, enabled: agent.enabled, status: agent.status, mode: agent.mode, inventoryToolCount: agent.inventoryToolCount, activity: agent.capabilityActivity, now: new Date(now) })}
        />
        {agent.enabled && <OperatingModeCard agentId={agent.id} displayName={agent.displayName} mode={agent.mode} canPause={canPause} canGoAutonomous={canGoAutonomous} autonomousBlockedReason={autonomousBlockedReason} agencyPaused={agencyPaused} />}

        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>What {agent.displayName} handles</CardTitle>
              <CardDescription>Role-specific responsibilities and the boundaries that always apply.</CardDescription>
            </div>
            <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[12px] font-semibold uppercase tracking-[.12em] text-muted">{meta.shortName}</span>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="rounded-2xl border border-line bg-surface-2/60 p-4 text-[14px] leading-[1.75] text-ink-2">{agent.summary ?? `${meta.shortName} hasn't been configured yet. Use Configure to describe its responsibilities and goals.`}</p>
            {operationsNotice && <p role="status" className="rounded-xl border border-warning/30 bg-warning-soft/40 p-3 text-[12px] leading-relaxed text-warning-ink">{operationsNotice}</p>}
            <div>
              <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-[.12em] text-muted">{operationsNotice ? "Intended role capabilities" : "Capabilities"}</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {capabilities.map((c) => (
                  <li key={c} className="flex items-start gap-2 text-[14px] leading-relaxed text-ink-2">{operationsNotice ? <Info className="mt-0.5 size-4 shrink-0 text-muted" /> : <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />} {c}</li>
                ))}
              </ul>
            </div>
            <div className="border-t border-line pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] font-semibold uppercase tracking-[.12em] text-muted">{operationsNotice ? "Configured role guidance" : "Tool permissions"}</p>
                <span className="text-[12px] text-muted">{operationsNotice ? "Instruction-level entries" : "Granted by iAcquire"}</span>
              </div>
              <ul className="mt-2.5 grid gap-2 sm:grid-cols-2">
                {agent.defaultTools.map((t) => (
                  <li key={t} className="flex items-center gap-2 rounded-xl border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-ink-2"><Lock className="size-3.5 shrink-0 text-faint" /> {agentToolLabel(t)}</li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] leading-relaxed text-muted">{operationsNotice ? "These labels do not represent callable services in the current Hermes chat runtime." : "Tools can be switched off in Configure; nobody can add new tools from this screen."}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div><CardTitle>Connection &amp; identity</CardTitle><CardDescription>Latest recorded facts, not inferred availability.</CardDescription></div>
          </CardHeader>
          <CardContent className="space-y-3 text-[13px]">
            <div className="flex items-center justify-between gap-3"><span className="text-muted">Lifecycle</span><span className="font-medium text-ink">{sentenceCase(agent.status)}</span></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted">Provider runtime</span><span className="text-right font-medium text-ink">{agent.providerRuntime}</span></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted">Approved inventory</span><span className="text-right font-medium text-ink">{agent.inventoryDigest ? `${agent.inventoryToolCount ?? 0} tools · ${agent.inventoryDigest.slice(0, 10)}…` : "Not recorded"}</span></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted">Last checked</span><span className="text-right font-medium text-ink">{agent.lastHealthCheckAt ? formatDateTime(agent.lastHealthCheckAt, timeZone) : "Never"}</span></div>
            {agent.lastHealthDetail && <p className="rounded-xl border border-line bg-surface-2/60 p-3 text-[12px] leading-relaxed text-muted">{agent.lastHealthDetail}</p>}
            {adminManageHref && <ButtonLink href={adminManageHref} variant="secondary" size="sm" className="w-full">Open connection controls <ArrowUpRight className="size-3.5" /></ButtonLink>}
          </CardContent>
        </Card>

        {runs.length > 0 && (
          <Card>
            <CardHeader>
              <div><CardTitle>Latest activity</CardTitle><CardDescription>The most recent saved runs. Open Activity for the full record.</CardDescription></div>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-line">
                {runs.slice(0, 3).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-[13px]">
                    <span className="min-w-0 flex-1 text-ink-2">{formatDateTime(r.started_at, timeZone)}</span>
                    <Badge tone={r.status === "completed" ? "success" : r.status === "running" ? "primary" : r.status === "cancelled" ? "neutral" : "danger"}>{sentenceCase(r.status)}</Badge>
                    <span className="text-muted">{r.total_tokens ?? "—"} tokens</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader><div><CardTitle>Safeguards</CardTitle><CardDescription>These boundaries cannot be changed by instructions.</CardDescription></div></CardHeader>
          <CardContent className="space-y-2.5 text-[14px] text-ink-2">
            {["Customer-facing actions wait for your approval", "Never invents bookings, prices or results", "Only works with your company's data", "Cannot grant itself new tools or access"].map((s) => (
              <p key={s} className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /> {s}</p>
            ))}
            <div className="mt-3 rounded-xl bg-surface-2 p-3 text-[13px] text-muted">
              Pending approvals: <span className="font-semibold text-ink">{pendingApprovals}</span> · <Link href="/approvals" className="font-medium text-primary-ink underline underline-offset-2 hover:no-underline">Approval Center</Link>
              <br /> Knowledge last applied: <span suppressHydrationWarning>{knowledgeAppliedAt ? relativeTime(knowledgeAppliedAt) : "not yet"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ConfigSection({ id, step, title, description, children }: { id: string; step: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28">
      <Card className="overflow-hidden">
        <CardHeader className="gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-semibold text-primary-ink ring-1 ring-inset ring-primary/15">{step}</span>
            <div className="min-w-0"><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">{children}</CardContent>
      </Card>
    </section>
  );
}

type PreviewCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ready"; summary: ConfigPreviewSummary }
  | { state: "error"; error: string };

type SubmitResult =
  | { kind: "applied"; version: number }
  | { kind: "review"; version: number; reasons: ReviewReasonView[] }
  | { kind: "blocked"; reasons: ReviewReasonView[]; message?: string }
  | { kind: "error"; message: string };

function issueForReason(reason: ReviewReasonView): FieldIssue {
  return {
    tone: reason.severity === "block" ? "danger" : "warning",
    title: reason.severity === "block" ? "Change not allowed" : "Review required",
    detail: reason.detail,
    fix: changeFixForReason(reason.code, reason.field),
  };
}

export function ConfigureTab({ meta, agent, settings, companyContext, draftVersion, draftStatus, hasPendingReview, onSaved, onOpenHistory, isInternalWorkspace }: Props & { settings: AgentSettings; hasPendingReview: boolean; onSaved: () => void; onOpenHistory: () => void }) {
  const operationsNotice = operationsManagerRuntimeNotice(meta.key, isInternalWorkspace ? "agency" : "client");
  const router = useRouter();
  const [s, setS] = React.useState<AgentSettings>(settings);
  const [justSaved, setJustSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [check, setCheck] = React.useState<PreviewCheck>({ state: "idle" });
  const [result, setResult] = React.useState<SubmitResult | null>(null);
  const [nameTouched, setNameTouched] = React.useState(false);
  const [saveAttempted, setSaveAttempted] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [employeeSuggestion, setEmployeeSuggestion] = React.useState<EmployeeGeneratedFields & { source: "ai" | "safe_defaults"; fallbackFields: string[] } | null>(null);
  const statusRef = React.useRef<HTMLDivElement>(null);
  const previewSequence = React.useRef(0);
  const set = <K extends keyof AgentSettings>(k: K, v: AgentSettings[K]) => {
    setS((p) => ({ ...p, [k]: v }));
    setJustSaved(false);
    setResult(null);
    setCheck({ state: "checking" });
  };
  const dirty = !justSaved && JSON.stringify(s) !== JSON.stringify(settings);
  const nameError = s.displayName.trim().length === 0 ? "Enter a name for this employee." : null;
  const showNameError = Boolean(nameError) && (nameTouched || saveAttempted);
  const configAudit = React.useMemo(
    () => auditRoleConfiguration(meta.key, s, companyContext ?? { description: "", services: "", idealCustomers: "", operatingArea: "", industry: "" }),
    [s, meta.key, companyContext],
  );
  const preparingFirstInternalConfig = isInternalWorkspace && agent.configVersion === null && draftVersion === null;
  const fillRecommended = () => {
    const recommended = recommendedSettings(meta.key);
    const next: AgentSettings = { ...s };
    const textFields: Array<keyof Pick<AgentSettings,
      "responsibilities" | "goals" | "neverPromise" | "escalateWhen" | "customInstruction" |
      "personality" | "characterTraits" | "communicationStyle" | "responseBehavior" |
      "operatingProcedures" | "proactiveResponsibilities" | "reportingBehavior"
    >> = [
      "responsibilities", "goals", "neverPromise", "escalateWhen", "customInstruction",
      "personality", "characterTraits", "communicationStyle", "responseBehavior",
      "operatingProcedures", "proactiveResponsibilities", "reportingBehavior",
    ];
    for (const field of textFields) {
      if (!next[field].trim()) next[field] = recommended[field];
    }
    if (preparingFirstInternalConfig) {
      next.tone = recommended.tone;
      next.replyLength = recommended.replyLength;
      next.language = recommended.language;
      if (!next.companyRules.trim()) {
        next.companyRules = "Use the approved company profile and internal knowledge as sources for business facts. If a fact is missing or unclear, say so and ask a person; do not infer it.";
      }
    }
    const mergedAnswers = { ...recommended.roleAnswers, ...s.roleAnswers };
    for (const [key, value] of Object.entries(mergedAnswers)) {
      if (typeof value === "string" && !value.trim()) mergedAnswers[key] = recommended.roleAnswers[key] ?? value;
    }
    next.roleAnswers = mergedAnswers;
    setS(next);
    setJustSaved(false);
    setResult(null);
    setCheck({ state: "checking" });
    toast.success("Recommended role fields added", {
      description: preparingFirstInternalConfig
        ? "Role-specific style and safe operating defaults are ready in this first internal draft. Review them before saving; unknown business details stay unfilled."
        : "Only blank fields were filled. Company-specific facts are left for you to provide, then save to apply.",
    });
  };
  const regenerateEmployeeSettings = async () => {
    if (regenerating) return;
    setRegenerating(true);
    const result = await regenerateEmployeeSettingsAction(meta.key);
    setRegenerating(false);
    if (!result.ok) return void toast.error(result.error);
    setEmployeeSuggestion(result.data);
  };
  const acceptEmployeeSettings = () => {
    if (!employeeSuggestion) return;
    const merged = mergeGeneratedEmployeeFields(
      s,
      employeeSuggestion,
      preparingFirstInternalConfig ? recommendedSettings(meta.key) : undefined,
    );
    if (merged.applied.length === 0) {
      toast.info("Your current fields were preserved", { description: "There are no blank fields or untouched role defaults to replace." });
      return;
    }
    setS(merged.settings);
    setEmployeeSuggestion(null);
    setJustSaved(false);
    setCheck({ state: "checking" });
    toast.success("Suggestions added to your draft", {
      description: `${merged.applied.length} fields updated; ${merged.preserved.length} existing values preserved. Review the draft, then save to create a new version.`,
    });
  };

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The preview is a no-write, permission-scoped server check that uses the same classifier as the
  // save path. If it fails, the form falls back to the server's final decision on submit.
  React.useEffect(() => {
    if (!dirty || nameError) return;
    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    const timer = window.setTimeout(() => {
      void previewConfigAction(meta.key, s).then((res) => {
        if (previewSequence.current !== sequence) return;
        setCheck(res.ok ? { state: "ready", summary: res.data } : { state: "error", error: res.error });
      });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [s, dirty, nameError, meta.key]);

  const activeCheck = React.useMemo<PreviewCheck>(() => (dirty && !nameError ? check : { state: "idle" }), [dirty, nameError, check]);
  const reasons = React.useMemo(() => (activeCheck.state === "ready" ? activeCheck.summary.reasons ?? [] : []), [activeCheck]);
  // One plain-English reason per affected field: a blocked reason wins over a review reason for the
  // same field, so a single sentence is not repeated as both "not allowed" and "review required".
  const primaryReasons = React.useMemo(() => {
    const groups = new Map<string, ReviewReasonView[]>();
    for (const reason of reasons) {
      const key = reason.field || `code:${reason.code}`;
      const list = groups.get(key) ?? [];
      list.push(reason);
      groups.set(key, list);
    }
    return [...groups.values()].map((list) => list.find((reason) => reason.severity === "block") ?? list[0]);
  }, [reasons]);
  const issuesByField = React.useMemo(() => {
    const map = new Map<string, FieldIssue[]>();
    for (const reason of primaryReasons) {
      if (!reason.field) continue;
      const list = map.get(reason.field) ?? [];
      list.push(issueForReason(reason));
      map.set(reason.field, list);
    }
    return map;
  }, [primaryReasons]);
  const issuesFor = (field: string) => issuesByField.get(field) ?? [];
  const decision = activeCheck.state === "ready" ? activeCheck.summary.decision : null;
  const blockedReasons = result?.kind === "blocked" ? result.reasons : activeCheck.state === "ready" && decision === "blocked" ? primaryReasons.filter((reason) => reason.severity === "block") : [];
  const reviewReasons = result?.kind === "review" ? result.reasons : activeCheck.state === "ready" && decision === "review_required" ? primaryReasons.filter((reason) => reason.severity === "review") : [];
  const pending = result?.kind === "review";
  const displayedConfigVersion = result?.kind === "applied" || result?.kind === "review" ? result.version : agent.configVersion;
  const saveLabel = pending ? "Saved for review" : decision === "blocked" ? "Change not allowed" : decision === "review_required" ? "Submit for review" : decision === "auto_apply" ? "Save & apply" : "Save changes";
  const saveDisabled = saving || !dirty || Boolean(nameError) || decision === "blocked";

  const save = async () => {
    setSaveAttempted(true);
    if (saving || !dirty) return;
    if (nameError) {
      document.getElementById("cfg-name")?.focus();
      return;
    }
    if (decision === "blocked") {
      const first = primaryReasons.find((reason) => reason.severity === "block" && reason.field);
      const id = first ? configFieldElementId(first.field) : null;
      if (id) document.getElementById(id)?.focus();
      statusRef.current?.focus();
      return;
    }
    setSaving(true);
    setResult(null);
    const res = await saveAgentSettingsAction(meta.key, s);
    setSaving(false);
    if (!res.ok) {
      const blocked = res.code === "forbidden";
      setResult({ kind: blocked ? "blocked" : "error", reasons: [], message: res.error });
      toast.error(blocked ? "This change can't be saved because it conflicts with platform security rules." : res.error);
      window.requestAnimationFrame(() => statusRef.current?.focus());
      return;
    }
    setJustSaved(true);
    setCheck({ state: "idle" });
    if (res.data.status === "pending_agency_review") {
      setResult({ kind: "review", version: res.data.version, reasons: res.data.reasons ?? [] });
      toast.warning("Submitted for review", { description: "Your current configuration remains active until an authorized reviewer approves it." });
    } else {
      setResult({ kind: "applied", version: res.data.version });
      toast.success("Changes saved and applied successfully", { description: `Configuration v${res.data.version} is now active.` });
    }
    router.refresh();
    window.requestAnimationFrame(() => statusRef.current?.focus());
  };

  const fieldIssues = (field: string) => issuesFor(field);

  return (
    <div className="space-y-5 pb-36 xl:pb-0" data-aqi-target="workforce.employee.configure">
      <div ref={statusRef} tabIndex={-1} className="space-y-3 outline-none">
        {result?.kind === "applied" && (
          <ChangeDecisionNotice
            tone="success"
            title="Changes saved and applied successfully"
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={onOpenHistory}>View version history</Button>
                <Button size="sm" variant="ghost" onClick={onSaved}>Back to overview</Button>
              </div>
            }
          >
            <p>Configuration v{result.version} is now active. New conversations use it right away.</p>
          </ChangeDecisionNotice>
        )}
        {result?.kind === "review" && (
          <ChangeDecisionNotice
            tone="warning"
            title={`Submitted for review — configuration v${result.version}`}
            action={<Button size="sm" variant="secondary" onClick={onOpenHistory}>View version history</Button>}
          >
            <p>Your changes were saved and submitted for review. Your current configuration remains active until an authorized reviewer approves them.</p>
            {result.reasons.length > 0 && <ReasonList reasons={result.reasons} />}
          </ChangeDecisionNotice>
        )}
        {result?.kind === "blocked" && (
          <ChangeDecisionNotice tone="danger" title="This change can't be saved">
            <p>This change can&apos;t be saved because it conflicts with platform security rules. Your edits are still here; remove or change the flagged content and try again.</p>
            {result.reasons.length > 0 && <ReasonList reasons={result.reasons} />}
            {result.message && !result.reasons.length && <p>{result.message}</p>}
          </ChangeDecisionNotice>
        )}
        {result?.kind === "error" && (
          <ChangeDecisionNotice tone="danger" title="The configuration couldn't be saved">
            <p>{result.message}</p>
            <p>Your edits are still here. Check the highlighted fields and try again.</p>
          </ChangeDecisionNotice>
        )}

        {draftVersion !== null && !result && (
          <ChangeDecisionNotice
            tone={draftStatus === "rejected" ? "danger" : "warning"}
            title={
              draftStatus === "rejected"
                ? `Revising configuration v${draftVersion}, which was not approved`
                : draftStatus === "draft"
                  ? `Editing saved draft v${draftVersion}`
                  : `Editing unapplied configuration v${draftVersion}`
            }
          >
            <p>
              {draftStatus === "rejected"
                ? "This version was reviewed and not applied. Saving creates a new version. Routine changes may apply immediately; sensitive changes still need review."
                : "This version has been saved but is not active. Saving creates a new version. Your current live configuration stays in place until a reviewer approves the change."}
            </p>
          </ChangeDecisionNotice>
        )}

        {!result && activeCheck.state === "ready" && decision === "blocked" && (
          <ChangeDecisionNotice tone="danger" title="Change not allowed">
            <p>This change can&apos;t be saved because it conflicts with platform security rules. Your edits are still here.</p>
            <ReasonList reasons={blockedReasons} />
            <p>Remove or change the flagged content, then check the draft again. A blocked change cannot be approved as it stands.</p>
          </ChangeDecisionNotice>
        )}

        {!result && activeCheck.state === "ready" && decision === "review_required" && (
          <ChangeDecisionNotice tone="warning" title="Some changes require review">
            <p>
              Some of these changes will need review. None of the changes in this submission will become active until an authorized reviewer
              approves it. Your current configuration remains active, and you can keep editing before you submit.
            </p>
            <ReasonList reasons={reviewReasons} />
          </ChangeDecisionNotice>
        )}

        {!result && activeCheck.state === "error" && (
          <ChangeDecisionNotice tone="info" title="We couldn't pre-check this change">
            <p>
              The change check is temporarily unavailable, so the server will make the final decision when you save. Your current configuration
              stays active unless the save applies immediately.
            </p>
          </ChangeDecisionNotice>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <nav aria-label="Configuration sections" className="flex flex-wrap gap-1.5 rounded-2xl border border-line bg-surface-2/60 p-2">
            {[
              ["config-identity", "Identity"],
              ["config-role", "Role"],
              ["config-rules", "Rules"],
              ["config-instructions", "Instructions"],
              ["config-tools", "Tools"],
            ].map(([href, label]) => (
              <a key={href} href={`#${href}`} className="inline-flex min-h-9 items-center rounded-xl px-3 text-[12px] font-medium text-muted transition hover:bg-surface hover:text-ink">{label}</a>
            ))}
          </nav>

          <ConfigSection id="config-identity" step="01" title="Identity & communication" description={`How ${agent.displayName} introduces itself and sounds in conversation.`}>
            <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-lg text-[12px] leading-relaxed text-muted">Generate role suggestions from this workspace&apos;s confirmed company information. Nothing is saved until you accept the preview; existing non-default values are preserved.</p>
                <Button type="button" size="sm" variant="secondary" disabled={regenerating} onClick={() => void regenerateEmployeeSettings()}><Wand2 className="size-3.5" /> {regenerating ? "Generating…" : preparingFirstInternalConfig ? "Generate employee setup" : "Regenerate employee setup"}</Button>
              </div>
              {employeeSuggestion && <div className="mt-3 space-y-2 border-t border-line pt-3 text-[12px] text-ink-2">
                <p className="font-semibold">Suggested employee setup {employeeSuggestion.source === "safe_defaults" ? "· safe role defaults" : "· AI draft"}</p>
                {EMPLOYEE_GENERATED_FIELDS.map(([key, label]) => <p key={key}><strong>{label}:</strong> {employeeSuggestion[key]}</p>)}
                {employeeSuggestion.fallbackFields.length > 0 && <p className="text-warning-ink">Safe role defaults were used for: {employeeSuggestion.fallbackFields.map((field) => EMPLOYEE_GENERATED_FIELDS.find(([key]) => key === field)?.[1] ?? field).join(", ")}.</p>}
                <div className="flex gap-2 pt-1"><Button type="button" size="sm" variant="brand" onClick={acceptEmployeeSettings}>Fill blank and default fields</Button><Button type="button" size="sm" variant="ghost" onClick={() => setEmployeeSuggestion(null)}>Dismiss</Button></div>
              </div>}
            </div>
            <GuidedField
              id="cfg-name"
              label="Employee name"
              guidance={employeeFieldGuidance(meta.key, "displayName")}
              required
              error={showNameError ? nameError : null}
              issues={fieldIssues("displayName")}
              charLimit={40}
              valueLength={s.displayName.length}
            >
              <Input value={s.displayName} maxLength={40} onBlur={() => setNameTouched(true)} onChange={(e) => set("displayName", e.target.value)} />
            </GuidedField>
            <p className="-mt-3 text-[12px] leading-relaxed text-muted">Your employee&apos;s role is shown alongside this name throughout the workspace.</p>

            <GuidedChoiceField id="cfg-tone" label="Personality" guidance={employeeFieldGuidance(meta.key, "tone")} optional issues={fieldIssues("tone")}>
              <div role="radiogroup" aria-label="Personality" className="grid gap-2 sm:grid-cols-2">
                {TONES.map((t: Tone) => {
                  const selected = s.tone === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => set("tone", t)}
                      className={cn(
                        "rounded-2xl border p-3.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                        selected ? "border-primary bg-primary-soft/50 ring-2 ring-primary/15" : "border-line bg-surface hover:border-line-strong",
                      )}
                    >
                      <span className="flex items-center justify-between text-[14px] font-semibold text-ink">
                        {TONE_COPY[t].label}
                        {selected && <Check className="size-4 text-primary" aria-hidden />}
                      </span>
                      <span className="mt-1 block text-[12px] leading-relaxed text-muted">{TONE_COPY[t].description}</span>
                      <span className="mt-1.5 block text-[12px] italic leading-relaxed text-faint">“{TONE_COPY[t].example}”</span>
                    </button>
                  );
                })}
              </div>
            </GuidedChoiceField>

            <div className="grid gap-5 sm:grid-cols-2">
              <GuidedField id="cfg-personality" label="Personality" guidance={{ description: "The employee's distinct professional character." }} optional issues={fieldIssues("personality")} charLimit={500} valueLength={s.personality.length}>
                <Textarea rows={3} maxLength={500} value={s.personality} onChange={(e) => set("personality", e.target.value)} />
              </GuidedField>
              <GuidedField id="cfg-traits" label="Character traits" guidance={{ description: "Qualities the employee should show while working." }} optional issues={fieldIssues("characterTraits")} charLimit={400} valueLength={s.characterTraits.length}>
                <Textarea rows={3} maxLength={400} value={s.characterTraits} onChange={(e) => set("characterTraits", e.target.value)} />
              </GuidedField>
            </div>
            <GuidedField id="cfg-style" label="Communication style" guidance={{ description: "How this employee should explain its work." }} optional issues={fieldIssues("communicationStyle")} charLimit={500} valueLength={s.communicationStyle.length}>
              <Textarea rows={2} maxLength={500} value={s.communicationStyle} onChange={(e) => set("communicationStyle", e.target.value)} />
            </GuidedField>
            <GuidedField id="cfg-response" label="Response behavior" guidance={{ description: "How it should respond when facts are missing or a decision is needed." }} optional issues={fieldIssues("responseBehavior")} charLimit={700} valueLength={s.responseBehavior.length}>
              <Textarea rows={3} maxLength={700} value={s.responseBehavior} onChange={(e) => set("responseBehavior", e.target.value)} />
            </GuidedField>

            <div className="grid gap-5 sm:grid-cols-2">
              <GuidedChoiceField id="cfg-length" label="Reply length" guidance={employeeFieldGuidance(meta.key, "replyLength")} optional issues={fieldIssues("replyLength")}>
                <div role="radiogroup" aria-label="Reply length" className="grid gap-2">
                  {(["concise", "balanced", "detailed"] as const).map((v) => {
                    const selected = s.replyLength === v;
                    return (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => set("replyLength", v)}
                        className={cn(
                          "flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                          selected ? "border-primary bg-primary-soft/50 ring-2 ring-primary/15" : "border-line bg-surface hover:border-line-strong",
                        )}
                      >
                        <span>
                          <span className="block text-[13px] font-medium text-ink">{LENGTH_COPY[v].label}</span>
                          <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{LENGTH_COPY[v].description}</span>
                        </span>
                        {selected && <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
                      </button>
                    );
                  })}
                </div>
              </GuidedChoiceField>

              <GuidedField id="cfg-language" label="Language" guidance={employeeFieldGuidance(meta.key, "language")} optional issues={fieldIssues("language")}>
                <Select value={s.language} onChange={(e) => set("language", e.target.value as AgentSettings["language"])}>
                  {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
                </Select>
              </GuidedField>
            </div>
          </ConfigSection>

          <ConfigSection id="config-role" step="02" title="Role & responsibilities" description={`The work ${agent.displayName} should own. Short, specific answers work best; blank optional fields use safe defaults.`}>
            <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[14px] font-medium"><Sparkles className="size-3.5 text-primary" aria-hidden /> Role setup check</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">
                    {configAudit.employeeComplete}/{configAudit.employeeTotal} role fields and {configAudit.companyComplete}/{configAudit.companyTotal} company facts are filled.
                    Readiness proves this employee may run; this check shows whether its configuration contains enough specific information to do useful work.
                  </p>
                  {configAudit.missingCompanyFacts.length > 0 && (
                    <p className="mt-1.5 text-[12px] leading-relaxed text-warning-ink">
                      Still needed from your company profile: {configAudit.missingCompanyFacts.join(", ")}. The employee must not invent these.
                    </p>
                  )}
                </div>
                <Button type="button" size="sm" variant="secondary" onClick={fillRecommended}>
                  <Wand2 className="size-3.5" aria-hidden /> {preparingFirstInternalConfig ? "Prepare first config" : "Fill blank fields"}
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {configAudit.items.map((item) => (
                  <span
                    key={`${item.scope}:${item.key}`}
                    title={item.detail}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-medium",
                      item.state === "complete" ? "border-success/25 bg-success-soft text-success-ink" : "border-line-strong bg-surface text-muted",
                    )}
                  >
                    {item.state === "complete" ? <Check className="size-3" aria-hidden /> : <Info className="size-3" aria-hidden />}
                    {item.label}
                  </span>
                ))}
              </div>
            </div>
            {meta.questions.map((q) => (
              <GuidedField
                key={q.id}
                id={`cfg-q-${q.id}`}
                label={q.label}
                guidance={{ description: q.help ?? "Describe what this employee should do in this situation.", example: q.placeholder }}
                optional
                issues={fieldIssues(`roleAnswers.${q.id}`)}
                charLimit={1000}
                valueLength={(s.roleAnswers[q.id] ?? "").length}
              >
                <Textarea rows={3} maxLength={1000} value={s.roleAnswers[q.id] ?? ""} onChange={(e) => set("roleAnswers", { ...s.roleAnswers, [q.id]: e.target.value })} />
              </GuidedField>
            ))}
            <GuidedField id="cfg-resp" label="Main responsibilities" guidance={employeeFieldGuidance(meta.key, "responsibilities")} optional issues={fieldIssues("responsibilities")} charLimit={1000} valueLength={s.responsibilities.length}>
              <Textarea rows={3} maxLength={1000} value={s.responsibilities} onChange={(e) => set("responsibilities", e.target.value)} />
            </GuidedField>
            <GuidedField id="cfg-goals" label="Goals for this employee" guidance={employeeFieldGuidance(meta.key, "goals")} optional issues={fieldIssues("goals")} charLimit={1000} valueLength={s.goals.length}>
              <Textarea rows={3} maxLength={1000} value={s.goals} onChange={(e) => set("goals", e.target.value)} />
            </GuidedField>
            <GuidedField id="cfg-target" label="Target audience" guidance={employeeFieldGuidance(meta.key, "targetCustomers")} optional issues={fieldIssues("targetCustomers")} charLimit={1000} valueLength={s.targetCustomers.length}>
              <Textarea rows={3} maxLength={1000} value={s.targetCustomers} onChange={(e) => set("targetCustomers", e.target.value)} />
            </GuidedField>
            <GuidedField id="cfg-procedures" label="Operating procedures" guidance={{ description: "The steps this employee should follow within its existing permissions." }} optional issues={fieldIssues("operatingProcedures")} charLimit={1000} valueLength={s.operatingProcedures.length}>
              <Textarea rows={3} maxLength={1000} value={s.operatingProcedures} onChange={(e) => set("operatingProcedures", e.target.value)} />
            </GuidedField>
            <GuidedField id="cfg-proactive" label="Proactive responsibilities" guidance={{ description: "Work to surface when a real authorized schedule or trigger is active." }} optional issues={fieldIssues("proactiveResponsibilities")} charLimit={700} valueLength={s.proactiveResponsibilities.length}>
              <Textarea rows={3} maxLength={700} value={s.proactiveResponsibilities} onChange={(e) => set("proactiveResponsibilities", e.target.value)} />
            </GuidedField>
            <GuidedField id="cfg-reporting" label="Reporting behavior" guidance={{ description: "What evidence, uncertainty and next steps to include in reports." }} optional issues={fieldIssues("reportingBehavior")} charLimit={700} valueLength={s.reportingBehavior.length}>
              <Textarea rows={3} maxLength={700} value={s.reportingBehavior} onChange={(e) => set("reportingBehavior", e.target.value)} />
            </GuidedField>
          </ConfigSection>

          <ConfigSection id="config-rules" step="03" title="Behavior & business rules" description="Guardrails and escalation. These are combined with iAcquire's protected policy and cannot override it.">
            <GuidedField id="cfg-rules" label="Company rules" guidance={employeeFieldGuidance(meta.key, "companyRules")} optional issues={fieldIssues("companyRules")} charLimit={1500} valueLength={s.companyRules.length}>
              <Textarea rows={3} maxLength={1500} value={s.companyRules} onChange={(e) => set("companyRules", e.target.value)} />
            </GuidedField>
            <GuidedField id="cfg-never" label="Never promise" guidance={employeeFieldGuidance(meta.key, "neverPromise")} optional issues={fieldIssues("neverPromise")} charLimit={1000} valueLength={s.neverPromise.length}>
              <Textarea rows={3} maxLength={1000} value={s.neverPromise} onChange={(e) => set("neverPromise", e.target.value)} />
            </GuidedField>
            <div className="grid gap-5 sm:grid-cols-2">
              <GuidedField id="cfg-esc" label="When to ask a human" guidance={employeeFieldGuidance(meta.key, "escalateWhen")} optional issues={fieldIssues("escalateWhen")} charLimit={600} valueLength={s.escalateWhen.length}>
                <Textarea rows={2} maxLength={600} value={s.escalateWhen} onChange={(e) => set("escalateWhen", e.target.value)} />
              </GuidedField>
              <GuidedField id="cfg-esc-contact" label="Escalation contact" guidance={employeeFieldGuidance(meta.key, "escalationContact")} optional issues={fieldIssues("escalationContact")} charLimit={200} valueLength={s.escalationContact.length}>
                <Input maxLength={200} value={s.escalationContact} onChange={(e) => set("escalationContact", e.target.value)} />
              </GuidedField>
            </div>
            <div id="cfg-approval" tabIndex={-1} className="scroll-mt-28 rounded-2xl border border-line bg-surface-2/50 p-4 outline-none">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[14px] font-medium"><Lock className="size-3.5 text-faint" aria-hidden /> Required approval policy</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">Fixed by iAcquire policy. Customer-facing actions always need approval, and this setting cannot be changed here.</p>
                </div>
                <Badge tone="neutral">Fixed by iAcquire policy</Badge>
              </div>
              <p className="mt-2.5 border-t border-line pt-2.5 text-[12px] leading-relaxed text-faint">
                This preference is recorded for compatibility but is not currently read by the runtime approval gate. Your employee&apos;s
                operating mode and the platform&apos;s tool policy remain the enforced approval boundary. Editing the instructions cannot grant
                new permissions.
              </p>
            </div>
          </ConfigSection>

          <ConfigSection id="config-instructions" step="04" title="Additional instructions" description="One short, plain-English instruction specific to this employee.">
            <GuidedField id="cfg-custom" label="Employee-specific instruction" guidance={employeeFieldGuidance(meta.key, "customInstruction")} optional issues={fieldIssues("customInstruction")} charLimit={500} valueLength={s.customInstruction.length}>
              <Textarea rows={3} maxLength={500} value={s.customInstruction} onChange={(e) => set("customInstruction", e.target.value)} />
            </GuidedField>
          </ConfigSection>

          <ConfigSection id="config-tools" step="05" title={operationsNotice ? "Role capability guidance" : "Tool permissions"} description={operationsNotice ? "These switches change instructions only. When authorized and ready, the internal Operations Manager receives a read-only operations snapshot for each run, but no callable iAcquireOS tool. It cannot create approvals or save summaries." : "Only the tools granted to this role are listed. You can switch tools off, never add new ones."}>
            <div className="space-y-2">
              {agent.defaultTools.map((t) => {
                const on = !s.disabledTools.includes(t);
                const wasOff = settings.disabledTools.includes(t);
                const toolGuidance = ROLE_TOOL_GUIDANCE[t] ?? {
                  description: `${agentToolLabel(t)} is granted for this role by iAcquire.`,
                  off: "The employee will not be given this tool in its instructions.",
                };
                return (
                  <GuidedSwitch
                    key={t}
                    id={`cfg-tool-${t.replaceAll(".", "-")}`}
                    label={agentToolLabel(t)}
                    description={toolGuidance.description}
                    checked={on}
                    onCheckedChange={(next) => set("disabledTools", next ? s.disabledTools.filter((x) => x !== t) : [...s.disabledTools, t])}
                    issues={on && wasOff ? fieldIssues("disabledTools") : []}
                    offLabel={toolGuidance.off}
                    onLabel="Included in this employee's instructions."
                  />
                );
              })}
            </div>
            <p className="rounded-xl bg-surface-2 p-3 text-[12px] leading-relaxed text-muted"><Lock className="mr-1.5 inline size-3.5" /> {TOOL_BOUNDARY_NOTE}</p>
          </ConfigSection>
        </div>

        <aside className="order-first xl:order-last xl:sticky xl:top-24 xl:self-start">
          <Card className="overflow-hidden">
            <div className="border-b border-line bg-surface-2/60 p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[.15em] text-muted">Publishing</p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[14px] font-semibold text-ink">{hasPendingReview || pending ? "Awaiting review" : displayedConfigVersion ? `Configuration v${displayedConfigVersion}` : "New configuration"}</p>
                <span className={cn("size-2 rounded-full", dirty ? "bg-warning" : "bg-success")} aria-hidden />
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                {dirty ? "You have unsaved changes." : pending ? "Saved for review. Your current configuration is still active." : "All changes are saved."}
              </p>
            </div>
            <CardContent className="space-y-3">
              <div aria-live="polite" className="min-h-5 text-[12px] text-muted">
                {activeCheck.state === "checking" ? "Checking this change…" : activeCheck.state === "error" ? "The change check is unavailable. The server will decide when you save." : null}
              </div>

              {activeCheck.state === "ready" && decision === "auto_apply" && !result && (
                <div className="rounded-xl border border-success/25 bg-success-soft/40 p-3">
                  <p className="text-[12px] font-semibold text-success-ink">Ready to save</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-success-ink/90">Routine changes apply immediately after validation.</p>
                </div>
              )}
              {activeCheck.state === "ready" && decision === "review_required" && !result && (
                <div className="rounded-xl border border-warning/30 bg-warning-soft/40 p-3">
                  <p className="text-[12px] font-semibold text-warning-ink">Review required</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-warning-ink/90">Your current configuration stays active while a reviewer decides.</p>
                </div>
              )}
              {activeCheck.state === "ready" && decision === "blocked" && !result && (
                <div className="rounded-xl border border-danger/25 bg-danger-soft/40 p-3">
                  <p className="text-[12px] font-semibold text-danger-ink">Change not allowed</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-danger-ink/90">Fix the flagged fields before saving.</p>
                </div>
              )}

              <Button variant="brand" className="w-full" disabled={saveDisabled} loading={saving} onClick={save}>{saveLabel}</Button>
              <Button variant="secondary" className="w-full" onClick={() => setTesting(true)}><Sparkles className="size-4" /> Test this draft</Button>
              <Button variant="ghost" className="w-full" disabled={!dirty || saving} onClick={() => { setS(settings); setJustSaved(true); setResult(null); setCheck({ state: "idle" }); }}>Discard changes</Button>
              <Button variant="ghost" className="w-full justify-start" onClick={onOpenHistory}><History className="size-4" /> Version history</Button>
              <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[12px] leading-relaxed text-muted"><Info className="mt-0.5 size-3.5 shrink-0" /> Test draft uses the real provider in an isolated session. It does not save or change the active employee.</p>
              <a href="#employee-readiness" className="inline-flex text-[12px] font-medium text-primary hover:underline">Review activation requirements</a>
            </CardContent>
          </Card>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-float backdrop-blur xl:hidden">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-ink">{dirty ? "Unsaved changes" : pending ? "Waiting for review" : "All changes saved"}</p>
            <p className="truncate text-[12px] text-muted">
              {decision === "blocked" ? "Fix the flagged fields to continue" : decision === "review_required" ? "A reviewer must approve this change" : displayedConfigVersion ? `Active configuration v${displayedConfigVersion}` : "No active configuration"}
            </p>
          </div>
          <Button variant="brand" size="sm" disabled={saveDisabled} loading={saving} onClick={save} aria-label={`${saveLabel} (mobile)`}>{saveLabel}</Button>
        </div>
      </div>

      <ConfigTestDialog open={testing} onOpenChange={setTesting} role={meta.key} agentName={s.displayName || agent.displayName} draft={s} activeVersion={agent.configVersion} />
    </div>
  );
}

function ReasonList({ reasons }: { reasons: ReviewReasonView[] }) {
  if (!reasons.length) return null;
  return (
    <ul className="space-y-1.5">
      {reasons.map((reason) => {
        const id = reason.field ? configFieldElementId(reason.field) : null;
        return (
          <li key={`${reason.code}:${reason.field}`} className="rounded-xl border border-line bg-surface p-2.5 text-[12px] text-ink-2">
            <p className="font-semibold text-ink">{reason.label}{reason.severity === "block" ? " — not allowed" : " — review required"}</p>
            <p className="mt-0.5 leading-relaxed">{reason.detail}</p>
            <p className="mt-1 leading-relaxed text-muted"><span className="font-medium text-ink-2">How to fix: </span>{changeFixForReason(reason.code, reason.field)}</p>
            {id && <a href={`#${id}`} className="mt-1.5 inline-flex font-medium text-primary underline underline-offset-2">Go to this field</a>}
          </li>
        );
      })}
    </ul>
  );
}


function ChangeTab({ meta, agent, settings, onApplied }: Props & { onApplied: () => void }) {
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [proposal, setProposal] = React.useState<{ status: string; changes: Partial<AgentSettings>; explanations: string[]; refusal?: string } | null>(null);
  const [check, setCheck] = React.useState<PreviewCheck>({ state: "idle" });
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const examples = [`Make my ${meta.shortName} more friendly and less pushy`, "Keep answers shorter", "Reply in Spanish", "Don't use emojis"];
  const decision = check.state === "ready" ? check.summary.decision : null;
  const reasons = check.state === "ready" ? check.summary.reasons ?? [] : [];
  const blocked = decision === "blocked";

  const propose = async () => {
    setPending(true);
    setApplyError(null);
    setCheck({ state: "idle" });
    const res = await proposeChangeAction(meta.key, text);
    if (!res.ok) {
      setPending(false);
      return toast.error(res.error);
    }
    setProposal(res.data);
    if (res.data.status === "proposed" && settings) {
      const preview = await previewConfigAction(meta.key, { ...settings, ...res.data.changes });
      setCheck(preview.ok ? { state: "ready", summary: preview.data } : { state: "error", error: preview.error });
    }
    setPending(false);
  };
  const apply = async () => {
    if (!proposal || blocked) return;
    setPending(true);
    setApplyError(null);
    const res = await applyChangeAction(meta.key, text, proposal.changes);
    setPending(false);
    if (!res.ok) {
      setApplyError(res.error);
      return toast.error(res.error);
    }
    if (res.data.status === "pending_agency_review") {
      const reason = res.data.reasons?.[0];
      toast.warning("Submitted for review", { description: reason ? `${reason.label}: ${reason.detail}` : "A reviewer will check this change before it is applied." });
    } else {
      toast.success("Changes saved and applied successfully", { description: `Configuration v${res.data.version} is now active.` });
    }
    setText("");
    setProposal(null);
    setCheck({ state: "idle" });
    router.refresh();
    onApplied();
  };
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader><div><CardTitle className="flex items-center gap-2"><Wand2 className="size-4 text-violet" /> Describe a change in plain English</CardTitle><CardDescription>We show exactly what will change before anything is saved. Safety rules cannot be changed here.</CardDescription></div></CardHeader>
        <CardContent className="space-y-4">
          <GuidedField
            id="change-text"
            label="What should change?"
            guidance={{
              description: "Describe the outcome you want in one or two sentences. The request is interpreted against the active configuration, and you see the exact fields before anything is saved.",
              example: `e.g. ${examples[0]}`,
              info: "Instructions can refine tone, wording and routine work. They cannot add tools, change the employee's role or relax iAcquire's approval policy.",
            }}
            required
            charLimit={1000}
            valueLength={text.length}
          >
            <Textarea rows={4} maxLength={1000} value={text} onChange={(e) => { setText(e.target.value); setProposal(null); setCheck({ state: "idle" }); setApplyError(null); }} />
          </GuidedField>
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-muted">Try an example</p>
            <div className="flex flex-wrap gap-2">{examples.map((e) => <button key={e} type="button" onClick={() => { setText(e); setProposal(null); setCheck({ state: "idle" }); setApplyError(null); }} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-2 transition hover:border-primary/30 hover:text-ink">{e}</button>)}</div>
          </div>
          <Button variant="secondary" onClick={propose} loading={pending && !proposal} disabled={!text.trim()}><Sparkles className="size-4" /> Preview change</Button>
          <AnimatePresence>
            {proposal && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-3 rounded-2xl border border-line bg-surface-2/60 p-4">
                {proposal.status === "refused" ? <p className="flex items-start gap-2 text-[14px] text-warning-ink"><XCircle className="mt-0.5 size-4 shrink-0" /> {proposal.refusal}</p>
                  : proposal.status === "no_change" ? <p className="text-[14px] text-muted">{proposal.explanations[0]}</p>
                    : <>
                        <p className="text-[14px] font-semibold">What will change for {agent.displayName}</p>
                        <ul className="space-y-1.5">{proposal.explanations.map((e) => <li key={e} className="flex items-start gap-2 text-[14px]"><Check className="mt-0.5 size-4 shrink-0 text-success" /> {e}</li>)}</ul>

                        {check.state === "checking" && <p className="text-[12px] text-muted">Checking this change…</p>}
                        {check.state === "error" && (
                          <ChangeDecisionNotice tone="info" title="We couldn't pre-check this change">
                            <p>The server will make the final decision when you apply it. Your current configuration remains active unless the change applies immediately.</p>
                          </ChangeDecisionNotice>
                        )}
                        {check.state === "ready" && decision === "auto_apply" && (
                          <ChangeDecisionNotice tone="success" title="Ready to apply">
                            <p>This is a routine change. It will apply immediately after server validation.</p>
                          </ChangeDecisionNotice>
                        )}
                        {check.state === "ready" && decision === "review_required" && (
                          <ChangeDecisionNotice tone="warning" title="Some changes require review">
                            <p>None of the changes in this submission will become active until an authorized reviewer approves it. Your current configuration remains active.</p>
                            <ReasonList reasons={reasons} />
                          </ChangeDecisionNotice>
                        )}
                        {check.state === "ready" && decision === "blocked" && (
                          <ChangeDecisionNotice tone="danger" title="Change not allowed">
                            <p>This change can&apos;t be saved because it conflicts with platform security rules. Edit the request to remove the flagged request.</p>
                            <ReasonList reasons={reasons} />
                          </ChangeDecisionNotice>
                        )}

                        {applyError && <p role="alert" className="rounded-xl border border-danger/25 bg-danger-soft/40 p-2.5 text-[13px] text-danger-ink">{applyError}</p>}
                        <div className="flex flex-wrap gap-2">
                          <Button variant="brand" onClick={apply} loading={pending} disabled={blocked}>
                            {blocked ? "Change not allowed" : decision === "review_required" ? "Submit for review" : "Apply change"}
                          </Button>
                          <Button variant="ghost" onClick={() => { setProposal(null); setCheck({ state: "idle" }); setApplyError(null); }}>Cancel</Button>
                        </div>
                      </>}
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
      <Card className="h-fit bg-surface-2/50">
        <CardHeader><div><CardTitle>How this works</CardTitle><CardDescription>Safe, reviewable changes.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3 text-[13px] leading-relaxed text-muted">
          <p className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" /> The request is interpreted against the active configuration.</p>
          <p className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" /> You see the exact fields before applying.</p>
          <p className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" /> If any part needs review, the whole submission is held so nothing applies partially.</p>
          <p className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /> Tools, permissions and the run gate cannot be changed here. Blocked requests are refused, not sent for approval.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function HistoryTab({ meta, versions, timeZone, now, draftVersion, isInternalWorkspace, canConfigure, onEdit }: Props & { onEdit: (versionId: string) => void }) {
  return (
    <ConfigVersionHistory
      versions={versions}
      role={meta.key}
      timeZone={timeZone}
      initialNow={now}
      isInternalWorkspace={isInternalWorkspace}
      draftVersion={draftVersion}
      canEdit={canConfigure}
      onEdit={onEdit}
    />
  );
}

function EmployeeProactiveActivity({ meta, reports, monitoring, timeZone }: { meta: AgentRoleMeta; reports: ProactiveReportView[]; monitoring: MonitoringStatus | null; timeZone: string }) {
  const duty = proactiveDutyForRole(meta.key);
  if (!duty) return null;
  const roleMonitoring = monitoring?.byRole.find((row) => row.role === meta.key);
  const state = monitoring?.state ?? "not_configured";
  const watching = Boolean(roleMonitoring?.enabled && state === "active");
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2"><Radar className="size-4" aria-hidden /> Proactive work</CardTitle>
          <CardDescription>{duty.description}</CardDescription>
        </div>
        <Badge tone={watching ? "success" : state === "paused" ? "warning" : "neutral"}>
          {watching ? "Monitoring active" : state === "paused" ? "Monitoring paused" : "No monitoring scheduled"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border border-line bg-surface-2/40 p-3">
          <p className="text-[13px] font-semibold text-ink">{duty.title}</p>
          <ul className="mt-1.5 grid gap-1 text-[12px] text-ink-2 sm:grid-cols-2">
            {duty.watches.slice(0, 6).map((item) => <li key={item} className="flex gap-1.5"><span className="text-primary">•</span>{item}</li>)}
          </ul>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">{duty.approvalBoundary}</p>
        </div>
        {reports.length === 0 ? (
          <p className="text-[13px] text-muted">No verified proactive report has been recorded for this employee yet. This view never fabricates one.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {reports.map((report) => (
              <li key={report.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <Badge tone={report.severity === "critical" ? "danger" : report.severity === "warning" ? "warning" : "primary"}>{PROACTIVE_SEVERITY_LABELS[report.severity]}</Badge>
                <div className="min-w-0 flex-1">
                  <Link href={`/work?report=${report.id}`} className="block truncate text-[13px] font-semibold text-ink hover:underline">{report.title}</Link>
                  <span className="text-[12px] text-muted"><span suppressHydrationWarning>{formatDateTime(report.createdAt, timeZone)}</span> · {report.findings.length} finding{report.findings.length === 1 ? "" : "s"}</span>
                </div>
                <Link href={`/work?report=${report.id}`} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[12px] font-semibold text-primary hover:bg-primary-soft/50">
                  Open <ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] leading-relaxed text-muted">
          {watching
            ? "An authorized schedule or trigger is enabled for this employee. Reports appear only after a real job completes."
            : "No recurring job is authorized for this employee here. You can inspect or authorize monitoring on the AI Work Board."}
        </p>
        <ButtonLink href="/work" variant="secondary">Open the AI Work Board</ButtonLink>
      </CardContent>
    </Card>
  );
}

function ActivityTab({ runs, timeZone, meta, agent, canChat: canUse, proactiveReports, proactiveMonitoring }: Props) {
  const proactive = <EmployeeProactiveActivity meta={meta} reports={proactiveReports} monitoring={proactiveMonitoring} timeZone={timeZone} />;
  if (!runs.length) {
    return (
      <div className="space-y-4">
        {proactive}
        <Card><EmptyState icon={<Activity className="size-5" />} title="No recorded runs yet" description={`Conversations and tool activity appear here after ${agent.displayName} starts working. This view only shows saved run records.`} action={canUse && agent.enabled && canChat(agent.status) ? <ButtonLink href={`/chat/${meta.slug}`} variant="secondary">Open chat</ButtonLink> : <ButtonLink href="#employee-readiness" variant="secondary">Review setup requirements</ButtonLink>} /></Card>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {proactive}
      <Card className="overflow-hidden">
        <div className="scrollbar-thin overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[640px] text-left text-[14px]">
            <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted"><tr><th className="px-5 py-3 font-medium">Started</th><th className="px-3 py-3 font-medium">Type</th><th className="px-3 py-3 font-medium">Status</th><th className="px-3 py-3 text-right font-medium">Tool steps</th><th className="px-5 py-3 text-right font-medium">Tokens</th></tr></thead>
            <tbody className="divide-y divide-line">
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="px-5 py-2.5">{formatDateTime(r.started_at, timeZone)}</td>
                  <td className="px-3 py-2.5">{r.purpose === "lead_research" ? "Lead research" : "Conversation"}</td>
                  <td className="px-3 py-2.5"><Badge tone={r.status === "completed" ? "success" : r.status === "cancelled" ? "neutral" : r.status === "running" ? "primary" : "danger"}>{sentenceCase(r.status)}</Badge>{r.error_message && <span className="ml-2 text-[12px] text-muted">{r.error_message}</span>}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.tools}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{r.total_tokens ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
