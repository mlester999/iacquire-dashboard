"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ArrowUpRight, Building2, CheckCircle2, Clock3, Crown, ListChecks, Mail, Search, ShieldCheck, UserX, Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Field, Input, ProgressBar, Select } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { Dialog, Sheet, Switch } from "@/components/ui/overlays";
import { InviteStaff } from "@/components/admin/invite-staff";
import { assignStaffAction, setAgencyUserPermissionAction, updateAgencyTeamMemberAction } from "@/app/(admin)/admin/actions";
import type { AgencyTeamView } from "@/server/admin/team";
import { AGENCY_DELEGABLE_PERMISSIONS, AGENCY_PERMISSION_INFO, agencyRoleHasPermission, type AgencyPermission } from "@/lib/permissions";
import { cn, formatDate, pluralize, relativeTime } from "@/lib/utils";

type Member = AgencyTeamView["members"][number];
const ROLE = { agency_super_admin: "Super Admin", agency_manager: "Agency Manager", agency_staff: "Agency Staff" } as const;
const ROLE_ICON = { agency_super_admin: Crown, agency_manager: ShieldCheck, agency_staff: Workflow } as const;
const ROLE_ORDER: Member["role"][] = ["agency_super_admin", "agency_manager", "agency_staff"];

function RolePill({ role, size }: { role: Member["role"]; size?: "sm" | "md" }) {
  const Icon = ROLE_ICON[role];
  return <StatusPill tone={role === "agency_super_admin" ? "violet" : "primary"} size={size} icon={<Icon className="size-3" aria-hidden />}>{ROLE[role]}</StatusPill>;
}

function MemberStatus({ status }: { status: string }) {
  return <StatusPill status={status === "active" ? "active" : "disabled"}>{status === "active" ? "Active" : "Disabled"}</StatusPill>;
}

