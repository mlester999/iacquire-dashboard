"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, CheckCircle2, Copy, Mail, ShieldCheck, UserPlus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, Switch } from "@/components/ui/overlays";
import { Badge, Field, Input } from "@/components/ui/primitives";
import { inviteStaffAction } from "@/app/(admin)/admin/actions";
import { AGENCY_TEAM_MANAGED_PERMISSIONS, AGENCY_TEAM_PERMISSION_INFO, AGENCY_TEAM_PERMISSION_VIEW_PARENT, type AgencyPermissionOverrides, type AgencyTeamPermission } from "@/lib/permissions";
import type { AgencyTeamView } from "@/server/admin/team";

type TeamRole = "agency_staff" | "agency_manager";
type ScopeMode = "all_clients" | "assigned_clients";
type Delivery = { status: string; error: string | null };
type RoleDefaults = AgencyTeamView["permissionDefaults"];

function invitationBasePermission(role: TeamRole, permission: AgencyTeamPermission, roleDefaults: RoleDefaults, overrides: AgencyPermissionOverrides) {
  const override = overrides[permission];
  return override ? override === "allow" : roleDefaults[role][permission] === true;
}

function invitationEffectivePermission(role: TeamRole, permission: AgencyTeamPermission, roleDefaults: RoleDefaults, overrides: AgencyPermissionOverrides) {
  const parent = AGENCY_TEAM_PERMISSION_VIEW_PARENT[permission];
  return (!parent || invitationBasePermission(role, parent, roleDefaults, overrides))
    && invitationBasePermission(role, permission, roleDefaults, overrides);
}

function invitationPermissionSource(role: TeamRole, permission: AgencyTeamPermission, roleDefaults: RoleDefaults, overrides: AgencyPermissionOverrides) {
  const parent = AGENCY_TEAM_PERMISSION_VIEW_PARENT[permission];
  if (parent && !invitationBasePermission(role, parent, roleDefaults, overrides)) {
    return `Blocked by ${parent === "website.view" ? "Website Studio" : "Projects"} view access`;
  }
  return overrides[permission] ? `Custom ${overrides[permission]}` : `${role === "agency_manager" ? "Agency Manager" : "Agency Staff"} role default`;
}

