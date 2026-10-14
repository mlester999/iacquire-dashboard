"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Ban, Building2, CheckCircle2, ChevronDown, ClipboardCheck, Copy, FileCode2, KeyRound, Link2, PlayCircle, RefreshCw, ShieldAlert, Stethoscope, UserPlus } from "lucide-react";
import { AgentAvatar, AgentStatusBadge } from "@/components/brand";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, ProgressBar, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Switch, Tabs } from "@/components/ui/overlays";
import { PageHero } from "@/components/ui/workspace";
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
import { AGENT_BY_KEY } from "@/lib/agents";
import { cn, formatDate, formatDateTime, formatNumber, initials, relativeTime, sentenceCase } from "@/lib/utils";

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
  const reduce=useReducedMotion();
  const [tab, setTab] = React.useState(["overview","workforce","reviews","integrations","usage","billing","team"].includes(initialTab)?initialTab:"overview");
  const held = data.heldVersions.length + data.heldKnowledge.length;
  return (
    <div className="module-stack">
        <Link href="/admin/clients" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" /> Clients
        </Link>
        <PageHero eyebrow="Client workspace" icon={<Building2 className="size-5"/>} title={data.org.name} description={<span>{data.org.industry??"Industry not set"} · {data.org.timezone.replaceAll("_"," ")}<span className="mt-1 block text-xs">Registered {formatDate(data.org.created_at,timeZone)} · Private, tenant-scoped workspace</span></span>} aside={<div className="flex items-center gap-4"><span className="grid size-16 place-items-center rounded-2xl border border-primary/15 bg-surface/70 text-xl font-semibold text-primary-ink">{initials(data.org.name)}</span><div className="space-y-2"><Badge tone={data.org.status === "active" ? "success" : data.org.status === "suspended" ? "danger" : "primary"}>{sentenceCase(data.org.status)}</Badge>{data.org.is_demo&&<div><Badge tone="violet">Demo data</Badge></div>}</div></div>} action={<><ButtonLink href={`/admin/clients/${data.org.id}/setup`} variant="brand" size="sm">
            <ClipboardCheck className="size-4" /> Setup manager
          </ButtonLink>
          <ButtonLink href={`/admin/clients/${data.org.id}/integrations`} variant="secondary" size="sm"><KeyRound className="size-4" /> Secure integrations</ButtonLink><ButtonLink href={`/admin/clients/${data.org.id}/activation`} variant="ghost" size="sm">Readiness review</ButtonLink></>}><dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">{[{label:"Client team",value:data.members.filter(m=>m.status==="active").length},{label:"Included AI employees",value:data.agents.filter(a=>a.enabled).length},{label:"Awaiting review",value:held},{label:"Assigned agency staff",value:data.staff.filter(s=>s.assigned).length}].map(s=><div key={s.label}><dt className="text-xs text-muted">{s.label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{s.value}</dd></div>)}</dl></PageHero>
      <Tabs
        id="client-tabs"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "overview", label: "Overview" },
          { value: "workforce", label: "AI workforce" },
          { value: "reviews", label: "Reviews", count: held || undefined },
          { value: "integrations", label: "Integrations" },
          { value: "usage", label: "Usage & limits" },
          { value: "billing", label: "Billing" },
          { value: "team", label: "Team & staff" },
        ]}
      />
      <motion.div key={tab} initial={reduce?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:.2}}>
      {tab === "overview" && <OverviewTab data={data} superAdmin={superAdmin} />}
      {tab === "workforce" && <WorkforceTab data={data} superAdmin={superAdmin} />}
      {tab === "reviews" && <ReviewsTab data={data} />}
      {tab === "integrations" && <IntegrationsTab data={data} superAdmin={superAdmin} />}
      {tab === "usage" && <UsageTab data={data} superAdmin={superAdmin} />}
      {tab === "billing" && <BillingTab data={data} superAdmin={superAdmin} timeZone={timeZone} />}
      {tab === "team" && <TeamTab data={data} superAdmin={superAdmin} />}
      </motion.div>
    </div>
  );
}

