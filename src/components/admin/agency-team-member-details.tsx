"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowUpRight, Building2, Check, Clock3, History, Search, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Card, Input, Select } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { assignStaffAction, copyAgencyUserPermissionsAction, updateAgencyTeamMemberAction } from "@/app/(admin)/admin/actions";
import { AGENCY_TEAM_MANAGED_PERMISSIONS, AGENCY_TEAM_PERMISSION_INFO, AGENCY_TEAM_PERMISSION_VIEW_PARENT, AGENCY_TEAM_PROTECTED_PERMISSIONS, AGENCY_TEAM_PROTECTED_PERMISSION_INFO, isAgencyTeamPermission, type AgencyPermissionOverrides, type AgencyTeamPermission, type Permission } from "@/lib/permissions";
import type { AgencyTeamView } from "@/server/admin/team";
import { formatDate, relativeTime } from "@/lib/utils";

type Member = AgencyTeamView["members"][number];
type Tab = "overview" | "permissions" | "clients" | "activity";
type Filter = "all" | "allowed" | "restricted" | "customized";

const ALL_TEAM_PERMISSIONS = [...AGENCY_TEAM_MANAGED_PERMISSIONS, ...AGENCY_TEAM_PROTECTED_PERMISSIONS] as Permission[];

const roleLabel = (role: Member["role"]) => role === "agency_manager" ? "Agency Manager" : role === "agency_staff" ? "Agency Staff" : "Super Admin";
const toOverrideValue = (value: string): "allow" | "deny" | null => value === "allow" || value === "deny" ? value : null;

function permissionInfo(permission: Permission): { label: string; group: string; note?: string } {
  return isAgencyTeamPermission(permission)
    ? AGENCY_TEAM_PERMISSION_INFO[permission]
    : AGENCY_TEAM_PROTECTED_PERMISSION_INFO[permission];
}

function roleOrCustomPermission(member: Member, permission: Permission, defaults: AgencyTeamView["permissionDefaults"]) {
  if (isAgencyTeamPermission(permission)) {
    const override = member.permissionOverrides[permission];
    if (override) return override === "allow";
  }
  return defaults[member.role as "agency_manager" | "agency_staff"][permission] === true;
}

function effective(member: Member, permission: Permission, defaults: AgencyTeamView["permissionDefaults"]) {
  if (member.status !== "active") return false;
  const parent = AGENCY_TEAM_PERMISSION_VIEW_PARENT[permission as AgencyTeamPermission];
  if (parent && !roleOrCustomPermission(member, parent, defaults)) return false;
  return roleOrCustomPermission(member, permission, defaults);
}

function permissionSource(member: Member, permission: Permission, defaults: AgencyTeamView["permissionDefaults"]) {
  if (member.status !== "active") return "Suspended account";
  const parent = AGENCY_TEAM_PERMISSION_VIEW_PARENT[permission as AgencyTeamPermission];
  if (parent && !roleOrCustomPermission(member, parent, defaults)) {
    return `Blocked by ${parent === "website.view" ? "Website Studio" : "Projects"} view access`;
  }
  const role = roleLabel(member.role);
  const note = isAgencyTeamPermission(permission) ? "" : AGENCY_TEAM_PROTECTED_PERMISSION_INFO[permission].note.toLowerCase();
  const protectedSource = note.includes("super admin only")
    ? "Super Admin only"
    : note.includes("client owner or agency role control")
      ? "Client owner or agency policy"
      : note.includes("client owner")
      ? "Client owner policy"
      : note.includes("agency role control") || note.includes("agency role default")
        ? "Agency role policy"
        : "Client, scope or resource policy";
  const source = isAgencyTeamPermission(permission)
    ? member.permissionOverrides[permission]
      ? `Custom ${member.permissionOverrides[permission]} override`
      : `${role} role default`
    : protectedSource;
  return source;
}

function auditValue(value: unknown): string {
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "Not recorded";
}

function auditChanges(metadata: Record<string, unknown>): string[] {
  const changes = Array.isArray(metadata.changes) ? metadata.changes : [];
  const permissions = Array.isArray(metadata.permissions) ? metadata.permissions : [];
  return [...changes, ...permissions].flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const label = typeof row.permission === "string" && row.permission in AGENCY_TEAM_PERMISSION_INFO
      ? AGENCY_TEAM_PERMISSION_INFO[row.permission as AgencyTeamPermission].label
      : typeof row.field === "string" ? row.field.replaceAll("_", " ") : null;
    return label ? [`${label}: ${auditValue(row.from)} → ${auditValue(row.to)}`] : [];
  });
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  "team.invited": "Invitation created",
  "team.invitation_accepted": "Invitation accepted",
  "auth.invitation_accepted": "Invitation accepted",
  "team.invitation_resent": "Invitation resent",
  "team.invitation_revoked": "Invitation revoked",
  "team.access_updated": "Role, status or scope changed",
  "team.permissions_updated": "Permissions changed",
  "team.permissions_copied": "Permissions copied",
  "tenant.staff_assigned": "Client access assigned",
  "tenant.staff_unassigned": "Client access removed",
};

function auditActionLabel(action: string) {
  return AUDIT_ACTION_LABELS[action]
    ?? action.split(".").map((part) => part.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase())).join(" · ");
}

