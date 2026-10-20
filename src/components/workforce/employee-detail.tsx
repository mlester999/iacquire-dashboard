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
  RotateCcw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  XCircle,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Segmented, Switch, Tabs, Tooltip } from "@/components/ui/overlays";
import { InfoChip } from "@/components/ui/status";
import { applyChangeAction, proposeChangeAction, rollbackAction, saveAgentSettingsAction } from "@/app/actions/workforce";
import { LANGUAGES, LENGTH_COPY, TONE_COPY, TONES, type AgentSettings, type ReplyLength, type Tone } from "@/lib/agent-settings";
import { canChat, type AgentRoleMeta, type AgentStatus } from "@/lib/agents";
import { agentToolLabel } from "@/lib/agent-tools";
import { cn, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { EmployeeProfileHero, ReadinessChecklist } from "@/components/workforce/employee-summary";
import { OperatingModeCard, type AgentMode } from "@/components/workforce/operating-controls";
import { ConfigTestDialog } from "@/components/workforce/config-test-dialog";
import { EmployeeInstructions } from "@/components/workforce/employee-instructions";
import { EmployeeKnowledge } from "@/components/workforce/employee-knowledge";
import type { EmployeeInstructionOverview } from "@/server/workforce/instructions";
import type { EmployeeKnowledgeView } from "@/server/workforce/knowledge";

interface Version {
  id: string;
  version: number;
  summary: string;
  status: string;
  source: string;
  change_request: string | null;
  risk_flags: string[];
  created_at: string;
  applied_at: string | null;
  created_by_name: string | null;
}

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
    inventoryDigest: string | null;
    inventoryVerifiedAt: string | null;
    inventoryToolCount: number | null;
  };
  canPause: boolean;
  canGoAutonomous: boolean;
  autonomousBlockedReason: string | null;
  agencyPaused: boolean;
  settings: AgentSettings | null;
  versions: Version[];
  canConfigure: boolean;
  canChat: boolean;
  canViewKnowledge: boolean;
  canEditKnowledge: boolean;
  acknowledgementCurrent: boolean | null;
  isAgencyEmployee: boolean;
  adminManageHref: string | null;
  initialTab: string;
  timeZone: string;
  capabilities: string[];
  description: string;
  knowledgeAppliedAt: string | null;
  runs: Array<{ id: string; purpose: string; status: string; started_at: string; finished_at: string | null; total_tokens: number | null; tools: number; error_message: string | null }>;
  pendingApprovals: number;
  instructionOverview: EmployeeInstructionOverview | null;
  knowledgeView: EmployeeKnowledgeView | null;
  uploadAccept: string;
}

export function EmployeeDetail(props: Props) {
  const { meta, agent } = props;
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
    inventoryDigest: agent.inventoryDigest,
    acknowledgementCurrent: props.acknowledgementCurrent,
    isAgencyEmployee: props.isAgencyEmployee,
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
      <Link href="/employees" className="inline-flex items-center gap-1.5 text-[13px] text-muted transition hover:text-ink">
        <ArrowLeft className="size-3.5" /> AI Employees
      </Link>

      <EmployeeProfileHero
        meta={meta}
        displayName={agent.displayName}
        description={props.description}
        readiness={readiness}
        eyebrow={props.isAgencyEmployee ? "iAcquire internal employee" : "Your AI employee"}
        actions={<>{primary}{secondary}{props.adminManageHref && primary && readiness.cta !== "connection" ? <ButtonLink href={props.adminManageHref} variant="ghost">Admin controls <ArrowUpRight className="size-3.5" /></ButtonLink> : null}</>}
        footer={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <InfoChip icon={<Sparkles />}>{agent.configVersion ? `Configuration v${agent.configVersion}` : "Not configured"}</InfoChip>
            <InfoChip icon={<ShieldCheck />}>{agent.inventoryDigest ? `${agent.inventoryToolCount ?? 0} tools approved` : "Inventory not recorded"}</InfoChip>
            <InfoChip icon={<History />}>{agent.lastHealthCheckAt ? `Checked ${relativeTime(agent.lastHealthCheckAt)}` : "Never checked"}</InfoChip>
            <span className="text-[11.5px] text-muted">{agent.assignedOrganization}</span>
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
          <motion.div key={tab} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: reduced ? 0 : 0.2 }}>
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
            {tab === "history" && <HistoryTab {...props} />}
            {tab === "activity" && <ActivityTab {...props} />}
          </motion.div>
        </AnimatePresence>
      </Tabs>
    </div>
  );
}