function OverviewTab({ data, superAdmin }: { data: Detail; superAdmin: boolean }) {
  const { run, pending } = useAction();
  const [reason, setReason] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const online = data.agents.filter((a) => a.enabled && a.status === "online").length;
  const enabled = data.agents.filter((a) => a.enabled).length;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2 overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Workspace essentials</CardTitle>
            <CardDescription>The key account milestones recorded for this client.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            ["Owner accepted invitation", data.members.some((m) => m.role === "owner")],
            ["Onboarding completed", Boolean(data.org.onboarding_completed_at)],
            [`Employees online (${online}/${enabled})`, enabled > 0 && online === enabled],
            ["CRM location verified", data.ghl?.status === "connected"],
            ["Setup fee paid or waived", ["paid", "waived"].includes(data.billing?.setup_payment_status ?? "")],
          ].map(([label, done]) => (
            <div key={String(label)} className={cn("flex items-center gap-3 rounded-xl border px-4 py-3 text-[13.5px]",done?"border-success/15 bg-success-soft/35":"border-line bg-surface-2/50")}>
              {done ? <CheckCircle2 className="size-5 text-success" /> : <span className="size-5 shrink-0 rounded-full border-2 border-line-strong" />}
              <span className={done ? "text-ink" : "text-muted"}>{label}</span>
              <span className="ml-auto text-[11.5px] text-muted">{done?"Recorded":"Pending"}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card className="border-primary/15 bg-primary-soft/20">
        <CardHeader>
          <div>
            <CardTitle>Workspace access</CardTitle>
            <CardDescription>Suspending blocks every client user immediately.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.org.status === "suspended" ? (
            <>
              <p className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">Suspended: {data.org.suspended_reason}</p>
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
            <p className="text-[13px] text-muted">Only super admins can suspend workspaces.</p>
          )}
        </CardContent>
      </Card>
      <Card className="lg:col-span-3">
        <CardHeader>
          <div>
            <CardTitle>Recent failed AI runs</CardTitle>
            <CardDescription>Sanitized execution status only — message content is private to the client.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {data.failedRuns.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl border border-success/15 bg-success-soft/30 p-4"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-success-soft text-success-ink"><CheckCircle2 className="size-5"/></span><div><p className="text-sm font-medium text-ink">No failed runs recorded.</p><p className="mt-1 text-xs text-muted">Execution issues will appear here with sanitized diagnostics when they occur.</p></div></div>
          ) : (
            <ul className="divide-y divide-line">
              {data.failedRuns.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                  <span className="font-medium">{AGENT_BY_KEY[r.agent_role].shortName}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{r.error_message ?? r.error_code}</span>
                  <span className="text-[12px] text-faint">{r.finished_at ? relativeTime(r.finished_at) : ""}</span>
                </li>
              ))}
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

