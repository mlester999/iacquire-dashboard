"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  BadgeCheck,
  Bell,
  BookOpen,
  Bot,
  Building2,
  CalendarCheck,
  ChevronDown,
  ClipboardCheck,
  Clock,
  FolderKanban,
  Gauge,
  Globe,
  KeyRound,
  Laptop,
  LifeBuoy,
  Lock,
  LogOut,
  Mail,
  MessagesSquare,
  MonitorSmartphone,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Sparkles,
  Target,
  UserMinus,
  UserPlus,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Field, Input, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuTrigger, Segmented, Switch } from "@/components/ui/overlays";
import { AvatarTile, InfoChip, RelativeTime, StatusPill } from "@/components/ui/status";
import { IconTile, Notice, OptionCard, Panel, SaveBar, SettingRow } from "@/components/settings/panel";
import { ROLE_META, RolePill } from "@/components/settings/role-pill";
import { startTutorial } from "@/components/aqi/tutorial/tutorial-store";
import {
  changePasswordAction,
  changeRoleAction,
  inviteMemberAction,
  listSessionsAction,
  revokeInviteAction,
  revokeMemberAction,
  revokeSessionAction,
  saveNotificationPrefsAction,
  updateAiPreferencesAction,
  updateProfileAction,
  updateUserProfileAction,
} from "@/app/actions/settings";
import { LANGUAGES, LENGTH_COPY, TONE_COPY, TONES, type AiPreferences, type ReplyLength } from "@/lib/agent-settings";
import { grantableRoles, ROLE_DESCRIPTIONS, ROLE_LABELS, type OrgRole } from "@/lib/permissions";
import type { EmailPreference } from "@/lib/ops";
import type { NotificationPrefsView } from "@/lib/notification-groups";
import { cn, relativeTime, timeZoneLabel } from "@/lib/utils";

const ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
  "America/Toronto", "America/Vancouver", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Dubai", "Asia/Singapore", "Asia/Manila",
  "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC",
];

const READ_ONLY = "You can view this, but only an owner or manager can change it.";

