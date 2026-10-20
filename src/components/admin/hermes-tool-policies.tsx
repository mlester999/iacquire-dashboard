"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowUpRight, Bot, CheckCircle2, CircleHelp, LockKeyhole, Save, ShieldCheck, Sparkles } from "lucide-react";
import { Card, Select } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog, Switch } from "@/components/ui/overlays";
import { PageHero } from "@/components/ui/workspace";
import { StatusPill } from "@/components/ui/status";
import { acknowledgeInternalHermesCapabilitiesAction, resetHermesToolPolicyAction, saveHermesToolPolicyAction } from "@/app/(admin)/admin/actions";
import { resolveEffectiveHermesPolicy } from "@/lib/hermes-tool-policies";
import type { HermesPolicyRecord, HermesToolPolicyView } from "@/server/workforce/tool-policies";
import { AGENT_BY_KEY } from "@/lib/agents";
import { formatDate } from "@/lib/utils";

type Target = "client_default" | `client:${string}` | `agent:${string}`;
type PolicyTargetOption = { value: Target; companyName: string; targetName: string; typeOrder: number; label: string };

function policyTargetOptions(data: HermesToolPolicyView): PolicyTargetOption[] {
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  return [
    ...data.clients.map((client): PolicyTargetOption => ({
      value: `client:${client.id}`,
      companyName: client.name,
      targetName: "",
      typeOrder: 0,
      label: `${client.name} · Client`,
    })),
    ...data.agents.map((agent): PolicyTargetOption => ({
      value: `agent:${agent.id}`,
      companyName: agent.orgName,
      targetName: agent.displayName,
      typeOrder: 1,
      label: `${agent.orgName} · Employee · ${agent.displayName}`,
    })),
  ].sort((a, b) =>
    collator.compare(a.companyName, b.companyName)
    || a.typeOrder - b.typeOrder
    || collator.compare(a.targetName, b.targetName),
  );
}

function targetInfo(data: HermesToolPolicyView, target: Target): { policy: HermesPolicyRecord; inherited: boolean; saveTarget: { scopeKind: "client_default" | "client" | "agent"; orgId?: string; agentId?: string }; title: string } {
  if (target === "client_default") return { policy: data.clientDefault, inherited: false, saveTarget: { scopeKind: "client_default" }, title: "Default client policy" };
  if (target.startsWith("client:")) {
    const orgId = target.slice("client:".length);
    const client = data.clients.find((entry) => entry.id === orgId);
    return { policy: client?.policy ?? data.clientDefault, inherited: !client?.policy, saveTarget: { scopeKind: "client", orgId }, title: client?.name ?? "Client policy" };
  }
  const agentId = target.slice("agent:".length);
  const agent = data.agents.find((entry) => entry.id === agentId);
  if (!agent) return { policy: data.clientDefault, inherited: true, saveTarget: { scopeKind: "agent", agentId }, title: "Employee policy" };
  const client = data.clients.find((entry) => entry.id === agent.orgId);
  const inheritedPolicy = resolveEffectiveHermesPolicy(agent.orgKind === "agency"
    ? { internalDefault: data.internalDefault }
    : { clientDefault: data.clientDefault, clientOverride: client?.policy });
  return { policy: agent.policy ?? inheritedPolicy ?? data.clientDefault, inherited: !agent.policy, saveTarget: { scopeKind: "agent", agentId }, title: `${agent.displayName} · ${agent.orgName}` };
}