function WorkforceTab({ data, superAdmin }: { data: Detail; superAdmin: boolean }) {
  const { run, pending } = useAction();
  const [connectFor, setConnectFor] = React.useState<Detail["agents"][number] | null>(null);
  const [bundle, setBundle] = React.useState<ProvisioningBundle | null>(null);
  return (
    <div className="space-y-6">
      <Card className="border-primary/20 bg-primary-soft/30">
        <CardContent className="pt-5 text-[13px] leading-relaxed text-primary-ink">
          <details><summary className="flex cursor-pointer items-center gap-2 font-medium"><ShieldAlert className="size-4 shrink-0" />Dedicated identities and restricted tool access<ChevronDown className="ml-auto size-3.5"/></summary><p className="mt-3">
            Each employee needs its own <strong>blank</strong> Hermes profile (never a clone of an internal <code>iacquire-*</code> profile) and its own API key. Hermes profiles don&apos;t sandbox the agent on the
            local terminal backend, so the portal only marks an employee online after an authenticated capabilities check <em>and</em> a toolsets check showing no shell, file or code tools.
          </p></details>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.agents.map((a) => {
          const meta = AGENT_BY_KEY[a.role_key];
          return (
            <Card key={a.id} className={cn("relative overflow-hidden transition hover:border-primary/25",!a.enabled && "opacity-70")}>
              <div aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{background:meta.accent}}/>
              <CardContent className="space-y-3 pt-5">
                <div className="flex items-center gap-3">
                  <AgentAvatar role={meta} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold">{a.display_name}</p>
                    <AgentStatusBadge status={a.enabled ? a.status : "disabled"} />
                  </div>
                  {superAdmin && (
                    <Switch
                      checked={a.enabled}
                      aria-label={`${a.enabled ? "Disable" : "Enable"} ${meta.shortName}`}
                      onCheckedChange={(v) => run(`en-${a.id}`, () => setAgentEnabledAction(data.org.id, a.id, v), v ? "Employee enabled" : "Employee disabled")}
                    />
                  )}
                </div>
                <p className="text-[12.5px] leading-relaxed text-muted">{meta.tagline}</p>
                <dl className="space-y-1.5 text-[12.5px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Hermes profile</dt>
                    <dd className="truncate font-mono text-[12px]">{a.hermes_profile ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Host</dt>
                    <dd className="truncate font-mono text-[12px]">{a.hermes_host ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Config</dt>
                    <dd>{a.config_version ? `v${a.config_version}` : "Not configured"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Runs (30d)</dt>
                    <dd className="tabular-nums">
                      {a.runs_30d}
                      {a.failed_30d > 0 && <span className="text-danger-ink"> · {a.failed_30d} failed</span>}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Last check</dt>
                    <dd>{a.last_health_check_at ? relativeTime(a.last_health_check_at) : "Never"}</dd>
                  </div>
                </dl>
                {a.last_health_detail && <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2">{a.last_health_detail}</p>}
                <div className="flex flex-wrap gap-2 pt-1">
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
        <CardHeader>
          <div>
            <CardTitle>Provisioning requests</CardTitle>
            <CardDescription>Opened automatically when onboarding completes. Close the loop with a successful health check.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {data.provisioning.length === 0 ? (
            <p className="py-4 text-[13px] text-muted">No provisioning requests.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.provisioning.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
                  <span className="font-medium">{AGENT_BY_KEY[j.agent_role].shortName}</span>
                  <Badge tone={j.status === "succeeded" ? "success" : j.status === "failed" ? "danger" : j.status === "requested" ? "warning" : "primary"}>{sentenceCase(j.status)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-muted">{j.detail ?? ""}</span>
                  <span className="text-[12px] text-faint">{relativeTime(j.created_at)}</span>
                  {j.status === "requested" && (
                    <Button size="sm" variant="ghost" onClick={() => run(`job-${j.id}`, () => updateProvisioningJobAction(data.org.id, j.id, "in_progress"), "Marked in progress")}>
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
        <button
          type="button"
          className="flex items-center gap-1 text-[12px] text-primary hover:underline"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          }}
        >
          <Copy className="size-3" /> Copy
        </button>
      </div>
      <pre className="scrollbar-thin max-h-64 overflow-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed">{value}</pre>
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
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-semibold text-primary-ink">{i + 1}</span>
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
          <div className="rounded-xl bg-surface-2 p-3 text-[12.5px]">
            <p className="font-medium">Online only when:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
              {bundle.verification.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ReviewsTab({ data }: { data: Detail }) {
  const { run, pending } = useAction();
  if (!data.heldVersions.length && !data.heldKnowledge.length) {
    return (
      <Card>
        <CardContent className="flex items-center gap-4 py-6"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-success-soft text-success-ink"><CheckCircle2 className="size-6"/></span><div><p className="text-[15px] font-semibold text-ink">The review queue is clear.</p><p className="mt-1 text-[13px] text-muted">Held employee configurations and knowledge changes will appear here when agency review is needed.</p></div></CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {data.heldVersions.map((v) => (
        <Card key={v.id}>
          <CardContent className="space-y-3 pt-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[14px] font-semibold">
                {AGENT_BY_KEY[v.agent_role].shortName} · configuration v{v.version}
              </p>
              {v.risk_flags.map((f) => (
                <Badge key={f} tone="warning">
                  {f.replace(/_/g, " ")}
                </Badge>
              ))}
            </div>
            {v.change_request && <p className="text-[13px] text-ink-2">Request: “{v.change_request}”</p>}
            <p className="text-[13px] text-muted">{v.summary}</p>
            <div className="flex gap-2">
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
        <Card key={k.section}>
          <CardContent className="space-y-3 pt-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[14px] font-semibold">Knowledge · {sentenceCase(k.section)}</p>
              {k.risk_flags.map((f) => (
                <Badge key={f} tone="warning">
                  {f.replace(/_/g, " ")}
                </Badge>
              ))}
            </div>
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-[12.5px]">{k.content}</pre>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => run(`k-${k.section}`, () => decideHeldKnowledgeAction(data.org.id, k.section, true), "Approved")}>
                Approve
              </Button>
              <Button size="sm" variant="secondary" onClick={() => run(`kr-${k.section}`, () => decideHeldKnowledgeAction(data.org.id, k.section, false), "Rejected")}>
                Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function IntegrationsTab({ data, superAdmin }: { data: Detail; superAdmin: boolean }) {
  const { run, pending } = useAction();
  const [locationId, setLocationId] = React.useState(data.ghl?.location_id ?? "");
  const [locationName, setLocationName] = React.useState(data.ghl?.location_name ?? "");
  const [pipelineId, setPipelineId] = React.useState(data.ghl?.pipeline_id ?? "");
  const [calendarIds, setCalendarIds] = React.useState((data.ghl?.calendar_ids ?? []).join(", "));
  const [token, setToken] = React.useState("");
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader>
          <div>
            <CardTitle>GoHighLevel location</CardTitle>
            <CardDescription>Stored server-side only. The Aster Homes location and iAcquire&apos;s internal location are refused.</CardDescription>
          </div>
          {data.ghl && <Badge tone={data.ghl.status === "connected" ? "success" : data.ghl.status === "error" ? "danger" : "neutral"}>{sentenceCase(data.ghl.status)}</Badge>}
        </CardHeader>
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
          <div className="flex flex-wrap gap-2">
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
        <CardHeader>
          <div>
            <CardTitle>Integration status</CardTitle>
            <CardDescription>Last recorded checks for this client.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-line">
            {data.integrations.map((i) => (
              <li key={i.provider} className="py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-medium">{i.provider === "ghl" ? "GoHighLevel CRM" : i.provider === "ghl_calendar" ? "GHL calendar" : i.provider === "hermes" ? "Hermes" : i.provider}</span>
                  <Badge tone={i.status === "connected" ? "success" : i.status === "error" ? "danger" : i.status === "pending" ? "warning" : "neutral"}>{sentenceCase(i.status)}</Badge>
                </div>
                {i.detail && <p className="mt-0.5 text-[12px] text-muted">{i.detail}</p>}
                {i.last_checked_at && <p className="text-[11.5px] text-faint">Checked {relativeTime(i.last_checked_at)}</p>}
              </li>
            ))}
          </ul>
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
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>This month</CardTitle>
            <CardDescription>Measured usage. Vendor invoices are not estimated here.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-1 flex justify-between text-[13px]">
              <span>AI messages</span>
              <span className="tabular-nums">
                {formatNumber(u.agentMessages)} / {formatNumber(u.limits.monthly_agent_messages)}
              </span>
            </div>
            <ProgressBar value={pct} tone={pct >= 100 ? "danger" : pct >= u.limits.warn_at_percent ? "warning" : "primary"} label="AI message usage" />
          </div>
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            <div className="rounded-xl bg-surface-2 p-3">
              <dt className="text-muted">Tokens</dt>
              <dd className="text-[17px] font-semibold tabular-nums">{formatNumber(u.tokens)}</dd>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <dt className="text-muted">Failed runs</dt>
              <dd className="text-[17px] font-semibold tabular-nums">{formatNumber(u.failedRuns)}</dd>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <dt className="text-muted">Research today</dt>
              <dd className="text-[17px] font-semibold tabular-nums">{formatNumber(u.leadResearchToday)}</dd>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <dt className="text-muted">Help requests</dt>
              <dd className="text-[17px] font-semibold tabular-nums">{formatNumber(u.helpRequests)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card className="lg:col-span-3">
        <CardHeader>
          <div>
            <CardTitle>Limits</CardTitle>
            <CardDescription>Hard stops block costly operations before they start.</CardDescription>
          </div>
        </CardHeader>
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
            <div className="flex items-center justify-between rounded-xl border border-line px-3.5 py-2.5">
              <span className="text-[13px] font-medium">Hard stop at limit</span>
              <Switch checked={form.hardStop} disabled={!superAdmin} onCheckedChange={(v) => setForm((f) => ({ ...f, hardStop: v }))} aria-label="Hard stop at limit" />
            </div>
          </div>
          <Field label="Fair-use note shown to the client" htmlFor="l-note" optional>
            <Textarea id="l-note" value={form.fairUseNote} disabled={!superAdmin} rows={2} maxLength={1000} onChange={(e) => setForm((f) => ({ ...f, fairUseNote: e.target.value }))} />
          </Field>
          {superAdmin && (
            <Button loading={pending === "limits"} onClick={() => run("limits", () => updateUsageLimitsAction(data.org.id, { ...form, monthlyTokens: form.monthlyTokens }), "Limits saved")}>
              Save limits
            </Button>
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
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <div>
          <CardTitle>Setup &amp; activation</CardTitle>
          <CardDescription>One-time setup fee of ${((b?.setup_fee_cents ?? 149900) / 100).toLocaleString()} {b?.currency ?? "USD"}. Maintenance and custom projects are managed separately. No live payment collection in this view.</CardDescription>
        </div>
      </CardHeader>
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
          <Button loading={pending === "billing"} onClick={() => run("billing", () => updateBillingAction(data.org.id, form as never), "Billing updated")}>
            Save billing
          </Button>
        )}
        {b?.paid_at && <p className="text-[12.5px] text-muted">Marked paid {formatDateTime(b.paid_at, timeZone)}</p>}
      </CardContent>
    </Card>
  );
}

function TeamTab({ data, superAdmin }: { data: Detail; superAdmin: boolean }) {
  const { run, pending } = useAction();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"owner" | "admin" | "member">("owner");
  const [link, setLink] = React.useState<string | null>(null);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Client users</CardTitle>
            <CardDescription>Members of this workspace.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-y divide-line">
            {data.members.map((m) => (
              <li key={m.user_id} className="flex items-center gap-3 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{m.full_name || m.email}</p>
                  <p className="truncate text-[12px] text-muted">{m.email}</p>
                </div>
                <Badge tone={m.status === "active" ? "primary" : "neutral"}>{sentenceCase(m.role)}</Badge>
                <span className="hidden text-[11.5px] text-faint sm:block">{m.last_login_at ? `Seen ${relativeTime(m.last_login_at)}` : "Never signed in"}</span>
              </li>
            ))}
            {data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-muted">{i.email}</p>
                  <p className="text-[12px] text-faint">Invitation pending · expires {relativeTime(i.expires_at)}</p>
                </div>
                <Badge tone="warning">{sentenceCase(i.role ?? "member")}</Badge>
                {superAdmin && (
                  <Button size="sm" variant="ghost" onClick={() => run(`rv-${i.id}`, () => revokeInvitationAction(i.id, data.org.id), "Invitation revoked")}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {superAdmin && (
            <div className="space-y-3 rounded-xl border border-line p-3">
              <p className="text-[13px] font-medium">Invite someone</p>
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
                    const res = await run("invite", () => inviteClientUserAction(data.org.id, email, role), "Invitation sent");
                    if (res && "data" in res && res.data) setLink((res.data as { link: string }).link);
                    setEmail("");
                  }}
                >
                  <UserPlus className="size-4" /> Invite
                </Button>
              </div>
              {link && (
                <div className="flex items-center gap-2 rounded-lg bg-surface-2 p-2">
                  <code className="min-w-0 flex-1 truncate text-[12px]">{link}</code>
                  <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Copied"))}>
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Assigned agency staff</CardTitle>
            <CardDescription>Staff only see clients they&apos;re assigned to.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {data.staff.length === 0 ? (
            <p className="py-4 text-[13px] text-muted">No agency staff accounts yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.staff.map((s) => (
                <li key={s.user_id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{s.full_name || s.email}</p>
                    <p className="truncate text-[12px] text-muted">{s.email}</p>
                  </div>
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