export function TeamManagement({ data, timeZone }: { data: AgencyTeamView; timeZone: string }) {
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [open, setOpen] = React.useState<string | null>(null);
  const member = data.members.find((item) => item.id === open) ?? null;
  const active = data.members.filter((item) => item.status === "active").length;
  const coverage = data.coverage.total ? Math.round(data.coverage.assigned / data.coverage.total * 100) : null;
  const visible = data.members.filter((item) => (filter === "all" || item.role === filter) && `${item.name} ${item.email}`.toLowerCase().includes(search.toLowerCase()));

  return <div className="space-y-6">
    <PageHero tone="dark" eyebrow="Agency operations" icon={<Users className="size-5" />} title="The people behind the platform." description="Manage agency roles, client scope, individual permissions and team coverage in one shared workspace." aside={<InviteStaff clients={data.clients} />}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[
        { label: "Team members", value: data.members.length, note: `${active} active accounts` },
        { label: "Invitations pending", value: data.invitations.length, note: "Awaiting account acceptance" },
        { label: "Clients assigned", value: data.coverage.assigned, note: `of ${data.coverage.total} client workspaces` },
        { label: "Role groups", value: new Set(data.members.map((item) => item.role)).size, note: "Current authorization roles" },
      ].map((stat) => <div key={stat.label} className="rounded-xl bg-white/[.05] p-4 ring-1 ring-inset ring-white/10"><dt className="text-[12px] text-white/70">{stat.label}</dt><dd className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-white">{stat.value}</dd><p className="mt-1 text-[11.5px] text-white/55">{stat.note}</p></div>)}</dl>
    </PageHero>

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-4"><h2 className="text-[16px] font-semibold text-ink">Your agency, connected</h2><p className="mt-1 text-[12.5px] text-muted">Roles define authority. Client scope separately limits which workspaces are available.</p></div>
        <div className="p-5">
          <div className="mx-auto flex w-fit max-w-full items-center gap-3 rounded-2xl border border-primary/20 bg-primary-soft px-5 py-3"><span className="grid size-10 place-items-center rounded-xl bg-primary text-white"><ShieldCheck className="size-5" /></span><div><p className="text-sm font-semibold text-primary-ink">iAcquire agency</p><p className="text-xs text-muted">Owner-controlled team roles</p></div></div>
          <div aria-hidden className="mx-auto h-7 w-px bg-line-strong" />
          <div className="grid gap-4 md:grid-cols-3">{ROLE_ORDER.map((role, index) => {
            const group = data.members.filter((item) => item.role === role);
            const Icon = ROLE_ICON[role];
            return <motion.div key={role} initial={false} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .05 }} className="min-w-0">
              <details open className={cn("rounded-2xl border", role === "agency_super_admin" ? "border-violet/20 bg-violet-soft/30" : "border-primary/20 bg-primary-soft/25")}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-ink"><Icon className={cn("size-4", role === "agency_super_admin" ? "text-violet" : "text-primary")} />{ROLE[role]}<span className="ml-auto rounded-md bg-surface px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2 ring-1 ring-inset ring-line">{group.length}</span></summary>
                <div className="space-y-2 px-3 pb-3">{group.map((item) => <button key={item.id} type="button" onClick={() => setOpen(item.id)} className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left shadow-soft transition hover:border-primary/30"><AvatarTile name={item.name} /><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-ink">{item.name}</span><span className="mt-1 block text-[11px] text-muted">{item.role === "agency_super_admin" ? "Every client workspace" : item.scopeMode === "all_clients" ? "All current and future clients" : pluralize(item.clients.length, "client assignment")}</span></span><ArrowUpRight className="size-3.5 shrink-0 text-muted" /></button>)}{!group.length && <p className="rounded-xl border border-dashed border-line-strong p-3 text-[12px] text-muted">No {ROLE[role]} accounts.</p>}</div>
              </details>
            </motion.div>;
          })}</div>
        </div>
        <div className="grid gap-3 border-t border-line bg-surface-2/50 px-5 py-4 text-[12.5px] leading-relaxed text-muted sm:grid-cols-3">
          <p><strong className="font-semibold text-ink-2">Super Admin</strong> owns team and infrastructure access.</p>
          <p><strong className="font-semibold text-ink-2">Agency Manager</strong> has all clients by default; scope can be narrowed.</p>
          <p><strong className="font-semibold text-ink-2">Agency Staff</strong> can access assigned clients only.</p>
        </div>
      </Card>

      <Card className="flex flex-col p-5"><div className="mb-4 flex items-center gap-2"><span className="grid size-9 place-items-center rounded-xl bg-success-soft text-success-ink"><Building2 className="size-4" /></span><h2 className="text-[15px] font-semibold">Client coverage</h2></div><p className="text-4xl font-semibold tabular-nums tracking-tight text-ink">{coverage === null ? "—" : `${coverage}%`}</p><p className="mt-1 text-[13px] text-muted">with an explicit team assignment</p>{coverage !== null && <ProgressBar className="mt-4 h-2" tone="success" value={coverage} label="Client assignment coverage" />}<div className="mt-3"><InfoChip icon={<Building2 />}>{data.coverage.assigned} of {data.coverage.total} assigned</InfoChip></div><p className="mt-4 text-[12.5px] leading-relaxed text-muted">Super Admins and full-scope Managers can already reach every client. This meter tracks explicit team assignments.</p><div className="mt-5 space-y-2">{data.clients.filter((client) => !client.assignedStaff).slice(0, 3).map((client) => <Link key={client.id} href={`/admin/clients/${client.id}?tab=team`} className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2 text-xs text-ink-2 ring-1 ring-inset ring-line"><span className="flex min-w-0 items-center gap-2.5"><AvatarTile name={client.name} size="sm" /><span className="truncate font-medium">{client.name}</span></span><StatusPill tone="warning" size="sm" icon={<UserX className="size-3" />}>Unassigned</StatusPill></Link>)}{!data.clients.length && <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] text-muted">Create a client workspace to start assigning coverage.</p>}</div><Link href="/admin/clients" className="mt-auto flex min-h-11 items-center gap-1 pt-5 text-[13px] font-medium text-primary hover:underline">Manage client coverage <ArrowUpRight className="size-3.5" /></Link></Card>
    </div>

    <section className="space-y-4"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="text-lg font-semibold tracking-tight text-ink">People directory</h2><p className="text-[12.5px] text-muted">Role, client access, permissions and recorded activity.</p></div><div className="flex flex-col gap-2 sm:flex-row"><div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" /><Input className="pl-9 sm:w-60" aria-label="Search agency team" placeholder="Find a team member…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><Select aria-label="Filter agency team by role" className="sm:w-44" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Every role</option><option value="agency_super_admin">Super Admin</option><option value="agency_manager">Agency Manager</option><option value="agency_staff">Agency Staff</option></Select></div></div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{visible.map((item, index) => <motion.button key={item.id} type="button" initial={false} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index * .035, .2) }} onClick={() => setOpen(item.id)} className="group relative min-w-0 rounded-2xl border border-line bg-surface p-5 text-left shadow-soft transition hover:border-primary/25 hover:shadow-card"><div className="mb-4 flex items-center justify-between gap-3"><AvatarTile name={item.name} size="lg" /><MemberStatus status={item.status} /></div><h3 className="truncate text-[15px] font-semibold text-ink">{item.name}</h3><p className="mt-1 truncate text-[12.5px] text-muted">{item.email}</p><div className="mt-4 flex flex-wrap items-center gap-1.5"><RolePill role={item.role} size="sm" /><InfoChip icon={<Building2 />}>{item.role === "agency_super_admin" ? "All client workspaces" : item.scopeMode === "all_clients" ? "All clients" : pluralize(item.clients.length, "assigned client")}</InfoChip><InfoChip icon={<ListChecks />}>{pluralize(item.openTasks, "open task")}</InfoChip></div><div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3"><InfoChip icon={<Clock3 />}>{item.lastLoginAt ? `Last sign-in ${relativeTime(item.lastLoginAt)}` : "Has not signed in yet"}</InfoChip><ArrowUpRight className="size-4 shrink-0 text-muted transition group-hover:text-primary" /></div></motion.button>)}</div>
      {!visible.length && <Card><EmptyState compact icon={<Search className="size-5" />} title="No matching people" description="Try a name, email, or another role." /></Card>}
    </section>

    {data.invitations.length > 0 && <Card className="overflow-hidden"><div className="flex items-center gap-2.5 border-b border-line px-5 py-4"><span className="grid size-8 place-items-center rounded-lg bg-warning-soft text-warning-ink"><Mail className="size-4" /></span><h2 className="text-sm font-semibold">Pending invitations</h2><span className="rounded-md bg-surface-3 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2">{data.invitations.length}</span></div><ul className="divide-y divide-line">{data.invitations.map((invite) => <li key={invite.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{invite.email}</p><div className="mt-1.5 flex flex-wrap items-center gap-1.5"><StatusPill tone="warning" size="sm">Pending</StatusPill><InfoChip icon={<Clock3 />}>Expires {formatDate(invite.expiresAt, timeZone)}</InfoChip><span className="text-[11px] text-muted">Email: {invite.deliveryStatus ?? "unknown"}</span><span className="text-[11px] text-muted">{invite.scopeMode === "all_clients" ? "All clients" : `${invite.initialAssignments} initial assignments`}</span></div></div><span className="text-[12px] font-medium text-muted">{invite.role === "agency_manager" ? "Agency Manager" : invite.role === "agency_staff" ? "Agency Staff" : "Legacy Super Admin invitation"}</span></li>)}</ul></Card>}

    <Sheet open={Boolean(member)} onOpenChange={(value) => !value && setOpen(null)} title={member?.name ?? "Team member"} description="Manage this account's role, client scope, permissions and activity.">
      {member && <MemberDetails key={member.id} member={member} clients={data.clients} timeZone={timeZone} />}
    </Sheet>
  </div>;
}

