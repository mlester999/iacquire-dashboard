"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion,useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  CircleCheck,
  History,
  Info,
  Lock,
  MessageSquare,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Wand2,
  XCircle,
} from "lucide-react";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Segmented, Switch, Tabs, Tooltip } from "@/components/ui/overlays";
import { applyChangeAction, proposeChangeAction, rollbackAction, saveAgentSettingsAction } from "@/app/actions/workforce";
import { LANGUAGES, LENGTH_COPY, TONE_COPY, TONES, type AgentSettings, type ReplyLength, type Tone } from "@/lib/agent-settings";
import { canChat, type AgentRoleMeta, type AgentStatus } from "@/lib/agents";
import { agentToolLabel } from "@/lib/agent-tools";
import { cn, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
import { PageHero,MetricCard } from "@/components/ui/workspace";
import { OperatingModeCard,type AgentMode } from "@/components/workforce/operating-controls";
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
    lastHealthDetail: string | null;
    summary: string | null;
    configVersion: number | null;
    configAppliedAt: string | null;
    defaultTools: string[];
    mode: AgentMode;
    providerRuntime: string;
    assignedOrganization: string;
    lastActivityAt: string | null;
  };
  canPause: boolean;
  canGoAutonomous: boolean;
  autonomousBlockedReason: string | null;
  agencyPaused: boolean;
  settings: AgentSettings | null;
  versions: Version[];
  canConfigure: boolean;
  canChat: boolean;
  initialTab: string;
  timeZone: string;
  capabilities: string[];
  description: string;
  knowledgeAppliedAt: string | null;
  runs: Array<{ id: string; purpose: string; status: string; started_at: string; finished_at: string | null; total_tokens: number | null; tools: number; error_message: string | null }>;
  pendingApprovals: number;
  instructionOverview: EmployeeInstructionOverview | null;
  knowledgeView: EmployeeKnowledgeView | null;
  canViewKnowledge: boolean;
  canEditKnowledge: boolean;
  uploadAccept: string;
}

