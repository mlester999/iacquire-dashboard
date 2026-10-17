"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Activity, ArrowLeft, Ban, Banknote, BookOpen, Briefcase, Building2, CalendarDays, CheckCircle2, ChevronDown, CircleDashed, ClipboardCheck, Clock, Cpu, Database, DoorClosed, ExternalLink, FileCode2, Gauge, Globe, KeyRound, LifeBuoy, Link2, Lock, Mail, MessageSquareQuote, Plug, PlayCircle, Receipt, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles, Stethoscope, TriangleAlert, UserCheck, UserPlus, Users, Workflow, Copy } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardContent, EmptyState, Field, Input, ProgressBar, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Switch, Tabs } from "@/components/ui/overlays";
import { AvatarTile, InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { Callout, DetailList, DetailRow, HeroIdentity, IconTile, SectionHead, StatTile, roleTone } from "@/components/admin/setup/ui";
import { ResendInvitationButton, deliverySummary } from "@/components/admin/resend-invitation";
import {
  assignStaffAction,
  connectHermesAction,
  decideHeldKnowledgeAction,
  decideHeldVersionAction,
  healthCheckAction,
  inviteClientUserAction,
  provisioningBundleAction,
  revokeInvitationAction,
  setAgentEnabledAction,
  setGhlMappingAction,
  setTenantStatusAction,
  syncGhlAction,
  updateBillingAction,
  updateProvisioningJobAction,
  updateUsageLimitsAction,
  verifyGhlAction,
} from "@/app/(admin)/admin/actions";
import type { TenantDetail } from "@/server/admin/queries";
import type { ProvisioningBundle } from "@/server/workforce/provisioning";
import { AGENT_BY_KEY, AGENT_STATUS_LABEL, type AgentStatus } from "@/lib/agents";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, relativeTime, sentenceCase } from "@/lib/utils";

type Detail = TenantDetail;

function useAction() {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const run = async <T,>(key: string, fn: () => Promise<{ ok: true; data?: T } | { ok: false; error: string }>, success?: string | ((d: T | undefined) => string)) => {
    setPending(key);
    try {
    const res = await fn();
    setPending(null);
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    if (success) toast.success(typeof success === "function" ? success(res.data) : success);
    router.refresh();
    return res;
    } catch { toast.error("The change could not be saved. Please try again.");return null; }
    finally {setPending(null);}
  };
  return { pending, run };
}

export function ClientDetail({ data, superAdmin, initialTab, timeZone }: { data: Detail; superAdmin: boolean; initialTab: string; timeZone: string }) {
  const visibleTabs = ["overview", ...(data.access.workforce ? ["workforce", "reviews"] : []), ...(data.access.integrations ? ["integrations"] : []), "usage", ...(data.access.setup ? ["billing"] : []), ...(data.access.team ? ["team"] : [])];
  const [tab, setTab] = React.useState(visibleTabs.includes(initialTab) ? initialTab : "overview");
  const activeTab = visibleTabs.includes(tab) ? tab : "overview";
  const held = data.heldVersions.length + data.heldKnowledge.length;
  // The owner's pending invitation (expired ones included) can be re-sent straight from the header.
  const ownerInvite = data.invitations.find((i) => i.role === "owner") ?? null;
  const enabledAgents = data.agents.filter((a) => a.enabled).length;
  const activeMembers = data.members.filter((m) => m.status === "active").length;
  const assignedStaff = data.staff.filter((s) => s.assigned).length;
  return (
    <div className="module-stack">
        <Link href="/admin/clients" className="inline-flex min-h-10 items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-ink">
          <ArrowLeft className="size-3.5" /> Clients
        </Link>
        <PageHero
          eyebrow="Client workspace"
          icon={<Building2 className="size-5" />}
          title={data.org.name}
          description={
            <div className="flex flex-wrap items-center gap-2">
              <InfoChip icon={<Briefcase />}>{data.org.industry ?? "Industry not set"}</InfoChip>
              <InfoChip icon={<Globe />}>{data.org.timezone.replaceAll("_", " ")}</InfoChip>
              <InfoChip icon={<CalendarDays />}>Registered {formatDate(data.org.created_at, timeZone)}</InfoChip>
              <InfoChip icon={<Lock />}>Private, tenant-scoped workspace</InfoChip>
            </div>
          }
          aside={
            <HeroIdentity name={data.org.name} label="Workspace status">
              <StatusPill status={data.org.status} />
              {data.org.is_demo && <StatusPill tone="violet" dot={false} icon={<Sparkles className="size-3" />}>Demo data</StatusPill>}
            </HeroIdentity>
          }
          action={
            <>
              {data.access.setup && <ButtonLink href={`/admin/clients/${data.org.id}/setup`} variant="brand" size="sm">
                <ClipboardCheck className="size-4" /> Setup manager
              </ButtonLink>}
              {superAdmin && ownerInvite && <ResendInvitationButton orgId={data.org.id} invitation={ownerInvite} label="Resend invite" />}
              {data.access.integrations && <ButtonLink href={`/admin/clients/${data.org.id}/integrations`} variant="secondary" size="sm"><KeyRound className="size-4" /> Secure integrations</ButtonLink>}
              <ButtonLink href={`/admin/clients/${data.org.id}/website`} variant="secondary" size="sm"><Globe className="size-4" /> Website</ButtonLink>
              <ButtonLink href={`/admin/clients/${data.org.id}/activation`} variant="secondary" size="sm"><ShieldCheck className="size-4" /> Readiness review</ButtonLink>
              {superAdmin && <ButtonLink href={`/admin/clients/${data.org.id}/offboarding`} variant="secondary" size="sm"><DoorClosed className="size-4" /> Offboarding</ButtonLink>}
            </>
          }
        >
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {([
              ...(data.access.team ? [{ label: "Client team", value: activeMembers, icon: <Users />, tone: "primary" as const }] : []),
              ...(data.access.workforce ? [
                { label: "Included AI employees", value: enabledAgents, icon: <Sparkles />, tone: "violet" as const },
                { label: "Awaiting review", value: held, icon: <ClipboardCheck />, tone: held > 0 ? "warning" as const : "success" as const },
                { label: "Assigned agency staff", value: assignedStaff, icon: <UserCheck />, tone: "primary" as const },
              ] : []),
            ] as Array<{ label: string; value: number; icon: React.ReactNode; tone: StatusTone }>).map((s) => (
              <StatTile key={s.label} label={s.label} value={s.value} icon={s.icon} tone={s.tone} />
            ))}
          </dl>
        </PageHero>
      <Tabs
        id="client-tabs"
        value={activeTab}
        onValueChange={setTab}
        items={[
          { value: "overview", label: "Overview" },
          ...(data.access.workforce ? [
            { value: "workforce", label: "AI workforce", count: enabledAgents || undefined },
            { value: "reviews", label: "Reviews", count: held || undefined },
          ] : []),
          ...(data.access.integrations ? [{ value: "integrations", label: "Integrations" }] : []),
          { value: "usage", label: "Usage & limits" },
          ...(data.access.setup ? [{ value: "billing", label: "Billing" }] : []),
          ...(data.access.team ? [{ value: "team", label: "Team & staff", count: activeMembers + data.invitations.length || undefined }] : []),
        ]}
      >
      <motion.div key={activeTab} initial={false} animate={{opacity:1,y:0}} transition={{duration:.2}} className="page-in min-w-0">
      {activeTab === "overview" && <OverviewTab data={data} superAdmin={superAdmin} timeZone={timeZone} />}
      {activeTab === "workforce" && data.access.workforce && <WorkforceTab data={data} superAdmin={superAdmin} />}
      {activeTab === "reviews" && data.access.workforce && <ReviewsTab data={data} />}
      {activeTab === "integrations" && data.access.integrations && <IntegrationsTab data={data} superAdmin={superAdmin} />}
      {activeTab === "usage" && <UsageTab data={data} superAdmin={superAdmin} />}
      {activeTab === "billing" && data.access.setup && <BillingTab data={data} superAdmin={superAdmin} timeZone={timeZone} />}
      {activeTab === "team" && data.access.team && <TeamTab data={data} superAdmin={superAdmin} />}
      </motion.div>
      </Tabs>
    </div>
  );
}