function MemberDetails({ member, clients, timeZone }: { member: Member; clients: AgencyTeamView["clients"]; timeZone: string }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [platformRole, setPlatformRole] = React.useState<"agency_manager" | "agency_staff">(member.role === "agency_staff" ? "agency_staff" : "agency_manager");
  const [status, setStatus] = React.useState<"active" | "disabled">(member.status === "active" ? "active" : "disabled");
  const [scopeMode, setScopeMode] = React.useState<"all_clients" | "assigned_clients">(member.scopeMode);
  const [confirmAccess, setConfirmAccess] = React.useState(false);
  const [permissionChange, setPermissionChange] = React.useState<{ permission: AgencyPermission; effect: "allow" | "deny" | null } | null>(null);
  const isOwner = member.role === "agency_super_admin";
  const groups = [...new Set(Object.values(AGENCY_PERMISSION_INFO).map((item) => item.group))];

  const saveAccess = () => start(async () => {
    const result = await updateAgencyTeamMemberAction({ userId: member.id, platformRole, status, scopeMode });
    if (!result.ok) toast.error(result.error);
    else { toast.success("Team access updated. Existing sessions have been revoked."); setConfirmAccess(false); router.refresh(); }
  });

  const savePermission = () => {
    if (!permissionChange) return;
    const change = permissionChange;
    start(async () => {
      const result = await setAgencyUserPermissionAction({ userId: member.id, permission: change.permission, effect: change.effect, reason: "Updated in Agency Team & Permissions." });
      if (!result.ok) toast.error(result.error);
      else { toast.success(change.effect ? "Permission override saved." : "Permission reset to its role default."); setPermissionChange(null); router.refresh(); }
    });
  };

  return <div className="space-y-6 p-5">
    <div className="rounded-2xl bg-surface-2 p-5"><div className="flex items-center gap-3"><AvatarTile name={member.name} size="lg" /><div className="min-w-0"><p className="font-semibold text-ink">{member.name}</p><p className="break-all text-[13px] text-muted">{member.email}</p></div></div><div className="mt-4 flex flex-wrap gap-2"><RolePill role={member.role} /><MemberStatus status={member.status} /></div></div>
    <dl className="grid grid-cols-2 gap-3">{[{ label: "Open setup tasks", value: member.openTasks }, { label: "Assigned support tickets", value: member.openTickets }].map((item) => <div key={item.label} className="rounded-xl border border-line p-3"><dd className="text-2xl font-semibold tabular-nums">{item.value}</dd><dt className="mt-1 text-xs text-muted">{item.label}</dt></div>)}</dl>

    <section className="space-y-3"><h3 className="text-sm font-semibold">Account and client scope</h3>
      {isOwner ? <div className="rounded-xl border border-violet/20 bg-violet-soft/40 p-4 text-[13px] leading-relaxed text-violet-ink"><Crown className="mb-2 size-4" />Super Admin ownership cannot be changed or delegated from this screen.</div> : <>
        <Field label="Role" htmlFor={`role-${member.id}`}><Select id={`role-${member.id}`} value={platformRole} disabled={pending} onChange={(event) => { const next = event.target.value as "agency_manager" | "agency_staff"; setPlatformRole(next); if (next === "agency_staff") setScopeMode("assigned_clients"); }}><option value="agency_manager">Agency Manager</option><option value="agency_staff">Agency Staff</option></Select></Field>
        {platformRole === "agency_manager" && <Field label="Client scope" htmlFor={`scope-${member.id}`}><Select id={`scope-${member.id}`} value={scopeMode} disabled={pending} onChange={(event) => setScopeMode(event.target.value as "all_clients" | "assigned_clients")}><option value="all_clients">All current and future clients</option><option value="assigned_clients">Assigned clients only</option></Select></Field>}
        <Field label="Account status" htmlFor={`status-${member.id}`}><Select id={`status-${member.id}`} value={status} disabled={pending} onChange={(event) => setStatus(event.target.value as "active" | "disabled")}><option value="active">Active</option><option value="disabled">Disabled · revoke access</option></Select></Field>
        <Button variant="brand" disabled={pending || (platformRole === member.role && status === member.status && scopeMode === member.scopeMode)} onClick={() => setConfirmAccess(true)}>Save access changes</Button>
      </>}
      <p className="text-[12px] leading-relaxed text-muted">Scope is enforced on each server request and in tenant database policies. Disabling the account blocks profile resolution; role, scope and permission changes revoke existing portal sessions.</p>
    </section>

    {member.role !== "agency_super_admin" && <section className="space-y-3 border-t border-line pt-5"><div><h3 className="text-sm font-semibold">Individual permissions</h3><p className="mt-1 text-[12px] text-muted">Only supported operational permissions can be adjusted. Protected owner controls remain locked.</p></div>
      {groups.map((group) => <div key={group} className="space-y-2"><h4 className="pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{group}</h4>{Object.entries(AGENCY_PERMISSION_INFO).filter(([, info]) => info.group === group).map(([rawPermission, info]) => {
        const permission = rawPermission as AgencyPermission;
        const override = member.permissionOverrides[permission];
        const baseline = agencyRoleHasPermission(member.role, permission);
        const effective = override ? override === "allow" : baseline;
        const canEdit = AGENCY_DELEGABLE_PERMISSIONS.includes(permission) && member.status === "active";
        const explanation = override ? `Custom ${override === "allow" ? "allow" : "deny"}` : baseline ? "Allowed by role" : "Restricted by role";
        return <div key={permission} className="rounded-xl border border-line bg-surface p-3"><div className="flex items-center gap-3"><div className="min-w-0 flex-1"><p className="text-[12.5px] font-medium text-ink">{info.label}</p><p className="mt-1 text-[11px] text-muted">{explanation}{!canEdit && !info.delegable ? " · protected" : ""}</p></div><Switch id={`permission-${member.id}-${permission}`} aria-label={info.label} checked={effective} disabled={!canEdit || pending} onCheckedChange={(checked) => setPermissionChange({ permission, effect: checked ? "allow" : "deny" })} /></div>{override && <button type="button" disabled={pending} className="mt-2 text-[11px] font-medium text-primary hover:underline" onClick={() => setPermissionChange({ permission, effect: null })}>Reset to role default</button>}</div>;
      })}</div>)}
    </section>}

    {platformRole === "agency_manager" || member.role === "agency_staff" ? <section className="space-y-3 border-t border-line pt-5"><h3 className="text-sm font-semibold">Assigned clients</h3>{member.role === "agency_manager" && scopeMode === "all_clients" ? <div className="rounded-xl bg-primary-soft p-3 text-[13px] text-primary-ink"><CheckCircle2 className="mr-2 inline size-4" />All current and future clients are in scope.</div> : <div className="space-y-2">{clients.map((client) => <div key={client.id} className="flex min-h-14 items-center gap-3 rounded-xl border border-line px-3 py-2"><AvatarTile name={client.name} size="sm" /><Link href={`/admin/clients/${client.id}?tab=team`} className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink hover:text-primary">{client.name}</Link><Switch id={`assign-${member.id}-${client.id}`} aria-label={`Assign ${member.name} to ${client.name}`} checked={member.clients.some((item) => item.id === client.id)} disabled={pending || member.status !== "active" || isOwner} onCheckedChange={(assign) => start(async () => { const result = await assignStaffAction(client.id, member.id, assign); if (!result.ok) toast.error(result.error); else { toast.success(assign ? "Client access assigned" : "Client access removed"); router.refresh(); } })} /></div>)}{!clients.length && <p className="text-sm text-muted">No client workspaces to assign yet.</p>}</div>}</section> : null}

    <section className="space-y-3 border-t border-line pt-5"><div><h3 className="text-sm font-semibold">Activity</h3><p className="mt-1 text-[12px] text-muted">Recorded actions involving this teammate.</p></div>{member.activity.length ? <ul className="space-y-2">{member.activity.map((event, index) => <li key={`${event.action}-${event.occurredAt}-${index}`} className="flex items-start justify-between gap-3 rounded-xl bg-surface-2 p-3"><span className="min-w-0"><span className="block break-words text-[12px] font-medium text-ink">{event.action.replaceAll(".", " · ")}</span><span className="mt-1 block text-[11px] text-muted">{event.result}</span></span><time className="shrink-0 text-[10px] text-muted" dateTime={event.occurredAt}>{formatDate(event.occurredAt, timeZone)}</time></li>)}</ul> : <p className="rounded-xl border border-dashed border-line p-3 text-[12px] text-muted">No team activity has been recorded yet.</p>}{member.lastLoginAt && <InfoChip icon={<Clock3 />}>Last sign-in {formatDate(member.lastLoginAt, timeZone)}</InfoChip>}</section>

    <Dialog open={confirmAccess} onOpenChange={setConfirmAccess} title="Confirm team access change" description="Existing portal sessions will be revoked. The new role and scope will apply on the next request." footer={<><Button variant="secondary" disabled={pending} onClick={() => setConfirmAccess(false)}>Cancel</Button><Button variant="brand" loading={pending} onClick={saveAccess}>Confirm change</Button></>}>
      <p className="text-[13px] leading-relaxed text-muted">{status === "disabled" ? `Disable ${member.name} and end their access?` : `Set ${member.name} to ${ROLE[platformRole]} with ${scopeMode === "all_clients" ? "all current and future clients" : "assigned clients only"}?`}</p>
    </Dialog>
    <Dialog open={Boolean(permissionChange)} onOpenChange={(value) => !value && setPermissionChange(null)} title="Confirm permission change" description="This change is recorded and revokes the teammate's existing portal sessions." footer={<><Button variant="secondary" disabled={pending} onClick={() => setPermissionChange(null)}>Cancel</Button><Button variant="brand" loading={pending} onClick={savePermission}>Confirm change</Button></>}>
      {permissionChange && <p className="text-[13px] leading-relaxed text-muted">{permissionChange.effect === null ? "Reset" : permissionChange.effect === "allow" ? "Allow" : "Restrict"} {AGENCY_PERMISSION_INFO[permissionChange.permission].label} for {member.name}?</p>}
    </Dialog>
  </div>;
}