export function EmployeeDetail(props: Props) {
  const { meta, agent } = props;
  const reduced=useReducedMotion();
  const [tab, setTab] = React.useState(props.initialTab);
  const ready = agent.enabled && canChat(agent.status);
  const items = [
    { value: "overview", label: "Overview" },
    ...(props.canConfigure
      ? [
          { value: "configure", label: "Configure" },
          { value: "change", label: "Request a change" },
          ...(props.instructionOverview ? [{ value: "instructions", label: "Instructions & SOUL" }] : []),
        ]
      : []),
    ...(props.canViewKnowledge && props.knowledgeView ? [{ value: "knowledge", label: "Knowledge" }] : []),
    ...(props.canConfigure ? [{ value: "history", label: "Version history", count: props.versions.length || undefined }] : []),
    { value: "activity", label: "Activity" },
  ];
  return (
    <div className="space-y-6">
      <Link href="/workforce" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> AI Workforce
      </Link>
      <PageHero eyebrow={meta.name} title={agent.displayName} description={props.description} tone="neutral" aside={<div className="flex items-center gap-4 rounded-2xl border border-line bg-surface/70 p-5"><AgentAvatar role={meta} size="xl"/><div><p className="text-[11px] font-medium uppercase tracking-wider text-muted">Dedicated identity</p><p className="mt-2 text-[14px] font-semibold">{meta.shortName}</p><p className="mt-1 text-[12px] text-muted">Private company workspace</p></div></div>} action={<>
              <AgentStatusBadge status={agent.enabled?agent.status:"disabled"} />
              <span className="text-muted">{agent.configVersion ? `Configuration v${agent.configVersion}` : "Not configured yet"}</span>
              {agent.lastHealthCheckAt && <span className="text-faint" suppressHydrationWarning>Checked {relativeTime(agent.lastHealthCheckAt)}</span>}
          {props.canChat && (ready?<ButtonLink href={`/chat/${meta.slug}`} variant="brand"><MessageSquare className="size-4"/>Start a chat</ButtonLink>:<Button disabled variant="secondary"><MessageSquare className="size-4"/>Chat unavailable</Button>)}
        </>}/>

      <div className="grid gap-3 sm:grid-cols-3"><MetricCard label="Configuration versions" value={props.versions.length} detail="Saved changes remain available in history." icon={<History className="size-4"/>} tone="blue"/><MetricCard label="Recorded runs" value={props.runs.length} detail="Activity from this employee's saved run history." icon={<Sparkles className="size-4"/>} tone="violet"/><MetricCard label="Awaiting approval" value={props.pendingApprovals} detail="Customer-facing actions stay under your control." icon={<ShieldCheck className="size-4"/>} tone="amber" href="/approvals"/></div>

      <Tabs id="employee-tabs" value={tab} onValueChange={setTab} items={items}>

      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={reduced?false:{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduced?undefined:{ opacity: 0 }} transition={{ duration: reduced?0:0.2 }}>
          {tab === "overview" && (
            <div className="space-y-6">
              {agent.enabled && <OperatingModeCard agentId={agent.id} displayName={agent.displayName} mode={agent.mode} canPause={props.canPause} canGoAutonomous={props.canGoAutonomous} autonomousBlockedReason={props.autonomousBlockedReason} agencyPaused={props.agencyPaused} />}
              <OverviewTab {...props} />
            </div>
          )}
          {tab === "configure" && props.settings && <ConfigureTab {...props} settings={props.settings} onSaved={() => setTab("history")} />}
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

function OverviewTab({ agent, capabilities, knowledgeAppliedAt, pendingApprovals, timeZone, meta }: Props) {
  const online = agent.enabled&&(agent.status === "online" || agent.status === "busy");
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="surface-tint lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>How {agent.displayName} works for you</CardTitle>
            <CardDescription>Generated from your answers. Edit it any time in Configure.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="rounded-xl border border-line bg-surface-2/60 p-4 text-[14px] leading-relaxed text-ink">{agent.summary ?? `${meta.shortName} hasn't been configured yet.`}</p>
          <div>
            <p className="mb-2 text-[13px] font-semibold">Capabilities</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {capabilities.map((c) => (
                <li key={c} className="flex items-start gap-2 text-[13px] text-ink-2">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> {c}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-[13px] font-semibold">Tool permissions</p>
            <ul className="space-y-1.5">
              {agent.defaultTools.map((t) => (
                <li key={t} className="flex items-center gap-2 text-[13px] text-ink-2">
                  <Lock className="size-3.5 text-faint" /> {agentToolLabel(t)}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted">Tools are granted by iAcquire. You can switch tools off in Configure, but never add new ones from here.</p>
          </div>
        </CardContent>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Connection</CardTitle>
              <CardDescription>Latest recorded connection check.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2.5 text-[13px]">
            <AgentStatusBadge status={agent.enabled?agent.status:"disabled"} />
            <p className="text-muted">
              {!agent.enabled?"This employee is not included in your package.":online
                ? "Running in its own private, secured environment."
                : agent.status === "setup_required" || agent.status === "provisioning"
                  ? "iAcquire is preparing a dedicated, isolated environment for this employee."
                  : (agent.lastHealthDetail ?? "The last check didn't succeed.")}
            </p>
            {agent.lastHealthCheckAt && <p className="text-[12px] text-faint">Last checked {formatDateTime(agent.lastHealthCheckAt, timeZone)}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Employee profile</CardTitle>
              <CardDescription>Identity, ownership and runtime, kept separate from provider credentials.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-[13px]">
            <div className="flex items-center justify-between gap-3"><span className="text-muted">Assigned organization</span><span className="text-right font-medium">{agent.assignedOrganization}</span></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted">Provider runtime</span><span className="text-right font-medium">{agent.providerRuntime}</span></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted">Employee enabled</span><span className="text-right font-medium">{agent.enabled ? "Yes" : "No"}</span></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted">Last recorded activity</span><span className="text-right font-medium">{agent.lastActivityAt ? relativeTime(agent.lastActivityAt) : "No runs yet"}</span></div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-faint">Changing the AI model or provider connection does not change this employee&apos;s conversations, knowledge or configuration history.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Safeguards</CardTitle>
              <CardDescription>These always apply and can&apos;t be changed by instructions.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-[13px] text-ink-2">
            {["Customer-facing actions wait for your approval", "Never invents bookings, prices or results", "Only works with your company's data", "Can't grant itself new tools or access"].map((s) => (
              <p key={s} className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /> {s}
              </p>
            ))}
            <div className="mt-3 rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">
              Pending approvals: <span className="font-semibold text-ink">{pendingApprovals}</span> ·{" "}
              <Link href="/approvals" className="text-primary hover:underline">
                Approval Center
              </Link>
              <br />
              Knowledge last applied: <span suppressHydrationWarning>{knowledgeAppliedAt ? relativeTime(knowledgeAppliedAt) : "not yet"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ConfigureTab({ meta, agent, settings, onSaved }: Props & { settings: AgentSettings; onSaved: () => void }) {
  const router = useRouter();
  const [s, setS] = React.useState<AgentSettings>(settings);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const set = <K extends keyof AgentSettings>(k: K, v: AgentSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    const res = await saveAgentSettingsAction(meta.key, s);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    if (res.data.status === "pending_agency_review") toast.warning("Saved for review", { description: "Part of the instructions looked like it could change safety rules, so iAcquire will review it first." });
    else toast.success(`Saved as configuration v${res.data.version}`, { description: "New conversations use it right away." });
    router.refresh();
    onSaved();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Communication</CardTitle>
              <CardDescription>How {agent.displayName} sounds.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field label="Name" htmlFor="cfg-name" hint="What your team calls this employee.">
              <Input id="cfg-name" value={s.displayName} maxLength={40} onChange={(e) => set("displayName", e.target.value)} />
            </Field>
            <div>
              <p className="mb-2 text-[13px] font-medium text-ink-2">Tone</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {TONES.map((t: Tone) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => set("tone", t)}
                    aria-pressed={s.tone === t}
                    className={cn("rounded-xl border p-3 text-left transition", s.tone === t ? "border-primary bg-primary-soft/50 ring-2 ring-primary/20" : "border-line hover:border-line-strong")}
                  >
                    <span className="flex items-center justify-between text-[13.5px] font-semibold">
                      {TONE_COPY[t].label} {s.tone === t && <Check className="size-4 text-primary" />}
                    </span>
                    <span className="mt-1 block text-[12.5px] italic text-muted">“{TONE_COPY[t].example}”</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[13px] font-medium text-ink-2">Reply length</p>
                <p className="text-[12.5px] text-muted">{LENGTH_COPY[s.replyLength].description}</p>
              </div>
              <Segmented
                id="cfg-length"
                ariaLabel="Reply length"
                value={s.replyLength}
                onChange={(v: ReplyLength) => set("replyLength", v)}
                options={(["concise", "balanced", "detailed"] as const).map((v) => ({ value: v, label: LENGTH_COPY[v].label }))}
              />
            </div>
            <Field label="Language" htmlFor="cfg-lang">
              <Select id="cfg-lang" value={s.language} onChange={(e) => set("language", e.target.value as AgentSettings["language"])}>
                {LANGUAGES.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </Select>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Role &amp; business focus</CardTitle>
              <CardDescription>Short answers are perfect. Leave anything blank to use sensible defaults.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {meta.questions.map((q) => (
              <Field key={q.id} label={q.label} htmlFor={`cfg-q-${q.id}`} optional>
                <Textarea id={`cfg-q-${q.id}`} rows={2} maxLength={1000} placeholder={q.placeholder} value={s.roleAnswers[q.id] ?? ""} onChange={(e) => set("roleAnswers", { ...s.roleAnswers, [q.id]: e.target.value })} />
              </Field>
            ))}
            <Field label="Main responsibilities" htmlFor="cfg-resp" optional>
              <Textarea id="cfg-resp" rows={2} maxLength={1000} value={s.responsibilities} onChange={(e) => set("responsibilities", e.target.value)} placeholder="e.g. Focus on commercial clients first" />
            </Field>
            <Field label="Goals for this employee" htmlFor="cfg-goals" optional>
              <Textarea id="cfg-goals" rows={2} maxLength={1000} value={s.goals} onChange={(e) => set("goals", e.target.value)} placeholder="e.g. Book 10 consultations a month" />
            </Field>
            <Field label="Target customers" htmlFor="cfg-target" optional>
              <Textarea id="cfg-target" rows={2} maxLength={1000} value={s.targetCustomers} onChange={(e) => set("targetCustomers", e.target.value)} />
            </Field>
            <Field label="A short instruction" htmlFor="cfg-custom" optional hint="Plain English, e.g. “Always mention our free inspection.”">
              <Input id="cfg-custom" maxLength={500} value={s.customInstruction} onChange={(e) => set("customInstruction", e.target.value)} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Rules &amp; escalation</CardTitle>
              <CardDescription>Boundaries for {agent.displayName}.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Company rules" htmlFor="cfg-rules" optional>
              <Textarea id="cfg-rules" rows={2} maxLength={1500} value={s.companyRules} onChange={(e) => set("companyRules", e.target.value)} placeholder="e.g. Never discuss competitors by name" />
            </Field>
            <Field label="Never promise" htmlFor="cfg-never" optional>
              <Textarea id="cfg-never" rows={2} maxLength={1000} value={s.neverPromise} onChange={(e) => set("neverPromise", e.target.value)} placeholder="e.g. Same-day service, exact prices before an inspection" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ask a human when…" htmlFor="cfg-esc" optional>
                <Input id="cfg-esc" maxLength={600} value={s.escalateWhen} onChange={(e) => set("escalateWhen", e.target.value)} placeholder="a customer is upset" />
              </Field>
              <Field label="Escalation contact" htmlFor="cfg-esc-contact" optional>
                <Input id="cfg-esc-contact" maxLength={200} value={s.escalationContact} onChange={(e) => set("escalationContact", e.target.value)} placeholder="Name and email" />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-line p-3.5">
              <div>
                <p className="text-[13.5px] font-medium">Ask before any business action</p>
                <p className="text-[12.5px] text-muted">When off, only customer-facing and high-impact actions need approval. Customer-facing actions always do.</p>
              </div>
              <Switch checked={s.approvalPreference === "always"} onCheckedChange={(v) => set("approvalPreference", v ? "always" : "high_impact")} aria-label="Ask before any business action" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Allowed actions</CardTitle>
              <CardDescription>Switch off anything you don&apos;t want {agent.displayName} to use.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="divide-y divide-line">
            {agent.defaultTools.map((t) => {
              const on = !s.disabledTools.includes(t);
              return (
                <div key={t} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="text-[13.5px]">{agentToolLabel(t)}</span>
                  <Switch checked={on} onCheckedChange={(v) => set("disabledTools", v ? s.disabledTools.filter((x) => x !== t) : [...s.disabledTools, t])} aria-label={agentToolLabel(t)} />
                </div>
              );
            })}
            <p className="py-3 text-[11.5px] leading-relaxed text-faint">
              Switching a tool off removes it from this employee&apos;s instructions. The provider profile&apos;s own
              tool restrictions and the connection health check remain the enforced boundary for what it can execute;
              a switch here is not a separate sandbox.
            </p>
          </CardContent>
        </Card>
      </div>
      <div className="lg:sticky lg:top-24 lg:self-start">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Save changes</CardTitle>
              <CardDescription>Creates a new version you can roll back.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" /> Your answers are kept separate from iAcquire&apos;s safety rules, so they can never change what the employee is allowed to do.
            </p>
            <Button variant="brand" className="w-full" disabled={!dirty || s.displayName.trim().length === 0} loading={saving} onClick={save}>
              Save &amp; apply
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => setTesting(true)}>
              Test this draft
            </Button>
            <Button variant="ghost" className="w-full" disabled={!dirty} onClick={() => setS(settings)}>
              Discard changes
            </Button>
            <p className="text-[11.5px] leading-relaxed text-faint">A test uses the real provider in an isolated session. It does not save this draft or change the live employee.</p>
          </CardContent>
        </Card>
      </div>
      <ConfigTestDialog
        open={testing}
        onOpenChange={setTesting}
        role={meta.key}
        agentName={s.displayName || agent.displayName}
        draft={s}
        activeVersion={agent.configVersion}
      />
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
    <Card className="max-w-3xl">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="size-4 text-violet" /> Describe a change in plain English
          </CardTitle>
          <CardDescription>We&apos;ll show exactly what will change before anything is applied.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <label htmlFor="change-text" className="sr-only">
          Change request
        </label>
        <Textarea id="change-text" rows={3} maxLength={1000} value={text} onChange={(e) => { setText(e.target.value); setProposal(null); }} placeholder={`e.g. ${examples[0]}`} />
        <div className="flex flex-wrap gap-2">
          {examples.map((e) => (
            <button key={e} type="button" onClick={() => { setText(e); setProposal(null); }} className="rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] text-ink-2 transition hover:border-primary/30 hover:text-ink">
              {e}
            </button>
          ))}
        </div>
        <Button variant="secondary" onClick={propose} loading={pending && !proposal} disabled={!text.trim()}>
          <Sparkles className="size-4" /> Preview change
        </Button>
        <AnimatePresence>
          {proposal && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-2xl border border-line bg-surface-2/60 p-4">
              {proposal.status === "refused" ? (
                <p className="flex items-start gap-2 text-[13.5px] text-warning-ink">
                  <XCircle className="mt-0.5 size-4 shrink-0" /> {proposal.refusal}
                </p>
              ) : proposal.status === "no_change" ? (
                <p className="text-[13.5px] text-muted">{proposal.explanations[0]}</p>
              ) : (
                <>
                  <p className="mb-2 text-[13px] font-semibold">What will change for {agent.displayName}</p>
                  <ul className="space-y-1.5">
                    {proposal.explanations.map((e) => (
                      <li key={e} className="flex items-start gap-2 text-[13.5px]">
                        <Check className="mt-0.5 size-4 shrink-0 text-success" /> {e}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 flex gap-2">
                    <Button variant="brand" onClick={apply} loading={pending}>
                      Apply change
                    </Button>
                    <Button variant="ghost" onClick={() => setProposal(null)}>
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

function HistoryTab({ meta, versions, timeZone }: Props) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState<Version | null>(null);
  const [pending, setPending] = React.useState(false);
  if (!versions.length) return <Card><CardContent className="py-12 text-center text-[13.5px] text-muted">No configuration versions yet.</CardContent></Card>;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <History className="size-4" /> Version history
          </CardTitle>
          <CardDescription>Every change is kept. Restoring an older version creates a new one.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="relative space-y-5 border-l border-line pl-5">
          {versions.map((v) => (
            <li key={v.id} className="relative">
              <span className={cn("absolute -left-[26px] top-1 size-3 rounded-full ring-4 ring-surface", v.status === "applied" ? "bg-success" : v.status === "pending_agency_review" ? "bg-warning" : v.status === "rejected" ? "bg-danger" : "bg-surface-3")} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold">v{v.version}</span>
                <Badge tone={v.status === "applied" ? "success" : v.status === "pending_agency_review" ? "warning" : v.status === "rejected" ? "danger" : "neutral"}>
                  {v.status === "applied" ? "Active" : v.status === "pending_agency_review" ? "Awaiting iAcquire review" : sentenceCase(v.status)}
                </Badge>
                <span className="text-[12px] text-muted">
                  {sentenceCase(v.source)} · {v.created_by_name ?? "System"} · {formatDateTime(v.created_at, timeZone)}
                </span>
              </div>
              {v.change_request && <p className="mt-1 text-[13px] italic text-ink-2">“{v.change_request}”</p>}
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{v.summary}</p>
              {v.status === "superseded" && (
                <Tooltip content="Creates a new version with these settings">
                  <Button size="sm" variant="ghost" className="mt-1 -ml-2" onClick={() => setConfirm(v)}>
                    <RotateCcw className="size-3.5" /> Restore
                  </Button>
                </Tooltip>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Restore version ${confirm?.version}?`}
        description="The current settings stay in history, so you can switch back later."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              loading={pending}
              onClick={async () => {
                if (!confirm) return;
                setPending(true);
                const res = await rollbackAction(meta.key, confirm.id);
                setPending(false);
                if (!res.ok) return toast.error(res.error);
                toast.success(`Restored as v${res.data.version}`);
                setConfirm(null);
                router.refresh();
              }}
            >
              Restore
            </Button>
          </>
        }
      />
    </Card>
  );
}

function ActivityTab({ runs, timeZone,meta,agent,canChat:canUse }: Props) {
  if (!runs.length) return <Card className="surface-tint"><CardContent className="flex flex-col items-start gap-4 py-7 sm:flex-row sm:items-center"><AgentAvatar role={meta} size="lg"/><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[.15em] text-primary">Employee activity</p><h3 className="mt-2 text-[19px] font-semibold tracking-tight">No recorded runs yet</h3><p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted">Conversations and tool activity appear here after {agent.displayName} starts working. This view only shows saved run records.</p></div>{canUse&&<ButtonLink href={agent.enabled&&canChat(agent.status)?`/chat/${meta.slug}`:"/setup"} variant="secondary">{agent.enabled&&canChat(agent.status)?"Open chat":"Review setup"}</ButtonLink>}</CardContent></Card>;
  return (
    <Card className="overflow-hidden">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
            <tr>
              <th className="px-5 py-3 font-medium">Started</th>
              <th className="px-3 py-3 font-medium">Type</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 text-right font-medium">Tool steps</th>
              <th className="px-5 py-3 text-right font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="px-5 py-2.5">{formatDateTime(r.started_at, timeZone)}</td>
                <td className="px-3 py-2.5">{r.purpose === "lead_research" ? "Lead research" : "Conversation"}</td>
                <td className="px-3 py-2.5">
                  <Badge tone={r.status === "completed" ? "success" : r.status === "cancelled" ? "neutral" : r.status === "running" ? "primary" : "danger"}>{sentenceCase(r.status)}</Badge>
                  {r.error_message && <span className="ml-2 text-[12px] text-muted">{r.error_message}</span>}
                </td>
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