export function HermesToolPolicies({ data, timeZone }: { data: HermesToolPolicyView; timeZone: string }) {
  const router = useRouter();
  const [target, setTarget] = React.useState<Target>("client_default");
  const [pending, start] = React.useTransition();
  const [confirmAck, setConfirmAck] = React.useState(false);
  const [selectedProfiles, setSelectedProfiles] = React.useState<string[]>([]);
  const internalProfiles = data.agents.filter((agent) => agent.orgKind === "agency");

  const acknowledge = () => start(async () => {
    const targets = selectedProfiles.flatMap((agentId) => {
      const profile = internalProfiles.find((candidate) => candidate.id === agentId);
      return profile?.activeConfigVersionId ? [{ agentId, expectedActiveConfigVersionId: profile.activeConfigVersionId }] : [];
    });
    if (targets.length !== selectedProfiles.length) {
      toast.error("Reload the page; one selected employee no longer has the same applied configuration.");
      return;
    }
    const res = await acknowledgeInternalHermesCapabilitiesAction(targets);
    if (!res.ok) toast.error(res.error);
    else { toast.success("Acknowledgement recorded for the selected existing profiles."); setConfirmAck(false); setSelectedProfiles([]); router.refresh(); }
  });

  return <div className="space-y-6">
    <PageHero tone="dark" eyebrow="AI workforce" icon={<Sparkles className="size-5" />} title="Hermes Tool Policies" description="Review intended tool access, client defaults, overrides and profile checks. Policy saves do not change the Hermes gateway." aside={<StatusPill tone="warning" icon={<AlertTriangle className="size-3" />}>Not enforced by gateway</StatusPill>}>
      <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-white/[.05] p-4 ring-1 ring-inset ring-white/10"><p className="text-[12px] text-white/70">Client default</p><p className="mt-1 text-lg font-semibold text-white">{data.clientDefault.name}</p><p className="mt-1 text-[11px] text-white/55">Applies as the desired default for new client policies</p></div><div className="rounded-xl bg-white/[.05] p-4 ring-1 ring-inset ring-white/10"><p className="text-[12px] text-white/70">Internal workforce</p><p className="mt-1 text-lg font-semibold text-white">Full Hermes Capabilities</p><p className="mt-1 text-[11px] text-white/55">Existing profiles require per-profile owner acknowledgement</p></div><div className="rounded-xl bg-white/[.05] p-4 ring-1 ring-inset ring-white/10"><p className="text-[12px] text-white/70">Gateway controls</p><p className="mt-1 text-lg font-semibold text-white">Read-only API</p><p className="mt-1 text-[11px] text-white/55">Remote policy writes and complete inventory are unavailable</p></div></div>
    </PageHero>

    <div role="alert" className="flex items-start gap-3 rounded-2xl border border-warning/25 bg-warning-soft p-4 text-[13px] leading-relaxed text-warning-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><p><strong>{data.inventoryComplete ? "The complete runtime catalog is currently verified for every internal profile." : "At least one internal profile needs a fresh or complete runtime inventory check."}</strong> Inventory checks use the read-only Hermes catalog. The gateway does not expose a supported policy-write endpoint, so saved tool policies remain desired settings and do not change profile capabilities.</p></div>

    {data.editable && <InternalAcknowledgement profiles={internalProfiles} timeZone={timeZone} selected={selectedProfiles} setSelected={setSelectedProfiles} onConfirm={() => setConfirmAck(true)} />}

    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <PolicyConfiguration key={`${target}:${targetInfo(data, target).policy.id}:${targetInfo(data, target).policy.updatedAt}`} data={data} target={target} onTargetChange={setTarget} />

      <div className="space-y-5">
        <Card className="space-y-4 p-5"><div className="flex items-center gap-2"><LockKeyhole className="size-4 text-primary" /><h2 className="text-sm font-semibold">Effective desired policy</h2></div><p className="text-[12px] leading-relaxed text-muted">Overrides resolve in order: employee, client, then default. This preview describes saved intent; it is not a gateway enforcement result.</p><div className="space-y-2">{data.clients.map((client) => <div key={client.id} className="rounded-xl border border-line p-3"><p className="text-[12px] font-semibold text-ink">{client.name}</p><div className="mt-2 flex flex-wrap gap-1.5"><StatusPill tone={client.policy ? "primary" : "neutral"}>{client.policy?.name ?? data.clientDefault.name}</StatusPill><StatusPill tone="warning">Not enforced</StatusPill></div><p className="mt-2 text-[11px] text-muted">{client.agentIds.length} AI employee profiles in scope</p></div>)}</div>{!data.clients.length && <p className="rounded-xl bg-surface-2 p-3 text-[12px] text-muted">No client workspaces are available in your scope.</p>}</Card>
        <Card className="space-y-4 p-5"><div className="flex items-center gap-2"><CircleHelp className="size-4 text-primary" /><h2 className="text-sm font-semibold">Client role capability matrix</h2></div><p className="text-[12px] text-muted">Business capabilities by iAcquire employee role. Actual tools remain subject to the gateway profile.</p><div className="space-y-3">{Object.entries(data.roleMatrix).map(([roleKey, role]) => <div key={roleKey} className="rounded-xl border border-line p-3"><p className="text-[12px] font-semibold text-ink">{role.label}</p><ul className="mt-2 flex flex-wrap gap-1.5">{role.capabilities.map((capability) => <li key={capability} className="rounded-md bg-primary-soft px-2 py-1 text-[10px] text-primary-ink">{data.capabilityOptions.find((option) => option.key === capability)?.label ?? capability}</li>)}</ul></div>)}</div></Card>
      </div>
    </section>

    <Card className="overflow-hidden"><div className="border-b border-line px-5 py-4"><h2 className="text-sm font-semibold">Policy history</h2><p className="mt-1 text-[12px] text-muted">Changes and acknowledgements are audited. History does not mean Hermes applied a policy.</p></div>{data.history.length ? <ul className="divide-y divide-line">{data.history.map((event, index) => <li key={`${event.action}-${event.occurredAt}-${index}`} className="flex flex-wrap items-center gap-3 px-5 py-3"><span className="min-w-0 flex-1"><span className="block text-[12px] font-medium text-ink">{event.policyName} · {event.action.replaceAll("_", " ")}</span><span className="mt-1 block text-[11px] text-muted">{event.actorName} · {event.scopeKind.replaceAll("_", " ")}</span></span><time className="text-[11px] text-muted" dateTime={event.occurredAt}>{formatDate(event.occurredAt, timeZone)}</time></li>)}</ul> : <p className="p-5 text-[12px] text-muted">No policy changes or acknowledgements recorded yet.</p>}</Card>

    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 text-primary" /><p className="text-[12px] leading-relaxed text-muted">Client employees stay blocked from live runs while Hermes cannot prove complete permissions. Existing internal profiles can run only after a current identity check and owner acknowledgement. Policy edits never start tasks or campaigns.</p></div><Link href="/admin/employees" className="flex items-center gap-1 text-[12px] font-medium text-primary hover:underline">Open Internal Workforce <ArrowUpRight className="size-3.5" /></Link></div>

    <Dialog open={confirmAck} onOpenChange={setConfirmAck} title="Acknowledge Full Hermes Capabilities" description="Record approval only after the current profile and inventory pass server checks." footer={<><Button variant="secondary" disabled={pending} onClick={() => setConfirmAck(false)}>Cancel</Button><Button variant="brand" loading={pending} onClick={acknowledge}>Verify and acknowledge selected profiles</Button></>}>
      <div className="space-y-3 text-[13px] leading-relaxed text-muted"><p>For each selected internal employee, the server will confirm the saved Hermes identity and read the complete runtime tool inventory through the existing read-only diagnostic endpoints. It will record the acknowledgement only if the applied configuration, identity, credentials and approved inventory remain unchanged and current.</p><p>This does not change Hermes profile configuration or permissions, submit a model run, start a chat, or launch a background job. If a tool inventory differs from the recorded baseline or any state changes during verification, the acknowledgement stops without being saved.</p></div>
    </Dialog>
  </div>;
}

