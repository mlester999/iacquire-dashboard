"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Laptop, LogOut, Mail, RotateCcw, Shield, UserMinus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Segmented, Switch } from "@/components/ui/overlays";
import { startTour } from "@/components/shell/guided-tour";
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

function SaveBar({ dirty, pending, onSave, onReset }: { dirty: boolean; pending: boolean; onSave: () => void; onReset: () => void }) {
  return (
    <div className="flex justify-end gap-2 border-t border-line pt-4">
      <Button variant="ghost" disabled={!dirty || pending} onClick={onReset}>
        Discard
      </Button>
      <Button disabled={!dirty} loading={pending} onClick={onSave}>
        Save changes
      </Button>
    </div>
  );
}

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
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Business profile</CardTitle>
            <CardDescription>Shared with your AI employees as business context.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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
                <input type="color" aria-label="Pick brand color" value={p.brandColor || "#2c5bff"} disabled={!canEdit} onChange={(e) => setP({ ...p, brandColor: e.target.value })} className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-surface p-1" />
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
          {canEdit && (
            <SaveBar
              dirty={JSON.stringify(p) !== JSON.stringify(profile)}
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
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Your account</CardTitle>
            <CardDescription>{user.email}</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => startTour()}>
            <RotateCcw className="size-3.5" /> Restart tour
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
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
          <SaveBar
            dirty={u.fullName !== user.fullName || u.timezone !== user.timezone}
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
        </CardContent>
      </Card>
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
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Invite a teammate</CardTitle>
              <CardDescription>They&apos;ll get an email to set up their account. Invitations expire after 7 days.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void run("invite", () => inviteMemberAction(email, role), `Invitation sent to ${email}`).then(() => setEmail(""));
              }}
            >
              <label htmlFor="inv-email" className="sr-only">
                Email
              </label>
              <Input id="inv-email" type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <label htmlFor="inv-role" className="sr-only">
                Role
              </label>
              <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)} className="sm:w-44">
                {invitable.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
              <Button type="submit" loading={pending === "invite"}>
                <UserPlus className="size-4" /> Invite
              </Button>
            </form>
            <ul className="mt-4 grid gap-2 text-[12.5px] text-muted sm:grid-cols-2 lg:grid-cols-3">
              {invitable.map((r) => (
                <li key={r}>
                  <span className="font-medium text-ink">{ROLE_LABELS[r]}</span> — {ROLE_DESCRIPTIONS[r]}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardTitle>Team</CardTitle>
            <CardDescription>
              {members.length} member{members.length === 1 ? "" : "s"}
            </CardDescription>
          </div>
        </CardHeader>
        <ul className="divide-y divide-line">
          {members.map((m) => {
            const editable = canManage && m.user_id !== myId && grantable.includes(m.role);
            return (
              <li key={m.user_id} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/80 to-violet/80 text-[12px] font-semibold text-white">
                    {(m.full_name || m.email).slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium">
                      {m.full_name || m.email} {m.user_id === myId && <span className="text-[12px] font-normal text-muted">(you)</span>}
                    </p>
                    <p className="truncate text-[12.5px] text-muted">
                      {m.email} · {m.last_login_at ? `active ${relativeTime(m.last_login_at)}` : "hasn't signed in yet"}
                    </p>
                  </div>
                </div>
                {editable ? (
                  <div className="flex items-center gap-2">
                    <label htmlFor={`role-${m.user_id}`} className="sr-only">
                      Role for {m.full_name}
                    </label>
                    <Select id={`role-${m.user_id}`} value={m.role} onChange={(e) => run(`r-${m.user_id}`, () => changeRoleAction(m.user_id, e.target.value), "Role updated")} className="h-9 w-40 text-[13px]">
                      {grantable.filter((r) => r !== "member" || m.role === "member").map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove ${m.full_name || m.email}`} onClick={() => setRemoving(m)}>
                      <UserMinus className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <Badge tone={m.role === "owner" ? "violet" : m.role === "admin" ? "primary" : "neutral"}>{ROLE_LABELS[m.role]}</Badge>
                )}
              </li>
            );
          })}
          {invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-5 py-3.5">
              <span className="flex size-9 items-center justify-center rounded-xl bg-surface-2 text-muted">
                <Mail className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] text-ink-2">{i.email}</p>
                <p className="text-[12.5px] text-muted">Invited as {ROLE_LABELS[i.role]} · expires {relativeTime(i.expires_at)}</p>
              </div>
              {canManage && (
                <Button size="sm" variant="ghost" loading={pending === `i-${i.id}`} onClick={() => run(`i-${i.id}`, () => revokeInviteAction(i.id), "Invitation revoked")}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
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
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Company-wide AI preferences</CardTitle>
          <CardDescription>Defaults for every AI employee. You can still fine-tune each employee separately.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-2">Default tone</p>
          <div className="grid gap-2 sm:grid-cols-4">
            {TONES.map((t) => (
              <button
                key={t}
                type="button"
                disabled={!canEdit}
                aria-pressed={p.tone === t}
                onClick={() => setP({ ...p, tone: t })}
                className={cn("rounded-xl border px-3 py-2.5 text-left text-[13.5px] font-medium transition", p.tone === t ? "border-primary bg-primary-soft/50 ring-2 ring-primary/20" : "border-line hover:border-line-strong")}
              >
                {TONE_COPY[t].label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[13px] font-medium text-ink-2">Default reply length</p>
            <p className="text-[12.5px] text-muted">{LENGTH_COPY[p.replyLength].description}</p>
          </div>
          <Segmented id="pref-len" ariaLabel="Reply length" value={p.replyLength} onChange={(v: ReplyLength) => canEdit && setP({ ...p, replyLength: v })} options={(["concise", "balanced", "detailed"] as const).map((v) => ({ value: v, label: LENGTH_COPY[v].label }))} />
        </div>
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
          <>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3.5">
              <span>
                <span className="block text-[13.5px] font-medium">Apply to all configured employees now</span>
                <span className="block text-[12.5px] text-muted">Creates a new configuration version for each employee.</span>
              </span>
              <Switch checked={apply} onCheckedChange={setApply} aria-label="Apply to all configured employees" />
            </label>
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
          </>
        )}
      </CardContent>
    </Card>
  );
}

type PrefsPatch = Parameters<typeof saveNotificationPrefsAction>[0];
const EMAIL_CHOICES: Array<{ value: EmailPreference; label: string; hint: string }> = [
  { value: "important", label: "Important only", hint: "Things that need you, money, your live website, and anything urgent." },
  { value: "all", label: "Everything", hint: "An email for every notification you haven't switched off." },
  { value: "off", label: "Urgent only", hint: "Only critical alerts. Everything else stays in the app." },
];

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
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>In-app notifications</CardTitle>
            <CardDescription>Choose what appears in your notification bell. Critical alerts are always shown.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="divide-y divide-line">
          {groups.map((g) => (
            <label key={g.key} className="flex items-center justify-between gap-4 py-3.5">
              <span>
                <span className="block text-[14px] font-medium">{g.label}</span>
                <span className="block text-[12.5px] text-muted">{g.description}</span>
              </span>
              <Switch
                checked={p.groups[g.key] !== false}
                aria-label={g.label}
                onCheckedChange={(v) => save({ groups: { ...p.groups, [g.key]: v } }, (cur) => ({ ...cur, groups: { ...cur.groups, [g.key]: v } }))}
              />
            </label>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Email</CardTitle>
            <CardDescription>Sent only to your verified address. Anything involving a customer&apos;s message arrives as a title and a link; the details stay behind your sign-in.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {emailAvailable ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  <span className="block text-[14px] font-medium">Which notifications to email</span>
                  <span className="block text-[12.5px] text-muted" id="email-choice-hint">{choice.hint}</span>
                </span>
                <Segmented id="email-choice" ariaLabel="Which notifications to email" value={p.email} options={EMAIL_CHOICES.map((c) => ({ value: c.value, label: c.label }))} onChange={(v) => save({ email: v }, (cur) => ({ ...cur, email: v }))} />
              </div>
              <label className="flex items-center justify-between gap-4 border-t border-line pt-4">
                <span>
                  <span className="block text-[14px] font-medium">Email me setup updates</span>
                  <span className="block text-[12.5px] text-muted">Milestones and requests while iAcquire sets up your system. You can turn this off any time.</span>
                </span>
                <Switch checked={p.setupEmails} aria-label="Email me setup updates" onCheckedChange={(v) => save({ setupEmails: v }, (cur) => ({ ...cur, setupEmails: v }))} />
              </label>
              <p className="text-[12.5px] text-muted">Routine email waits until 7am your time if it would arrive between 9pm and 7am. Critical alerts are sent straight away.</p>
            </>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-muted">Email notifications aren&apos;t available yet. They turn on once the iAcquire team connects an email provider. Until then everything appears in the app, and account emails (invitations, password resets) are always sent.</p>
          )}
        </CardContent>
      </Card>
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
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="size-4" /> Change password
            </CardTitle>
            <CardDescription>Other devices are signed out when you change it.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
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
            <div className="flex justify-end">
              <Button type="submit" loading={pending} disabled={!current || next.length < 10}>
                Update password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>Devices currently signed in to your account.</CardDescription>
          </div>
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
        </CardHeader>
        <CardContent>
          {sessions === null ? (
            <div className="skeleton h-14 rounded-xl" />
          ) : (
            <ul className="divide-y divide-line">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-3">
                  <Laptop className="size-5 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium">
                      {device(s.userAgent)} {s.current && <Badge tone="success" className="ml-1 h-5 text-[11px]">This device</Badge>}
                    </p>
                    <p className="text-[12px] text-muted">
                      Signed in {relativeTime(s.createdAt)} · last active {relativeTime(s.lastSeenAt)}
                    </p>
                  </div>
                  {!s.current && canRevokeOne && (
                    <Button
                      size="sm"
                      variant="ghost"
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
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