export function AgencyTeamMemberDetails({ data, memberId, timeZone }: { data: AgencyTeamView; memberId: string; timeZone: string }) {
  const router = useRouter();
  const member = data.members.find((item) => item.id === memberId)!;
  const [tab, setTab] = React.useState<Tab>("overview");
  const [draftOverrides, setDraftOverrides] = React.useState<AgencyPermissionOverrides>(member.permissionOverrides);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const [clientSearch, setClientSearch] = React.useState("");
  const [expandAll, setExpandAll] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [status, setStatus] = React.useState<"active" | "disabled">(member.status === "active" ? "active" : "disabled");
  const [role, setRole] = React.useState<"agency_manager" | "agency_staff">(member.role === "agency_manager" ? "agency_manager" : "agency_staff");
  const [scopeMode, setScopeMode] = React.useState<"all_clients" | "assigned_clients">(member.scopeMode);
  const [pendingRole, setPendingRole] = React.useState<"agency_manager" | "agency_staff" | null>(null);
  const [compareUserId, setCompareUserId] = React.useState("");
  const [copySourceId, setCopySourceId] = React.useState("");
  const [copySelection, setCopySelection] = React.useState<Set<AgencyTeamPermission>>(new Set());
  const [copySearch, setCopySearch] = React.useState("");
  const [copyConfirm, setCopyConfirm] = React.useState(false);
  const [importantOnly, setImportantOnly] = React.useState(false);
  const [assignmentConfirmation, setAssignmentConfirmation] = React.useState<{ clientId: string; assign: boolean } | null>(null);
  const [saveConfirmationOpen, setSaveConfirmationOpen] = React.useState(false);
  const [pendingNavigationHref, setPendingNavigationHref] = React.useState<string | null>(null);

  const permissionChanges: Partial<Record<AgencyTeamPermission, "allow" | "deny" | null>> = {};
  for (const permission of AGENCY_TEAM_MANAGED_PERMISSIONS) {
    const before = member.permissionOverrides[permission] ?? null;
    const after = draftOverrides[permission] ?? null;
    if (before !== after) permissionChanges[permission] = after;
  }
  const dirtyPermissions = Object.keys(permissionChanges).length > 0;
  const dirtyAccount = role !== member.role || status !== (member.status === "active" ? "active" : "disabled") || scopeMode !== member.scopeMode;
  const hasUnsavedChanges = dirtyAccount || dirtyPermissions;
  const draftMember: Member = { ...member, role, status, scopeMode, permissionOverrides: draftOverrides };
  const groups = [...new Set(ALL_TEAM_PERMISSIONS.map((permission) => permissionInfo(permission).group))];
  const allowed = ALL_TEAM_PERMISSIONS.filter((permission) => effective(draftMember, permission, data.permissionDefaults));
  const allowedGroups = new Set(allowed.map((permission) => permissionInfo(permission).group));
  const effectiveChanges = ALL_TEAM_PERMISSIONS.filter((permission) =>
    effective(member, permission, data.permissionDefaults) !== effective(draftMember, permission, data.permissionDefaults)
    || permissionSource(member, permission, data.permissionDefaults) !== permissionSource(draftMember, permission, data.permissionDefaults));
  const overrideCount = Object.keys(member.permissionOverrides).length;
  const searchLower = search.trim().toLowerCase();
  const visiblePermissions = AGENCY_TEAM_MANAGED_PERMISSIONS.filter((permission) => {
    const label = AGENCY_TEAM_PERMISSION_INFO[permission].label.toLowerCase();
    const isAllowed = effective(draftMember, permission, data.permissionDefaults);
    const isCustom = Object.hasOwn(draftOverrides, permission);
    return (!searchLower || label.includes(searchLower) || AGENCY_TEAM_PERMISSION_INFO[permission].group.toLowerCase().includes(searchLower))
      && (filter === "all" || filter === "allowed" && isAllowed || filter === "restricted" && !isAllowed || filter === "customized" && isCustom);
  });
  const visibleProtectedPermissions = AGENCY_TEAM_PROTECTED_PERMISSIONS.filter((permission) => {
    const info = AGENCY_TEAM_PROTECTED_PERMISSION_INFO[permission];
    const isAllowed = effective(draftMember, permission, data.permissionDefaults);
    return (!searchLower || info.label.toLowerCase().includes(searchLower) || info.group.toLowerCase().includes(searchLower))
      && (filter === "all" || filter === "allowed" && isAllowed || filter === "restricted" && !isAllowed);
  });
  const hasVisiblePermissions = visiblePermissions.length + visibleProtectedPermissions.length > 0;
  const visiblePermissionSet = new Set<Permission>([...visiblePermissions, ...visibleProtectedPermissions]);
  const dirtyChangeCount = Object.keys(permissionChanges).length
    + Number(role !== member.role)
    + Number(status !== (member.status === "active" ? "active" : "disabled"))
    + Number(scopeMode !== member.scopeMode);
  const compareMember = data.members.find((item) => item.id === compareUserId && item.id !== member.id) ?? null;
  const permissionDifferences = compareMember ? ALL_TEAM_PERMISSIONS.filter((permission) =>
    effective(member, permission, data.permissionDefaults) !== effective(compareMember, permission, data.permissionDefaults)
    || permissionSource(member, permission, data.permissionDefaults) !== permissionSource(compareMember, permission, data.permissionDefaults)) : [];
  const comparisonDifferences = compareMember ? [
    ...(member.role !== compareMember.role ? [{ label: "Role", current: roleLabel(member.role), other: roleLabel(compareMember.role) }] : []),
    ...(member.status !== compareMember.status ? [{ label: "Account status", current: member.status, other: compareMember.status }] : []),
    ...(member.scopeMode !== compareMember.scopeMode ? [{ label: "Client scope", current: member.scopeMode === "all_clients" ? "All current and future clients" : "Assigned clients only", other: compareMember.scopeMode === "all_clients" ? "All current and future clients" : "Assigned clients only" }] : []),
    ...(member.clients.map((item) => item.id).sort().join(",") !== compareMember.clients.map((item) => item.id).sort().join(",") ? [{ label: "Explicit client assignments", current: member.clients.map((item) => item.name).join(", ") || "None", other: compareMember.clients.map((item) => item.name).join(", ") || "None" }] : []),
    ...permissionDifferences.map((permission) => ({
      label: permissionInfo(permission).label,
      current: `${effective(member, permission, data.permissionDefaults) ? "Allowed" : "Restricted"} · ${permissionSource(member, permission, data.permissionDefaults)}`,
      other: `${effective(compareMember, permission, data.permissionDefaults) ? "Allowed" : "Restricted"} · ${permissionSource(compareMember, permission, data.permissionDefaults)}`,
    })),
  ] : [];
  const copyMember = data.members.find((item) => item.id === copySourceId && item.id !== member.id && item.role !== "agency_super_admin") ?? null;
  const selectedCopy = [...copySelection];
  const copySearchLower = copySearch.trim().toLowerCase();
  const visibleCopyPermissions = AGENCY_TEAM_MANAGED_PERMISSIONS.filter((permission) => {
    const info = AGENCY_TEAM_PERMISSION_INFO[permission];
    return !copySearchLower || info.label.toLowerCase().includes(copySearchLower) || info.group.toLowerCase().includes(copySearchLower);
  });
  const copyPermissionGroups = [...new Set(visibleCopyPermissions.map((permission) => AGENCY_TEAM_PERMISSION_INFO[permission].group))];
  const copiedOverride = (permission: AgencyTeamPermission) => {
    if (!copyMember) return null;
    const sourceAllowed = effective(copyMember, permission, data.permissionDefaults);
    const targetRoleDefault = data.permissionDefaults[member.role as "agency_manager" | "agency_staff"][permission] === true;
    return sourceAllowed === targetRoleDefault ? null : sourceAllowed ? "allow" : "deny";
  };
  const copyChanges = copyMember ? selectedCopy.filter((permission) => (member.permissionOverrides[permission] ?? null) !== copiedOverride(permission)) : [];
  const copyPreviewMember = copyMember ? { ...member, permissionOverrides: { ...member.permissionOverrides } } : null;
  if (copyPreviewMember) {
    for (const permission of selectedCopy) {
      const effect = copiedOverride(permission);
      if (effect === null) delete copyPreviewMember.permissionOverrides[permission];
      else copyPreviewMember.permissionOverrides[permission] = effect;
    }
  }
  const copyBlockedPermissions = copyMember && copyPreviewMember
    ? selectedCopy.filter((permission) => effective(copyMember, permission, data.permissionDefaults)
      && !effective(copyPreviewMember, permission, data.permissionDefaults))
    : [];
  const visibleActivity = member.activity.filter((event) => !importantOnly || /^(team\.|auth\.invitation_|agency\.|tenant\.staff_(assigned|unassigned)$|crm\.support_session|support\.)/.test(event.action));
  const clientSearchLower = clientSearch.trim().toLowerCase();
  const visibleClients = data.clients.filter((client) => !clientSearchLower || client.name.toLowerCase().includes(clientSearchLower));
  const sensitivePermissionGrants = effectiveChanges.filter((permission) =>
    !effective(member, permission, data.permissionDefaults)
    && effective(draftMember, permission, data.permissionDefaults)
    && ["contacts.assign", "contacts.merge", "contacts.delete", "contacts.import", "contacts.export", "contacts.bulk", "companies.delete", "opportunities.reopen", "opportunities.delete", "analytics.export", "website.publish", "website.archive", "website.domains", "campaigns.manage", "agency.clients.create", "agency.clients.invite_users", "agency.workforce.manage", "agency.crm.manage", "agency.support.manage", "setup.manage", "projects.manage", "quotes.manage"].includes(permission));
  const expandsClientScope = member.scopeMode !== "all_clients" && scopeMode === "all_clients";
  const reactivatesAccount = member.status !== "active" && status === "active";
  const assignmentClient = assignmentConfirmation ? data.clients.find((client) => client.id === assignmentConfirmation.clientId) ?? null : null;

  const submitChanges = () => {
    if (!hasUnsavedChanges) return;
    setSaveConfirmationOpen(false);
    setPending(true);
    void updateAgencyTeamMemberAction({ userId: member.id, platformRole: role, status, scopeMode, expectedRevision: member.revision, ...(dirtyPermissions ? { permissionOverrides: draftOverrides } : {}) }).then((result) => {
      if (!result.ok) toast.error(result.error);
      else { toast.success("Role, status, scope and permissions saved together."); router.refresh(); }
    }).finally(() => setPending(false));
  };

  const saveChanges = () => {
    if (!hasUnsavedChanges) return;
    if (sensitivePermissionGrants.length || expandsClientScope || reactivatesAccount) {
      setSaveConfirmationOpen(true);
      return;
    }
    submitChanges();
  };

  const discardChanges = () => {
    setRole(member.role === "agency_manager" ? "agency_manager" : "agency_staff");
    setStatus(member.status === "active" ? "active" : "disabled");
    setScopeMode(member.scopeMode);
    setDraftOverrides(member.permissionOverrides);
    setPendingRole(null);
  };

  const assign = (clientId: string, value: boolean) => setAssignmentConfirmation({ clientId, assign: value });

  const confirmAssignment = () => {
    if (!assignmentConfirmation) return;
    const { clientId, assign: shouldAssign } = assignmentConfirmation;
    setPending(true);
    void assignStaffAction(clientId, member.id, shouldAssign, member.revision).then((result) => {
      if (!result.ok) toast.error(result.error);
      else { toast.success(shouldAssign ? "Client assignment added." : "Client assignment removed."); router.refresh(); }
    }).finally(() => { setPending(false); setAssignmentConfirmation(null); });
  };

  const copyPermissions = () => {
    if (!copyMember || !selectedCopy.length || hasUnsavedChanges) return;
    const blockedCount = copyBlockedPermissions.length;
    setPending(true);
    void copyAgencyUserPermissionsAction({ sourceUserId: copyMember.id, targetUserId: member.id, permissions: selectedCopy, expectedRevision: member.revision }).then((result) => {
      if (!result.ok) toast.error(result.error);
      else {
        toast.success(blockedCount
          ? `Copied ${selectedCopy.length} selected states; ${blockedCount} remain restricted by this member's module access.`
          : `Copied ${selectedCopy.length} selected permission states.`);
        setCopyConfirm(false);
        router.refresh();
      }
    }).finally(() => setPending(false));
  };

  React.useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const warnBeforeNavigation = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin
          && destination.pathname === window.location.pathname
          && destination.search === window.location.search) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPendingNavigationHref(destination.href);
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", warnBeforeNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", warnBeforeNavigation, true);
    };
  }, [hasUnsavedChanges]);

  const leaveWithoutSaving = () => {
    if (!pendingNavigationHref) return;
    const destination = new URL(pendingNavigationHref, window.location.href);
    discardChanges();
    setPendingNavigationHref(null);
    if (destination.origin === window.location.origin) router.push(`${destination.pathname}${destination.search}${destination.hash}`);
    else window.location.assign(destination.href);
  };

  const changeRole = (next: "agency_manager" | "agency_staff") => {
    if (next === role) return;
    if (Object.keys(draftOverrides).length) setPendingRole(next);
    else applyRole(next, false);
  };
  const applyRole = (next: "agency_manager" | "agency_staff", reset: boolean) => {
    setRole(next);
    setScopeMode(next === "agency_manager" ? "all_clients" : "assigned_clients");
    if (reset) setDraftOverrides({});
    setPendingRole(null);
  };

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: "overview", label: "Overview", icon: <Users className="size-4" /> },
    { id: "permissions", label: "Permissions", icon: <ShieldCheck className="size-4" /> },
    { id: "clients", label: "Assigned Clients", icon: <Building2 className="size-4" /> },
    { id: "activity", label: "Activity Log", icon: <History className="size-4" /> },
  ];

  return <div className="space-y-6">
    <Link href="/admin/team" className="inline-flex min-h-10 items-center gap-2 rounded-lg text-[13px] font-medium text-muted hover:text-primary"><ArrowLeft className="size-4" />Back to Agency Team</Link>
    <PageHero tone="dark" eyebrow="Agency team member" icon={<ShieldCheck className="size-5" />} title={member.name} description="Review effective access, client scope and recorded changes for this teammate.">
      <div className="flex flex-wrap items-center gap-3"><AvatarTile name={member.name} size="lg" /><div className="min-w-0"><p className="break-all text-sm text-white/85">{member.email}</p><div className="mt-2 flex flex-wrap gap-2"><StatusPill tone="primary" size="sm">{roleLabel(member.role)}</StatusPill><StatusPill status={member.status === "active" ? "active" : "disabled"}>{member.status === "active" ? "Active" : "Suspended"}</StatusPill><StatusPill tone="neutral" size="sm">{member.scopeMode === "all_clients" ? "All current and future clients" : `${member.clients.length} assigned clients`}</StatusPill></div></div><div className="ml-auto flex flex-wrap gap-2"><InfoChip icon={<Clock3 />}>{member.lastLoginAt ? `Last sign-in ${relativeTime(member.lastLoginAt)}` : "Has not signed in"}</InfoChip><InfoChip icon={<Check />}>{overrideCount} custom override{overrideCount === 1 ? "" : "s"}</InfoChip></div></div>
      <div role="group" aria-label="Effective access summary" className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{[
        { label: "Allowed action areas", value: allowedGroups.size, tab: "permissions" as const, filter: "allowed" as Filter },
        { label: "Restricted action areas", value: groups.length - allowedGroups.size, tab: "permissions" as const, filter: "restricted" as Filter },
        { label: "Custom overrides", value: Object.keys(draftOverrides).length, tab: "permissions" as const, filter: "customized" as Filter },
        { label: "Client access", value: scopeMode === "all_clients" ? "All clients" : `${member.clients.length} assigned`, tab: "clients" as const, filter: null },
      ].map((stat) => <button key={stat.label} type="button" aria-label={`${stat.value} ${stat.label}; open ${stat.tab === "clients" ? "assigned clients" : `${stat.filter} permissions`}`} onClick={() => { setTab(stat.tab); if (stat.filter) setFilter(stat.filter); }} className="rounded-xl bg-white/[.05] p-4 text-left ring-1 ring-inset ring-white/10 transition hover:bg-white/[.09] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"><span className="block text-[12px] text-white/70">{stat.label}</span><span className="mt-1 block text-2xl font-semibold tabular-nums text-white">{stat.value}</span></button>)}</div>
    </PageHero>

    <div role="tablist" aria-label="Team member details" className="relative flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">{tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition ${tab === item.id ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-ink"}`}>{item.icon}{item.label}</button>)}</div>

    {tab === "overview" && <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold text-ink">Account access</h2><p className="mt-1 text-[13px] text-muted">Role, scope and permission edits are saved together. Changes revoke active sessions.</p></div><Button disabled={pending || !hasUnsavedChanges} loading={pending} onClick={saveChanges}>Save access</Button></div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="space-y-1.5 text-[12px] font-medium text-muted">Role<Select value={role} disabled={pending} onChange={(event) => changeRole(event.target.value as "agency_manager" | "agency_staff")}><option value="agency_manager">Agency Manager</option><option value="agency_staff">Agency Staff</option></Select></label><label className="space-y-1.5 text-[12px] font-medium text-muted">Account status<Select value={status} disabled={pending} onChange={(event) => setStatus(event.target.value as "active" | "disabled")}><option value="active">Active</option><option value="disabled">Suspended</option></Select></label><label className="space-y-1.5 text-[12px] font-medium text-muted sm:col-span-2">Client scope<Select value={scopeMode} disabled={pending || role === "agency_staff"} onChange={(event) => setScopeMode(event.target.value as "all_clients" | "assigned_clients")}><option value="all_clients">All current and future clients</option><option value="assigned_clients">Assigned clients only</option></Select><span className="block text-[12px] font-normal">Client scope is checked separately from each feature permission.</span></label></div>
        {pendingRole && <div className="mt-4 rounded-xl border border-warning/30 bg-warning-soft p-4"><p className="text-[13px] font-semibold text-warning-ink">Confirm role-default change</p><p className="mt-1 text-[12px] text-muted">There are custom permissions. Keep those explicit choices with the new role or reset them to the new role defaults.</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => applyRole(pendingRole, false)}>Change role and keep overrides</Button><Button size="sm" variant="ghost" onClick={() => applyRole(pendingRole, true)}>Reset overrides and change role</Button><Button size="sm" variant="ghost" onClick={() => setPendingRole(null)}>Cancel</Button></div></div>}
      </Card>
      <div className="space-y-5"><Card className="p-5"><h2 className="text-base font-semibold text-ink">Current workload</h2><div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-xl bg-surface-2 p-4"><p className="text-[12px] text-muted">Open setup tasks</p><p className="mt-1 text-2xl font-semibold tabular-nums">{member.openTasks}</p></div><div className="rounded-xl bg-surface-2 p-4"><p className="text-[12px] text-muted">Open support tickets</p><p className="mt-1 text-2xl font-semibold tabular-nums">{member.openTickets}</p></div></div><p className="mt-4 text-[12px] leading-relaxed text-muted">{member.status === "active" ? "Feature permissions and client scope are checked on each server request. CRM access also requires a time-limited, audited support session." : "This account is suspended. Protected operations are denied even if an older session token is presented."}</p></Card><Card className="overflow-hidden"><div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3"><div><h2 className="text-sm font-semibold text-ink">Recent activity</h2><p className="mt-0.5 text-[12px] text-muted">Latest recorded actions involving this teammate.</p></div><Button size="sm" variant="ghost" onClick={() => setTab("activity")}>View log</Button></div>{member.activity.slice(0, 3).length ? <ul className="divide-y divide-line">{member.activity.slice(0, 3).map((event, index) => <li key={`${event.action}-${event.occurredAt}-${index}`} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-[12px] font-medium text-ink">{auditActionLabel(event.action)}</p><p className="mt-0.5 truncate text-[12px] text-muted">{event.actorName ?? "System"} · {event.result}</p></div><time className="shrink-0 text-[12px] text-muted" dateTime={event.occurredAt}>{relativeTime(event.occurredAt)}</time></li>)}</ul> : <p className="p-4 text-[12px] text-muted">No actions involving this teammate have been recorded yet.</p>}</Card></div>
    </div>}

    {tab === "permissions" && <div className="space-y-5">
      <Card className="p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-center"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" /><Input aria-label="Search permissions" className="pl-9" placeholder="Search actions or modules…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><Select aria-label="Filter permission state" className="lg:w-52" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}><option value="all">All supported actions</option><option value="allowed">Allowed</option><option value="restricted">Restricted</option><option value="customized">Customized</option></Select><Button variant="secondary" onClick={() => setExpandAll((current) => !current)}>{expandAll ? "Collapse all" : "Expand all"}</Button><Button variant="ghost" disabled={!overrideCount || pending} onClick={() => setDraftOverrides({})}>Reset to role defaults</Button></div><div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted"><span>Role default</span><span className="text-faint">·</span><span>Custom allow/deny overrides</span><span className="text-faint">·</span><span>Client scope remains an independent boundary</span></div><p className="mt-2 text-[12px] leading-relaxed text-muted">CRM access requires an active audited support session; CRM changes and report exports require a write session. Client scope, feature policy and website approval checks still apply.</p></Card>
      {groups.map((group) => {
        const groupPermissions = ALL_TEAM_PERMISSIONS.filter((permission) => permissionInfo(permission).group === group && visiblePermissionSet.has(permission));
        if (!groupPermissions.length) return null;
        return <details key={group} open={expandAll || searchLower.length > 0 || filter !== "all"} className="overflow-hidden rounded-2xl border border-line bg-surface"><summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 border-b border-line bg-surface-2 px-4 py-3"><span className="text-sm font-semibold text-ink">{group}</span><span className="text-[12px] text-muted">{groupPermissions.filter((permission) => effective(draftMember, permission, data.permissionDefaults)).length} allowed of {groupPermissions.length}</span></summary><div className="grid gap-2 p-3 md:grid-cols-2">{groupPermissions.map((permission) => {
          const info = permissionInfo(permission);
          const isAllowed = effective(draftMember, permission, data.permissionDefaults);
          return <div key={permission} className="flex min-h-[84px] items-center gap-3 rounded-xl border border-line p-3"><div className="min-w-0 flex-1"><p className="text-[13px] font-medium text-ink">{info.label}</p><p className="mt-1 text-[12px] text-muted">{isAllowed ? "Allowed" : "Restricted"} · {permissionSource(draftMember, permission, data.permissionDefaults)}</p>{isAgencyTeamPermission(permission) ? info.note && <p className="mt-1 text-[12px] text-faint">{info.note}</p> : <p className="mt-1 text-[12px] text-faint">{AGENCY_TEAM_PROTECTED_PERMISSION_INFO[permission].note}</p>}</div>{isAgencyTeamPermission(permission) ? <Select aria-label={`${info.label} access`} className="w-36 text-[12px]" value={draftOverrides[permission] ?? "default"} disabled={pending || member.status !== "active"} onChange={(event) => setDraftOverrides((current) => {
            const next = { ...current };
            const value = toOverrideValue(event.target.value);
            if (value === null) delete next[permission]; else next[permission] = value;
            return next;
          })}><option value="default">Role default</option><option value="allow">Allow</option><option value="deny">Deny</option></Select> : <span className="shrink-0 rounded-lg bg-surface-2 px-2 py-1 text-[12px] font-medium text-muted">{permissionSource(draftMember, permission, data.permissionDefaults)}</span>}</div>;
        })}</div></details>;
      })}
      {!hasVisiblePermissions && <Card className="p-6 text-center text-sm text-muted">No permissions match this search and filter.</Card>}
      {hasUnsavedChanges && <Card className="space-y-3 border-warning/30 bg-warning-soft/40 p-4"><div><h3 className="text-sm font-semibold text-ink">Preview unsaved access changes</h3><p className="mt-1 text-[12px] text-muted">This preview includes all {ALL_TEAM_PERMISSIONS.length} permission states and their source. Client scope remains a separate boundary.</p></div><div className="grid gap-2 sm:grid-cols-2"><p className="rounded-lg bg-surface p-3 text-[12px]"><strong>Role:</strong> {roleLabel(member.role)} → {roleLabel(role)}</p><p className="rounded-lg bg-surface p-3 text-[12px]"><strong>Status:</strong> {member.status} → {status}</p><p className="rounded-lg bg-surface p-3 text-[12px] sm:col-span-2"><strong>Client scope:</strong> {member.scopeMode === "all_clients" ? "All current and future clients" : `${member.clients.length} assigned clients`} → {scopeMode === "all_clients" ? "All current and future clients" : `${member.clients.length} assigned clients`}</p></div>{effectiveChanges.length ? <ul className="max-h-96 space-y-1 overflow-y-auto">{effectiveChanges.map((permission) => <li key={permission} className="rounded-lg bg-surface p-2.5 text-[12px]"><span className="font-medium">{permissionInfo(permission).label}:</span> {effective(member, permission, data.permissionDefaults) ? "Allowed" : "Restricted"} · {permissionSource(member, permission, data.permissionDefaults)} → {effective(draftMember, permission, data.permissionDefaults) ? "Allowed" : "Restricted"} · {permissionSource(draftMember, permission, data.permissionDefaults)}</li>)}</ul> : <p className="text-[12px] text-muted">No permission state or source changes; the role, status or scope change is shown above.</p>}</Card>}
      <Card className="space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-ink">Compare permissions</h3><p className="mt-1 text-[12px] text-muted">Compare effective action access, role, status, client scope and assignments.</p></div><Select aria-label="Choose team member to compare" className="w-full sm:w-72" value={compareUserId} onChange={(event) => setCompareUserId(event.target.value)}><option value="">Choose a teammate…</option>{data.members.filter((item) => item.id !== member.id && item.role !== "agency_super_admin").map((item) => <option key={item.id} value={item.id}>{item.name} · {roleLabel(item.role)}</option>)}</Select></div>{compareMember && <div className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[560px] text-left text-[12px]"><thead className="bg-surface-2 text-muted"><tr><th className="p-3 font-medium">Access detail</th><th className="p-3 font-medium">{member.name}</th><th className="p-3 font-medium">{compareMember.name}</th></tr></thead><tbody className="divide-y divide-line">{comparisonDifferences.map((difference) => <tr key={difference.label}><td className="p-3 text-ink">{difference.label}</td><td className="p-3">{difference.current}</td><td className="p-3">{difference.other}</td></tr>)}{!comparisonDifferences.length && <tr><td colSpan={3} className="p-4 text-muted">These members have matching role, scope, assignments and supported permission states.</td></tr>}</tbody></table></div>}</Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-ink">Copy selected permissions</h3><p className="mt-1 text-[12px] text-muted">Copies only selected operational action states. It never copies role, scope or client assignments.</p></div><Select aria-label="Copy permissions from teammate" className="w-full sm:w-72" value={copySourceId} disabled={hasUnsavedChanges} onChange={(event) => { setCopySourceId(event.target.value); setCopySelection(new Set()); setCopySearch(""); setCopyConfirm(false); }}><option value="">Choose a source teammate…</option>{data.members.filter((item) => item.id !== member.id && item.role !== "agency_super_admin").map((item) => <option key={item.id} value={item.id}>{item.name} · {roleLabel(item.role)}</option>)}</Select></div>
        {copyMember && <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" /><Input aria-label="Search permissions to copy" className="pl-9" placeholder="Search actions or modules…" value={copySearch} disabled={hasUnsavedChanges} onChange={(event) => { setCopySearch(event.target.value); setCopyConfirm(false); }} /></div><Button type="button" variant="secondary" size="sm" disabled={hasUnsavedChanges || !visibleCopyPermissions.length} onClick={() => { const allVisibleSelected = visibleCopyPermissions.every((permission) => copySelection.has(permission)); setCopySelection((current) => { const next = new Set(current); for (const permission of visibleCopyPermissions) { if (allVisibleSelected) next.delete(permission); else next.add(permission); } return next; }); setCopyConfirm(false); }}>{visibleCopyPermissions.every((permission) => copySelection.has(permission)) ? "Clear matching" : `Select matching (${visibleCopyPermissions.length})`}</Button></div>
          <p className="text-[12px] text-muted">Choose source states by action group. Search narrows the list; changing the source clears the selection.</p>
          <div className="space-y-2">{copyPermissionGroups.map((group) => {
            const permissions = visibleCopyPermissions.filter((permission) => AGENCY_TEAM_PERMISSION_INFO[permission].group === group);
            return <details key={group} open={copySearchLower.length > 0} className="overflow-hidden rounded-xl border border-line"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 bg-surface-2 px-3 py-2.5 text-[12px] font-semibold text-ink"><span>{group}</span><span className="font-normal text-muted">{permissions.filter((permission) => copySelection.has(permission)).length} of {permissions.length} selected</span></summary><div className="grid gap-2 border-t border-line p-2 sm:grid-cols-2">{permissions.map((permission) => <label key={permission} className="flex min-h-14 items-start gap-2.5 rounded-lg border border-line p-2.5 text-[12px]"><input type="checkbox" checked={copySelection.has(permission)} disabled={hasUnsavedChanges} onChange={(event) => { const checked = event.target.checked; setCopySelection((current) => { const next = new Set(current); if (checked) next.add(permission); else next.delete(permission); return next; }); setCopyConfirm(false); }} className="mt-0.5 size-4 shrink-0 accent-primary" /><span className="min-w-0 flex-1"><span className="block font-medium text-ink">{AGENCY_TEAM_PERMISSION_INFO[permission].label}</span><span className="mt-1 block text-[12px] text-muted">Source: {effective(copyMember, permission, data.permissionDefaults) ? "Allowed" : "Restricted"} · {permissionSource(copyMember, permission, data.permissionDefaults)}</span></span></label>)}</div></details>;
          })}{!visibleCopyPermissions.length && <p className="rounded-xl border border-dashed border-line-strong p-4 text-center text-[12px] text-muted">No operational permissions match this search.</p>}</div>
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-[12px] text-muted">{selectedCopy.length} selected · {copyChanges.length} override change{copyChanges.length === 1 ? "" : "s"} for this member</p><Button variant={copyConfirm ? "primary" : "secondary"} disabled={!selectedCopy.length || pending || hasUnsavedChanges} loading={pending} onClick={() => copyConfirm ? copyPermissions() : setCopyConfirm(true)}>{copyConfirm ? "Confirm copy" : "Preview selected changes"}</Button></div>
          {copyConfirm && copyMember && copyPreviewMember && <div role="status" className="space-y-2 rounded-lg bg-warning-soft p-3 text-[12px] text-warning-ink"><p>Copy {selectedCopy.length} selected states from {copyMember.name}. This preview shows each destination permission after its module gates are applied:</p><ul className="max-h-64 list-inside list-disc space-y-1 overflow-y-auto">{selectedCopy.map((permission) => {
            const currentEffect = member.permissionOverrides[permission] ?? null;
            const nextEffect = copiedOverride(permission);
            return <li key={permission}>{AGENCY_TEAM_PERMISSION_INFO[permission].label}: {effective(member, permission, data.permissionDefaults) ? "Allowed" : "Restricted"} · {permissionSource(member, permission, data.permissionDefaults)} → {effective(copyPreviewMember, permission, data.permissionDefaults) ? "Allowed" : "Restricted"} · {permissionSource(copyPreviewMember, permission, data.permissionDefaults)} (source: {effective(copyMember, permission, data.permissionDefaults) ? "Allowed" : "Restricted"}; {nextEffect ? `copied override ${nextEffect}` : "role default"}){currentEffect ? ` · previous custom ${currentEffect}` : ""}</li>;
          })}</ul><p>Role, client scope and assignments will remain unchanged.</p></div>}
          {copyConfirm && copyBlockedPermissions.length > 0 && <p role="alert" className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-[12px] text-warning-ink">{copyBlockedPermissions.map((permission) => `${AGENCY_TEAM_PERMISSION_INFO[permission].label} is ${permissionSource(copyPreviewMember!, permission, data.permissionDefaults).toLowerCase()}`).join(". ")}. The copy will not change module view access.</p>}
        </>}
      </Card>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface/95 p-3 shadow-card backdrop-blur"><p className="text-[12px] text-muted">{hasUnsavedChanges ? `${dirtyChangeCount} unsaved role, status, scope or permission change${dirtyChangeCount === 1 ? "" : "s"}.` : "All access changes are saved."}</p><div className="flex gap-2"><Button variant="secondary" disabled={!hasUnsavedChanges || pending} onClick={discardChanges}>Discard changes</Button><Button loading={pending} disabled={!hasUnsavedChanges || pending} onClick={saveChanges}>Save changes</Button></div></div>
    </div>}

    {tab === "clients" && <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-line p-5 sm:flex-row sm:items-end sm:justify-between">
        <div><h2 className="text-base font-semibold text-ink">Assigned clients</h2><p className="mt-1 text-[13px] text-muted">{member.scopeMode === "all_clients" ? "This manager can access all current and future clients. Explicit assignments below are for operational coverage." : "Only selected client workspaces are accessible. Removing an assignment immediately closes that scope."}</p></div>
        <div className="relative w-full sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" /><Input aria-label="Search clients" className="pl-9" placeholder="Search clients…" value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} /></div>
      </div>
      <div className="divide-y divide-line">{visibleClients.map((client) => {
        const assigned = member.clients.some((item) => item.id === client.id);
        const controlsAccess = member.scopeMode === "assigned_clients";
        return <div key={client.id} className="flex min-h-16 items-center gap-3 px-5 py-3"><AvatarTile name={client.name} /><div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium text-ink">{client.name}</p><p className="mt-1 text-[12px] text-muted">{controlsAccess ? assigned ? "Assigned · client access allowed" : "Not assigned · client access denied" : assigned ? "Assigned for operational coverage" : "No explicit assignment"}</p></div><Link href={`/admin/clients/${client.id}`} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-primary" aria-label={`Open ${client.name}`}><ArrowUpRight className="size-4" /></Link><input type="checkbox" aria-label={`Assign ${member.name} to ${client.name}`} checked={assigned} disabled={pending || member.status !== "active" || hasUnsavedChanges} onChange={(event) => assign(client.id, event.target.checked)} className="size-4 accent-primary" /></div>;
      })}{!visibleClients.length && <p className="p-6 text-center text-sm text-muted">{data.clients.length ? "No clients match this search." : "No active client workspaces are available."}</p>}</div>
    </Card>}

    {tab === "activity" && <Card className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-5"><div><h2 className="text-base font-semibold text-ink">Activity log</h2><p className="mt-1 text-[13px] text-muted">Recorded actor, action, result and previous/new permission values.</p></div><Button variant={importantOnly ? "primary" : "secondary"} size="sm" onClick={() => setImportantOnly((value) => !value)}>{importantOnly ? "Show all events" : "Important events"}</Button></div>{visibleActivity.length ? <ul className="divide-y divide-line">{visibleActivity.map((event, index) => { const changes = auditChanges(event.metadata); const actorRoleText = event.actorRole === "agency_super_admin" ? "Super Admin" : event.actorRole === "agency_manager" ? "Agency Manager" : event.actorRole === "agency_staff" ? "Agency Staff" : event.actorRole; return <li key={`${event.action}-${event.occurredAt}-${index}`} className="flex flex-wrap items-start justify-between gap-3 p-4 sm:px-5"><div className="min-w-0"><p className="break-words text-[13px] font-medium text-ink">{auditActionLabel(event.action)}</p><p className="mt-1 text-[12px] text-muted">By {event.actorName ?? "System"}{actorRoleText ? ` · ${actorRoleText}` : ""} · {event.result}</p>{changes.length > 0 && <ul className="mt-2 space-y-1 text-[12px] text-muted">{changes.map((change) => <li key={change}>{change}</li>)}</ul>}</div><time className="shrink-0 text-[12px] text-muted" dateTime={event.occurredAt}>{formatDate(event.occurredAt, timeZone)} · {relativeTime(event.occurredAt)}</time></li>; })}</ul> : <div className="p-8 text-center text-sm text-muted">{member.activity.length ? "No important events are recorded for this teammate." : "No actions involving this teammate have been recorded yet."}</div>}</Card>}

    <Dialog
      open={!!pendingNavigationHref}
      onOpenChange={(open) => { if (!open) setPendingNavigationHref(null); }}
      title="Leave without saving?"
      description="Your role, client scope or permission edits have not been saved. Leaving will discard those changes."
      footer={<><Button variant="secondary" onClick={() => setPendingNavigationHref(null)}>Stay on this page</Button><Button variant="danger" onClick={leaveWithoutSaving}>Discard changes and leave</Button></>}
    >
      <p className="rounded-xl border border-warning/25 bg-warning-soft/40 p-4 text-[13px] text-warning-ink">The teammate’s current access remains unchanged until you save.</p>
    </Dialog>

    <Dialog
      open={!!assignmentConfirmation}
      onOpenChange={(open) => { if (!open && !pending) setAssignmentConfirmation(null); }}
      title={assignmentConfirmation?.assign ? "Confirm client assignment" : "Confirm client removal"}
      description={member.scopeMode === "assigned_clients"
        ? assignmentConfirmation?.assign ? "This assignment grants this teammate access to the selected client workspace." : "Removing this assignment immediately removes this teammate's client access."
        : "This manager already has all-client access. The assignment records operational coverage and does not change that access scope."}
      footer={<><Button variant="secondary" disabled={pending} onClick={() => setAssignmentConfirmation(null)}>Cancel</Button><Button variant={assignmentConfirmation?.assign ? "primary" : "danger"} loading={pending} disabled={!assignmentClient} onClick={confirmAssignment}>{assignmentConfirmation?.assign ? "Confirm assignment" : "Remove assignment"}</Button></>}
    >
      <p className="rounded-xl border border-line bg-surface-2 p-4 text-sm text-ink">{assignmentClient?.name ?? "The selected client is no longer available."}</p>
    </Dialog>

    <Dialog
      open={saveConfirmationOpen}
      onOpenChange={(open) => { if (!open && !pending) setSaveConfirmationOpen(false); }}
      title="Confirm high impact access changes"
      description="Review these changes before saving. Saving revokes this teammate's active sessions so the updated access is checked on the next request."
      footer={<><Button variant="secondary" disabled={pending} onClick={() => setSaveConfirmationOpen(false)}>Cancel</Button><Button loading={pending} onClick={submitChanges}>Save reviewed changes</Button></>}
    >
      <ul className="space-y-2 text-[13px] text-ink">
        {sensitivePermissionGrants.map((permission) => <li key={permission} className="rounded-lg border border-line p-3">Grant <strong>{permissionInfo(permission).label}</strong> to {member.name}.</li>)}
        {expandsClientScope && <li className="rounded-lg border border-line p-3">Expand {member.name}&apos;s scope to all current and future client workspaces.</li>}
        {reactivatesAccount && <li className="rounded-lg border border-line p-3">Reactivate {member.name}&apos;s account and restore access allowed by the selected role and scope.</li>}
      </ul>
    </Dialog>
  </div>;
}