function PolicyConfiguration({ data, target, onTargetChange }: {
  data: HermesToolPolicyView;
  target: Target;
  onTargetChange: (target: Target) => void;
}) {
  const router = useRouter();
  const selectedTarget = targetInfo(data, target);
  const targetOptions = policyTargetOptions(data);
  const [name, setName] = React.useState(target === "client_default" ? selectedTarget.policy.name : selectedTarget.inherited ? "Custom Policy" : selectedTarget.policy.name);
  const [allowedCapabilities, setAllowedCapabilities] = React.useState<string[]>([...selectedTarget.policy.allowedCapabilities]);
  const [blockedToolsets, setBlockedToolsets] = React.useState<string[]>([...selectedTarget.policy.blockedToolsets]);
  const [approvalMode, setApprovalMode] = React.useState(selectedTarget.policy.approvalMode);
  const [policyError, setPolicyError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const currentOverride = target === "client_default" || !selectedTarget.inherited;
  const readOnly = !data.editable;
  const agentIsInternal = target.startsWith("agent:") && data.agents.find((agent) => `agent:${agent.id}` === target)?.orgKind === "agency";

  const savePolicy = () => start(async () => {
    setPolicyError(null);
    const res = await saveHermesToolPolicyAction({
      ...selectedTarget.saveTarget,
      name,
      allowedCapabilities,
      blockedToolsets,
      approvalMode,
    });
    if (!res.ok) setPolicyError(res.error);
    else { toast.success("Desired policy saved. Hermes has not applied it."); router.refresh(); }
  });

  const resetPolicy = () => start(async () => {
    if (target === "client_default") return;
    const res = await resetHermesToolPolicyAction(selectedTarget.saveTarget as { scopeKind: "client" | "agent"; orgId?: string; agentId?: string });
    if (!res.ok) toast.error(res.error);
    else { toast.success("Override reset to its inherited policy."); router.refresh(); }
  });

  return <Card className="space-y-5 p-5">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><h2 className="text-base font-semibold text-ink">Policy configuration</h2><p className="mt-1 text-[12px] text-muted">Edit the default, a client override, or an employee override.</p></div><div className="sm:w-80"><Select aria-label="Policy target" value={target} disabled={pending} onChange={(event) => onTargetChange(event.target.value as Target)}><option value="client_default">Default client policy</option>{targetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div></div>
    <div className="rounded-xl border border-line bg-surface-2 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold text-ink">{selectedTarget.title}</p><p className="mt-1 text-[12px] text-muted">{selectedTarget.inherited ? "Currently inherits the policy shown below." : "This scope has a saved override."}</p></div><StatusPill tone="warning">Desired · Not enforced</StatusPill></div></div>
    <div className="space-y-2"><label htmlFor="hermes-policy-name" className="text-[12px] font-medium text-ink">Policy name</label><input id="hermes-policy-name" className="h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} disabled={readOnly || pending || agentIsInternal} /></div>
    {agentIsInternal && <p className="rounded-xl border border-warning/20 bg-warning-soft p-3 text-[12px] text-warning-ink">Internal profiles remain on their existing Hermes configuration. Saving a per-profile desired override will block new portal runs until the gateway can apply and verify the changed policy.</p>}

    <fieldset disabled={readOnly || pending} className="space-y-2"><legend className="mb-2 text-[12px] font-semibold text-ink">Allowed business capabilities · desired</legend>{data.capabilityOptions.map((option) => <label key={option.key} className="flex min-h-11 items-center gap-3 rounded-xl border border-line px-3 py-2"><Switch id={`capability-${option.key}`} aria-label={option.label} checked={allowedCapabilities.includes(option.key)} onCheckedChange={(checked) => setAllowedCapabilities((current) => checked ? [...new Set([...current, option.key])] : current.filter((key) => key !== option.key))} /><span className="text-[12.5px] text-ink">{option.label}</span></label>)}</fieldset>

    <fieldset disabled={readOnly || pending} className="space-y-2"><legend className="mb-2 text-[12px] font-semibold text-ink">Restricted Hermes toolsets · desired</legend>{data.blockableToolsets.map((toolset) => <label key={toolset.key} className="flex min-h-11 items-center gap-3 rounded-xl border border-line px-3 py-2"><Switch id={`blocked-${toolset.key}`} aria-label={`${toolset.label} restricted`} checked={blockedToolsets.includes(toolset.key)} onCheckedChange={(checked) => setBlockedToolsets((current) => checked ? [...new Set([...current, toolset.key])] : current.filter((key) => key !== toolset.key))} /><span className="text-[12.5px] text-ink">{toolset.label}</span></label>)}</fieldset>

    <div className="space-y-2"><label htmlFor="approval-mode" className="text-[12px] font-semibold text-ink">Approval policy · desired</label><Select id="approval-mode" value={approvalMode} disabled={readOnly || pending} onChange={(event) => setApprovalMode(event.target.value as HermesPolicyRecord["approvalMode"])}><option value="client_rules">Use the client&apos;s configured rules</option><option value="approval_required">Require approval for actions</option><option value="read_only">Read-only actions</option></Select><p className="text-[11px] text-muted">Approval settings are recorded for review; the current Hermes API does not apply these policy values.</p></div>
    {policyError && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-[12px] text-danger-ink">{policyError}</p>}
    {data.editable && <div className="flex flex-wrap gap-2 border-t border-line pt-4"><Button variant="brand" loading={pending} onClick={savePolicy}><Save className="size-4" /> Save desired policy</Button>{target !== "client_default" && currentOverride && <Button variant="secondary" disabled={pending} onClick={resetPolicy}>Reset to inherited policy</Button>}</div>}
  </Card>;
}

function InternalAcknowledgement({ profiles, timeZone, selected, setSelected, onConfirm }: {
  profiles: HermesToolPolicyView["agents"];
  timeZone: string;
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  onConfirm: () => void;
}) {
  const selectable = profiles.filter((profile) => profile.canAcknowledgeFullCapabilities && !profile.fullCapabilitiesAcknowledged);
  return <Card className="space-y-4 border-violet/20 p-5">
    <div className="flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-soft text-violet"><Bot className="size-4" /></span>
      <div>
        <h2 className="text-sm font-semibold text-ink">Internal agency profiles · Full Hermes Capabilities</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">Acknowledge only profiles with a verified identity and authenticated API check. Each profile is recorded separately; the current gateway configuration is not changed.</p>
      </div>
    </div>
    <p className="text-[11px] text-muted">A checked switch shows an acknowledgement already saved or a profile selected below. Saved acknowledgements stay on and cannot be changed here.</p>
    <div className="space-y-2">
      {profiles.map((profile) => {
        const acknowledged = profile.fullCapabilitiesAcknowledged;
        const checked = acknowledged || selected.includes(profile.id);
        const canAcknowledge = profile.canAcknowledgeFullCapabilities && !acknowledged;
        return <div key={profile.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-ink">{AGENT_BY_KEY[profile.roleKey].shortName}</p>
            <p className="mt-1 break-all font-mono text-[10px] text-muted">{profile.profile ?? "Not mapped"}</p>
            <p className="mt-1 text-[10px] text-muted">Configuration: {profile.configVersion ? `v${profile.configVersion}` : "not applied"} · Identity: {profile.identityMapped ? "current" : profile.lastProfileCheck ?? "check required"}</p>
            <p className="mt-1 text-[10px] text-muted">Tool permissions: {profile.toolPermissionsStatus ?? "unverified"} · Inventory: {profile.inventoryCurrent ? "current" : profile.inventoryDigest ? "expired / refresh required" : "not recorded"}{profile.inventoryToolCount ? ` · ${profile.inventoryToolCount} tools` : ""}{profile.inventoryExpiresAt ? ` · expires ${formatDate(profile.inventoryExpiresAt, timeZone)}` : ""}</p>
            {profile.inventoryDigest && <p className="mt-1 break-all font-mono text-[9px] text-muted">Digest {profile.inventoryDigest.slice(0, 16)}…</p>}
            {acknowledged && <p className="mt-1 text-[10px] text-violet">Acknowledged by {profile.acknowledgedBy ?? "Super Admin"}{profile.acknowledgedAt ? ` · ${formatDate(profile.acknowledgedAt, timeZone)}` : ""}</p>}
          </div>
          <StatusPill tone={acknowledged ? "violet" : profile.canAcknowledgeFullCapabilities ? profile.identityMapped ? "success" : "warning" : "warning"}>
            {acknowledged ? "Acknowledged · current" : profile.canAcknowledgeFullCapabilities ? profile.identityMapped ? "Verified · not acknowledged" : "Identity refresh required" : "Prerequisite required"}
          </StatusPill>
          <Switch
            id={`agency-ack-${profile.id}`}
            aria-label={acknowledged ? `Profile capabilities authorized for ${profile.displayName}` : `Select ${profile.displayName} for Full Hermes Capabilities acknowledgement`}
            checked={checked}
            disabled={!canAcknowledge}
            className={acknowledged ? "disabled:opacity-100" : undefined}
            onCheckedChange={(nextChecked) => setSelected((current) => nextChecked ? [...new Set([...current, profile.id])] : current.filter((id) => id !== profile.id))}
          />
        </div>;
      })}
      {!profiles.length && <p className="rounded-xl bg-surface-2 p-3 text-[12px] text-muted">No existing internal employee records were found. Connect or verify them from Internal Workforce first.</p>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <p className="text-[11px] text-muted">Expired inventory is refreshed during acknowledgement; the inventory digest must match its previously verified baseline.</p>
      <Button variant="secondary" disabled={!selectable.length || !selected.length} onClick={onConfirm}><CheckCircle2 className="size-4" /> Acknowledge {selected.length} selected</Button>
    </div>
    {profiles.some((profile) => !profile.fullCapabilitiesAcknowledged && !profile.canAcknowledgeFullCapabilities) && <p className="text-[11px] text-warning-ink">A profile must be enabled, have an applied configuration, pass its latest health check, have a saved approved identity and credential, and have a previously verified inventory before acknowledgement. Resolve these prerequisites in Internal Workforce first.</p>}
  </Card>;
}