/** Link text for a website value: strips the scheme and trailing slash so it reads as a hostname. */
function hostLabel(url: string) {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function OverviewTab({ data, superAdmin, timeZone }: { data: Detail; superAdmin: boolean; timeZone: string }) {
  const { run, pending } = useAction();
  const [reason, setReason] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const online = data.agents.filter((a) => a.enabled && a.status === "online").length;
  const enabled = data.agents.filter((a) => a.enabled).length;
  const owner = data.members.find((m) => m.role === "owner") ?? null;
  const suspended = data.org.status === "suspended";
  const milestones: Array<{ label: string; hint: string; done: boolean }> = [
    ...(data.access.team ? [{ label: "Owner accepted invitation", done: Boolean(owner), hint: owner ? owner.full_name || owner.email : "Waiting for the owner to accept" }] : []),
    { label: "Onboarding completed", done: Boolean(data.org.onboarding_completed_at), hint: data.org.onboarding_completed_at ? `Submitted ${formatDate(data.org.onboarding_completed_at, timeZone)}` : "The company questionnaire has not been submitted" },
    ...(data.access.workforce ? [{ label: `Employees online (${online}/${enabled})`, done: enabled > 0 && online === enabled, hint: enabled === 0 ? "No AI employees are enabled" : online === enabled ? "Every enabled employee passed its health check" : `${enabled - online} enabled ${enabled - online === 1 ? "employee is" : "employees are"} not online` }] : []),
    ...(data.access.integrations ? [{ label: "CRM location verified", done: data.ghl?.status === "connected", hint: data.ghl ? data.ghl.location_name || `Location ${data.ghl.location_id}` : "No CRM location is mapped yet" }] : []),
    ...(data.access.setup ? [{ label: "Setup fee paid or waived", done: ["paid", "waived"].includes(data.billing?.setup_payment_status ?? ""), hint: sentenceCase(data.billing?.setup_payment_status ?? "not_invoiced") }] : []),
  ];
  const doneCount = milestones.filter((m) => m.done).length;
  return (
    <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
      <Card className="overflow-hidden lg:col-span-2">
        <SectionHead icon={<ClipboardCheck />} title="Workspace essentials" description="The key account milestones recorded for this client." aside={<StatusPill tone={doneCount === milestones.length ? "success" : "primary"}>{doneCount} of {milestones.length} recorded</StatusPill>} />
        <CardContent className="space-y-3">
          <ProgressBar value={(doneCount / milestones.length) * 100} tone={doneCount === milestones.length ? "success" : "primary"} label="Milestones recorded" className="h-1.5" />
          <ul className="space-y-2.5">
            {milestones.map((m) => (
              <li key={m.label} className={cn("flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors", m.done ? "border-success/15 bg-success-soft/35" : "border-line bg-surface-2/50")}>
                {m.done ? <CheckCircle2 aria-hidden className="size-5 shrink-0 text-success" /> : <CircleDashed aria-hidden className="size-5 shrink-0 text-faint" />}
                <div className="min-w-0 flex-1">
                  <p className={cn("text-[13.5px] font-medium", m.done ? "text-ink" : "text-ink-2")}>{m.label}</p>
                  <p className="mt-0.5 truncate text-[12px] text-muted" title={m.hint}>{m.hint}</p>
                </div>
                {m.done ? <StatusPill tone="success" size="sm">Recorded</StatusPill> : <StatusPill status="pending" size="sm" />}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card className={cn("self-start", suspended ? "border-danger/25 bg-danger-soft/15" : "border-primary/15 bg-primary-soft/20")}>
        <SectionHead icon={suspended ? <Ban /> : <ShieldCheck />} tone={suspended ? "danger" : "success"} title="Workspace access" description="Suspending blocks every client user immediately." />
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-xl bg-surface/80 px-3.5 py-2.5 ring-1 ring-inset ring-line">
            <span className="text-[12.5px] font-medium text-muted">Access</span>
            <StatusPill tone={suspended ? "danger" : "success"}>{suspended ? "Suspended" : "Active"}</StatusPill>
          </div>
          {suspended ? (
            <>
              <Callout tone="danger" icon={<Ban />} title="Suspended">
                {data.org.suspended_reason?.trim() || "No reason was recorded."}
              </Callout>
              {superAdmin && (
                <Button className="w-full" loading={pending === "reactivate"} onClick={() => run("reactivate", () => setTenantStatusAction(data.org.id, "active"), "Workspace reactivated")}>
                  Reactivate workspace
                </Button>
              )}
            </>
          ) : superAdmin ? (
            <Button variant="outline" className="w-full text-danger-ink" onClick={() => setConfirm(true)}>
              <Ban className="size-4" /> Suspend access
            </Button>
          ) : (
            <Callout tone="neutral" icon={<Lock />}>Only super admins can suspend workspaces.</Callout>
          )}
          <DetailList>
            <DetailRow label="Owner">
              {owner ? (
                <>
                  <AvatarTile name={owner.full_name || owner.email} size="sm" className="size-6 rounded-md text-[9px]" />
                  <span className="truncate" title={owner.email}>{owner.full_name || owner.email}</span>
                </>
              ) : (
                <StatusPill status="pending" size="sm">Invite pending</StatusPill>
              )}
            </DetailRow>
            <DetailRow label="Website">
              {data.org.website ? (
                <span className="truncate text-ink-2" title={data.org.website}>{hostLabel(data.org.website)}</span>
              ) : (
                <StatusPill tone="neutral" size="sm" dot={false}>Not set</StatusPill>
              )}
            </DetailRow>
            <DetailRow label="Workspace ID" mono>
              <span className="truncate" title={data.org.slug}>{data.org.slug}</span>
            </DetailRow>
          </DetailList>
        </CardContent>
      </Card>
      <Card className="lg:col-span-3">
        <SectionHead icon={<TriangleAlert />} tone={data.failedRuns.length ? "danger" : "success"} title="Recent failed AI runs" description="Sanitized execution status only — message content is private to the client." aside={data.failedRuns.length > 0 && <StatusPill tone="danger">{data.failedRuns.length} failed</StatusPill>} />
        <CardContent>
          {data.failedRuns.length === 0 ? (
            <EmptyState compact icon={<CheckCircle2 className="size-5 text-success" />} title="No failed runs recorded." description="Execution issues will appear here with sanitized diagnostics when they occur." />
          ) : (
            <ul className="divide-y divide-line">
              {data.failedRuns.map((r) => {
                const message = r.error_message ?? (r.error_code ? sentenceCase(r.error_code) : "No details were recorded.");
                return (
                  <li key={r.id} className="management-row -mx-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-3">
                    <AgentAvatar role={AGENT_BY_KEY[r.agent_role]} size="sm" />
                    <div className="min-w-0 flex-1 basis-56">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13.5px] font-semibold text-ink">{AGENT_BY_KEY[r.agent_role].shortName}</span>
                        <StatusPill tone="danger" size="sm">Failed</StatusPill>
                        {r.error_code && <InfoChip className="font-mono text-[11px]">{r.error_code}</InfoChip>}
                      </div>
                      <p className="mt-1 truncate text-[12.5px] text-muted" title={message}>{message}</p>
                    </div>
                    {r.finished_at && <InfoChip icon={<Clock />}><span suppressHydrationWarning>{relativeTime(r.finished_at)}</span></InfoChip>}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Suspend ${data.org.name}?`}
        description="Client users lose access until the workspace is reactivated. Data is kept."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={pending === "suspend"}
              onClick={async () => {
                const ok = await run("suspend", () => setTenantStatusAction(data.org.id, "suspended", reason), "Workspace suspended");
                if (ok) setConfirm(false);
              }}
            >
              Suspend
            </Button>
          </>
        }
      >
        <Field label="Reason (visible to agency staff)" htmlFor="suspend-reason">
          <Textarea id="suspend-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
        </Field>
      </Dialog>
    </div>
  );
}

/** Employee states on the shared tones: green when live, red when broken, violet while being set up, neutral otherwise. */
const AGENT_TONE: Record<AgentStatus, StatusTone> = {
  online: "success",
  busy: "warning",
  provisioning: "violet",
  setup_required: "neutral",
  offline: "danger",
  error: "danger",
  disabled: "neutral",
};

function WorkforceTab({ data, superAdmin }: { data: Detail; superAdmin: boolean }) {
  const { run, pending } = useAction();
  const [connectFor, setConnectFor] = React.useState<Detail["agents"][number] | null>(null);
  const [bundle, setBundle] = React.useState<ProvisioningBundle | null>(null);
  return (
    <div className="space-y-6">
      <details className="group card-surface rounded-2xl border-primary/20 bg-primary-soft/30">
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 text-[13.5px] font-medium text-primary-ink transition-colors hover:bg-primary-soft/40 [&::-webkit-details-marker]:hidden">
          <IconTile icon={<ShieldAlert />} tone="primary" size="sm" />
          <span className="min-w-0 flex-1">Dedicated identities and restricted tool access</span>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <p className="border-t border-primary/15 px-4 py-3.5 text-[13px] leading-relaxed text-ink-2">
          Each employee needs its own <strong>blank</strong> Hermes profile (never a clone of an internal <code>iacquire-*</code> profile) and its own API key. Hermes profiles don&apos;t sandbox the agent on the
          local terminal backend, so the portal only marks an employee online after an authenticated capabilities check <em>and</em> a toolsets check showing no shell, file or code tools.
        </p>
      </details>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
        {data.agents.map((a) => {
          const meta = AGENT_BY_KEY[a.role_key];
          const status: AgentStatus = a.enabled ? a.status : "disabled";
          const healthTone: StatusTone = status === "online" ? "success" : status === "offline" || status === "error" ? "danger" : "neutral";
          return (
            <Card key={a.id} className={cn("relative flex flex-col overflow-hidden transition hover:border-primary/25", !a.enabled && "opacity-70")}>
              <div aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{background:meta.accent}}/>
              <CardContent className="flex flex-1 flex-col gap-3.5 pt-5">
                <div className="flex items-center gap-3">
                  <AgentAvatar role={meta} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14.5px] font-semibold tracking-tight text-ink" title={a.display_name}>{a.display_name}</p>
                    <div className="mt-1.5"><StatusPill tone={AGENT_TONE[status]} size="sm">{AGENT_STATUS_LABEL[status]}</StatusPill></div>
                  </div>
                  {superAdmin && (
                    <Switch
                      checked={a.enabled}
                      aria-label={`${a.enabled ? "Disable" : "Enable"} ${meta.shortName}`}
                      onCheckedChange={(v) => run(`en-${a.id}`, () => setAgentEnabledAction(data.org.id, a.id, v), v ? "Employee enabled" : "Employee disabled")}
                    />
                  )}
                </div>
                <p className="text-[12.5px] leading-relaxed text-muted md:min-h-10">{meta.tagline}</p>
                <DetailList>
                  <DetailRow label="Hermes profile" mono>
                    <span className="truncate" title={a.hermes_profile ?? undefined}>{a.hermes_profile ?? "—"}</span>
                  </DetailRow>
                  <DetailRow label="Host" mono>
                    <span className="truncate" title={a.hermes_host ?? undefined}>{a.hermes_host ?? "—"}</span>
                  </DetailRow>
                  <DetailRow label="Config">
                    {a.config_version ? <InfoChip>v{a.config_version}</InfoChip> : <StatusPill tone="neutral" size="sm">Not configured</StatusPill>}
                  </DetailRow>
                  <DetailRow label="Runs (30d)">
                    <span className="tabular-nums">{formatNumber(a.runs_30d)}</span>
                    {a.failed_30d > 0 && <StatusPill tone="danger" size="sm">{formatNumber(a.failed_30d)} failed</StatusPill>}
                  </DetailRow>
                  <DetailRow label="Last check">
                    {a.last_health_check_at ? <span title={formatDateTime(a.last_health_check_at)} suppressHydrationWarning>{relativeTime(a.last_health_check_at)}</span> : <StatusPill tone="neutral" size="sm">Never</StatusPill>}
                  </DetailRow>
                </DetailList>
                {a.last_health_detail && (
                  <Callout tone={healthTone} icon={<Stethoscope />} className="py-2.5 text-[12.5px]">
                    {a.last_health_detail}
                  </Callout>
                )}
                <div className="mt-auto grid grid-cols-1 gap-2 pt-1 min-[420px]:grid-cols-2 xl:grid-cols-3 [&>button]:w-full [&>button]:px-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      const res = await provisioningBundleAction(a.id);
                      if (res.ok) setBundle(res.data);
                      else toast.error(res.error);
                    }}
                  >
                    <FileCode2 className="size-3.5" /> Runbook
                  </Button>
                  {superAdmin && a.enabled && (
                    <Button size="sm" variant="secondary" onClick={() => setConnectFor(a)}>
                      <KeyRound className="size-3.5" /> {a.has_credential ? "Reconnect" : "Connect"}
                    </Button>
                  )}
                  {a.has_credential && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={pending === `hc-${a.id}`}
                      onClick={() => run(`hc-${a.id}`, () => healthCheckAction(a.id), (d) => (d && "status" in (d as object) ? `Health check: ${(d as { status: string }).status.replace("_", " ")}` : "Health check complete"))}
                    >
                      <Stethoscope className="size-3.5" /> Health check
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <SectionHead icon={<Workflow />} tone="violet" title="Provisioning requests" description="Opened automatically when onboarding completes. Close the loop with a successful health check." aside={data.provisioning.length > 0 && <InfoChip>{data.provisioning.length} {data.provisioning.length === 1 ? "request" : "requests"}</InfoChip>} />
        <CardContent>
          {data.provisioning.length === 0 ? (
            <EmptyState compact icon={<Workflow className="size-5" />} title="No provisioning requests" description="Requests are opened automatically when a client completes onboarding." />
          ) : (
            <ul className="divide-y divide-line">
              {data.provisioning.map((j) => (
                <li key={j.id} className="management-row -mx-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-3">
                  <AgentAvatar role={AGENT_BY_KEY[j.agent_role]} size="sm" />
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-ink">{AGENT_BY_KEY[j.agent_role].shortName}</span>
                      <StatusPill status={j.status} size="sm" />
                    </div>
                    {j.detail && <p className="mt-1 line-clamp-2 text-[12.5px] text-muted" title={j.detail}>{j.detail}</p>}
                  </div>
                  <InfoChip icon={<Clock />}><span suppressHydrationWarning>{relativeTime(j.created_at)}</span></InfoChip>
                  {j.status === "requested" && (
                    <Button size="sm" variant="secondary" onClick={() => run(`job-${j.id}`, () => updateProvisioningJobAction(data.org.id, j.id, "in_progress"), "Marked in progress")}>
                      <PlayCircle className="size-3.5" /> Start
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConnectDialog key={connectFor?.id ?? "none"} agent={connectFor} onClose={() => setConnectFor(null)} />
      <BundleDialog bundle={bundle} onClose={() => setBundle(null)} />
    </div>
  );
}

function ConnectDialog({ agent, onClose }: { agent: Detail["agents"][number] | null; onClose: () => void }) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = React.useState("");
  // Remounted per agent (keyed by the parent), so the form always starts from that agent's values.
  const [profile, setProfile] = React.useState(agent?.hermes_profile ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [pending, setPending] = React.useState(false);
  return (
    <Dialog
      open={Boolean(agent)}
      onOpenChange={(o) => !o && onClose()}
      title={`Connect ${agent ? AGENT_BY_KEY[agent.role_key].shortName : ""}`}
      description="The key is encrypted at rest and never shown again. The portal runs an authenticated health check immediately."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            loading={pending}
            disabled={!baseUrl || !profile || apiKey.length < 24}
            onClick={async () => {
              if (!agent) return;
              setPending(true);
              const res = await connectHermesAction(agent.id, { baseUrl, profile, apiKey });
              setPending(false);
              setApiKey("");
              if (!res.ok) return toast.error(res.error);
              if (res.data.ok) toast.success("Connected and online");
              else toast.warning(`Connected, but not online: ${res.data.detail}`);
              router.refresh();
              onClose();
            }}
          >
            Connect &amp; check
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Hermes API base URL" htmlFor="h-url" hint="The gateway's API listener, e.g. https://hermes.example.com (HTTPS required).">
          <Input id="h-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" autoComplete="off" />
        </Field>
        <Field label="Profile name" htmlFor="h-profile" hint="Served under /p/<profile>/ by the multiplexed gateway. Internal iacquire-* profiles are refused.">
          <Input id="h-profile" value={profile} onChange={(e) => setProfile(e.target.value)} autoComplete="off" className="font-mono" />
        </Field>
        <Field label="Profile API_SERVER_KEY" htmlFor="h-key" hint="This profile's own key — never the default profile's key.">
          <Input id="h-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" className="font-mono" />
        </Field>
      </div>
    </Dialog>
  );
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[12.5px] font-medium text-ink-2">{label}</p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          }}
        >
          <Copy className="size-3.5" /> Copy
        </Button>
      </div>
      <pre className="scrollbar-thin max-h-64 overflow-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-ink">{value}</pre>
    </div>
  );
}

function BundleDialog({ bundle, onClose }: { bundle: ProvisioningBundle | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(bundle)} onOpenChange={(o) => !o && onClose()} title={`Provisioning runbook · ${bundle?.profile ?? ""}`} description="Run these steps on the Hermes host. The portal never changes Hermes itself." size="xl">
      {bundle && (
        <div className="space-y-5">
          <ol className="space-y-3">
            {bundle.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-semibold tabular-nums text-primary-ink ring-1 ring-inset ring-primary/15">{i + 1}</span>
                <div className="min-w-0 space-y-1.5">
                  <p className="text-[13.5px] font-medium">{s.title}</p>
                  {s.note && <p className="text-[12.5px] text-muted">{s.note}</p>}
                  {s.command && <pre className="scrollbar-thin overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[12px]">{s.command}</pre>}
                </div>
              </li>
            ))}
          </ol>
          <CodeBlock label="SOUL.md" value={bundle.soul} />
          <CodeBlock label="config.yaml (merge)" value={bundle.configYaml} />
          <CodeBlock label=".env lines" value={bundle.envTemplate} />
          <Callout tone="primary" icon={<ShieldCheck />} title="Online only when:" className="text-[12.5px]">
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
              {bundle.verification.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}
    </Dialog>
  );
}

function RiskFlags({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {flags.map((f) => (
        <StatusPill key={f} tone="warning" size="sm" dot={false} icon={<TriangleAlert className="size-3" />}>
          {sentenceCase(f)}
        </StatusPill>
      ))}
    </div>
  );
}

function ReviewsTab({ data }: { data: Detail }) {
  const { run, pending } = useAction();
  if (!data.heldVersions.length && !data.heldKnowledge.length) {
    return (
      <Card>
        <EmptyState icon={<CheckCircle2 className="size-5 text-success" />} title="The review queue is clear." description="Held employee configurations and knowledge changes will appear here when agency review is needed." />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {data.heldVersions.map((v) => (
        <Card key={v.id} className="overflow-hidden">
          <div aria-hidden className="h-0.5 bg-warning" />
          <CardContent className="space-y-4 pt-5">
            <div className="flex items-start gap-3">
              <AgentAvatar role={AGENT_BY_KEY[v.agent_role]} size="md" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[14.5px] font-semibold tracking-tight">{AGENT_BY_KEY[v.agent_role].shortName} configuration</p>
                  <InfoChip>v{v.version}</InfoChip>
                  <StatusPill status="pending_review" size="sm">Held for review</StatusPill>
                </div>
                <RiskFlags flags={v.risk_flags} />
              </div>
              <InfoChip icon={<Clock />} className="hidden sm:inline-flex"><span suppressHydrationWarning>{relativeTime(v.created_at)}</span></InfoChip>
            </div>
            {v.change_request && (
              <Callout tone="neutral" icon={<MessageSquareQuote />} title="Requested change">
                “{v.change_request}”
              </Callout>
            )}
            <p className="text-[13px] leading-relaxed text-ink-2">{v.summary}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={pending === `a-${v.id}`} onClick={() => run(`a-${v.id}`, () => decideHeldVersionAction(data.org.id, v.id, true), "Approved and applied")}>
                Approve &amp; apply
              </Button>
              <Button size="sm" variant="secondary" loading={pending === `r-${v.id}`} onClick={() => run(`r-${v.id}`, () => decideHeldVersionAction(data.org.id, v.id, false), "Rejected")}>
                Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      {data.heldKnowledge.map((k) => (
        <Card key={k.section} className="overflow-hidden">
          <div aria-hidden className="h-0.5 bg-warning" />
          <CardContent className="space-y-4 pt-5">
            <div className="flex items-start gap-3">
              <IconTile icon={<BookOpen />} tone="violet" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[14.5px] font-semibold tracking-tight">Knowledge · {sentenceCase(k.section)}</p>
                  <StatusPill status="pending_review" size="sm">Held for review</StatusPill>
                </div>
                <RiskFlags flags={k.risk_flags} />
              </div>
              <InfoChip icon={<Clock />} className="hidden sm:inline-flex"><span suppressHydrationWarning>{relativeTime(k.updated_at)}</span></InfoChip>
            </div>
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-[12.5px] ring-1 ring-inset ring-line">{k.content}</pre>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={pending === `k-${k.section}`} onClick={() => run(`k-${k.section}`, () => decideHeldKnowledgeAction(data.org.id, k.section, true), "Approved")}>
                Approve
              </Button>
              <Button size="sm" variant="secondary" loading={pending === `kr-${k.section}`} onClick={() => run(`kr-${k.section}`, () => decideHeldKnowledgeAction(data.org.id, k.section, false), "Rejected")}>
                Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const PROVIDER: Record<string, { label: string; icon: React.ReactNode }> = {
  ghl: { label: "GoHighLevel CRM", icon: <Database /> },
  ghl_calendar: { label: "GHL calendar", icon: <CalendarDays /> },
  hermes: { label: "Hermes", icon: <Cpu /> },
  n8n: { label: "n8n", icon: <Workflow /> },
};

function IntegrationsTab({ data, superAdmin }: { data: Detail; superAdmin: boolean }) {
  const { run, pending } = useAction();
  const [locationId, setLocationId] = React.useState(data.ghl?.location_id ?? "");
  const [locationName, setLocationName] = React.useState(data.ghl?.location_name ?? "");
  const [pipelineId, setPipelineId] = React.useState(data.ghl?.pipeline_id ?? "");
  const [calendarIds, setCalendarIds] = React.useState((data.ghl?.calendar_ids ?? []).join(", "));
  const [token, setToken] = React.useState("");
  return (
    <div className="grid gap-6 lg:grid-cols-5 [&>*]:min-w-0">
      <Card className="lg:col-span-3">
        <SectionHead icon={<Database />} tone="primary" title="GoHighLevel location" description="Stored server-side only. The Aster Homes location and iAcquire&apos;s internal location are refused." aside={data.ghl ? <StatusPill status={data.ghl.status} /> : <StatusPill status="not_connected" />} />
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location ID" htmlFor="g-loc">
              <Input id="g-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!superAdmin} className="font-mono" />
            </Field>
            <Field label="Location name" htmlFor="g-name" optional>
              <Input id="g-name" value={locationName} onChange={(e) => setLocationName(e.target.value)} disabled={!superAdmin} />
            </Field>
            <Field label="Pipeline ID" htmlFor="g-pipe" optional>
              <Input id="g-pipe" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} disabled={!superAdmin} className="font-mono" />
            </Field>
            <Field label="Calendar IDs" htmlFor="g-cal" optional hint="Comma-separated.">
              <Input id="g-cal" value={calendarIds} onChange={(e) => setCalendarIds(e.target.value)} disabled={!superAdmin} className="font-mono" />
            </Field>
          </div>
          {superAdmin && (
            <Field
              label="Location-scoped private integration token"
              htmlFor="g-token"
              optional={Boolean(data.ghl?.has_credential)}
              hint="Read scopes: locations.readonly (identity), opportunities.readonly, calendars.readonly, calendars/events.readonly. Never an agency-level token."
            >
              <Input id="g-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={data.ghl?.has_credential ? "Stored — leave blank to keep" : ""} autoComplete="new-password" />
            </Field>
          )}
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {superAdmin && (
              <Button
                loading={pending === "map"}
                onClick={async () => {
                  await run("map", () => setGhlMappingAction(data.org.id, { locationId, locationName, pipelineId, calendarIds, token }), "Mapping saved");
                  setToken("");
                }}
              >
                <Link2 className="size-4" /> Save mapping
              </Button>
            )}
            {data.ghl && (
              <>
                <Button variant="secondary" loading={pending === "verify"} onClick={() => run("verify", () => verifyGhlAction(data.org.id), (d) => (d as { detail: string } | undefined)?.detail ?? "Checked")}>
                  <Stethoscope className="size-4" /> Verify
                </Button>
                <Button variant="secondary" loading={pending === "sync"} onClick={() => run("sync", () => syncGhlAction(data.org.id), (d) => (d as { detail: string } | undefined)?.detail ?? "Synced")}>
                  <RefreshCw className="size-4" /> Sync now
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <SectionHead icon={<Plug />} tone="violet" title="Integration status" description="Last recorded checks for this client." />
        <CardContent>
          {data.integrations.length === 0 ? (
            <EmptyState compact icon={<Plug className="size-5" />} title="No checks recorded" description="Connection checks appear here once an integration has been verified." />
          ) : (
            <ul className="divide-y divide-line">
              {data.integrations.map((i) => {
                const meta = PROVIDER[i.provider] ?? { label: sentenceCase(i.provider), icon: <Plug /> };
                const tone: StatusTone = i.status === "error" ? "danger" : i.status === "connected" ? "success" : i.status === "pending" || i.status === "degraded" ? "warning" : "neutral";
                return (
                  <li key={i.provider} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <IconTile icon={meta.icon} tone={tone} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className="text-[13.5px] font-semibold text-ink">{meta.label}</span>
                        <StatusPill status={i.status} size="sm" />
                      </div>
                      {i.detail && <p className="mt-1 text-[12px] leading-relaxed text-muted">{i.detail}</p>}
                      {i.last_checked_at && <InfoChip icon={<Clock />} className="mt-2 h-5 text-[11px]"><span suppressHydrationWarning>Checked {relativeTime(i.last_checked_at)}</span></InfoChip>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UsageTab({ data, superAdmin }: { data: Detail; superAdmin: boolean }) {
  const { run, pending } = useAction();
  const u = data.usage;
  const [form, setForm] = React.useState({
    monthlyAgentMessages: String(u.limits.monthly_agent_messages),
    monthlyTokens: u.limits.monthly_tokens === null ? "" : String(u.limits.monthly_tokens),
    dailyLeadResearch: String(u.limits.daily_lead_research),
    monthlyHelpRequests: String(u.limits.monthly_help_requests),
    warnAtPercent: String(u.limits.warn_at_percent),
    hardStop: u.limits.hard_stop,
    fairUseNote: u.limits.fair_use_note ?? "",
  });
  const pct = u.limits.monthly_agent_messages ? (u.agentMessages / u.limits.monthly_agent_messages) * 100 : 0;
  const meterTone = pct >= 100 ? "danger" : pct >= u.limits.warn_at_percent ? "warning" : "primary";
  const remaining = Math.max(0, u.limits.monthly_agent_messages - u.agentMessages);
  return (
    <div className="grid gap-6 lg:grid-cols-5 [&>*]:min-w-0">
      <Card className="lg:col-span-2">
        <SectionHead icon={<Gauge />} tone="primary" title="This month" description="Measured usage. Vendor invoices are not estimated here." />
        <CardContent className="space-y-4">
          <div className="rounded-xl bg-surface-2/60 p-4 ring-1 ring-inset ring-line">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[12px] font-medium text-muted">AI messages</p>
                <p className="mt-0.5 text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">
                  {formatNumber(u.agentMessages)}
                  <span className="ml-1.5 text-[14px] font-medium tracking-normal text-muted">/ {formatNumber(u.limits.monthly_agent_messages)}</span>
                </p>
              </div>
              <StatusPill tone={meterTone}>{pct >= 100 ? "Limit reached" : `${Math.round(pct)}% used`}</StatusPill>
            </div>
            <ProgressBar value={pct} tone={meterTone} label="AI message usage" className="mt-3.5" />
            <p className="mt-2 text-[12px] text-muted">{formatNumber(remaining)} {remaining === 1 ? "message" : "messages"} left this month</p>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <StatTile icon={<Cpu />} tone="primary" label="Tokens" value={formatNumber(u.tokens)} />
            <StatTile icon={<TriangleAlert />} tone={u.failedRuns > 0 ? "danger" : "success"} label="Failed runs" value={formatNumber(u.failedRuns)} />
            <StatTile icon={<Search />} tone="violet" label="Research today" value={formatNumber(u.leadResearchToday)} />
            <StatTile icon={<LifeBuoy />} tone="primary" label="Help requests" value={formatNumber(u.helpRequests)} />
          </dl>
          <div className="flex flex-wrap gap-2">
            <InfoChip icon={<Activity />}>Warns at {u.limits.warn_at_percent}%</InfoChip>
            <StatusPill tone={u.limits.hard_stop ? "danger" : "neutral"} size="sm" dot={false} icon={<Lock className="size-3" />}>{u.limits.hard_stop ? "Hard stop on" : "Hard stop off"}</StatusPill>
            <InfoChip>{u.limits.monthly_tokens === null ? "No token cap" : `${formatNumber(u.limits.monthly_tokens)} token cap`}</InfoChip>
          </div>
        </CardContent>
      </Card>
      <Card className="lg:col-span-3">
        <SectionHead icon={<ShieldCheck />} tone="violet" title="Limits" description="Hard stops block costly operations before they start." />
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["monthlyAgentMessages", "AI messages per month"],
                ["monthlyTokens", "Tokens per month (blank = no token cap)"],
                ["dailyLeadResearch", "Lead research per day"],
                ["monthlyHelpRequests", "Help assistant AI answers per month"],
                ["warnAtPercent", "Warn at (%)"],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label} htmlFor={`l-${k}`}>
                <Input id={`l-${k}`} inputMode="numeric" value={form[k]} disabled={!superAdmin} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
              </Field>
            ))}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/40 px-3.5 py-2.5 sm:mt-[26px]">
              <span className="text-[13px] font-medium text-ink">Hard stop at limit</span>
              <Switch checked={form.hardStop} disabled={!superAdmin} onCheckedChange={(v) => setForm((f) => ({ ...f, hardStop: v }))} aria-label="Hard stop at limit" />
            </div>
          </div>
          <Field label="Fair-use note shown to the client" htmlFor="l-note" optional>
            <Textarea id="l-note" value={form.fairUseNote} disabled={!superAdmin} rows={2} maxLength={1000} onChange={(e) => setForm((f) => ({ ...f, fairUseNote: e.target.value }))} />
          </Field>
          {superAdmin && (
            <div className="border-t border-line pt-4">
              <Button loading={pending === "limits"} onClick={() => run("limits", () => updateUsageLimitsAction(data.org.id, { ...form, monthlyTokens: form.monthlyTokens }), "Limits saved")}>
                Save limits
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BillingTab({ data, superAdmin, timeZone }: { data: Detail; superAdmin: boolean; timeZone: string }) {
  const { run, pending } = useAction();
  const b = data.billing;
  const [form, setForm] = React.useState({
    setupPaymentStatus: b?.setup_payment_status ?? "not_invoiced",
    activationStatus: b?.activation_status ?? "pending",
    invoiceUrl: b?.invoice_url ?? "",
    receiptUrl: b?.receipt_url ?? "",
    serviceTerms: b?.service_terms ?? "",
  });
  const currency = b?.currency ?? "USD";
  const savedPayment = b?.setup_payment_status ?? "not_invoiced";
  const savedActivation = b?.activation_status ?? "pending";
  return (
    <div className="grid gap-6 lg:grid-cols-5 [&>*]:min-w-0">
      <Card className="lg:col-span-3">
        <SectionHead icon={<Receipt />} tone="primary" title="Setup &amp; activation" description="Maintenance and custom projects are managed separately. No live payment collection in this view." />
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Setup payment" htmlFor="b-pay">
              <Select id="b-pay" value={form.setupPaymentStatus} disabled={!superAdmin} onChange={(e) => setForm((f) => ({ ...f, setupPaymentStatus: e.target.value }))}>
                {["not_invoiced", "invoiced", "paid", "waived", "refunded"].map((s) => (
                  <option key={s} value={s}>
                    {sentenceCase(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Activation" htmlFor="b-act">
              <Select id="b-act" value={form.activationStatus} disabled={!superAdmin} onChange={(e) => setForm((f) => ({ ...f, activationStatus: e.target.value }))}>
                {["pending", "active", "suspended"].map((s) => (
                  <option key={s} value={s}>
                    {sentenceCase(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Invoice link (HTTPS)" htmlFor="b-inv" optional>
              <Input id="b-inv" value={form.invoiceUrl} disabled={!superAdmin} onChange={(e) => setForm((f) => ({ ...f, invoiceUrl: e.target.value }))} />
            </Field>
            <Field label="Receipt link (HTTPS)" htmlFor="b-rec" optional>
              <Input id="b-rec" value={form.receiptUrl} disabled={!superAdmin} onChange={(e) => setForm((f) => ({ ...f, receiptUrl: e.target.value }))} />
            </Field>
          </div>
          <Field label="Service terms & operating limits shown to the client" htmlFor="b-terms" optional>
            <Textarea id="b-terms" rows={4} maxLength={4000} value={form.serviceTerms} disabled={!superAdmin} onChange={(e) => setForm((f) => ({ ...f, serviceTerms: e.target.value }))} />
          </Field>
          {superAdmin && (
            <div className="border-t border-line pt-4">
              <Button loading={pending === "billing"} onClick={() => run("billing", () => updateBillingAction(data.org.id, form as never), "Billing updated")}>
                Save billing
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="self-start lg:col-span-2">
        <SectionHead icon={<Banknote />} tone="success" title="Billing summary" description="What is recorded today. Save to update." />
        <CardContent className="space-y-4">
          <StatTile icon={<Receipt />} tone="primary" label="One-time setup fee" value={formatCurrency((b?.setup_fee_cents ?? 149900) / 100, currency)} detail={currency} className="p-3.5" />
          <DetailList>
            <DetailRow label="Setup payment"><StatusPill status={savedPayment} size="sm" /></DetailRow>
            <DetailRow label="Activation"><StatusPill status={savedActivation} size="sm" /></DetailRow>
            <DetailRow label="Invoice">
              {b?.invoice_url ? <ExternalPill href={b.invoice_url}>View invoice</ExternalPill> : <StatusPill tone="neutral" size="sm" dot={false}>Not added</StatusPill>}
            </DetailRow>
            <DetailRow label="Receipt">
              {b?.receipt_url ? <ExternalPill href={b.receipt_url}>View receipt</ExternalPill> : <StatusPill tone="neutral" size="sm" dot={false}>Not added</StatusPill>}
            </DetailRow>
          </DetailList>
          {b?.paid_at && (
            <Callout tone="success" icon={<CheckCircle2 />} title="Marked paid">
              {formatDateTime(b.paid_at, timeZone)}
            </Callout>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** An external document link, only ever rendered for an HTTPS address. */
function ExternalPill({ href, children }: { href: string; children: React.ReactNode }) {
  if (!/^https:\/\//i.test(href)) return <StatusPill tone="warning" size="sm">Link needs HTTPS</StatusPill>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-6 items-center gap-1 rounded-md text-[12.5px] font-medium text-primary-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary">
      {children} <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

/** What actually happened to the invitation email, taken from the outbox rather than assumed. */
function InvitationEmailStatus({ invitation: i }: { invitation: Detail["invitations"][number] }) {
  if (!i.email_status) return <Callout tone="neutral" icon={<Mail />} className="px-3 py-2 text-[12px]">No invitation email on record. Use Resend.</Callout>;
  const s = deliverySummary(i.email_status, i.email_error, i.email);
  const when = i.email_at ? ` ${relativeTime(i.email_at)}` : "";
  const text =
    i.email_status === "sent" ? `Email sent${when}`
    : i.email_status === "captured" ? "Email was not delivered: email delivery is switched off for this environment"
    : i.email_status === "failed" ? `Email failed${i.email_error ? `: ${i.email_error}` : ""}`
    : "Email queued, delivery not confirmed";
  return <Callout tone={s.tone} icon={<Mail />} className="px-3 py-2 text-[12px]"><span suppressHydrationWarning>{text}</span></Callout>;
}

function TeamTab({ data, superAdmin }: { data: Detail; superAdmin: boolean }) {
  const { run, pending } = useAction();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"owner" | "admin" | "member">("owner");
  const [link, setLink] = React.useState<string | null>(null);
  const assigned = data.staff.filter((s) => s.assigned).length;
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
      <Card>
        <SectionHead icon={<Users />} title="Client users" description="Members of this workspace." aside={<InfoChip>{data.members.length} {data.members.length === 1 ? "member" : "members"}{data.invitations.length > 0 ? ` · ${data.invitations.length} invited` : ""}</InfoChip>} />
        <CardContent className="space-y-4">
          {data.members.length === 0 && data.invitations.length === 0 && (
            <EmptyState compact icon={<Users className="size-5" />} title="No client users yet" description="Invite the owner below and they will appear here once they accept." />
          )}
          <ul className="divide-y divide-line">
            {data.members.map((m) => (
              <li key={m.user_id} className="management-row -mx-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-3 text-[13px]">
                <AvatarTile name={m.full_name || m.email} size="md" />
                <div className="min-w-0 flex-1 basis-44">
                  <p className="truncate font-semibold text-ink" title={m.full_name || m.email}>{m.full_name || m.email}</p>
                  <p className="truncate text-[12px] text-muted" title={m.email}>{m.email}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusPill tone={roleTone(m.role)} size="sm">{sentenceCase(m.role)}</StatusPill>
                  {m.status !== "active" && <StatusPill status={m.status} size="sm" />}
                  <InfoChip icon={<Clock />} className="h-5 text-[11px]"><span suppressHydrationWarning>{m.last_login_at ? `Seen ${relativeTime(m.last_login_at)}` : "Never signed in"}</span></InfoChip>
                </div>
              </li>
            ))}
            {data.invitations.map((i) => (
              <li key={i.id} className="-mx-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-3 text-[13px]">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-dashed border-line-strong bg-surface-2/60 text-muted"><Mail className="size-4" /></span>
                <div className="min-w-0 flex-1 basis-52 space-y-1.5">
                  <p className="truncate font-semibold text-ink" title={i.email}>{i.email}</p>
                  <div className="flex flex-wrap items-center gap-1.5" suppressHydrationWarning>
                    <StatusPill tone={i.expired ? "danger" : "warning"} size="sm"><span suppressHydrationWarning>{i.expired ? `Invitation expired ${relativeTime(i.expires_at)}` : `Invitation pending · expires ${relativeTime(i.expires_at)}`}</span></StatusPill>
                  </div>
                  <InvitationEmailStatus invitation={i} />
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto">
                  <StatusPill tone={roleTone(i.role ?? "member")} size="sm">{sentenceCase(i.role ?? "member")}</StatusPill>
                  {superAdmin && <ResendInvitationButton orgId={data.org.id} invitation={i} variant="secondary" label="Resend" />}
                  {superAdmin && (
                    <Button size="sm" variant="outline" className="text-danger-ink" loading={pending === `rv-${i.id}`} onClick={() => run(`rv-${i.id}`, () => revokeInvitationAction(i.id, data.org.id), "Invitation revoked")}>
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {superAdmin && (
            <div className="space-y-3 rounded-xl border border-line bg-surface-2/40 p-3.5">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-ink"><UserPlus className="size-4 text-primary" aria-hidden /> Invite someone</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <label htmlFor="inv-email" className="sr-only">
                  Email
                </label>
                <Input id="inv-email" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <label htmlFor="inv-role" className="sr-only">
                  Role
                </label>
                <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="sm:w-36">
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </Select>
                <Button
                  loading={pending === "invite"}
                  onClick={async () => {
                    const res = await run("invite", () => inviteClientUserAction(data.org.id, email, role), (d) => (d?.delivery.status === "sent" ? "Invitation emailed" : "Invitation created, but the email was not delivered. Copy the link below."));
                    if (res && "data" in res && res.data) setLink((res.data as { link: string }).link);
                    setEmail("");
                  }}
                >
                  <UserPlus className="size-4" /> Invite
                </Button>
              </div>
              {link && (
                <div className="flex items-center gap-2 rounded-lg bg-surface p-2 ring-1 ring-inset ring-line">
                  <code className="min-w-0 flex-1 truncate px-1 text-[12px]" title={link}>{link}</code>
                  <Button size="sm" variant="secondary" aria-label="Copy invitation link" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Copied"))}>
                    <Copy className="size-3.5" /> Copy
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <SectionHead icon={<UserCheck />} tone="violet" title="Assigned agency staff" description="Staff only see clients they&apos;re assigned to." aside={data.staff.length > 0 && <InfoChip>{assigned} of {data.staff.length} assigned</InfoChip>} />
        <CardContent>
          {data.staff.length === 0 ? (
            <EmptyState compact icon={<UserCheck className="size-5" />} title="No agency staff accounts yet" description="Invite agency staff from the Team page, then assign them to this client here." />
          ) : (
            <ul className="divide-y divide-line">
              {data.staff.map((s) => (
                <li key={s.user_id} className="management-row -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 text-[13px]">
                  <AvatarTile name={s.full_name || s.email} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-ink" title={s.full_name || s.email}>{s.full_name || s.email}</p>
                    <p className="truncate text-[12px] text-muted" title={s.email}>{s.email}</p>
                  </div>
                  {s.assigned ? <StatusPill tone="success" size="sm">Assigned</StatusPill> : <StatusPill tone="neutral" size="sm">Not assigned</StatusPill>}
                  <Switch
                    checked={s.assigned}
                    disabled={!superAdmin}
                    aria-label={`Assign ${s.full_name || s.email}`}
                    onCheckedChange={(v) => run(`st-${s.user_id}`, () => assignStaffAction(data.org.id, s.user_id, v), v ? "Staff assigned" : "Staff unassigned")}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
