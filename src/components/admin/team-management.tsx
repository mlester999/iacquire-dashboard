"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight, Building2, Clock3, Crown, ListChecks, Mail, Search, ShieldCheck, UserX, Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Input, ProgressBar, Select } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { InviteStaff } from "@/components/admin/invite-staff";
import { revokeInvitationAction } from "@/app/(admin)/admin/actions";
import type { AgencyTeamView } from "@/server/admin/team";
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
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [revokingInvitation, setRevokingInvitation] = React.useState<string | null>(null);
  const active = data.members.filter((item) => item.status === "active").length;
  const coverage = data.coverage.total ? Math.round(data.coverage.assigned / data.coverage.total * 100) : null;
  const visible = data.members.filter((item) => (filter === "all" || item.role === filter) && `${item.name} ${item.email}`.toLowerCase().includes(search.toLowerCase()));
  const revokeInvitation = async (id: string) => {
    if (!window.confirm("Revoke this pending agency invitation? Its invitation link will stop working.")) return;
    setRevokingInvitation(id);
    try {
      const result = await revokeInvitationAction(id);
      if (!result.ok) toast.error(result.error);
      else { toast.success("Invitation revoked."); router.refresh(); }
    } catch {
      toast.error("The invitation could not be revoked.");
    } finally {
      setRevokingInvitation(null);
    }
  };

  return <div className="space-y-6">
    <PageHero tone="dark" eyebrow="Agency operations" icon={<Users className="size-5" />} title="The people behind the platform." description="Manage agency roles, client scope, individual permissions and team coverage in one shared workspace." aside={<InviteStaff clients={data.clients} roleDefaults={data.permissionDefaults} />}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[
        { label: "Team members", value: data.members.length, note: `${active} active accounts` },
        { label: "Invitations pending", value: data.invitations.length, note: "Awaiting account acceptance" },
        { label: "Clients assigned", value: data.coverage.assigned, note: `of ${data.coverage.total} client workspaces` },
        { label: "Role groups", value: new Set(data.members.map((item) => item.role)).size, note: "Current authorization roles" },
      ].map((stat) => <div key={stat.label} className="rounded-xl bg-white/[.05] p-4 ring-1 ring-inset ring-white/10"><dt className="text-[12px] text-white/70">{stat.label}</dt><dd className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-white">{stat.value}</dd><p className="mt-1 text-[12px] text-white/55">{stat.note}</p></div>)}</dl>
    </PageHero>

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-4"><h2 className="text-[16px] font-semibold text-ink">Your agency, connected</h2><p className="mt-1 text-[13px] text-muted">Roles define authority. Client scope separately limits which workspaces are available.</p></div>
        <div className="p-5">
          <div className="mx-auto flex w-fit max-w-full items-center gap-3 rounded-2xl border border-primary/20 bg-primary-soft px-5 py-3"><span className="grid size-10 place-items-center rounded-xl bg-primary text-white"><ShieldCheck className="size-5" /></span><div><p className="text-sm font-semibold text-primary-ink">iAcquire agency</p><p className="text-xs text-muted">Owner-controlled team roles</p></div></div>
          <div aria-hidden className="mx-auto h-7 w-px bg-line-strong" />
          <div className="grid gap-4 md:grid-cols-3">{ROLE_ORDER.map((role, index) => {
            const group = data.members.filter((item) => item.role === role);
            const Icon = ROLE_ICON[role];
            return <motion.div key={role} initial={false} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .05 }} className="min-w-0">
              <details open className={cn("rounded-2xl border", role === "agency_super_admin" ? "border-violet/20 bg-violet-soft/30" : "border-primary/20 bg-primary-soft/25")}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-ink"><Icon className={cn("size-4", role === "agency_super_admin" ? "text-violet" : "text-primary")} />{ROLE[role]}<span className="ml-auto rounded-md bg-surface px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2 ring-1 ring-inset ring-line">{group.length}</span></summary>
                <div className="space-y-2 px-3 pb-3">{group.map((item) => {
                  const body = <><AvatarTile name={item.name} /><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold text-ink">{item.name}</span><span className="mt-1 block text-[12px] text-muted">{item.role === "agency_super_admin" ? "Every client workspace · platform controls" : item.scopeMode === "all_clients" ? "All current and future clients" : pluralize(item.clients.length, "client assignment")}</span></span>{item.role !== "agency_super_admin" && <ArrowUpRight className="size-3.5 shrink-0 text-muted" />}</>;
                  return item.role === "agency_super_admin"
                    ? <div role="group" key={item.id} className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left shadow-soft" aria-label="Super Admin platform account">{body}</div>
                    : <Link key={item.id} href={`/admin/team/${item.id}`} className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 text-left shadow-soft transition hover:border-primary/30">{body}</Link>;
                })}{!group.length && <p className="rounded-xl border border-dashed border-line-strong p-3 text-[12px] text-muted">No {ROLE[role]} accounts.</p>}</div>
              </details>
            </motion.div>;
          })}</div>
        </div>
        <div className="grid gap-3 border-t border-line bg-surface-2/50 px-5 py-4 text-[13px] leading-relaxed text-muted sm:grid-cols-3">
          <p><strong className="font-semibold text-ink-2">Super Admin</strong> owns team and infrastructure access.</p>
          <p><strong className="font-semibold text-ink-2">Agency Manager</strong> has all clients by default; scope can be narrowed.</p>
          <p><strong className="font-semibold text-ink-2">Agency Staff</strong> can access assigned clients only.</p>
        </div>
      </Card>

      <Card className="flex flex-col p-5"><div className="mb-4 flex items-center gap-2"><span className="grid size-9 place-items-center rounded-xl bg-success-soft text-success-ink"><Building2 className="size-4" /></span><h2 className="text-[15px] font-semibold">Client coverage</h2></div><p className="text-4xl font-semibold tabular-nums tracking-tight text-ink">{coverage === null ? "—" : `${coverage}%`}</p><p className="mt-1 text-[14px] text-muted">with an explicit team assignment</p>{coverage !== null && <ProgressBar className="mt-4 h-2" tone="success" value={coverage} label="Client assignment coverage" />}<div className="mt-3"><InfoChip icon={<Building2 />}>{data.coverage.assigned} of {data.coverage.total} assigned</InfoChip></div><p className="mt-4 text-[13px] leading-relaxed text-muted">Super Admins and full-scope Managers can already reach every client. This meter tracks explicit team assignments.</p><div className="mt-5 space-y-2">{data.clients.filter((client) => !client.assignedStaff).slice(0, 3).map((client) => <Link key={client.id} href={`/admin/clients/${client.id}?tab=team`} className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2 text-xs text-ink-2 ring-1 ring-inset ring-line"><span className="flex min-w-0 items-center gap-2.5"><AvatarTile name={client.name} size="sm" /><span className="truncate font-medium">{client.name}</span></span><StatusPill tone="warning" size="sm" icon={<UserX className="size-3" />}>Unassigned</StatusPill></Link>)}{!data.clients.length && <p className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted">Create a client workspace to start assigning coverage.</p>}</div><Link href="/admin/clients" className="mt-auto flex min-h-11 items-center gap-1 pt-5 text-[14px] font-medium text-primary hover:underline">Manage client coverage <ArrowUpRight className="size-3.5" /></Link></Card>
    </div>

    <section className="space-y-4"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="text-lg font-semibold tracking-tight text-ink">People directory</h2><p className="text-[13px] text-muted">Open a teammate to review effective access, assigned clients and real activity.</p></div><div className="flex flex-col gap-2 sm:flex-row"><div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" /><Input className="pl-9 sm:w-60" aria-label="Search agency team" placeholder="Find a team member…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><Select aria-label="Filter agency team by role" className="sm:w-44" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Every role</option><option value="agency_super_admin">Super Admin</option><option value="agency_manager">Agency Manager</option><option value="agency_staff">Agency Staff</option></Select></div></div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{visible.map((item, index) => {
        const body = <><div className="mb-4 flex items-center justify-between gap-3"><AvatarTile name={item.name} size="lg" /><MemberStatus status={item.status} /></div><h3 className="truncate text-[15px] font-semibold text-ink">{item.name}</h3><p className="mt-1 truncate text-[13px] text-muted">{item.email}</p><div className="mt-4 flex flex-wrap items-center gap-1.5"><RolePill role={item.role} size="sm" /><InfoChip icon={<Building2 />}>{item.role === "agency_super_admin" ? "All client workspaces" : item.scopeMode === "all_clients" ? "All clients" : pluralize(item.clients.length, "assigned client")}</InfoChip><InfoChip icon={<ListChecks />}>{pluralize(item.openTasks, "open task")}</InfoChip></div><div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3"><InfoChip icon={<Clock3 />}>{item.lastLoginAt ? `Last sign-in ${relativeTime(item.lastLoginAt)}` : "Has not signed in yet"}</InfoChip>{item.role !== "agency_super_admin" && <ArrowUpRight className="size-4 shrink-0 text-muted transition group-hover:text-primary" />}</div></>;
        return <motion.div key={item.id} initial={false} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index * .035, .2) }} className="min-w-0">{item.role === "agency_super_admin"
          ? <div role="group" className="relative block min-w-0 rounded-2xl border border-line bg-surface p-5 text-left shadow-soft" aria-label="Super Admin platform account">{body}</div>
          : <Link href={`/admin/team/${item.id}`} className="group relative block min-w-0 rounded-2xl border border-line bg-surface p-5 text-left shadow-soft transition hover:border-primary/25 hover:shadow-card">{body}</Link>}</motion.div>;
      })}</div>
      {!visible.length && <Card><EmptyState compact icon={<Search className="size-5" />} title="No matching people" description="Try a name, email, or another role." /></Card>}
    </section>

    {data.invitations.length > 0 && <Card className="overflow-hidden"><div className="flex items-center gap-2.5 border-b border-line px-5 py-4"><span className="grid size-8 place-items-center rounded-lg bg-warning-soft text-warning-ink"><Mail className="size-4" /></span><h2 className="text-sm font-semibold">Pending invitations</h2><span className="rounded-md bg-surface-3 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2">{data.invitations.length}</span></div><ul className="divide-y divide-line">{data.invitations.map((invite) => <li key={invite.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{invite.email}</p><div className="mt-1.5 flex flex-wrap items-center gap-1.5"><StatusPill tone="warning" size="sm">Pending</StatusPill><InfoChip icon={<Clock3 />}>Expires {formatDate(invite.expiresAt, timeZone)}</InfoChip><span className="text-[12px] text-muted">Email: {invite.deliveryStatus ?? "unknown"}</span><span className="text-[12px] text-muted">{invite.scopeMode === "all_clients" ? "All clients" : `${invite.initialAssignments} initial assignments`}</span>{invite.customPermissionCount > 0 && <StatusPill tone="violet" size="sm">{invite.customPermissionCount} custom permissions</StatusPill>}</div></div><span className="text-[12px] font-medium text-muted">{invite.role === "agency_manager" ? "Agency Manager" : invite.role === "agency_staff" ? "Agency Staff" : "Legacy Super Admin invitation"}</span><Button size="sm" variant="outline" loading={revokingInvitation === invite.id} disabled={revokingInvitation !== null} onClick={() => void revokeInvitation(invite.id)}>Revoke</Button></li>)}</ul></Card>}
  </div>;
}
