"use client";

import * as React from "react";
import { CheckCircle2, Eye, Lock, PencilLine, Plug, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { setPermissionOverrideAction, updateWorkspaceSettingsAction } from "@/app/actions/crm";
import { Avatar, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { CAPABILITY_LABELS, CRM_CAPABILITIES, CRM_MODE_LABELS, CRM_MODES, type CrmMode } from "@/lib/crm/types";
import { DELEGABLE_PERMISSION_INFO, DELEGABLE_PERMISSIONS, type DelegablePermission } from "@/lib/permissions";
import type { CrmWorkspace } from "@/server/crm/workspace";
import type { ProviderSwitchState } from "@/server/crm/provider-switch";
import { ProviderSwitchWizard } from "@/components/crm/provider-switch/wizard";
import type { MemberAccess } from "@/server/crm/permissions";
import type { SupportSessionLogEntry } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";

// ---------------------------------------------------------------------------
// CRM provider
// ---------------------------------------------------------------------------

export function ProviderSettings({ scope, workspace, canEditDefaults, switchState }: { scope: CrmScope; workspace: CrmWorkspace; canEditDefaults: boolean; switchState: ProviderSwitchState }) {
  const { run, busy } = useCrmAction();
  const [currency, setCurrency] = React.useState(workspace.defaultCurrency);
  const [callingCode, setCallingCode] = React.useState(workspace.defaultCallingCode ?? "");
  const dirty = currency !== workspace.defaultCurrency || (callingCode || null) !== workspace.defaultCallingCode;
  return (
    <div className="space-y-6">
      <PageTitle title="CRM Provider" description="Which system holds this workspace's records. Each capability has exactly one owner, so two systems never change the same record." />

      <div className="grid gap-3 lg:grid-cols-3">
        {CRM_MODES.map((m: CrmMode) => {
          const current = workspace.mode === m;
          return (
            <Card key={m} className={cn("p-4", current && "ring-2 ring-primary")}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[14px] font-semibold text-ink">{CRM_MODE_LABELS[m].label}</p>
                {current && <Badge tone="primary"><CheckCircle2 className="size-3" />Current</Badge>}
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{CRM_MODE_LABELS[m].description}</p>
            </Card>
          );
        })}
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold text-ink">Who owns each capability</h3>
          <p className="mt-0.5 text-[13px] text-muted">iAcquire refuses to write to anything GoHighLevel owns, and the other way round. This is enforced on the server, not just hidden in the interface.</p>
        </div>
        <ul className="divide-y divide-line">
          {CRM_CAPABILITIES.map((c) => (
            <li key={c} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[14px]">
              <span className="text-ink">{CAPABILITY_LABELS[c]}</span>
              {workspace.capabilities[c] === "native" ? <Badge tone="primary">iAcquire</Badge> : <Badge tone="warning">GoHighLevel</Badge>}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <div className="flex items-start gap-3">
          <Plug className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <div className="text-[14px] leading-relaxed text-ink-2">
            <p className="font-medium text-ink">GoHighLevel connection: {workspace.ghlConnected ? "connected (read-only)" : "not connected"}</p>
            <p className="mt-1 text-muted">
              {workspace.ghlConnected
                ? "Your GoHighLevel location stays connected and untouched: iAcquire only reads it. Moving a capability is a guided switch below, with a preview, a backup, a dry run and a way back."
                : "This workspace doesn't need GoHighLevel. Everything runs in iAcquire. Moving records in from GoHighLevel needs the location connected read-only first (iAcquire support connects it)."}
            </p>
          </div>
        </div>
      </Card>

      <ProviderSwitchWizard scope={scope} initial={switchState} />

      <Card className="p-4">
        <h3 className="text-[14px] font-semibold text-ink">Defaults</h3>
        <p className="mt-0.5 text-[13px] text-muted">Used when a deal has no currency, and to read phone numbers typed without a country code.</p>
        {!canEditDefaults && <div className="mt-3"><ReadOnlyNotice /></div>}
        <form className="mt-3 grid max-w-xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={async (e) => { e.preventDefault(); await run("defaults", () => updateWorkspaceSettingsAction(scope.orgId, { defaultCurrency: currency, defaultCallingCode: callingCode || null }), "Defaults saved."); }}>
          <Field label="Currency" htmlFor="ws-currency" hint="Three letters, like USD or PHP"><Input id="ws-currency" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} disabled={!canEditDefaults} /></Field>
          <Field label="Country calling code" htmlFor="ws-cc" hint="Digits only, like 63 or 1"><Input id="ws-cc" inputMode="numeric" maxLength={3} value={callingCode} onChange={(e) => setCallingCode(e.target.value.replace(/\D/g, ""))} disabled={!canEditDefaults} /></Field>
          {canEditDefaults && <Button type="submit" disabled={!dirty} loading={busy("defaults")}>Save</Button>}
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team & permissions
// ---------------------------------------------------------------------------

const GROUPS = ["Contacts", "Sales", "Calendar", "Work", "Messaging", "Automation", "Reporting"] as const;

export function PermissionsSettings({ scope, members }: { scope: CrmScope; members: MemberAccess[] }) {
  const { run } = useCrmAction();
  const [selectedId, setSelectedId] = React.useState(members.find((m) => m.editable)?.userId ?? members[0]?.userId ?? "");
  const person = members.find((m) => m.userId === selectedId) ?? null;
  const canManage = !!scope.can["crm.permissions.manage"] && !scope.readOnly;
  return (
    <div className="space-y-5">
      <PageTitle title="Team & Permissions" description="Everyone starts with their role's access. You can grant or withdraw individual CRM permissions for one person without changing their role. Every change is recorded." />
      {!members.length ? (
        <Card><EmptyState icon={<ShieldCheck className="size-5" />} title="No teammates yet" description="Invite teammates from Settings → Team, then fine-tune what each person can do here." /></Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <ul className="space-y-1" aria-label="Teammates">
            {members.map((m) => {
              const changes = Object.keys(m.overrides).length;
              return (
                <li key={m.userId}>
                  <button type="button" onClick={() => setSelectedId(m.userId)} aria-current={m.userId === selectedId ? "true" : undefined}
                    className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left", m.userId === selectedId ? "bg-surface shadow-soft ring-1 ring-line" : "hover:bg-surface-2")}>
                    <Avatar name={m.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink">{m.name}</span>
                      <span className="block truncate text-[12px] text-muted">{m.roleLabel}{changes ? ` · ${changes} ${changes === 1 ? "change" : "changes"}` : ""}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {person && (
            <Card className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div>
                  <p className="text-[14px] font-semibold text-ink">{person.name}</p>
                  <p className="text-[13px] text-muted">{person.email} · {person.roleLabel}</p>
                </div>
                {!person.editable && <Badge tone="neutral"><Lock className="size-3" />{person.role === "owner" ? "Owners always have full access" : person.userId === scope.userId ? "You can't change your own access" : "Only the owner can change this person"}</Badge>}
              </div>
              <div className="space-y-4 p-4">
                {GROUPS.map((g) => {
                  const perms = DELEGABLE_PERMISSIONS.filter((p) => DELEGABLE_PERMISSION_INFO[p].group === g);
                  return (
                    <section key={g}>
                      <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">{g}</h3>
                      <ul className="divide-y divide-line rounded-xl border border-line">
                        {perms.map((p: DelegablePermission) => {
                          const override = person.overrides[p];
                          const on = person.effective[p];
                          return (
                            <li key={p} className="flex items-center justify-between gap-3 px-3 py-2 text-[14px]">
                              <span className="min-w-0">
                                <span className={cn("block", on ? "text-ink" : "text-muted")}>{DELEGABLE_PERMISSION_INFO[p].label}</span>
                                {override && <span className="text-[12px] text-primary-ink">{override === "grant" ? "Granted to this person" : "Withdrawn for this person"}</span>}
                              </span>
                              {canManage && person.editable ? (
                                <Menu>
                                  <MenuTrigger asChild>
                                    <button type="button" aria-label={`${DELEGABLE_PERMISSION_INFO[p].label}: ${on ? "allowed" : "not allowed"}. Change`}
                                      className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium", on ? "border-success/30 bg-success-soft text-success-ink" : "border-line bg-surface-2 text-muted")}>
                                      {on ? "Allowed" : "Not allowed"}
                                    </button>
                                  </MenuTrigger>
                                  <MenuContent>
                                    <MenuLabel>{DELEGABLE_PERMISSION_INFO[p].label}</MenuLabel>
                                    <MenuItem disabled={override === "grant" || (on && !override) || !scope.can[p]} onSelect={() => run(`p-${p}`, () => setPermissionOverrideAction(scope.orgId, person.userId, p, "grant"), "Permission granted.")}>Allow for {person.name.split(" ")[0]}</MenuItem>
                                    <MenuItem disabled={override === "revoke" || (!on && !override)} onSelect={() => run(`p-${p}`, () => setPermissionOverrideAction(scope.orgId, person.userId, p, "revoke"), "Permission withdrawn.")}>{"Don't allow"}</MenuItem>
                                    {override && (
                                      <>
                                        <MenuSeparator />
                                        <MenuItem onSelect={() => run(`p-${p}`, () => setPermissionOverrideAction(scope.orgId, person.userId, p, null), "Back to the role's default.")}>Use the {person.roleLabel} default</MenuItem>
                                      </>
                                    )}
                                  </MenuContent>
                                </Menu>
                              ) : (
                                <span className={cn("text-[13px] font-medium", on ? "text-success-ink" : "text-muted")}>{on ? "Allowed" : "Not allowed"}</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Support access log
// ---------------------------------------------------------------------------

export function SupportAccessLog({ sessions }: { sessions: SupportSessionLogEntry[] }) {
  return (
    <div className="space-y-5">
      <PageTitle title="Support Access" description="Every time someone from the iAcquire team opens your CRM, it's recorded here: who, why, for how long, and what they did. Write access is limited to senior staff, lasts at most 30 minutes, and notifies you when it starts." />
      {!sessions.length ? (
        <Card><EmptyState icon={<Eye className="size-5" />} title="No support access yet" description="Nobody from the iAcquire team has opened your CRM." /></Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div role="region" aria-label="Support access history table" tabIndex={0} className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <table className="w-full min-w-[720px] text-[14px]">
              <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">Who</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">Access</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">Reason</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">When</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Pages viewed</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Changes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-2.5 font-medium text-ink">{s.person}</td>
                    <td className="px-3 py-2.5">
                      {s.mode === "write" ? <Badge tone="warning"><PencilLine className="size-3" />Can change</Badge> : <Badge tone="neutral"><Eye className="size-3" />View only</Badge>}
                      {s.active && <Badge tone="primary" className="ml-1.5">Active now</Badge>}
                    </td>
                    <td className="max-w-[280px] px-3 py-2.5 text-ink-2"><span className="line-clamp-2">{s.reason}</span></td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted"><RelativeTime iso={s.startedAt} /></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s.views}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{s.changes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