export function InviteStaff({ clients = [], roleDefaults }: { clients?: Array<{ id: string; name: string }>; roleDefaults: RoleDefaults }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [permissionEditorOpen, setPermissionEditorOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<TeamRole>("agency_staff");
  const [scopeMode, setScopeMode] = React.useState<ScopeMode>("assigned_clients");
  const [clientIds, setClientIds] = React.useState<string[]>([]);
  const [permissionOverrides, setPermissionOverrides] = React.useState<AgencyPermissionOverrides>({});
  const [draftOverrides, setDraftOverrides] = React.useState<AgencyPermissionOverrides>({});
  const [previewingPermissions, setPreviewingPermissions] = React.useState(false);
  const [pendingRole, setPendingRole] = React.useState<TeamRole | null>(null);
  const [link, setLink] = React.useState<string | null>(null);
  const [delivery, setDelivery] = React.useState<Delivery | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const begin = () => {
    setLink(null); setDelivery(null); setError(null); setEmail(""); setRole("agency_staff");
    setScopeMode("assigned_clients"); setClientIds([]); setPermissionOverrides({}); setDraftOverrides({}); setPendingRole(null); setOpen(true);
  };
  const changeRole = (nextRole: TeamRole) => {
    if (Object.keys(permissionOverrides).length) setPendingRole(nextRole);
    else applyRole(nextRole);
  };
  const applyRole = (nextRole: TeamRole) => {
    setRole(nextRole);
    setScopeMode(nextRole === "agency_manager" ? "all_clients" : "assigned_clients");
    setPendingRole(null);
  };
  const openPermissions = () => {
    setDraftOverrides({ ...permissionOverrides });
    setPreviewingPermissions(false);
    setOpen(false);
    setPermissionEditorOpen(true);
  };

  const invite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true); setError(null);
    try {
      const res = await inviteStaffAction(email, role, scopeMode, scopeMode === "assigned_clients" ? clientIds : [], permissionOverrides);
      if (!res.ok) { setError(res.error); return; }
      setLink(res.data.link); setDelivery(res.data.delivery); router.refresh();
    } catch {
      setError("The invitation could not be confirmed. Check pending invitations before trying again.");
    } finally { setPending(false); }
  };

  const deliveryCopy = delivery?.status === "sent"
    ? "The email provider accepted the invitation email."
    : delivery?.status === "queued"
      ? "The invitation email is queued. Delivery is not confirmed yet."
      : delivery?.status === "captured"
        ? "The invitation was captured in the development mailbox; it was not delivered."
        : delivery?.status === "failed"
          ? "The invitation email failed. Fix the email-provider configuration, or securely share this one-time link."
          : "Email delivery could not be confirmed. Do not assume the invitee received an email.";
  const customized = Object.entries(permissionOverrides);
  const summary = customized.slice(0, 3).map(([permission, effect]) => `${AGENCY_TEAM_PERMISSION_INFO[permission as keyof typeof AGENCY_TEAM_PERMISSION_INFO]?.label ?? permission}: ${effect === "allow" ? "Allowed" : "Restricted"}`);
  const groups = [...new Set(AGENCY_TEAM_MANAGED_PERMISSIONS.map((permission) => AGENCY_TEAM_PERMISSION_INFO[permission].group))];
  const defaultGroups = groups.map((group) => ({
    group,
    count: AGENCY_TEAM_MANAGED_PERMISSIONS.filter((permission) => AGENCY_TEAM_PERMISSION_INFO[permission].group === group && roleDefaults[role][permission] === true).length,
  })).filter((entry) => entry.count > 0);
  const permissionDraftChanges = AGENCY_TEAM_MANAGED_PERMISSIONS.filter((permission) => Object.hasOwn(draftOverrides, permission));

  return <>
    <Button variant="brand" onClick={begin}><UserPlus className="size-4" /> Invite teammate</Button>
    <Dialog
      open={open}
      onOpenChange={(value) => { if (!value && pending) return; setOpen(value); if (!value) setLink(null); }}
      title={link ? "Invitation created" : "Invite an agency teammate"}
      description={link ? "The invitation is single-use and expires in seven days." : "Choose their role, client scope and any initial assignments."}
      footer={link ? <Button onClick={() => { setOpen(false); setLink(null); }}>Done</Button> : <>
        <Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
        <Button loading={pending} disabled={!email.includes("@")} type="submit" form="staff-invitation-form">Create invitation</Button>
      </>}
    >
      {link ? (
        <div className="space-y-4">
          <div className={`rounded-2xl border p-4 ${delivery?.status === "sent" ? "border-success/20 bg-success-soft" : delivery?.status === "failed" ? "border-danger/20 bg-danger-soft" : "border-warning/20 bg-warning-soft"}`}>
            <CheckCircle2 className="mb-3 size-7 text-primary" />
            <p className="font-semibold text-ink">Invitation created for {email}</p>
            <p className="mt-1 text-[13px] text-muted">{deliveryCopy}</p>
            <p className="mt-2 text-[12px] text-muted">{role === "agency_manager" ? scopeMode === "all_clients" ? "Agency Manager · All current and future clients" : "Agency Manager · Assigned clients only" : `Agency Staff · ${clientIds.length} initial assignment${clientIds.length === 1 ? "" : "s"}`}</p>
            {customized.length > 0 && <p className="mt-1 text-[12px] text-muted">{customized.length} custom permission{customized.length === 1 ? "" : "s"} will apply when this invite is accepted.</p>}
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 p-2"><code className="min-w-0 flex-1 truncate px-2 text-[12px]">{link}</code><Button size="sm" variant="ghost" aria-label="Copy secure invitation link" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Copied"))}><Copy className="size-3.5" /></Button></div>
          <p className="text-[12px] text-muted">Share this private link only with {email}. It is single-use and cannot grant Super Admin ownership.</p>
        </div>
      ) : (
        <form id="staff-invitation-form" className="space-y-5" onSubmit={invite}>
          <Field label="Work email" htmlFor="staff-email"><Input id="staff-email" type="email" required autoComplete="email" placeholder="teammate@youragency.com" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
          <section className="space-y-3 border-t border-line pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Role</p>
            {([
              { key: "agency_manager", label: "Agency Manager", description: "Works across clients by default. Agency credentials, Hermes infrastructure and team security remain protected.", icon: ShieldCheck },
              { key: "agency_staff", label: "Agency Staff", description: "Works with assigned clients only. No client access is granted until assignments are selected.", icon: Workflow },
            ] as const).map((item) => <label key={item.key} className={`relative flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${role === item.key ? "border-primary/35 bg-primary-soft" : "border-line bg-surface hover:bg-surface-2"}`}>
              <input type="radio" className="sr-only" name="staff-invitation-role" value={item.key} checked={role === item.key} onChange={() => changeRole(item.key)} />
              <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${role === item.key ? "bg-primary text-white" : "bg-surface-2 text-muted"}`}><item.icon className="size-4" /></span>
              <span><span className="block text-sm font-semibold text-ink">{item.label}</span><span className="mt-1 block text-[12.5px] leading-relaxed text-muted">{item.description}</span></span>
              {role === item.key && <CheckCircle2 className="ml-auto mt-1 size-4 shrink-0 text-primary" />}
            </label>)}
            <div className="rounded-xl border border-line bg-surface-2/70 p-3"><p className="text-[13px] font-semibold text-ink">Using {role === "agency_manager" ? "Agency Manager" : "Agency Staff"} default permissions</p><p className="mt-1 text-[12px] text-muted">Allowed action areas: {defaultGroups.map((entry) => `${entry.group} (${entry.count})`).join(" · ") || "None"}. Platform security, billing, credentials and Hermes policy controls remain protected.</p></div>
            <div className="rounded-xl border border-line p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[13px] font-semibold text-ink">Permissions</p><p className="mt-1 text-[12px] text-muted">Your teammate uses role defaults unless you customize individual supported actions.</p></div><Button type="button" variant="secondary" size="sm" onClick={openPermissions}>{customized.length ? "Edit custom permissions" : "Customize permissions (optional)"}</Button></div>
              {customized.length > 0 && <div className="mt-3 rounded-lg bg-violet-soft/60 p-3"><p className="text-[12px] font-semibold text-violet-ink">Custom permissions configured · {customized.length}</p><p className="mt-1 text-[11px] text-muted">{summary.join(" · ")}{customized.length > summary.length ? ` · +${customized.length - summary.length} more` : ""}</p></div>}
            </div>
          </section>

          {pendingRole && <section className="rounded-xl border border-warning/25 bg-warning-soft p-3"><p className="text-[13px] font-semibold text-warning-ink">Change role defaults?</p><p className="mt-1 text-[12px] text-muted">Your custom actions will remain explicit overrides. Confirm whether to keep them or clear them and use the new role defaults.</p><div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" onClick={() => { applyRole(pendingRole); }}>Change role and keep custom actions</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setPermissionOverrides({}); applyRole(pendingRole); }}>Reset permissions and change role</Button><Button type="button" size="sm" variant="ghost" onClick={() => setPendingRole(null)}>Cancel</Button></div></section>}

          {role === "agency_manager" && <section className="space-y-2 border-t border-line pt-4"><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Client access</p>{([
            { key: "all_clients", title: "All current and future clients", detail: "New client workspaces are included automatically." },
            { key: "assigned_clients", title: "Assigned clients only", detail: "The manager can access only the clients selected below." },
          ] as const).map((option) => <label key={option.key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3"><input type="radio" name="manager-scope" checked={scopeMode === option.key} onChange={() => setScopeMode(option.key)} className="mt-1 accent-primary" /><span><span className="block text-[13px] font-medium text-ink">{option.title}</span><span className="mt-1 block text-[12px] text-muted">{option.detail}</span></span></label>)}</section>}

          {scopeMode === "assigned_clients" && <section className="space-y-2 border-t border-line pt-4"><p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary"><Building2 className="size-3.5" />Initial client assignments</p>{clients.length ? <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line p-2">{clients.map((client) => <label key={client.id} className="flex min-h-10 items-center gap-3 rounded-lg px-2 hover:bg-surface-2"><input type="checkbox" checked={clientIds.includes(client.id)} onChange={(event) => setClientIds((current) => event.target.checked ? [...current, client.id] : current.filter((id) => id !== client.id))} className="size-4 accent-primary" /><span className="text-[13px] text-ink">{client.name}</span></label>)}</div> : <p className="rounded-xl bg-surface-2 p-3 text-[12px] text-muted">No client workspaces are available to assign yet.</p>}<p className="text-[12px] text-muted">No clients will be accessible unless an assignment is selected here or added later.</p></section>}

          <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface-2/70 p-4"><span className="flex items-center gap-2 text-[13px] font-medium text-ink"><Mail className="size-4 text-primary" />Secure invitation</span><Badge tone={scopeMode === "all_clients" ? "violet" : "neutral"}>{scopeMode === "all_clients" ? "All clients" : `${clientIds.length} selected`}</Badge></div>
          {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p>}
        </form>
      )}
    </Dialog>

    <Dialog
      open={permissionEditorOpen}
      onOpenChange={(value) => { if (!value) { setPermissionEditorOpen(false); setOpen(true); } }}
      fullScreen
      title="Customize invitation permissions"
      description={`Review ${role === "agency_manager" ? "Agency Manager" : "Agency Staff"} role defaults. Changes stay in this invitation until you send it.`}
      icon={<ShieldCheck />}
      footer={<><Button variant="secondary" onClick={() => { setPermissionEditorOpen(false); setPreviewingPermissions(false); setOpen(true); }}>Cancel customization</Button><Button variant="secondary" onClick={() => setPreviewingPermissions(true)}>Preview changes</Button><Button onClick={() => { setPermissionOverrides({ ...draftOverrides }); setPermissionEditorOpen(false); setPreviewingPermissions(false); setOpen(true); }}>Save & return to invitation</Button></>}
    >
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface-2 p-4"><div><p className="text-sm font-semibold text-ink">{Object.keys(draftOverrides).length} customized actions</p><p className="mt-1 text-[12px] text-muted">Role defaults update dynamically. Inherited permissions are not copied into the draft.</p></div><Button variant="ghost" onClick={() => setDraftOverrides({})}>Reset to role defaults</Button></div>
        {previewingPermissions && <section aria-live="polite" className="rounded-2xl border border-primary/25 bg-primary-soft/40 p-4"><h2 className="text-sm font-semibold text-ink">Preview permission changes</h2><p className="mt-1 text-[12px] text-muted">These overrides stay private in the invitation draft and apply only after the teammate accepts.</p>{permissionDraftChanges.length ? <ul className="mt-3 grid gap-2 sm:grid-cols-2">{permissionDraftChanges.map((permission) => <li key={permission} className="rounded-lg bg-surface p-3 text-[12px]"><strong>{AGENCY_TEAM_PERMISSION_INFO[permission].label}</strong><br />{invitationEffectivePermission(role, permission, roleDefaults, {}) ? "Allowed" : "Restricted"} · {invitationPermissionSource(role, permission, roleDefaults, {})} → {invitationEffectivePermission(role, permission, roleDefaults, draftOverrides) ? "Allowed" : "Restricted"} · {invitationPermissionSource(role, permission, roleDefaults, draftOverrides)}</li>)}</ul> : <p className="mt-3 text-[12px] text-muted">No custom permission overrides. The invitee will use the role defaults listed above.</p>}</section>}
        {groups.map((group) => <section key={group} className="overflow-hidden rounded-2xl border border-line"><div className="border-b border-line bg-surface-2 px-4 py-3"><h2 className="text-sm font-semibold text-ink">{group}</h2></div><div className="grid gap-2 p-3 md:grid-cols-2">{AGENCY_TEAM_MANAGED_PERMISSIONS.filter((permission) => AGENCY_TEAM_PERMISSION_INFO[permission].group === group).map((permission) => {
          const info = AGENCY_TEAM_PERMISSION_INFO[permission];
          const fallback = roleDefaults[role][permission] === true;
          const effect = draftOverrides[permission];
          const checked = effect ? effect === "allow" : fallback;
          return <div key={permission} className="flex min-h-16 items-center gap-3 rounded-xl border border-line bg-surface p-3"><div className="min-w-0 flex-1"><p className="text-[13px] font-medium text-ink">{info.label}</p><p className="mt-1 text-[11px] text-muted">{invitationEffectivePermission(role, permission, roleDefaults, draftOverrides) ? "Allowed" : "Restricted"} · {invitationPermissionSource(role, permission, roleDefaults, draftOverrides)}</p></div><Switch aria-label={`${info.label} for invitation`} checked={checked} onCheckedChange={(allow) => setDraftOverrides((current) => {
            const next = { ...current };
            if (allow === fallback) delete next[permission];
            else next[permission] = allow ? "allow" : "deny";
            return next;
          })} />{effect && <Button type="button" size="sm" variant="ghost" onClick={() => setDraftOverrides((current) => { const next = { ...current }; delete next[permission]; return next; })}>Role default</Button>}</div>;
        })}</div></section>)}
      </div>
    </Dialog>
  </>;
}