export function ProfileForms({
  profile,
  user,
  canEdit,
}: {
  profile: { name: string; industry: string; website: string; region: string; timezone: string; description: string; services: string; idealCustomers: string; brandColor: string };
  user: { fullName: string; email: string; timezone: string };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [p, setP] = React.useState(profile);
  const [u, setU] = React.useState({ fullName: user.fullName, timezone: user.timezone });
  const [pending, setPending] = React.useState<string | null>(null);
  const zones = ZONES.includes(p.timezone) ? ZONES : [p.timezone, ...ZONES];
  const userZones = ZONES.includes(u.timezone) ? ZONES : [u.timezone, ...ZONES];
  const profileDirty = JSON.stringify(p) !== JSON.stringify(profile);
  const userDirty = u.fullName !== user.fullName || u.timezone !== user.timezone;
  return (
    <div className="space-y-6">
      {!canEdit && (
        <Notice tone="neutral" icon={<Lock />} title="Business profile is view only">
          {READ_ONLY}
        </Notice>
      )}
      <Panel
        icon={<Building2 />}
        title="Business profile"
        description="Shared with your AI employees as business context."
        aside={canEdit ? undefined : <StatusPill tone="neutral" icon={<Lock className="size-3" aria-hidden />}>View only</StatusPill>}
        footer={
          canEdit && (
            <SaveBar
              dirty={profileDirty}
              pending={pending === "p"}
              onReset={() => setP(profile)}
              onSave={async () => {
                setPending("p");
                const res = await updateProfileAction(p);
                setPending(null);
                if (!res.ok) return toast.error(res.error);
                toast.success("Business profile saved");
                router.refresh();
              }}
            />
          )
        }
        bodyClassName="space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" htmlFor="p-name">
            <Input id="p-name" value={p.name} disabled={!canEdit} maxLength={120} onChange={(e) => setP({ ...p, name: e.target.value })} />
          </Field>
          <Field label="Industry" htmlFor="p-ind" optional>
            <Input id="p-ind" value={p.industry} disabled={!canEdit} maxLength={120} onChange={(e) => setP({ ...p, industry: e.target.value })} />
          </Field>
          <Field label="Website" htmlFor="p-web" optional>
            <Input id="p-web" value={p.website} disabled={!canEdit} maxLength={300} onChange={(e) => setP({ ...p, website: e.target.value })} />
          </Field>
          <Field label="Where you operate" htmlFor="p-region" optional>
            <Input id="p-region" value={p.region} disabled={!canEdit} maxLength={200} onChange={(e) => setP({ ...p, region: e.target.value })} />
          </Field>
          <Field label="Workspace time zone" htmlFor="p-tz" hint="Used for appointments, analytics and timestamps.">
            <Select id="p-tz" value={p.timezone} disabled={!canEdit} onChange={(e) => setP({ ...p, timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {timeZoneLabel(z)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Brand color" htmlFor="p-color" optional>
            <div className="flex gap-2">
              <input type="color" aria-label="Pick brand color" value={p.brandColor || "#2c5bff"} disabled={!canEdit} onChange={(e) => setP({ ...p, brandColor: e.target.value })} className="h-11 w-12 shrink-0 cursor-pointer rounded-xl border border-line-strong bg-surface p-1 shadow-soft disabled:opacity-60 sm:h-10" />
              <Input id="p-color" value={p.brandColor} disabled={!canEdit} placeholder="#2C5BFF" maxLength={7} onChange={(e) => setP({ ...p, brandColor: e.target.value })} />
            </div>
          </Field>
        </div>
        <Field label="What your business does" htmlFor="p-desc" optional>
          <Textarea id="p-desc" rows={3} value={p.description} disabled={!canEdit} maxLength={4000} onChange={(e) => setP({ ...p, description: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Products & services" htmlFor="p-services" optional>
            <Textarea id="p-services" rows={3} value={p.services} disabled={!canEdit} maxLength={4000} onChange={(e) => setP({ ...p, services: e.target.value })} />
          </Field>
          <Field label="Ideal customers" htmlFor="p-ideal" optional>
            <Textarea id="p-ideal" rows={3} value={p.idealCustomers} disabled={!canEdit} maxLength={4000} onChange={(e) => setP({ ...p, idealCustomers: e.target.value })} />
          </Field>
        </div>
      </Panel>
      <Panel
        icon={<UserRound />}
        tone="violet"
        title="Your account"
        description="How you appear to your team, and the time zone used for your own timestamps."
        aside={
          <>
            <InfoChip icon={<Mail aria-hidden />} className="max-w-[16rem]">
              {user.email}
            </InfoChip>
            <Button variant="secondary" size="sm" onClick={() => void startTutorial("getting-started", "library")}>
              <RotateCcw className="size-3.5" /> Restart tour
            </Button>
          </>
        }
        footer={
          <SaveBar
            dirty={userDirty}
            pending={pending === "u"}
            onReset={() => setU({ fullName: user.fullName, timezone: user.timezone })}
            onSave={async () => {
              setPending("u");
              const res = await updateUserProfileAction(u);
              setPending(null);
              if (!res.ok) return toast.error(res.error);
              toast.success("Account updated");
              router.refresh();
            }}
          />
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" htmlFor="u-name">
            <Input id="u-name" value={u.fullName} maxLength={120} onChange={(e) => setU({ ...u, fullName: e.target.value })} />
          </Field>
          <Field label="Your time zone" htmlFor="u-tz">
            <Select id="u-tz" value={u.timezone} onChange={(e) => setU({ ...u, timezone: e.target.value })}>
              {userZones.map((z) => (
                <option key={z} value={z}>
                  {timeZoneLabel(z)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Panel>
    </div>
  );
}

export function TeamManager({
  members,
  invites,
  myRole,
  myId,
  canManage,
}: {
  members: Array<{ user_id: string; full_name: string; email: string; role: OrgRole; last_login_at: string | null }>;
  invites: Array<{ id: string; email: string; role: OrgRole; expires_at: string }>;
  myRole: OrgRole;
  myId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const grantable = grantableRoles(myRole);
  // The earlier general "Team member" role stays for people who already have it but is no longer offered to new invitations.
  const invitable = grantable.filter((r) => r !== "member");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<OrgRole>("viewer");
  const [pending, setPending] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<(typeof members)[number] | null>(null);
  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    setPending(key);
    const res = await fn();
    setPending(null);
    if (!res.ok) return toast.error(res.error ?? "Something went wrong.");
    toast.success(msg);
    router.refresh();
  };
  return (
    <div className="space-y-6">
      {canManage && (
        <Panel icon={<UserPlus />} title="Invite a teammate" description="They'll get an email to set up their account. Invitations expire after 7 days.">
          <form
            data-aqi-target="settings.team.invite"
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void run("invite", () => inviteMemberAction(email, role), `Invitation sent to ${email}`).then(() => setEmail(""));
            }}
          >
            <label htmlFor="inv-email" className="sr-only">
              Email
            </label>
            <Input id="inv-email" data-aqi-target="settings.team.email" type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label htmlFor="inv-role" className="sr-only">
              Role
            </label>
            <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)} className="sm:w-52">
              {invitable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
            <Button type="submit" data-aqi-target="settings.team.submit" loading={pending === "invite"}>
              <UserPlus className="size-4" /> Invite
            </Button>
          </form>
          <ul className="mt-5 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface-2/40" aria-label="What each role can do">
            {invitable.map((r) => {
              const Icon = ROLE_META[r].icon;
              return (
                <li key={r} className={cn("flex flex-col gap-1.5 px-4 py-3 transition-colors sm:flex-row sm:items-center sm:gap-4", r === role && "bg-primary-soft/50")}>
                  <p className="flex shrink-0 items-center gap-2.5 text-[13px] font-semibold text-ink sm:w-56">
                    <IconTile icon={<Icon />} tone={ROLE_META[r].tone} size="sm" className="size-7 rounded-lg [&>svg]:size-3.5" />
                    {ROLE_LABELS[r]}
                  </p>
                  <p className="min-w-0 text-[12.5px] leading-relaxed text-muted">{ROLE_DESCRIPTIONS[r]}</p>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      <Panel
        icon={<Users />}
        title="Team"
        description="Everyone with access to this workspace, and what they can do."
        aside={
          <>
            <InfoChip icon={<Users aria-hidden />}>
              {members.length} member{members.length === 1 ? "" : "s"}
            </InfoChip>
            {invites.length > 0 && <StatusPill tone="warning">{invites.length} pending invitation{invites.length === 1 ? "" : "s"}</StatusPill>}
          </>
        }
        flush
      >
        <ul className="divide-y divide-line border-t border-line">
          {members.map((m) => {
            const editable = canManage && m.user_id !== myId && grantable.includes(m.role);
            const display = m.full_name || m.email;
            return (
              <li key={m.user_id} className="management-row flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
                <div className="flex min-w-0 flex-1 items-center gap-3.5">
                  <AvatarTile name={display} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-ink">
                      <span className="truncate" title={display}>
                        {display}
                      </span>
                      {m.user_id === myId && <StatusPill tone="primary" size="sm" dot={false}>You</StatusPill>}
                    </p>
                    <p className="truncate text-[12.5px] text-muted" title={m.email}>
                      {m.email}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <RolePill role={m.role} />
                      {m.last_login_at ? <InfoChip icon={<Clock aria-hidden />}>Active {relativeTime(m.last_login_at)}</InfoChip> : <StatusPill tone="neutral" size="sm">Hasn&apos;t signed in yet</StatusPill>}
                    </div>
                  </div>
                </div>
                {editable && (
                  <div className="flex shrink-0 items-center gap-2 sm:justify-end">
                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="secondary" size="sm" className="flex-1 sm:flex-none" loading={pending === `r-${m.user_id}`} aria-label={`Change role for ${display}`}>
                          Change role <ChevronDown className="size-3.5" aria-hidden />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        {grantable
                          .filter((r) => r !== "member" || m.role === "member")
                          .map((r) => (
                            <MenuItem key={r} onSelect={() => (r === m.role ? undefined : void run(`r-${m.user_id}`, () => changeRoleAction(m.user_id, r), "Role updated"))}>
                              {ROLE_LABELS[r]}
                              {r === m.role && <BadgeCheck className="ml-auto size-4 text-primary" aria-label="Current role" />}
                            </MenuItem>
                          ))}
                      </MenuContent>
                    </Menu>
                    <Button size="icon-sm" variant="secondary" title="Remove from workspace" aria-label={`Remove ${display}`} onClick={() => setRemoving(m)}>
                      <UserMinus className="size-4" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
          {invites.map((i) => (
            <li key={i.id} className="management-row flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
              <div className="flex min-w-0 flex-1 items-center gap-3.5">
                <IconTile icon={<Mail />} tone="warning" className="size-9 rounded-[10px]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-ink" title={i.email}>
                    {i.email}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <StatusPill tone="warning" size="sm">Invitation pending</StatusPill>
                    <RolePill role={i.role} />
                    <InfoChip icon={<Clock aria-hidden />}>Expires {relativeTime(i.expires_at)}</InfoChip>
                  </div>
                </div>
              </div>
              {canManage && (
                <Button size="sm" variant="secondary" className="sm:shrink-0" loading={pending === `i-${i.id}`} onClick={() => run(`i-${i.id}`, () => revokeInviteAction(i.id), "Invitation revoked")}>
                  Revoke invitation
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.full_name || removing?.email}?`}
        description="They lose access to this workspace immediately. Their past activity stays in the audit log."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={Boolean(removing && pending === `x-${removing.user_id}`)}
              onClick={async () => {
                if (!removing) return;
                await run(`x-${removing.user_id}`, () => revokeMemberAction(removing.user_id), "Access removed");
                setRemoving(null);
              }}
            >
              Remove access
            </Button>
          </>
        }
      />
    </div>
  );
}

export function AiPrefsForm({ prefs, retention, canEdit }: { prefs: AiPreferences; retention: string; canEdit: boolean }) {
  const router = useRouter();
  const [p, setP] = React.useState(prefs);
  const [r, setR] = React.useState(retention);
  const [apply, setApply] = React.useState(true);
  const [pending, setPending] = React.useState(false);
  const dirty = JSON.stringify(p) !== JSON.stringify(prefs) || r !== retention;
  return (
    <div className="space-y-6">
      {!canEdit && (
        <Notice tone="neutral" icon={<Lock />} title="AI preferences are view only">
          {READ_ONLY}
        </Notice>
      )}
      <Panel
        icon={<Sparkles />}
        tone="violet"
        title="Company-wide AI preferences"
        description="Defaults for every AI employee. You can still fine-tune each employee separately."
        aside={!canEdit ? <StatusPill tone="neutral" icon={<Lock className="size-3" aria-hidden />}>View only</StatusPill> : undefined}
        bodyClassName="space-y-6"
        footer={
          canEdit && (
            <SaveBar
              dirty={dirty}
              pending={pending}
              onReset={() => {
                setP(prefs);
                setR(retention);
              }}
              onSave={async () => {
                setPending(true);
                const res = await updateAiPreferencesAction({ ...p, chatRetentionDays: r as never, applyToEmployees: apply });
                setPending(false);
                if (!res.ok) return toast.error(res.error);
                toast.success("AI preferences saved", { description: res.data.updated ? `Applied to ${res.data.updated} employee${res.data.updated === 1 ? "" : "s"}.` : undefined });
                router.refresh();
              }}
            />
          )
        }
      >
        <div>
          <p className="mb-2.5 text-[13px] font-medium text-ink-2" id="pref-tone-label">
            Default tone
          </p>
          <div role="radiogroup" aria-labelledby="pref-tone-label" className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {TONES.map((t) => (
              <OptionCard key={t} selected={p.tone === t} disabled={!canEdit} onSelect={() => setP({ ...p, tone: t })} title={TONE_COPY[t].label} description={<>&ldquo;{TONE_COPY[t].example}&rdquo;</>} />
            ))}
          </div>
        </div>
        <SettingRow title="Default reply length" description={LENGTH_COPY[p.replyLength].description}>
          <Segmented id="pref-len" ariaLabel="Reply length" value={p.replyLength} onChange={(v: ReplyLength) => canEdit && setP({ ...p, replyLength: v })} options={(["concise", "balanced", "detailed"] as const).map((v) => ({ value: v, label: LENGTH_COPY[v].label }))} />
        </SettingRow>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Language" htmlFor="pref-lang">
            <Select id="pref-lang" disabled={!canEdit} value={p.language} onChange={(e) => setP({ ...p, language: e.target.value as AiPreferences["language"] })}>
              {LANGUAGES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </Select>
          </Field>
          <Field label="Conversation history retention" htmlFor="pref-ret" hint="Older conversations are deleted automatically.">
            <Select id="pref-ret" disabled={!canEdit} value={r} onChange={(e) => setR(e.target.value)}>
              <option value="forever">Keep until deleted</option>
              <option value="365">1 year</option>
              <option value="90">90 days</option>
              <option value="30">30 days</option>
            </Select>
          </Field>
        </div>
        <Field label="Company rules" htmlFor="pref-rules" optional>
          <Textarea id="pref-rules" rows={2} maxLength={1500} disabled={!canEdit} value={p.companyRules} onChange={(e) => setP({ ...p, companyRules: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Never promise" htmlFor="pref-never" optional>
            <Textarea id="pref-never" rows={2} maxLength={1000} disabled={!canEdit} value={p.neverPromise} onChange={(e) => setP({ ...p, neverPromise: e.target.value })} />
          </Field>
          <Field label="Ask a human when…" htmlFor="pref-esc" optional>
            <Textarea id="pref-esc" rows={2} maxLength={600} disabled={!canEdit} value={p.escalateWhen} onChange={(e) => setP({ ...p, escalateWhen: e.target.value })} />
          </Field>
        </div>
        {canEdit && (
          <SettingRow as="label" icon={<RefreshCw />} tone="primary" title="Apply to all configured employees now" description="Creates a new configuration version for each employee.">
            <Switch checked={apply} onCheckedChange={setApply} aria-label="Apply to all configured employees" />
          </SettingRow>
        )}
      </Panel>
    </div>
  );
}

type PrefsPatch = Parameters<typeof saveNotificationPrefsAction>[0];
const EMAIL_CHOICES: Array<{ value: EmailPreference; label: string; hint: string }> = [
  { value: "important", label: "Important only", hint: "Things that need you, money, your live website, and anything urgent." },
  { value: "all", label: "Everything", hint: "An email for every notification you haven't switched off." },
  { value: "off", label: "Urgent only", hint: "Only critical alerts. Everything else stays in the app." },
];

const GROUP_ICONS: Record<string, LucideIcon> = {
  setup: ClipboardCheck,
  approvals: BadgeCheck,
  leads: Target,
  workforce: Bot,
  support: LifeBuoy,
  knowledge: BookOpen,
  usage: Gauge,
  calendar: CalendarCheck,
  projects: FolderKanban,
  billing: Wallet,
  messaging: MessagesSquare,
  websites: Globe,
};

export function NotificationPrefsForm({ groups, prefs, emailAvailable = false }: { groups: Array<{ key: string; label: string; description: string }>; prefs: NotificationPrefsView; emailAvailable?: boolean }) {
  const [p, setP] = React.useState(prefs);
  const save = async (patch: PrefsPatch, apply: (cur: NotificationPrefsView) => NotificationPrefsView) => {
    const before = p;
    setP(apply(before));
    const res = await saveNotificationPrefsAction(patch);
    if (!res.ok) {
      setP(before);
      toast.error(res.error);
    } else toast.success("Preference saved");
  };
  const choice = EMAIL_CHOICES.find((c) => c.value === p.email) ?? EMAIL_CHOICES[0];
  const on = groups.filter((g) => p.groups[g.key] !== false).length;
  return (
    <div className="space-y-6">
      <Panel
        icon={<Bell />}
        title="In-app notifications"
        description="Choose what appears in your notification bell. Critical alerts are always shown."
        aside={<StatusPill tone={on === groups.length ? "success" : "primary"}>{on} of {groups.length} on</StatusPill>}
      >
        <div className="grid gap-2.5 lg:grid-cols-2">
          {groups.map((g) => {
            const Icon = GROUP_ICONS[g.key] ?? Bell;
            const enabled = p.groups[g.key] !== false;
            return (
              <SettingRow key={g.key} as="label" icon={<Icon />} tone={enabled ? "primary" : "neutral"} title={g.label} description={g.description}>
                <Switch checked={enabled} aria-label={g.label} onCheckedChange={(v) => save({ groups: { ...p.groups, [g.key]: v } }, (cur) => ({ ...cur, groups: { ...cur.groups, [g.key]: v } }))} />
              </SettingRow>
            );
          })}
        </div>
      </Panel>
      <Panel
        icon={<Mail />}
        tone={emailAvailable ? "primary" : "neutral"}
        title="Email"
        description="Sent only to your verified address. Anything involving a customer's message arrives as a title and a link; the details stay behind your sign-in."
        aside={emailAvailable ? <StatusPill tone="success">Email available</StatusPill> : <StatusPill tone="neutral">Not available yet</StatusPill>}
        bodyClassName="space-y-3"
      >
        {emailAvailable ? (
          <>
            <SettingRow title="Which notifications to email" description={<span id="email-choice-hint">{choice.hint}</span>}>
              <Segmented id="email-choice" ariaLabel="Which notifications to email" value={p.email} options={EMAIL_CHOICES.map((c) => ({ value: c.value, label: c.label }))} onChange={(v) => save({ email: v }, (cur) => ({ ...cur, email: v }))} />
            </SettingRow>
            <SettingRow as="label" title="Email me setup updates" description="Milestones and requests while iAcquire sets up your system. You can turn this off any time.">
              <Switch checked={p.setupEmails} aria-label="Email me setup updates" onCheckedChange={(v) => save({ setupEmails: v }, (cur) => ({ ...cur, setupEmails: v }))} />
            </SettingRow>
            <Notice tone="neutral" icon={<Clock />}>
              Routine email waits until 7am your time if it would arrive between 9pm and 7am. Critical alerts are sent straight away.
            </Notice>
          </>
        ) : (
          <Notice tone="neutral" icon={<Mail />} title="Email notifications aren't available yet">
            They turn on once the iAcquire team connects an email provider. Until then everything appears in the app, and account emails (invitations, password resets) are always sent.
          </Notice>
        )}
      </Panel>
    </div>
  );
}

export function SecurityPanel() {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [sessions, setSessions] = React.useState<Array<{ id: string; current: boolean; userAgent: string | null; createdAt: string; lastSeenAt: string }> | null>(null);
  const [canRevokeOne, setCanRevokeOne] = React.useState(true);
  const load = React.useCallback(async () => {
    const res = await listSessionsAction();
    setSessions(res.ok ? res.data : []);
    if (res.ok) setCanRevokeOne(res.canRevokeOne);
  }, []);
  React.useEffect(() => {
    let live = true;
    listSessionsAction().then((res) => {
      if (!live) return;
      setSessions(res.ok ? res.data : []);
      if (res.ok) setCanRevokeOne(res.canRevokeOne);
    });
    return () => {
      live = false;
    };
  }, []);
  const device = (ua: string | null) => {
    if (!ua) return "Unknown device";
    const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
    return `${browser}${os ? ` on ${os}` : ""}`;
  };
  const strong = next.length >= 10;
  return (
    <div className="space-y-6">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const res = await changePasswordAction(current, next, confirm);
          setPending(false);
          if (!res.ok) return toast.error(res.error);
          toast.success("Password changed");
          setCurrent("");
          setNext("");
          setConfirm("");
          void load();
        }}
      >
        <Panel
          icon={<KeyRound />}
          title="Change password"
          description="Other devices are signed out when you change it."
          bodyClassName="space-y-4"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3">
              {next ? (
                <StatusPill tone={strong ? "success" : "warning"}>{strong ? "Long enough" : `${next.length} of 10 characters`}</StatusPill>
              ) : (
                <InfoChip icon={<Lock aria-hidden />}>Use at least 10 characters</InfoChip>
              )}
              <Button type="submit" loading={pending} disabled={!current || next.length < 10}>
                Update password
              </Button>
            </div>
          }
        >
          <Field label="Current password" htmlFor="pw-cur">
            <Input id="pw-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New password" htmlFor="pw-new" hint="At least 10 characters.">
              <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
            </Field>
            <Field label="Confirm new password" htmlFor="pw-conf">
              <Input id="pw-conf" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </Field>
          </div>
        </Panel>
      </form>
      <Panel
        icon={<MonitorSmartphone />}
        tone="success"
        title="Active sessions"
        description="Devices currently signed in to your account."
        aside={
          <>
            {sessions && <InfoChip icon={<MonitorSmartphone aria-hidden />}>{sessions.length} signed in</InfoChip>}
            {sessions && sessions.length > 1 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  const res = await revokeSessionAction("others");
                  if (!res.ok) return toast.error(res.error);
                  toast.success("Signed out of other devices");
                  void load();
                }}
              >
                <LogOut className="size-3.5" /> Sign out others
              </Button>
            )}
          </>
        }
        flush
      >
        {sessions === null ? (
          <div className="space-y-3 border-t border-line px-5 py-4 sm:px-6" aria-label="Loading sessions" role="status">
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState compact icon={<MonitorSmartphone className="size-5" />} title="No other sessions" description="When you sign in on another device, it will be listed here so you can sign it out." className="border-t border-line" />
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {sessions.map((s) => {
              const mobile = /Android|iPhone|iPad/.test(s.userAgent ?? "");
              const Icon = mobile ? Smartphone : Laptop;
              return (
                <li key={s.id} className="management-row flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
                  <div className="flex min-w-0 flex-1 items-center gap-3.5">
                    <IconTile icon={<Icon />} tone={s.current ? "success" : "neutral"} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                        {device(s.userAgent)}
                        {s.current && <StatusPill tone="success" size="sm">This device</StatusPill>}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <InfoChip icon={<Clock aria-hidden />}>Signed in {relativeTime(s.createdAt)}</InfoChip>
                        <InfoChip><RelativeTime value={s.lastSeenAt} prefix="Last active " /></InfoChip>
                      </div>
                    </div>
                  </div>
                  {!s.current && canRevokeOne && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="sm:shrink-0"
                      onClick={async () => {
                        const res = await revokeSessionAction(s.id);
                        if (!res.ok) return toast.error(res.error);
                        void load();
                      }}
                    >
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