function OverviewTab({ agent, capabilities, knowledgeAppliedAt, pendingApprovals, timeZone, meta, readiness, onConfigure, runs, canConfigure, adminManageHref, canPause, canGoAutonomous, autonomousBlockedReason, agencyPaused }: Props & { readiness: ReturnType<typeof deriveEmployeeReadiness>; onConfigure: () => void }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_365px]">
      <div className="space-y-6">
        <ReadinessChecklist readiness={readiness} action={canConfigure && readiness.cta !== "chat" ? <Button size="sm" variant="brand" onClick={onConfigure}>Continue setup <ArrowUpRight className="size-3.5" /></Button> : undefined} />
        {agent.enabled && <OperatingModeCard agentId={agent.id} displayName={agent.displayName} mode={agent.mode} canPause={canPause} canGoAutonomous={canGoAutonomous} autonomousBlockedReason={autonomousBlockedReason} agencyPaused={agencyPaused} />}

        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>What {agent.displayName} handles</CardTitle>
              <CardDescription>Role-specific responsibilities and the boundaries that always apply.</CardDescription>
            </div>
            <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[.12em] text-muted">{meta.shortName}</span>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="rounded-2xl border border-line bg-surface-2/60 p-4 text-[14px] leading-[1.75] text-ink-2">{agent.summary ?? `${meta.shortName} hasn't been configured yet. Use Configure to describe its responsibilities and goals.`}</p>
            <div>
              <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-[.12em] text-muted">Capabilities</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {capabilities.map((c) => (
                  <li key={c} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> {c}</li>
                ))}
              </ul>
            </div>
            <div className="border-t border-line pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] font-semibold uppercase tracking-[.12em] text-muted">Tool permissions</p>
                <span className="text-[11.5px] text-muted">Granted by iAcquire</span>
              </div>
              <ul className="mt-2.5 grid gap-2 sm:grid-cols-2">
                {agent.defaultTools.map((t) => (
                  <li key={t} className="flex items-center gap-2 rounded-xl border border-line bg-surface-2/50 px-3 py-2 text-[12.5px] text-ink-2"><Lock className="size-3.5 shrink-0 text-faint" /> {agentToolLabel(t)}</li>
                ))}
              </ul>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted">Tools can be switched off in Configure; nobody can add new tools from this screen.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div><CardTitle>Connection &amp; identity</CardTitle><CardDescription>Latest recorded facts, not inferred availability.</CardDescription></div>
          </CardHeader>
          <CardContent className="space-y-3 text-[12.5px]">
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
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-[12.5px]">
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
          <CardContent className="space-y-2.5 text-[13px] text-ink-2">
            {["Customer-facing actions wait for your approval", "Never invents bookings, prices or results", "Only works with your company's data", "Cannot grant itself new tools or access"].map((s) => (
              <p key={s} className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /> {s}</p>
            ))}
            <div className="mt-3 rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">
              Pending approvals: <span className="font-semibold text-ink">{pendingApprovals}</span> · <Link href="/approvals" className="text-primary hover:underline">Approval Center</Link>
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
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary-ink ring-1 ring-inset ring-primary/15">{step}</span>
            <div className="min-w-0"><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">{children}</CardContent>
      </Card>
    </section>
  );
}

function ConfigureTab({ meta, agent, settings, hasPendingReview, onSaved, onOpenHistory }: Props & { settings: AgentSettings; hasPendingReview: boolean; onSaved: () => void; onOpenHistory: () => void }) {
  const router = useRouter();
  const [s, setS] = React.useState<AgentSettings>(settings);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [saveState, setSaveState] = React.useState<string | null>(null);
  const set = <K extends keyof AgentSettings>(k: K, v: AgentSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const nameError = s.displayName.trim().length === 0 ? "Give this employee a name." : null;

  const save = async () => {
    if (nameError) return;
    setSaving(true);
    setSaveState(null);
    const res = await saveAgentSettingsAction(meta.key, s);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    if (res.data.status === "pending_agency_review") {
      setSaveState("Saved for review. Nothing is applied until iAcquire approves it.");
      toast.warning("Saved for review", { description: "Part of the instructions looked like it could change safety rules, so iAcquire will review it first." });
    } else {
      setSaveState(`Configuration v${res.data.version} applied.`);
      toast.success(`Saved as configuration v${res.data.version}`, { description: "New conversations use it right away." });
    }
    router.refresh();
    onSaved();
  };

  return (
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
          <Field label="Employee name" htmlFor="cfg-name" hint="What your team calls this employee." error={nameError}>
            <Input id="cfg-name" value={s.displayName} maxLength={40} aria-invalid={Boolean(nameError)} onChange={(e) => set("displayName", e.target.value)} />
          </Field>
          <div>
            <p className="mb-2 text-[13px] font-medium text-ink-2">Personality</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {TONES.map((t: Tone) => (
                <button key={t} type="button" onClick={() => set("tone", t)} aria-pressed={s.tone === t} className={cn("rounded-2xl border p-3.5 text-left transition", s.tone === t ? "border-primary bg-primary-soft/50 ring-2 ring-primary/15" : "border-line bg-surface hover:border-line-strong")}>
                  <span className="flex items-center justify-between text-[13px] font-semibold">{TONE_COPY[t].label}{s.tone === t && <Check className="size-4 text-primary" />}</span>
                  <span className="mt-1 block text-[12px] leading-relaxed text-muted">{TONE_COPY[t].example}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[13px] font-medium text-ink-2">Reply length</p>
              <p className="mb-2 text-[12px] text-muted">{LENGTH_COPY[s.replyLength].description}</p>
              <Segmented id="cfg-length" ariaLabel="Reply length" value={s.replyLength} onChange={(v: ReplyLength) => set("replyLength", v)} options={(["concise", "balanced", "detailed"] as const).map((v) => ({ value: v, label: LENGTH_COPY[v].label }))} />
            </div>
            <Field label="Language" htmlFor="cfg-lang">
              <Select id="cfg-lang" value={s.language} onChange={(e) => set("language", e.target.value as AgentSettings["language"])}>{LANGUAGES.map((l) => <option key={l}>{l}</option>)}</Select>
            </Field>
          </div>
        </ConfigSection>

        <ConfigSection id="config-role" step="02" title="Role & responsibilities" description="The real work this employee should own. Short answers are perfect; blank fields use safe defaults.">
          {meta.questions.map((q) => (
            <Field key={q.id} label={q.label} htmlFor={`cfg-q-${q.id}`} optional>
              <Textarea id={`cfg-q-${q.id}`} rows={2} maxLength={1000} placeholder={q.placeholder} value={s.roleAnswers[q.id] ?? ""} onChange={(e) => set("roleAnswers", { ...s.roleAnswers, [q.id]: e.target.value })} />
            </Field>
          ))}
          <Field label="Main responsibilities" htmlFor="cfg-resp" optional><Textarea id="cfg-resp" rows={2} maxLength={1000} value={s.responsibilities} onChange={(e) => set("responsibilities", e.target.value)} placeholder="e.g. Focus on commercial clients first" /></Field>
          <Field label="Goals for this employee" htmlFor="cfg-goals" optional><Textarea id="cfg-goals" rows={2} maxLength={1000} value={s.goals} onChange={(e) => set("goals", e.target.value)} placeholder="e.g. Book 10 consultations a month" /></Field>
          <Field label="Target audience" htmlFor="cfg-target" optional><Textarea id="cfg-target" rows={2} maxLength={1000} value={s.targetCustomers} onChange={(e) => set("targetCustomers", e.target.value)} /></Field>
        </ConfigSection>

        <ConfigSection id="config-rules" step="03" title="Behavior & business rules" description="Guardrails and escalation. These are combined with iAcquire's protected policy and cannot override it.">
          <Field label="Company rules" htmlFor="cfg-rules" optional><Textarea id="cfg-rules" rows={2} maxLength={1500} value={s.companyRules} onChange={(e) => set("companyRules", e.target.value)} placeholder="e.g. Never discuss competitors by name" /></Field>
          <Field label="Never promise" htmlFor="cfg-never" optional><Textarea id="cfg-never" rows={2} maxLength={1000} value={s.neverPromise} onChange={(e) => set("neverPromise", e.target.value)} placeholder="e.g. Same-day service, exact prices before an inspection" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ask a human when…" htmlFor="cfg-esc" optional><Input id="cfg-esc" maxLength={600} value={s.escalateWhen} onChange={(e) => set("escalateWhen", e.target.value)} placeholder="a customer is upset" /></Field>
            <Field label="Escalation contact" htmlFor="cfg-esc-contact" optional><Input id="cfg-esc-contact" maxLength={200} value={s.escalationContact} onChange={(e) => set("escalationContact", e.target.value)} placeholder="Name and email" /></Field>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-surface-2/50 p-4">
            <div><p className="text-[13px] font-medium">Ask before any business action</p><p className="mt-1 text-[12px] leading-relaxed text-muted">Customer-facing actions always need approval. With this on, every business action does too.</p></div>
            <Switch checked={s.approvalPreference === "always"} onCheckedChange={(v) => set("approvalPreference", v ? "always" : "high_impact")} aria-label="Ask before any business action" />
          </div>
        </ConfigSection>

        <ConfigSection id="config-instructions" step="04" title="Additional instructions" description="One short, plain-English instruction specific to this employee.">
          <Field label="Employee-specific instruction" htmlFor="cfg-custom" optional hint="Keep it factual. Instructions cannot change permissions or safety rules."><Textarea id="cfg-custom" rows={3} maxLength={500} value={s.customInstruction} onChange={(e) => set("customInstruction", e.target.value)} placeholder="e.g. Always mention our free inspection." /></Field>
        </ConfigSection>

        <ConfigSection id="config-tools" step="05" title="Tool permissions" description="Only the tools granted to this role are listed. Client controls can switch tools off, never add new ones.">
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {agent.defaultTools.map((t) => {
              const on = !s.disabledTools.includes(t);
              return (
                <div key={t} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div><p className="text-[13px] font-medium">{agentToolLabel(t)}</p><p className="mt-0.5 text-[11.5px] text-muted">Granted by iAcquire for this role.</p></div>
                  <Switch checked={on} onCheckedChange={(v) => set("disabledTools", v ? s.disabledTools.filter((x) => x !== t) : [...s.disabledTools, t])} aria-label={agentToolLabel(t)} />
                </div>
              );
            })}
          </div>
          <p className="rounded-xl bg-surface-2 p-3 text-[11.5px] leading-relaxed text-muted"><Lock className="mr-1.5 inline size-3.5" /> The provider profile and the connection health check remain the enforced boundary. A switch here changes instructions; it is not a separate sandbox.</p>
        </ConfigSection>
      </div>

      <aside className="order-first xl:order-last xl:sticky xl:top-24 xl:self-start">
        <Card className="overflow-hidden">
          <div className="border-b border-line bg-surface-2/60 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[.15em] text-muted">Publishing</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-[14px] font-semibold text-ink">{hasPendingReview ? "Awaiting review" : agent.configVersion ? `Configuration v${agent.configVersion}` : "New configuration"}</p>
              <span className={cn("size-2 rounded-full", dirty ? "bg-warning" : "bg-success")} aria-hidden />
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{dirty ? "You have unsaved changes." : "All changes are saved."}</p>
          </div>
          <CardContent className="space-y-3">
            <div aria-live="polite" className="min-h-5 text-[12px] text-muted">{saveState}</div>
            <Button variant="brand" className="w-full" disabled={!dirty || Boolean(nameError)} loading={saving} onClick={save}>Save &amp; apply</Button>
            <Button variant="secondary" className="w-full" onClick={() => setTesting(true)}><Sparkles className="size-4" /> Test this draft</Button>
            <Button variant="ghost" className="w-full" disabled={!dirty} onClick={() => setS(settings)}>Discard changes</Button>
            <Button variant="ghost" className="w-full justify-start" onClick={onOpenHistory}><History className="size-4" /> Version history</Button>
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[11.5px] leading-relaxed text-muted"><Info className="mt-0.5 size-3.5 shrink-0" /> Test draft uses the real provider in an isolated session. It does not save or change the active employee.</p>
            <a href="#employee-readiness" className="inline-flex text-[12px] font-medium text-primary hover:underline">Review activation requirements</a>
          </CardContent>
        </Card>
      </aside>

      <ConfigTestDialog open={testing} onOpenChange={setTesting} role={meta.key} agentName={s.displayName || agent.displayName} draft={s} activeVersion={agent.configVersion} />
    </div>
  );
}

function ChangeTab({ meta, agent, onApplied }: Props & { onApplied: () => void }) {
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [proposal, setProposal] = React.useState<{ status: string; changes: Partial<AgentSettings>; explanations: string[]; refusal?: string } | null>(null);
  const examples = [`Make my ${meta.shortName} more friendly and less pushy`, "Keep answers shorter", "Reply in Spanish", "Don't use emojis"];
  const propose = async () => {
    setPending(true);
    const res = await proposeChangeAction(meta.key, text);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    setProposal(res.data);
  };
  const apply = async () => {
    if (!proposal) return;
    setPending(true);
    const res = await applyChangeAction(meta.key, text, proposal.changes);
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    if (res.data.status === "pending_agency_review") toast.warning("Sent for iAcquire review");
    else toast.success(`Applied as configuration v${res.data.version}`);
    setText("");
    setProposal(null);
    router.refresh();
    onApplied();
  };
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader><div><CardTitle className="flex items-center gap-2"><Wand2 className="size-4 text-violet" /> Describe a change in plain English</CardTitle><CardDescription>We show exactly what will change before anything is applied. Safety rules cannot be changed here.</CardDescription></div></CardHeader>
        <CardContent className="space-y-4">
          <label htmlFor="change-text" className="sr-only">Change request</label>
          <Textarea id="change-text" rows={4} maxLength={1000} value={text} onChange={(e) => { setText(e.target.value); setProposal(null); }} placeholder={`e.g. ${examples[0]}`} />
          <div className="flex flex-wrap gap-2">{examples.map((e) => <button key={e} type="button" onClick={() => { setText(e); setProposal(null); }} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-2 transition hover:border-primary/30 hover:text-ink">{e}</button>)}</div>
          <Button variant="secondary" onClick={propose} loading={pending && !proposal} disabled={!text.trim()}><Sparkles className="size-4" /> Preview change</Button>
          <AnimatePresence>
            {proposal && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-2xl border border-line bg-surface-2/60 p-4">
                {proposal.status === "refused" ? <p className="flex items-start gap-2 text-[13.5px] text-warning-ink"><XCircle className="mt-0.5 size-4 shrink-0" /> {proposal.refusal}</p>
                  : proposal.status === "no_change" ? <p className="text-[13.5px] text-muted">{proposal.explanations[0]}</p>
                    : <>
                        <p className="mb-2 text-[13px] font-semibold">What will change for {agent.displayName}</p>
                        <ul className="space-y-1.5">{proposal.explanations.map((e) => <li key={e} className="flex items-start gap-2 text-[13.5px]"><Check className="mt-0.5 size-4 shrink-0 text-success" /> {e}</li>)}</ul>
                        <div className="mt-4 flex gap-2"><Button variant="brand" onClick={apply} loading={pending}>Apply change</Button><Button variant="ghost" onClick={() => setProposal(null)}>Cancel</Button></div>
                      </>}
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
      <Card className="h-fit bg-surface-2/50">
        <CardHeader><div><CardTitle>How this works</CardTitle><CardDescription>Safe, reviewable changes.</CardDescription></div></CardHeader>
        <CardContent className="space-y-3 text-[12.5px] leading-relaxed text-muted">
          <p className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" /> The request is interpreted against the active configuration.</p>
          <p className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" /> You see the exact fields before applying.</p>
          <p className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" /> Risky instruction changes are held for iAcquire review.</p>
          <p className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /> Tools, permissions and the run gate cannot be changed here.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function HistoryTab({ meta, versions, timeZone }: Props) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState<Version | null>(null);
  const [pending, setPending] = React.useState(false);
  if (!versions.length) {
    return <Card><EmptyState icon={<History className="size-5" />} title="No configuration versions yet" description="Save a configuration to create the first version. Every later change stays in this history and can be restored." action={<span className="text-[12px] text-muted">Configuration changes are versioned.</span>} /></Card>;
  }
  return (
    <Card className="overflow-hidden">
      <CardHeader><div><CardTitle className="flex items-center gap-2"><History className="size-4" /> Version history</CardTitle><CardDescription>Every change is kept. Restoring an older version creates a new one.</CardDescription></div></CardHeader>
      <CardContent>
        <ol className="relative space-y-5 border-l border-line pl-5">
          {versions.map((v) => (
            <li key={v.id} className="relative">
              <span className={cn("absolute -left-[26px] top-1.5 size-3 rounded-full ring-4 ring-surface", v.status === "applied" ? "bg-success" : v.status === "pending_agency_review" ? "bg-warning" : v.status === "rejected" ? "bg-danger" : "bg-surface-3")} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold">v{v.version}</span>
                <Badge tone={v.status === "applied" ? "success" : v.status === "pending_agency_review" ? "warning" : v.status === "rejected" ? "danger" : "neutral"}>{v.status === "applied" ? "Active" : v.status === "pending_agency_review" ? "Awaiting iAcquire review" : sentenceCase(v.status)}</Badge>
                <span className="text-[12px] text-muted">{sentenceCase(v.source)} · {v.created_by_name ?? "System"} · {formatDateTime(v.created_at, timeZone)}</span>
              </div>
              {v.change_request && <p className="mt-1 text-[13px] italic text-ink-2">“{v.change_request}”</p>}
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{v.summary}</p>
              {v.status === "superseded" && <Tooltip content="Creates a new version with these settings"><Button size="sm" variant="ghost" className="-ml-2 mt-1" onClick={() => setConfirm(v)}><RotateCcw className="size-3.5" /> Restore</Button></Tooltip>}
            </li>
          ))}
        </ol>
      </CardContent>
      <Dialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)} title={`Restore version ${confirm?.version}?`} description="The current settings stay in history, so you can switch back later." size="sm" footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button><Button loading={pending} onClick={async () => { if (!confirm) return; setPending(true); const res = await rollbackAction(meta.key, confirm.id); setPending(false); if (!res.ok) return toast.error(res.error); toast.success(`Restored as v${res.data.version}`); setConfirm(null); router.refresh(); }}>Restore</Button></>} />
    </Card>
  );
}

function ActivityTab({ runs, timeZone, meta, agent, canChat: canUse }: Props) {
  if (!runs.length) {
    return <Card><EmptyState icon={<Activity className="size-5" />} title="No recorded runs yet" description={`Conversations and tool activity appear here after ${agent.displayName} starts working. This view only shows saved run records.`} action={canUse && agent.enabled && canChat(agent.status) ? <ButtonLink href={`/chat/${meta.slug}`} variant="secondary">Open chat</ButtonLink> : <ButtonLink href="#employee-readiness" variant="secondary">Review setup requirements</ButtonLink>} /></Card>;
  }
  return (
    <Card className="overflow-hidden">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
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
  );
}
